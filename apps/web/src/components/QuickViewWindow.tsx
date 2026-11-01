import { useEffect, useRef, useState } from 'react';
import type { DetectedFile } from '@omniview/shared-types';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';
import {
  closeQuickViewWindow,
  openPathsInWorkspace,
  readSystemFile,
  subscribeToQuickViewFiles,
  type QuickViewPayload,
} from '../services/desktopBridge';
import { QuickView } from './QuickView';

/**
 * Root of the floating Quick View window. It keeps its own in-memory copy of
 * the files (never persisted, so it can't clash with the workspace window) and
 * hands paths back to the workspace on "Open in workspace".
 */
export function QuickViewWindow() {
  const importFiles = useWorkspaceStore((s) => s.importFiles);
  const [queue, setQueue] = useState<string[]>([]);
  const [batch, setBatch] = useState(0);
  const paths = useRef(new Map<string, string>());

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('qv-window');
    return () => root.classList.remove('qv-window');
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const onFiles = async (files: QuickViewPayload[]) => {
      const state = useWorkspaceStore.getState();
      const ids: string[] = [];
      for (const f of files) {
        const known = state.files.find((x) => x.originalName === f.filename && x.sizeBytes === f.sizeBytes);
        if (known) {
          ids.push(known.id);
          paths.current.set(known.id, f.path);
          continue;
        }
        try {
          const bytes = await readSystemFile(f.path);
          const [created] = await importFiles([{ name: f.filename, bytes }], 'desktop-open-with', false);
          if (created) {
            ids.push(created.id);
            paths.current.set(created.id, f.path);
          }
        } catch (e) {
          console.warn('[Pulse] Quick View could not read', f.path, e);
        }
      }
      if (ids.length > 0) {
        setQueue(ids);
        setBatch((b) => b + 1);
      }
    };
    void subscribeToQuickViewFiles((files) => void onFiles(files)).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [importFiles]);

  const download = (file: DetectedFile) => {
    const buffer = useWorkspaceStore.getState().fileBuffers[file.id];
    if (!buffer) return;
    const url = URL.createObjectURL(new Blob([buffer], { type: file.detectedMimeType }));
    const a = document.createElement('a');
    a.href = url;
    a.download = file.originalName;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (queue.length === 0) return null;

  return (
    <QuickView
      key={batch}
      standalone
      queue={queue}
      pathOf={(id) => paths.current.get(id)}
      onClose={() => void closeQuickViewWindow()}
      onOpenInWorkspace={(id) => {
        const path = paths.current.get(id);
        if (path) void openPathsInWorkspace([path]);
      }}
      onDownload={download}
    />
  );
}
