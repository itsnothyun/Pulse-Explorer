import type { DetectedFile } from '@omniview/shared-types';
import { ConvertError, convert, formatBytes, outputName, uniqueName, type ResolvedTarget } from '../converters/registry';
import { useConvertStore } from '../stores/useConvertStore';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';

let counter = 0;

/**
 * Converts a library file on-device and saves the result next to it: same
 * collection, original untouched. Progress and the outcome show up as a job.
 */
export async function runConversion(file: DetectedFile, target: ResolvedTarget): Promise<void> {
  const { upsertJob, level } = useConvertStore.getState();
  const jobId = `convert-${Date.now()}-${counter++}`;
  const buffer = useWorkspaceStore.getState().fileBuffers[file.id];
  upsertJob({
    id: jobId,
    fileName: file.originalName,
    targetLabel: target.compress ? 'Compress' : target.label,
    status: 'running',
    progress: 0,
    before: file.sizeBytes,
  });

  try {
    if (!buffer) throw new ConvertError('The file is not loaded yet. Open it once and try again.');
    // Let the "running" state paint before heavy work blocks the main thread.
    await new Promise((r) => setTimeout(r, 30));
    const out = await convert(target, {
      bytes: new Uint8Array(buffer),
      info: { extension: file.extension, category: file.category },
      name: file.originalName,
      level,
      onProgress: (p) => upsertJob({ id: jobId, progress: p }),
    });

    const store = useWorkspaceStore.getState();
    const siblings = store.files.filter((f) => !f.isTrashed && f.folderId === file.folderId).map((f) => f.originalName);
    const name = uniqueName(outputName(file.originalName, out.ext, Boolean(target.compress)), siblings);
    const [created] = await store.importFiles(
      [{ name, bytes: out.bytes, declaredMime: out.mime, folderId: file.folderId ?? undefined }],
      'conversion',
      false
    );
    const saved = created ? (target.compress ? ` Saved ${formatBytes(file.sizeBytes - out.bytes.length)}.` : '') : '';
    upsertJob({
      id: jobId,
      status: 'done',
      progress: 1,
      after: out.bytes.length,
      resultFileId: created?.id,
      fileName: name,
      message: [out.note, saved.trim()].filter(Boolean).join(' ') || undefined,
    });
  } catch (e) {
    const message = e instanceof ConvertError ? e.message : 'Something went wrong while converting this file.';
    if (!(e instanceof ConvertError)) console.error('[convert]', e);
    upsertJob({ id: jobId, status: 'error', message });
  }
}
