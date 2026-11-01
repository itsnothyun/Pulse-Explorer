import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DetectedFile } from '@omniview/shared-types';
import { formatFileSize } from '@omniview/utilities';
import { ensureSystemFileImported, isDesktop, listRecentSystemFiles, type RecentSystemFile } from '../services/desktopBridge';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';
import { PixelIcon, categoryGlyph } from './pulse/PixelIcon';
import { Eyebrow, PixelText } from './pulse/Pixel';
import { Segmented } from './pulse/Segmented';

const EXT_CATEGORY: Record<string, string> = {
  pdf: 'pdf', docx: 'word', doc: 'word', odt: 'word', rtf: 'word',
  pptx: 'presentation', ppt: 'presentation', odp: 'presentation',
  xlsx: 'spreadsheet', xls: 'spreadsheet', ods: 'spreadsheet', csv: 'spreadsheet', tsv: 'spreadsheet',
  epub: 'ebook', fb2: 'ebook',
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', bmp: 'image', ico: 'image', svg: 'image',
  mp3: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio', aac: 'audio', mp4: 'video', webm: 'video',
  zip: 'archive', tar: 'archive', gz: 'archive', tgz: 'archive',
};

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "just now", "12 minutes ago", "yesterday", then a short date. */
export function relativeTime(ms: number, now = Date.now()): string {
  if (!ms) return '—';
  const diff = (ms - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 6) return rtf.format(Math.round(diff / 86400), 'day');
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: abs > 86400 * 300 ? 'numeric' : undefined });
}

interface RecentViewProps {
  query: string;
  onOpenFile: (fileId: string) => void;
  onFileContextMenu: (file: DetectedFile, x: number, y: number) => void;
  onQuickView: (fileId: string) => void;
}

/**
 * Recent: what you opened in Pulse, and, on desktop, what Windows File Explorer
 * lists as recently opened, sortable by when it was opened or last modified.
 */
export function RecentView({ query, onOpenFile, onFileContextMenu, onQuickView }: RecentViewProps) {
  const files = useWorkspaceStore((s) => s.files);
  const recentFileIds = useWorkspaceStore((s) => s.recentFileIds);
  const sessions = useWorkspaceStore((s) => s.lastSessionByFileId);

  const [system, setSystem] = useState<RecentSystemFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<'opened' | 'modified'>('opened');
  const [opening, setOpening] = useState<string | null>(null);
  const desktop = isDesktop();

  const refresh = useCallback(async () => {
    if (!desktop) return;
    setLoading(true);
    setError(null);
    try {
      setSystem(await listRecentSystemFiles(80));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [desktop]);

  useEffect(() => {
    void refresh();
    // Explorer history changes while Pulse is in the background; refresh on focus.
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const q = query.trim().toLowerCase();
  const inPulse = useMemo(() => {
    const byId = new Map(files.filter((f) => !f.isTrashed).map((f) => [f.id, f]));
    return recentFileIds
      .map((id) => byId.get(id))
      .filter((f): f is DetectedFile => Boolean(f))
      .filter((f) => !q || f.originalName.toLowerCase().includes(q));
  }, [files, recentFileIds, q]);

  const onPc = useMemo(() => {
    const list = (system ?? []).filter((f) => !q || f.filename.toLowerCase().includes(q) || f.folder.toLowerCase().includes(q));
    return [...list].sort((a, b) => (sort === 'opened' ? b.openedAt - a.openedAt : b.modifiedAt - a.modifiedAt));
  }, [system, sort, q]);

  /** Peeks at a PC file in Quick View, reusing the copy already in Pulse if there is one. */
  const openSystemFile = async (f: RecentSystemFile) => {
    setOpening(f.path);
    try {
      const id = await ensureSystemFileImported(f);
      if (id) onQuickView(id);
    } catch (e) {
      setError(`Couldn't open ${f.filename}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setOpening(null);
    }
  };

  return (
    <div data-testid="recent-view" className="flex-1 overflow-auto bg-slate-950">
      <div className="max-w-[1180px] mx-auto px-6 lg:px-10 py-8 space-y-10">
        <div className="space-y-3">
          <Eyebrow text="WORKSPACE" />
          <h2>
            <PixelText text="RECENT" dot={5} label="Recent" assemble />
          </h2>
        </div>

        {/* Opened in Pulse */}
        <section>
          <h3 className="text-sm font-semibold text-slate-100 mb-3">Opened in Pulse</h3>
          {inPulse.length === 0 ? (
            <p className="text-sm text-slate-400 py-4">Files you open in Pulse show up here.</p>
          ) : (
            <ul className="anim-stagger border-t border-slate-800">
              {inPulse.map((f) => {
                const s = sessions[f.id];
                return (
                  <li key={f.id} className="border-b border-slate-800">
                    <button
                      onClick={() => onOpenFile(f.id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        onFileContextMenu(f, e.clientX, e.clientY);
                      }}
                      className="recent-row group"
                    >
                      <PixelIcon name={categoryGlyph(f.category)} size={14} className="text-slate-400 group-hover:text-white" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-slate-100">{f.originalName}</span>
                        <span className="block text-xs text-slate-400">
                          {s?.totalPages && s.totalPages > 1 ? `Page ${s.currentPage ?? 1} of ${s.totalPages} · ` : ''}
                          {formatFileSize(f.sizeBytes)}
                        </span>
                      </span>
                      <PixelIcon name="arrowRight" size={7} className="text-slate-600 group-hover:text-white" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* On this PC (File Explorer) */}
        <section>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">On this PC</h3>
              <p className="text-xs text-slate-400 mt-0.5">From File Explorer’s recent files</p>
            </div>
            {desktop && (
              <div className="flex items-center gap-2">
                <Segmented
                  label="Sort PC files by"
                  value={sort}
                  onChange={setSort}
                  options={[
                    { value: 'opened', label: 'Opened' },
                    { value: 'modified', label: 'Modified' },
                  ]}
                />
                <button onClick={() => void refresh()} className="icon-btn" title="Refresh" aria-label="Refresh">
                  <PixelIcon name="recent" size={14} className={loading ? 'animate-spin' : ''} />
                </button>
              </div>
            )}
          </div>

          {!desktop ? (
            <div className="border border-dotted border-slate-700 px-5 py-6 text-sm text-slate-400">
              File Explorer history is available in the Pulse desktop app.
            </div>
          ) : error ? (
            <p role="alert" className="text-sm text-slate-200 py-4">{error}</p>
          ) : system === null ? (
            <div className="py-8 flex justify-center">
              <span className="px-spinner" role="status" aria-label="Loading recent files">
                <i /><i /><i /><i /><i /><i /><i /><i /><i />
              </span>
            </div>
          ) : onPc.length === 0 ? (
            <p className="text-sm text-slate-400 py-4">{q ? 'No recent PC files match.' : 'No recent files Pulse can open.'}</p>
          ) : (
            <div className="border-t border-slate-800">
              <div className="hidden md:grid recent-grid px-2 py-2 text-[11px] text-slate-500 border-b border-slate-800">
                <span />
                <span>Name</span>
                <span className={sort === 'opened' ? 'text-slate-200' : ''}>Opened</span>
                <span className={sort === 'modified' ? 'text-slate-200' : ''}>Modified</span>
                <span className="text-right">Size</span>
              </div>
              <ul key={sort} className="anim-stagger">
                {onPc.map((f) => (
                  <li key={f.path} className="border-b border-slate-800">
                    <button
                      onClick={() => void openSystemFile(f)}
                      disabled={opening === f.path}
                      title={`${f.path}
Click for Quick View`}
                      className="recent-grid recent-row group w-full text-left disabled:opacity-60"
                    >
                      <PixelIcon
                        name={categoryGlyph(EXT_CATEGORY[f.extension] ?? 'file')}
                        size={14}
                        className="text-slate-400 group-hover:text-white"
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] text-slate-100">{f.filename}</span>
                        <span className="block truncate text-xs text-slate-500">{f.folder}</span>
                      </span>
                      <span className="hidden md:block text-xs text-slate-400 tabular-nums">{relativeTime(f.openedAt)}</span>
                      <span className="hidden md:block text-xs text-slate-400 tabular-nums">{relativeTime(f.modifiedAt)}</span>
                      <span className="hidden md:block text-xs text-slate-400 text-right font-mono tabular-nums">
                        {opening === f.path ? 'Opening…' : formatFileSize(f.sizeBytes)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
