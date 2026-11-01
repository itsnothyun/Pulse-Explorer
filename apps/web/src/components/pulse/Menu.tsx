import { useEffect, useRef, useState, type ReactNode } from 'react';

interface MenuItem {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  checked?: boolean;
  disabled?: boolean;
}

interface MenuProps {
  /** Accessible label and tooltip for the trigger. */
  label: string;
  trigger: ReactNode;
  items: (MenuItem | 'divider')[];
  align?: 'start' | 'end';
  /** Open below the trigger (default) or above it, e.g. from a footer. */
  placement?: 'bottom' | 'top';
  triggerClassName?: string;
}

/** Pulse context menu: dotted edge, inverting items, arrow keys and Escape. */
export function Menu({ label, trigger, items, align = 'end', placement = 'bottom', triggerClassName = '' }: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    listRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={triggerClassName || 'icon-btn'}
      >
        {trigger}
      </button>
      {open && (
        <div
          ref={listRef}
          role="menu"
          className={`pulse-menu anim-pop absolute z-40 min-w-[200px] ${placement === 'top' ? 'bottom-full mb-1.5 anim-pop-up' : 'mt-1.5'} ${align === 'end' ? 'right-0' : 'left-0 anim-pop-start'}`}
        >
          {items.map((item, i) =>
            item === 'divider' ? (
              <div key={`d${i}`} className="pulse-rule-dotted my-1.5 mx-2" />
            ) : (
              <button
                key={item.label}
                type="button"
                role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={item.checked}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className="gap-2.5 disabled:text-slate-400 disabled:pointer-events-none"
              >
                <span className="w-3.5 flex justify-center shrink-0">
                  {item.checked ? <span className="w-2 h-2 bg-current" /> : item.icon}
                </span>
                <span className="truncate">{item.label}</span>
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
