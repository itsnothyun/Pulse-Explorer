import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { DetectedFile, FileCategory } from '@omniview/shared-types';

interface NewCollectionModalProps {
  open: boolean;
  files: DetectedFile[];
  existingNames: string[];
  getIcon: (category: FileCategory, className?: string) => React.ReactNode;
  onClose: () => void;
  onCreate: (name: string, fileIds: string[]) => void;
}

/** Name a collection and, optionally, pick the files that go in it right away. */
export function NewCollectionModal({ open, files, existingNames, getIcon, onClose, onCreate }: NewCollectionModalProps) {
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setQuery('');
    setPicked(new Set());
    requestAnimationFrame(() => nameRef.current?.focus());
  }, [open]);

  const live = useMemo(() => files.filter((f) => !f.isTrashed), [files]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? live.filter((f) => f.originalName.toLowerCase().includes(q)) : live;
  }, [live, query]);

  if (!open) return null;

  const trimmed = name.trim();
  const duplicate = existingNames.some((n) => n.toLowerCase() === trimmed.toLowerCase());
  const canCreate = trimmed.length > 0 && !duplicate;

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canCreate) return;
    onCreate(trimmed, Array.from(picked));
    onClose();
  };

  return (
    <div
      className="anim-fade fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-collection-title"
        onSubmit={submit}
        className="anim-pop-center w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 shadow-2xl flex flex-col max-h-[80vh]"
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-4">
          <h2 id="new-collection-title" className="text-sm font-semibold text-white">
            New collection
          </h2>
          <button type="button" onClick={onClose} className="icon-btn" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 space-y-1.5">
          <label htmlFor="collection-name" className="text-xs text-slate-400">
            Name
          </label>
          <input
            id="collection-name"
            ref={nameRef}
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Q4 review"
            maxLength={60}
            className="w-full h-10 rounded-md bg-slate-950 border border-slate-700 px-3 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-slate-300"
          />
          <p className={`text-[11px] h-4 ${duplicate ? 'text-slate-100' : 'text-transparent'}`} aria-live="polite">
            {duplicate ? 'A collection with this name already exists.' : '.'}
          </p>
        </div>

        <div className="px-5 pt-2 flex items-center justify-between">
          <span className="text-xs text-slate-400">Add files (optional)</span>
          {picked.size > 0 && <span className="text-[11px] font-mono tabular-nums text-slate-300">{picked.size} selected</span>}
        </div>
        <div className="px-5 pt-2">
          <div className="flex items-center gap-2 h-8 px-2.5 rounded-md border border-slate-800 focus-within:border-slate-500">
            <Search className="w-3.5 h-3.5 text-slate-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter files"
              aria-label="Filter files"
              className="flex-1 bg-transparent text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none"
            />
          </div>
        </div>
        <ul className="mx-5 mt-2 mb-1 overflow-y-auto min-h-0 flex-1 border-y border-slate-800 py-1" aria-label="Files">
          {shown.length === 0 && <li className="py-6 text-center text-xs text-slate-500">No files match.</li>}
          {shown.map((f) => {
            const checked = picked.has(f.id);
            return (
              <li key={f.id}>
                <label className="flex items-center gap-2.5 px-2 py-1.5 rounded cursor-pointer text-xs text-slate-300 hover:bg-slate-800/50">
                  <input type="checkbox" checked={checked} onChange={() => toggle(f.id)} className="sr-only peer" />
                  <span
                    aria-hidden="true"
                    className={`w-3.5 h-3.5 shrink-0 border rounded-[2px] grid place-items-center transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-slate-50 ${
                      checked ? 'bg-slate-50 border-slate-50' : 'border-slate-600'
                    }`}
                  >
                    {checked && <span className="w-1.5 h-1.5 bg-slate-950" />}
                  </span>
                  <span className="text-slate-400">{getIcon(f.category, 'w-3.5 h-3.5')}</span>
                  <span className="truncate">{f.originalName}</span>
                </label>
              </li>
            );
          })}
        </ul>

        <div className="flex justify-end gap-2 px-5 py-4">
          <button type="button" onClick={onClose} className="pulse-btn pulse-btn-ghost h-9">
            Cancel
          </button>
          <button type="submit" disabled={!canCreate} className="pulse-btn h-9 disabled:opacity-40 disabled:pointer-events-none">
            Create{picked.size > 0 ? ` with ${picked.size}` : ''}
          </button>
        </div>
      </form>
    </div>
  );
}
