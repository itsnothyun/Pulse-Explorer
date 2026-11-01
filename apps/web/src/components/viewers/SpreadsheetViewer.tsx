import React, { useMemo, useState } from 'react';
import {
  Filter,
  FunctionSquare,
  ShieldAlert,
  Table2,
} from 'lucide-react';
import type { DetectedFile, TabViewerState } from '@omniview/shared-types';
import type { ViewerDocument } from '@omniview/viewer-core';
import type {
  SpreadsheetCellData,
  SpreadsheetViewerPayload,
} from '@omniview/viewer-adapters';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';

interface SpreadsheetViewerProps {
  file: DetectedFile;
  tab: TabViewerState;
  document: ViewerDocument<SpreadsheetViewerPayload>;
}

function getColumnLabel(colIndex: number): string {
  let label = '';
  let n = colIndex;
  while (n >= 0) {
    label = String.fromCharCode((n % 26) + 65) + label;
    n = Math.floor(n / 26) - 1;
  }
  return label;
}

export const SpreadsheetViewer: React.FC<SpreadsheetViewerProps> = ({
  file,
  tab,
  document,
}) => {
  const updateTabState = useWorkspaceStore((s) => s.updateTabState);
  const { sheets, delimiterDetected, encodingDetected, macrosBlocked } = document.payload;

  const activeSheetIndex = useMemo(() => {
    if (tab.activeSheet) {
      const idx = sheets.findIndex((s) => s.name === tab.activeSheet);
      if (idx >= 0) return idx;
    }
    return Math.max(0, Math.min(sheets.length - 1, tab.currentPage - 1));
  }, [sheets, tab.activeSheet, tab.currentPage]);

  const activeSheet = sheets[activeSheetIndex] ?? sheets[0];
  const [selectedCell, setSelectedCell] = useState<{ row: number; col: number }>({
    row: 0,
    col: 0,
  });
  const [rowFilterText, setRowFilterText] = useState<string>('');
  const [scrollOffsetRow, setScrollOffsetRow] = useState<number>(0);

  const filteredRows = useMemo(() => {
    if (!activeSheet) return [];
    const q = (rowFilterText || tab.searchQuery).trim().toLowerCase();
    if (!q) {
      return activeSheet.rows.map((cells, idx) => ({ originalRowNumber: idx + 1, cells }));
    }
    return activeSheet.rows
      .map((cells, idx) => ({ originalRowNumber: idx + 1, cells }))
      .filter(
        ({ originalRowNumber, cells }) =>
          originalRowNumber === 1 ||
          cells.some(
            (c) =>
              c.formatted.toLowerCase().includes(q) ||
              (c.formula && c.formula.toLowerCase().includes(q))
          )
      );
  }, [activeSheet, rowFilterText, tab.searchQuery]);

  if (!activeSheet) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-slate-400">
        Workbook contains no worksheets.
      </div>
    );
  }

  // Virtualized window of rows (render 80 rows at a time for high-speed scrolling)
  const WINDOW_SIZE = 80;
  const visibleRows = filteredRows.slice(scrollOffsetRow, scrollOffsetRow + WINDOW_SIZE);
  const currentCell: SpreadsheetCellData | undefined =
    activeSheet.rows[selectedCell.row]?.[selectedCell.col];
  const cellCoord = `${getColumnLabel(selectedCell.col)}${selectedCell.row + 1}`;

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-slate-950" data-testid="spreadsheet-viewer-root">
      {/* Top Formula & Security Telemetry Bar */}
      <div className="border-b border-slate-800 bg-slate-900/90 px-4 py-2 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2 flex-1 min-w-[280px]">
          <span
            data-testid="spreadsheet-cell-coord"
            className="px-2.5 py-1 rounded bg-slate-950 border border-slate-700 font-mono font-semibold text-blue-300 min-w-[56px] text-center"
          >
            {cellCoord}
          </span>
          <div className="flex items-center gap-1.5 text-slate-400">
            <FunctionSquare className="w-4 h-4 text-blue-400" />
          </div>
          <div
            data-testid="spreadsheet-formula-bar"
            className="flex-1 rounded bg-slate-950 border border-slate-800 px-3 py-1 font-mono text-xs text-slate-200 truncate selectable-text"
          >
            {currentCell?.formula
              ? `${currentCell.formula}   →   ${currentCell.formatted}`
              : currentCell?.formatted || 'Empty cell'}
          </div>
        </div>

        {/* Row Filter & CSV/Macro Indicators */}
        <div className="flex items-center gap-3">
          <div className="relative flex items-center">
            <Filter className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 pointer-events-none" />
            <input
              type="text"
              value={rowFilterText}
              onChange={(e) => {
                setRowFilterText(e.target.value);
                setScrollOffsetRow(0);
              }}
              placeholder="Filter sheet rows..."
              className="pl-8 pr-3 py-1 rounded bg-slate-950 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-blue-500 w-44"
            />
          </div>

          {delimiterDetected && (
            <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-[11px] font-mono">
              CSV Delimiter: &quot;{delimiterDetected}&quot; ({encodingDetected})
            </span>
          )}

          {macrosBlocked && (
            <span className="flex items-center gap-1 px-2.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[11px]">
              <ShieldAlert className="w-3.5 h-3.5" />
              <span>Macros Blocked (Safe Mode)</span>
            </span>
          )}
        </div>
      </div>

      {/* Virtualized Grid Container */}
      <div
        className="flex-1 overflow-auto relative"
        onScroll={(e) => {
          const scrollTop = e.currentTarget.scrollTop;
          const approxRow = Math.floor(scrollTop / 30);
          if (Math.abs(approxRow - scrollOffsetRow) > 15) {
            setScrollOffsetRow(Math.max(0, Math.min(filteredRows.length - WINDOW_SIZE, approxRow)));
          }
        }}
      >
        <table
          style={{ fontSize: `${Math.round(12 * (tab.zoom / 100))}px` }}
          className="border-collapse w-max min-w-full selectable-text"
        >
          <thead className="sticky top-0 z-20 bg-slate-900 text-slate-400 select-none">
            <tr>
              <th className="w-12 border border-slate-800 bg-slate-900 px-2 py-1.5 text-center font-mono text-[11px]">
                #
              </th>
              {Array.from({ length: Math.max(activeSheet.totalCols, 1) }, (_, cIdx) => (
                <th
                  key={cIdx}
                  style={{ minWidth: `${activeSheet.colWidths[cIdx] ?? 130}px` }}
                  className={`border border-slate-800 px-3 py-1.5 text-center font-mono text-[11px] font-semibold ${
                    selectedCell.col === cIdx ? 'bg-blue-950/70 text-blue-300' : 'bg-slate-900'
                  }`}
                >
                  {getColumnLabel(cIdx)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map(({ originalRowNumber, cells }) => {
              const rIdx = originalRowNumber - 1;
              const isHeaderRow = originalRowNumber === 1 && activeSheet.frozenRows > 0;
              return (
                <tr
                  key={originalRowNumber}
                  className={
                    isHeaderRow
                      ? 'bg-slate-900/90 font-semibold text-slate-100 sticky top-7 z-10'
                      : rIdx % 2 === 0
                      ? 'bg-slate-950'
                      : 'bg-slate-900/30'
                  }
                >
                  <td
                    className={`border border-slate-800/90 px-2 py-1 text-center font-mono text-[11px] select-none ${
                      selectedCell.row === rIdx
                        ? 'bg-blue-950/70 text-blue-300 font-bold'
                        : 'bg-slate-900 text-slate-500'
                    }`}
                  >
                    {originalRowNumber}
                  </td>
                  {Array.from({ length: Math.max(activeSheet.totalCols, 1) }, (_, cIdx) => {
                    const cell = cells[cIdx];
                    const isSelected = selectedCell.row === rIdx && selectedCell.col === cIdx;
                    const q = tab.searchQuery.trim().toLowerCase();
                    const isSearchMatch =
                      q.length > 0 &&
                      Boolean(cell?.formatted && cell.formatted.toLowerCase().includes(q));

                    return (
                      <td
                        key={cIdx}
                        onClick={() => setSelectedCell({ row: rIdx, col: cIdx })}
                        className={`border border-slate-800/80 px-3 py-1.5 truncate cursor-cell transition-colors ${
                          isSelected
                            ? 'ring-2 ring-inset ring-blue-500 bg-blue-500/15 text-white'
                            : isSearchMatch
                            ? 'bg-amber-400/25 text-amber-200 font-semibold'
                            : cell?.type === 'number' || cell?.type === 'formula'
                            ? 'text-right font-mono text-emerald-300'
                            : 'text-left text-slate-200'
                        }`}
                      >
                        {cell?.formatted ?? ''}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Bottom Worksheet Tabs Bar */}
      <div className="h-10 shrink-0 border-t border-slate-800 bg-slate-900 px-4 flex items-center justify-between">
        <div className="flex items-center gap-1.5 overflow-x-auto">
          <Table2 className="w-4 h-4 text-emerald-400 mr-1 shrink-0" />
          {sheets.map((sheet, idx) => {
            const isActive = idx === activeSheetIndex;
            return (
              <button
                key={sheet.name}
                data-testid={`worksheet-tab-${sheet.name}`}
                onClick={() => {
                  updateTabState(tab.tabId, {
                    activeSheet: sheet.name,
                    currentPage: idx + 1,
                  });
                  setSelectedCell({ row: 0, col: 0 });
                  setScrollOffsetRow(0);
                }}
                className={`px-3 py-1 rounded text-xs font-medium transition ${
                  isActive
                    ? 'bg-emerald-600/25 border border-emerald-500/50 text-emerald-200 shadow-sm'
                    : 'bg-slate-800/60 hover:bg-slate-800 text-slate-400'
                }`}
              >
                {sheet.name}
                <span className="ml-1.5 text-[10px] opacity-70 font-mono">
                  ({sheet.totalRows})
                </span>
              </button>
            );
          })}
        </div>

        <div className="text-[11px] text-slate-400 font-mono">
          Showing {visibleRows.length} of {filteredRows.length} rows • {activeSheet.totalCols} cols
        </div>
      </div>
    </div>
  );
};
