import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Download, ExternalLink, Eye, Folder, Pencil, Star, Trash2, Columns } from 'lucide-react';
import type { DetectedFile, WorkspaceFolder } from '@omniview/shared-types';

export interface FileMenuState {
  file: DetectedFile;
  x: number;
  y: number;
}

interface FileContextMenuProps {
  state: FileMenuState | null;
  folders: WorkspaceFolder[];
  canCompare: boolean;
  onClose: () => void;
  onOpen: (file: DetectedFile) => void;
  onQuickView: (file: DetectedFile) => void;
  onCompare: (file: DetectedFile) => void;
  onToggleFavorite: (file: DetectedFile) => void;
  onRename: (file: DetectedFile, name: string) => void;
  onMove: (file: DetectedFile, folderId: string | null) => void;
  onDownload: (file: DetectedFile) => void;
  onTrash: (file: DetectedFile) => void;
}

/** Right-click menu for any file in the library or dashboard. */
export function FileContextMenu(props: FileContextMenuProps) {
  const { state, folders, canCompare, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');

  useEffect(() => {
    setRenaming(false);
    if (state) setName(state.file.originalName);
  }, [state]);

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    if (!state || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(state.x, window.innerWidth - r.width - 8),
      y: Math.min(state.y, window.innerHeight - r.height - 8),
    });
    ref.current.querySelector<HTMLElement>('button')?.focus();
  }, [state, renaming]);

  useEffect(() => {
    if (!state) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('blur', onClose);
    };
  }, [state, onClose]);

  if (!state) return null;
  const { file } = state;
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`Actions for ${file.originalName}`}
      onKeyDown={onKeyDown}
      className="pulse-menu fixed z-[70] w-60 anim-pop anim-pop-start"
      style={{ left: pos.x || state.x, top: pos.y || state.y }}
    >
      <div className="px-3 pt-1.5 pb-2 text-[11px] text-slate-400 truncate">{file.originalName}</div>
      {renaming ? (
        <form
          className="px-1.5 pb-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) props.onRename(file, name.trim());
            onClose();
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.currentTarget.setSelectionRange(0, name.lastIndexOf('.') > 0 ? name.lastIndexOf('.') : name.length)}
            aria-label="New file name"
            className="w-full rounded bg-transparent border border-slate-600 px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-slate-300"
          />
        </form>
      ) : (
        <>
          <button role="menuitem" onClick={act(() => props.onOpen(file))} className="gap-2.5">
            <ExternalLink className="w-3.5 h-3.5" /> Open
          </button>
          <button role="menuitem" onClick={act(() => props.onQuickView(file))} className="gap-2.5">
            <Eye className="w-3.5 h-3.5" /> Quick view
            <kbd className="pulse-kbd ml-auto">Space</kbd>
          </button>
          {canCompare && (
            <button role="menuitem" onClick={act(() => props.onCompare(file))} className="gap-2.5">
              <Columns className="w-3.5 h-3.5" /> Open side by side
            </button>
          )}
          <button role="menuitem" onClick={act(() => props.onToggleFavorite(file))} className="gap-2.5">
            <Star className={`w-3.5 h-3.5 ${file.isFavorite ? 'fill-current' : ''}`} />
            {file.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          </button>
          <button role="menuitem" onClick={() => setRenaming(true)} className="gap-2.5">
            <Pencil className="w-3.5 h-3.5" /> Rename
          </button>
          {folders.length > 0 && <div className="pulse-rule-dotted my-1.5 mx-2" />}
          {folders.map((f) => (
            <button
              key={f.id}
              role="menuitemcheckbox"
              aria-checked={file.folderId === f.id}
              onClick={act(() => props.onMove(file, file.folderId === f.id ? null : f.id))}
              className="gap-2.5"
            >
              {file.folderId === f.id ? <span className="w-3.5 flex justify-center"><span className="w-2 h-2 bg-current" /></span> : <Folder className="w-3.5 h-3.5" />}
              <span className="truncate">{f.name}</span>
            </button>
          ))}
          <div className="pulse-rule-dotted my-1.5 mx-2" />
          <button role="menuitem" onClick={act(() => props.onDownload(file))} className="gap-2.5">
            <Download className="w-3.5 h-3.5" /> Download original
          </button>
          <button role="menuitem" onClick={act(() => props.onTrash(file))} className="gap-2.5">
            <Trash2 className="w-3.5 h-3.5" /> Move to trash
          </button>
        </>
      )}
    </div>
  );
}
