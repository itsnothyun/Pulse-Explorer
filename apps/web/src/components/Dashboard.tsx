import { useMemo } from 'react';
import { ArrowRight, Globe, Star, Upload } from 'lucide-react';
import type { DetectedFile, FileCategory } from '@omniview/shared-types';
import { formatFileSize } from '@omniview/utilities';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';
import { Eyebrow, PixelText, SegmentBar } from './pulse/Pixel';
import { useCountUp } from './pulse/motion';

const TYPE_GROUPS: { label: string; categories: FileCategory[] }[] = [
  { label: 'PDF', categories: ['pdf'] },
  { label: 'Documents', categories: ['word'] },
  { label: 'Slides', categories: ['presentation'] },
  { label: 'Sheets', categories: ['spreadsheet'] },
  { label: 'eBooks', categories: ['ebook'] },
  { label: 'Images', categories: ['image'] },
  { label: 'Code', categories: ['code'] },
  { label: 'Media', categories: ['audio', 'video'] },
  { label: 'Archives', categories: ['archive'] },
];

interface DashboardProps {
  getIcon: (category: FileCategory, className?: string) => React.ReactNode;
  onOpenFile: (fileId: string) => void;
  onOpenPicker: () => void;
  onImportUrl: () => void;
  onShowLibrary: () => void;
  onFileContextMenu: (file: DetectedFile, x: number, y: number) => void;
  onQuickView: (fileId: string) => void;
}

/** Home screen: what is here, what you were reading, and the two ways to add more. */
export function Dashboard({ getIcon, onOpenFile, onOpenPicker, onImportUrl, onShowLibrary, onFileContextMenu, onQuickView }: DashboardProps) {
  const files = useWorkspaceStore((s) => s.files);
  const tabs = useWorkspaceStore((s) => s.tabs);
  const recentFileIds = useWorkspaceStore((s) => s.recentFileIds);
  const sessions = useWorkspaceStore((s) => s.lastSessionByFileId);
  const annotationsByFileId = useWorkspaceStore((s) => s.annotationsByFileId);

  const live = useMemo(() => files.filter((f) => !f.isTrashed), [files]);
  const byId = useMemo(() => new Map(live.map((f) => [f.id, f])), [live]);

  const recent = useMemo(() => {
    const fromHistory = recentFileIds.map((id) => byId.get(id)).filter((f): f is DetectedFile => Boolean(f));
    // Before anything has been opened, show the newest imports instead.
    const pool = fromHistory.length > 0 ? fromHistory : live;
    return pool.slice(0, 6);
  }, [recentFileIds, byId, live]);

  const favorites = useMemo(() => live.filter((f) => f.isFavorite).slice(0, 5), [live]);
  const totalBytes = useMemo(() => live.reduce((n, f) => n + f.sizeBytes, 0), [live]);
  const noteCount = useMemo(
    () => Object.values(annotationsByFileId).reduce((n, list) => n + list.length, 0),
    [annotationsByFileId]
  );
  const groups = useMemo(() => {
    const counted = TYPE_GROUPS.map((g) => ({
      ...g,
      count: live.filter((f) => g.categories.includes(f.category)).length,
    })).filter((g) => g.count > 0);
    // Share of the whole library, so the bars stay comparable as files are added.
    const total = Math.max(1, live.length);
    return counted.map((g) => ({ ...g, ratio: g.count / total }));
  }, [live]);

  const fileCount = useCountUp(live.length);
  const byteCount = useCountUp(totalBytes, 1200);
  const tabCount = useCountUp(tabs.length);
  const notesCount = useCountUp(noteCount);
  const stats = [
    { key: 'FILES', value: String(Math.round(fileCount)), caption: 'in this workspace' },
    { key: 'STORAGE', value: formatFileSize(Math.round(byteCount)).replace(/\s+/g, ''), caption: 'kept on this device' },
    { key: 'OPEN', value: String(Math.round(tabCount)), caption: tabs.length === 1 ? 'tab' : 'tabs' },
    { key: 'NOTES', value: String(Math.round(notesCount)), caption: 'annotations' },
  ];

  return (
    <div data-testid="dashboard-view" className="flex-1 overflow-auto bg-slate-950">
      <div className="max-w-[1180px] mx-auto px-6 lg:px-10 py-10 space-y-10">
        {/* Heading + actions */}
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="space-y-4 min-w-0">
            <Eyebrow text="HOME" />
            <h1>
              <PixelText text="WORKSPACE" dot={6} label="Workspace" assemble />
            </h1>
            <p className="text-sm text-slate-400 max-w-[52ch]">
              Everything stays on this device. Drop files anywhere, or open them from your disk.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onImportUrl} className="pulse-btn pulse-btn-ghost">
              <Globe className="w-4 h-4" />
              From URL
            </button>
            <button onClick={onOpenPicker} className="pulse-btn">
              <Upload className="w-4 h-4" />
              Open files
            </button>
          </div>
        </div>

        {/* Stats: one ruled strip, pixel numbers */}
        <div className="anim-stagger grid grid-cols-2 md:grid-cols-4 gap-px bg-slate-800 border border-slate-800 rounded-xl overflow-hidden">
          {stats.map((s) => (
            <div key={s.key} className="bg-slate-950 p-5 space-y-3">
              <PixelText text={s.key} dot={1.5} className="px-eye" label={s.key.toLowerCase()} />
              <PixelText text={s.value} dot={4} label={`${s.value} ${s.caption}`} />
              <div className="pulse-caption">{s.caption}</div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-10">
          {/* Continue reading */}
          <section className="min-w-0">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-slate-100">
                {recentFileIds.length > 0 ? 'Continue' : 'Recently added'}
              </h2>
              <button onClick={onShowLibrary} className="text-xs text-slate-400 hover:text-white flex items-center gap-1">
                All files <ArrowRight className="w-3 h-3" />
              </button>
            </div>
            {recent.length === 0 ? (
              <button
                onClick={onOpenPicker}
                className="w-full rounded-xl border border-dotted border-slate-600 py-14 text-center text-sm text-slate-400 hover:text-white hover:border-slate-400"
              >
                No files yet. Drop some here, or click to choose.
              </button>
            ) : (
              <ul className="anim-stagger border-t border-slate-800">
                {recent.map((f) => {
                  const session = sessions[f.id];
                  const isOpen = tabs.some((t) => t.fileId === f.id);
                  const where =
                    session?.totalPages && session.totalPages > 1
                      ? `Page ${session.currentPage ?? 1} of ${session.totalPages}`
                      : f.extension.toUpperCase();
                  return (
                    <li key={f.id} className="border-b border-slate-800">
                      <button
                        data-testid={`dashboard-file-${f.originalName}`}
                        onClick={() => onOpenFile(f.id)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          onFileContextMenu(f, e.clientX, e.clientY);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === ' ') {
                            e.preventDefault();
                            onQuickView(f.id);
                          }
                        }}
                        className="group w-full flex items-center gap-3 py-3 px-2 -mx-2 rounded text-left hover:bg-slate-800/40"
                      >
                        <span className="text-slate-400 group-hover:text-white">{getIcon(f.category, 'w-4 h-4 shrink-0')}</span>
                        <span className="flex-1 min-w-0">
                          <span className="block truncate text-sm text-slate-100">{f.originalName}</span>
                          <span className="block text-xs text-slate-400">
                            {where} · {formatFileSize(f.sizeBytes)}
                          </span>
                        </span>
                        {isOpen && <span className="text-[11px] text-slate-400">Open</span>}
                        <ArrowRight className="w-3.5 h-3.5 text-slate-600 group-hover:text-white" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Composition + favourites */}
          <aside className="space-y-10 min-w-0">
            {groups.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold text-slate-100 mb-4">By type</h2>
                <ul className="anim-stagger space-y-3">
                  {groups.map((g) => (
                    <li key={g.label} className="grid grid-cols-[72px_1fr_24px] items-center gap-3 text-xs">
                      <span className="text-slate-400">{g.label}</span>
                      <SegmentBar value={g.ratio} segments={16} />
                      <span className="text-right font-mono tabular-nums text-slate-300">{g.count}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {favorites.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold text-slate-100 mb-3">Favorites</h2>
                <ul className="space-y-0.5">
                  {favorites.map((f) => (
                    <li key={f.id}>
                      <button
                        onClick={() => onOpenFile(f.id)}
                        className="w-full flex items-center gap-2.5 py-1.5 px-2 -mx-2 rounded text-xs text-slate-300 hover:text-white hover:bg-slate-800/40"
                      >
                        <Star className="w-3 h-3 fill-current shrink-0" />
                        <span className="truncate">{f.originalName}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
