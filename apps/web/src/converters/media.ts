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
