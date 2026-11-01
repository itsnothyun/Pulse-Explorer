import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatFileSize } from '@omniview/utilities';
import {
  TYPE_EXTENSIONS,
  ensureSystemFileImported,
  isDesktop,
  listRecentFilesByType,
  type RecentSystemFile,
} from '../services/desktopBridge';
import { PixelIcon, categoryGlyph } from './pulse/PixelIcon';
import { relativeTime } from './RecentView';

interface PcFilesSectionProps {
  /** Pulse type id (pdf, word, presentation, ...). */
  type: string;
  label: string;
  query: string;
  onQuickView: (fileId: string) => void;
}

// Scans are cheap (~150ms) but not free; keep results per type for the session.
const cache = new Map<string, { at: number; files: RecentSystemFile[] }>();
const FRESH_MS = 60_000;

/** "On this PC": the most recently modified files of this type in your user folders. */
export function PcFilesSection({ type, label, query, onQuickView }: PcFilesSectionProps) {
  const desktop = isDesktop();
  const extensions = TYPE_EXTENSIONS[type];
  const [files, setFiles] = useState<RecentSystemFile[] | null>(() => cache.get(type)?.files ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const load = useCallback(
    async (force = false) => {
      if (!desktop || !extensions) return;
      const hit = cache.get(type);
      if (!force && hit && Date.now() - hit.at < FRESH_MS) {
        setFiles(hit.files);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result = await listRecentFilesByType(extensions, 60);
        cache.set(type, { at: Date.now(), files: result });
        setFiles(result);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [desktop, extensions, type]
  );

  useEffect(() => {
    setFiles(cache.get(type)?.files ?? null);
    void load();
  }, [type, load]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () => (files ?? []).filter((f) => !q || f.filename.toLowerCase().includes(q) || f.folder.toLowerCase().includes(q)),
    [files, q]
  );

  if (!extensions) return null;

  const open = async (f: RecentSystemFile) => {
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
    <section className="pt-4" data-testid="pc-files-section">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">On this PC</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Recently modified {label.toLowerCase()} in Desktop, Documents, Downloads and your media folders
          </p>
        </div>
        {desktop && (
          <button onClick={() => void load(true)} className="pulse-btn pulse-btn-ghost pulse-btn-sm" disabled={loading}>
            <PixelIcon name="recent" size={7} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Scanning…' : 'Rescan'}
          </button>
        )}
      </div>

      {!desktop ? (
        <div className="border border-dotted border-slate-700 px-5 py-6 text-sm text-slate-400">
          Your PC’s {label.toLowerCase()} show up here in the Pulse desktop app.
        </div>
      ) : error ? (
        <p role="alert" className="text-sm text-slate-200 py-4">{error}</p>
      ) : files === null ? (
        <div className="py-8 flex justify-center">
          <span className="px-spinner" role="status" aria-label={`Scanning for ${label}`}>
            <i /><i /><i /><i /><i /><i /><i /><i /><i />
          </span>
        </div>
      ) : shown.length === 0 ? (
        <p className="text-sm text-slate-400 py-4">{q ? 'Nothing on this PC matches.' : `No ${label.toLowerCase()} found in your folders.`}</p>
      ) : (
        <div className="border-t border-slate-800">
          <div className="hidden md:grid pc-grid px-2 py-2 text-[11px] text-slate-500 border-b border-slate-800">
            <span />
            <span>Name</span>
            <span className="text-slate-200">Modified</span>
            <span className="text-right">Size</span>
          </div>
          <ul className="anim-stagger">
            {shown.map((f) => (
              <li key={f.path} className="border-b border-slate-800">
                <button
                  onClick={() => void open(f)}
                  disabled={opening === f.path}
                  title={`${f.path}\nClick for Quick View`}
                  className="pc-grid recent-row group w-full text-left disabled:opacity-60"
                >
                  <PixelIcon name={categoryGlyph(type)} size={14} className="text-slate-400 group-hover:text-white" />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] text-slate-100">{f.filename}</span>
                    <span className="block truncate text-xs text-slate-500">{f.folder}</span>
                  </span>
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
  );
}
