import { useCallback, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { DetectedFile } from '@omniview/shared-types';
import { getTargets } from '../converters/registry';
import { useConvertStore } from '../stores/useConvertStore';

const HOLD_MS = 450;
const MOVE_TOLERANCE = 8;
const INTERACTIVE = 'button, a, input, select, textarea';

/**
 * Long-press (touch or primary mouse button) on a file opens the convert circle.
 * `bind(file)` returns props to spread on the file card or row. Only one press
 * can be live at a time, so the timer state is shared across items.
 */
export function useFileLongPress() {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef({ x: 0, y: 0 });
  const firedAt = useRef(0);

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const bind = useCallback(
    (file: DetectedFile) => ({
      onPointerDown: (e: ReactPointerEvent) => {
        if (e.button !== 0 || file.isTrashed) return;
        // Ignore presses on controls nested inside the card (the card itself may be a button).
        const control = (e.target as HTMLElement).closest(INTERACTIVE);
        if (control && control !== e.currentTarget && e.currentTarget.contains(control)) return;
        if (getTargets({ extension: file.extension, category: file.category }).length === 0) return;
        cancel();
        start.current = { x: e.clientX, y: e.clientY };
        const { clientX: x, clientY: y } = e;
        timer.current = setTimeout(() => {
          timer.current = null;
          firedAt.current = Date.now();
          navigator.vibrate?.(12);
          useConvertStore.getState().openCircle({ file, x, y, held: true });
        }, HOLD_MS);
      },
      onPointerMove: (e: ReactPointerEvent) => {
        if (!timer.current) return;
        if (Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > MOVE_TOLERANCE) cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onPointerLeave: cancel,
      // The release that ends a long press must not also open the file.
      onClickCapture: (e: ReactMouseEvent) => {
        if (Date.now() - firedAt.current < 600) {
          e.stopPropagation();
          e.preventDefault();
        }
      },
      // Touch browsers fire a context menu after a long press; the circle replaces it.
      onContextMenuCapture: (e: ReactMouseEvent) => {
        if (Date.now() - firedAt.current < 900) {
          e.stopPropagation();
          e.preventDefault();
        }
      },
    }),
    [cancel]
  );

  return bind;
}
