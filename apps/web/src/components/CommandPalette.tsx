import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CornerDownLeft, Search } from 'lucide-react';

export interface Command {
  id: string;
  label: string;
  group: 'Go to' | 'Actions' | 'Files' | 'Open tabs';
  icon?: ReactNode;
  hint?: string;
  keywords?: string;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}

const GROUP_ORDER: Command['group'][] = ['Open tabs', 'Go to', 'Actions', 'Files'];

/** Ranks a label against the query: prefix > word start > substring > in-order letters. */
function score(text: string, q: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 4;
  if (t.split(/[\s_.\-/]+/).some((w) => w.startsWith(q))) return 3;
  if (t.includes(q)) return 2;
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  return i === q.length ? 1 : 0;
}

/** Ctrl+K palette: jump to any place, run any action, open any file. */
export function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      restoreFocus.current = document.activeElement as HTMLElement | null;
      setQuery('');
      setIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      restoreFocus.current?.focus?.();
    }
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const ranked = commands
      .map((c) => ({ c, s: Math.max(score(c.label, q), c.keywords ? score(c.keywords, q) - 1 : 0) }))
      .filter((r) => r.s > 0);
    if (q) ranked.sort((a, b) => b.s - a.s);
    else ranked.sort((a, b) => GROUP_ORDER.indexOf(a.c.group) - GROUP_ORDER.indexOf(b.c.group));
    return ranked.slice(0, 40).map((r) => r.c);
  }, [commands, query]);

  useEffect(() => setIndex(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (!open) return null;

  const runAt = (i: number) => {
    const cmd = results[i];
    if (!cmd) return;
    onClose();
    cmd.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(index);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  let lastGroup: string | null = null;

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/60 flex items-start justify-center pt-[14vh] px-4 anim-fade"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-xl pulse-menu !p-0 overflow-hidden anim-pop-center"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2.5 px-4 h-12 border-b border-slate-800">
          <Search className="w-4 h-4 text-slate-400 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files, places and actions"
            aria-label="Search commands"
            aria-controls="command-results"
            aria-activedescendant={results[index] ? `cmd-${results[index].id}` : undefined}
            className="flex-1 bg-transparent text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
          />
          <kbd className="text-[10px] font-mono text-slate-400 border border-slate-700 rounded-sm px-1.5 py-0.5">Esc</kbd>
        </div>

        <div ref={listRef} id="command-results" role="listbox" className="max-h-[52vh] overflow-y-auto p-1.5 no-scrollbar">
          {results.length === 0 && <p className="px-3 py-8 text-center text-sm text-slate-400">Nothing matches “{query}”.</p>}
          {results.map((cmd, i) => {
            const header = cmd.group !== lastGroup ? cmd.group : null;
            lastGroup = cmd.group;
            const active = i === index;
            return (
              <div key={cmd.id}>
                {header && (
                  <div className="px-3 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{header}</div>
                )}
                <div
                  id={`cmd-${cmd.id}`}
                  role="option"
                  aria-selected={active}
                  data-index={i}
                  onMouseMove={() => index !== i && setIndex(i)}
                  onClick={() => runAt(i)}
                  className={`flex items-center gap-3 h-9 px-3 rounded cursor-pointer text-sm transition-colors duration-100 ${
                    active ? 'bg-slate-50 text-slate-950' : 'text-slate-200'
                  }`}
                >
                  <span className={`w-4 flex justify-center shrink-0 ${active ? '' : 'text-slate-400'}`}>{cmd.icon}</span>
                  <span className="flex-1 truncate">{cmd.label}</span>
                  {cmd.hint && (
                    <span className={`text-[11px] font-mono ${active ? 'text-slate-700' : 'text-slate-500'}`}>{cmd.hint}</span>
                  )}
                  {active && <CornerDownLeft className="w-3.5 h-3.5" />}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
