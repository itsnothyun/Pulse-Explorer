/**
 * Bridge to the Tauri desktop shell. Every export is a no-op in the browser,
 * so the web build keeps working unchanged.
 */
import type { DetectedFile, ImportSource } from '@omniview/shared-types';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';

export const isDesktop = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

interface OpenWithFilePayload {
  path: string;
  filename: string;
  extension: string;
  sizeBytes: number;
}

type ImportFn = (
  inputs: { name: string; bytes: ArrayBuffer }[],
  source: ImportSource,
  openFirstInTab?: boolean
) => Promise<DetectedFile[]>;

/** Called with the ids of files Windows handed to Pulse, in the order given. */
export type OpenedHandler = (fileIds: string[], forceTab?: boolean) => void;

/** Imports the files (reusing copies already in Pulse) without opening tabs. */
async function importPayloads(payloads: OpenWithFilePayload[], importFiles: ImportFn, onOpened: OpenedHandler, forceTab = false) {
  if (payloads.length === 0) return;
  const { invoke } = await import('@tauri-apps/api/core');
  const existing = useWorkspaceStore.getState().files.filter((f) => !f.isTrashed);
  const ids: (string | null)[] = payloads.map(
    (p) => existing.find((f) => f.originalName === p.filename && f.sizeBytes === p.sizeBytes)?.id ?? null
  );
  const missing = payloads.filter((_, i) => !ids[i]);
  if (missing.length > 0) {
    const items = await Promise.all(
      missing.map(async (p) => ({
        name: p.filename,
        bytes: await invoke<ArrayBuffer>('read_local_file_bytes', { path: p.path }),
      }))
    );
    const created = await importFiles(items, 'desktop-open-with', false);
    let k = 0;
    ids.forEach((id, i) => {
      if (!id) ids[i] = created[k++]?.id ?? null;
    });
  }
  onOpened(ids.filter((id): id is string => Boolean(id)), forceTab);
}

/**
 * Imports files Windows handed to Pulse ("Open with", double-click on an
 * associated type, or a second launch forwarded by the single-instance guard).
 * Returns an unsubscribe function.
 */
export async function subscribeToOpenWithFiles(importFiles: ImportFn, onOpened: OpenedHandler): Promise<() => void> {
  if (!isDesktop()) return () => {};
  const [{ invoke }, { listen }] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/event'),
  ]);
  const unlisten = await listen<OpenWithFilePayload[]>('omniview://open-with-files', (e) => {
    void importPayloads(e.payload, importFiles, onOpened);
  });
  const unlistenTab = await listen<OpenWithFilePayload[]>('pulse://open-in-tab', (e) => {
    void importPayloads(e.payload, importFiles, onOpened, true);
  });
  const pending = await invoke<OpenWithFilePayload[]>('consume_startup_open_with_files');
  await importPayloads(pending, importFiles, onOpened);
  return () => {
    unlisten();
    unlistenTab();
  };
}

/** Opens Windows Settings > Default apps so the user can make Pulse the default. */
export async function openDefaultAppsSettings(): Promise<void> {
  if (!isDesktop()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_default_apps_settings');
}

export interface RecentSystemFile {
  path: string;
  filename: string;
  extension: string;
  folder: string;
  sizeBytes: number;
  /** When it was last opened from File Explorer, ms since epoch. */
  openedAt: number;
  /** The file's last-modified time, ms since epoch. */
  modifiedAt: number;
}

/** Files Windows lists under File Explorer > Recent, filtered to types Pulse can open. */
export async function listRecentSystemFiles(limit = 60): Promise<RecentSystemFile[]> {
  if (!isDesktop()) return [];
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<RecentSystemFile[]>('list_recent_system_files', { limit });
}

/** Reads a file from disk for import. */
export async function readSystemFile(path: string): Promise<ArrayBuffer> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<ArrayBuffer>('read_local_file_bytes', { path });
}

/** Most recently modified files of the given extensions in the user's folders. */
export async function listRecentFilesByType(extensions: string[], limit = 60): Promise<RecentSystemFile[]> {
  if (!isDesktop()) return [];
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<RecentSystemFile[]>('list_recent_files_by_type', { extensions, limit });
}

/** Returns the Pulse file id for a PC file, importing it only if no copy (same name and size) exists. */
export async function ensureSystemFileImported(f: Pick<RecentSystemFile, 'path' | 'filename' | 'sizeBytes'>): Promise<string | null> {
  const state = useWorkspaceStore.getState();
  const existing = state.files.find((x) => !x.isTrashed && x.originalName === f.filename && x.sizeBytes === f.sizeBytes);
  if (existing) return existing.id;
  const bytes = await readSystemFile(f.path);
  const [created] = await state.importFiles([{ name: f.filename, bytes }], 'desktop-open-with', false);
  return created?.id ?? null;
}

/** Extensions per Pulse type, matching the desktop shell's supported list. */
export const TYPE_EXTENSIONS: Record<string, string[]> = {
  pdf: ['pdf'],
  word: ['docx', 'doc', 'odt', 'rtf'],
  presentation: ['pptx', 'ppt', 'odp'],
  spreadsheet: ['xlsx', 'xls', 'ods', 'csv', 'tsv'],
  ebook: ['epub', 'fb2'],
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'],
  code: ['md', 'json', 'yaml', 'yml', 'toml', 'xml', 'ts', 'js', 'py', 'go', 'rs', 'html', 'css', 'sql', 'sh', 'txt', 'log', 'ini'],
  audio: ['mp3', 'wav', 'flac', 'ogg', 'aac', 'mp4', 'webm'],
  archive: ['zip', 'tar', 'gz', 'tgz'],
};

/** True inside the floating Quick View window (a second webview of the same app). */
export const isQuickViewWindow = (): boolean => {
  if (!isDesktop()) return false;
  const meta = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } })
    .__TAURI_INTERNALS__?.metadata?.currentWindow;
  return meta?.label === 'quickview';
};

/** Tells the desktop shell how files from File Explorer should open, so cold starts know too. */
export async function syncExplorerOpenMode(mode: 'quick-view' | 'tab'): Promise<void> {
  if (!isDesktop()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_explorer_open_mode', { mode }).catch(() => undefined);
}

export interface QuickViewPayload {
  path: string;
  filename: string;
  extension: string;
  sizeBytes: number;
}

/** Quick View window: files queued at launch plus any opened while it's up. */
export async function subscribeToQuickViewFiles(onFiles: (files: QuickViewPayload[]) => void): Promise<() => void> {
  const [{ invoke }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
  const unlisten = await listen<QuickViewPayload[]>('pulse://quickview-files', (e) => onFiles(e.payload));
  const pending = await invoke<QuickViewPayload[]>('consume_quickview_files');
  if (pending.length > 0) onFiles(pending);
  return unlisten;
}

export async function closeQuickViewWindow(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('close_quickview');
}

export async function openPathsInWorkspace(paths: string[]): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_in_workspace', { paths });
}

/** Opens File Explorer with the file selected. */
export async function revealInExplorer(path: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('reveal_in_explorer', { path });
}

/** Shows the Windows "Open with" chooser for the file. */
export async function openWithOtherApp(path: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_with_other_app', { path });
}

const NO_DRAG ='button, a, input, select, textarea, [role="button"], [role="option"], [role="tab"], [data-no-drag]';

/**
 * Starts a native window drag from a custom title bar. Unlike
 * `data-tauri-drag-region` (which only works on the exact element), this works
 * from any non-interactive child such as the file name or meta text.
 * Double-click toggles maximize when `maximizeOnDoubleClick` is set.
 */
export function startWindowDrag(e: React.MouseEvent, maximizeOnDoubleClick = true): void {
  if (!isDesktop() || e.button !== 0) return;
  if ((e.target as HTMLElement).closest(NO_DRAG)) return;
  e.preventDefault();
  void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
    const win = getCurrentWindow();
    if (e.detail === 2 && maximizeOnDoubleClick) void win.toggleMaximize();
    else void win.startDragging();
  });
}
