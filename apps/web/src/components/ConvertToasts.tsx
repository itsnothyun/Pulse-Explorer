import { useEffect } from 'react';
import { formatBytes } from '../converters/registry';
import { useConvertStore, type ConvertJob } from '../stores/useConvertStore';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';

function Toast({ job }: { job: ConvertJob }) {
  const dismiss = useConvertStore((s) => s.dismissJob);
  const openFileInTab = useWorkspaceStore((s) => s.openFileInTab);

  useEffect(() => {
    if (job.status !== 'done') return;
    const t = setTimeout(() => dismiss(job.id), 9000);
    return () => clearTimeout(t);
  }, [job.status, job.id, dismiss]);

  const delta = job.after !== undefined && job.before > 0 ? Math.round((1 - job.after / job.before) * 100) : null;

  return (
    <div
      role={job.status === 'error' ? 'alert' : 'status'}
      className="anim-toast pointer-events-auto w-[min(92vw,360px)] rounded-lg border border-slate-700 bg-slate-950 shadow-2xl p-3 text-xs"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-slate-100 truncate">
            {job.status === 'running' && `${job.targetLabel}…`}
            {job.status === 'done' && `Saved ${job.fileName}`}
            {job.status === 'error' && 'Could not convert'}
          </div>
          <div className="text-slate-400 mt-1">
            {job.status === 'running' && job.fileName}
            {job.status === 'done' && (
              <>
                {formatBytes(job.before)} → {formatBytes(job.after ?? 0)}
                {delta !== null && delta !== 0 && <span className="text-slate-200"> ({delta > 0 ? `−${delta}` : `+${-delta}`}%)</span>}
                {job.message && <span className="block mt-1">{job.message}</span>}
              </>
            )}
            {job.status === 'error' && job.message}
          </div>
        </div>
        <button type="button" onClick={() => dismiss(job.id)} className="icon-btn shrink-0" aria-label="Dismiss">
          ×
        </button>
      </div>
      {job.status === 'running' && (
        <div className="mt-2 h-1 bg-slate-800 overflow-hidden" aria-hidden>
          <div className="h-full bg-slate-100 transition-[width] duration-200" style={{ width: `${Math.max(6, Math.round(job.progress * 100))}%` }} />
        </div>
      )}
      {job.status === 'done' && job.resultFileId && (
        <div className="mt-2">
          <button
            type="button"
            className="pulse-btn pulse-btn-ghost pulse-btn-sm"
            onClick={() => {
              void openFileInTab(job.resultFileId!);
              dismiss(job.id);
            }}
          >
            Open
          </button>
        </div>
      )}
    </div>
  );
}

/** Progress and results of conversions, bottom-right. */
export function ConvertToasts() {
  const jobs = useConvertStore((s) => s.jobs);
  if (jobs.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[85] flex flex-col gap-2 items-end pointer-events-none">
      {jobs.map((j) => (
        <Toast key={j.id} job={j} />
      ))}
    </div>
  );
}
