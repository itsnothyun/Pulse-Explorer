import { PDFDocument } from 'pdf-lib';
import { ConvertError, type ConvertOutput, type ConvertTarget, type Converter, type FileInfo } from './types';
import { LEVELS, mimeFor, textDecode, textEncode, type LevelSettings } from './util';

interface Decoded {
  img: HTMLImageElement;
  width: number;
  height: number;
}

async function decode(bytes: Uint8Array, ext: string): Promise<Decoded> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeFor(ext) }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // SVGs without intrinsic size report 0.
    const width = img.naturalWidth || 1024;
    const height = img.naturalHeight || width;
    return { img, width, height };
  } catch {
    throw new ConvertError('This image could not be decoded. It may be corrupt.');
  } finally {
    // The decoded bitmap stays valid after revoking.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function draw({ img, width, height }: Decoded, maxDim: number, opaque: boolean): HTMLCanvasElement {
  const scale = maxDim > 0 ? Math.min(1, maxDim / Math.max(width, height)) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ConvertError('Canvas is not available in this environment.');
  if (opaque) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function encode(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, mime, quality));
  if (!blob || blob.type !== mime) {
    throw new ConvertError(`This browser can't encode ${mime.split('/')[1].toUpperCase()}.`);
  }
  return new Uint8Array(await blob.arrayBuffer());
}

/** Uncompressed 24-bit BMP; transparency is flattened onto white. */
function encodeBmp(canvas: HTMLCanvasElement): Uint8Array {
  const { width, height } = canvas;
  const data = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const out = new Uint8Array(54 + rowSize * height);
  const v = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  v.setUint32(2, out.length, true);
  v.setUint32(10, 54, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, width, true);
  v.setInt32(22, height, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 24, true);
  v.setUint32(34, rowSize * height, true);
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = data[i + 3] / 255;
      const blend = (c: number) => Math.round(c * a + 255 * (1 - a));
      out[row + x * 3] = blend(data[i + 2]);
      out[row + x * 3 + 1] = blend(data[i + 1]);
      out[row + x * 3 + 2] = blend(data[i]);
    }
  }
  return out;
}

/**
 * Re-encodes an embedded image smaller, keeping its format. Returns null when
 * there is nothing to gain (for example a PNG that doesn't need scaling).
 */
export async function recompressRaster(bytes: Uint8Array, ext: string, s: LevelSettings): Promise<Uint8Array | null> {
  const decoded = await decode(bytes, ext);
  const scaled = s.maxDim > 0 && Math.max(decoded.width, decoded.height) > s.maxDim;
  if (ext === 'png' && !scaled) return null;
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return encode(draw(decoded, s.maxDim, mime === 'image/jpeg'), mime, s.quality);
}

async function toPdf(bytes: Uint8Array, ext: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  let embedded;
  if (ext === 'jpg' || ext === 'jpeg') {
    embedded = await pdf.embedJpg(bytes);
  } else {
    const decoded = await decode(bytes, ext);
    embedded = await pdf.embedPng(await encode(draw(decoded, 0, false), 'image/png', 1));
  }
  // 1 px = 0.75 pt keeps the image at its natural 96 dpi size.
  const page = pdf.addPage([embedded.width * 0.75, embedded.height * 0.75]);
  page.drawImage(embedded, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  return pdf.save();
}

const minifySvg = (svg: string) =>
  svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim();

const TARGET_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

export const imageConverter: Converter = {
  id: 'image',

  async run(target, input): Promise<ConvertOutput> {
    const ext = input.info.extension.toLowerCase();
    const s = LEVELS[input.level];

    if (target.compress) {
      if (ext === 'svg') return { bytes: textEncode(minifySvg(textDecode(input.bytes))), ext: 'svg', mime: mimeFor('svg') };
      const out = await recompressRaster(input.bytes, ext, s);
      if (!out) throw new ConvertError('PNG is lossless and this one is already within the size limit. Try the Smallest level, or convert to WebP.');
      const outExt = ext === 'jpeg' ? 'jpg' : ext;
      return { bytes: out, ext: outExt, mime: mimeFor(outExt) };
    }

    if (target.id === 'pdf') return { bytes: await toPdf(input.bytes, ext), ext: 'pdf', mime: mimeFor('pdf') };

    const decoded = await decode(input.bytes, ext);
    if (target.id === 'bmp') return { bytes: encodeBmp(draw(decoded, 0, true)), ext: 'bmp', mime: mimeFor('bmp') };
    const mime = TARGET_MIME[target.id];
    const bytes = await encode(draw(decoded, 0, target.id === 'jpg'), mime, s.quality);
    return { bytes, ext: target.id, mime };
  },
};
