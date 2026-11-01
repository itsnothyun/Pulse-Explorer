import { useEffect, useState } from 'react';
import { isDesktop } from '../../services/desktopBridge';

type AppWindow = import('@tauri-apps/api/window').Window;

/**
 * Minimize / maximize / close for the undecorated desktop window, drawn in the
 * Pulse square-pixel grammar (7x7 SVG glyphs, crisp edges). Renders nothing in
 * the browser.
 */
export function WindowControls({ onClose }: { onClose?: () => void } = {}) {
  const [win, setWin] = useState<AppWindow | null>(null);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isDesktop()) return;
    let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const w = getCurrentWindow();
      setWin(w);
      setMaximized(await w.isMaximized());
      unlisten = await w.onResized(async () => setMaximized(await w.isMaximized()));
    });
    return () => unlisten?.();
  }, []);

  if (!win) return null;

  return (
    <div className="win-controls" role="group" aria-label="Window controls">
      <button type="button" className="win-btn" onClick={() => void win.minimize()} aria-label="Minimize" title="Minimize">
        <PixelGlyph rows={[0, 0, 0, 0, 0, 0, 127]} />
      </button>
      <button
        type="button"
        className="win-btn"
        onClick={() => void win.toggleMaximize()}
        aria-label={maximized ? 'Restore' : 'Maximize'}
        title={maximized ? 'Restore' : 'Maximize'}
      >
        {maximized ? (
          <PixelGlyph rows={[31, 17, 125, 69, 71, 68, 124]} />
        ) : (
          <PixelGlyph rows={[127, 65, 65, 65, 65, 65, 127]} />
        )}
      </button>
      <button type="button" className="win-btn win-btn-close" onClick={() => (onClose ? onClose() : void win.close())} aria-label="Close" title="Close">
        <PixelGlyph rows={[65, 34, 20, 8, 20, 34, 65]} />
      </button>
    </div>
  );
}

/** 7x7 bitmap glyph; bit 0x40 is the leftmost column. */
export function PixelGlyph({ rows }: { rows: number[] }) {
  let d = '';
  rows.forEach((row, r) => {
    for (let c = 0; c < 7; c++) if (row & (0x40 >> c)) d += `M${c} ${r}h1v1h-1z`;
  });
  return (
    <svg viewBox="0 0 7 7" width="10" height="10" shapeRendering="crispEdges" fill="currentColor" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
