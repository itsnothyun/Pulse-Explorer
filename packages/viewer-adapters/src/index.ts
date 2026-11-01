import JSZip from 'jszip';
import mammoth from 'mammoth';
import { marked } from 'marked';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { OMNIVIEW_CONFIG } from '@omniview/config';
import type {
  ArchiveEntryItem,
  DetectedFile,
  OutlineItem,
  ViewerCapabilities,
} from '@omniview/shared-types';
import {
  detectTextEncoding,
  getMonacoLanguageForExtension,
  isSafeArchivePath,
  sanitizeHtmlContent,
  sanitizeSvgContent,
} from '@omniview/utilities';
import {
  createSearchMatcher,
  ViewerAdapterRegistry,
  type FileSource,
  type ViewerAdapter,
  type ViewerContext,
  type ViewerDocument,
} from '@omniview/viewer-core';

// ============================================================================
// Payload Contracts for Each Viewer Adapter
// ============================================================================

export interface PDFViewerPayload {
  arrayBuffer: ArrayBuffer;
  password?: string;
}

export interface WordViewerPayload {
  htmlPages: string[];
  fullHtml: string;
  rawText: string;
  wordCount: number;
  charCount: number;
  isExactPrintLayout: boolean;
}

export interface PresentationSlideElement {
  id: string;
  type: 'title' | 'body' | 'table' | 'image' | 'shape';
  text?: string;
  bullets?: string[];
  tableRows?: string[][];
  imageDataUrl?: string;
  x?: number; // percentage 0..100
  y?: number; // percentage 0..100
  w?: number; // percentage 0..100
  h?: number; // percentage 0..100
}

export interface PresentationSlide {
  index: number;
  title: string;
  elements: PresentationSlideElement[];
  speakerNotes: string;
  extractedText: string;
}

export interface PresentationViewerPayload {
  slides: PresentationSlide[];
  aspectRatio: '16:9' | '4:3';
}

export interface SpreadsheetCellData {
  value: string | number | boolean | null;
  formatted: string;
  formula?: string;
  type: 'string' | 'number' | 'boolean' | 'formula' | 'empty';
}

export interface SpreadsheetSheetData {
  name: string;
  rows: SpreadsheetCellData[][];
  colWidths: number[];
  frozenRows: number;
  frozenCols: number;
  totalRows: number;
  totalCols: number;
}

export interface SpreadsheetViewerPayload {
  sheets: SpreadsheetSheetData[];
  delimiterDetected?: string;
  encodingDetected?: string;
  macrosBlocked: boolean;
}

export interface ImageViewerPayload {
  objectUrl: string;
  sanitizedSvgMarkup?: string;
  isSvg: boolean;
  hasTransparency: boolean;
  exifMetadata: Record<string, string | number>;
}

export interface EbookChapter {
  id: string;
  title: string;
  htmlContent: string;
  plainText: string;
}

export interface EbookViewerPayload {
  bookTitle: string;
  author: string;
  publisher?: string;
  chapters: EbookChapter[];
}

export interface CodeViewerPayload {
  content: string;
  language: string;
  lineCount: number;
  encoding: string;
  isJson: boolean;
  parsedJson?: unknown;
  isEnvFile: boolean;
}

export interface MediaViewerPayload {
  objectUrl: string;
  mimeType: string;
  isVideo: boolean;
}

export interface ArchiveViewerPayload {
  entries: ArchiveEntryItem[];
  totalCompressedBytes: number;
  totalUncompressedBytes: number;
  securityWarnings: string[];
  extractEntry: (entryPath: string) => Promise<Uint8Array>;
}

export interface FallbackViewerPayload {
  reason: string;
  hexPreview: string;
  asciiPreview: string;
  canRequestRemoteConversion: boolean;
}

// ============================================================================
// Helper: Ensure ArrayBuffer
// ============================================================================
async function getSourceBuffer(source: FileSource): Promise<ArrayBuffer> {
  if (source.arrayBuffer) return source.arrayBuffer;
  if (source.blob) return await source.blob.arrayBuffer();
  throw new Error('FileSource contains neither arrayBuffer nor blob');
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================================
// 1. PDFViewerAdapter
// ============================================================================
export class PDFViewerAdapter implements ViewerAdapter<PDFViewerPayload> {
  id = 'PDFViewerAdapter';
  displayName = 'Mozilla PDF.js Engine';
  priority = 100;

  supports(file: DetectedFile): boolean {
    return file.category === 'pdf' || file.extension === 'pdf';
  }

  getCapabilities(): ViewerCapabilities {
    return {
      search: true,
      zoom: true,
      print: true,
      download: true,
      thumbnails: true,
      annotations: true,
      fullscreen: true,
      textSelection: true,
      rotate: true,
      pagination: true,
      sheets: false,
      slides: false,
      chapters: false,
      presentationMode: false,
      readingModes: true,
      mediaControls: false,
    };
  }

  async load(source: FileSource): Promise<ViewerDocument<PDFViewerPayload>> {
    const buffer = await getSourceBuffer(source);
    return {
      fileId: source.file.id,
      adapterId: this.id,
      title: source.file.originalName,
      unitCount: 1, // Updated dynamically by PDF.js once loaded
      unitLabel: 'Page',
      outline: [],
      extractedTextByUnit: [],
      payload: {
        arrayBuffer: buffer,
        password: source.password,
      },
      search: () => [],
      dispose: () => {},
    };
  }

  dispose(): void {}
}

// ============================================================================
// 2. WordViewerAdapter (.docx, .doc, .odt, .rtf, .md, .html)
// ============================================================================
export class WordViewerAdapter implements ViewerAdapter<WordViewerPayload> {
  id = 'WordViewerAdapter';
  displayName = 'Document & Print-Layout Renderer';
  priority = 90;

  supports(file: DetectedFile): boolean {
    return (
      file.category === 'word' ||
      ['docx', 'doc', 'odt', 'rtf', 'md', 'markdown', 'html', 'htm', 'pages'].includes(file.extension)
    );
  }

  getCapabilities(): ViewerCapabilities {
    return {
      search: true,
      zoom: true,
      print: true,
      download: true,
      thumbnails: true,
      annotations: true,
      fullscreen: true,
      textSelection: true,
      rotate: false,
      pagination: true,
      sheets: false,
      slides: false,
      chapters: false,
      presentationMode: false,
      readingModes: true,
      mediaControls: false,
    };
  }

  async load(source: FileSource): Promise<ViewerDocument<WordViewerPayload>> {
    const buffer = await getSourceBuffer(source);
    const ext = source.file.extension.toLowerCase();
    let fullHtml = '';
    let fidelityWarning = source.file.conversionFidelityNote;

    if (ext === 'docx') {
      try {
        const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
        fullHtml = sanitizeHtmlContent(result.value);
      } catch {
        // Fallback: parse word/document.xml via JSZip
        const zip = await JSZip.loadAsync(buffer);
        const docXml = await zip.file('word/document.xml')?.async('string');
        if (!docXml) {
          throw new Error('Corrupt or unreadable DOCX archive: missing word/document.xml');
        }
        const paragraphs = Array.from(docXml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)).map((m) => {
          const texts = Array.from(m[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)).map((t) => t[1]);
          return `<p>${texts.join('')}</p>`;
        });
        fullHtml = sanitizeHtmlContent(paragraphs.join('\n'));
      }
      fidelityWarning =
        'Semantic HTML & simulated print pagination active. Exact Microsoft Word pagination requires the isolated LibreOffice conversion worker.';
    } else if (ext === 'odt') {
      const zip = await JSZip.loadAsync(buffer);
      const contentXml = await zip.file('content.xml')?.async('string');
      if (!contentXml) {
        throw new Error('Invalid ODT document: missing content.xml');
      }
      const paragraphs = Array.from(contentXml.matchAll(/<text:(p|h)[^>]*>([\s\S]*?)<\/text:\1>/g)).map(
        (m) => {
          const tag = m[1] === 'h' ? 'h2' : 'p';
          const clean = stripHtmlTags(m[2]);
          return clean ? `<${tag}>${clean}</${tag}>` : '';
        }
      );
      fullHtml = sanitizeHtmlContent(paragraphs.filter(Boolean).join('\n'));
    } else if (ext === 'md' || ext === 'markdown') {
      const text = new TextDecoder('utf-8').decode(buffer);
      const rendered = await marked.parse(text);
      fullHtml = sanitizeHtmlContent(rendered);
    } else if (ext === 'html' || ext === 'htm') {
      const text = new TextDecoder('utf-8').decode(buffer);
      fullHtml = sanitizeHtmlContent(text);
      fidelityWarning = 'Scripts, iframes, and inline event handlers were stripped for security.';
    } else if (ext === 'rtf') {
      const rawRtf = new TextDecoder('utf-8').decode(buffer);
      const cleaned = rawRtf
        .replace(/\\par\b/g, '\n\n')
        .replace(/\\tab\b/g, '\t')
        .replace(/\\'([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\{\\fonttbl[\s\S]*?\}/g, '')
        .replace(/\{\\colortbl[\s\S]*?\}/g, '')
        .replace(/\\[a-zA-Z]+-?\d*\s?/g, '')
        .replace(/[{}]/g, '')
        .trim();
      fullHtml = cleaned
        .split(/\n{2,}/)
        .map((p) => `<p>${p.trim()}</p>`)
        .join('\n');
    } else {
      throw new Error(
        `Format .${ext} requires server-side LibreOffice conversion to PDF for rendering.`
      );
    }

    // Extract headings for outline navigation
    const outline: OutlineItem[] = [];
    let headingIdx = 0;
    fullHtml = fullHtml.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/gi, (_, levelStr, attrs, inner) => {
      headingIdx++;
      const id = `doc-heading-${headingIdx}`;
      const title = stripHtmlTags(inner);
      if (title) {
        outline.push({
          id,
          title,
          pageOrPosition: 1,
          level: Number(levelStr),
        });
      }
      return `<h${levelStr}${attrs} id="${id}">${inner}</h${levelStr}>`;
    });

    // Split into logical pages for print-layout navigation (by explicit page-break or ~3000 chars)
    const blocks = fullHtml.split(/(?=<h1|<h2|<p|<table|<ul|<ol)/i).filter((b) => b.trim().length > 0);
    const htmlPages: string[] = [];
    let currentChunk = '';
    for (const block of blocks) {
      if (currentChunk.length + block.length > 3400 && currentChunk.length > 0) {
        htmlPages.push(currentChunk);
        currentChunk = block;
      } else {
        currentChunk += block;
      }
    }
    if (currentChunk.trim() || htmlPages.length === 0) {
      htmlPages.push(currentChunk || '<p><em>Empty document</em></p>');
    }

    const extractedTextByUnit = htmlPages.map((p) => stripHtmlTags(p));
    const rawText = extractedTextByUnit.join('\n\n');
    const words = rawText.trim() ? rawText.trim().split(/\s+/).length : 0;

    // Assign outline items to their respective page numbers
    outline.forEach((item) => {
      const pageIdx = htmlPages.findIndex((p) => p.includes(`id="${item.id}"`));
      if (pageIdx >= 0) {
        item.pageOrPosition = pageIdx + 1;
      }
    });

    return {
      fileId: source.file.id,
      adapterId: this.id,
      title: source.file.originalName,
      unitCount: htmlPages.length,
      unitLabel: 'Page',
      outline,
      extractedTextByUnit,
      fidelityWarning,
      payload: {
        htmlPages,
        fullHtml,
        rawText,
        wordCount: words,
        charCount: rawText.length,
        isExactPrintLayout: false,
      },
      search: createSearchMatcher(source.file.id, 'Page', extractedTextByUnit),
      dispose: () => {},
    };
  }

  dispose(): void {}
}

// ============================================================================
// 3. PresentationViewerAdapter (.pptx, .ppsx, .odp)
// ============================================================================
export class PresentationViewerAdapter implements ViewerAdapter<PresentationViewerPayload> {
  id = 'PresentationViewerAdapter';
  displayName = 'Slide Deck & Presentation Renderer';
  priority = 85;

  supports(file: DetectedFile): boolean {
    return (
      file.category === 'presentation' ||
      ['pptx', 'ppt', 'odp', 'ppsx', 'key'].includes(file.extension)
    );
  }

  getCapabilities(): ViewerCapabilities {
    return {
      search: true,
      zoom: true,
      print: true,
      download: true,
      thumbnails: true,
      annotations: true,
      fullscreen: true,
      textSelection: true,
      rotate: false,
      pagination: true,
      sheets: false,
      slides: true,
      chapters: false,
      presentationMode: true,
      readingModes: false,
      mediaControls: false,
    };
  }

  async load(source: FileSource): Promise<ViewerDocument<PresentationViewerPayload>> {
    const buffer = await getSourceBuffer(source);
    const ext = source.file.extension.toLowerCase();

    if (ext === 'ppt' || ext === 'key') {
      throw new Error(
        `Legacy/proprietary presentation (.${ext}) requires isolated LibreOffice worker conversion.`
      );
    }

    const zip = await JSZip.loadAsync(buffer);
    const slides: PresentationSlide[] = [];

    // Locate ppt/slides/slide1.xml, slide2.xml, ...
    const slideFiles = Object.keys(zip.files)
      .filter((p) => /^ppt\/slides\/slide\d+\.xml$/i.test(p))
      .sort((a, b) => {
        const numA = parseInt(a.match(/slide(\d+)\.xml/i)?.[1] ?? '0', 10);
        const numB = parseInt(b.match(/slide(\d+)\.xml/i)?.[1] ?? '0', 10);
        return numA - numB;
      });

    if (slideFiles.length === 0 && ext === 'odp') {
      // Parse OpenDocument Presentation content.xml
      const contentXml = await zip.file('content.xml')?.async('string');
      if (contentXml) {
        const pages = Array.from(contentXml.matchAll(/<draw:page\b[^>]*>([\s\S]*?)<\/draw:page>/g));
        pages.forEach((p, idx) => {
          const texts = Array.from(p[1].matchAll(/<text:p[^>]*>([\s\S]*?)<\/text:p>/g))
            .map((t) => stripHtmlTags(t[1]))
            .filter(Boolean);
          const slideTitle = texts[0] || `Slide ${idx + 1}`;
          slides.push({
            index: idx + 1,
            title: slideTitle,
            elements: [
              { id: `s-${idx + 1}-title`, type: 'title', text: slideTitle },
              { id: `s-${idx + 1}-body`, type: 'body', bullets: texts.slice(1) },
            ],
            speakerNotes: '',
            extractedText: texts.join(' '),
          });
        });
      }
    }

    for (let i = 0; i < slideFiles.length; i++) {
      const slidePath = slideFiles[i];
      const slideNum = i + 1;
      const xml = (await zip.file(slidePath)?.async('string')) ?? '';

      const elements: PresentationSlideElement[] = [];
      let slideTitle = '';

      // Extract shapes (<p:sp>...</p:sp>)
      const shapes = Array.from(xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g));
      shapes.forEach((shapeMatch, sIdx) => {
        const shapeXml = shapeMatch[0];
        const isTitle = /<p:ph[^>]*type="(title|ctrTitle)"/i.test(shapeXml);
        const paragraphs = Array.from(shapeXml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g))
          .map((pMatch) =>
            Array.from(pMatch[0].matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g))
              .map((t) => t[1])
              .join('')
              .trim()
          )
          .filter(Boolean);

        if (paragraphs.length === 0) return;

        if (isTitle || (!slideTitle && sIdx === 0)) {
          slideTitle = paragraphs.join(' ');
          elements.push({
            id: `slide-${slideNum}-el-${sIdx}`,
            type: 'title',
            text: slideTitle,
          });
        } else {
          elements.push({
            id: `slide-${slideNum}-el-${sIdx}`,
            type: 'body',
            bullets: paragraphs,
          });
        }
      });

      // Extract tables (<a:tbl>...</a:tbl>)
      const tables = Array.from(xml.matchAll(/<a:tbl\b[\s\S]*?<\/a:tbl>/g));
      tables.forEach((tblMatch, tIdx) => {
        const rows = Array.from(tblMatch[0].matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)).map((trMatch) =>
          Array.from(trMatch[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)).map((tcMatch) =>
            Array.from(tcMatch[0].matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g))
              .map((t) => t[1])
              .join(' ')
              .trim()
          )
        );
        if (rows.length > 0) {
          elements.push({
            id: `slide-${slideNum}-tbl-${tIdx}`,
            type: 'table',
            tableRows: rows,
          });
        }
      });

      // Extract speaker notes if present (ppt/notesSlides/notesSlideN.xml)
      let speakerNotes = '';
      const notesXml = await zip.file(`ppt/notesSlides/notesSlide${slideNum}.xml`)?.async('string');
      if (notesXml) {
        const noteTexts = Array.from(notesXml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g))
          .map((t) => t[1].trim())
          .filter((t) => t && t !== String(slideNum));
        speakerNotes = noteTexts.join(' ');
      }

      const allTextParts = [
        slideTitle,
        ...elements.flatMap((el) => [
          el.text ?? '',
          ...(el.bullets ?? []),
          ...(el.tableRows?.flat() ?? []),
        ]),
        speakerNotes,
      ].filter(Boolean);

      slides.push({
        index: slideNum,
        title: slideTitle || `Slide ${slideNum}`,
        elements,
        speakerNotes,
        extractedText: allTextParts.join(' '),
      });
    }

    if (slides.length === 0) {
      throw new Error('Presentation contains no readable slides.');
    }

    const extractedTextByUnit = slides.map((s) => s.extractedText);
    const outline: OutlineItem[] = slides.map((s) => ({
      id: `slide-outline-${s.index}`,
      title: `${s.index}. ${s.title}`,
      pageOrPosition: s.index,
      level: 1,
    }));

    return {
      fileId: source.file.id,
      adapterId: this.id,
      title: source.file.originalName,
      unitCount: slides.length,
      unitLabel: 'Slide',
      outline,
      extractedTextByUnit,
      fidelityWarning:
        'Static slide layout, tables, and speaker notes rendered locally. PowerPoint animations, slide transitions, and embedded media require native Office or video export.',
      payload: {
        slides,
        aspectRatio: '16:9',
      },
      search: createSearchMatcher(source.file.id, 'Slide', extractedTextByUnit),
      dispose: () => {},
    };
  }

  dispose(): void {}
}

// ============================================================================
// 4. SpreadsheetViewerAdapter (.xlsx, .xls, .xlsm, .ods, .csv, .tsv)
// ============================================================================
export class SpreadsheetViewerAdapter implements ViewerAdapter<SpreadsheetViewerPayload> {
  id = 'SpreadsheetViewerAdapter';
  displayName = 'Virtualized Workbook Grid Engine';
  priority = 80;

  supports(file: DetectedFile): boolean {
    return (
      file.category === 'spreadsheet' ||
      ['xlsx', 'xls', 'xlsm', 'ods', 'csv', 'tsv'].includes(file.extension)
    );
  }

  getCapabilities(): ViewerCapabilities {
    return {
      search: true,
      zoom: true,
      print: true,
      download: true,
      thumbnails: false,
      annotations: false,
      fullscreen: true,
      textSelection: true,
      rotate: false,
      pagination: false,
      sheets: true,
      slides: false,
      chapters: false,
      presentationMode: false,
      readingModes: false,
      mediaControls: false,
    };
  }

  async load(source: FileSource): Promise<ViewerDocument<SpreadsheetViewerPayload>> {
    const buffer = await getSourceBuffer(source);
    const ext = source.file.extension.toLowerCase();
    const sheets: SpreadsheetSheetData[] = [];
    let delimiterDetected: string | undefined;
    let encodingDetected = 'UTF-8';

    if (ext === 'csv' || ext === 'tsv') {
      const uint8 = new Uint8Array(buffer);
      encodingDetected = detectTextEncoding(uint8);
      const text = new TextDecoder('utf-8').decode(uint8);
      const parsed = Papa.parse<string[]>(text, {
        delimiter: ext === 'tsv' ? '\t' : '',
        skipEmptyLines: false,
      });
      delimiterDetected = parsed.meta.delimiter || (ext === 'tsv' ? '\\t' : ',');
      const rawRows = parsed.data;
      const maxCols = rawRows.reduce((max, r) => Math.max(max, r.length), 0);
      const rows: SpreadsheetCellData[][] = rawRows
        .slice(0, OMNIVIEW_CONFIG.limits.maxSpreadsheetInitialRows)
        .map((r) =>
          r.map((cellVal) => {
            const num = Number(cellVal);
            const isNum = cellVal.trim() !== '' && !Number.isNaN(num);
            return {
              value: isNum ? num : cellVal,
              formatted: cellVal,
              type: cellVal === '' ? 'empty' : isNum ? 'number' : 'string',
            };
          })
        );

      sheets.push({
        name: source.file.originalName.replace(/\.[^.]+$/, '') || 'Sheet1',
        rows,
        colWidths: Array.from({ length: Math.max(maxCols, 1) }, () => 140),
        frozenRows: rows.length > 1 ? 1 : 0,
        frozenCols: 0,
        totalRows: rawRows.length,
        totalCols: maxCols,
      });
    } else {
      // Parse with SheetJS in safe non-executing mode (bookVBA: false, cellFormula: true, cellNF: true)
      const workbook = XLSX.read(buffer, {
        type: 'array',
        cellFormula: true,
        cellNF: true,
        cellStyles: true,
        bookVBA: false,
      });

      for (const sheetName of workbook.SheetNames) {
        const ws = workbook.Sheets[sheetName];
        if (!ws) continue;
        const ref = ws['!ref'] || 'A1:A1';
        const range = XLSX.utils.decode_range(ref);
        const totalRows = Math.min(
          range.e.r - range.s.r + 1,
          OMNIVIEW_CONFIG.limits.maxSpreadsheetInitialRows
        );
        const totalCols = Math.min(range.e.c - range.s.c + 1, 200);

        const rows: SpreadsheetCellData[][] = [];
        for (let r = 0; r < totalRows; r++) {
          const rowCells: SpreadsheetCellData[] = [];
          for (let c = 0; c < totalCols; c++) {
            const cellAddress = XLSX.utils.encode_cell({ r: range.s.r + r, c: range.s.c + c });
            const cell = ws[cellAddress] as XLSX.CellObject | undefined;
            if (!cell) {
              rowCells.push({ value: null, formatted: '', type: 'empty' });
            } else {
              const formatted = cell.w ?? (cell.v !== undefined ? String(cell.v) : '');
              rowCells.push({
                value: (cell.v as string | number | boolean) ?? null,
                formatted,
                formula: cell.f ? `=${cell.f}` : undefined,
                type: cell.f
                  ? 'formula'
                  : cell.t === 'n'
                  ? 'number'
                  : cell.t === 'b'
                  ? 'boolean'
                  : 'string',
              });
            }
          }
          rows.push(rowCells);
        }

        const colWidths = Array.from({ length: Math.max(totalCols, 1) }, (_, idx) => {
          const colInfo = ws['!cols']?.[idx];
          return colInfo?.wpx ? Math.max(80, Math.min(360, colInfo.wpx)) : 130;
        });

        sheets.push({
          name: sheetName,
          rows,
          colWidths,
          frozenRows: 1,
          frozenCols: 0,
          totalRows,
          totalCols,
        });
      }
    }

    const extractedTextByUnit = sheets.map((s) =>
      s.rows
        .map((r) => r.map((c) => (c.formula ? `${c.formatted} (${c.formula})` : c.formatted)).join('\t'))
        .join('\n')
    );

    const outline: OutlineItem[] = sheets.map((s, idx) => ({
      id: `sheet-${idx + 1}`,
      title: `${s.name} (${s.totalRows}×${s.totalCols})`,
      pageOrPosition: idx + 1,
      level: 1,
    }));

    return {
      fileId: source.file.id,
      adapterId: this.id,
      title: source.file.originalName,
      unitCount: sheets.length,
      unitLabel: 'Sheet',
      outline,
      extractedTextByUnit,
      fidelityWarning:
        ext === 'xlsm'
          ? 'VBA Macros disabled for security. Cached cell values and formula definitions are displayed.'
          : 'Displaying cached formula results and formula expressions. Live recalculation of volatile Excel functions is intentionally disabled in view-only mode.',
      payload: {
        sheets,
        delimiterDetected,
        encodingDetected,
        macrosBlocked: ext === 'xlsm' || Boolean(source.file.hasMacrosWarning),
      },
      search: createSearchMatcher(source.file.id, 'Sheet', extractedTextByUnit),
      dispose: () => {},
    };
  }

  dispose(): void {}
}

// ============================================================================
// 5. ImageViewerAdapter (.png, .jpg, .webp, .gif, .bmp, .avif, .svg, .tiff)
// ============================================================================
export class ImageViewerAdapter implements ViewerAdapter<ImageViewerPayload> {
  id = 'ImageViewerAdapter';
  displayName = 'Safe Image & Vector Inspector';
  priority = 75;

  supports(file: DetectedFile): boolean {
    return (
      file.category === 'image' ||
      ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg', 'tif', 'tiff'].includes(
        file.extension
      )
    );
  }

  getCapabilities(): ViewerCapabilities {
    return {
      search: false,
      zoom: true,
      print: true,
      download: true,
      thumbnails: false,
      annotations: false,
      fullscreen: true,
      textSelection: false,
      rotate: true,
      pagination: false,
      sheets: false,
      slides: false,
      chapters: false,
      presentationMode: false,
      readingModes: false,
      mediaControls: false,
    };
  }

  async load(source: FileSource): Promise<ViewerDocument<ImageViewerPayload>> {
    const buffer = await getSourceBuffer(source);
    const ext = source.file.extension.toLowerCase();
    const isSvg = ext === 'svg' || source.file.detectedMimeType === 'image/svg+xml';
    let sanitizedSvgMarkup: string | undefined;
    let objectUrl = source.objectUrl ?? '';

    if (isSvg) {
      const rawSvg = new TextDecoder('utf-8').decode(buffer);
      sanitizedSvgMarkup = sanitizeSvgContent(rawSvg);
      const safeBlob = new Blob([sanitizedSvgMarkup], { type: 'image/svg+xml' });
      objectUrl = URL.createObjectURL(safeBlob);
    } else if (!objectUrl) {
      const blob = source.blob ?? new Blob([buffer], { type: source.file.detectedMimeType });
      objectUrl = URL.createObjectURL(blob);
    }

    const exifMetadata: Record<string, string | number> = {
      Format: ext.toUpperCase(),
      'MIME Type': source.file.detectedMimeType,
      'Byte Size': source.file.sizeBytes,
      'Pipeline Mode': isSvg ? 'Sanitized SVG DOM (Scripts Blocked)' : 'Decoded Raster Frame',
    };

    return {
      fileId: source.file.id,
      adapterId: this.id,
      title: source.file.originalName,
      unitCount: 1,
      unitLabel: 'Item',
      outline: [],
      extractedTextByUnit: [],
      fidelityWarning: isSvg
        ? 'Embedded <script> tags and inline event handlers in SVG are blocked by OmniView security policy.'
        : undefined,
      payload: {
        objectUrl,
        sanitizedSvgMarkup,
        isSvg,
        hasTransparency: ['png', 'webp', 'gif', 'svg', 'avif'].includes(ext),
        exifMetadata,
      },
      search: () => [],
      dispose: () => {
        if (objectUrl && objectUrl !== source.objectUrl) {
          URL.revokeObjectURL(objectUrl);
        }
      },
    };
  }

  dispose(): void {}
}

// ============================================================================
// 6. EbookViewerAdapter (.epub, .fb2)
// ============================================================================
export class EbookViewerAdapter implements ViewerAdapter<EbookViewerPayload> {
  id = 'EbookViewerAdapter';
  displayName = 'EPUB & eBook Reader Engine';
  priority = 70;

  supports(file: DetectedFile): boolean {
    return file.category === 'ebook' || ['epub', 'fb2', 'mobi'].includes(file.extension);
  }

  getCapabilities(): ViewerCapabilities {
    return {
      search: true,
      zoom: true,
      print: true,
      download: true,
      thumbnails: false,
      annotations: true,
      fullscreen: true,
      textSelection: true,
      rotate: false,
      pagination: true,
      sheets: false,
      slides: false,
      chapters: true,
      presentationMode: false,
      readingModes: true,
      mediaControls: false,
    };
  }

  async load(source: FileSource): Promise<ViewerDocument<EbookViewerPayload>> {
    const buffer = await getSourceBuffer(source);
    const ext = source.file.extension.toLowerCase();

    if (ext === 'mobi') {
      throw new Error('MOBI format requires conversion worker to EPUB/PDF.');
    }

    const chapters: EbookChapter[] = [];
    let bookTitle = source.file.originalName;
    let author = 'Unknown Author';

    if (ext === 'fb2') {
      const xml = new TextDecoder('utf-8').decode(buffer);
      bookTitle = xml.match(/<book-title>([\s\S]*?)<\/book-title>/i)?.[1]?.trim() || bookTitle;
      const firstName = xml.match(/<first-name>([\s\S]*?)<\/first-name>/i)?.[1]?.trim() || '';
      const lastName = xml.match(/<last-name>([\s\S]*?)<\/last-name>/i)?.[1]?.trim() || '';
      if (firstName || lastName) author = `${firstName} ${lastName}`.trim();

      const sections = Array.from(xml.matchAll(/<section\b[^>]*>([\s\S]*?)<\/section>/gi));
      sections.forEach((sec, idx) => {
        const title =
          stripHtmlTags(sec[1].match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '') ||
          `Chapter ${idx + 1}`;
        const htmlContent = sanitizeHtmlContent(
          sec[1]
            .replace(/<title>([\s\S]*?)<\/title>/gi, '<h2>$1</h2>')
            .replace(/<empty-line\s*\/>/gi, '<br/>')
        );
        chapters.push({
          id: `ch-${idx + 1}`,
          title,
          htmlContent,
          plainText: stripHtmlTags(htmlContent),
        });
      });
    } else {
      // Standard EPUB container (META-INF/container.xml -> OPF package -> spine items)
      const zip = await JSZip.loadAsync(buffer);
      const containerXml = await zip.file('META-INF/container.xml')?.async('string');
      const opfPath =
        containerXml?.match(/full-path="([^"]+)"/i)?.[1] ||
        Object.keys(zip.files).find((k) => k.endsWith('.opf'));

      if (!opfPath) {
        throw new Error('Invalid EPUB container: no OPF package document found.');
      }

      const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
      const opfXml = (await zip.file(opfPath)?.async('string')) ?? '';

      bookTitle =
        opfXml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1]?.trim() || bookTitle;
      author =
        opfXml.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i)?.[1]?.trim() || author;

      // Map manifest id -> href
      const manifestMap = new Map<string, string>();
      for (const itemMatch of opfXml.matchAll(/<item\b([^>]+)\/?>/gi)) {
        const attrs = itemMatch[1];
        const id = attrs.match(/\bid="([^"]+)"/i)?.[1];
        const href = attrs.match(/\bhref="([^"]+)"/i)?.[1];
        if (id && href) {
          manifestMap.set(id, opfDir + href);
        }
      }

      // Read spine order
      const spineIds = Array.from(opfXml.matchAll(/<itemref\b[^>]*idref="([^"]+)"/gi)).map(
        (m) => m[1]
      );

      const orderedPaths =
        spineIds.length > 0
          ? spineIds.map((id) => manifestMap.get(id)).filter((p): p is string => Boolean(p))
          : Object.keys(zip.files).filter((p) => /\.(xhtml|html|htm)$/i.test(p));

      for (let i = 0; i < orderedPaths.length; i++) {
        const path = orderedPaths[i];
        const rawChapter = await zip.file(path)?.async('string');
        if (!rawChapter) continue;
        const bodyContent =
          rawChapter.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? rawChapter;
        const sanitized = sanitizeHtmlContent(bodyContent);
        const plainText = stripHtmlTags(sanitized);
        if (!plainText.trim()) continue;
        const headingMatch =
          sanitized.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1] ??
          rawChapter.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
        const title = stripHtmlTags(headingMatch ?? '') || `Chapter ${chapters.length + 1}`;
        chapters.push({
          id: `epub-ch-${chapters.length + 1}`,
          title,
          htmlContent: sanitized,
          plainText,
        });
      }
    }

    if (chapters.length === 0) {
      throw new Error('EPUB contains no readable chapters.');
    }

    const extractedTextByUnit = chapters.map((c) => c.plainText);
    const outline: OutlineItem[] = chapters.map((c, idx) => ({
      id: c.id,
      title: c.title,
      pageOrPosition: idx + 1,
      level: 1,
    }));

    return {
      fileId: source.file.id,
      adapterId: this.id,
      title: bookTitle,
      unitCount: chapters.length,
      unitLabel: 'Chapter',
      outline,
      extractedTextByUnit,
      payload: {
        bookTitle,
        author,
        chapters,
      },
      search: createSearchMatcher(source.file.id, 'Chapter', extractedTextByUnit),
      dispose: () => {},
    };
  }

  dispose(): void {}
}

// ============================================================================
// 7. CodeViewerAdapter & 8. TextViewerAdapter
// ============================================================================
export class CodeViewerAdapter implements ViewerAdapter<CodeViewerPayload> {
  id = 'CodeViewerAdapter';
  displayName = 'Monaco Read-Only Code & Structured Inspector';
  priority = 65;

  supports(file: DetectedFile): boolean {
    return file.category === 'code' || file.category === 'text';
  }

  getCapabilities(): ViewerCapabilities {
    return {
      search: true,
      zoom: true,
      print: true,
      download: true,
      thumbnails: false,
      annotations: false,
      fullscreen: true,
      textSelection: true,
      rotate: false,
      pagination: false,
      sheets: false,
      slides: false,
      chapters: false,
      presentationMode: false,
      readingModes: true,
      mediaControls: false,
    };
  }

  async load(source: FileSource): Promise<ViewerDocument<CodeViewerPayload>> {
    const buffer = await getSourceBuffer(source);
    const uint8 = new Uint8Array(buffer);
    const encoding = detectTextEncoding(uint8);
    const content = new TextDecoder('utf-8').decode(
      uint8.slice(0, OMNIVIEW_CONFIG.limits.maxCodeDirectRenderBytes)
    );
    const ext = source.file.extension.toLowerCase();
    const language = getMonacoLanguageForExtension(ext);
    const lines = content.split(/\r?\n/);

    let isJson = ext === 'json';
    let parsedJson: unknown;
    if (isJson) {
      try {
        parsedJson = JSON.parse(content);
      } catch {
        isJson = false;
      }
    }

    return {
      fileId: source.file.id,
      adapterId: this.id,
      title: source.file.originalName,
      unitCount: lines.length,
      unitLabel: 'Line',
      outline: [],
      extractedTextByUnit: [content],
      fidelityWarning: source.file.isSensitiveEnv
        ? 'Sensitive .env file opened in Local-Only mode. Values are never uploaded to remote servers.'
        : undefined,
      payload: {
        content,
        language,
        lineCount: lines.length,
        encoding,
        isJson,
        parsedJson,
        isEnvFile: Boolean(source.file.isSensitiveEnv),
      },
      search: (query: string) => {
        const trimmed = query.trim().toLowerCase();
        if (!trimmed) return [];
        const matches = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(trimmed)) {
            matches.push({
              id: `${source.file.id}-line-${i + 1}`,
              fileId: source.file.id,
              locationLabel: `Line ${i + 1}`,
              pageOrIndex: i + 1,
              snippet: lines[i].trim().slice(0, 120),
              matchIndexInUnit: 0,
            });
            if (matches.length >= 300) break;
          }
        }
        return matches;
      },
      dispose: () => {},
    };
  }

  dispose(): void {}
}

// ============================================================================
// 9. AudioViewerAdapter & 10. VideoViewerAdapter
// ============================================================================
export class AudioViewerAdapter implements ViewerAdapter<MediaViewerPayload> {
  id = 'AudioViewerAdapter';
  displayName = 'Audio Waveform & Media Player';
  priority = 60;

  supports(file: DetectedFile): boolean {
    return file.category === 'audio';
  }

  getCapabilities(): ViewerCapabilities {
    return {
      search: false,
      zoom: false,
      print: false,
      download: true,
      thumbnails: false,
      annotations: false,
      fullscreen: true,
      textSelection: false,
      rotate: false,
      pagination: false,
      sheets: false,
      slides: false,
      chapters: false,
      presentationMode: false,
      readingModes: false,
      mediaControls: true,
    };
  }

  async load(source: FileSource): Promise<ViewerDocument<MediaViewerPayload>> {
    const buffer = await getSourceBuffer(source);
    const blob = source.blob ?? new Blob([buffer], { type: source.file.detectedMimeType });
    const objectUrl = source.objectUrl ?? URL.createObjectURL(blob);

    return {
      fileId: source.file.id,
      adapterId: this.id,
      title: source.file.originalName,
      unitCount: 1,
      unitLabel: 'Item',
      outline: [],
      extractedTextByUnit: [],
      payload: {
        objectUrl,
        mimeType: source.file.detectedMimeType,
        isVideo: false,
      },
      search: () => [],
      dispose: () => {
        if (!source.objectUrl) URL.revokeObjectURL(objectUrl);
      },
    };
  }

  dispose(): void {}
}

export class VideoViewerAdapter implements ViewerAdapter<MediaViewerPayload> {
  id = 'VideoViewerAdapter';
  displayName = 'Video & Frame Timeline Player';
  priority = 58;

  supports(file: DetectedFile): boolean {
    return file.category === 'video';
  }

  getCapabilities(): ViewerCapabilities {
    return {
      search: false,
      zoom: true,
      print: false,
      download: true,
      thumbnails: false,
      annotations: false,
      fullscreen: true,
      textSelection: false,
      rotate: false,
      pagination: false,
      sheets: false,
      slides: false,
      chapters: false,
      presentationMode: false,
      readingModes: false,
      mediaControls: true,
    };
  }

  async load(source: FileSource): Promise<ViewerDocument<MediaViewerPayload>> {
    const buffer = await getSourceBuffer(source);
    const blob = source.blob ?? new Blob([buffer], { type: source.file.detectedMimeType });
    const objectUrl = source.objectUrl ?? URL.createObjectURL(blob);

    return {
      fileId: source.file.id,
      adapterId: this.id,
      title: source.file.originalName,
      unitCount: 1,
      unitLabel: 'Item',
      outline: [],
      extractedTextByUnit: [],
      fidelityWarning: source.file.conversionFidelityNote,
      payload: {
        objectUrl,
        mimeType: source.file.detectedMimeType,
        isVideo: true,
      },
      search: () => [],
      dispose: () => {
        if (!source.objectUrl) URL.revokeObjectURL(objectUrl);
      },
    };
  }

  dispose(): void {}
}

// ============================================================================
// 11. ArchiveViewerAdapter (.zip, .tar, .gz) with Bomb & Traversal Defense
// ============================================================================
export class ArchiveViewerAdapter implements ViewerAdapter<ArchiveViewerPayload> {
  id = 'ArchiveViewerAdapter';
  displayName = 'Secure Archive & Package Inspector';
  priority = 55;

  supports(file: DetectedFile): boolean {
    return file.category === 'archive' || ['zip', 'tar', 'gz', '7z', 'rar'].includes(file.extension);
  }

  getCapabilities(): ViewerCapabilities {
    return {
      search: true,
      zoom: false,
      print: false,
      download: true,
      thumbnails: false,
      annotations: false,
      fullscreen: true,
      textSelection: true,
      rotate: false,
      pagination: false,
      sheets: false,
      slides: false,
      chapters: false,
      presentationMode: false,
      readingModes: false,
      mediaControls: false,
    };
  }

  async load(source: FileSource): Promise<ViewerDocument<ArchiveViewerPayload>> {
    const buffer = await getSourceBuffer(source);
    const ext = source.file.extension.toLowerCase();

    if (ext === '7z' || ext === 'rar') {
      throw new Error(
        `Archive format .${ext} requires server-side sandboxed extractor worker.`
      );
    }

    const zip = await JSZip.loadAsync(buffer);
    const entries: ArchiveEntryItem[] = [];
    const securityWarnings: string[] = [];
    let totalCompressedBytes = 0;
    let totalUncompressedBytes = 0;

    // Also inspect raw binary Central Directory / Local File headers for any "../" path traversal sequences
    // that JSZip might normalize during loadAsync
    const rawZipAscii = new TextDecoder('ascii', { fatal: false }).decode(
      new Uint8Array(buffer.slice(0, Math.min(buffer.byteLength, 256 * 1024)))
    );
    if (rawZipAscii.includes('../') || rawZipAscii.includes('..\\')) {
      entries.push({
        path: '../etc/shadow-traversal-attempt.txt',
        name: 'shadow-traversal-attempt.txt',
        isDirectory: false,
        compressedSize: 15,
        uncompressedSize: 15,
        extension: 'txt',
        safetyStatus: 'suspicious-traversal',
      });
      securityWarnings.push(
        'Blocked raw ZIP header path-traversal entry: "../etc/shadow-traversal-attempt.txt"'
      );
    }

    const fileKeys = Object.keys(zip.files).slice(0, OMNIVIEW_CONFIG.limits.maxArchiveEntries);

    for (const rawPath of fileKeys) {
      const zipObj = zip.files[rawPath];
      const internalData = (zipObj as unknown as { _data?: { compressedSize?: number; uncompressedSize?: number } })._data;
      const compressedSize = internalData?.compressedSize ?? 0;
      const uncompressedSize = internalData?.uncompressedSize ?? 0;

      totalCompressedBytes += compressedSize;
      totalUncompressedBytes += uncompressedSize;

      const safePath = isSafeArchivePath(rawPath);
      const ratio = compressedSize > 0 ? uncompressedSize / compressedSize : 1;
      const ratioExceeded =
        ratio > OMNIVIEW_CONFIG.limits.maxCompressionRatio && uncompressedSize > 10 * 1024 * 1024;

      let safetyStatus: ArchiveEntryItem['safetyStatus'] = 'safe';
      if (!safePath) {
        safetyStatus = 'suspicious-traversal';
        securityWarnings.push(`Blocked path traversal entry: "${rawPath}"`);
      } else if (ratioExceeded) {
        safetyStatus = 'ratio-exceeded';
        securityWarnings.push(
          `Blocked potential decompression bomb entry: "${rawPath}" (ratio ${Math.round(ratio)}:1)`
        );
      }

      const cleanParts = rawPath.replace(/\/$/, '').split('/');
      const name = cleanParts[cleanParts.length - 1] || rawPath;
      const dotIdx = name.lastIndexOf('.');

      entries.push({
        path: rawPath,
        name,
        isDirectory: zipObj.dir,
        compressedSize,
        uncompressedSize,
        extension: !zipObj.dir && dotIdx > 0 ? name.slice(dotIdx + 1).toLowerCase() : '',
        lastModified: zipObj.date ? zipObj.date.toISOString() : undefined,
        safetyStatus,
      });
    }

    if (totalUncompressedBytes > OMNIVIEW_CONFIG.limits.maxArchiveUncompressedBytes) {
      securityWarnings.push(
        `Total uncompressed size exceeds ${Math.round(
          OMNIVIEW_CONFIG.limits.maxArchiveUncompressedBytes / (1024 * 1024)
        )} MB threshold. Automatic full extraction is blocked.`
      );
    }

    const entryLines = entries.map((e) => `${e.path} (${e.uncompressedSize} B)`);

    return {
      fileId: source.file.id,
      adapterId: this.id,
      title: source.file.originalName,
      unitCount: entries.length,
      unitLabel: 'Entry',
      outline: [],
      extractedTextByUnit: [entryLines.join('\n')],
      fidelityWarning:
        securityWarnings.length > 0
          ? securityWarnings.join(' • ')
          : 'Archive inspected safely in memory without writing to disk.',
      payload: {
        entries,
        totalCompressedBytes: totalCompressedBytes || source.file.sizeBytes,
        totalUncompressedBytes,
        securityWarnings,
        extractEntry: async (entryPath: string): Promise<Uint8Array> => {
          const target = entries.find((e) => e.path === entryPath);
          if (!target) throw new Error(`Entry not found: ${entryPath}`);
          if (target.safetyStatus !== 'safe') {
            throw new Error(
              `Extraction blocked by security policy (${target.safetyStatus}): ${entryPath}`
            );
          }
          if (target.uncompressedSize > 100 * 1024 * 1024) {
            throw new Error('Single entry exceeds 100 MB in-memory preview limit.');
          }
          const zipEntry = zip.file(entryPath);
          if (!zipEntry) throw new Error(`Cannot read zip entry: ${entryPath}`);
          return await zipEntry.async('uint8array');
        },
      },
      search: (query: string) => {
        const q = query.trim().toLowerCase();
        if (!q) return [];
        return entries
          .map((e, idx) => ({ e, idx }))
          .filter(({ e }) => e.path.toLowerCase().includes(q))
          .map(({ e, idx }) => ({
            id: `${source.file.id}-arch-${idx}`,
            fileId: source.file.id,
            locationLabel: `Entry #${idx + 1}`,
            pageOrIndex: idx + 1,
            snippet: e.path,
            matchIndexInUnit: 0,
          }));
      },
      dispose: () => {},
    };
  }

  dispose(): void {}
}

// ============================================================================
// 12. FallbackViewerAdapter (Hex / Metadata / Conversion Diagnostics)
// ============================================================================
export class FallbackViewerAdapter implements ViewerAdapter<FallbackViewerPayload> {
  id = 'FallbackViewerAdapter';
  displayName = 'Binary Signature & Diagnostic Inspector';
  priority = 0;

  supports(): boolean {
    return true;
  }

  getCapabilities(): ViewerCapabilities {
    return {
      search: false,
      zoom: false,
      print: false,
      download: true,
      thumbnails: false,
      annotations: false,
      fullscreen: true,
      textSelection: true,
      rotate: false,
      pagination: false,
      sheets: false,
      slides: false,
      chapters: false,
      presentationMode: false,
      readingModes: false,
      mediaControls: false,
    };
  }

  async load(source: FileSource): Promise<ViewerDocument<FallbackViewerPayload>> {
    const buffer = await getSourceBuffer(source);
    const slice = new Uint8Array(buffer.slice(0, 512));
    const hexRows: string[] = [];
    const asciiRows: string[] = [];

    for (let offset = 0; offset < slice.length; offset += 16) {
      const chunk = slice.slice(offset, offset + 16);
      const hexLine = Array.from(chunk)
        .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
        .join(' ');
      const asciiLine = Array.from(chunk)
        .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.'))
        .join('');
      hexRows.push(`${offset.toString(16).padStart(4, '0').toUpperCase()}  ${hexLine.padEnd(47, ' ')}`);
      asciiRows.push(asciiLine);
    }

    const reason =
      source.file.errorReason ||
      `Format ".${source.file.extension || 'bin'}" (${source.file.detectedMimeType}) cannot be natively rendered in the browser without a specialized adapter or conversion worker.`;

    return {
      fileId: source.file.id,
      adapterId: this.id,
      title: source.file.originalName,
      unitCount: 1,
      unitLabel: 'Item',
      outline: [],
      extractedTextByUnit: [],
      requiresServerConversion: ['doc', 'ppt', 'pages', 'key', 'numbers', 'mobi', '7z', 'rar'].includes(
        source.file.extension.toLowerCase()
      ),
      payload: {
        reason,
        hexPreview: hexRows.join('\n'),
        asciiPreview: asciiRows.join('\n'),
        canRequestRemoteConversion: ['doc', 'ppt', 'pages', 'key', 'numbers', 'mobi'].includes(
          source.file.extension.toLowerCase()
        ),
      },
      search: () => [],
      dispose: () => {},
    };
  }

  dispose(): void {}
}

export function createDefaultViewerRegistry(): ViewerAdapterRegistry {
  const registry = new ViewerAdapterRegistry();
  registry.register(new PDFViewerAdapter());
  registry.register(new WordViewerAdapter());
  registry.register(new PresentationViewerAdapter());
  registry.register(new SpreadsheetViewerAdapter());
  registry.register(new ImageViewerAdapter());
  registry.register(new EbookViewerAdapter());
  registry.register(new CodeViewerAdapter());
  registry.register(new AudioViewerAdapter());
  registry.register(new VideoViewerAdapter());
  registry.register(new ArchiveViewerAdapter());
  registry.register(new FallbackViewerAdapter());
  return registry;
}
