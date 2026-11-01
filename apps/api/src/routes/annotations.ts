import type { FastifyInstance } from 'fastify';
import type {
  AnnotationType,
  ApiErrorResponse,
  DocumentAnnotation,
  NormalizedPoint,
  NormalizedRect,
} from '@omniview/shared-types';
import type { OmniViewMemoryStore } from '../store.js';

interface CreateAnnotationBody {
  fileChecksum?: string;
  pageNumber?: number;
  type?: AnnotationType;
  color?: string;
  rect?: NormalizedRect;
  points?: NormalizedPoint[];
  selectedText?: string;
  comment?: string;
  author?: string;
}

interface UpdateAnnotationBody {
  fileChecksum?: string;
  color?: string;
  rect?: NormalizedRect;
  points?: NormalizedPoint[];
  selectedText?: string;
  comment?: string;
}

export async function registerAnnotationRoutes(
  app: FastifyInstance,
  store: OmniViewMemoryStore
): Promise<void> {
  // GET /api/v1/files/:id/annotations
  app.get<{
    Params: { id: string };
    Querystring: { fileChecksum?: string; pageNumber?: string };
  }>('/api/v1/files/:id/annotations', async (request, reply) => {
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

    const targetChecksum = request.query.fileChecksum ?? file.checksum;
    const pageFilter = request.query.pageNumber
      ? Number.parseInt(request.query.pageNumber, 10)
      : undefined;

    const annotations = Array.from(store.annotations.values()).filter((ann) => {
      if (ann.fileId !== id) return false;
      if (ann.fileChecksum !== targetChecksum) return false;
      if (pageFilter !== undefined && !Number.isNaN(pageFilter) && ann.pageNumber !== pageFilter) {
        return false;
      }
      return true;
    });

    return {
      fileId: id,
      fileChecksum: targetChecksum,
      annotations,
    };
  });

  // POST /api/v1/files/:id/annotations
  app.post<{
    Params: { id: string };
    Body: CreateAnnotationBody;
  }>('/api/v1/files/:id/annotations', async (request, reply) => {
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

    const body = request.body ?? {};
    if (!body.fileChecksum || typeof body.fileChecksum !== 'string') {
      const err: ApiErrorResponse = {
        error: {
          code: 'MISSING_FILE_CHECKSUM',
          message:
            'fileChecksum is required when saving an annotation to guarantee document version integrity.',
        },
      };
      return reply.status(400).send(err);
    }

    if (body.fileChecksum !== file.checksum) {
      const err: ApiErrorResponse = {
        error: {
          code: 'CHECKSUM_MISMATCH',
          message: `Annotation fileChecksum "${body.fileChecksum}" does not match current file checksum "${file.checksum}". Refusing to attach annotation to a mismatched document version.`,
          details: {
            expectedChecksum: file.checksum,
            receivedChecksum: body.fileChecksum,
          },
        },
      };
      return reply.status(409).send(err);
    }

    const now = new Date().toISOString();
    const annotation: DocumentAnnotation = {
      id: store.nextId('ann'),
      fileId: id,
      fileChecksum: file.checksum,
      pageNumber: Math.max(1, body.pageNumber ?? 1),
      type: body.type ?? 'highlight',
      color: body.color ?? '#f59e0b',
      rect: body.rect,
      points: body.points,
      selectedText: body.selectedText,
      comment: body.comment,
      author: body.author ?? store.currentUser.displayName,
      createdAt: now,
      updatedAt: now,
    };

    store.annotations.set(annotation.id, annotation);
    store.recordAudit('annotation.created', 'annotation', annotation.id, {
      fileId: id,
      fileChecksum: file.checksum,
      pageNumber: annotation.pageNumber,
      type: annotation.type,
    });

    return reply.status(201).send({ annotation });
  });

  // PATCH /api/v1/annotations/:id
  app.patch<{
    Params: { id: string };
    Body: UpdateAnnotationBody;
  }>('/api/v1/annotations/:id', async (request, reply) => {
    const { id } = request.params;
    const existing = store.annotations.get(id);
    if (!existing) {
      return reply.status(404).send({
        error: {
          code: 'ANNOTATION_NOT_FOUND',
          message: `Annotation "${id}" does not exist.`,
        },
      });
    }

    const body = request.body ?? {};
    if (body.fileChecksum && body.fileChecksum !== existing.fileChecksum) {
      return reply.status(409).send({
        error: {
          code: 'CHECKSUM_MISMATCH',
          message: `Annotation update checksum "${body.fileChecksum}" does not match "${existing.fileChecksum}".`,
        },
      });
    }

    if (body.color !== undefined) existing.color = body.color;
    if (body.rect !== undefined) existing.rect = body.rect;
    if (body.points !== undefined) existing.points = body.points;
    if (body.selectedText !== undefined) existing.selectedText = body.selectedText;
    if (body.comment !== undefined) existing.comment = body.comment;
    existing.updatedAt = new Date().toISOString();

    store.annotations.set(id, existing);
    store.recordAudit('annotation.updated', 'annotation', id);

    return { annotation: existing };
  });

  // DELETE /api/v1/annotations/:id
  app.delete<{ Params: { id: string } }>('/api/v1/annotations/:id', async (request, reply) => {
    const { id } = request.params;
    const existing = store.annotations.get(id);
    if (!existing) {
      return reply.status(404).send({
        error: {
          code: 'ANNOTATION_NOT_FOUND',
          message: `Annotation "${id}" does not exist.`,
        },
      });
    }

    store.annotations.delete(id);
    store.recordAudit('annotation.deleted', 'annotation', id);

    return {
      deleted: true,
      id,
    };
  });
}
