import { useEffect, useRef, useState, type RefObject } from 'react';

export const HOUSE_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';

export const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  (document.documentElement.classList.contains('reduce-motion') ||
    Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches));

/**
 * Plays a short fade-and-rise on the element whenever `key` changes, without
 * remounting its children (so a PDF does not re-render just to animate).
 */
export function useEnterOnChange(ref: RefObject<HTMLElement | null>, key: unknown) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = ref.current;
    if (!el || prefersReducedMotion() || typeof el.animate !== 'function') return;
    el.animate(
      [
        { opacity: 0, transform: 'translateY(4px)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 220, easing: HOUSE_EASE }
    );
  }, [ref, key]);
}

/** Counts up to `target` over `duration` ms with the house ease (Pulse's weekly-total count-up). */
export function useCountUp(target: number, duration = 900): number {
  const [value, setValue] = useState(() => (prefersReducedMotion() ? target : 0));
  const fromRef = useRef(value);

  useEffect(() => {
    if (prefersReducedMotion()) {
      setValue(target);
      return;
    }
    const from = fromRef.current;
    if (from === target) return;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // ease-out-expo approximates the house curve
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      const next = from + (target - from) * eased;
      fromRef.current = next;
      setValue(next);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return value;
}
