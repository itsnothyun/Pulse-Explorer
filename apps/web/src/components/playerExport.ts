/**
 * Pure helpers behind the player's export tools (Save frame, Clip to MP4 / GIF): file names, range checks and the
 * FFmpeg arguments. Nothing here touches the DOM, Tauri or FFmpeg itself, so it is unit-tested on its own
 * (tests/integration/playerExport.test.ts).
 */

/** GIFs past this length get huge and slow to encode in WebAssembly; the player refuses them. */
export const GIF_MAX_SECONDS = 60;
/** A clip shorter than this is almost certainly a mis-click. */
export const MIN_CLIP_SECONDS = 0.1;
export const GIF_MAX_WIDTH = 480;
export const GIF_FPS = 12;

/** Containers whose usual codecs (H.264 / HEVC / AAC) can be copied into an .mp4 without re-encoding. */
const COPY_TO_MP4 = new Set(['mp4', 'm4v', 'mov']);

export type ClipFormat = 'mp4' | 'gif';

/** 12.7 s -> `0m12s`, 3725 s -> `1h02m05s`: a time as it goes into a file name (no colons, sorts sensibly). */
export function nameTime(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m${sec}s` : `${m}m${sec}s`;
}

/** `holiday.final.mp4` -> `holiday.final`; a dot file keeps its name. */
export function stem(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i > 0 ? filename.slice(0, i) : filename;
}

/** `<name> frame 0m12s.png` */
export function frameFileName(sourceFilename: string, seconds: number): string {
  return `${stem(sourceFilename)} frame ${nameTime(seconds)}.png`;
}

/** `<name> clip 0m10s-0m25s.mp4` / `.gif` */
export function clipFileName(sourceFilename: string, start: number, end: number, format: ClipFormat): string {
  return `${stem(sourceFilename)} clip ${nameTime(start)}-${nameTime(end)}.${format}`;
}

/**
 * The first of `name`, `name 2`, `name 3`… (before the extension) not in `taken`, compared case-insensitively since
 * macOS and Windows folders usually are. The desktop shell applies the same rule when it writes the file
 * (`save_next_to`), atomically, so this is for previews and the browser build.
 */
export function nextFreeName(name: string, taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, (n) => n.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  const base = stem(name);
  const ext = name.slice(base.length);
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}${ext}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

export type RangeCheck = { ok: true; start: number; end: number; length: number } | { ok: false; message: string };

/** Checks an In / Out pair before exporting it. */
export function validateRange(start: number | null, end: number | null, duration: number, format: ClipFormat): RangeCheck {
  if (start === null || end === null) return { ok: false, message: 'Mark an In point (I) and an Out point (O) first.' };
  if (![start, end].every(Number.isFinite)) return { ok: false, message: 'The marked range is not valid.' };
  const max = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  const s = Math.max(0, start);
  const e = Math.min(end, max);
  if (e <= s) return { ok: false, message: 'The Out point must come after the In point.' };
  const length = e - s;
  if (length < MIN_CLIP_SECONDS) return { ok: false, message: 'The clip is too short.' };
  if (format === 'gif' && length > GIF_MAX_SECONDS + 1e-6) {
    return { ok: false, message: `GIFs are limited to ${GIF_MAX_SECONDS} s; this range is ${Math.round(length)} s. Export it as MP4, or mark a shorter range.` };
  }
  return { ok: true, start: s, end: e, length };
}

/** Seconds as FFmpeg reads them, to the millisecond. */
export const ffTime = (seconds: number): string => (Math.max(0, seconds)).toFixed(3);

/** True when the source's container can usually be stream-copied into MP4. */
export const canStreamCopy = (sourceExt: string): boolean => COPY_TO_MP4.has(sourceExt.toLowerCase());

/**
 * Stream copy: fast and lossless, but the clip starts at the keyframe at or before In (it can begin a little early).
 * Only the first video and first audio stream: subtitle and data tracks often can't go into MP4.
 */
export function mp4CopyArgs(input: string, output: string, start: number, length: number): string[] {
  return [
    '-ss', ffTime(start), '-i', input, '-t', ffTime(length),
    '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy',
    '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', '-y', output,
  ];
}

/** Re-encode: frame-accurate In and Out, H.264 + AAC, even dimensions as yuv420p needs. */
export function mp4EncodeArgs(input: string, output: string, start: number, length: number): string[] {
  return [
    '-ss', ffTime(start), '-i', input, '-t', ffTime(length),
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-y', output,
  ];
}

/** GIF: 12 fps, at most 480 px wide, one palette generated from the clip itself (much better than the default). */
export function gifArgs(input: string, output: string, start: number, length: number): string[] {
  const filter =
    `fps=${GIF_FPS},scale='min(${GIF_MAX_WIDTH},iw)':-1:flags=lanczos,split[a][b];` +
    `[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
  return ['-ss', ffTime(start), '-i', input, '-t', ffTime(length), '-filter_complex', filter, '-loop', '0', '-an', '-y', output];
}

/** One frame as PNG (used when the picture can't be read back from a canvas). */
export function frameArgs(input: string, output: string, at: number): string[] {
  return ['-ss', ffTime(at), '-i', input, '-frames:v', '1', '-an', '-y', output];
}

/** `frame=  12 fps=… time=00:01:02.50 bitrate=…` -> 62.5; null for any other log line. */
export function parseFfmpegTime(line: string): number | null {
  const m = /time=\s*(-?)(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line);
  if (!m || m[1] === '-') return null;
  return Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}
