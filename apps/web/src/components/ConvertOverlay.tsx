import { useEffect, useMemo, useRef, useState } from 'react';
import { getTargets, LEVEL_LABELS, type ResolvedTarget } from '../converters/registry';
import { runConversion } from '../services/convertService';
import { useConvertStore } from '../stores/useConvertStore';

const RADIUS = 112;
const ZONE = 62;
const HIT = ZONE / 2 + 10;
const EDGE = RADIUS + ZONE / 2 + 12;

/** Fans the zones across an arc that faces the middle of the window so none land off-screen. */
function place(count: number, cx: number, cy: number): [number, number][] {
  const toward = Math.atan2(window.innerHeight / 2 - cy, window.innerWidth / 2 - cx);
  const centerAngle = Math.hypot(window.innerWidth / 2 - cx, window.innerHeight / 2 - cy) < 40 ? -Math.PI / 2 : toward;
  const arc = Math.min((Math.PI * 280) / 180, ((count - 1) * 50 * Math.PI) / 180);
  return Array.from({ length: count }, (_, i) => {
    const a = count === 1 ? centerAngle : centerAngle - arc / 2 + (arc * i) / (count - 1);
    return [Math.cos(a) * RADIUS, Math.sin(a) * RADIUS];
  });
}

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max));

/**
 * Long-press circle: targets fan out around the pressed file. Drag onto one and
 * release to convert. Release elsewhere to keep it open and tap or use arrow
 * keys instead; Esc or a tap outside closes it.
 */
export function ConvertOverlay() {
  const circle = useConvertStore((s) => s.circle);
  const level = useConvertStore((s) => s.level);
  const close = useConvertStore((s) => s.closeCircle);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [held, setHeld] = useState(false);
  const [shown, setShown] = useState(false);
  const moved = useRef(false);
  const panel = useRef<HTMLDivElement>(null);

  const file = circle?.file;
  const targets = useMemo(
    () => (file ? getTargets({ extension: file.extension, category: file.category }) : []),
    [file]
  );

  const center = useMemo(() => {
    if (!circle) return { x: 0, y: 0 };
    return { x: clamp(circle.x, EDGE, window.innerWidth - EDGE), y: clamp(circle.y, EDGE, window.innerHeight - EDGE) };
  }, [circle]);

  const offsets = useMemo(() => (circle ? place(targets.length, center.x, center.y) : []), [circle, targets.length, center]);

  useEffect(() => {
    setHeld(Boolean(circle?.held));
    setPointer(circle ? { x: circle.x, y: circle.y } : null);
    moved.current = false;
    setShown(false);
    if (!circle) return;
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, [circle]);

  const hovered = useMemo(() => {
    if (!pointer || !circle || !moved.current) return -1;
    let best = -1;
    let bestD = HIT;
    offsets.forEach(([dx, dy], i) => {
      const d = Math.hypot(pointer.x - (center.x + dx), pointer.y - (center.y + dy));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
    // `moved` is a ref read for the current pointer value.
  }, [pointer, circle, offsets, center]);

  const choose = (t: ResolvedTarget) => {
    if (!file) return;
    close();
    void runConversion(file, t);
  };

  // Track the finger or button that started the long press.
  useEffect(() => {
    if (!circle || !held) return;
    const origin = { x: circle.x, y: circle.y };
    const onMove = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > 10) moved.current = true;
      setPointer({ x: e.clientX, y: e.clientY });
    };
    const onUp = (e: PointerEvent) => {
      const x = e.clientX;
      const y = e.clientY;
      let hit = -1;
      if (moved.current) {
        let bestD = HIT;
        offsets.forEach(([dx, dy], i) => {
          const d = Math.hypot(x - (center.x + dx), y - (center.y + dy));
          if (d < bestD) {
            bestD = d;
            hit = i;
          }
        });
      }
      if (hit >= 0) choose(targets[hit]);
      else setHeld(false);
    };
    const onCancel = () => close();
    // Keep the page from scrolling under a finger that is dragging to a zone.
    const block = (e: TouchEvent) => e.cancelable && e.preventDefault();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('touchmove', block, { passive: false });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('touchmove', block);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circle, held, offsets, center, targets]);

  // Pinned mode: keyboard, Esc, focus management.
  useEffect(() => {
    if (!circle || held) return;
    const buttons = () => Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button[data-zone]') ?? []);
    buttons()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return close();
      if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
      e.preventDefault();
      const items = buttons();
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
      items[(i + step + items.length) % items.length]?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [circle, held, close]);

  useEffect(() => {
    if (!circle || !held) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [circle, held, close]);

  if (!circle || !file) return null;
  const active = hovered >= 0 ? targets[hovered] : null;

  return (
    <div
      className="fixed inset-0 z-[80] touch-none select-none"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}
      onPointerDown={(e) => !held && e.target === e.currentTarget && close()}
      role="presentation"
    >
      <div ref={panel} role="menu" aria-label={`Convert ${file.originalName}`} className="absolute inset-0 pointer-events-none">
        {/* Center disc */}
        <div
          className="absolute border border-slate-400 bg-slate-950 flex flex-col items-center justify-center text-center pointer-events-none"
          style={{
            width: 84,
            height: 84,
            borderRadius: '50%',
            left: center.x - 42,
            top: center.y - 42,
            transform: shown ? 'scale(1)' : 'scale(0.5)',
            opacity: shown ? 1 : 0,
            transition: 'transform 200ms cubic-bezier(.2,.9,.3,1.2), opacity 120ms',
            boxShadow: '0 0 0 6px rgba(255,255,255,0.06)',
          }}
        >
          <span className="font-mono text-[11px] uppercase text-slate-400 leading-none">{active ? 'to' : `.${file.extension}`}</span>
          <span className="font-mono text-[15px] font-semibold uppercase text-white leading-tight mt-1">
            {active ? (active.compress ? 'Shrink' : active.label) : 'Drag'}
          </span>
        </div>

        {targets.map((t, i) => {
          const [dx, dy] = offsets[i] ?? [0, 0];
          const on = hovered === i;
          return (
            <button
              key={t.id}
              type="button"
              role="menuitem"
              data-zone
              aria-label={t.compress ? `Compress, ${LEVEL_LABELS[level]}` : `Convert to ${t.label}`}
              disabled={held}
              onClick={() => choose(t)}
              className={`absolute font-mono text-[10px] uppercase font-semibold flex items-center justify-center text-center leading-tight focus-visible:outline-2 focus-visible:outline-white ${
                on ? 'bg-slate-50 text-slate-950 border border-slate-50' : 'bg-slate-900 text-slate-100 border border-slate-500 hover:bg-slate-700'
              } ${t.compress ? 'border-dashed' : ''}`}
              style={{
                width: ZONE,
                height: ZONE,
                borderRadius: '50%',
                left: center.x - ZONE / 2,
                top: center.y - ZONE / 2,
                transform: shown ? `translate(${dx}px, ${dy}px) scale(${on ? 1.14 : 1})` : 'translate(0,0) scale(0.3)',
                opacity: shown ? 1 : 0,
                transition: `transform 220ms cubic-bezier(.2,.9,.3,1.2) ${shown ? i * 18 : 0}ms, opacity 140ms, background-color 100ms`,
                pointerEvents: held ? 'none' : 'auto',
              }}
            >
              {t.label}
            </button>
          );
        })}

        {/* Caption */}
        <div
          className="absolute left-1/2 -translate-x-1/2 bottom-6 max-w-[min(92vw,420px)] text-center text-xs text-slate-300 px-3 py-2 rounded-lg border border-slate-700 bg-slate-950/90"
          aria-live="polite"
        >
          <div className="truncate text-slate-100 font-medium">{file.originalName}</div>
          <div className="text-slate-400 mt-0.5">
            {active
              ? active.note ?? (active.compress ? `Shrinks in the same format Â· ${LEVEL_LABELS[level]}` : `Saved next to the original as .${active.ext}`)
              : held
              ? 'Drag onto a format and let go'
              : 'Pick a format Â· Esc to close'}
          </div>
        </div>
      </div>
    </div>
  );
}
