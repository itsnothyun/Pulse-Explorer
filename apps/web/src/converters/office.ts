import { unzipSync, zipSync, type Zippable } from 'fflate';
import * as XLSX from 'xlsx';
import { ConvertError, type ConvertInput, type ConvertOutput, type Converter } from './types';
import { LEVELS, mimeFor, textDecode, textEncode } from './util';
import { textToPdf } from './textPdf';
import { recompressRaster } from './image';

/** Folders inside the zip where embedded pictures live. */
const MEDIA_DIRS = ['word/media/', 'ppt/media/', 'xl/media/', 'Pictures/', 'OEBPS/Images/', 'OEBPS/images/', 'images/'];

const entities: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const unescapeXml = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|apos);|&#(\d+);|&#x([0-9a-f]+);/gi, (m, _n, dec, hex) =>
    dec ? String.fromCodePoint(+dec) : hex ? String.fromCodePoint(parseInt(hex, 16)) : entities[m.toLowerCase()] ?? m
  );

/** Paragraph text from `<w:p>` / `<a:p>` style XML. */
function paragraphs(xml: string, para: string, text: string): string[] {
  const out: string[] = [];
  const paraRe = new RegExp(`<${para}[ >][\\s\\S]*?</${para}>`, 'g');
  const runRe = new RegExp(`<${text}(?:\\s[^>]*)?>([\\s\\S]*?)</${text}>|<w:tab/>|<w:br/>`, 'g');
  for (const p of xml.match(paraRe) ?? []) {
    let line = '';
    for (const m of p.matchAll(runRe)) {
      line += m[1] !== undefined ? unescapeXml(m[1]) : m[0] === '<w:tab/>' ? '\t' : '\n';
    }
    out.push(line);
  }
  return out;
}

export function docxText(bytes: Uint8Array): string[] {
  const files = unzipSync(bytes, { filter: (f) => f.name === 'word/document.xml' });
  const xml = files['word/document.xml'];
  if (!xml) throw new ConvertError('This is not a valid .docx (word/document.xml is missing).');
  return paragraphs(textDecode(xml), 'w:p', 'w:t');
}

export function pptxSlides(bytes: Uint8Array): string[][] {
  const files = unzipSync(bytes, { filter: (f) => /^ppt\/slides\/slide\d+\.xml$/.test(f.name) });
  const names = Object.keys(files).sort((a, b) => parseInt(a.replace(/\D/g, ''), 10) - parseInt(b.replace(/\D/g, ''), 10));
  if (names.length === 0) throw new ConvertError('This is not a valid .pptx (no slides found).');
  return names.map((n) => paragraphs(textDecode(files[n]), 'a:p', 'a:t').filter((l) => l.trim()));
}

function sheetLines(bytes: Uint8Array): string[] {
  const wb = XLSX.read(bytes, { type: 'array' });
  const lines: string[] = [];
  for (const name of wb.SheetNames) {
    lines.push(`== ${name} ==`);
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: '' });
    for (const r of rows) lines.push(r.map((c) => String(c)).join(' | '));
    lines.push('');
  }
  return lines;
}

async function repack(input: ConvertInput): Promise<Uint8Array> {
  const { level, bytes } = input;
  const settings = LEVELS[level];
  const files = unzipSync(bytes);
  const out: Zippable = {};
  const ordered = Object.keys(files).sort((a, b) => (a === 'mimetype' ? -1 : b === 'mimetype' ? 1 : 0));
  let done = 0;
  for (const name of ordered) {
    let data: Uint8Array = files[name];
    if (name === 'mimetype') {
      out[name] = [data, { level: 0 }];
    } else {
      const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
      if (MEDIA_DIRS.some((d) => name.startsWith(d)) && ['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
        const smaller = await recompressRaster(data, ext, settings).catch(() => null);
        if (smaller && smaller.length < data.length) data = smaller;
      }
      // Media is already compressed; storing it avoids wasted CPU.
      const stored = /\.(jpe?g|png|webp|gif|mp4|mp3)$/i.test(name);
      out[name] = [data, { level: stored ? 0 : 9 }];
    }
    input.onProgress?.(++done / ordered.length);
  }
  return zipSync(out);
}

export const officeConverter: Converter = {
  id: 'office',

  async run(target, input): Promise<ConvertOutput> {
    const ext = input.info.extension.toLowerCase();
    if (target.compress) {
      return { bytes: await repack(input), ext, mime: mimeFor(ext) };
    }
    if (target.id === 'txt') {
      const lines = ext === 'pptx' ? pptxSlides(input.bytes).flatMap((s, i) => [`--- Slide ${i + 1} ---`, ...s, '']) : docxText(input.bytes);
      return { bytes: textEncode(lines.join('\n')), ext: 'txt', mime: mimeFor('txt') };
    }
    // PDF
    if (ext === 'docx') {
      return { bytes: await textToPdf([docxText(input.bytes).join('\n')], { font: 'Helvetica' }), ext: 'pdf', mime: mimeFor('pdf'), note: 'Text only.' };
    }
    if (ext === 'pptx') {
      const pages = pptxSlides(input.bytes).map((s, i) => `Slide ${i + 1}\n\n${s.join('\n')}`);
      return { bytes: await textToPdf(pages, { font: 'Helvetica', pageBreakEach: true }), ext: 'pdf', mime: mimeFor('pdf'), note: 'Slide text only.' };
    }
    return { bytes: await textToPdf([sheetLines(input.bytes).join('\n')], { font: 'Courier', size: 8, landscape: true }), ext: 'pdf', mime: mimeFor('pdf'), note: 'Cell values only.' };
  },
};
