import React, { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import {
  AlertTriangle,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Lock,
  MessageSquare,
  Sparkles,
} from 'lucide-react';
import type {
  DetectedFile,
  DocumentAnnotation,
  NormalizedPoint,
  NormalizedRect,
  SearchMatch,
  TabViewerState,
} from '@omniview/shared-types';
import { createSearchMatcher } from '@omniview/viewer-core';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';

const EMPTY_LIST: never[] = [];

// Configure PDF.js worker using Vite URL import with safe fallback
try {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
  ).toString();
} catch {
  // Fallback handled by pdfjs disableWorker option if needed
}

interface PDFViewerProps {
  file: DetectedFile;
  tab: TabViewerState;
  buffer: ArrayBuffer;
}

interface PageTextData {
  pageNumber: number;
  text: string;
}

export const PDFViewer: React.FC<PDFViewerProps> = ({ file, tab, buffer }) => {
  const updateTabState = useWorkspaceStore((s) => s.updateTabState);
  const annotations = useWorkspaceStore((s) => s.annotationsByFileId[file.id] ?? EMPTY_LIST);
  const addAnnotation = useWorkspaceStore((s) => s.addAnnotation);
  const toggleBookmark = useWorkspaceStore((s) => s.toggleBookmark);
  const bookmarks = useWorkspaceStore((s) => s.bookmarksByFileId[file.id] ?? EMPTY_LIST);

  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pageTexts, setPageTexts] = useState<PageTextData[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [needsPassword, setNeedsPassword] = useState<boolean>(false);
  const [passwordInput, setPasswordInput] = useState<string>('');

  // ---- Continuous ("Scroll") layout: keep the scroll position and currentPage in sync.
  // `pageFromScroll` marks a page change that came from scrolling, so the
  // scroll-to-page effect does not jump back while the user is scrolling.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const thumbsRef = useRef<HTMLElement | null>(null);
  const pageFromScroll = useRef<number | null>(null);
  const isContinuous = tab.pdfViewMode === 'continuous';

  const pageElement = (n: number) =>
    scrollRef.current?.querySelector<HTMLElement>(`[data-testid="pdf-page-${n}"]`) ?? null;

  // currentPage -> scroll (toolbar, page field, thumbnails, arrow keys, search)
  useEffect(() => {
    if (!isContinuous || loading) return;
    if (pageFromScroll.current === tab.currentPage) {
      pageFromScroll.current = null;
      return;
    }
    const container = scrollRef.current;
    const el = pageElement(tab.currentPage);
    if (!container || !el) return;
    const top = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 16;
    const reduce = document.documentElement.classList.contains('reduce-motion') ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    container.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
  }, [tab.currentPage, isContinuous, loading, pdfDoc]);

  // scroll -> currentPage: the page crossing the upper third of the viewport is current
  useEffect(() => {
    const container = scrollRef.current;
    if (!isContinuous || loading || !container) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const probe = container.getBoundingClientRect().top + container.clientHeight / 3;
        const pages = container.querySelectorAll<HTMLElement>('[data-testid^="pdf-page-"]');
        let current = 1;
        pages.forEach((el) => {
          if (el.getBoundingClientRect().top <= probe) {
            current = Number(el.dataset.testid?.replace('pdf-page-', '')) || current;
          }
        });
        const latest = useWorkspaceStore.getState().tabs.find((t) => t.tabId === tab.tabId);
        if (latest && latest.currentPage !== current) {
          pageFromScroll.current = current;
          updateTabState(tab.tabId, { currentPage: current });
        }
      });
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, [isContinuous, loading, pdfDoc, tab.tabId, updateTabState]);

  // Keep the active thumbnail visible.
  useEffect(() => {
    thumbsRef.current
      ?.querySelector<HTMLElement>(`[data-testid="pdf-thumbnail-${tab.currentPage}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [tab.currentPage]);

  // Interactive Normalized Annotation Drawing State
  const [drawingPage, setDrawingPage] = useState<number | null>(null);
  const [dragStart, setDragStart] = useState<NormalizedPoint | null>(null);
  const [dragCurrent, setDragCurrent] = useState<NormalizedPoint | null>(null);
  const [freehandPoints, setFreehandPoints] = useState<NormalizedPoint[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNeedsPassword(false);

    const loadPdf = async () => {
      try {
        // Clone buffer so PDF.js worker transfer doesn't detach the store's ArrayBuffer
        const copy = buffer.slice(0);
        const loadingTask = pdfjsLib.getDocument({
          data: new Uint8Array(copy),
          password: passwordInput || undefined,
        });

        const doc = await loadingTask.promise;
        if (cancelled) return;

        setPdfDoc(doc);
        updateTabState(tab.tabId, { totalPages: doc.numPages });

        // Extract text streams per page for search and fallback readable text layer
        const extracted: PageTextData[] = [];
        const maxInitialExtract = Math.min(doc.numPages, 150);
        for (let p = 1; p <= maxInitialExtract; p++) {
          const page = await doc.getPage(p);
          const textContent = await page.getTextContent();
          const strings = textContent.items
            .map((item) => ('str' in item ? item.str : ''))
            .join(' ');
          extracted.push({ pageNumber: p, text: strings });
        }

        if (!cancelled) {
          setPageTexts(extracted);
          // Also populate the store's loadedDocument search function so toolbar search works seamlessly
          const loadedDoc = useWorkspaceStore.getState().loadedDocuments[file.id];
          if (loadedDoc) {
            const unitStrings = extracted.map((e) => e.text);
            loadedDoc.unitCount = doc.numPages;
            loadedDoc.extractedTextByUnit = unitStrings;
            loadedDoc.search = createSearchMatcher(file.id, 'Page', unitStrings);
          }
          setLoading(false);
        }
      } catch (err: unknown) {
        if (cancelled) return;
        const e = err as { name?: string; message?: string };
        if (e?.name === 'PasswordException') {
          setNeedsPassword(true);
          setLoading(false);
          return;
        }
        setError(e?.message || 'Unable to parse PDF binary stream');
        setLoading(false);
      }
    };

    void loadPdf();
    return () => {
      cancelled = true;
    };
  }, [buffer, file.id, passwordInput]);

  const handleMouseDown = (
    e: React.MouseEvent<HTMLDivElement>,
    pageNumber: number
  ) => {
    if (tab.activeAnnotationTool === 'select') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

    if (tab.activeAnnotationTool === 'note') {
      const comment = window.prompt('Enter annotation note text:', 'Review this section');
      if (comment) {
        addAnnotation(file.id, {
          pageNumber,
          type: 'note',
          color: tab.activeAnnotationColor,
          rect: { x: nx, y: ny, width: 0.04, height: 0.04 },
          comment,
          author: 'Local Reviewer',
        });
      }
      return;
    }

    setDrawingPage(pageNumber);
    setDragStart({ x: nx, y: ny });
    setDragCurrent({ x: nx, y: ny });
    if (tab.activeAnnotationTool === 'freehand') {
      setFreehandPoints([{ x: nx, y: ny }]);
    }
  };

  const handleMouseMove = (
    e: React.MouseEvent<HTMLDivElement>,
    pageNumber: number
  ) => {
    if (drawingPage !== pageNumber || !dragStart) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    setDragCurrent({ x: nx, y: ny });
    if (tab.activeAnnotationTool === 'freehand') {
      setFreehandPoints((prev) => [...prev, { x: nx, y: ny }]);
    }
  };

  const handleMouseUp = (pageNumber: number) => {
    if (drawingPage !== pageNumber || !dragStart || !dragCurrent) return;

    if (tab.activeAnnotationTool === 'freehand' && freehandPoints.length > 2) {
      addAnnotation(file.id, {
        pageNumber,
        type: 'freehand',
        color: tab.activeAnnotationColor,
        points: freehandPoints,
        comment: 'Freehand ink annotation',
        author: 'Local Reviewer',
      });
    } else {
      const x = Math.min(dragStart.x, dragCurrent.x);
      const y = Math.min(dragStart.y, dragCurrent.y);
      const width = Math.max(0.03, Math.abs(dragCurrent.x - dragStart.x));
      const height = Math.max(0.02, Math.abs(dragCurrent.y - dragStart.y));
      const normRect: NormalizedRect = { x, y, width, height };

      addAnnotation(file.id, {
        pageNumber,
        type: tab.activeAnnotationTool === 'select' ? 'highlight' : tab.activeAnnotationTool,
        color: tab.activeAnnotationColor,
        rect: normRect,
        comment: `${tab.activeAnnotationTool.toUpperCase()} on Page ${pageNumber}`,
        author: 'Local Reviewer',
      });
    }

    setDrawingPage(null);
    setDragStart(null);
    setDragCurrent(null);
    setFreehandPoints([]);
  };

  if (needsPassword) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <div className="max-w-md w-full rounded-xl border border-slate-700/80 bg-slate-900/90 p-6 shadow-xl">
          <Lock className="w-10 h-10 text-amber-400 mx-auto mb-3" />
          <h3 className="text-lg font-semibold text-slate-100 mb-1">
            Password-Protected PDF Document
          </h3>
          <p className="text-xs text-slate-400 mb-4">
            "{file.originalName}" is encrypted. Enter the document password to unlock local PDF.js rendering.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const input = (e.currentTarget.elements.namedItem('pdfPass') as HTMLInputElement).value;
              setPasswordInput(input);
            }}
            className="flex gap-2"
          >
            <input
              name="pdfPass"
              type="password"
              placeholder="Document password..."
              className="flex-1 rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-blue-500"
            />
            <button
              type="submit"
              className="pulse-btn pulse-btn-sm"
            >
              Unlock
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-400">
        <span className="px-spinner" role="status" aria-label="Loading"><i /><i /><i /><i /><i /><i /><i /><i /><i /></span>
        <p className="text-xs font-medium">Rendering PDF pages via Mozilla PDF.js...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <div className="max-w-md rounded-xl border border-rose-500/40 bg-rose-950/20 p-6 text-center">
          <AlertTriangle className="w-10 h-10 text-rose-400 mx-auto mb-3" />
          <h3 className="text-base font-semibold text-rose-200 mb-1">PDF Rendering Error</h3>
          <p className="text-xs text-rose-300/80 mb-3">{error}</p>
          <p className="text-[11px] text-slate-400">
            Magic Signature: <code className="text-slate-300">{file.magicSignatureHex}</code>
          </p>
        </div>
      </div>
    );
  }

  const totalPages = pdfDoc?.numPages ?? tab.totalPages;
  const pagesToDisplay: number[] =
    tab.pdfViewMode === 'single'
      ? [tab.currentPage]
      : tab.pdfViewMode === 'facing'
      ? [
          tab.currentPage,
          ...(tab.currentPage + 1 <= totalPages ? [tab.currentPage + 1] : []),
        ]
      : Array.from({ length: totalPages }, (_, i) => i + 1);

  return (
    <div className="flex h-full w-full overflow-hidden" data-testid="pdf-viewer-root">
      {/* Left Page Thumbnail Strip */}
      {tab.showThumbnails && (
        <aside ref={thumbsRef} className="w-44 shrink-0 border-r border-slate-800/80 bg-slate-900/50 overflow-y-auto p-3 space-y-2.5">
          <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-slate-400 px-1">
            <span>Pages ({totalPages})</span>
          </div>
          {Array.from({ length: totalPages }, (_, idx) => {
            const pageNum = idx + 1;
            const isCurrent = tab.currentPage === pageNum;
            const isBookmarked = bookmarks.some((b) => b.position === pageNum);
            const pageText = pageTexts.find((p) => p.pageNumber === pageNum)?.text ?? '';
            return (
              <button
                key={pageNum}
                onClick={() => updateTabState(tab.tabId, { currentPage: pageNum })}
                data-testid={`pdf-thumbnail-${pageNum}`}
                className={`w-full text-left rounded-lg p-2 border transition ${
                  isCurrent
                    ? 'border-blue-500 bg-blue-500/10 text-blue-200'
                    : 'border-slate-800 bg-slate-950/60 hover:border-slate-700 text-slate-400'
                }`}
              >
                <div className="flex items-center justify-between text-xs font-medium mb-1">
                  <span>Page {pageNum}</span>
                  {isBookmarked && <Bookmark className="w-3 h-3 text-amber-400 fill-amber-400" />}
                </div>
                <div className="h-20 rounded bg-white text-slate-800 p-1.5 text-[7px] leading-tight overflow-hidden font-mono select-none shadow-inner">
                  {pageText.slice(0, 180) || `PDF Page ${pageNum}`}
                </div>
              </button>
            );
          })}
        </aside>
      )}

      {/* Main Scrollable PDF Viewport */}
      <div ref={scrollRef} className="flex-1 overflow-auto p-6 flex flex-col items-center gap-6 bg-slate-950/60">
        {tab.activeAnnotationTool !== 'select' && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-sm border border-slate-700 text-xs text-slate-200">
            <Sparkles className="w-3.5 h-3.5 text-blue-400" />
            <span>
              Annotation Mode: <strong className="uppercase">{tab.activeAnnotationTool}</strong> —
              Click or drag on any page (normalized [0..1] zoom-invariant coordinates)
            </span>
          </div>
        )}

        <div
          className={`flex ${
            tab.pdfViewMode === 'facing'
              ? 'flex-row flex-wrap justify-center gap-6'
              : 'flex-col items-center gap-6'
          }`}
        >
          {pagesToDisplay.map((pageNum) => {
            const pageText = pageTexts.find((p) => p.pageNumber === pageNum)?.text ?? '';
            const pageAnnotations = annotations.filter(
              (a) => a.pageNumber === pageNum && a.fileChecksum === file.checksum
            );
            const isBookmarked = bookmarks.some((b) => b.position === pageNum);

            return (
              <PDFPageSurface
                key={pageNum}
                pdfDoc={pdfDoc}
                pageNumber={pageNum}
                zoom={tab.zoom}
                rotation={tab.rotation}
                searchQuery={tab.searchQuery}
                extractedText={pageText}
                annotations={pageAnnotations}
                showAnnotations={tab.showAnnotations}
                isBookmarked={isBookmarked}
                onToggleBookmark={() =>
                  toggleBookmark(file.id, pageNum, `Page ${pageNum}`)
                }
                onMouseDown={(e) => handleMouseDown(e, pageNum)}
                onMouseMove={(e) => handleMouseMove(e, pageNum)}
                onMouseUp={() => handleMouseUp(pageNum)}
                activePreviewRect={
                  drawingPage === pageNum && dragStart && dragCurrent
                    ? {
                        x: Math.min(dragStart.x, dragCurrent.x),
                        y: Math.min(dragStart.y, dragCurrent.y),
                        width: Math.abs(dragCurrent.x - dragStart.x),
                        height: Math.abs(dragCurrent.y - dragStart.y),
                      }
                    : null
                }
              />
            );
          })}
        </div>

        {/* Single / Facing Page Bottom Pager */}
        {tab.pdfViewMode !== 'continuous' && (
          <div className="flex items-center gap-3 bg-slate-900 border border-slate-800 px-4 py-2 rounded-full shadow-lg">
            <button
              disabled={tab.currentPage <= 1}
              onClick={() =>
                updateTabState(tab.tabId, { currentPage: Math.max(1, tab.currentPage - 1) })
              }
              className="p-1 rounded hover:bg-slate-800 disabled:opacity-40"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-medium">
              Page {tab.currentPage} of {totalPages}
            </span>
            <button
              disabled={tab.currentPage >= totalPages}
              onClick={() =>
                updateTabState(tab.tabId, {
                  currentPage: Math.min(totalPages, tab.currentPage + 1),
                })
              }
              className="p-1 rounded hover:bg-slate-800 disabled:opacity-40"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

interface PDFPageSurfaceProps {
  pdfDoc: pdfjsLib.PDFDocumentProxy | null;
  pageNumber: number;
  zoom: number;
  rotation: number;
  searchQuery: string;
  extractedText: string;
  annotations: DocumentAnnotation[];
  showAnnotations: boolean;
  isBookmarked: boolean;
  onToggleBookmark: () => void;
  onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  onMouseMove: (e: React.MouseEvent<HTMLDivElement>) => void;
  onMouseUp: () => void;
  activePreviewRect: NormalizedRect | null;
}

const PDFPageSurface: React.FC<PDFPageSurfaceProps> = ({
  pdfDoc,
  pageNumber,
  zoom,
  rotation,
  searchQuery,
  extractedText,
  annotations,
  showAnnotations,
  isBookmarked,
  onToggleBookmark,
  onMouseDown,
  onMouseMove,
  onMouseUp,
  activePreviewRect,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scale = zoom / 100;
  const baseWidth = 612 * scale;
  const baseHeight = 792 * scale;

  useEffect(() => {
    let renderTask: pdfjsLib.RenderTask | null = null;
    let cancelled = false;

    const renderCanvas = async () => {
      if (!pdfDoc || !canvasRef.current) return;
      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (cancelled || !canvasRef.current) return;
        const viewport = page.getViewport({ scale: scale * 1.25, rotation });
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        renderTask = page.render({
          canvasContext: ctx,
          viewport,
        });
        await renderTask.promise;
      } catch {
        // Ignore cancelled render task
      }
    };

    void renderCanvas();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdfDoc, pageNumber, scale, rotation]);

  const highlightTextMatches = (text: string, query: string) => {
    if (!query.trim()) return text;
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
    return parts.map((part, i) =>
      part.toLowerCase() === query.toLowerCase() ? (
        <mark
          key={i}
          className="bg-amber-300 text-slate-950 font-semibold px-0.5 rounded"
        >
          {part}
        </mark>
      ) : (
        part
      )
    );
  };

  return (
    <div
      data-testid={`pdf-page-${pageNumber}`}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      style={{
        width: `${Math.round(baseWidth)}px`,
        minHeight: `${Math.round(baseHeight)}px`,
        transform: rotation ? `rotate(${rotation}deg)` : undefined,
      }}
      className="relative bg-white text-slate-900 rounded shadow-2xl border border-slate-300 overflow-hidden transition-all select-text"
    >
      {/* PDF.js Rasterized Canvas */}
      <canvas
        ref={canvasRef}
        className="w-full h-auto block pointer-events-none"
      />

      {/* Accessible & Selectable Text Layer Overlay (also ensures search highlights are visible) */}
      <div className="p-8 text-xs leading-relaxed text-slate-800/90 font-sans selectable-text">
        <div className="flex items-center justify-between border-b border-slate-200 pb-2 mb-3 text-[11px] text-slate-500">
          <span>
            PDF Page {pageNumber} • Zoom {zoom}%
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleBookmark();
            }}
            className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-slate-100 text-slate-600"
            title="Bookmark this page"
          >
            <Bookmark
              className={`w-3.5 h-3.5 ${
                isBookmarked ? 'text-amber-500 fill-amber-500' : 'text-slate-400'
              }`}
            />
            <span>{isBookmarked ? 'Bookmarked' : 'Bookmark'}</span>
          </button>
        </div>
        <p className="whitespace-pre-wrap">{highlightTextMatches(extractedText, searchQuery)}</p>
      </div>

      {/* Normalized Coordinate Annotation Overlay */}
      {showAnnotations && (
        <div className="absolute inset-0 pointer-events-none">
          {annotations.map((ann) => {
            if (ann.type === 'freehand' && ann.points && ann.points.length > 1) {
              const polyline = ann.points
                .map((pt) => `${pt.x * 100},${pt.y * 100}`)
                .join(' ');
              return (
                <svg
                  key={ann.id}
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  className="absolute inset-0 w-full h-full"
                >
                  <polyline
                    fill="none"
                    stroke={ann.color}
                    strokeWidth="0.8"
                    points={polyline}
                  />
                </svg>
              );
            }
            if (!ann.rect) return null;
            return (
              <div
                key={ann.id}
                data-testid={`pdf-annotation-${ann.id}`}
                style={{
                  left: `${ann.rect.x * 100}%`,
                  top: `${ann.rect.y * 100}%`,
                  width: `${ann.rect.width * 100}%`,
                  height: `${ann.rect.height * 100}%`,
                  backgroundColor:
                    ann.type === 'highlight' ? `${ann.color}44` : 'transparent',
                  borderColor: ann.color,
                  borderBottomWidth: ann.type === 'underline' ? '3px' : undefined,
                  borderWidth:
                    ann.type === 'rectangle' || ann.type === 'note' ? '2px' : undefined,
                }}
                className="absolute rounded-sm flex items-start justify-end p-0.5"
                title={`${ann.type}: ${ann.comment || ''} (Normalized: ${ann.rect.x.toFixed(2)}, ${ann.rect.y.toFixed(2)})`}
              >
                {ann.type === 'note' && (
                  <div className="bg-amber-400 text-slate-950 rounded p-1 shadow">
                    <MessageSquare className="w-3 h-3" />
                  </div>
                )}
              </div>
            );
          })}

          {activePreviewRect && (
            <div
              style={{
                left: `${activePreviewRect.x * 100}%`,
                top: `${activePreviewRect.y * 100}%`,
                width: `${activePreviewRect.width * 100}%`,
                height: `${activePreviewRect.height * 100}%`,
              }}
              className="absolute border-2 border-dashed border-blue-500 bg-blue-500/20"
            />
          )}
        </div>
      )}
    </div>
  );
};
