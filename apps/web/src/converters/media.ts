import { ConvertError, type ConvertInput, type ConvertOutput, type Converter, type Level } from './types';
import { VIDEO } from './targets';
import { LEVELS, mimeFor } from './util';

const MAX_INPUT = 1024 * 1024 * 1024;

type FFmpegInstance = import('@ffmpeg/ffmpeg').FFmpeg;
let ffmpegPromise: Promise<FFmpegInstance> | null = null;
let currentProgress: ((fraction: number) => void) | undefined;

/** Loads FFmpeg's WebAssembly build from this app's own files, so nothing is fetched from a CDN. */
function loadFfmpeg(): Promise<FFmpegInstance> {
  ffmpegPromise ??= (async () => {
    const [{ FFmpeg }, core, wasm] = await Promise.all([
      import('@ffmpeg/ffmpeg'),
      import('@ffmpeg/core?url'),
      import('@ffmpeg/core/wasm?url'),
    ]);
    const ff = new FFmpeg();
    ff.on('progress', ({ progress }) => currentProgress?.(Math.min(1, Math.max(0, progress))));
    await ff.load({ coreURL: core.default, wasmURL: wasm.default });
    return ff;
  })().catch((e) => {
    ffmpegPromise = null;
    throw new ConvertError(`Could not start the media engine: ${e instanceof Error ? e.message : String(e)}`);
  });
  return ffmpegPromise;
}

const kbps = (level: Level) => `${LEVELS[level].audioKbps}k`;

/** FFmpeg arguments (between `-i in` and the output name) for each output codec. */
function codecArgs(outExt: string, level: Level, hasVideo: boolean): string[] {
  const s = LEVELS[level];
  const scale = hasVideo && s.videoHeight > 0 ? ['-vf', `scale=-2:'min(${s.videoHeight},ih)'`] : [];
  switch (outExt) {
    case 'mp4':
      return [...scale, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(s.crf), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', kbps(level), '-movflags', '+faststart'];
    case 'webm': {
      const vb = { small: '500k', balanced: '1000k', best: '2500k' }[level];
      return [...scale, '-c:v', 'libvpx', '-crf', '10', '-b:v', vb, '-deadline', 'realtime', '-cpu-used', '5', '-c:a', 'libvorbis', '-b:a', kbps(level)];
    }
    case 'mp3':
      return ['-vn', '-c:a', 'libmp3lame', '-b:a', kbps(level)];
    case 'ogg':
      return ['-vn', '-c:a', 'libvorbis', '-b:a', kbps(level)];
    case 'm4a':
    case 'aac':
      return ['-vn', '-c:a', 'aac', '-b:a', kbps(level)];
    case 'flac':
      return ['-vn', '-c:a', 'flac', '-compression_level', '8'];
    case 'wav':
      return ['-vn', '-c:a', 'pcm_s16le'];
    default:
      throw new ConvertError(`Unsupported media target: ${outExt}`);
  }
}

export interface MediaJob {
  /** The source, mounted read-only (WORKERFS): FFmpeg reads only the parts it seeks to, outside the wasm heap. */
  input: Blob;
  inputExt: string;
  outputExt: string;
  /** FFmpeg arguments, given the input and output paths inside the engine. */
  args: (input: string, output: string) => string[];
  /** Every log line (the player reads `time=` from them for progress). */
  onLog?: (line: string) => void;
  /** Aborting stops the engine at once (its worker is terminated and restarted on the next job). */
  signal?: AbortSignal;
}

let jobSeq = 0;

/**
 * One FFmpeg run over a Blob for callers outside the converter registry (the player's frame and clip export).
 * Resolves with the output's bytes; rejects with a ConvertError on failure, or a DOMException `AbortError` when
 * `signal` aborts.
 */
export async function runMediaJob(job: MediaJob): Promise<Uint8Array> {
  const aborted = () => new DOMException('Cancelled', 'AbortError');
  if (job.signal?.aborted) throw aborted();
  const ff = await loadFfmpeg();
  const dir = `/job${++jobSeq}`;
  const inPath = `${dir}/in.${job.inputExt.toLowerCase() || 'bin'}`;
  const outPath = `/out${jobSeq}.${job.outputExt}`;
  let killed = false;
  const kill = () => {
    killed = true;
    ff.terminate();
    ffmpegPromise = null;
  };
  let lastLine = '';
  const log = ({ message }: { message: string }) => {
    if (message.trim() && !/^\s*(frame|size)=/.test(message)) lastLine = message.trim();
    job.onLog?.(message);
  };
  if (job.signal?.aborted) throw aborted();
  job.signal?.addEventListener('abort', kill, { once: true });
  ff.on('log', log);
  let mounted = false;
  try {
    await ff.createDir(dir);
    await ff.mount('WORKERFS' as import('@ffmpeg/ffmpeg').FFFSType, { blobs: [{ name: inPath.slice(dir.length + 1), data: job.input }] }, dir);
    mounted = true;
    const code = await ff.exec(job.args(inPath, outPath));
    if (code !== 0) throw new ConvertError(`The media engine could not process this file${lastLine ? ` (${lastLine.slice(0, 140)})` : ''}.`);
    const data = (await ff.readFile(outPath)) as Uint8Array;
    if (data.length === 0) throw new ConvertError('The export produced an empty file.');
    return data.slice();
  } catch (e) {
    if (killed) throw aborted();
    throw e instanceof ConvertError ? e : new ConvertError(`The media engine failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    job.signal?.removeEventListener('abort', kill);
    if (!killed) {
      ff.off('log', log);
      await ff.deleteFile(outPath).catch(() => undefined);
      if (mounted) await ff.unmount(dir).catch(() => undefined);
      await ff.deleteDir(dir).catch(() => undefined);
    }
  }
}

export const mediaConverter: Converter = {
  id: 'media',

  async run(target, input: ConvertInput): Promise<ConvertOutput> {
    if (input.bytes.length > MAX_INPUT) throw new ConvertError('Files over 1 GB are too large to process in the browser.');
    const ext = input.info.extension.toLowerCase();
    const ff = await loadFfmpeg();
    const inName = `in.${ext}`;
    const outName = `out.${target.ext}`;
    currentProgress = input.onProgress;
    try {
      await ff.writeFile(inName, input.bytes);
      const code = await ff.exec(['-i', inName, ...codecArgs(target.ext, input.level, VIDEO.includes(ext)), '-y', outName]);
      if (code !== 0) throw new ConvertError('The media engine could not process this file. The codec may be unsupported.');
      const data = (await ff.readFile(outName)) as Uint8Array;
      if (data.length === 0) throw new ConvertError('The conversion produced an empty file.');
      return { bytes: data.slice(), ext: target.ext, mime: mimeFor(target.ext) };
    } finally {
      currentProgress = undefined;
      await ff.deleteFile(inName).catch(() => undefined);
      await ff.deleteFile(outName).catch(() => undefined);
    }
  },
};
