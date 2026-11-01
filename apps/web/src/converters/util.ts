import type { Level } from './types';

export interface LevelSettings {
  /** 0..1 encoder quality for lossy image output. */
  quality: number;
  /** Longest image edge when compressing; 0 keeps the original size. */
  maxDim: number;
  /** x264 constant rate factor (higher is smaller). */
  crf: number;
  /** Tallest video frame in px; 0 keeps the original size. */
  videoHeight: number;
  audioKbps: number;
  /** PDF page render scale (1 = 72 dpi) and JPEG quality when flattening. */
  pdfScale: number;
  pdfQuality: number;
}

export const LEVELS: Record<Level, LevelSettings> = {
  small: { quality: 0.6, maxDim: 1600, crf: 34, videoHeight: 480, audioKbps: 64, pdfScale: 1, pdfQuality: 0.55 },
  balanced: { quality: 0.78, maxDim: 2560, crf: 28, videoHeight: 720, audioKbps: 128, pdfScale: 1.4, pdfQuality: 0.72 },
  best: { quality: 0.92, maxDim: 0, crf: 23, videoHeight: 0, audioKbps: 192, pdfScale: 2, pdfQuality: 0.88 },
};

export const LEVEL_LABELS: Record<Level, string> = { small: 'Smallest', balanced: 'Balanced', best: 'Best quality' };

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
  svg: 'image/svg+xml', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', yaml: 'application/yaml', yml: 'application/yaml', xml: 'application/xml',
  html: 'text/html', md: 'text/markdown', zip: 'application/zip', tar: 'application/x-tar', gz: 'application/gzip',
  tgz: 'application/gzip', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
  ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/mp4',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
};

export const mimeFor = (ext: string): string => MIME[ext.toLowerCase()] ?? 'application/octet-stream';

export const baseName = (name: string): string => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
};

/** `report.docx` + `pdf` -> `report.pdf`; compress keeps the name and adds a marker. */
export function outputName(name: string, ext: string, compress: boolean): string {
  const base = baseName(name).replace(/\.(tar)$/i, '');
  return compress ? `${base} (compressed).${ext}` : `${base}.${ext}`;
}

/** Picks `name (2).ext` style names that don't collide with `taken`. */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, (n) => n.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  const base = baseName(name);
  const ext = name.slice(base.length);
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export const textDecode = (b: Uint8Array): string => new TextDecoder('utf-8').decode(b);
export const textEncode = (s: string): Uint8Array => new TextEncoder().encode(s);

export const lower = (s: string) => s.toLowerCase();
