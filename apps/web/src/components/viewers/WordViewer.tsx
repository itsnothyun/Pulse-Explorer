import React from 'react';
import {
  BookOpen,
  FileText,
  Info,
  ListTree,
  ServerCog,
} from 'lucide-react';
import type { DetectedFile, TabViewerState } from '@omniview/shared-types';
import type { ViewerDocument } from '@omniview/viewer-core';
import type { WordViewerPayload } from '@omniview/viewer-adapters';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';

interface WordViewerProps {
  file: DetectedFile;
  tab: TabViewerState;
  document: ViewerDocument<WordViewerPayload>;
}

export const WordViewer: React.FC<WordViewerProps> = ({ file, tab, document }) => {
  const updateTabState = useWorkspaceStore((s) => s.updateTabState);
  const requestServerConversion = useWorkspaceStore((s) => s.requestServerConversion);
  const conversionJob = useWorkspaceStore((s) => s.conversionJobs[file.id]);
  const { payload, outline } = document;

  const highlightHtml = (html: string, query: string): string => {
    if (!query.trim()) return html;
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Highlight only text outside HTML tags
    return html.replace(
      new RegExp(`(>[^<]*?)(${escaped})([^<]*?<)`, 'gi'),
      '$1<mark class="bg-amber-300 text-slate-950 px-0.5 rounded font-semibold">$2</mark>$3'
    );
  };

  return (
    <div className="flex h-full w-full overflow-hidden" data-testid="word-viewer-root">
      {/* Left Heading Outline Sidebar */}
      {tab.showThumbnails && (
        <aside className="w-56 shrink-0 border-r border-slate-800/80 bg-slate-900/50 overflow-y-auto p-3 space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400 px-1">
            <ListTree className="w-3.5 h-3.5 text-blue-400" />
            <span>Headings & Pages</span>
          </div>

          {outline.length > 0 ? (
            <div className="space-y-1">
              {outline.map((item) => (
                <button
                  key={item.id}
                  onClick={() =>
                    updateTabState(tab.tabId, {
                      currentPage: Number(item.pageOrPosition) || 1,
                    })
                  }
                  style={{ paddingLeft: `${Math.max(8, item.level * 10)}px` }}
                  className="w-full text-left py-1.5 pr-2 rounded text-xs text-slate-300 hover:bg-slate-800/80 truncate transition"
                >
                  {item.title}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-500 px-1">No structural headings detected.</p>
          )}

          <div className="pt-3 border-t border-slate-800/80 space-y-1">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 px-1">
              Document Metrics
            </div>
            <div className="text-xs text-slate-400 px-1 flex justify-between">
              <span>Words:</span>
              <span className="font-mono text-slate-200">{payload.wordCount.toLocaleString()}</span>
            </div>
            <div className="text-xs text-slate-400 px-1 flex justify-between">
              <span>Characters:</span>
              <span className="font-mono text-slate-200">{payload.charCount.toLocaleString()}</span>
            </div>
            <div className="text-xs text-slate-400 px-1 flex justify-between">
              <span>Logical Pages:</span>
              <span className="font-mono text-slate-200">{payload.htmlPages.length}</span>
            </div>
          </div>
        </aside>
      )}

      {/* Central Document Reading Surface */}
      <div className="flex-1 overflow-auto p-6 bg-slate-950/60 flex flex-col items-center gap-5">
        {/* Fidelity Transparency Banner (Principle #12 & #14) */}
        <div className="max-w-3xl w-full rounded-lg border border-blue-500/30 bg-blue-950/20 px-4 py-2.5 flex items-center justify-between gap-4 text-xs">
          <div className="flex items-center gap-2.5 text-slate-300">
            <Info className="w-4 h-4 text-blue-400 shrink-0" />
            <span>
              {conversionJob?.status === 'completed'
                ? 'High-fidelity LibreOffice print-layout artifact synced.'
                : document.fidelityWarning ||
                  'Local semantic HTML preview active. HTML conversion does not guarantee exact Microsoft Word pagination.'}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() =>
                updateTabState(tab.tabId, {
                  docReadingMode:
                    tab.docReadingMode === 'print-layout' ? 'reading' : 'print-layout',
                })
              }
              className="pulse-btn pulse-btn-ghost pulse-btn-sm flex items-center gap-1.5"
            >
              {tab.docReadingMode === 'print-layout' ? (
                <>
                  <BookOpen className="w-3.5 h-3.5 text-blue-400" />
                  <span>Simplified Reader</span>
                </>
              ) : (
                <>
                  <FileText className="w-3.5 h-3.5 text-blue-400" />
                  <span>Print Layout</span>
                </>
              )}
            </button>

            <button
              onClick={() => void requestServerConversion(file.id)}
              disabled={conversionJob?.status === 'processing'}
              className="pulse-btn pulse-btn-ghost pulse-btn-sm flex items-center gap-1.5"
              title="Convert via isolated LibreOffice headless worker for exact pagination"
            >
              <ServerCog className="w-3.5 h-3.5" />
              <span>
                {conversionJob?.status === 'processing'
                  ? 'Converting...'
                  : conversionJob?.status === 'completed'
                  ? 'PDF Print Verified'
                  : 'LibreOffice Print Sync'}
              </span>
            </button>
          </div>
        </div>

        {/* Render Paginated Print Layout or Continuous Reader Mode */}
        {tab.docReadingMode === 'print-layout' ? (
          payload.htmlPages.map((pageHtml, idx) => (
            <article
              key={idx}
              style={{
                width: `${Math.round(760 * (tab.zoom / 100))}px`,
                fontSize: `${Math.round(15 * (tab.zoom / 100))}px`,
              }}
              className="bg-white text-slate-900 rounded shadow-2xl border border-slate-300 p-12 selectable-text prose prose-slate max-w-none"
            >
              <div className="flex justify-between items-center text-[11px] text-slate-400 border-b border-slate-200 pb-2 mb-6">
                <span>{file.originalName}</span>
                <span>
                  Page {idx + 1} of {payload.htmlPages.length}
                </span>
              </div>
              <div
                className="space-y-4 leading-relaxed [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:text-slate-900 [&_h1]:mb-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-slate-800 [&_h2]:mt-5 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-slate-300 [&_td]:p-2 [&_th]:border [&_th]:border-slate-300 [&_th]:p-2 [&_th]:bg-slate-100"
                dangerouslySetInnerHTML={{
                  __html: highlightHtml(pageHtml, tab.searchQuery),
                }}
              />
            </article>
          ))
        ) : (
          <article
            style={{
              maxWidth: `${Math.round(680 * (tab.zoom / 100))}px`,
              fontSize: `${Math.round(16 * (tab.zoom / 100))}px`,
            }}
            className="w-full bg-slate-900/90 text-slate-100 rounded-xl border border-slate-800 p-10 selectable-text shadow-xl"
          >
            <div
              className="space-y-4 leading-relaxed [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:text-white [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-blue-300 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-slate-700 [&_td]:p-2.5"
              dangerouslySetInnerHTML={{
                __html: highlightHtml(payload.fullHtml, tab.searchQuery),
              }}
            />
          </article>
        )}
      </div>
    </div>
  );
};
