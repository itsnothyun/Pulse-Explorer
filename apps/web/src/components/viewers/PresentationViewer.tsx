import React, { useState } from 'react';
import { Select } from '../pulse/Select';
import {
  ChevronLeft,
  ChevronRight,
  Info,
  Maximize2,
  MessageSquareText,
  MonitorPlay,
} from 'lucide-react';
import type { DetectedFile, TabViewerState } from '@omniview/shared-types';
import type { ViewerDocument } from '@omniview/viewer-core';
import type { PresentationViewerPayload } from '@omniview/viewer-adapters';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';

interface PresentationViewerProps {
  file: DetectedFile;
  tab: TabViewerState;
  document: ViewerDocument<PresentationViewerPayload>;
}

export const PresentationViewer: React.FC<PresentationViewerProps> = ({
  file,
  tab,
  document,
}) => {
  const updateTabState = useWorkspaceStore((s) => s.updateTabState);
  const setDistractionFree = useWorkspaceStore((s) => s.setDistractionFree);
  const [showSpeakerNotes, setShowSpeakerNotes] = useState<boolean>(true);
  const [darkStageBg, setDarkStageBg] = useState<boolean>(true);

  const slides = document.payload.slides;
  const currentSlideIndex = Math.max(1, Math.min(slides.length, tab.currentPage));
  const activeSlide = slides[currentSlideIndex - 1] ?? slides[0];

  const highlightText = (text: string) => {
    const q = tab.searchQuery.trim();
    if (!q) return text;
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
    return parts.map((p, i) =>
      p.toLowerCase() === q.toLowerCase() ? (
        <mark key={i} className="bg-amber-300 text-slate-950 px-1 rounded">
          {p}
        </mark>
      ) : (
        p
      )
    );
  };

  return (
    <div className="flex h-full w-full overflow-hidden" data-testid="presentation-viewer-root">
      {/* Left Vertical Slide Thumbnail Strip */}
      {tab.showThumbnails && (
        <aside className="w-56 shrink-0 border-r border-slate-800/80 bg-slate-900/60 overflow-y-auto p-3 space-y-2.5">
          <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-slate-400 px-1">
            <span>Slides ({slides.length})</span>
            <span>16:9</span>
          </div>

          {slides.map((slide) => {
            const isCurrent = slide.index === currentSlideIndex;
            return (
              <button
                key={slide.index}
                data-testid={`slide-thumbnail-${slide.index}`}
                onClick={() => updateTabState(tab.tabId, { currentPage: slide.index })}
                className={`w-full text-left rounded-lg p-2 border transition ${
                  isCurrent
                    ? 'border-blue-500 bg-blue-500/15 text-blue-100 shadow'
                    : 'border-slate-800 bg-slate-950/60 hover:border-slate-700 text-slate-400'
                }`}
              >
                <div className="flex items-center justify-between text-[11px] font-semibold mb-1.5">
                  <span>Slide {slide.index}</span>
                </div>
                <div className="aspect-video rounded bg-slate-900 border border-slate-700/70 p-2 flex flex-col justify-between overflow-hidden">
                  <div className="text-[10px] font-semibold text-white line-clamp-2 leading-snug">
                    {slide.title}
                  </div>
                  <div className="text-[8px] text-slate-400 truncate">
                    {slide.elements.length} elements
                  </div>
                </div>
              </button>
            );
          })}
        </aside>
      )}

      {/* Central Presentation Stage & Bottom Controls */}
      <div
        className={`flex-1 flex flex-col overflow-hidden ${
          darkStageBg ? 'bg-slate-950' : 'bg-slate-200'
        }`}
      >
        {/* Fidelity Warning Banner */}
        <div className="px-4 py-2 bg-slate-900/90 border-b border-slate-800 flex items-center justify-between text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <Info className="w-3.5 h-3.5 text-blue-400 shrink-0" />
            <span>
              {document.fidelityWarning ||
                'Static slide appearance preserved; PowerPoint transitions, animations, and macros are not executed.'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setDarkStageBg((v) => !v)}
              className="pulse-btn pulse-btn-ghost pulse-btn-sm"
            >
              {darkStageBg ? 'Light Backdrop' : 'Dark Backdrop'}
            </button>
            <button
              onClick={() => setShowSpeakerNotes((v) => !v)}
              className="pulse-btn pulse-btn-ghost pulse-btn-sm flex items-center gap-1"
            >
              <MessageSquareText className="w-3.5 h-3.5 text-blue-400" />
              <span>Speaker Notes</span>
            </button>
            <button
              onClick={() => setDistractionFree(true)}
              className="pulse-btn pulse-btn-sm flex items-center gap-1"
            >
              <MonitorPlay className="w-3.5 h-3.5" />
              <span>Present Fullscreen</span>
            </button>
          </div>
        </div>

        {/* Main 16:9 Slide Canvas */}
        <div className="flex-1 overflow-auto p-8 flex items-center justify-center">
          <div
            data-testid={`slide-stage-${activeSlide.index}`}
            style={{
              width: `${Math.round(860 * (tab.zoom / 100))}px`,
              minHeight: `${Math.round(484 * (tab.zoom / 100))}px`,
            }}
            className="aspect-video bg-slate-900 text-slate-100 rounded-xl shadow-2xl border border-slate-700/80 p-10 flex flex-col justify-between selectable-text relative overflow-hidden"
          >
            {/* Subtle top accent bar */}
            <div className="absolute top-0 left-0 right-0 h-1.5 bg-slate-50" />

            <div className="space-y-6">
              <div className="flex items-start justify-between gap-4 border-b border-slate-800 pb-4">
                <h2 className="text-2xl font-bold tracking-tight text-white">
                  {highlightText(activeSlide.title)}
                </h2>
                <span className="px-2.5 py-1 rounded-sm border border-slate-700 text-slate-300 text-xs font-mono shrink-0">
                  Slide {activeSlide.index} / {slides.length}
                </span>
              </div>

              <div className="space-y-4">
                {activeSlide.elements
                  .filter((el) => el.type !== 'title')
                  .map((el) => {
                    if (el.type === 'body' && el.bullets) {
                      return (
                        <ul key={el.id} className="space-y-2.5 pl-5 list-disc text-slate-200 text-sm">
                          {el.bullets.map((b, i) => (
                            <li key={i} className="leading-relaxed">
                              {highlightText(b)}
                            </li>
                          ))}
                        </ul>
                      );
                    }
                    if (el.type === 'table' && el.tableRows) {
                      return (
                        <div
                          key={el.id}
                          className="overflow-hidden rounded-lg border border-slate-700/80 bg-slate-950/50 mt-4"
                        >
                          <table className="w-full text-left text-xs">
                            <tbody>
                              {el.tableRows.map((row, rIdx) => (
                                <tr
                                  key={rIdx}
                                  className={
                                    rIdx === 0
                                      ? 'bg-blue-950/60 font-semibold text-blue-200'
                                      : 'border-t border-slate-800 text-slate-300'
                                  }
                                >
                                  {row.map((cell, cIdx) => (
                                    <td key={cIdx} className="px-3 py-2">
                                      {highlightText(cell)}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      );
                    }
                    return null;
                  })}
              </div>
            </div>

            <div className="flex items-center justify-between pt-4 border-t border-slate-800/80 text-[11px] text-slate-400">
              <span>{file.originalName}</span>
              <span>Pulse presentation engine</span>
            </div>
          </div>
        </div>

        {/* Speaker Notes Drawer */}
        {showSpeakerNotes && (
          <div className="h-28 shrink-0 border-t border-slate-800 bg-slate-900/95 px-6 py-3 overflow-y-auto">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-blue-400 mb-1">
              Speaker Notes — Slide {activeSlide.index}
            </div>
            <p className="text-xs text-slate-300 leading-relaxed selectable-text">
              {activeSlide.speakerNotes
                ? highlightText(activeSlide.speakerNotes)
                : 'No speaker notes attached to this slide.'}
            </p>
          </div>
        )}

        {/* Bottom Presentation Navigation Bar */}
        <div className="h-12 shrink-0 border-t border-slate-800 bg-slate-900 px-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              data-testid="slide-prev-btn"
              disabled={currentSlideIndex <= 1}
              onClick={() =>
                updateTabState(tab.tabId, { currentPage: Math.max(1, currentSlideIndex - 1) })
              }
              className="pulse-btn pulse-btn-ghost pulse-btn-sm flex items-center gap-1"
            >
              <ChevronLeft className="w-4 h-4" />
              <span>Previous</span>
            </button>
            <button
              data-testid="slide-next-btn"
              disabled={currentSlideIndex >= slides.length}
              onClick={() =>
                updateTabState(tab.tabId, {
                  currentPage: Math.min(slides.length, currentSlideIndex + 1),
                })
              }
              className="pulse-btn pulse-btn-ghost pulse-btn-sm flex items-center gap-1"
            >
              <span>Next</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <Select
            label="Go to slide"
            prefix="Slide"
            value={String(currentSlideIndex)}
            onChange={(v) => updateTabState(tab.tabId, { currentPage: Number(v) })}
            options={slides.map((sl) => ({
              value: String(sl.index),
              label: `${sl.index}. ${sl.title.slice(0, 36)}`,
            }))}
          />

          <button
            onClick={() => setDistractionFree(true)}
            className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-white"
            title="Fullscreen slide mode"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
