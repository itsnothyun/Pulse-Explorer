import type { FastifyInstance } from 'fastify';
import { OMNIVIEW_CONFIG } from '@omniview/config';
import type {
  ApiErrorResponse,
  DetectedFile,
  FileCategory,
  ImportSource,
  SearchMatch,
} from '@omniview/shared-types';
import { detectTextEncoding, formatFileSize } from '@omniview/utilities';
import type { OmniViewMemoryStore } from '../store.js';
import { validateSafeRemoteUrl } from '../ssrf.js';

interface CreateFileBody {
  filename?: string;
  mimeType?: string;
  content?: string;
  contentBase64?: string;
  importSource?: ImportSource;
  folderId?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
}

interface ImportUrlBody {
  url?: string;
  filename?: string;
  folderId?: string | null;
  mockContent?: string;
  mockContentBase64?: string;
  mimeType?: string;
}

function parseByteRange(
  rangeHeader: string,
  totalLength: number
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) {
    return null;
  }

  const rangeSpec = rangeHeader.slice('bytes='.length).split(',')[0]?.trim() ?? '';
  const dashIndex = rangeSpec.indexOf('-');
  if (dashIndex === -1) {
    return null;
  }

  const startStr = rangeSpec.slice(0, dashIndex).trim();
  const endStr = rangeSpec.slice(dashIndex + 1).trim();

  if (totalLength === 0) {
    return 'unsatisfiable';
  }

  let start: number;
  let end: number;

  if (startStr === '') {
    // Suffix byte-range-spec: bytes=-500 (last 500 bytes)
    const suffixLength = Number.parseInt(endStr, 10);
    if (Number.isNaN(suffixLength) || suffixLength <= 0) {
      return 'unsatisfiable';
    }
    start = Math.max(0, totalLength - suffixLength);
    end = totalLength - 1;
  } else {
    start = Number.parseInt(startStr, 10);
    end = endStr === '' ? totalLength - 1 : Number.parseInt(endStr, 10);
    if (Number.isNaN(start) || Number.isNaN(end)) {
      return 'unsatisfiable';
    }
    if (start < 0 || start >= totalLength || start > end) {
      return 'unsatisfiable';
    }
    end = Math.min(end, totalLength - 1);
  }

  return { start, end };
}

export async function registerFileRoutes(
  app: FastifyInstance,
  store: OmniViewMemoryStore
): Promise<void> {
  // POST /api/v1/files
  app.post<{ Body: CreateFileBody }>('/api/v1/files', async (request, reply) => {
    const body = request.body ?? {};
    const filename = body.filename?.trim();
    if (!filename) {
      const err: ApiErrorResponse = {
        error: {
          code: 'INVALID_FILENAME',
          message: 'A non-empty filename is required to register a file.',
        },
      };
      return reply.status(400).send(err);
    }

    let buffer: Buffer;
    if (typeof body.contentBase64 === 'string') {
      buffer = Buffer.from(body.contentBase64, 'base64');
    } else if (typeof body.content === 'string') {
      buffer = Buffer.from(body.content, 'utf-8');
    } else {
      buffer = Buffer.alloc(0);
    }

    if (buffer.byteLength > OMNIVIEW_CONFIG.limits.maxFileSizeBytes) {
      const err: ApiErrorResponse = {
        error: {
          code: 'FILE_TOO_LARGE',
          message: `File size (${formatFileSize(buffer.byteLength)}) exceeds maximum limit (${formatFileSize(OMNIVIEW_CONFIG.limits.maxFileSizeBytes)}).`,
        },
      };
      return reply.status(413).send(err);
    }

    const detected = await store.registerFile({
      filename,
      declaredMimeType: body.mimeType,
      content: buffer,
      importSource: body.importSource ?? 'local-picker',
      folderId: body.folderId ?? null,
      metadata: body.metadata,
    });

    return reply.status(201).send({ file: detected });
  });

  // GET /api/v1/files
  app.get<{
    Querystring: {
      folderId?: string;
      category?: FileCategory;
      favorite?: string;
      trashed?: string;
      q?: string;
    };
  }>('/api/v1/files', async (request) => {
    const { folderId, category, favorite, trashed, q } = request.query;
    const includeTrashed = trashed === 'true';

    let list = Array.from(store.files.values()).filter((f) =>
      includeTrashed ? Boolean(f.isTrashed) : !f.isTrashed
    );

    if (folderId) {
      list = list.filter((f) => f.folderId === folderId);
    }
    if (category) {
      list = list.filter((f) => f.category === category);
    }
    if (favorite === 'true') {
      list = list.filter((f) => Boolean(f.isFavorite));
    }
    if (q && q.trim()) {
      const needle = q.trim().toLowerCase();
      list = list.filter(
        (f) =>
          f.originalName.toLowerCase().includes(needle) ||
          f.extension.toLowerCase().includes(needle) ||
          f.category.toLowerCase().includes(needle)
      );
    }

    list.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
    return {
      files: list,
      total: list.length,
    };
  });

  // GET /api/v1/files/:id
  app.get<{ Params: { id: string } }>('/api/v1/files/:id', async (request, reply) => {
    const file = store.files.get(request.params.id);
    if (!file) {
      const err: ApiErrorResponse = {
        error: {
          code: 'FILE_NOT_FOUND',
          message: `File "${request.params.id}" does not exist.`,
        },
      };
      return reply.status(404).send(err);
    }
    return { file };
  });

  // DELETE /api/v1/files/:id
  app.delete<{
    Params: { id: string };
    Querystring: { permanent?: string };
  }>('/api/v1/files/:id', async (request, reply) => {
    const { id } = request.params;
    const file = store.files.get(id);
    if (!file) {
      const err: ApiErrorResponse = {
        error: {
          code: 'FILE_NOT_FOUND',
          message: `File "${id}" does not exist.`,
        },
      };
      return reply.status(404).send(err);
    }

    if (request.query.permanent === 'true') {
      store.files.delete(id);
      store.fileContents.delete(id);
      store.fileVersions.delete(id);
    } else {
      file.isTrashed = true;
      file.lastModified = new Date().toISOString();
      store.files.set(id, file);
    }

    store.recordAudit('file.deleted', 'file', id, {
      permanent: request.query.permanent === 'true',
    });

    return {
      deleted: true,
      id,
      permanent: request.query.permanent === 'true',
    };
  });

  // GET /api/v1/files/:id/content (supports HTTP Range 206 Partial Content)
  app.get<{ Params: { id: string } }>('/api/v1/files/:id/content', async (request, reply) => {
    const { id } = request.params;
    const file = store.files.get(id);
    const content = store.fileContents.get(id);
    if (!file || !content) {
      const err: ApiErrorResponse = {
        error: {
          code: 'FILE_NOT_FOUND',
          message: `Content for file "${id}" is not available.`,
        },
      };
      return reply.status(404).send(err);
    }

    const totalLength = content.byteLength;
    reply.header('Accept-Ranges', 'bytes');
    reply.header('ETag', `"${file.checksum}"`);
    reply.header('Cache-Control', 'private, max-age=3600');
    reply.header(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(file.sanitizedName)}"`
    );

    const rangeHeader = request.headers.range;
    if (typeof rangeHeader === 'string' && rangeHeader.trim().length > 0) {
      const parsedRange = parseByteRange(rangeHeader.trim(), totalLength);
      if (parsedRange === 'unsatisfiable') {
        reply.header('Content-Range', `bytes */${totalLength}`);
        return reply.status(416).send({
          error: {
            code: 'RANGE_NOT_SATISFIABLE',
            message: `Requested byte range "${rangeHeader}" is outside file size (${totalLength} bytes).`,
          },
        });
      }

      if (parsedRange) {
        const { start, end } = parsedRange;
        const chunk = content.subarray(start, end + 1);
        reply.header('Content-Range', `bytes ${start}-${end}/${totalLength}`);
        reply.header('Content-Length', String(chunk.byteLength));
        reply.header('Content-Type', file.detectedMimeType);
        return reply.status(206).send(chunk);
      }
    }

    reply.header('Content-Length', String(totalLength));
    reply.header('Content-Type', file.detectedMimeType);
    return reply.status(200).send(content);
  });

  // GET /api/v1/files/:id/preview
  app.get<{ Params: { id: string } }>('/api/v1/files/:id/preview', async (request, reply) => {
    const { id } = request.params;
    const file = store.files.get(id);
    if (!file) {
      return reply.status(404).send({
        error: {
          code: 'FILE_NOT_FOUND',
          message: `File "${id}" does not exist.`,
        },
      });
    }

    const artifact = Array.from(store.previewArtifacts.values()).find(
      (a) => a.fileId === id && a.fileChecksum === file.checksum
    );

    return {
      fileId: file.id,
      fileChecksum: file.checksum,
      status: artifact ? 'ready' : file.status,
      category: file.category,
      detectedMimeType: file.detectedMimeType,
      conversionRequired: file.status === 'conversion-required',
      fidelityNote: file.conversionFidelityNote ?? null,
      previewArtifact: artifact
        ? {
            id: artifact.id,
            cacheKey: artifact.cacheKey,
            converterName: artifact.converterName,
            converterVersion: artifact.converterVersion,
            artifactFormat: artifact.artifactFormat,
            mimeType: artifact.mimeType,
            sizeBytes: artifact.sizeBytes,
            pageCount: artifact.pageCount ?? 1,
            createdAt: artifact.createdAt,
          }
        : null,
    };
  });

  // GET /api/v1/files/:id/metadata
  app.get<{ Params: { id: string } }>('/api/v1/files/:id/metadata', async (request, reply) => {
    const { id } = request.params;
    const file = store.files.get(id);
    const content = store.fileContents.get(id);
    if (!file || !content) {
      return reply.status(404).send({
        error: {
          code: 'FILE_NOT_FOUND',
          message: `File "${id}" does not exist.`,
        },
      });
    }

    const versions = store.fileVersions.get(id) ?? [];
    const encoding = detectTextEncoding(new Uint8Array(content.subarray(0, 4096)));

    return {
      fileId: file.id,
      originalName: file.originalName,
      sanitizedName: file.sanitizedName,
      extension: file.extension,
      declaredMimeType: file.declaredMimeType,
      detectedMimeType: file.detectedMimeType,
      magicSignatureHex: file.magicSignatureHex ?? '',
      category: file.category,
      sizeBytes: file.sizeBytes,
      formattedSize: formatFileSize(file.sizeBytes),
      checksum: file.checksum,
      encoding,
      hasMacrosWarning: Boolean(file.hasMacrosWarning),
      isSensitiveEnv: Boolean(file.isSensitiveEnv),
      isEncrypted: Boolean(file.isEncrypted),
      conversionFidelityNote: file.conversionFidelityNote ?? null,
      versionCount: versions.length,
      versions,
      createdAt: file.createdAt,
      lastModified: file.lastModified,
      metadata: file.metadata ?? {},
    };
  });

  // GET /api/v1/files/:id/thumbnail
  app.get<{ Params: { id: string } }>('/api/v1/files/:id/thumbnail', async (request, reply) => {
    const { id } = request.params;
    const file = store.files.get(id);
    if (!file) {
      return reply.status(404).send({
        error: {
          code: 'FILE_NOT_FOUND',
          message: `File "${id}" does not exist.`,
        },
      });
    }

    const badge = file.extension.toUpperCase().slice(0, 6) || 'FILE';
    const label = file.sanitizedName.replace(/[<>&"']/g, '').slice(0, 28);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="320" viewBox="0 0 240 320">
      <rect width="240" height="320" rx="14" fill="#111827" stroke="#374151" stroke-width="2"/>
      <rect x="24" y="28" width="76" height="28" rx="6" fill="#4f46e5"/>
      <text x="62" y="47" text-anchor="middle" fill="#ffffff" font-family="sans-serif" font-size="13" font-weight="bold">${badge}</text>
      <line x1="24" y1="88" x2="216" y2="88" stroke="#1f2937" stroke-width="8" stroke-linecap="round"/>
      <line x1="24" y1="114" x2="184" y2="114" stroke="#1f2937" stroke-width="8" stroke-linecap="round"/>
      <line x1="24" y1="140" x2="200" y2="140" stroke="#1f2937" stroke-width="8" stroke-linecap="round"/>
      <text x="24" y="284" fill="#9ca3af" font-family="sans-serif" font-size="12">${label}</text>
    </svg>`;

    reply.header('Content-Type', 'image/svg+xml');
    reply.header('Cache-Control', 'private, max-age=3600');
    return reply.status(200).send(svg);
  });

  // POST /api/v1/files/import-url (with strict SSRF protection)
  app.post<{ Body: ImportUrlBody }>('/api/v1/files/import-url', async (request, reply) => {
    const body = request.body ?? {};
    const rawUrl = body.url ?? '';
    const validation = validateSafeRemoteUrl(rawUrl);

    if (!validation.allowed || !validation.normalizedUrl) {
      const statusCode = validation.code === 'SSRF_BLOCKED' ? 403 : 400;
      store.recordAudit('file.import_url_blocked', 'url', undefined, {
        url: rawUrl,
        code: validation.code,
        reason: validation.reason,
      });
      const err: ApiErrorResponse = {
        error: {
          code: validation.code ?? 'SSRF_BLOCKED',
          message: validation.reason ?? 'Remote URL import rejected by security policy.',
        },
      };
      return reply.status(statusCode).send(err);
    }

    const parsedUrl = new URL(validation.normalizedUrl);
    const derivedName =
      body.filename?.trim() ||
      decodeURIComponent(parsedUrl.pathname.split('/').pop() || '') ||
      'remote-document.txt';

    let contentBuffer: Buffer;
    let declaredMime = body.mimeType ?? 'text/plain';

    if (typeof body.mockContentBase64 === 'string') {
      contentBuffer = Buffer.from(body.mockContentBase64, 'base64');
    } else if (typeof body.mockContent === 'string') {
      contentBuffer = Buffer.from(body.mockContent, 'utf-8');
    } else {
      // Deterministic safe payload for sandbox/offline testing or controlled fetch
      contentBuffer = Buffer.from(
        `Remote imported document from ${validation.normalizedUrl}`,
        'utf-8'
      );
    }

    const file = await store.registerFile({
      filename: derivedName,
      declaredMimeType: declaredMime,
      content: contentBuffer,
      importSource: 'url-import',
      folderId: body.folderId ?? null,
      metadata: {
        sourceUrl: validation.normalizedUrl,
      },
    });

    return reply.status(201).send({
      file,
      sourceUrl: validation.normalizedUrl,
    });
  });

  // GET /api/v1/search
  app.get<{
    Querystring: {
      q?: string;
      category?: FileCategory;
      folderId?: string;
    };
  }>('/api/v1/search', async (request) => {
    const rawQuery = request.query.q ?? '';
    const needle = rawQuery.trim().toLowerCase();
    const { category, folderId } = request.query;

    const matchedFiles: DetectedFile[] = [];
    const matches: SearchMatch[] = [];

    for (const file of store.files.values()) {
      if (file.isTrashed) continue;
      if (category && file.category !== category) continue;
      if (folderId && file.folderId !== folderId) continue;

      if (!needle) {
        matchedFiles.push(file);
        continue;
      }

      let fileMatched = false;
      if (
        file.originalName.toLowerCase().includes(needle) ||
        file.extension.toLowerCase().includes(needle)
      ) {
        fileMatched = true;
      }

      const rawBytes = store.fileContents.get(file.id);
      if (rawBytes && (file.category === 'text' || file.category === 'code' || file.category === 'word' || file.category === 'pdf')) {
        const text = rawBytes.toString('utf-8');
        const lines = text.split(/\r?\n/);
        lines.forEach((line, idx) => {
          if (line.toLowerCase().includes(needle)) {
            fileMatched = true;
            matches.push({
              id: `match-${file.id}-${idx + 1}`,
              fileId: file.id,
              locationLabel: `Line ${idx + 1}`,
              pageOrIndex: idx + 1,
              snippet: line.trim().slice(0, 180),
              matchIndexInUnit: 0,
            });
          }
        });
      }

      if (fileMatched) {
        matchedFiles.push(file);
      }
    }

    return {
      query: rawQuery,
      files: matchedFiles,
      matches,
    };
  });
}
