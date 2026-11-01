import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { PixelIcon } from './PixelIcon';

interface SelectProps<T extends string> {
  value: T;
  options: { value: T; label: string; icon?: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
  /** Shown before the selected label, e.g. "Sort". */
  prefix?: string;
  align?: 'start' | 'end';
  className?: string;
}

/**
 * Pulse dropdown replacing native <select>: pixel-notched trigger, dotted-edge
 * menu that pops from its corner, inverted active row, full listbox keyboard support.
 */
export function Select<T extends string>({ value, options, onChange, label, prefix, align = 'start', className = '' }: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const current = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    const onDown = (e: MouseEvent) => !rootRef.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, options, value]);

  const choose = (i: number) => {
    const o = options[i];
    if (o) onChange(o.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(options.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className={`relative ${className}`} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}: ${current?.label}`}
        onClick={() => setOpen((v) => !v)}
        className={`pulse-btn pulse-btn-ghost pulse-btn-sm pulse-select ${open ? 'is-open' : ''}`}
      >
        {prefix && <span className="text-slate-400 font-normal">{prefix}</span>}
        {current?.icon}
        <span>{current?.label}</span>
        <PixelIcon name="chevronDown" size={7} className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={label}
          aria-activedescendant={`${listId}-${active}`}
          tabIndex={-1}
          className={`pulse-menu anim-pop absolute z-40 mt-1.5 min-w-full w-max ${align === 'end' ? 'right-0' : 'left-0 anim-pop-start'}`}
        >
          {options.map((o, i) => {
            const selected = o.value === value;
            return (
              <li
                key={o.value}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={selected}
                onMouseMove={() => active !== i && setActive(i)}
                onClick={() => choose(i)}
                className={`flex items-center gap-2.5 h-8 pl-2.5 pr-3 cursor-pointer text-[13px] transition-colors duration-100 ${
                  i === active ? 'bg-slate-50 text-slate-950' : 'text-slate-200'
                }`}
              >
                <span className="w-3 flex justify-center">{selected && <span className="w-1.5 h-1.5 bg-current" />}</span>
                {o.icon}
                <span>{o.label}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
