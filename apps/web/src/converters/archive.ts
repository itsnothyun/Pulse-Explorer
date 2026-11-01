import { gunzipSync, gzipSync, unzipSync, zipSync, type Zippable } from 'fflate';
import { ConvertError, type ConvertInput, type ConvertOutput, type Converter, type FileInfo } from './types';
import { ARCHIVE_FORMATS } from './targets';
import { baseName, mimeFor } from './util';

export type Entries = Record<string, Uint8Array>;

const MAX_TOTAL = 1024 * 1024 * 1024;
const MAX_RATIO = 100;

/** Rejects zip-slip paths and normalizes separators. */
export function safeEntryName(raw: string): string | null {
  const name = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null;
  if (name.split('/').some((p) => p === '..')) return null;
  return name;
}

// ------------------------------------------------------------------ tar

const enc = new TextEncoder();
const dec = new TextDecoder();

function octal(n: number, len: number): Uint8Array {
  return enc.encode(n.toString(8).padStart(len - 1, '0') + '\0');
}

function tarHeader(name: string, size: number): Uint8Array {
  const h = new Uint8Array(512);
  let prefix = '';
  let short = name;
  if (enc.encode(name).length > 100) {
    const cut = name.lastIndexOf('/', 155 + 100);
    const idx = name.slice(0, cut).length > 155 ? -1 : cut;
    if (idx <= 0 || enc.encode(name.slice(idx + 1)).length > 100) {
      throw new ConvertError(`"${name}" has a path too long for the tar format.`);
    }
    prefix = name.slice(0, idx);
    short = name.slice(idx + 1);
  }
  h.set(enc.encode(short), 0);
  h.set(enc.encode('0000644\0'), 100);
  h.set(enc.encode('0000000\0'), 108);
  h.set(enc.encode('0000000\0'), 116);
  h.set(octal(size, 12), 124);
  h.set(octal(Math.floor(Date.now() / 1000), 12), 136);
  h.fill(0x20, 148, 156);
  h[156] = 0x30;
  h.set(enc.encode('ustar\0'), 257);
  h.set(enc.encode('00'), 263);
  h.set(enc.encode(prefix), 345);
  let sum = 0;
  for (const b of h) sum += b;
  h.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148);
  return h;
}

export function writeTar(entries: Entries): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const [name, data] of Object.entries(entries)) {
    const header = tarHeader(name, data.length);
    const pad = (512 - (data.length % 512)) % 512;
    parts.push(header, data, new Uint8Array(pad));
    total += 512 + data.length + pad;
  }
  parts.push(new Uint8Array(1024));
  total += 1024;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const cstr = (b: Uint8Array, s: number, e: number) => {
  let end = s;
  while (end < e && b[end] !== 0) end++;
  return dec.decode(b.subarray(s, end));
};

export function isTar(b: Uint8Array): boolean {
  return b.length >= 512 && cstr(b, 257, 262) === 'ustar';
}

export function readTar(b: Uint8Array): Entries {
  const out: Entries = {};
  let pos = 0;
  let longName: string | null = null;
  let total = 0;
  while (pos + 512 <= b.length) {
    if (b.subarray(pos, pos + 512).every((x) => x === 0)) break;
    const size = parseInt(cstr(b, pos + 124, pos + 136).trim() || '0', 8);
    const type = String.fromCharCode(b[pos + 156] || 0x30);
    const prefix = cstr(b, pos + 345, pos + 500);
    let name = cstr(b, pos, pos + 100);
    if (prefix) name = `${prefix}/${name}`;
    const start = pos + 512;
    if (Number.isNaN(size) || start + size > b.length) throw new ConvertError('The tar archive is truncated or corrupt.');
    if (type === 'L') {
      longName = cstr(b, start, start + size);
    } else if (type === '0' || type === '\0') {
      const safe = safeEntryName(longName ?? name);
      longName = null;
      total += size;
      if (total > MAX_TOTAL) throw new ConvertError('The archive expands to more than 1 GB; refusing to open it.');
      if (safe) out[safe] = b.slice(start, start + size);
    }
    pos = start + Math.ceil(size / 512) * 512;
  }
  return out;
}

// -------------------------------------------------------------- read/write

export function readArchive(bytes: Uint8Array, info: FileInfo, name: string): Entries {
  const ext = info.extension.toLowerCase();
  if (ext === 'zip') {
    let total = 0;
    const raw = unzipSync(bytes, {
      filter: (f) => {
        total += f.originalSize;
        if (total > MAX_TOTAL) throw new ConvertError('The archive expands to more than 1 GB; refusing to open it.');
        if (f.originalSize > 10 * 1024 * 1024 && f.originalSize / Math.max(1, f.size) > MAX_RATIO) {
          throw new ConvertError('Compression ratio above 100:1 looks like a zip bomb; refusing to open it.');
        }
        return !f.name.endsWith('/');
      },
    });
    const out: Entries = {};
    for (const [k, v] of Object.entries(raw)) {
      const safe = safeEntryName(k);
      if (safe) out[safe] = v;
    }
    return out;
  }
  if (ext === 'tar') return readTar(bytes);
  // gz / tgz
  const inflated = gunzipSync(bytes);
  if (isTar(inflated)) return readTar(inflated);
  return { [baseName(name).replace(/\.tar$/i, '') || 'file']: inflated };
}

function toZip(entries: Entries, level: 6 | 9): Uint8Array {
  const z: Zippable = {};
  for (const [k, v] of Object.entries(entries)) z[k] = [v, { level }];
  return zipSync(z);
}

// ---------------------------------------------------------------- converter

export const archiveConverter: Converter = {
  id: 'archive',

  async run(target, input: ConvertInput): Promise<ConvertOutput> {
    const ext = input.info.extension.toLowerCase();
    if (target.compress && (ext === 'gz' || ext === 'tgz')) {
      // Recompress the gzip stream as-is so a plain .gz stays a plain .gz.
      return { bytes: gzipSync(gunzipSync(input.bytes), { level: 9 }), ext, mime: mimeFor(ext) };
    }
    const entries = readArchive(input.bytes, input.info, input.name);
    if (Object.keys(entries).length === 0) throw new ConvertError('The archive has no files to convert.');
    const id = target.compress ? ext : target.id;
    let bytes: Uint8Array;
    if (id === 'zip') bytes = toZip(entries, 9);
    else if (id === 'tar') bytes = writeTar(entries);
    else bytes = gzipSync(writeTar(entries), { level: 9 });
    const outExt = ARCHIVE_FORMATS[id].ext;
    return { bytes, ext: outExt, mime: mimeFor(outExt) };
  },
};

/** Builds a zip from named files; used by multi-file outputs such as PDF pages. */
export function zipFiles(entries: Entries): Uint8Array {
  return toZip(entries, 6);
}
