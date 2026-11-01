import { create } from 'zustand';
import type { DetectedFile } from '@omniview/shared-types';
import type { Level } from '../converters/types';

export interface CircleState {
  file: DetectedFile;
  x: number;
  y: number;
  /** True while the finger or button that started the long press is still down. */
  held: boolean;
}

export interface ConvertJob {
  id: string;
  fileName: string;
  targetLabel: string;
  status: 'running' | 'done' | 'error';
  progress: number;
  message?: string;
  before: number;
  after?: number;
  resultFileId?: string;
}

interface ConvertState {
  level: Level;
  circle: CircleState | null;
  jobs: ConvertJob[];
  setLevel: (level: Level) => void;
  openCircle: (circle: CircleState) => void;
  closeCircle: () => void;
  upsertJob: (job: Partial<ConvertJob> & { id: string }) => void;
  dismissJob: (id: string) => void;
}

const LEVEL_KEY = 'pulse.convertLevel';

function readLevel(): Level {
  try {
    const v = localStorage.getItem(LEVEL_KEY);
    if (v === 'small' || v === 'balanced' || v === 'best') return v;
  } catch {
    // Storage can be blocked; the default is fine.
  }
  return 'balanced';
}

export const useConvertStore = create<ConvertState>((set) => ({
  level: readLevel(),
  circle: null,
  jobs: [],
  setLevel: (level) => {
    try {
      localStorage.setItem(LEVEL_KEY, level);
    } catch {
      // Not persisted; still applies for this session.
    }
    set({ level });
  },
  openCircle: (circle) => set({ circle }),
  closeCircle: () => set({ circle: null }),
  upsertJob: (job) =>
    set((s) =>
      s.jobs.some((j) => j.id === job.id)
        ? { jobs: s.jobs.map((j) => (j.id === job.id ? { ...j, ...job } : j)) }
        : { jobs: [...s.jobs, job as ConvertJob] }
    ),
  dismissJob: (id) => set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) })),
}));
