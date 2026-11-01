import type { FileCategory } from '@omniview/shared-types';
import { OMNIVIEW_CONFIG } from '@omniview/config';

export interface SignatureInspectionResult {
  extension: string;
  detectedMimeType: string;
  category: FileCategory;
  magicSignatureHex: string;
  hasMacrosWarning: boolean;
  isSensitiveEnv: boolean;
  conversionRequired: boolean;
  conversionFidelityNote?: string;
}

const CODE_EXTENSIONS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'py', 'php', 'java', 'c', 'cpp', 'h', 'hpp',
  'cs', 'go', 'rs', 'sql', 'json', 'xml', 'yaml', 'yml', 'toml', 'env',
  'css', 'scss', 'less', 'sh', 'bash', 'ps1', 'dockerfile', 'graphql',
]);

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'log', 'rtf', 'html', 'htm', 'ini', 'conf',
]);

const SPREADSHEET_EXTENSIONS = new Set([
  'xlsx', 'xls', 'xlsm', 'ods', 'csv', 'tsv', 'numbers',
]);

const PRESENTATION_EXTENSIONS = new Set([
  'pptx', 'ppt', 'odp', 'ppsx', 'key',
]);

const WORD_EXTENSIONS = new Set([
  'docx', 'doc', 'odt', 'pages',
]);

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg', 'tif', 'tiff',
]);

const EBOOK_EXTENSIONS = new Set([
  'epub', 'fb2', 'mobi',
]);

const AUDIO_EXTENSIONS = new Set([
  'mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac',
]);

const VIDEO_EXTENSIONS = new Set([
  'mp4', 'webm', 'mov', 'mkv', 'avi',
]);

const ARCHIVE_EXTENSIONS = new Set([
  'zip', 'tar', 'gz', 'tgz', '7z', 'rar',
]);

export function extractExtension(filename: string): string {
  const trimmed = filename.trim();
  if (trimmed === '.env' || trimmed.endsWith('/.env') || trimmed.endsWith('\\.env')) {
    return 'env';
  }
  const base = trimmed.split(/[/\\]/).pop() ?? trimmed;
  if (base.startsWith('.env.')) {
    return 'env';
  }
  const idx = base.lastIndexOf('.');
  if (idx <= 0 || idx === base.length - 1) return '';
  return base.slice(idx + 1).toLowerCase();
}

export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? 'unnamed-file';
  return base
    .replace(/[\x00-\x1f\x80-\x9f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 255) || 'unnamed-file';
}

export function isSafeArchivePath(entryPath: string): boolean {
  if (!entryPath || entryPath.includes('\0')) return false;
  const normalized = entryPath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    return false;
  }
  const segments = normalized.split('/');
  let depth = 0;
  for (const seg of segments) {
    if (seg === '..') {
      depth--;
      if (depth < 0) return false;
    } else if (seg && seg !== '.') {
      depth++;
    }
  }
  return depth >= 0 && !segments.includes('..');
}

export function bytesToHex(bytes: Uint8Array, maxBytes = 16): string {
  return Array.from(bytes.slice(0, maxBytes))
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
}

export function inspectFileSignature(
  filename: string,
  headerBytes: Uint8Array,
  declaredMime = ''
): SignatureInspectionResult {
  const ext = extractExtension(filename);
  const hex = bytesToHex(headerBytes, 12);
  const asciiHeader = new TextDecoder('ascii', { fatal: false }).decode(headerBytes.slice(0, 64));

  // 1. Check PDF magic header (%PDF-)
  if (asciiHeader.includes('%PDF-')) {
    return {
      extension: ext || 'pdf',
      detectedMimeType: 'application/pdf',
      category: 'pdf',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: false,
    };
  }

  // 2. Check PNG (89 50 4E 47 0D 0A 1A 0A)
  if (
    headerBytes.length >= 8 &&
    headerBytes[0] === 0x89 &&
    headerBytes[1] === 0x50 &&
    headerBytes[2] === 0x4e &&
    headerBytes[3] === 0x47
  ) {
    return {
      extension: ext || 'png',
      detectedMimeType: 'image/png',
      category: 'image',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: false,
    };
  }

  // 3. Check JPEG (FF D8 FF)
  if (
    headerBytes.length >= 3 &&
    headerBytes[0] === 0xff &&
    headerBytes[1] === 0xd8 &&
    headerBytes[2] === 0xff
  ) {
    return {
      extension: ext || 'jpg',
      detectedMimeType: 'image/jpeg',
      category: 'image',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: false,
    };
  }

  // 4. Check GIF (GIF87a / GIF89a)
  if (asciiHeader.startsWith('GIF87a') || asciiHeader.startsWith('GIF89a')) {
    return {
      extension: ext || 'gif',
      detectedMimeType: 'image/gif',
      category: 'image',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: false,
    };
  }

  // 5. Check WEBP / WAV / AVI (RIFF....WEBP / WAVE / AVI )
  if (asciiHeader.startsWith('RIFF') && headerBytes.length >= 12) {
    const subType = asciiHeader.slice(8, 12);
    if (subType === 'WEBP') {
      return {
        extension: ext || 'webp',
        detectedMimeType: 'image/webp',
        category: 'image',
        magicSignatureHex: hex,
        hasMacrosWarning: false,
        isSensitiveEnv: false,
        conversionRequired: false,
      };
    }
    if (subType === 'WAVE') {
      return {
        extension: ext || 'wav',
        detectedMimeType: 'audio/wav',
        category: 'audio',
        magicSignatureHex: hex,
        hasMacrosWarning: false,
        isSensitiveEnv: false,
        conversionRequired: false,
      };
    }
    if (subType === 'AVI ') {
      return {
        extension: ext || 'avi',
        detectedMimeType: 'video/x-msvideo',
        category: 'video',
        magicSignatureHex: hex,
        hasMacrosWarning: false,
        isSensitiveEnv: false,
        conversionRequired: true,
        conversionFidelityNote: 'AVI containers may require FFmpeg transcoding depending on browser codec support.',
      };
    }
  }

  // 6. Check TIFF (49 49 2A 00 or 4D 4D 00 2A)
  if (
    headerBytes.length >= 4 &&
    ((headerBytes[0] === 0x49 && headerBytes[1] === 0x49 && headerBytes[2] === 0x2a && headerBytes[3] === 0x00) ||
      (headerBytes[0] === 0x4d && headerBytes[1] === 0x4d && headerBytes[2] === 0x00 && headerBytes[3] === 0x2a))
  ) {
    return {
      extension: ext || 'tiff',
      detectedMimeType: 'image/tiff',
      category: 'image',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: false,
    };
  }

  // 7. Check ZIP-based containers (PK\x03\x04) -> DOCX, PPTX, XLSX,XLSM, ODT, ODS, ODP, EPUB, ZIP
  if (
    headerBytes.length >= 4 &&
    headerBytes[0] === 0x50 &&
    headerBytes[1] === 0x4b &&
    (headerBytes[2] === 0x03 || headerBytes[2] === 0x05) &&
    (headerBytes[3] === 0x04 || headerBytes[3] === 0x06)
  ) {
    if (ext === 'docx' || ext === 'odt' || ext === 'pages') {
      return {
        extension: ext,
        detectedMimeType:
          ext === 'docx'
            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : 'application/vnd.oasis.opendocument.text',
        category: 'word',
        magicSignatureHex: hex,
        hasMacrosWarning: false,
        isSensitiveEnv: false,
        conversionRequired: ext === 'pages',
        conversionFidelityNote:
          'Client-side semantic HTML & paginated preview active. Use LibreOffice/ONLYOFFICE conversion worker for exact Microsoft Word page breaks.',
      };
    }
    if (ext === 'pptx' || ext === 'ppsx' || ext === 'odp' || ext === 'key') {
      return {
        extension: ext,
        detectedMimeType:
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        category: 'presentation',
        magicSignatureHex: hex,
        hasMacrosWarning: false,
        isSensitiveEnv: false,
        conversionRequired: ext === 'key',
        conversionFidelityNote:
          'Static slide geometry, text, images, and speaker notes are rendered locally. PowerPoint animations, transitions, and embedded macros are not executed.',
      };
    }
    if (ext === 'xlsx' || ext === 'xlsm' || ext === 'ods' || ext === 'numbers') {
      return {
        extension: ext,
        detectedMimeType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        category: 'spreadsheet',
        magicSignatureHex: hex,
        hasMacrosWarning: ext === 'xlsm',
        isSensitiveEnv: false,
        conversionRequired: ext === 'numbers',
        conversionFidelityNote:
          ext === 'xlsm'
            ? 'Macro-enabled workbook (.xlsm) opened in safe non-executing mode. VBA macros are blocked; cached formula results and formulas are displayed.'
            : 'Interactive grid shows cached formula values and formula definitions without executing untrusted scripts.',
      };
    }
    if (ext === 'epub') {
      return {
        extension: 'epub',
        detectedMimeType: 'application/epub+zip',
        category: 'ebook',
        magicSignatureHex: hex,
        hasMacrosWarning: false,
        isSensitiveEnv: false,
        conversionRequired: false,
      };
    }
    return {
      extension: ext || 'zip',
      detectedMimeType: 'application/zip',
      category: 'archive',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: false,
    };
  }

  // 8. Check OLE2 Compound Document (D0 CF 11 E0 A1 B1 1A E1) -> Legacy .doc, .xls, .ppt
  if (
    headerBytes.length >= 8 &&
    headerBytes[0] === 0xd0 &&
    headerBytes[1] === 0xcf &&
    headerBytes[2] === 0x11 &&
    headerBytes[3] === 0xe0
  ) {
    if (ext === 'xls') {
      return {
        extension: 'xls',
        detectedMimeType: 'application/vnd.ms-excel',
        category: 'spreadsheet',
        magicSignatureHex: hex,
        hasMacrosWarning: true,
        isSensitiveEnv: false,
        conversionRequired: false,
        conversionFidelityNote: 'Legacy BIFF8 (.xls) opened in non-executing safe grid mode.',
      };
    }
    if (ext === 'ppt') {
      return {
        extension: 'ppt',
        detectedMimeType: 'application/vnd.ms-powerpoint',
        category: 'presentation',
        magicSignatureHex: hex,
        hasMacrosWarning: true,
        isSensitiveEnv: false,
        conversionRequired: true,
        conversionFidelityNote: 'Legacy binary PowerPoint (.ppt) requires isolated LibreOffice conversion to PDF/slides.',
      };
    }
    return {
      extension: ext || 'doc',
      detectedMimeType: 'application/msword',
      category: 'word',
      magicSignatureHex: hex,
      hasMacrosWarning: true,
      isSensitiveEnv: false,
      conversionRequired: true,
      conversionFidelityNote: 'Legacy binary Word (.doc) requires isolated LibreOffice conversion for full layout fidelity.',
    };
  }

  // 9. Check GZIP (1F 8B)
  if (headerBytes.length >= 2 && headerBytes[0] === 0x1f && headerBytes[1] === 0x8b) {
    return {
      extension: ext || 'gz',
      detectedMimeType: 'application/gzip',
      category: 'archive',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: false,
    };
  }

  // 10. Check 7z (37 7A BC AF 27 1C)
  if (
    headerBytes.length >= 6 &&
    headerBytes[0] === 0x37 &&
    headerBytes[1] === 0x7a &&
    headerBytes[2] === 0xbc &&
    headerBytes[3] === 0xaf
  ) {
    return {
      extension: '7z',
      detectedMimeType: 'application/x-7z-compressed',
      category: 'archive',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: false,
    };
  }

  // 11. Check RAR (52 61 72 21 1A 07)
  if (
    headerBytes.length >= 6 &&
    headerBytes[0] === 0x52 &&
    headerBytes[1] === 0x61 &&
    headerBytes[2] === 0x72 &&
    headerBytes[3] === 0x21
  ) {
    return {
      extension: 'rar',
      detectedMimeType: 'application/vnd.rar',
      category: 'archive',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: false,
    };
  }

  // 12. Check Audio/Video magic bytes (ID3, OggS, fLaC, ftyp, EBML/WebM/MKV)
  if (asciiHeader.startsWith('ID3') || (headerBytes.length >= 2 && headerBytes[0] === 0xff && (headerBytes[1] & 0xe0) === 0xe0 && ext === 'mp3')) {
    return {
      extension: 'mp3',
      detectedMimeType: 'audio/mpeg',
      category: 'audio',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: false,
    };
  }
  if (asciiHeader.startsWith('OggS')) {
    return {
      extension: ext || 'ogg',
      detectedMimeType: 'audio/ogg',
      category: 'audio',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: false,
    };
  }
  if (asciiHeader.startsWith('fLaC')) {
    return {
      extension: 'flac',
      detectedMimeType: 'audio/flac',
      category: 'audio',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: false,
    };
  }
  if (headerBytes.length >= 8 && asciiHeader.slice(4, 8) === 'ftyp') {
    const isAudio = ext === 'm4a' || declaredMime.startsWith('audio/');
    return {
      extension: ext || (isAudio ? 'm4a' : 'mp4'),
      detectedMimeType: isAudio ? 'audio/mp4' : 'video/mp4',
      category: isAudio ? 'audio' : 'video',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: false,
    };
  }
  if (
    headerBytes.length >= 4 &&
    headerBytes[0] === 0x1a &&
    headerBytes[1] === 0x45 &&
    headerBytes[2] === 0xdf &&
    headerBytes[3] === 0xa3
  ) {
    return {
      extension: ext || 'webm',
      detectedMimeType: ext === 'mkv' ? 'video/x-matroska' : 'video/webm',
      category: 'video',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: false,
    };
  }

  // 13. Extension + Content heuristic fallback
  if (ext === 'svg' || asciiHeader.trimStart().startsWith('<svg')) {
    return {
      extension: 'svg',
      detectedMimeType: 'image/svg+xml',
      category: 'image',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: false,
      conversionFidelityNote: 'SVG rendered through script-sanitized pipeline.',
    };
  }

  if (ext === 'csv' || ext === 'tsv') {
    return {
      extension: ext,
      detectedMimeType: ext === 'tsv' ? 'text/tab-separated-values' : 'text/csv',
      category: 'spreadsheet',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: false,
    };
  }

  if (ext === 'rtf' || asciiHeader.startsWith('{\\rtf')) {
    return {
      extension: 'rtf',
      detectedMimeType: 'application/rtf',
      category: 'word',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: false,
    };
  }

  if (ext === 'html' || ext === 'htm') {
    return {
      extension: ext,
      detectedMimeType: 'text/html',
      category: 'word',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: false,
      conversionFidelityNote: 'HTML rendered in script-isolated sandboxed mode; switch to Code view to inspect raw markup.',
    };
  }

  if (ext === 'md' || ext === 'markdown') {
    return {
      extension: ext,
      detectedMimeType: 'text/markdown',
      category: 'word',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: false,
    };
  }

  if (CODE_EXTENSIONS.has(ext)) {
    return {
      extension: ext,
      detectedMimeType: ext === 'json' ? 'application/json' : 'text/plain',
      category: 'code',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: ext === 'env',
      conversionRequired: false,
    };
  }

  if (TEXT_EXTENSIONS.has(ext)) {
    return {
      extension: ext,
      detectedMimeType: 'text/plain',
      category: 'text',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: false,
    };
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    return {
      extension: ext,
      detectedMimeType: declaredMime || `image/${ext}`,
      category: 'image',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: false,
    };
  }

  if (AUDIO_EXTENSIONS.has(ext)) {
    return {
      extension: ext,
      detectedMimeType: declaredMime || `audio/${ext}`,
      category: 'audio',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: false,
    };
  }

  if (VIDEO_EXTENSIONS.has(ext)) {
    return {
      extension: ext,
      detectedMimeType: declaredMime || `video/${ext}`,
      category: 'video',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: false,
    };
  }

  if (EBOOK_EXTENSIONS.has(ext)) {
    return {
      extension: ext,
      detectedMimeType: ext === 'fb2' ? 'application/x-fictionbook+xml' : 'application/x-mobipocket-ebook',
      category: 'ebook',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: ext === 'mobi',
    };
  }

  if (ARCHIVE_EXTENSIONS.has(ext)) {
    return {
      extension: ext,
      detectedMimeType: declaredMime || 'application/octet-stream',
      category: 'archive',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: false,
    };
  }

  if (WORD_EXTENSIONS.has(ext)) {
    return {
      extension: ext,
      detectedMimeType: declaredMime || 'application/octet-stream',
      category: 'word',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: true,
    };
  }

  if (PRESENTATION_EXTENSIONS.has(ext)) {
    return {
      extension: ext,
      detectedMimeType: declaredMime || 'application/octet-stream',
      category: 'presentation',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: true,
    };
  }

  if (SPREADSHEET_EXTENSIONS.has(ext)) {
    return {
      extension: ext,
      detectedMimeType: declaredMime || 'application/octet-stream',
      category: 'spreadsheet',
      magicSignatureHex: hex,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      conversionRequired: true,
    };
  }

  return {
    extension: ext || 'bin',
    detectedMimeType: declaredMime || 'application/octet-stream',
    category: 'unknown',
    magicSignatureHex: hex,
    hasMacrosWarning: false,
    isSensitiveEnv: false,
    conversionRequired: false,
  };
}

export async function computeSha256Hex(buffer: ArrayBuffer | Uint8Array): Promise<string> {
  const uint8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', uint8 as unknown as BufferSource);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  // Fallback FNV-1a 64-bit deterministic hash if subtle crypto unavailable
  let h1 = 0xdeadbeef ^ uint8.length;
  let h2 = 0x41c6ce57 ^ uint8.length;
  for (let i = 0; i < uint8.length; i++) {
    const ch = uint8[i];
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

export function sanitizeSvgContent(rawSvg: string): string {
  if (!OMNIVIEW_CONFIG.security.sanitizeSvgScripts) return rawSvg;
  return rawSvg
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<script[^>]*\/>/gi, '')
    .replace(/<foreignObject[\s\S]*?>[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(['"])[\s\S]*?\1/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/(href|xlink:href)\s*=\s*(['"])\s*javascript:[\s\S]*?\2/gi, '$1=""');
}

export function sanitizeHtmlContent(rawHtml: string): string {
  if (!OMNIVIEW_CONFIG.security.sanitizeHtmlScripts) return rawHtml;
  return rawHtml
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<script[^>]*\/>/gi, '')
    .replace(/<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?>[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(['"])[\s\S]*?\1/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/(href|src|action)\s*=\s*(['"])\s*javascript:[\s\S]*?\2/gi, '$1="#"');
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(i === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}`;
}

export function detectTextEncoding(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return 'UTF-8 (BOM)';
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return 'UTF-16 LE';
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return 'UTF-16 BE';
  }
  // Check for null bytes indicating binary or UTF-16 without BOM
  let nullCount = 0;
  const sampleLen = Math.min(bytes.length, 4096);
  for (let i = 0; i < sampleLen; i++) {
    if (bytes[i] === 0) nullCount++;
  }
  if (nullCount > sampleLen * 0.1) {
    return 'BINARY';
  }
  return 'UTF-8';
}

export function getMonacoLanguageForExtension(ext: string): string {
  const map: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    php: 'php',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    go: 'go',
    rs: 'rust',
    sql: 'sql',
    json: 'json',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'ini',
    env: 'ini',
    css: 'css',
    scss: 'scss',
    html: 'html',
    htm: 'html',
    md: 'markdown',
    markdown: 'markdown',
    sh: 'shell',
    bash: 'shell',
    ps1: 'powershell',
    log: 'plaintext',
    txt: 'plaintext',
  };
  return map[ext.toLowerCase()] ?? 'plaintext';
}
