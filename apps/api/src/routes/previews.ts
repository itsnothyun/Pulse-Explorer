import type { FastifyInstance } from 'fastify';
import type { ApiErrorResponse, ConversionJob } from '@omniview/shared-types';
import type { OmniViewMemoryStore } from '../store.js';

interface CreatePreviewJobBody {
  fileId?: string;
  targetFormat?: ConversionJob['targetFormat'];
  converterName?: ConversionJob['converterName'];
}

export async function registerPreviewRoutes(
  app: FastifyInstance,
  store: OmniViewMemoryStore
): Promise<void> {
  // POST /api/v1/previews
  app.post<{ Body: CreatePreviewJobBody }>('/api/v1/previews', async (request, reply) => {
    const body = request.body ?? {};
    if (!body.fileId) {
      const err: ApiErrorResponse = {
        error: {
          code: 'MISSING_FILE_ID',
          message: 'fileId is required to create a preview conversion job.',
        },
      };
      return reply.status(400).send(err);
    }

    const file = store.files.get(body.fileId);
    if (!file) {
      const err: ApiErrorResponse = {
        error: {
          code: 'FILE_NOT_FOUND',
          message: `File "${body.fileId}" does not exist.`,
        },
      };
      return reply.status(404).send(err);
    }

    const targetFormat: ConversionJob['targetFormat'] = body.targetFormat ?? 'pdf';
    const converterName: ConversionJob['converterName'] =
      body.converterName ??
      (file.category === 'video' || file.category === 'audio'
        ? 'ffmpeg'
        : file.category === 'ebook'
          ? 'epub-converter'
          : 'libreoffice-headless');

    const cacheKey = `${file.checksum}:${converterName}:1.0.0:${targetFormat}`;
    const existingArtifact = Array.from(store.previewArtifacts.values()).find(
      (a) => a.cacheKey === cacheKey
    );

    const now = new Date().toISOString();
    const jobId = store.nextId('job');
    const job: ConversionJob = {
      id: jobId,
      fileId: file.id,
      fileChecksum: file.checksum,
      sourceFormat: file.extension,
      targetFormat,
      converterName,
      status: 'completed',
      progress: 100,
      fidelityWarning:
        file.conversionFidelityNote ??
        'Converted in isolated worker with macro execution disabled.',
      startedAt: now,
      completedAt: now,
    };

    store.conversionJobs.set(jobId, job);

    if (!existingArtifact) {
      const synthesizedPdf = Buffer.from(
        `%PDF-1.4\n% OmniView Converted Preview for ${file.sanitizedName} (${file.checksum})\n%%EOF\n`,
        'utf-8'
      );
      store.previewArtifacts.set(cacheKey, {
        id: store.nextId('artifact'),
        fileId: file.id,
        fileChecksum: file.checksum,
        converterName,
        converterVersion: '1.0.0',
        cacheKey,
        artifactFormat: targetFormat,
        mimeType: targetFormat === 'pdf' ? 'application/pdf' : 'text/html',
        sizeBytes: synthesizedPdf.byteLength,
        content: synthesizedPdf,
        pageCount: 1,
        fidelityWarning: job.fidelityWarning,
        createdAt: now,
      });
    }

    file.status = 'ready';
    store.files.set(file.id, file);

    store.recordAudit('preview.job_created', 'conversion_job', jobId, {
      fileId: file.id,
      converterName,
      targetFormat,
      cached: Boolean(existingArtifact),
    });

    return reply.status(existingArtifact ? 200 : 202).send({
      job,
      cached: Boolean(existingArtifact),
      cacheKey,
    });
  });

  // GET /api/v1/previews/:jobId
  app.get<{ Params: { jobId: string } }>('/api/v1/previews/:jobId', async (request, reply) => {
    const job = store.conversionJobs.get(request.params.jobId);
    if (!job) {
      return reply.status(404).send({
        error: {
          code: 'JOB_NOT_FOUND',
          message: `Conversion job "${request.params.jobId}" does not exist.`,
        },
      });
    }
    return { job };
  });

  // DELETE /api/v1/previews/:jobId
  app.delete<{ Params: { jobId: string } }>(
    '/api/v1/previews/:jobId',
    async (request, reply) => {
      const job = store.conversionJobs.get(request.params.jobId);
      if (!job) {
        return reply.status(404).send({
          error: {
            code: 'JOB_NOT_FOUND',
            message: `Conversion job "${request.params.jobId}" does not exist.`,
          },
        });
      }

      job.status = 'cancelled';
      job.completedAt = new Date().toISOString();
      store.conversionJobs.set(job.id, job);

      store.recordAudit('preview.job_cancelled', 'conversion_job', job.id);
      return {
        cancelled: true,
        job,
      };
    }
  );
}
