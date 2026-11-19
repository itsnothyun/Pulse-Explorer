import { useEffect, useMemo, useRef, useState } from 'react';
import type { DetectedFile } from '@omniview/shared-types';
import { formatFileSize } from '@omniview/utilities';
import { useWorkspaceStore, viewerRegistry } from '../stores/useWorkspaceStore';
import { ViewerHost } from './viewers/ViewerHost';
import { isDesktop, openFileManager, openWithOtherApp, revealInExplorer, startWindowDrag } from '../services/desktopBridge';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Download,
  FolderOpen,
  HardDrive,
  Library,
  Maximize2,
  Minimize2,
  Pin,
  PinOff,
  SquareArrowOutUpRight,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { categoryIcon } from './explorerIcons';
import { Scanner, SegmentBar } from './pulse/Pixel';
import { WindowControls } from './pulse/WindowControls';

type AppWindow = import('@tauri-apps/api/window').Window;

/** Lucide, as the file manager draws it: 16 px for actions, 14 px in small controls. */
const ICON = { size: 16, strokeWidth: 1.75 } as const;
const SMALL = { size: 14, strokeWidth: 1.75 } as const;

interface QuickViewProps {
  /** File ids to flip through; the first is shown first. */
  queue: string[];
  onClose: () => void;
  /** The in-app Quick View hands the file to the workspace; the desktop window has none. */
  onOpenInWorkspace?: (fileId: string) => void;
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
  // the desktop window shows the folder in Pulse's file manager (apps/files), the in-app one in Windows' Explorer
  const reveal = () => path && run(standalone ? openFileManager(path) : revealInExplorer(path));
  const openWith = () => path && run(openWithOtherApp(path));

  const close = () => {
    setLeaving(true);
    window.setTimeout(onClose, 160);
  };
  const keep = () => file && onOpenInWorkspace?.(file.id);
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
      else if (e.key === 'Enter' && !typing && onOpenInWorkspace) keep();
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
  const KindIcon = categoryIcon(file.category);

  // The desktop window is drawn like a window of the file manager (apps/files): a tab in the title bar,
  // a command bar, the document in a rounded content pane and a status bar, on the same monochrome glass.
  if (standalone) {
    return (
      <div className={`qv-standalone rf-window fixed inset-0 z-[80] ${leaving ? 'qv-leaving' : ''}`}>
        <div
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label={`Quick View: ${file.originalName}`}
          className="qv-panel relative flex flex-col w-full h-full focus:outline-none"
        >
          {/* Title bar: the file as a tab, like the file manager's tabs */}
          <header
            onMouseDown={!fullscreen ? (e) => startWindowDrag(e, true) : undefined}
            className="rf-titlebar flex items-center shrink-0 select-none"
          >
            <div className="rf-tab" title={path ?? file.originalName}>
              <KindIcon {...ICON} />
              <span className="truncate">{file.originalName}</span>
              <button className="rf-tab-close" onClick={close} aria-label="Close Quick View" title="Close (Esc)" data-testid="quickview-close">
                <X size={14} strokeWidth={1.75} />
              </button>
            </div>
            <div className="flex-1" />
            {win && !fullscreen && <WindowControls onClose={close} lucide />}
          </header>

          {/* Command bar */}
          <div className="rf-commandbar flex items-center shrink-0">
            {queue.length > 1 && (
              <>
                <button className="rf-cmd" onClick={() => go(-1)} aria-label="Previous file" title="Previous file ([)">
                  <ChevronLeft {...ICON} />
                </button>
                <button className="rf-cmd" onClick={() => go(1)} aria-label="Next file" title="Next file (])">
                  <ChevronRight {...ICON} />
                </button>
                <span className="rf-cmd-text">{index + 1} of {queue.length}</span>
                <span className="rf-cmd-sep" />
              </>
            )}
            {path && (
              <>
                <button className="rf-cmd" onClick={copyPath} title="Copy path (Ctrl+Shift+C)" aria-label="Copy path">
                  <ClipboardCopy {...ICON} />
                </button>
                <button className="rf-cmd" onClick={reveal} title="Show in folder (Ctrl+Shift+E)" aria-label="Show in folder">
                  <FolderOpen {...ICON} />
                </button>
                <button className="rf-cmd" onClick={openWith} title="Open with another app" aria-label="Open with another app">
                  <SquareArrowOutUpRight {...ICON} />
                </button>
              </>
            )}
            {caps?.download !== false && (
              <button className="rf-cmd" onClick={() => onDownload(file)} title="Save a copy" aria-label="Save a copy">
                <Download {...ICON} />
              </button>
            )}
            <div className="flex-1" />
            {paged && tab && (
              <>
                <button className="rf-cmd" onClick={() => page(-1)} disabled={tab.currentPage <= 1} aria-label="Previous page">
                  <ChevronLeft {...ICON} />
                </button>
                <span className="rf-cmd-text tabular-nums">
                  {tab.currentPage} / {tab.totalPages}
                </span>
                <button className="rf-cmd" onClick={() => page(1)} disabled={tab.currentPage >= tab.totalPages} aria-label="Next page">
                  <ChevronRight {...ICON} />
                </button>
                <span className="rf-cmd-sep" />
              </>
            )}
            {caps?.zoom && tab && (
              <>
                <button className="rf-cmd" onClick={() => zoom(tab.zoom - 15)} aria-label="Zoom out">
                  <ZoomOut {...ICON} />
                </button>
                <button className="rf-cmd rf-cmd-wide tabular-nums" onClick={() => zoom(100)} title="Reset zoom">
                  {tab.zoom}%
                </button>
                <button className="rf-cmd" onClick={() => zoom(tab.zoom + 15)} aria-label="Zoom in">
                  <ZoomIn {...ICON} />
                </button>
                <span className="rf-cmd-sep" />
              </>
            )}
            {win && (
              <>
                <button
                  className={`rf-cmd ${pinned ? 'rf-cmd-on' : ''}`}
                  onClick={togglePin}
                  aria-pressed={pinned}
                  title={`${pinned ? 'Unpin' : 'Keep on top'} (Ctrl+Shift+T)`}
                  aria-label="Keep on top"
                >
                  {pinned ? <PinOff {...ICON} /> : <Pin {...ICON} />}
                </button>
                <button
                  className="rf-cmd"
                  onClick={toggleFullscreen}
                  title={`${fullscreen ? 'Exit full screen' : 'Full screen'} (F11)`}
                  aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
                >
                  {fullscreen ? <Minimize2 {...ICON} /> : <Maximize2 {...ICON} />}
                </button>
              </>
            )}
          </div>

          {/* The document, in the file manager's rounded content pane */}
          <div key={file.id} className="rf-content qv-body relative flex-1 min-h-0 overflow-hidden anim-fade-up">
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

          {/* Status bar, like the file manager's */}
          <footer className="rf-status flex items-center shrink-0">
            {notice ? (
              <span className="flex items-center gap-1.5 rf-status-on" role="status">
                <Check {...SMALL} /> {notice}
              </span>
            ) : (
              <>
                <span>{file.extension.toUpperCase()}</span>
                <span>{formatFileSize(file.sizeBytes)}</span>
                {paged && tab && <span>Page {tab.currentPage} of {tab.totalPages}</span>}
                {folder && (
                  <button className="rf-status-path truncate" onClick={reveal} title="Show in folder">
                    {folder}
                  </button>
                )}
              </>
            )}
            <span className="ml-auto hidden md:flex items-center gap-3">
              {paged && <span>← → pages</span>}
              {queue.length > 1 && <span>[ ] files</span>}
              <span>Esc {fullscreen ? 'exit full screen' : 'close'}</span>
            </span>
          </footer>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${standalone ? 'qv-standalone' : 'qv-backdrop'} fixed inset-0 z-[80] flex items-center justify-center ${standalone ? '' : 'p-3 sm:p-6'} ${leaving ? 'qv-leaving' : ''}`}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      {queue.length > 1 && !standalone && (
        <button className="qv-side qv-side-left" onClick={() => go(-1)} aria-label="Previous file" title="Previous file ([)">
          <ChevronLeft {...ICON} />
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
        {/* Title bar */}
        <header
          onMouseDown={standalone && !fullscreen ? (e) => startWindowDrag(e, true) : undefined}
          className={`relative z-10 flex items-center gap-3 h-14 pl-4 border-b border-slate-800 shrink-0 ${standalone ? 'pr-0 cursor-default select-none' : 'pr-4'}`}
        >
          <span className="qv-glyph">
            <KindIcon {...ICON} />
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
                <ChevronLeft {...SMALL} />
              </button>
              <span className="w-14 text-center text-xs font-mono tabular-nums text-slate-200">
                {tab.currentPage} / {tab.totalPages}
              </span>
              <button className="icon-btn" onClick={() => page(1)} disabled={tab.currentPage >= tab.totalPages} aria-label="Next page">
                <ChevronRight {...SMALL} />
              </button>
            </div>
          )}

          {caps?.zoom && tab && (
            <div className="hidden md:flex items-center gap-0.5 pl-2 ml-1 border-l border-slate-800">
              <button className="icon-btn" onClick={() => zoom(tab.zoom - 15)} aria-label="Zoom out">
                <ZoomOut {...SMALL} />
              </button>
              <button className="w-12 h-7 text-xs font-mono tabular-nums text-slate-200 hover:text-white" onClick={() => zoom(100)} title="Reset zoom">
                {tab.zoom}%
              </button>
              <button className="icon-btn" onClick={() => zoom(tab.zoom + 15)} aria-label="Zoom in">
                <ZoomIn {...SMALL} />
              </button>
            </div>
          )}

          {standalone && queue.length > 1 && (
            <div className="flex items-center gap-0.5 pl-2 ml-1 border-l border-slate-800">
              <button className="icon-btn" onClick={() => go(-1)} aria-label="Previous file" title="Previous file ([)">
                <ChevronLeft {...SMALL} />
              </button>
              <span className="text-[11px] font-mono tabular-nums text-slate-300 w-10 text-center">
                {index + 1}/{queue.length}
              </span>
              <button className="icon-btn" onClick={() => go(1)} aria-label="Next file" title="Next file (])">
                <ChevronRight {...SMALL} />
              </button>
            </div>
          )}

          <div className="flex items-center gap-0.5 pl-2 ml-1 border-l border-slate-800">
            {path && (
              <span className="hidden sm:flex items-center gap-0.5">
                <button className="icon-btn" onClick={copyPath} title="Copy path (Ctrl+Shift+C)" aria-label="Copy path">
                  <ClipboardCopy {...ICON} />
                </button>
                <button className="icon-btn" onClick={reveal} title="Show in folder (Ctrl+Shift+E)" aria-label="Show in folder">
                  <FolderOpen {...ICON} />
                </button>
                <button className="icon-btn" onClick={openWith} title="Open with another app" aria-label="Open with another app">
                  <SquareArrowOutUpRight {...ICON} />
                </button>
              </span>
            )}
            {caps?.download !== false && (
              <button className="icon-btn" onClick={() => onDownload(file)} title="Save a copy" aria-label="Save a copy">
                <Download {...ICON} />
              </button>
            )}
            {onOpenInWorkspace && (
              <button
                className="icon-btn"
                onClick={keep}
                title="Open in workspace (Enter)"
                aria-label="Open in workspace"
                data-testid="quickview-open-workspace"
              >
                <Library {...ICON} />
              </button>
            )}
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
                  {pinned ? <PinOff {...ICON} /> : <Pin {...ICON} />}
                </button>
                <button
                  className="icon-btn"
                  onClick={toggleFullscreen}
                  title={`${fullscreen ? 'Exit full screen' : 'Full screen'} (F11)`}
                  aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
                >
                  {fullscreen ? <Minimize2 {...ICON} /> : <Maximize2 {...ICON} />}
                </button>
              </div>
              {!fullscreen && <WindowControls onClose={close} lucide />}
              {fullscreen && (
                <button className="icon-btn mr-3" onClick={close} aria-label="Close Quick View" title="Close" data-testid="quickview-close">
                  <X {...ICON} />
                </button>
              )}
            </>
          ) : (
            <button className="icon-btn" onClick={close} aria-label="Close Quick View" title="Close (Esc)" data-testid="quickview-close">
              <X {...ICON} />
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
              <Check {...SMALL} /> {notice}
            </span>
          ) : folder ? (
            <button className="flex min-w-0 items-center gap-2 hover:text-slate-200" onClick={reveal} title="Show in folder">
              <FolderOpen {...SMALL} />
              <span className="truncate font-mono">{folder}</span>
            </button>
          ) : (
            !paged && (
              <span className="flex items-center gap-2">
                <HardDrive {...SMALL} /> Opened read-only from this device
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
          <ChevronRight {...ICON} />
        </button>
      )}
    </div>
  );
}
