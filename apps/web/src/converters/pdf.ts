import { PDFDocument } from 'pdf-lib';
import { ConvertError, type ConvertInput, type ConvertOutput, type ConvertTarget, type Converter } from './types';
import { LEVELS, baseName, mimeFor, textEncode } from './util';
import { zipFiles } from './archive';

type PdfJs = typeof import('pdfjs-dist');
type PdfDoc = Awaited<ReturnType<PdfJs['getDocument']>['promise']>;

let pdfjsPromise: Promise<PdfJs> | null = null;
function loadPdfjs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist').then((lib) => {
    // Same worker the viewer uses.
    lib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
    return lib;
  });
  return pdfjsPromise;
}

async function open(bytes: Uint8Array): Promise<PdfDoc> {
  const lib = await loadPdfjs();
  try {
    // pdf.js transfers the buffer, so hand it a copy.
    return await lib.getDocument({ data: bytes.slice() }).promise;
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === 'PasswordException') throw new ConvertError('This PDF is password protected.');
    throw new ConvertError('This PDF could not be read. It may be corrupt.');
  }
}

async function renderPage(doc: PdfDoc, n: number, scale: number): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(n);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

const toBytes = async (canvas: HTMLCanvasElement, mime: string, q: number): Promise<Uint8Array> => {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, mime, q));
  if (!blob) throw new ConvertError('Could not encode a page image.');
  return new Uint8Array(await blob.arrayBuffer());
};

/** Re-renders pages as JPEG so photos and scans actually shrink. Text stops being selectable. */
async function flatten(input: ConvertInput): Promise<Uint8Array> {
  const s = LEVELS[input.level];
  const doc = await open(input.bytes);
  const out = await PDFDocument.create();
  for (let n = 1; n <= doc.numPages; n++) {
    const canvas = await renderPage(doc, n, s.pdfScale);
    const jpg = await out.embedJpg(await toBytes(canvas, 'image/jpeg', s.pdfQuality));
    // Page keeps its original size in points: canvas px / scale.
    const page = out.addPage([canvas.width / s.pdfScale, canvas.height / s.pdfScale]);
    page.drawImage(jpg, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
    input.onProgress?.(n / doc.numPages);
  }
  void doc.destroy();
  return out.save();
}

export const pdfConverter: Converter = {
  id: 'pdf',

  async run(target, input): Promise<ConvertOutput> {
    if (target.compress) {
      if (input.level === 'best') {
        // Lossless: repack object streams only, keeps text selectable.
        const doc = await PDFDocument.load(input.bytes, { ignoreEncryption: false }).catch(() => {
          throw new ConvertError('This PDF could not be read, or it is encrypted.');
        });
        return { bytes: await doc.save({ useObjectStreams: true }), ext: 'pdf', mime: mimeFor('pdf'), note: 'Lossless repack; text stays selectable.' };
      }
      return { bytes: await flatten(input), ext: 'pdf', mime: mimeFor('pdf'), note: 'Pages were flattened to images; text is no longer selectable.' };
    }

    const doc = await open(input.bytes);
    if (target.id === 'txt') {
      const pages: string[] = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const content = await (await doc.getPage(n)).getTextContent();
        pages.push(content.items.map((i) => ('str' in i ? i.str + (i.hasEOL ? '\n' : ' ') : '')).join('').trim());
        input.onProgress?.(n / doc.numPages);
      }
      const text = pages.join('\n\n').trim();
      if (!text) throw new ConvertError('No selectable text found. This PDF may be a scan.');
      return { bytes: textEncode(text), ext: 'txt', mime: mimeFor('txt') };
    }

    const mime = target.id === 'png' ? 'image/png' : 'image/jpeg';
    const s = LEVELS[input.level];
    const images: Record<string, Uint8Array> = {};
    const base = baseName(input.name);
    const pad = String(doc.numPages).length;
    for (let n = 1; n <= doc.numPages; n++) {
      const canvas = await renderPage(doc, n, Math.max(1.5, s.pdfScale));
      images[`${base}-${String(n).padStart(pad, '0')}.${target.ext}`] = await toBytes(canvas, mime, Math.max(0.85, s.quality));
      input.onProgress?.(n / doc.numPages);
    }
    void doc.destroy();
    if (doc.numPages === 1) {
      const [bytes] = Object.values(images);
      return { bytes, ext: target.ext, mime };
    }
    return { bytes: zipFiles(images), ext: 'zip', mime: mimeFor('zip'), note: `${doc.numPages} pages saved as ${target.ext.toUpperCase()} images in a ZIP.` };
  },
};
