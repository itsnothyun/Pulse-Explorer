import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { GLYPHS, PULSE_GLYPH_METRICS as M } from '@omniview/ui';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function buildPath(line: string, dot: number, gap: number): { d: string; w: number; h: number } {
  const t = line.toUpperCase();
  const cols = Math.max(t.length * M.advance - 1, 1);
  const s = dot - gap;
  let d = '';
  for (let i = 0; i < t.length; i++) {
    const rows = GLYPHS[t[i]];
    if (!rows) continue;
    for (let r = 0; r < M.rows; r++)
      for (let c = 0; c < M.cols; c++)
        if (rows[r] & (0x10 >> c)) d += `M${(i * M.advance + c) * dot} ${r * dot}h${s}v${s}h-${s}z`;
  }
  return { d, w: cols * dot, h: M.rows * dot };
}

function buildRects(line: string, dot: number, gap: number) {
  const t = line.toUpperCase();
  const s = dot - gap;
  const rects: { x: number; y: number; s: number; delay: number }[] = [];
  for (let i = 0; i < t.length; i++) {
    const rows = GLYPHS[t[i]];
    if (!rows) continue;
    for (let r = 0; r < M.rows; r++)
      for (let c = 0; c < M.cols; c++)
        if (rows[r] & (0x10 >> c))
          rects.push({
            x: (i * M.advance + c) * dot,
            y: r * dot,
            s,
            delay: Math.round(Math.random() * 520 + c * 18 + i * 14),
          });
  }
  return rects;
}

interface PixelTextProps {
  /** Text to draw. Use `|` to break lines. Rendered uppercase. */
  text: string;
  /** Desired dot size in px; shrinks in 0.25px steps to fit the container. */
  dot?: number;
  /** Real-text twin for assistive tech; defaults to `text`. */
  label?: string;
  /** Run the one-time headline assembly animation. */
  assemble?: boolean;
  align?: 'start' | 'center';
  className?: string;
}

/**
 * Pulse 5x7 pixel heading. The SVG is aria-hidden and paired with a visually
 * hidden real-text twin (The Real-Text-Behind-Pixels Rule).
 */
export function PixelText({ text, dot = 6, label, assemble = false, align = 'start', className = '' }: PixelTextProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [fitDot, setFitDot] = useState(dot);
  const lines = useMemo(() => text.split('|'), [text]);
  const [animate] = useState(() => assemble && !prefersReducedMotion());

  useLayoutEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const cols = Math.max(...lines.map((l) => l.length * M.advance - 1));
    const fit = () => {
      const box = el.getBoundingClientRect().width || 320;
      setFitDot(Math.max(M.minDot, Math.min(dot, Math.floor((box / cols) * 4) / 4)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [lines, dot]);

  const gap = fitDot >= M.gapThreshold ? Math.round(fitDot * M.gapRatio * 4) / 4 : 0;

  return (
    <span ref={ref} className={`px ${className}`} style={{ ['--dot' as string]: `${fitDot}px` }}>
      <span className="sr-only">{label ?? text.replace(/\|/g, ' ')}</span>
      {lines.map((line, i) => {
        if (animate) {
          const rects = buildRects(line, fitDot, gap);
          const cols = Math.max(line.length * M.advance - 1, 1);
          return (
            <span key={i} className={`px-line ${align === 'center' ? 'px-center' : ''}`}>
              <svg
                className="px-assemble"
                viewBox={`0 0 ${cols * fitDot} ${M.rows * fitDot}`}
                width={cols * fitDot}
                height={M.rows * fitDot}
                shapeRendering="crispEdges"
                fill="currentColor"
                aria-hidden="true"
                focusable="false"
              >
                {rects.map((r, j) => (
                  <rect key={j} x={r.x} y={r.y} width={r.s} height={r.s} style={{ animationDelay: `${r.delay}ms` }} />
                ))}
              </svg>
            </span>
          );
        }
        const { d, w, h } = buildPath(line, fitDot, gap);
        return (
          <span key={i} className={`px-line ${align === 'center' ? 'px-center' : ''}`}>
            <svg
              viewBox={`0 0 ${w} ${h}`}
              width={w}
              height={h}
              shapeRendering="crispEdges"
              fill="currentColor"
              aria-hidden="true"
              focusable="false"
            >
              <path d={d} />
            </svg>
          </span>
        );
      })}
    </span>
  );
}

/** The widget's 8-dot scanner with a 3-dot trail. `big` doubles its size. */
export function Scanner({ big = false, hot = false, className = '' }: { big?: boolean; hot?: boolean; className?: string }) {
  return (
    <span className={`scan ${big ? 'scan-big' : ''} ${hot ? 'scan-hot' : ''} ${className}`} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

/** A square live pixel breathing between 30% and 100%. */
export function Pip({ still = false, className = '' }: { still?: boolean; className?: string }) {
  return <span className={`pip ${still ? 'pip-still' : ''} ${className}`} aria-hidden="true" />;
}

/**
 * Pulse segmented bar: lit segments Phosphor White, unlit segments dark, and a
 * leading segment more than 15% filled shown half-lit.
 */
export function SegmentBar({ value, segments = 16, className = '' }: { value: number; segments?: number; className?: string }) {
  const filled = Math.max(0, Math.min(1, value)) * segments;
  const full = Math.floor(filled);
  const partial = filled - full > 0.15;
  return (
    <span className={`seg-bar ${className}`} aria-hidden="true">
      {Array.from({ length: segments }, (_, i) => (
        <i key={i} className={i < full ? 'on' : i === full && partial ? 'mid' : undefined} />
      ))}
    </span>
  );
}

/** Faint CRT band sweeping down the parent (parent needs `relative`). */
export function Sweep() {
  return <span className="sweep" aria-hidden="true" />;
}

/** Eyebrow: scanner plus a small pixel label, as above every Pulse section. */
export function Eyebrow({ text }: { text: string }) {
  return (
    <span className="eyebrow">
      <Scanner />
      <PixelText text={text} dot={2} className="px-eye" />
    </span>
  );
}

/** The Pulse logo mark (app icon) plus the PULSE pixel wordmark. */
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand">
      <img src="/img/icon.png" width={28} height={28} alt="" className="brand-icon" />
      {!compact && <PixelText text="PULSE" dot={2.5} label="Pulse" />}
      {!compact && <Scanner className="brand-scan" />}
    </span>
  );
}
