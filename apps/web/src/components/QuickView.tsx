import { useEffect, useMemo, useRef, useState } from 'react';
import type { DetectedFile } from '@omniview/shared-types';
import { formatFileSize } from '@omniview/utilities';
import { useWorkspaceStore, viewerRegistry } from '../stores/useWorkspaceStore';
import { ViewerHost } from './viewers/ViewerHost';
import { isDesktop, openWithOtherApp, revealInExplorer, startWindowDrag } from '../services/desktopBridge';
import { PixelIcon, categoryGlyph } from './pulse/PixelIcon';
import { Scanner, SegmentBar, Sweep } from './pulse/Pixel';
import { PixelGlyph, WindowControls } from './pulse/WindowControls';

type AppWindow = import('@tauri-apps/api/window').Window;

const GLYPH = {
  copy: [120, 72, 95, 113, 17, 17, 31],
  pin: [28, 28, 28, 62, 8, 8, 8],
  fullscreen: [99, 65, 0, 0, 0, 65, 99],
  exitFullscreen: [34, 99, 0, 0, 0, 99, 34],
};

interface QuickViewProps {
  /** File ids to flip through; the first is shown first. */
  queue: string[];
  onClose: () => void;
  onOpenInWorkspace: (fileId: string) => void;
  onDownload: (file: DetectedFile) => void;
  /** Rendered as its own desktop window instead of an overlay. */
  standalone?: boolean;
  /** Where the file lives on disk, when it came from File Explorer. */
  pathOf?: (fileId: string) => string | undefined;
}

/**
 * Quick View: a floating Pulse panel for files opened from File Explorer (or
 * Space in the library). Uses a hidden tab so the workspace behind is untouched.
 */
export function QuickView({ queue, onClose, onOpenInWorkspace, onDownload, standalone = false, pathOf }: QuickViewProps) {
  const [index, setIndex] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [win, setWin] = useState<AppWindow | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  const panelRef = useRef<HTMLDivElement>(null);
  const wantedFile = useRef<string | undefined>(undefined);
  const restoreFocus = useRef<HTMLElement | null>(null);

  const openQuickView = useWorkspaceStore((s) => s.openQuickView);
  const closeQuickView = useWorkspaceStore((s) => s.closeQuickView);
  const updateTabState = useWorkspaceStore((s) => s.updateTabState);
  const fileId = queue[Math.min(index, queue.length - 1)];
  const file = useWorkspaceStore((s) => s.files.find((f) => f.id === fileId));
  const tabId = fileId ? `qv-${fileId}` : null;
  const tab = useWorkspaceStore((s) => (tabId ? s.tabs.find((t) => t.tabId === tabId) : undefined));
  const buffer = useWorkspaceStore((s) => (fileId ? s.fileBuffers[fileId] : undefined));
  const document = useWorkspaceStore((s) => (fileId ? s.loadedDocuments[fileId] : undefined));

  // Reset to the first file whenever a new batch arrives.
  useEffect(() => setIndex(0), [queue]);

  // Open the current file in a hidden tab (id `qv-<file>`); close it when moving on.
  // A load that finishes after we've moved to another file is closed right away.
  useEffect(() => {
    if (!fileId) return;
    wantedFile.current = fileId;
    void openQuickView(fileId).then((id) => {
      if (id && wantedFile.current !== fileId) closeQuickView(id);
    });
    return () => {
      wantedFile.current = undefined;
      // No-op if "Open in workspace" already promoted it to a normal tab.
      closeQuickView(`qv-${fileId}`);
    };
  }, [fileId, openQuickView, closeQuickView]);

  useEffect(() => {
    restoreFocus.current = window.document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => panelRef.current?.focus());
    return () => restoreFocus.current?.focus?.();
  }, []);

  const caps = useMemo(() => (file ? viewerRegistry.resolve(file).getCapabilities(file) : null), [file]);
  const paged = Boolean(tab && tab.totalPages > 1);

  // Standalone window: track fullscreen (it also changes on F11 / OS gestures).
  useEffect(() => {
    if (!standalone || !isDesktop()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const w = getCurrentWindow();
      if (cancelled) return;
      setWin(w);
      setFullscreen(await w.isFullscreen());
      unlisten = await w.onResized(async () => setFullscreen(await w.isFullscreen()));
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [standalone]);

  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  const path = file && pathOf ? pathOf(file.id) : undefined;
  const folder = path ? path.slice(0, Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))) : undefined;

  const flash = (text: string) => {
    setNotice(text);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2200);
  };
  const run = (action: Promise<unknown>, done?: string) =>
    action.then(
      () => done && flash(done),
      (e) => flash(String(e))
    );

  const toggleFullscreen = () => win && run(win.setFullscreen(!fullscreen).then(() => setFullscreen(!fullscreen)));
  const togglePin = () => win && run(win.setAlwaysOnTop(!pinned).then(() => setPinned(!pinned)), pinned ? 'Unpinned' : 'Pinned on top');
  const copyPath = () => path && run(navigator.clipboard.writeText(path), 'Path copied');
  const reveal = () => path && run(revealInExplorer(path));
  const openWith = () => path && run(openWithOtherApp(path));

  const close = () => {
    setLeaving(true);
    window.setTimeout(onClose, 160);
  };
  const keep = () => file && onOpenInWorkspace(file.id);
  const go = (delta: number) => setIndex((i) => (i + delta + queue.length) % queue.length);
  const page = (delta: number) =>
    tab && updateTabState(tab.tabId, { currentPage: Math.min(tab.totalPages, Math.max(1, tab.currentPage + delta)) });
  const zoom = (next: number) => tab && updateTabState(tab.tabId, { zoom: Math.min(300, Math.max(40, next)) });

  // Keys are handled here and never reach the workspace behind.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest('input, textarea, [contenteditable="true"]');
      const mod = e.ctrlKey || e.metaKey;
      let handled = true;
      if (e.key === 'Escape' && fullscreen) toggleFullscreen();
      else if (e.key === 'Escape') close();
      else if (e.key === 'F11' && win) toggleFullscreen();
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'c' && path) copyPath();
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'e' && path) reveal();
      else if (mod && e.shiftKey && e.key.toLowerCase() === 't' && win) togglePin();
      else if (e.key === 'Enter' && !typing) keep();
      else if (!typing && e.key === 'ArrowRight' && paged) page(1);
      else if (!typing && e.key === 'ArrowLeft' && paged) page(-1);
      else if (!typing && e.key === ']' && queue.length > 1) go(1);
      else if (!typing && e.key === '[' && queue.length > 1) go(-1);
      else if (mod && (e.key === '=' || e.key === '+') && tab) zoom(tab.zoom + 15);
      else if (mod && e.key === '-' && tab) zoom(tab.zoom - 15);
      else if (mod && e.key === '0' && tab) zoom(100);
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  if (!file) return null;

  return (
    <div
      className={`${standalone ? 'qv-standalone' : 'qv-backdrop'} fixed inset-0 z-[80] flex items-center justify-center ${standalone ? '' : 'p-3 sm:p-6'} ${leaving ? 'qv-leaving' : ''}`}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      {queue.length > 1 && !standalone && (
        <button className="qv-side qv-side-left" onClick={() => go(-1)} aria-label="Previous file" title="Previous file ([)">
          <PixelIcon name="chevronRight" size={14} className="rotate-180" />
        </button>
      )}

      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Quick View: ${file.originalName}`}
        className={`qv-panel relative flex flex-col w-full h-full focus:outline-none ${standalone ? '' : 'max-w-[1280px] max-h-[920px]'}`}
      >
        <Sweep />

        {/* Title bar */}
        <header
          onMouseDown={standalone && !fullscreen ? (e) => startWindowDrag(e, true) : undefined}
          className={`relative z-10 flex items-center gap-3 h-14 pl-4 border-b border-slate-800 shrink-0 ${standalone ? 'pr-0 cursor-default select-none' : 'pr-4'}`}
        >
          <span className="qv-glyph">
            <PixelIcon name={categoryGlyph(file.category)} size={14} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <h2 className="truncate text-sm font-semibold text-white">{file.originalName}</h2>
              <Scanner />
            </div>
            <div className="text-[11px] text-slate-400 font-mono tabular-nums">
              {file.extension.toUpperCase()} · {formatFileSize(file.sizeBytes)}
              {paged && tab ? ` · ${tab.currentPage} / ${tab.totalPages}` : ''}
              {queue.length > 1 ? ` · file ${index + 1} of ${queue.length}` : ''}
            </div>
          </div>

          {paged && tab && (
            <div className="hidden md:flex items-center gap-0.5">
              <button className="icon-btn" onClick={() => page(-1)} disabled={tab.currentPage <= 1} aria-label="Previous page">
                <PixelIcon name="chevronRight" size={7} className="rotate-180" />
              </button>
              <span className="w-14 text-center text-xs font-mono tabular-nums text-slate-200">
                {tab.currentPage} / {tab.totalPages}
              </span>
              <button className="icon-btn" onClick={() => page(1)} disabled={tab.currentPage >= tab.totalPages} aria-label="Next page">
                <PixelIcon name="chevronRight" size={7} />
              </button>
            </div>
          )}

          {caps?.zoom && tab && (
            <div className="hidden md:flex items-center gap-0.5 pl-2 ml-1 border-l border-slate-800">
              <button className="icon-btn" onClick={() => zoom(tab.zoom - 15)} aria-label="Zoom out">
                <span className="font-mono text-sm leading-none">−</span>
              </button>
              <button className="w-12 h-7 text-xs font-mono tabular-nums text-slate-200 hover:text-white" onClick={() => zoom(100)} title="Reset zoom">
                {tab.zoom}%
              </button>
              <button className="icon-btn" onClick={() => zoom(tab.zoom + 15)} aria-label="Zoom in">
                <span className="font-mono text-sm leading-none">+</span>
              </button>
            </div>
          )}

          {standalone && queue.length > 1 && (
            <div className="flex items-center gap-0.5 pl-2 ml-1 border-l border-slate-800">
              <button className="icon-btn" onClick={() => go(-1)} aria-label="Previous file" title="Previous file ([)">
                <PixelIcon name="chevronRight" size={7} className="rotate-180" />
              </button>
              <span className="text-[11px] font-mono tabular-nums text-slate-300 w-10 text-center">
                {index + 1}/{queue.length}
              </span>
              <button className="icon-btn" onClick={() => go(1)} aria-label="Next file" title="Next file (])">
                <PixelIcon name="chevronRight" size={7} />
              </button>
            </div>
          )}

          <div className="flex items-center gap-0.5 pl-2 ml-1 border-l border-slate-800">
            {path && (
              <span className="hidden sm:flex items-center gap-0.5">
                <button className="icon-btn" onClick={copyPath} title="Copy path (Ctrl+Shift+C)" aria-label="Copy path">
                  <PixelGlyph rows={GLYPH.copy} />
                </button>
                <button className="icon-btn" onClick={reveal} title="Show in File Explorer (Ctrl+Shift+E)" aria-label="Show in File Explorer">
                  <PixelIcon name="folder" size={14} />
                </button>
                <button className="icon-btn" onClick={openWith} title="Open with another app" aria-label="Open with another app">
                  <PixelIcon name="open" size={14} />
                </button>
              </span>
            )}
            {caps?.download !== false && (
              <button className="icon-btn" onClick={() => onDownload(file)} title="Save a copy" aria-label="Save a copy">
                <PixelIcon name="download" size={14} />
              </button>
            )}
            <button
              className="icon-btn"
              onClick={keep}
              title="Open in workspace (Enter)"
              aria-label="Open in workspace"
              data-testid="quickview-open-workspace"
            >
              <PixelIcon name="library" size={14} />
            </button>
          </div>

          {standalone && win ? (
            <>
              <div className="flex items-center gap-0.5 pl-2 border-l border-slate-800">
                <button
                  className={`icon-btn ${pinned ? 'text-white bg-white/10' : ''}`}
                  onClick={togglePin}
                  aria-pressed={pinned}
                  title={`${pinned ? 'Unpin' : 'Keep on top'} (Ctrl+Shift+T)`}
                  aria-label="Keep on top"
                >
                  <PixelGlyph rows={GLYPH.pin} />
                </button>
                <button
                  className="icon-btn"
                  onClick={toggleFullscreen}
                  title={`${fullscreen ? 'Exit full screen' : 'Full screen'} (F11)`}
                  aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
                >
                  <PixelGlyph rows={fullscreen ? GLYPH.exitFullscreen : GLYPH.fullscreen} />
                </button>
              </div>
              {!fullscreen && <WindowControls onClose={close} />}
              {fullscreen && (
                <button className="icon-btn mr-3" onClick={close} aria-label="Close Quick View" title="Close" data-testid="quickview-close">
                  <PixelIcon name="close" size={10} />
                </button>
              )}
            </>
          ) : (
            <button className="icon-btn" onClick={close} aria-label="Close Quick View" title="Close (Esc)" data-testid="quickview-close">
              <PixelIcon name="close" size={10} />
            </button>
          )}
        </header>

        {/* Document */}
        <div key={file.id} className="qv-body relative z-10 flex-1 min-h-0 overflow-hidden anim-fade-up">
          {tab ? (
            <ViewerHost file={file} tab={tab} buffer={buffer} document={document} />
          ) : (
            <div className="h-full flex items-center justify-center">
              <span className="px-spinner" role="status" aria-label="Loading">
                <i /><i /><i /><i /><i /><i /><i /><i /><i />
              </span>
            </div>
          )}
        </div>

        {/* Footer: progress + key hints */}
        <footer className="relative z-10 flex items-center gap-4 h-10 px-4 border-t border-slate-800 shrink-0 text-[11px] text-slate-400">
          {paged && tab && <SegmentBar value={tab.currentPage / tab.totalPages} segments={32} className="w-40 shrink-0" />}
          {notice ? (
            <span className="flex items-center gap-2 text-slate-200" role="status">
              <PixelIcon name="check" size={7} /> {notice}
            </span>
          ) : folder ? (
            <button className="flex min-w-0 items-center gap-2 hover:text-slate-200" onClick={reveal} title="Show in File Explorer">
              <PixelIcon name="folder" size={7} />
              <span className="truncate font-mono">{folder}</span>
            </button>
          ) : (
            !paged && (
              <span className="flex items-center gap-2">
                <PixelIcon name="device" size={7} /> Opened read-only from this device
              </span>
            )
          )}
          <span className="ml-auto hidden md:flex items-center gap-3">
            {paged && <span className="flex items-center gap-1.5"><kbd className="pulse-kbd">←</kbd><kbd className="pulse-kbd">→</kbd> pages</span>}
            {queue.length > 1 && <span className="flex items-center gap-1.5"><kbd className="pulse-kbd">[</kbd><kbd className="pulse-kbd">]</kbd> files</span>}
            {win && <span className="flex items-center gap-1.5"><kbd className="pulse-kbd">F11</kbd> full screen</span>}
            <span className="flex items-center gap-1.5"><kbd className="pulse-kbd">Esc</kbd> {fullscreen ? 'exit full screen' : 'close'}</span>
          </span>
        </footer>
      </div>

      {queue.length > 1 && !standalone && (
        <button className="qv-side qv-side-right" onClick={() => go(1)} aria-label="Next file" title="Next file (])">
          <PixelIcon name="chevronRight" size={14} />
        </button>
      )}
    </div>
  );
}
