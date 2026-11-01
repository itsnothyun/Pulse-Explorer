/**
 * Which conversions each file type offers. Kept free of heavy imports so the
 * app can build the long-press circle without loading any converter engine.
 */
import type { ConvertTarget, FileInfo } from './types';

const ext = (info: FileInfo) => info.extension.toLowerCase();

// ---------------------------------------------------------------- images
export const RASTER = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];

export function imageTargets(info: FileInfo): ConvertTarget[] {
  const e = ext(info);
  if (!RASTER.includes(e) && e !== 'svg') return [];
  const own = e === 'jpeg' ? 'jpg' : e;
  const list: ConvertTarget[] = ['png', 'jpg', 'webp', 'bmp']
    .filter((id) => id !== own)
    .map((id) => ({ id, label: id.toUpperCase(), ext: id }));
  list.push({ id: 'pdf', label: 'PDF', ext: 'pdf' });
  if (['png', 'jpg', 'jpeg', 'webp', 'svg'].includes(e)) list.push({ id: 'compress', label: 'Compress', ext: own, compress: true });
  return list;
}

// ------------------------------------------------------------------- pdf
export function pdfTargets(info: FileInfo): ConvertTarget[] {
  if (ext(info) !== 'pdf') return [];
  return [
    { id: 'png', label: 'PNG', ext: 'png', note: 'One image per page (ZIP when several)' },
    { id: 'jpg', label: 'JPG', ext: 'jpg', note: 'One image per page (ZIP when several)' },
    { id: 'txt', label: 'TXT', ext: 'txt', note: 'Selectable text only' },
    { id: 'compress', label: 'Compress', ext: 'pdf', compress: true, note: 'Smallest and Balanced flatten pages to images' },
  ];
}

// ---------------------------------------------------------------- office
/** OOXML and ODF containers are plain zips, so they can be repacked. */
export const ZIP_DOCS = ['docx', 'pptx', 'xlsx', 'odt', 'ods', 'odp', 'epub'];

export function officeTargets(info: FileInfo): ConvertTarget[] {
  const e = ext(info);
  const list: ConvertTarget[] = [];
  if (e === 'docx') list.push({ id: 'txt', label: 'TXT', ext: 'txt' }, { id: 'pdf', label: 'PDF', ext: 'pdf', note: 'Text only: images and layout are not carried over' });
  if (e === 'pptx') list.push({ id: 'txt', label: 'TXT', ext: 'txt' }, { id: 'pdf', label: 'PDF', ext: 'pdf', note: 'Slide text only: images and layout are not carried over' });
  if (e === 'xlsx' || e === 'xls' || e === 'ods') list.push({ id: 'pdf', label: 'PDF', ext: 'pdf', note: 'Cell values as a text table' });
  if (ZIP_DOCS.includes(e)) list.push({ id: 'compress', label: 'Compress', ext: e, compress: true, note: 'Repacks and shrinks embedded photos' });
  return list;
}

// ------------------------------------------------------------------ data
const TABULAR = ['csv', 'tsv', 'xlsx', 'xls', 'ods'];
const STRUCTURED = ['json', 'yaml', 'yml'];
const PLAIN_TEXT = ['txt', 'md', 'log', 'html', 'xml', 'sql', 'sh', 'ini', 'toml', 'css', 'js', 'ts', 'py', 'go', 'rs'];
const DATA_LABEL: Record<string, string> = { csv: 'CSV', tsv: 'TSV', json: 'JSON', yaml: 'YAML', xlsx: 'XLSX', ods: 'ODS' };

export function dataTargets(info: FileInfo): ConvertTarget[] {
  const e = ext(info);
  const own = e === 'yml' ? 'yaml' : e;
  if (PLAIN_TEXT.includes(e)) return [{ id: 'gz', label: 'GZIP', ext: `${e}.gz` }];
  if (![...TABULAR, ...STRUCTURED].includes(e)) return [];
  const list: ConvertTarget[] = ['csv', 'tsv', 'json', 'yaml', 'xlsx', 'ods']
    .filter((id) => id !== own)
    .map((id) => ({ id, label: DATA_LABEL[id], ext: id, note: id === 'csv' || id === 'tsv' ? 'First sheet only' : undefined }));
  if (e === 'json') list.push({ id: 'compress', label: 'Compress', ext: 'json', compress: true, note: 'Minifies whitespace' });
  return list;
}

// ----------------------------------------------------------------- media
export const VIDEO = ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'];
export const AUDIO = ['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'opus'];

export function mediaTargets(info: FileInfo): ConvertTarget[] {
  const e = ext(info);
  if (VIDEO.includes(e)) {
    const own = e === 'm4v' ? 'mp4' : e;
    const list: ConvertTarget[] = ['mp4', 'webm'].filter((id) => id !== own).map((id) => ({ id, label: id.toUpperCase(), ext: id }));
    list.push({ id: 'mp3', label: 'MP3', ext: 'mp3', note: 'Audio only' });
    list.push({ id: 'compress', label: 'Compress', ext: own === 'webm' ? 'webm' : 'mp4', compress: true, note: 'Re-encodes video; can take a while' });
    return list;
  }
  if (AUDIO.includes(e)) {
    const own = e === 'aac' ? 'm4a' : e;
    const list: ConvertTarget[] = ['mp3', 'wav', 'ogg', 'flac', 'm4a'].filter((id) => id !== own).map((id) => ({ id, label: id.toUpperCase(), ext: id }));
    const compressTo = e === 'wav' ? 'flac' : e === 'opus' || e === 'aac' ? 'm4a' : e;
    list.push({ id: 'compress', label: 'Compress', ext: compressTo, compress: true, note: e === 'wav' ? 'Lossless FLAC' : undefined });
    return list;
  }
  return [];
}

// --------------------------------------------------------------- archive
export const ARCHIVE_FORMATS: Record<string, { label: string; ext: string }> = {
  zip: { label: 'ZIP', ext: 'zip' },
  tar: { label: 'TAR', ext: 'tar' },
  tgz: { label: 'TAR.GZ', ext: 'tgz' },
};

export function archiveTargets(info: FileInfo): ConvertTarget[] {
  const e = ext(info);
  if (!['zip', 'tar', 'gz', 'tgz'].includes(e)) return [];
  const own = e === 'gz' ? 'tgz' : e;
  const list: ConvertTarget[] = Object.entries(ARCHIVE_FORMATS)
    .filter(([id]) => id !== own)
    .map(([id, f]) => ({ id, label: f.label, ext: f.ext }));
  if (e !== 'tar') list.push({ id: 'compress', label: 'Compress', ext: e, compress: true });
  return list;
}
