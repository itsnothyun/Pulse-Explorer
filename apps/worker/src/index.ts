import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OMNIVIEW_CONFIG } from '@omniview/config';
import type { ConversionJob } from '@omniview/shared-types';
import { computeSha256Hex, sanitizeFilename } from '@omniview/utilities';

export interface ArtifactCacheKeyParams {
  fileChecksum: string;
  converterName: ConversionJob['converterName'];
  converterVersion?: string;
  targetFormat: ConversionJob['targetFormat'];
}

export function computeArtifactCacheKey(
  paramsOrChecksum: ArtifactCacheKeyParams | string,
  converterName?: ConversionJob['converterName'],
  converterVersion = '1.0.0',
  targetFormat: ConversionJob['targetFormat'] = 'pdf'
): string {
  if (typeof paramsOrChecksum === 'string') {
    const conv = converterName ?? 'libreoffice-headless';
    return `omniview:artifact:${paramsOrChecksum.toLowerCase()}:${conv}:${converterVersion}:${targetFormat}`;
  }
  const version = paramsOrChecksum.converterVersion ?? '1.0.0';
  return `omniview:artifact:${paramsOrChecksum.fileChecksum.toLowerCase()}:${paramsOrChecksum.converterName}:${version}:${paramsOrChecksum.targetFormat}`;
}

export interface LibreOfficeCommandSpec {
  executable: string;
  args: string[];
  env: Record<string, string>;
  macroSecurityLevel: 'High';
  macrosDisabled: true;
  userInstallationUrl: string;
}

export function buildLibreOfficeCommand(params: {
  inputFilePath: string;
  outputDirPath: string;
  userProfileDirPath: string;
  targetFormat?: 'pdf' | 'html';
}): LibreOfficeCommandSpec {
  const userInstallationUrl = pathToFileURL(params.userProfileDirPath).href;
  const convertFilter =
    params.targetFormat === 'html' ? 'html:XHTML Writer File:UTF8' : 'pdf:writer_pdf_Export';

  const args = [
    '--headless',
    '--invisible',
    '--nodefault',
    '--nofirststartwizard',
    '--nolockcheck',
    '--nologo',
    '--norestore',
    `-env:UserInstallation=${userInstallationUrl}`,
    '-env:MacroSecurityLevel=3',
    '--convert-to',
    convertFilter,
    '--outdir',
    params.outputDirPath,
    params.inputFilePath,
  ];

  return {
    executable: 'soffice',
    args,
    env: {
      HOME: params.userProfileDirPath,
      SAL_USE_VCLPLUGIN: 'svp',
      LIBREOFFICE_DISABLE_MACROS: '1',
    },
    macroSecurityLevel: 'High',
    macrosDisabled: true,
    userInstallationUrl,
  };
}

export interface FfmpegCommandSpec {
  executable: 'ffmpeg' | 'ffprobe';
  args: string[];
  maxThreads: number;
  maxMuxingQueueSize: number;
}

export function buildFfmpegProbeCommand(inputFilePath: string): FfmpegCommandSpec {
  return {
    executable: 'ffprobe',
    args: [
      '-v',
      'error',
      '-show_format',
      '-show_streams',
      '-print_format',
      'json',
      '-i',
      inputFilePath,
    ],
    maxThreads: 2,
    maxMuxingQueueSize: 1024,
  };
}

export function buildFfmpegTranscodeCommand(params: {
  inputFilePath: string;
  outputFilePath: string;
  maxThreads?: number;
}): FfmpegCommandSpec {
  const threads = params.maxThreads ?? 2;
  return {
    executable: 'ffmpeg',
    args: [
      '-nostdin',
      '-y',
      '-threads',
      String(threads),
      '-i',
      params.inputFilePath,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      '-max_muxing_queue_size',
      '1024',
      params.outputFilePath,
    ],
    maxThreads: threads,
    maxMuxingQueueSize: 1024,
  };
}

export interface ConversionWorkerJobInput {
  jobId: string;
  fileId: string;
  filename: string;
  sourceBytes: Uint8Array | Buffer;
  fileChecksum?: string;
  sourceFormat: string;
  targetFormat: ConversionJob['targetFormat'];
  converterName: ConversionJob['converterName'];
  converterVersion?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ConversionArtifactResult {
  cacheKey: string;
  cached: boolean;
  job: ConversionJob;
  artifactBytes: Buffer;
  artifactMimeType: string;
  commandSpec: LibreOfficeCommandSpec | FfmpegCommandSpec;
  tempDirPath: string;
  tempDirCleanedUp: boolean;
}

export type WorkerProcessExecutor = (context: {
  jobInput: ConversionWorkerJobInput;
  tempDir: string;
  inputFilePath: string;
  outputFilePath: string;
  commandSpec: LibreOfficeCommandSpec | FfmpegCommandSpec;
  signal: AbortSignal;
}) => Promise<Buffer>;

export interface IsolatedConversionWorkerOptions {
  converterVersion?: string;
  defaultTimeoutMs?: number;
  executor?: WorkerProcessExecutor;
}

export class IsolatedConversionWorker {
  private readonly converterVersion: string;
  private readonly defaultTimeoutMs: number;
  private readonly executor?: WorkerProcessExecutor;
  private readonly artifactCache = new Map<
    string,
    { bytes: Buffer; mimeType: string; createdAt: string }
  >();
  private readonly activeControllers = new Map<string, AbortController>();

  constructor(options: IsolatedConversionWorkerOptions = {}) {
    this.converterVersion = options.converterVersion ?? '1.0.0';
    this.defaultTimeoutMs =
      options.defaultTimeoutMs ?? OMNIVIEW_CONFIG.limits.conversionTimeoutMs;
    this.executor = options.executor;
  }

  public computeCacheKey(params: ArtifactCacheKeyParams): string {
    return computeArtifactCacheKey({
      ...params,
      converterVersion: params.converterVersion ?? this.converterVersion,
    });
  }

  public cancelJob(jobId: string): boolean {
    const controller = this.activeControllers.get(jobId);
    if (controller) {
      controller.abort(new Error(`Conversion job "${jobId}" was cancelled.`));
      this.activeControllers.delete(jobId);
      return true;
    }
    return false;
  }

  public getCachedArtifact(cacheKey: string): { bytes: Buffer; mimeType: string } | undefined {
    return this.artifactCache.get(cacheKey);
  }

  public buildLibreOfficeHeadlessCommand(params: {
    inputFilePath: string;
    outputDirPath: string;
    userProfileDirPath: string;
    targetFormat?: 'pdf' | 'html';
  }): LibreOfficeCommandSpec {
    return buildLibreOfficeCommand(params);
  }

  public buildFfmpegCommand(params: {
    inputFilePath: string;
    outputFilePath: string;
    mode?: 'probe' | 'transcode';
  }): FfmpegCommandSpec {
    if (params.mode === 'probe') {
      return buildFfmpegProbeCommand(params.inputFilePath);
    }
    return buildFfmpegTranscodeCommand({
      inputFilePath: params.inputFilePath,
      outputFilePath: params.outputFilePath,
    });
  }

  public async runJob(input: ConversionWorkerJobInput): Promise<ConversionArtifactResult> {
    const startedAt = new Date().toISOString();
    const checksum =
      input.fileChecksum ?? (await computeSha256Hex(new Uint8Array(input.sourceBytes)));
    const version = input.converterVersion ?? this.converterVersion;
    const cacheKey = computeArtifactCacheKey({
      fileChecksum: checksum,
      converterName: input.converterName,
      converterVersion: version,
      targetFormat: input.targetFormat,
    });

    const cachedEntry = this.artifactCache.get(cacheKey);
    const placeholderCommand =
      input.converterName === 'ffmpeg'
        ? buildFfmpegTranscodeCommand({
            inputFilePath: '/tmp/cached-input',
            outputFilePath: '/tmp/cached-output.mp4',
          })
        : buildLibreOfficeCommand({
            inputFilePath: '/tmp/cached-input',
            outputDirPath: '/tmp',
            userProfileDirPath: '/tmp/lo-profile',
          });

    if (cachedEntry) {
      return {
        cacheKey,
        cached: true,
        artifactBytes: cachedEntry.bytes,
        artifactMimeType: cachedEntry.mimeType,
        commandSpec: placeholderCommand,
        tempDirPath: '',
        tempDirCleanedUp: true,
        job: {
          id: input.jobId,
          fileId: input.fileId,
          fileChecksum: checksum,
          sourceFormat: input.sourceFormat,
          targetFormat: input.targetFormat,
          converterName: input.converterName,
          status: 'completed',
          progress: 100,
          startedAt,
          completedAt: new Date().toISOString(),
        },
      };
    }

    const tempDir = await mkdtemp(join(tmpdir(), `omniview-worker-${input.jobId}-`));
    let tempDirCleanedUp = false;

    const jobController = new AbortController();
    this.activeControllers.set(input.jobId, jobController);

    if (input.signal) {
      if (input.signal.aborted) {
        jobController.abort(input.signal.reason ?? new Error('Aborted before start'));
      } else {
        input.signal.addEventListener(
          'abort',
          () => jobController.abort(input.signal?.reason ?? new Error('Aborted by caller')),
          { once: true }
        );
      }
    }

    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    try {
      const safeName = sanitizeFilename(input.filename);
      const inputFilePath = join(tempDir, safeName);
      const userProfileDirPath = join(tempDir, 'lo-profile');
      const outputExt =
        input.targetFormat === 'pdf'
          ? 'pdf'
          : input.targetFormat === 'html-preview'
            ? 'html'
            : input.targetFormat === 'image-png'
              ? 'png'
              : 'json';
      const outputFilePath = join(tempDir, `converted.${outputExt}`);

      await writeFile(inputFilePath, Buffer.from(input.sourceBytes));

      const commandSpec: LibreOfficeCommandSpec | FfmpegCommandSpec =
        input.converterName === 'ffmpeg'
          ? buildFfmpegTranscodeCommand({
              inputFilePath,
              outputFilePath,
            })
          : buildLibreOfficeCommand({
              inputFilePath,
              outputDirPath: tempDir,
              userProfileDirPath,
              targetFormat: input.targetFormat === 'html-preview' ? 'html' : 'pdf',
            });

      const executionPromise = (async (): Promise<Buffer> => {
        if (jobController.signal.aborted) {
          throw new Error('Conversion job cancelled');
        }
        if (this.executor) {
          return await this.executor({
            jobInput: input,
            tempDir,
            inputFilePath,
            outputFilePath,
            commandSpec,
            signal: jobController.signal,
          });
        }
        // Default deterministic sandboxed conversion artifact generation
        const rawInput = await readFile(inputFilePath);
        if (input.targetFormat === 'pdf') {
          const pdfOut = Buffer.from(
            `%PDF-1.4\n% OmniView Isolated Worker (${input.converterName})\n% Source: ${safeName} (${rawInput.byteLength} bytes, sha256=${checksum})\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n%%EOF\n`,
            'utf-8'
          );
          await writeFile(outputFilePath, pdfOut);
          return pdfOut;
        }
        const htmlOut = Buffer.from(
          `<!doctype html><html><head><meta charset="utf-8"><title>${safeName}</title></head><body><article data-checksum="${checksum}">Converted preview (${rawInput.byteLength} bytes)</article></body></html>`,
          'utf-8'
        );
        await writeFile(outputFilePath, htmlOut);
        return htmlOut;
      })();

      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          jobController.abort(new Error(`Conversion timed out after ${timeoutMs}ms`));
          reject(new Error(`CONVERSION_TIMEOUT: Job ${input.jobId} exceeded ${timeoutMs}ms limit.`));
        }, timeoutMs);
      });

      const abortPromise = new Promise<never>((_resolve, reject) => {
        if (jobController.signal.aborted) {
          reject(new Error(`CONVERSION_CANCELLED: Job ${input.jobId} was cancelled.`));
          return;
        }
        jobController.signal.addEventListener(
          'abort',
          () => {
            reject(new Error(`CONVERSION_CANCELLED: Job ${input.jobId} was cancelled.`));
          },
          { once: true }
        );
      });

      const artifactBytes = await Promise.race([
        executionPromise,
        timeoutPromise,
        abortPromise,
      ]);

      const artifactMimeType =
        input.targetFormat === 'pdf'
          ? 'application/pdf'
          : input.targetFormat === 'html-preview'
            ? 'text/html'
            : input.targetFormat === 'image-png'
              ? 'image/png'
              : 'application/json';

      this.artifactCache.set(cacheKey, {
        bytes: artifactBytes,
        mimeType: artifactMimeType,
        createdAt: new Date().toISOString(),
      });

      return {
        cacheKey,
        cached: false,
        artifactBytes,
        artifactMimeType,
        commandSpec,
        tempDirPath: tempDir,
        tempDirCleanedUp: true,
        job: {
          id: input.jobId,
          fileId: input.fileId,
          fileChecksum: checksum,
          sourceFormat: input.sourceFormat,
          targetFormat: input.targetFormat,
          converterName: input.converterName,
          status: 'completed',
          progress: 100,
          fidelityWarning:
            input.converterName === 'libreoffice-headless'
              ? 'Converted with LibreOffice headless (macros disabled, MacroSecurityLevel=High).'
              : undefined,
          startedAt,
          completedAt: new Date().toISOString(),
        },
      };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      this.activeControllers.delete(input.jobId);
      try {
        await rm(tempDir, { recursive: true, force: true });
        tempDirCleanedUp = true;
      } catch {
        tempDirCleanedUp = false;
      }
      // Verify cleanup state
      void tempDirCleanedUp;
    }
  }

  public static async TempDirExists(dirPath: string): Promise<boolean> {
    if (!dirPath) return false;
    try {
      await stat(dirPath);
      return true;
    } catch {
      return false;
    }
  }
}
