import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatFileSize } from '@omniview/utilities';
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Eraser,
  Film,
  FolderOpen,
  Gauge,
  ImagePlay,
  Maximize2,
  Minimize2,
  Music,
  Pause,
  PictureInPicture2,
  Pin,
  PinOff,
  Play,
  Repeat,
  RotateCcw,
  RotateCw,
  Scissors,
  SkipBack,
  SkipForward,
  SquareArrowOutUpRight,
  Video,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  closeQuickViewWindow,
  isDesktop,
  openWithOtherApp,
  readSystemFile,
  revealInExplorer,
  saveNextTo,
  startWindowDrag,
  type QuickViewPayload,
} from '../services/desktopBridge';
import { WindowControls } from './pulse/WindowControls';
import {
  GIF_MAX_SECONDS,
  canStreamCopy,
  clipFileName,
  frameArgs,
  frameFileName,
  gifArgs,
  mp4CopyArgs,
  mp4EncodeArgs,
  parseFfmpegTime,
  validateRange,
  type ClipFormat,
} from './playerExport';

/** Video and audio Pulse plays itself (Quick View's player); the shell sends these here instead of the system's player. */
export const VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'ogv']);
export const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus']);
export const isMediaPayload = (f: QuickViewPayload) => VIDEO_EXTS.has(f.extension.toLowerCase()) || AUDIO_EXTS.has(f.extension.toLowerCase());

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SMALL = { size: 14, strokeWidth: 1.75 } as const;
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

type AppWindow = import('@tauri-apps/api/window').Window;

/** 0:07, 4:05, 1:02:09 */
function clock(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

const posKey = (f: QuickViewPayload) => `pulse.player.pos:${f.path}:${f.sizeBytes}`;
function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode: no resume */
  }
}

/** A file on disk as the webview can stream it (Tauri's asset protocol: range requests, nothing read up front). */
function useStreamUrl(path: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    void import('@tauri-apps/api/core').then(({ convertFileSrc }) => {
      if (alive) setUrl(convertFileSrc(path));
    });
    return () => {
      alive = false;
    };
  }, [path]);
  return url;
}

/** What FFmpeg (WebAssembly) is given whole; the existing converters draw the same line. */
const MAX_ENGINE_INPUT = 1024 * 1024 * 1024;

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/**
 * The picture at `at` seconds as a PNG, drawn through a second, CORS-mode <video>. Tauri's asset protocol answers
 * every request (ranges included) with `Access-Control-Allow-Origin: <this window's origin>`, so with
 * crossOrigin="anonymous" the canvas stays readable and the frame is the decoder's own, at full size. The playing
 * <video> is left without crossOrigin so playback never depends on it. Null when the webview still taints the canvas,
 * times out or can't decode: the caller then asks FFmpeg for the frame.
 */
async function grabFrame(src: string, at: number): Promise<Uint8Array | null> {
  const v = document.createElement('video');
  v.crossOrigin = 'anonymous';
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  // in the document (invisibly): WebKit may not paint frames of a detached video
  v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.appendChild(v);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('timeout')), 10000);
      const done = () => {
        window.clearTimeout(timer);
        resolve();
      };
      v.onloadedmetadata = () => {
        v.currentTime = Math.min(at, Math.max(0, v.duration - 0.001));
      };
      v.onseeked = () => {
        if (v.readyState >= 2) done();
        else v.oncanplay = done;
      };
      v.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error('decode'));
      };
      v.src = src;
    });
    if (!v.videoWidth || !v.videoHeight) return null;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0);
    // throws SecurityError if the canvas is tainted after all
    const blob = await new Promise<Blob | null>((resolve, reject) => {
      try {
        c.toBlob(resolve, 'image/png');
      } catch (e) {
        reject(e);
      }
    });
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  } finally {
    v.removeAttribute('src');
    v.load();
    v.remove();
  }
}

/** The whole file, as FFmpeg mounts it. */
async function loadSource(f: QuickViewPayload): Promise<Blob> {
  if (f.sizeBytes > MAX_ENGINE_INPUT) throw new Error('Files over 1 GB are too large to export from here.');
  return new Blob([await readSystemFile(f.path)]);
}

interface ExportJob {
  label: string;
  /** 0..1, or null while the engine hasn't said. */
  fraction: number | null;
  ctl: AbortController;
}

interface PulsePlayerProps {
  items: QuickViewPayload[];
  /** Pauses and goes (Esc, the close button, the window's own close). */
  onClose: () => void;
}

/**
 * Pulse's media player, in the Quick View window: the file manager's title bar, command bar and status bar around a
 * stage that plays the file straight from disk. Video sits on an ambient glow of its own colours; audio gets a
 * listening card. Its controls float in a glass bar that fades away while the picture plays.
 */
export function PulsePlayer({ items, onClose }: PulsePlayerProps) {
  const [index, setIndex] = useState(0);
  const item = items[Math.min(index, items.length - 1)];
  const ext = item.extension.toLowerCase();
  const isVideo = VIDEO_EXTS.has(ext);
  const src = useStreamUrl(item.path);

  const media = useRef<HTMLVideoElement | null>(null);
  const ambient = useRef<HTMLCanvasElement | null>(null);
  const stage = useRef<HTMLDivElement | null>(null);
  const scrub = useRef<HTMLDivElement | null>(null);

  const [win, setWin] = useState<AppWindow | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(() => Number(readStore('pulse.player.volume') ?? 1) || 1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(false);
  const [rateOpen, setRateOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [chrome, setChrome] = useState(true);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [flash, setFlash] = useState<{ key: number; icon: 'play' | 'pause' | 'back' | 'fwd' | 'vol'; text?: string } | null>(null);
  const [resumed, setResumed] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [markIn, setMarkIn] = useState<number | null>(null);
  const [markOut, setMarkOut] = useState<number | null>(null);
  const [clipOpen, setClipOpen] = useState(false);
  const [job, setJob] = useState<ExportJob | null>(null);
  const [saved, setSaved] = useState<{ path: string; name: string; key: number } | null>(null);
  const canExport = isVideo && isDesktop();
  const fitted = useRef(false);
  const idle = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!isDesktop()) return;
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => setWin(getCurrentWindow()));
  }, []);

  // a new file: everything about the last one goes
  useEffect(() => {
    setError(null);
    setSize(null);
    setTime(0);
    setDuration(0);
    setBuffered(0);
    setResumed(null);
    setPlaying(false);
    setMarkIn(null);
    setMarkOut(null);
    setClipOpen(false);
  }, [item.path]);

  // ---- playback --------------------------------------------------------------------------------------------------

  const say = (text: string, ms = 1800) => {
    setNotice(text);
    window.setTimeout(() => setNotice((n) => (n === text ? null : n)), ms);
  };
  const pop = (icon: 'play' | 'pause' | 'back' | 'fwd' | 'vol', text?: string) => setFlash({ key: Date.now(), icon, text });

  const toggle = useCallback(() => {
    const m = media.current;
    if (!m) return;
    if (m.paused) {
      void m.play().catch(() => undefined);
      pop('play');
    } else {
      m.pause();
      pop('pause');
    }
  }, []);

  const seekBy = (d: number) => {
    const m = media.current;
    if (!m || !Number.isFinite(m.duration)) return;
    m.currentTime = Math.min(Math.max(m.currentTime + d, 0), m.duration);
    pop(d < 0 ? 'back' : 'fwd', `${d > 0 ? '+' : '−'}${Math.abs(d)}s`);
  };

  const setVol = (v: number) => {
    const m = media.current;
    const nv = Math.min(Math.max(v, 0), 1);
    setVolume(nv);
    setMuted(nv === 0);
    if (m) {
      m.volume = nv;
      m.muted = nv === 0;
    }
    writeStore('pulse.player.volume', String(nv));
  };

  const go = (step: number) => {
    if (items.length < 2) return;
    fitted.current = true;
    setIndex((i) => (i + step + items.length) % items.length);
  };

  const close = useCallback(() => {
    media.current?.pause();
    onClose();
  }, [onClose]);

  const toggleFullscreen = () => {
    if (!win) return;
    void win.setFullscreen(!fullscreen).then(() => setFullscreen(!fullscreen));
  };
  const togglePin = () => {
    if (!win) return;
    void win.setAlwaysOnTop(!pinned).then(() => {
      setPinned(!pinned);
      say(pinned ? 'Unpinned' : 'Kept on top');
    });
  };
  const pip = () => {
    const m = media.current as (HTMLVideoElement & { webkitSetPresentationMode?: (mode: string) => void }) | null;
    if (!m) return;
    if (document.pictureInPictureElement) void document.exitPictureInPicture();
    else if (m.requestPictureInPicture) void m.requestPictureInPicture().catch(() => m.webkitSetPresentationMode?.('picture-in-picture'));
    else m.webkitSetPresentationMode?.('picture-in-picture');
  };
  const copyPath = () => {
    void navigator.clipboard.writeText(item.path).then(() => say('Path copied'));
  };

  // ---- export: a frame as PNG, the In-Out range as MP4 or GIF, saved next to the file ----------------------------

  const markAt = (which: 'in' | 'out') => {
    const m = media.current;
    if (!m || !Number.isFinite(m.duration)) return;
    const t = m.currentTime;
    if (which === 'in') {
      setMarkIn(t);
      if (markOut !== null && markOut <= t) setMarkOut(null);
    } else {
      setMarkOut(t);
      if (markIn !== null && markIn >= t) setMarkIn(null);
    }
    say(`${which === 'in' ? 'In' : 'Out'} at ${clock(t)}`);
  };
  const clearMarks = () => {
    setMarkIn(null);
    setMarkOut(null);
    setClipOpen(false);
  };

  /** Runs one export with progress in a toast, then saves the result next to `source` and offers to show it. */
  const runExport = async (
    label: string,
    source: QuickViewPayload,
    work: (signal: AbortSignal, progress: (fraction: number | null) => void) => Promise<{ bytes: Uint8Array; name: string }>
  ) => {
    if (job) {
      say('An export is already running');
      return;
    }
    const ctl = new AbortController();
    setJob({ label, fraction: null, ctl });
    const progress = (fraction: number | null) => setJob((j) => (j && j.ctl === ctl ? { ...j, fraction } : j));
    try {
      const { bytes, name } = await work(ctl.signal, progress);
      if (ctl.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const path = await saveNextTo(source.path, name, bytes);
      if (path) {
        const shown = { path, name: path.split(/[\\/]/).pop() ?? name, key: Date.now() };
        setSaved(shown);
        window.setTimeout(() => setSaved((s) => (s === shown ? null : s)), 7000);
      }
    } catch (e) {
      if (isAbort(e) || ctl.signal.aborted) say('Export cancelled');
      else say(e instanceof Error ? e.message : String(e), 6000);
    } finally {
      setJob((j) => (j && j.ctl === ctl ? null : j));
    }
  };

  const saveFrame = () => {
    const m = media.current;
    if (!m || !canExport || !src || m.readyState < 1) return;
    const at = m.currentTime;
    const source = item;
    const srcExt = ext;
    void runExport('Saving frame', source, async (signal) => {
      let bytes = await grabFrame(src, at);
      if (!bytes) {
        // the canvas route failed: FFmpeg decodes the same moment from the file itself
        const { runMediaJob } = await import('../converters/media');
        const input = await loadSource(source);
        bytes = await runMediaJob({ input, inputExt: srcExt, outputExt: 'png', args: (i, o) => frameArgs(i, o, at), signal });
      }
      return { bytes, name: frameFileName(source.filename, at) };
    });
  };

  const exportClip = (format: ClipFormat) => {
    setClipOpen(false);
    if (!canExport) return;
    const check = validateRange(markIn ?? (markOut !== null ? 0 : null), markOut ?? (markIn !== null ? duration : null), duration, format);
    if (!check.ok) {
      say(check.message, 5000);
      return;
    }
    if (item.sizeBytes > MAX_ENGINE_INPUT) {
      say('Files over 1 GB are too large to export from here.', 5000);
      return;
    }
    const source = item;
    const srcExt = ext;
    void runExport(format === 'gif' ? 'Making GIF' : 'Exporting clip', source, async (signal, progress) => {
      const { runMediaJob } = await import('../converters/media');
      const input = await loadSource(source);
      progress(0);
      const onLog = (line: string) => {
        const t = parseFfmpegTime(line);
        if (t !== null) progress(Math.min(1, t / check.length));
      };
      const run = (args: (i: string, o: string) => string[]) => runMediaJob({ input, inputExt: srcExt, outputExt: format, args, onLog, signal });
      let bytes: Uint8Array;
      if (format === 'gif') bytes = await run((i, o) => gifArgs(i, o, check.start, check.length));
      else if (canStreamCopy(srcExt)) {
        try {
          bytes = await run((i, o) => mp4CopyArgs(i, o, check.start, check.length));
        } catch (e) {
          if (isAbort(e)) throw e;
          progress(0);
          bytes = await run((i, o) => mp4EncodeArgs(i, o, check.start, check.length));
        }
      } else bytes = await run((i, o) => mp4EncodeArgs(i, o, check.start, check.length));
      return { bytes, name: clipFileName(source.filename, check.start, check.end, format) };
    });
  };

  // the window takes the picture's shape the first time a video is known (within 80 % of the screen)
  const fitWindow = async (w: number, h: number) => {
    if (fitted.current || !win || fullscreen) return;
    fitted.current = true;
    try {
      const { LogicalSize } = await import('@tauri-apps/api/dpi');
      const { currentMonitor } = await import('@tauri-apps/api/window');
      const mon = await currentMonitor();
      const scale = mon?.scaleFactor ?? 1;
      const maxW = (mon ? mon.workArea.size.width / scale : 1440) * 0.8;
      const maxH = (mon ? mon.workArea.size.height / scale : 900) * 0.8;
      const chromeH = 44 + 48 + 32 + 8; // title bar, command bar, status bar, the pane's margin
      // never larger than the picture itself (a 720p clip opens at 720p), smaller when the screen needs it
      const k = Math.min(maxW / w, (maxH - chromeH) / h, 1);
      const width = Math.max(640, Math.round(w * k) + 16);
      const height = Math.max(440, Math.round(h * k) + chromeH);
      await win.setSize(new LogicalSize(width, height));
      await win.center();
    } catch {
      /* the window keeps its size */
    }
  };

  // keys: Space / K play, ← → 5 s, J L 10 s, ↑ ↓ volume, M mute, F full screen, , . a frame, 0–9 a tenth, [ ] files,
  // I / O mark the clip, Shift+S saves the frame (Esc clears the marks before it closes)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const m = media.current;
      const typing = (e.target as HTMLElement | null)?.closest('input, textarea');
      if (typing) return;
      const k = e.key;
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
      let handled = true;
      if (k === 'Escape') {
        if (clipOpen) setClipOpen(false);
        else if (markIn !== null || markOut !== null) clearMarks();
        else if (fullscreen) toggleFullscreen();
        else close();
      } else if (canExport && plain && !e.shiftKey && k.toLowerCase() === 'i') markAt('in');
      else if (canExport && plain && !e.shiftKey && k.toLowerCase() === 'o') markAt('out');
      else if (canExport && plain && e.shiftKey && k.toLowerCase() === 's') saveFrame();
      else if (k === ' ' || k.toLowerCase() === 'k') toggle();
      else if (k === 'ArrowLeft') seekBy(-5);
      else if (k === 'ArrowRight') seekBy(5);
      else if (k.toLowerCase() === 'j') seekBy(-10);
      else if (k.toLowerCase() === 'l') seekBy(10);
      else if (k === 'ArrowUp') {
        setVol(volume + 0.05);
        pop('vol', `${Math.round(Math.min(volume + 0.05, 1) * 100)}%`);
      } else if (k === 'ArrowDown') {
        setVol(volume - 0.05);
        pop('vol', `${Math.round(Math.max(volume - 0.05, 0) * 100)}%`);
      } else if (k.toLowerCase() === 'm') {
        if (m) {
          m.muted = !m.muted;
          setMuted(m.muted);
          pop('vol', m.muted ? 'Muted' : `${Math.round(volume * 100)}%`);
        }
      } else if (k.toLowerCase() === 'f' || k === 'F11') toggleFullscreen();
      else if ((k === ',' || k === '.') && m && m.paused) m.currentTime = Math.max(0, m.currentTime + (k === ',' ? -1 / 30 : 1 / 30));
      else if (/^[0-9]$/.test(k) && m && Number.isFinite(m.duration)) m.currentTime = (Number(k) / 10) * m.duration;
      else if (k === ']') go(1);
      else if (k === '[') go(-1);
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        wake();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // ---- the controls come and go ----------------------------------------------------------------------------------

  const wake = useCallback(() => {
    setChrome(true);
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => {
      if (media.current && !media.current.paused && !rateOpen && !clipOpen) setChrome(false);
    }, 2600);
  }, [rateOpen, clipOpen]);
  useEffect(() => {
    if (!playing) setChrome(true);
    else wake();
  }, [playing, wake]);
  useEffect(() => () => window.clearTimeout(idle.current), []);

  // ---- ambient glow: the picture's own colours, blurred behind it ----------------------------------------------

  useEffect(() => {
    if (!isVideo) return;
    let raf = 0;
    let last = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < 200) return;
      last = now;
      const v = media.current;
      const c = ambient.current;
      if (!v || !c || v.readyState < 2) return;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      try {
        ctx.drawImage(v, 0, 0, c.width, c.height);
      } catch {
        /* nothing to draw yet */
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [isVideo, item.path]);

  // ---- position: remembered per file, picked up next time ------------------------------------------------------

  useEffect(() => {
    if (!playing) return;
    const t = window.setInterval(() => {
      const m = media.current;
      if (m && Number.isFinite(m.duration) && m.duration > 60) writeStore(posKey(item), String(m.currentTime));
    }, 4000);
    return () => window.clearInterval(t);
  }, [playing, item]);

  // the shell hides the window (its close button, Esc there): the sound stops with it
  useEffect(() => {
    if (!isDesktop()) return;
    let un: (() => void) | undefined;
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen('pulse://quickview-closed', () => media.current?.pause()).then((fn) => (un = fn))
    );
    return () => un?.();
  }, []);

  // ---- scrubbing -------------------------------------------------------------------------------------------------

  const timeAt = (clientX: number) => {
    const r = scrub.current?.getBoundingClientRect();
    if (!r || !duration) return { x: 0, t: 0 };
    const x = Math.min(Math.max(clientX - r.left, 0), r.width);
    return { x, t: (x / r.width) * duration };
  };
  const onScrubDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
    const { t } = timeAt(e.clientX);
    if (media.current) media.current.currentTime = t;
    setTime(t);
  };
  const onScrubMove = (e: React.PointerEvent) => {
    const h = timeAt(e.clientX);
    setHover(h);
    if (dragging && media.current) {
      media.current.currentTime = h.t;
      setTime(h.t);
    }
  };

  const progress = duration ? (time / duration) * 100 : 0;
  const bufferedPct = duration ? (buffered / duration) * 100 : 0;
  const VolIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const folder = useMemo(() => item.path.replace(/[\\/][^\\/]*$/, ''), [item.path]);
  const KindIcon = isVideo ? Video : Music;
  const pct = (t: number) => `${Math.min(Math.max(duration ? (t / duration) * 100 : 0, 0), 100)}%`;
  const hasMarks = markIn !== null || markOut !== null;
  const rangeStart = markIn ?? 0;
  const rangeEnd = markOut ?? duration;
  const rangeLength = Math.max(0, rangeEnd - rangeStart);
  const immersive = fullscreen;

  return (
    <div className="qv-standalone rf-window fixed inset-0 z-[80]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Player: ${item.filename}`}
        className={`qv-panel pp-panel relative flex flex-col w-full h-full focus:outline-none ${immersive ? 'pp-immersive' : ''}`}
      >
        {/* Title bar: the file as a tab */}
        {!immersive && (
          <header onMouseDown={(e) => startWindowDrag(e, true)} className="rf-titlebar flex items-center shrink-0 select-none">
            <div className="rf-tab" title={item.path}>
              <KindIcon {...ICON} />
              <span className="truncate">{item.filename}</span>
              <button className="rf-tab-close" onClick={close} aria-label="Close player" title="Close (Esc)">
                <X size={14} strokeWidth={1.75} />
              </button>
            </div>
            {items.length > 1 && <span className="pp-count">{index + 1} / {items.length}</span>}
            <div className="flex-1" />
            {win && !IS_MAC && <WindowControls onClose={close} lucide />}
          </header>
        )}

        {/* Command bar: the file's own commands */}
        {!immersive && (
          <div className="rf-commandbar flex items-center shrink-0">
            {items.length > 1 && (
              <>
                <button className="rf-cmd" onClick={() => go(-1)} title="Previous file ([)" aria-label="Previous file">
                  <ChevronLeft {...ICON} />
                </button>
                <button className="rf-cmd" onClick={() => go(1)} title="Next file (])" aria-label="Next file">
                  <ChevronRight {...ICON} />
                </button>
                <span className="rf-cmd-sep" />
              </>
            )}
            <button className="rf-cmd" onClick={copyPath} title="Copy path" aria-label="Copy path">
              <ClipboardCopy {...ICON} />
            </button>
            <button className="rf-cmd" onClick={() => void revealInExplorer(item.path)} title="Show in folder" aria-label="Show in folder">
              <FolderOpen {...ICON} />
            </button>
            <button className="rf-cmd" onClick={() => void openWithOtherApp(item.path)} title="Open with another app" aria-label="Open with another app">
              <SquareArrowOutUpRight {...ICON} />
            </button>
            <div className="flex-1" />
            {win && (
              <>
                <button className={`rf-cmd ${pinned ? 'rf-cmd-on' : ''}`} onClick={togglePin} aria-pressed={pinned} title={pinned ? 'Unpin' : 'Keep on top'} aria-label="Keep on top">
                  {pinned ? <PinOff {...ICON} /> : <Pin {...ICON} />}
                </button>
                <button className="rf-cmd" onClick={toggleFullscreen} title="Full screen (F)" aria-label="Full screen">
                  <Maximize2 {...ICON} />
                </button>
              </>
            )}
          </div>
        )}

        {/* The stage */}
        <div
          ref={stage}
          key={item.path}
          className={`pp-stage ${immersive ? '' : 'rf-content'} relative flex-1 min-h-0 overflow-hidden anim-fade-up ${chrome ? '' : 'pp-idle'}`}
          onMouseMove={wake}
          onMouseLeave={() => playing && setChrome(false)}
        >
          {isVideo && <canvas ref={ambient} width={32} height={18} className="pp-ambient" aria-hidden />}

          {src && (
            <video
              ref={media}
              src={src}
              className={isVideo ? 'pp-video' : 'pp-audio-el'}
              autoPlay
              playsInline
              loop={loop}
              preload="auto"
              onClick={isVideo ? toggle : undefined}
              onDoubleClick={isVideo ? toggleFullscreen : undefined}
              onPlay={() => setPlaying(true)}
              onPause={() => {
                setPlaying(false);
                const m = media.current;
                if (m && Number.isFinite(m.duration) && m.duration > 60) writeStore(posKey(item), String(m.currentTime));
              }}
              onEnded={() => {
                writeStore(posKey(item), null);
                if (!loop && index < items.length - 1) go(1);
              }}
              onTimeUpdate={(e) => !dragging && setTime(e.currentTarget.currentTime)}
              onProgress={(e) => {
                const b = e.currentTarget.buffered;
                if (b.length) setBuffered(b.end(b.length - 1));
              }}
              onLoadedMetadata={(e) => {
                const m = e.currentTarget;
                m.volume = volume;
                m.playbackRate = rate;
                setDuration(m.duration);
                if (m.videoWidth) {
                  setSize({ w: m.videoWidth, h: m.videoHeight });
                  void fitWindow(m.videoWidth, m.videoHeight);
                }
                const saved = Number(readStore(posKey(item)) ?? 0);
                if (saved > 5 && saved < m.duration - 5) {
                  m.currentTime = saved;
                  setResumed(saved);
                  window.setTimeout(() => setResumed(null), 5000);
                }
              }}
              onError={() =>
                setError(
                  isVideo
                    ? `This video's format (${ext.toUpperCase()}) can't be played here.`
                    : `This audio's format (${ext.toUpperCase()}) can't be played here.`
                )
              }
            />
          )}

          {/* audio: a listening card instead of a picture */}
          {!isVideo && !error && (
            <div className="pp-listen">
              <div className={`pp-disc ${playing ? 'pp-spin' : ''}`}>
                <Music size={34} strokeWidth={1.5} />
              </div>
              <div className="pp-listen-name">{item.filename.replace(/\.[^.]+$/, '')}</div>
              <div className="pp-listen-meta">{ext.toUpperCase()} · {formatFileSize(item.sizeBytes)}</div>
              <div className={`pp-bars ${playing ? 'pp-bars-on' : ''}`} aria-hidden>
                {Array.from({ length: 28 }, (_, i) => (
                  <i key={i} style={{ animationDelay: `${(i * 97) % 900}ms` }} />
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="pp-error">
              <KindIcon size={28} strokeWidth={1.5} />
              <p>{error}</p>
              <div className="flex gap-2">
                <button className="pp-pill" onClick={() => void openWithOtherApp(item.path)}>
                  <SquareArrowOutUpRight {...SMALL} /> Open with another app
                </button>
                <button className="pp-pill" onClick={() => void revealInExplorer(item.path)}>
                  <FolderOpen {...SMALL} /> Show in folder
                </button>
              </div>
            </div>
          )}

          {/* what a key or a click just did, in the middle for a moment */}
          {flash && (
            <div key={flash.key} className="pp-flash" aria-hidden>
              {flash.icon === 'play' && <Play size={28} fill="currentColor" />}
              {flash.icon === 'pause' && <Pause size={28} fill="currentColor" />}
              {flash.icon === 'back' && <RotateCcw size={26} />}
              {flash.icon === 'fwd' && <RotateCw size={26} />}
              {flash.icon === 'vol' && <VolIcon size={26} />}
              {flash.text && <span>{flash.text}</span>}
            </div>
          )}

          {job ? (
            <div className="pp-toast" role="status">
              <span>{job.label}</span>
              <span className="pp-progress" aria-hidden>
                <i style={job.fraction === null ? undefined : { width: `${Math.round(job.fraction * 100)}%` }} className={job.fraction === null ? 'pp-progress-wait' : ''} />
              </span>
              <span className="pp-toast-num">{job.fraction === null ? '…' : `${Math.round(job.fraction * 100)}%`}</span>
              <button onClick={() => job.ctl.abort()}>Cancel</button>
            </div>
          ) : saved ? (
            <div key={saved.key} className="pp-toast" role="status">
              <span className="pp-toast-name" title={saved.path}>Saved {saved.name}</span>
              <button onClick={() => void revealInExplorer(saved.path)}>Show in folder</button>
            </div>
          ) : null}

          {!job && !saved && resumed !== null && (
            <div className="pp-toast">
              Resumed at {clock(resumed)}
              <button
                onClick={() => {
                  if (media.current) media.current.currentTime = 0;
                  writeStore(posKey(item), null);
                  setResumed(null);
                }}
              >
                Start over
              </button>
            </div>
          )}
          {!job && !saved && notice && <div className="pp-toast">{notice}</div>}

          {/* the controls: a glass bar over the picture */}
          {!error && (
            <div className={`pp-controls ${chrome || !isVideo ? 'pp-shown' : ''}`} onMouseMove={wake}>
              <div
                ref={scrub}
                className={`pp-scrub ${dragging ? 'pp-scrubbing' : ''}`}
                onPointerDown={onScrubDown}
                onPointerMove={onScrubMove}
                onPointerUp={() => setDragging(false)}
                onPointerLeave={() => !dragging && setHover(null)}
                role="slider"
                aria-label="Seek"
                aria-valuemin={0}
                aria-valuemax={Math.round(duration)}
                aria-valuenow={Math.round(time)}
              >
                <div className="pp-track">
                  <div className="pp-buffered" style={{ width: `${bufferedPct}%` }} />
                  <div className="pp-played" style={{ width: `${progress}%` }} />
                </div>
                {hasMarks && duration > 0 && (
                  <>
                    <div className="pp-cliprange" style={{ left: pct(rangeStart), width: `calc(${pct(rangeEnd)} - ${pct(rangeStart)})` }} aria-hidden />
                    {markIn !== null && <div className="pp-mark pp-mark-in" style={{ left: pct(markIn) }} title={`In ${clock(markIn)}`} aria-hidden />}
                    {markOut !== null && <div className="pp-mark pp-mark-out" style={{ left: pct(markOut) }} title={`Out ${clock(markOut)}`} aria-hidden />}
                  </>
                )}
                <div className="pp-thumb" style={{ left: `${progress}%` }} />
                {hover && duration > 0 && (
                  <div className="pp-hover" style={{ left: hover.x }}>
                    {clock(hover.t)}
                  </div>
                )}
              </div>
              <div className="pp-row">
                {items.length > 1 && (
                  <button className="pp-btn" onClick={() => go(-1)} title="Previous ([)" aria-label="Previous">
                    <SkipBack {...SMALL} fill="currentColor" />
                  </button>
                )}
                <button className="pp-btn pp-play" onClick={toggle} title={playing ? 'Pause (Space)' : 'Play (Space)'} aria-label={playing ? 'Pause' : 'Play'}>
                  {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
                </button>
                {items.length > 1 && (
                  <button className="pp-btn" onClick={() => go(1)} title="Next (])" aria-label="Next">
                    <SkipForward {...SMALL} fill="currentColor" />
                  </button>
                )}
                <button className="pp-btn" onClick={() => seekBy(-10)} title="Back 10 s (J)" aria-label="Back 10 seconds">
                  <RotateCcw {...SMALL} />
                </button>
                <button className="pp-btn" onClick={() => seekBy(10)} title="Forward 10 s (L)" aria-label="Forward 10 seconds">
                  <RotateCw {...SMALL} />
                </button>
                <span className="pp-time">
                  {clock(time)} <i>/</i> {clock(duration)}
                </span>
                <div className="flex-1" />
                {canExport && (
                  <>
                    <button className="pp-btn" onClick={saveFrame} disabled={!!job} title="Save frame as PNG (Shift+S)" aria-label="Save frame">
                      <Camera {...SMALL} />
                    </button>
                    <button className={`pp-btn pp-markbtn ${markIn !== null ? 'pp-on' : ''}`} onClick={() => markAt('in')} title={markIn !== null ? `In at ${clock(markIn)} (I sets it again)` : 'Mark In (I)'} aria-label="Mark In">
                      In
                    </button>
                    <button className={`pp-btn pp-markbtn ${markOut !== null ? 'pp-on' : ''}`} onClick={() => markAt('out')} title={markOut !== null ? `Out at ${clock(markOut)} (O sets it again)` : 'Mark Out (O)'} aria-label="Mark Out">
                      Out
                    </button>
                    <div className="relative">
                      <button
                        className={`pp-btn ${clipOpen ? 'pp-on' : ''}`}
                        onClick={() => {
                          setRateOpen(false);
                          setClipOpen((o) => !o);
                        }}
                        disabled={!!job}
                        title="Export clip (MP4 or GIF)"
                        aria-label="Export clip"
                        aria-expanded={clipOpen}
                      >
                        <Scissors {...SMALL} />
                      </button>
                      {clipOpen && (
                        <div className="pp-menu pp-clipmenu" onMouseLeave={() => setClipOpen(false)}>
                          <div className="pp-menu-head">
                            {hasMarks ? (
                              <>
                                {clock(rangeStart)} – {clock(rangeEnd)} <i>·</i> {rangeLength < 10 ? rangeLength.toFixed(1) : Math.round(rangeLength)} s
                              </>
                            ) : (
                              'Mark In (I) and Out (O)'
                            )}
                          </div>
                          <button disabled={!hasMarks} onClick={() => exportClip('mp4')} title={canStreamCopy(ext) ? 'Copies the streams when it can (fast, lossless, starts at the nearest keyframe); otherwise re-encodes' : 'Re-encodes to H.264 / AAC'}>
                            <Film {...SMALL} /> <span>Export MP4</span>
                          </button>
                          <button disabled={!hasMarks} onClick={() => exportClip('gif')} title={rangeLength > GIF_MAX_SECONDS ? `GIFs are limited to ${GIF_MAX_SECONDS} s` : '12 fps, up to 480 px wide'}>
                            <ImagePlay {...SMALL} /> <span>Export GIF</span>
                          </button>
                          <button disabled={!hasMarks} onClick={clearMarks} title="Clear In and Out (Esc)">
                            <Eraser {...SMALL} /> <span>Clear marks</span> <kbd>Esc</kbd>
                          </button>
                        </div>
                      )}
                    </div>
                    <span className="pp-sep" aria-hidden />
                  </>
                )}
                <div className="pp-vol">
                  <button
                    className="pp-btn"
                    onClick={() => {
                      const m = media.current;
                      if (!m) return;
                      m.muted = !m.muted;
                      setMuted(m.muted);
                    }}
                    title="Mute (M)"
                    aria-label="Mute"
                  >
                    <VolIcon {...SMALL} />
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={muted ? 0 : volume}
                    onChange={(e) => setVol(Number(e.target.value))}
                    aria-label="Volume"
                    style={{ ['--v' as string]: `${(muted ? 0 : volume) * 100}%` }}
                  />
                </div>
                <div className="relative">
                  <button className={`pp-btn pp-rate ${rate !== 1 ? 'pp-on' : ''}`} onClick={() => { setClipOpen(false); setRateOpen((o) => !o); }} title="Speed" aria-label="Speed">
                    <Gauge {...SMALL} />
                    <span>{rate}×</span>
                  </button>
                  {rateOpen && (
                    <div className="pp-menu" onMouseLeave={() => setRateOpen(false)}>
                      {RATES.map((r) => (
                        <button
                          key={r}
                          className={r === rate ? 'pp-on' : ''}
                          onClick={() => {
                            setRate(r);
                            if (media.current) media.current.playbackRate = r;
                            setRateOpen(false);
                          }}
                        >
                          {r}×
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button className={`pp-btn ${loop ? 'pp-on' : ''}`} onClick={() => setLoop((l) => !l)} title="Loop" aria-pressed={loop} aria-label="Loop">
                  <Repeat {...SMALL} />
                </button>
                {isVideo && (
                  <button className="pp-btn" onClick={pip} title="Picture in picture" aria-label="Picture in picture">
                    <PictureInPicture2 {...SMALL} />
                  </button>
                )}
                {win && isVideo && (
                  <button className="pp-btn" onClick={toggleFullscreen} title={fullscreen ? 'Exit full screen (F)' : 'Full screen (F)'} aria-label="Full screen">
                    {fullscreen ? <Minimize2 {...SMALL} /> : <Maximize2 {...SMALL} />}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Status bar */}
        {!immersive && (
          <footer className="rf-status flex items-center shrink-0">
            <span>{isVideo ? 'Video' : 'Audio'} · {ext.toUpperCase()}</span>
            {size && <span>{size.w} × {size.h}</span>}
            {duration > 0 && <span>{clock(duration)}</span>}
            <span>{formatFileSize(item.sizeBytes)}</span>
            {rate !== 1 && <span className="rf-status-on">{rate}×</span>}
            <button className="rf-status-path truncate" onClick={() => void revealInExplorer(item.path)} title="Show in folder">
              {folder}
            </button>
            <div className="flex-1" />
            <span>Esc close</span>
          </footer>
        )}
      </div>
    </div>
  );
}

/** Closes the player window (the shell keeps the window for the next file). */
export const closePlayerWindow = () => void closeQuickViewWindow();
