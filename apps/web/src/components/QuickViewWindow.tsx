import { useEffect, useRef, useState } from 'react';
import type { DetectedFile } from '@omniview/shared-types';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';
import {
  closeQuickViewWindow,
  readSystemFile,
  subscribeToQuickViewFiles,
  type QuickViewPayload,
} from '../services/desktopBridge';
import { QuickView } from './QuickView';
import { PulsePlayer, isMediaPayload } from './PulsePlayer';

/**
 * Root of the floating Quick View window. It keeps its own in-memory copy of
 * the files (never persisted). On the desktop it is Pulse Explorer's only window:
 * the file manager (apps/files) is the app, and this is its viewer.
 */
export function QuickViewWindow() {
  const importFiles = useWorkspaceStore((s) => s.importFiles);
  const [queue, setQueue] = useState<string[]>([]);
  const [batch, setBatch] = useState(0);
  /** Video and audio go to Pulse's player, streamed from disk (never read into memory first). */
  const [media, setMedia] = useState<QuickViewPayload[]>([]);
  const paths = useRef(new Map<string, string>());

  useEffect(() => {
    const root = document.documentElement;
    // macOS draws the window's frame and traffic lights itself (apps/desktop main.rs show_quickview)
    const mac = /Mac/i.test(navigator.platform);
    root.classList.add('qv-window');
    if (mac) root.classList.add('qv-mac');
    return () => root.classList.remove('qv-window', 'qv-mac');
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const onFiles = async (all: QuickViewPayload[]) => {
      // a batch that starts with a video or a song plays (its media files make the playlist); the rest is viewed
      if (all.length > 0 && isMediaPayload(all[0])) {
        setQueue([]);
        setMedia(all.filter(isMediaPayload));
        setBatch((b) => b + 1);
        return;
      }
      setMedia([]);
      const files = all;
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

  if (media.length > 0) {
    return (
      <PulsePlayer
        key={batch}
        items={media}
        onClose={() => {
          setMedia([]);
          void closeQuickViewWindow();
        }}
      />
    );
  }

  if (queue.length === 0) return null;

  return (
    <QuickView
      key={batch}
      standalone
      queue={queue}
      pathOf={(id) => paths.current.get(id)}
      onClose={() => void closeQuickViewWindow()}
      onDownload={download}
    />
  );
}
