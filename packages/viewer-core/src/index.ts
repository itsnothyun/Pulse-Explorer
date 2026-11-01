import type {
  DetectedFile,
  OutlineItem,
  SearchMatch,
  ViewerCapabilities,
} from '@omniview/shared-types';

export interface FileSource {
  file: DetectedFile;
  blob?: Blob;
  arrayBuffer?: ArrayBuffer;
  objectUrl?: string;
  password?: string;
}

export interface ViewerContext {
  isOfflineOrLocalMode: boolean;
  allowRemoteConversion: boolean;
  signal?: AbortSignal;
  onProgress?: (percent: number, stage: string) => void;
}

export interface ViewerDocument<TPayload = unknown> {
  fileId: string;
  adapterId: string;
  title: string;
  unitCount: number; // Pages, slides, sheets, or chapters
  unitLabel: 'Page' | 'Slide' | 'Sheet' | 'Chapter' | 'Entry' | 'Line' | 'Item';
  outline: OutlineItem[];
  extractedTextByUnit: string[];
  fidelityWarning?: string;
  requiresServerConversion?: boolean;
  payload: TPayload;
  search(query: string): SearchMatch[];
  dispose(): void;
}

export interface ViewerAdapter<TPayload = unknown> {
  id: string;
  displayName: string;
  priority: number;

  supports(file: DetectedFile): boolean;

  getCapabilities(file: DetectedFile): ViewerCapabilities;

  load(
    source: FileSource,
    context: ViewerContext
  ): Promise<ViewerDocument<TPayload>>;

  dispose(): Promise<void> | void;
}

export function createSearchMatcher(
  fileId: string,
  unitLabel: string,
  extractedTextByUnit: string[]
): (query: string) => SearchMatch[] {
  return (query: string): SearchMatch[] => {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const lowerQuery = trimmed.toLowerCase();
    const matches: SearchMatch[] = [];

    extractedTextByUnit.forEach((unitText, idx) => {
      if (!unitText) return;
      const lowerText = unitText.toLowerCase();
      let pos = 0;
      let matchIdxInUnit = 0;
      while (pos < lowerText.length) {
        const foundIdx = lowerText.indexOf(lowerQuery, pos);
        if (foundIdx === -1) break;
        const snippetStart = Math.max(0, foundIdx - 32);
        const snippetEnd = Math.min(unitText.length, foundIdx + trimmed.length + 48);
        const rawSnippet = unitText
          .slice(snippetStart, snippetEnd)
          .replace(/\s+/g, ' ')
          .trim();
        matches.push({
          id: `${fileId}-m-${idx + 1}-${matchIdxInUnit}`,
          fileId,
          locationLabel: `${unitLabel} ${idx + 1}`,
          pageOrIndex: idx + 1,
          snippet:
            (snippetStart > 0 ? '…' : '') +
            rawSnippet +
            (snippetEnd < unitText.length ? '…' : ''),
          matchIndexInUnit: matchIdxInUnit,
        });
        matchIdxInUnit++;
        pos = foundIdx + Math.max(1, lowerQuery.length);
        if (matches.length >= 500) return matches;
      }
    });

    return matches;
  };
}

export class ViewerAdapterRegistry {
  private adapters: ViewerAdapter[] = [];

  register(adapter: ViewerAdapter): void {
    const existingIdx = this.adapters.findIndex((a) => a.id === adapter.id);
    if (existingIdx >= 0) {
      this.adapters[existingIdx] = adapter;
    } else {
      this.adapters.push(adapter);
    }
    this.adapters.sort((a, b) => b.priority - a.priority);
  }

  resolve(file: DetectedFile): ViewerAdapter {
    for (const adapter of this.adapters) {
      if (adapter.supports(file)) {
        return adapter;
      }
    }
    const fallback = this.adapters.find((a) => a.id === 'FallbackViewerAdapter');
    if (!fallback) {
      throw new Error('FallbackViewerAdapter is not registered in ViewerAdapterRegistry');
    }
    return fallback;
  }

  getById(id: string): ViewerAdapter | undefined {
    return this.adapters.find((a) => a.id === id);
  }

  listAll(): ViewerAdapter[] {
    return [...this.adapters];
  }
}
