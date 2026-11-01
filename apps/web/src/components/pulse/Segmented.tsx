import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

interface SegmentedProps<T extends string> {
  value: T;
  options: { value: T; label: string; icon?: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
  /** Render as tabs (role=tablist) instead of a toggle group. */
  asTabs?: boolean;
  className?: string;
}

/** Pulse segmented control; the phosphor thumb slides to the active option. */
export function Segmented<T extends string>({ value, options, onChange, label, asTabs = false, className = '' }: SegmentedProps<T>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const btn = root?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(value)}"]`);
    if (!root || !btn) return;
    const measure = () => setThumb({ x: btn.offsetLeft - 3, w: btn.offsetWidth });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [value, options.length]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    const next = options[(i + (e.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length];
    onChange(next.value);
    rootRef.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus();
  };

  return (
    <div
      ref={rootRef}
      role={asTabs ? 'tablist' : 'group'}
      aria-label={label}
      onKeyDown={onKeyDown}
      className={`pulse-seg ${className}`}
    >
      {thumb && (
        <span
          className="pulse-seg-thumb"
          aria-hidden="true"
          style={{ width: thumb.w, transform: `translateX(${thumb.x}px)` }}
        />
      )}
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            data-value={o.value}
            role={asTabs ? 'tab' : undefined}
            aria-selected={asTabs ? active : undefined}
            aria-pressed={asTabs ? undefined : active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
