import { useEffect, useRef, useState } from 'react';
import { useWorkspaceStore, resetWorkspace } from '../stores/useWorkspaceStore';
import { isDesktop, openDefaultAppsSettings } from '../services/desktopBridge';
import { PixelIcon } from './pulse/PixelIcon';
import { PixelText } from './pulse/Pixel';
import { Segmented } from './pulse/Segmented';

export type SettingsTab = 'general' | 'files' | 'shortcuts' | 'about';

interface SettingsModalProps {
  open: boolean;
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  onClose: () => void;
  onImportUrl: () => void;
}

const SHORTCUTS: [string, string][] = [
  ['Jump to anything', 'Ctrl K'],
  ['Open files', 'Ctrl O'],
  ['Find in document', 'Ctrl F'],
  ['Next / previous tab', 'Ctrl Tab · Ctrl Shift Tab'],
  ['Go to tab 1 to 8 · last tab', 'Ctrl 1–8 · Ctrl 9'],
  ['Close tab', 'Ctrl W'],
  ['Zoom in / out / reset', 'Ctrl + · Ctrl − · Ctrl 0'],
  ['Previous / next page', '← · →'],
  ['Print', 'Ctrl P'],
  ['Exit focus mode', 'Esc'],
];

function Row({ title, detail, children }: { title: string; detail?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-4 border-b border-slate-800 last:border-b-0">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-slate-100">{title}</div>
        {detail && <div className="text-xs text-slate-400 mt-1 max-w-[40ch]">{detail}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Settings as a modal: segmented tabs with a sliding thumb, content that rises in per tab. */
export function SettingsModal({ open, tab, onTabChange, onClose, onImportUrl }: SettingsModalProps) {
  const theme = useWorkspaceStore((s) => s.theme);
  const toggleTheme = useWorkspaceStore((s) => s.toggleTheme);
  const motion = useWorkspaceStore((s) => s.motion);
  const setMotion = useWorkspaceStore((s) => s.setMotion);
  const workspaceMode = useWorkspaceStore((s) => s.workspaceMode);
  const setWorkspaceMode = useWorkspaceStore((s) => s.setWorkspaceMode);
  const fileCount = useWorkspaceStore((s) => s.files.length);
  const explorerOpenMode = useWorkspaceStore((s) => s.explorerOpenMode);
  const setExplorerOpenMode = useWorkspaceStore((s) => s.setExplorerOpenMode);
  const [armed, setArmed] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      restoreFocus.current = document.activeElement as HTMLElement | null;
      requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus());
    } else {
      setArmed(false);
      restoreFocus.current?.focus?.();
    }
  }, [open]);

  useEffect(() => setArmed(false), [tab]);

  if (!open) return null;

  return (
    <div
      className="anim-fade fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="anim-pop-center w-full max-w-lg border border-slate-800 bg-slate-900 shadow-2xl flex flex-col max-h-[86vh] rounded-xl overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 id="settings-title">
            <PixelText text="SETTINGS" dot={2.5} label="Settings" />
          </h2>
          <button type="button" onClick={onClose} className="icon-btn" aria-label="Close settings">
            <PixelIcon name="close" size={10} />
          </button>
        </div>

        <div className="px-5 pt-4">
          <Segmented<SettingsTab>
            asTabs
            label="Settings sections"
            value={tab}
            onChange={onTabChange}
            className="w-full"
            options={[
              { value: 'general', label: 'General' },
              { value: 'files', label: 'Files' },
              { value: 'shortcuts', label: 'Shortcuts' },
              { value: 'about', label: 'About' },
            ]}
          />
        </div>

        <div key={tab} role="tabpanel" className="anim-fade-up px-5 pt-2 pb-5 overflow-y-auto min-h-[300px]">
          {tab === 'general' && (
            <>
              <Row title="Theme" detail="Pulse Explorer is designed dark-first.">
                <Segmented
                  label="Theme"
                  value={theme}
                  onChange={(v) => v !== theme && toggleTheme()}
                  options={[
                    { value: 'dark', label: 'Dark', icon: <PixelIcon name="moon" size={7} /> },
                    { value: 'light', label: 'Light', icon: <PixelIcon name="sun" size={7} /> },
                  ]}
                />
              </Row>
              <Row title="Motion" detail="Reduce turns every animation off, even if Windows allows them.">
                <Segmented
                  label="Motion"
                  value={motion}
                  onChange={setMotion}
                  options={[
                    { value: 'system', label: 'System' },
                    { value: 'reduced', label: 'Reduce' },
                  ]}
                />
              </Row>
              <Row
                title="Storage"
                detail={
                  workspaceMode === 'local-guest'
                    ? 'Files stay on this device. Nothing is uploaded.'
                    : 'Cloud workspace: files can sync and use server conversion.'
                }
              >
                <Segmented
                  label="Storage"
                  value={workspaceMode}
                  onChange={setWorkspaceMode}
                  options={[
                    { value: 'local-guest', label: 'Device', icon: <PixelIcon name="device" size={7} /> },
                    { value: 'persistent-cloud', label: 'Cloud', icon: <PixelIcon name="cloud" size={7} /> },
                  ]}
                />
              </Row>
            </>
          )}

          {tab === 'files' && (
            <>
              <Row
                title="Opening from File Explorer"
                detail="Quick View floats the file over your workspace; Enter keeps it as a tab."
              >
                <Segmented
                  label="Opening from File Explorer"
                  value={explorerOpenMode}
                  onChange={setExplorerOpenMode}
                  options={[
                    { value: 'quick-view', label: 'Quick View' },
                    { value: 'tab', label: 'Tab' },
                  ]}
                />
              </Row>
              <Row title="Import from URL" detail="Fetch a public file through the safe importer.">
                <button
                  type="button"
                  className="pulse-btn pulse-btn-ghost pulse-btn-sm"
                  onClick={() => {
                    onClose();
                    onImportUrl();
                  }}
                >
                  <PixelIcon name="globe" size={7} /> Import
                </button>
              </Row>
              {isDesktop() && (
                <Row
                  title="Default app"
                  detail="Windows asks you to confirm in Settings. Pick Pulse Explorer for each file type you want."
                >
                  <button type="button" className="pulse-btn pulse-btn-ghost pulse-btn-sm" onClick={() => void openDefaultAppsSettings()}>
                    Open Windows settings <PixelIcon name="arrowRight" size={7} />
                  </button>
                </Row>
              )}
              <Row
                title="Clear workspace"
                detail={`Removes all ${fileCount} files, collections, notes and history from Pulse Explorer. Originals on disk are untouched.`}
              >
                <button
                  type="button"
                  data-armed={armed}
                  className="pulse-btn pulse-btn-danger pulse-btn-sm"
                  onClick={() => (armed ? void resetWorkspace() : setArmed(true))}
                  onBlur={() => setArmed(false)}
                >
                  <PixelIcon name="trash" size={7} /> {armed ? 'Click again to clear' : 'Clear…'}
                </button>
              </Row>
            </>
          )}

          {tab === 'shortcuts' && (
            <ul className="pt-2">
              {SHORTCUTS.map(([action, keys]) => (
                <li key={action} className="flex items-center justify-between gap-4 py-2.5 border-b border-slate-800 last:border-b-0 text-xs">
                  <span className="text-slate-300">{action}</span>
                  <span className="flex flex-wrap justify-end gap-1">
                    {keys.split(' · ').map((k) => (
                      <kbd key={k} className="pulse-kbd !opacity-80 text-slate-200">{k}</kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {tab === 'about' && (
            <div className="pt-6 space-y-5">
              <div className="flex items-center gap-4">
                <img src="/img/icon.png" width={48} height={48} alt="" />
                <div className="space-y-2">
                  <PixelText text="PULSE" dot={4} label="Pulse" />
                  <div className="text-xs text-slate-400 font-mono">Version 1.0.0</div>
                </div>
              </div>
              <p className="text-[13px] text-slate-300 leading-relaxed max-w-[52ch]">
                A local-first viewer for documents, sheets, slides, books, code, media and archives. Files open on
                your device and the originals are never modified.
              </p>
              <p className="text-xs text-slate-400">
                Design system and logo from Pulse by itsnothyun (MIT). Typeface: Schibsted Grotesk (OFL).
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
