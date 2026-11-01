import React, { useState } from 'react';
import {
  AlertOctagon,
  BookOpen,
  Bookmark,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FolderArchive,
  Grid,
  Lock,
  Music,
  Play,
  RotateCw,
  ServerCog,
  ShieldAlert,
  ShieldCheck,
  Video,
  WrapText,
} from 'lucide-react';
import type { DetectedFile, EbookTheme, TabViewerState } from '@omniview/shared-types';
import type { ViewerDocument } from '@omniview/viewer-core';
import type {
  ArchiveViewerPayload,
  CodeViewerPayload,
  EbookViewerPayload,
  FallbackViewerPayload,
  ImageViewerPayload,
  MediaViewerPayload,
} from '@omniview/viewer-adapters';
import { formatFileSize } from '@omniview/utilities';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';

const EMPTY_LIST: never[] = [];

// ============================================================================
// Image & Sanitized SVG Viewer
// ============================================================================
export const ImageViewer: React.FC<{
  file: DetectedFile;
  tab: TabViewerState;
  document: ViewerDocument<ImageViewerPayload>;
}> = ({ file, tab, document }) => {
  const updateTabState = useWorkspaceStore((s) => s.updateTabState);
  const [checkerboard, setCheckerboard] = useState<boolean>(true);
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null);
  const { payload } = document;

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-slate-950" data-testid="image-viewer-root">
      <div className="px-4 py-2 border-b border-slate-800 bg-slate-900/90 flex items-center justify-between text-xs text-slate-300">
        <div className="flex items-center gap-3">
          {payload.isSvg && (
            <span className="flex items-center gap-1 px-2.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[11px]">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>SVG Script-Sanitized Pipeline</span>
            </span>
          )}
          {dimensions && (
            <span className="font-mono text-slate-400">
              {dimensions.w} × {dimensions.h} px
            </span>
          )}
          <span className="font-mono text-slate-400">{formatFileSize(file.sizeBytes)}</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setCheckerboard((v) => !v)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs ${
              checkerboard ? 'bg-blue-600/25 text-blue-200 border border-blue-500/40' : 'bg-slate-800 text-slate-300'
            }`}
          >
            <Grid className="w-3.5 h-3.5" />
            <span>Transparency Grid</span>
          </button>
          <button
            onClick={() => updateTabState(tab.tabId, { rotation: (tab.rotation + 90) % 360 })}
            className="pulse-btn pulse-btn-ghost pulse-btn-sm flex items-center gap-1"
          >
            <RotateCw className="w-3.5 h-3.5" />
            <span>Rotate 90°</span>
          </button>
        </div>
      </div>

      <div
        className={`flex-1 overflow-auto p-8 flex items-center justify-center ${
          checkerboard ? 'checkerboard-bg' : 'bg-slate-950'
        }`}
      >
        <img
          src={payload.objectUrl}
          alt={file.originalName}
          onLoad={(e) =>
            setDimensions({
              w: e.currentTarget.naturalWidth,
              h: e.currentTarget.naturalHeight,
            })
          }
          style={{
            transform: `scale(${tab.zoom / 100}) rotate(${tab.rotation}deg)`,
            transformOrigin: 'center center',
          }}
          className="max-w-full max-h-full object-contain rounded shadow-2xl transition-transform duration-150"
        />
      </div>
    </div>
  );
};

// ============================================================================
// EPUB & FB2 eBook Viewer
// ============================================================================
export const EbookViewer: React.FC<{
  file: DetectedFile;
  tab: TabViewerState;
  document: ViewerDocument<EbookViewerPayload>;
}> = ({ file, tab, document }) => {
  const updateTabState = useWorkspaceStore((s) => s.updateTabState);
  const toggleBookmark = useWorkspaceStore((s) => s.toggleBookmark);
  const bookmarks = useWorkspaceStore((s) => s.bookmarksByFileId[file.id] ?? EMPTY_LIST);

  const chapters = document.payload.chapters;
  const currentIdx = Math.max(1, Math.min(chapters.length, tab.currentPage));
  const activeChapter = chapters[currentIdx - 1] ?? chapters[0];
  const ebookTheme: EbookTheme = tab.ebookTheme ?? 'dark';
  const fontSize = tab.ebookFontSize ?? 18;
  const isBookmarked = bookmarks.some((b) => b.position === currentIdx);

  const themeClasses: Record<EbookTheme, string> = {
    light: 'bg-stone-50 text-stone-900 border-stone-300',
    sepia: 'bg-[#f4ecd8] text-[#3b2f1e] border-[#d9c9a3]',
    dark: 'bg-slate-900 text-slate-100 border-slate-800',
  };

  return (
    <div className="flex h-full w-full overflow-hidden" data-testid="ebook-viewer-root">
      {/* Left Table of Contents */}
      {tab.showThumbnails && (
        <aside className="w-60 shrink-0 border-r border-slate-800 bg-slate-900/60 overflow-y-auto p-3 space-y-2">
          <div className="px-2 py-1">
            <div className="text-xs font-bold text-slate-100 truncate">
              {document.payload.bookTitle}
            </div>
            <div className="text-[11px] text-slate-400 truncate">
              {document.payload.author}
            </div>
          </div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 px-2 pt-2">
            Chapters ({chapters.length})
          </div>
          {chapters.map((ch, idx) => {
            const chNum = idx + 1;
            const isCurrent = chNum === currentIdx;
            return (
              <button
                key={ch.id}
                onClick={() => updateTabState(tab.tabId, { currentPage: chNum })}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs transition ${
                  isCurrent
                    ? 'bg-blue-600/20 border border-blue-500/40 text-blue-200 font-medium'
                    : 'hover:bg-slate-800/70 text-slate-400'
                }`}
              >
                {ch.title}
              </button>
            );
          })}
        </aside>
      )}

      {/* Reader Surface */}
      <div className="flex-1 flex flex-col overflow-hidden bg-slate-950">
        {/* Typography & Theme Controls */}
        <div className="px-6 py-2 border-b border-slate-800 bg-slate-900/90 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2 text-slate-400">
            <BookOpen className="w-4 h-4 text-blue-400" />
            <span>
              Chapter {currentIdx} of {chapters.length} ({Math.round((currentIdx / chapters.length) * 100)}% read)
            </span>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 bg-slate-950 border border-slate-800 rounded p-0.5">
              {(['light', 'sepia', 'dark'] as EbookTheme[]).map((t) => (
                <button
                  key={t}
                  onClick={() => updateTabState(tab.tabId, { ebookTheme: t })}
                  className={`px-2 py-0.5 rounded capitalize text-[11px] ${
                    ebookTheme === t ? 'bg-blue-600 text-slate-950' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1">
              <button
                onClick={() =>
                  updateTabState(tab.tabId, { ebookFontSize: Math.max(13, fontSize - 2) })
                }
                className="pulse-btn pulse-btn-ghost pulse-btn-sm"
              >
                A-
              </button>
              <span className="font-mono text-[11px] text-slate-300 w-9 text-center">
                {fontSize}px
              </span>
              <button
                onClick={() =>
                  updateTabState(tab.tabId, { ebookFontSize: Math.min(28, fontSize + 2) })
                }
                className="pulse-btn pulse-btn-ghost pulse-btn-sm"
              >
                A+
              </button>
            </div>

            <button
              onClick={() => toggleBookmark(file.id, currentIdx, activeChapter.title)}
              className="pulse-btn pulse-btn-ghost pulse-btn-sm flex items-center gap-1"
            >
              <Bookmark
                className={`w-3.5 h-3.5 ${
                  isBookmarked ? 'text-amber-400 fill-amber-400' : 'text-slate-400'
                }`}
              />
              <span>{isBookmarked ? 'Bookmarked' : 'Bookmark'}</span>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-8 flex justify-center">
          <article
            style={{ fontSize: `${fontSize}px`, maxWidth: '68ch' }}
            className={`w-full rounded-xl border p-10 shadow-xl leading-relaxed selectable-text space-y-4 ${themeClasses[ebookTheme]}`}
          >
            <div
              className="space-y-4 [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mb-4 [&_h2]:text-xl [&_h2]:font-semibold [&_p]:leading-relaxed"
              dangerouslySetInnerHTML={{ __html: activeChapter.htmlContent }}
            />
          </article>
        </div>

        <div className="h-11 border-t border-slate-800 bg-slate-900 px-6 flex items-center justify-between">
          <button
            disabled={currentIdx <= 1}
            onClick={() => updateTabState(tab.tabId, { currentPage: currentIdx - 1 })}
            className="pulse-btn pulse-btn-ghost pulse-btn-sm flex items-center gap-1"
          >
            <ChevronLeft className="w-4 h-4" />
            <span>Previous Chapter</span>
          </button>
          <div className="w-48 h-1.5 rounded-full bg-slate-800 overflow-hidden">
            <div
              style={{ width: `${(currentIdx / chapters.length) * 100}%` }}
              className="h-full bg-blue-500"
            />
          </div>
          <button
            disabled={currentIdx >= chapters.length}
            onClick={() => updateTabState(tab.tabId, { currentPage: currentIdx + 1 })}
            className="pulse-btn pulse-btn-ghost pulse-btn-sm flex items-center gap-1"
          >
            <span>Next Chapter</span>
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Code & Developer File Viewer (with JSON Tree & .env Local-Only Safeguard)
// ============================================================================
export const CodeViewer: React.FC<{
  file: DetectedFile;
  tab: TabViewerState;
  document: ViewerDocument<CodeViewerPayload>;
}> = ({ tab, document }) => {
  const [wordWrap, setWordWrap] = useState<boolean>(true);
  const [viewMode, setViewMode] = useState<'code' | 'json-tree'>(
    document.payload.isJson ? 'json-tree' : 'code'
  );
  const [copied, setCopied] = useState<boolean>(false);
  const [maskEnvValues, setMaskEnvValues] = useState<boolean>(document.payload.isEnvFile);

  const { content, language, lineCount, encoding, isJson, parsedJson, isEnvFile } =
    document.payload;

  const lines = content.split(/\r?\n/);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-slate-950" data-testid="code-viewer-root">
      <div className="px-4 py-2 border-b border-slate-800 bg-slate-900/90 flex items-center justify-between text-xs">
        <div className="flex items-center gap-3 text-slate-400">
          <span className="px-2 py-0.5 rounded bg-blue-500/15 border border-blue-500/30 text-blue-300 font-mono uppercase text-[11px]">
            {language}
          </span>
          <span className="font-mono">{lineCount.toLocaleString()} lines</span>
          <span className="font-mono">{encoding}</span>
          <span className="text-emerald-400 text-[11px]">Read-Only (Code Execution Disabled)</span>
        </div>

        <div className="flex items-center gap-2">
          {isEnvFile && (
            <button
              onClick={() => setMaskEnvValues((v) => !v)}
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-amber-500/20 border border-amber-500/40 text-amber-200 text-xs"
            >
              <Lock className="w-3.5 h-3.5" />
              <span>{maskEnvValues ? 'Reveal .env Secrets' : 'Mask .env Secrets'}</span>
            </button>
          )}
          {isJson && (
            <div className="flex items-center bg-slate-950 border border-slate-800 rounded p-0.5">
              <button
                onClick={() => setViewMode('json-tree')}
                className={`px-2.5 py-0.5 rounded text-[11px] ${
                  viewMode === 'json-tree' ? 'bg-blue-600 text-slate-950' : 'text-slate-400'
                }`}
              >
                JSON Tree
              </button>
              <button
                onClick={() => setViewMode('code')}
                className={`px-2.5 py-0.5 rounded text-[11px] ${
                  viewMode === 'code' ? 'bg-blue-600 text-slate-950' : 'text-slate-400'
                }`}
              >
                Raw Source
              </button>
            </div>
          )}
          <button
            onClick={() => setWordWrap((w) => !w)}
            className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs ${
              wordWrap ? 'bg-blue-600/20 text-blue-200 border border-blue-500/30' : 'bg-slate-800 text-slate-300'
            }`}
          >
            <WrapText className="w-3.5 h-3.5" />
            <span>Wrap</span>
          </button>
          <button
            onClick={() => void handleCopy()}
            className="pulse-btn pulse-btn-ghost pulse-btn-sm flex items-center gap-1"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 font-mono text-xs selectable-text">
        {viewMode === 'json-tree' && isJson ? (
          <div className="p-4 rounded-lg bg-slate-900/70 border border-slate-800">
            <pre className="text-blue-200 leading-relaxed">
              {JSON.stringify(parsedJson, null, 2)}
            </pre>
          </div>
        ) : (
          <table className="w-full border-collapse">
            <tbody>
              {lines.map((line, idx) => {
                const lineNum = idx + 1;
                const displayLine =
                  maskEnvValues && line.includes('=') && !line.trim().startsWith('#')
                    ? `${line.split('=')[0]}=••••••••••••••••`
                    : line;
                const q = tab.searchQuery.trim().toLowerCase();
                const isMatch = q.length > 0 && line.toLowerCase().includes(q);

                return (
                  <tr
                    key={lineNum}
                    className={
                      isMatch
                        ? 'bg-amber-500/20 text-amber-100'
                        : 'hover:bg-slate-900/60 text-slate-200'
                    }
                  >
                    <td className="w-12 pr-4 py-0.5 text-right text-slate-600 select-none border-r border-slate-800/80">
                      {lineNum}
                    </td>
                    <td
                      style={{ fontSize: `${Math.round(12 * (tab.zoom / 100))}px` }}
                      className={`pl-4 py-0.5 ${
                        wordWrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'
                      }`}
                    >
                      {displayLine || ' '}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// Audio & Video Media Viewer
// ============================================================================
export const MediaViewer: React.FC<{
  file: DetectedFile;
  document: ViewerDocument<MediaViewerPayload>;
}> = ({ file, document }) => {
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const mediaRef = React.useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const { objectUrl, isVideo, mimeType } = document.payload;

  const changeSpeed = (rate: number) => {
    setPlaybackRate(rate);
    if (mediaRef.current) {
      mediaRef.current.playbackRate = rate;
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-full w-full p-8 bg-slate-950" data-testid="media-viewer-root">
      <div className="max-w-3xl w-full rounded-2xl border border-slate-800 bg-slate-900/90 p-8 shadow-2xl space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-xl bg-blue-600/20 border border-blue-500/30 text-blue-400">
              {isVideo ? <Video className="w-6 h-6" /> : <Music className="w-6 h-6" />}
            </div>
            <div>
              <h3 className="text-base font-semibold text-white">{file.originalName}</h3>
              <p className="text-xs text-slate-400 font-mono">
                {mimeType} • {formatFileSize(file.sizeBytes)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-xs text-slate-400 mr-1">Speed:</span>
            {[0.5, 1, 1.25, 1.5, 2].map((rate) => (
              <button
                key={rate}
                onClick={() => changeSpeed(rate)}
                className={`px-2 py-1 rounded text-xs font-mono ${
                  playbackRate === rate
                    ? 'bg-blue-600 text-slate-950'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                {rate}x
              </button>
            ))}
          </div>
        </div>

        {isVideo ? (
          <video
            ref={mediaRef as React.RefObject<HTMLVideoElement>}
            src={objectUrl}
            controls
            className="w-full rounded-xl bg-black max-h-[60vh] border border-slate-800"
          />
        ) : (
          <div className="space-y-4">
            {/* Deterministic Waveform Bars Visualization */}
            <div className="h-24 rounded-xl bg-slate-950 border border-slate-800 px-4 flex items-center justify-between gap-1">
              {Array.from({ length: 48 }, (_, i) => {
                const heightPct = 20 + Math.round(Math.abs(Math.sin(i * 0.45) * Math.cos(i * 0.2)) * 75);
                return (
                  <div
                    key={i}
                    style={{ height: `${heightPct}%` }}
                    className="flex-1 rounded-full bg-slate-300"
                  />
                );
              })}
            </div>
            <audio
              ref={mediaRef as React.RefObject<HTMLAudioElement>}
              src={objectUrl}
              controls
              className="w-full"
            />
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// Secure Archive Viewer (.zip, .tar, .gz)
// ============================================================================
export const ArchiveViewer: React.FC<{
  file: DetectedFile;
  tab: TabViewerState;
  document: ViewerDocument<ArchiveViewerPayload>;
}> = ({ file, tab, document }) => {
  const importFiles = useWorkspaceStore((s) => s.importFiles);
  const { entries, totalCompressedBytes, totalUncompressedBytes, securityWarnings, extractEntry } =
    document.payload;

  const filteredEntries = entries.filter(
    (e) => !tab.searchQuery.trim() || e.path.toLowerCase().includes(tab.searchQuery.toLowerCase())
  );

  const handlePreviewEntry = async (entryPath: string, name: string) => {
    const bytes = await extractEntry(entryPath);
    await importFiles([{ name, bytes }], 'archive-entry', true);
  };

  const handleDownloadEntry = async (entryPath: string, name: string) => {
    const bytes = await extractEntry(entryPath);
    const blob = new Blob([bytes as unknown as BlobPart]);
    const url = URL.createObjectURL(blob);
    const a = window.document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-slate-950 p-6" data-testid="archive-viewer-root">
      <div className="max-w-5xl w-full mx-auto flex-1 flex flex-col rounded-xl border border-slate-800 bg-slate-900/70 overflow-hidden shadow-xl">
        <div className="px-6 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <FolderArchive className="w-6 h-6 text-amber-400" />
            <div>
              <h3 className="text-sm font-semibold text-white">{file.originalName}</h3>
              <p className="text-xs text-slate-400">
                {entries.length} entries • Compressed: {formatFileSize(totalCompressedBytes)} •
                Uncompressed: {formatFileSize(totalUncompressedBytes)}
              </p>
            </div>
          </div>

          {securityWarnings.length > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-rose-500/15 border border-rose-500/40 text-rose-200 text-xs">
              <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{securityWarnings[0]}</span>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-950/80 text-slate-400 sticky top-0">
              <tr>
                <th className="px-6 py-2.5 font-medium">Archive Path</th>
                <th className="px-4 py-2.5 font-medium">Type</th>
                <th className="px-4 py-2.5 font-medium text-right">Uncompressed</th>
                <th className="px-4 py-2.5 font-medium">Security Check</th>
                <th className="px-6 py-2.5 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {filteredEntries.map((entry) => (
                <tr key={entry.path} className="hover:bg-slate-800/40">
                  <td className="px-6 py-2.5 font-mono text-slate-200">{entry.path}</td>
                  <td className="px-4 py-2.5 uppercase font-mono text-slate-400">
                    {entry.isDirectory ? 'DIR' : entry.extension || 'FILE'}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-slate-300">
                    {entry.isDirectory ? '—' : formatFileSize(entry.uncompressedSize)}
                  </td>
                  <td className="px-4 py-2.5">
                    {entry.safetyStatus === 'safe' ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 text-[11px]">
                        <ShieldCheck className="w-3 h-3" /> Safe
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 text-[11px]">
                        <ShieldAlert className="w-3 h-3" /> Blocked ({entry.safetyStatus})
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-2.5 text-right space-x-2">
                    {!entry.isDirectory && entry.safetyStatus === 'safe' && (
                      <>
                        <button
                          onClick={() => void handlePreviewEntry(entry.path, entry.name)}
                          className="pulse-btn pulse-btn-ghost pulse-btn-sm inline-flex items-center gap-1"
                        >
                          <ExternalLink className="w-3 h-3" />
                          <span>Preview in Tab</span>
                        </button>
                        <button
                          onClick={() => void handleDownloadEntry(entry.path, entry.name)}
                          className="pulse-btn pulse-btn-ghost pulse-btn-sm inline-flex items-center gap-1"
                        >
                          <Download className="w-3 h-3" />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Diagnostic Fallback Viewer (Never Returns a Blank Screen!)
// ============================================================================
export const FallbackViewer: React.FC<{
  file: DetectedFile;
  document: ViewerDocument<FallbackViewerPayload>;
}> = ({ file, document }) => {
  const requestServerConversion = useWorkspaceStore((s) => s.requestServerConversion);
  const conversionJob = useWorkspaceStore((s) => s.conversionJobs[file.id]);
  const { reason, hexPreview, asciiPreview, canRequestRemoteConversion } = document.payload;

  return (
    <div className="flex items-center justify-center h-full w-full p-8 overflow-auto bg-slate-950" data-testid="fallback-viewer-root">
      <div className="max-w-3xl w-full rounded-2xl border border-amber-500/30 bg-slate-900/90 p-8 shadow-2xl space-y-6">
        <div className="flex items-start gap-4">
          <div className="p-3 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400">
            <AlertOctagon className="w-7 h-7" />
          </div>
          <div className="space-y-1 flex-1">
            <h3 className="text-lg font-semibold text-white">
              Native Browser Preview Unavailable — Diagnostic Inspector Active
            </h3>
            <p className="text-xs text-slate-300 leading-relaxed">{reason}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
            <div className="text-slate-500 text-[11px]">File Name</div>
            <div className="font-medium text-slate-200 truncate">{file.originalName}</div>
          </div>
          <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
            <div className="text-slate-500 text-[11px]">Detected MIME</div>
            <div className="font-mono text-slate-200 truncate">{file.detectedMimeType}</div>
          </div>
          <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
            <div className="text-slate-500 text-[11px]">Magic Signature</div>
            <div className="font-mono text-amber-300 truncate">{file.magicSignatureHex || 'N/A'}</div>
          </div>
          <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
            <div className="text-slate-500 text-[11px]">SHA-256 Checksum</div>
            <div className="font-mono text-slate-200 truncate">{file.checksum.slice(0, 16)}…</div>
          </div>
        </div>

        {canRequestRemoteConversion && (
          <div className="p-4 rounded-xl border border-blue-500/30 bg-blue-950/20 flex items-center justify-between gap-4">
            <div className="text-xs text-slate-300">
              <strong className="text-white block mb-0.5">
                Isolated Server-Side Conversion Available
              </strong>
              This format requires uploading the file to the sandboxed LibreOffice headless worker.
            </div>
            <button
              onClick={() => void requestServerConversion(file.id)}
              className="pulse-btn pulse-btn-sm flex items-center gap-1.5 shrink-0"
            >
              <ServerCog className="w-4 h-4" />
              <span>
                {conversionJob?.status === 'processing'
                  ? 'Converting...'
                  : 'Authorize Remote Conversion'}
              </span>
            </button>
          </div>
        )}

        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">
            Binary Header Inspection (First 512 Bytes — Hex & ASCII)
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 bg-slate-950 border border-slate-800 rounded-xl p-4 font-mono text-[11px] max-h-60 overflow-auto selectable-text">
            <pre className="md:col-span-2 text-blue-300 leading-relaxed">{hexPreview}</pre>
            <pre className="text-emerald-300 leading-relaxed border-l border-slate-800 pl-3">
              {asciiPreview}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};
