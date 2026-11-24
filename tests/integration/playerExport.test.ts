import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  GIF_MAX_SECONDS,
  canStreamCopy,
  clipFileName,
  ffTime,
  frameArgs,
  frameFileName,
  gifArgs,
  mp4CopyArgs,
  mp4EncodeArgs,
  nameTime,
  nextFreeName,
  parseFfmpegTime,
  stem,
  validateRange,
} from '../../apps/web/src/components/playerExport';

describe('player export: names', () => {
  it('formats times for file names', () => {
    expect(nameTime(0)).toBe('0m00s');
    expect(nameTime(12.9)).toBe('0m12s');
    expect(nameTime(65)).toBe('1m05s');
    expect(nameTime(3725)).toBe('1h02m05s');
    expect(nameTime(-3)).toBe('0m00s');
    expect(nameTime(Number.NaN)).toBe('0m00s');
  });

  it('builds frame and clip names from the source name', () => {
    expect(stem('holiday.final.mp4')).toBe('holiday.final');
    expect(stem('.hidden')).toBe('.hidden');
    expect(frameFileName('My video.mp4', 12.4)).toBe('My video frame 0m12s.png');
    expect(clipFileName('My video.mov', 10, 25.7, 'mp4')).toBe('My video clip 0m10s-0m25s.mp4');
    expect(clipFileName('a.mkv', 3600, 3610, 'gif')).toBe('a clip 1h00m00s-1h00m10s.gif');
  });

  it('picks the next free name, never an existing one', () => {
    expect(nextFreeName('a frame 0m12s.png', [])).toBe('a frame 0m12s.png');
    expect(nextFreeName('a frame 0m12s.png', ['a frame 0m12s.png'])).toBe('a frame 0m12s 2.png');
    expect(nextFreeName('a frame 0m12s.png', ['A FRAME 0m12s.PNG', 'a frame 0m12s 2.png'])).toBe('a frame 0m12s 3.png');
    expect(nextFreeName('x.png', new Set(['x.png', 'x 3.png']))).toBe('x 2.png');
    expect(nextFreeName('noext', ['noext'])).toBe('noext 2');
  });
});

describe('player export: range checks', () => {
  it('needs both marks and In before Out', () => {
    expect(validateRange(null, 10, 60, 'mp4').ok).toBe(false);
    expect(validateRange(5, null, 60, 'mp4').ok).toBe(false);
    const backwards = validateRange(20, 10, 60, 'mp4');
    expect(backwards.ok).toBe(false);
    if (!backwards.ok) expect(backwards.message).toMatch(/after the In/);
    expect(validateRange(10, 10, 60, 'mp4').ok).toBe(false);
    expect(validateRange(10, 10.05, 60, 'mp4').ok).toBe(false);
    expect(validateRange(Number.NaN, 10, 60, 'mp4').ok).toBe(false);
  });

  it('clamps to the file and reports the length', () => {
    expect(validateRange(-2, 999, 120, 'mp4')).toEqual({ ok: true, start: 0, end: 120, length: 120 });
    expect(validateRange(10, 25, 60, 'gif')).toEqual({ ok: true, start: 10, end: 25, length: 15 });
  });

  it(`refuses GIFs over ${GIF_MAX_SECONDS} s with a clear message, but not MP4`, () => {
    expect(validateRange(0, 60, 600, 'gif').ok).toBe(true);
    const long = validateRange(0, 61, 600, 'gif');
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.message).toMatch(/GIFs are limited to 60 s; this range is 61 s/);
    expect(validateRange(0, 300, 600, 'mp4').ok).toBe(true);
  });
});

describe('player export: FFmpeg arguments', () => {
  it('seeks before the input and limits the output length', () => {
    expect(ffTime(12.3456)).toBe('12.346');
    expect(ffTime(-1)).toBe('0.000');
    const copy = mp4CopyArgs('/j/in.mp4', '/o.mp4', 10, 15);
    expect(copy.slice(0, 6)).toEqual(['-ss', '10.000', '-i', '/j/in.mp4', '-t', '15.000']);
    expect(copy).toEqual(expect.arrayContaining(['-c', 'copy', '-map', '0:v:0', '0:a:0?']));
    expect(copy.at(-1)).toBe('/o.mp4');
  });

  it('re-encodes to H.264 / AAC with even dimensions', () => {
    const enc = mp4EncodeArgs('in.mkv', 'out.mp4', 1, 2);
    expect(enc).toEqual(expect.arrayContaining(['libx264', 'aac', 'yuv420p', '+faststart']));
    expect(enc[enc.indexOf('-vf') + 1]).toBe('scale=trunc(iw/2)*2:trunc(ih/2)*2');
    expect(enc).not.toContain('copy');
  });

  it('makes palette GIFs at 12 fps, at most 480 px wide, without audio', () => {
    const gif = gifArgs('in.mp4', 'out.gif', 3, 4);
    const filter = gif[gif.indexOf('-filter_complex') + 1];
    expect(filter).toContain('fps=12');
    expect(filter).toContain("scale='min(480,iw)':-1");
    expect(filter).toMatch(/palettegen.*paletteuse/);
    expect(gif).toEqual(expect.arrayContaining(['-an', '-loop', '0']));
  });

  it('grabs one frame', () => {
    expect(frameArgs('in.mov', 'f.png', 7.5)).toEqual(['-ss', '7.500', '-i', 'in.mov', '-frames:v', '1', '-an', '-y', 'f.png']);
  });

  it('knows which containers can be stream-copied into MP4', () => {
    expect(canStreamCopy('MP4')).toBe(true);
    expect(canStreamCopy('mov')).toBe(true);
    expect(canStreamCopy('webm')).toBe(false);
    expect(canStreamCopy('mkv')).toBe(false);
  });

  it('reads progress from FFmpeg log lines', () => {
    expect(parseFfmpegTime('frame=  120 fps= 30 q=-1.0 size=  1024KiB time=00:01:02.50 bitrate=…')).toBeCloseTo(62.5);
    expect(parseFfmpegTime('size=N/A time=01:00:00.00 bitrate=N/A')).toBe(3600);
    expect(parseFfmpegTime('time=-00:00:00.04')).toBeNull();
    expect(parseFfmpegTime('Input #0, mov,mp4,m4a')).toBeNull();
  });
});

// The same argument lists through a native FFmpeg, when one is installed: proves the filter graph and options parse
// and produce the expected files. (The app runs them in FFmpeg's WebAssembly build, which this does not exercise.)
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
describe.skipIf(!hasFfmpeg)('player export: arguments run through native FFmpeg', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulse-player-export-'));
  const src = join(dir, 'src.mp4');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const ff = (args: string[]) => {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  };
  const probe = (file: string, entries: string) =>
    spawnSync('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' }).stdout.trim().split('\n');

  it('creates a 10 s 1280x720 test video with sound', () => {
    ff([
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
      '-c:v', 'libx264', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', src,
    ]);
    expect(statSync(src).size).toBeGreaterThan(0);
  });

  it('frame: one 1280x720 PNG', () => {
    const out = join(dir, 'f.png');
    ff(frameArgs(src, out, 4.2));
    expect(readFileSync(out).subarray(1, 4).toString()).toBe('PNG');
    expect(probe(out, 'stream=width,height')).toEqual(['1280', '720']);
  });

  it('MP4 stream copy and re-encode: about the marked length, video and audio', () => {
    for (const [name, build] of [['copy.mp4', mp4CopyArgs], ['enc.mp4', mp4EncodeArgs]] as const) {
      const out = join(dir, name);
      ff(build(src, out, 2, 3));
      const length = Number(probe(out, 'format=duration')[0]);
      expect(length).toBeGreaterThan(2.8);
      expect(length).toBeLessThan(3.3);
      expect(probe(out, 'stream=codec_type').sort()).toEqual(['audio', 'video']);
    }
  });

  it('GIF: 480 px wide, 12 fps, the marked length', () => {
    const out = join(dir, 'c.gif');
    ff(gifArgs(src, out, 1, 2));
    expect(readFileSync(out).subarray(0, 3).toString()).toBe('GIF');
    const [codec, width, height, rate, frames] = probe(out, 'stream=codec_name,width,height,r_frame_rate,nb_frames');
    expect(codec).toBe('gif');
    expect([width, height]).toEqual(['480', '270']);
    expect(rate).toBe('12/1');
    expect(Number(frames)).toBeGreaterThanOrEqual(23);
    expect(Number(frames)).toBeLessThanOrEqual(25);
  });
});
