import { create } from 'zustand';
import type {
  AnnotationType,
  ConversionJob,
  DetectedFile,
  DocumentAnnotation,
  DocumentBookmark,
  FileCategory,
  ImportSource,
  TabViewerState,
  WorkspaceFolder,
} from '@omniview/shared-types';
import {
  computeSha256Hex,
  inspectFileSignature,
  sanitizeFilename,
} from '@omniview/utilities';
import type { ViewerDocument } from '@omniview/viewer-core';
import { createDefaultViewerRegistry } from '@omniview/viewer-adapters';
import { clearWorkspace, loadBuffers, loadSnapshot, markBuffersPersisted, saveWorkspace } from '../services/workspacePersistence';

export const viewerRegistry = createDefaultViewerRegistry();

export type SidebarFilter =
  | 'all'
  | 'recent'
  | 'favorites'
  | 'trash'
  | FileCategory
  | `folder:${string}`;

export type InspectorTab = 'details' | 'outline' | 'annotations' | 'search';

interface WorkspaceState {
  // Theme & Modes
  theme: 'dark' | 'light';
  /** 'reduced' turns motion off in-app regardless of the OS setting. */
  motion: 'system' | 'reduced';
  /** How files opened from File Explorer appear. */
  explorerOpenMode: 'quick-view' | 'tab';
  workspaceMode: 'local-guest' | 'persistent-cloud';
  isDistractionFree: boolean;
  leftSidebarOpen: boolean;
  rightInspectorOpen: boolean;
  activeInspectorTab: InspectorTab;

  // File Library
  files: DetectedFile[];
  fileBuffers: Record<string, ArrayBuffer>;
  loadedDocuments: Record<string, ViewerDocument>;
  folders: WorkspaceFolder[];
  sidebarFilter: SidebarFilter;
  fileManagerViewMode: 'grid' | 'list';
  sortBy: 'name' | 'size' | 'date';
  sortOrder: 'asc' | 'desc';
  globalSearchQuery: string;
  selectedFileIds: string[];
  duplicateNotice: string | null;

  // Tabs & Split Comparison
  tabs: TabViewerState[];
  activeTabId: string | null;
  comparisonTabId: string | null;
  closedTabsStack: string[]; // fileIds of recently closed tabs
  recentFileIds: string[]; // most recently opened first
  lastSessionByFileId: Record<string, Partial<TabViewerState>>;

  // Annotations (with Undo/Redo), Bookmarks & Conversion Jobs
  annotationsByFileId: Record<string, DocumentAnnotation[]>;
  annotationUndoStack: Record<string, DocumentAnnotation[][]>;
  annotationRedoStack: Record<string, DocumentAnnotation[][]>;
  bookmarksByFileId: Record<string, DocumentBookmark[]>;
  conversionJobs: Record<string, ConversionJob>;

  // Actions
  toggleTheme: () => void;
  setMotion: (motion: 'system' | 'reduced') => void;
  setWorkspaceMode: (mode: 'local-guest' | 'persistent-cloud') => void;
  setDistractionFree: (enabled: boolean) => void;
  setLeftSidebarOpen: (open: boolean) => void;
  setRightInspectorOpen: (open: boolean) => void;
  setActiveInspectorTab: (tab: InspectorTab) => void;
  setSidebarFilter: (filter: SidebarFilter) => void;
  setFileManagerViewMode: (mode: 'grid' | 'list') => void;
  setSort: (sortBy: 'name' | 'size' | 'date', sortOrder?: 'asc' | 'desc') => void;
  setGlobalSearchQuery: (query: string) => void;
  clearDuplicateNotice: () => void;

  // File Operations
  initializeStarterFiles: () => Promise<void>;
  importFiles: (
    inputs: { name: string; bytes: Uint8Array | ArrayBuffer; declaredMime?: string; folderId?: string; isFavorite?: boolean }[],
    source: ImportSource,
    openFirstInTab?: boolean
  ) => Promise<DetectedFile[]>;
  openFileInTab: (fileId: string, openInComparison?: boolean) => Promise<void>;
  /** Opens a file in the Quick View overlay; returns the hidden tab id. */
  openQuickView: (fileId: string) => Promise<string | null>;
  closeQuickView: (tabId: string) => void;
  setExplorerOpenMode: (mode: 'quick-view' | 'tab') => void;
  closeTab: (tabId: string) => void;
  closeOtherTabs: (tabId: string) => void;
  closeAllTabs: () => void;
  restoreLastClosedTab: () => Promise<void>;
  setActiveTab: (tabId: string | null) => void;
  setComparisonTab: (tabId: string | null) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  updateTabState: (tabId: string, patch: Partial<TabViewerState>) => void;

  // Library Organization
  toggleFavorite: (fileId: string) => void;
  renameFile: (fileId: string, newName: string) => void;
  moveFileToTrash: (fileId: string) => void;
  restoreFileFromTrash: (fileId: string) => void;
  permanentlyRemoveFile: (fileId: string) => void;
  createFolder: (name: string) => string | null;
  assignFileToFolder: (fileId: string, folderId: string | null) => void;

  // Annotations & Bookmarks
  addAnnotation: (
    fileId: string,
    annotation: Omit<DocumentAnnotation, 'id' | 'fileId' | 'fileChecksum' | 'createdAt' | 'updatedAt'>
  ) => void;
  updateAnnotationComment: (fileId: string, annotationId: string, comment: string) => void;
  deleteAnnotation: (fileId: string, annotationId: string) => void;
  undoAnnotation: (fileId: string) => void;
  redoAnnotation: (fileId: string) => void;
  toggleBookmark: (fileId: string, position: number | string, label: string) => void;

  // Conversion Worker Simulation / API Trigger
  requestServerConversion: (fileId: string) => Promise<void>;
}

function createInitialTabState(tabId: string, file: DetectedFile, adapterId: string, saved?: Partial<TabViewerState>): TabViewerState {
  return {
    tabId,
    fileId: file.id,
    adapterId,
    currentPage: saved?.currentPage ?? 1,
    totalPages: saved?.totalPages ?? 1,
    zoom: saved?.zoom ?? 100,
    fitMode: saved?.fitMode ?? 'fit-width',
    rotation: saved?.rotation ?? 0,
    pdfViewMode: saved?.pdfViewMode ?? 'continuous',
    docReadingMode: saved?.docReadingMode ?? 'print-layout',
    activeSheet: saved?.activeSheet,
    ebookTheme: saved?.ebookTheme ?? 'dark',
    ebookFontSize: saved?.ebookFontSize ?? 18,
    searchQuery: '',
    searchMatches: [],
    activeMatchIndex: 0,
    showThumbnails: saved?.showThumbnails ?? true,
    showAnnotations: true,
    activeAnnotationTool: 'select',
    activeAnnotationColor: '#3b82f6',
    hasUnsavedAnnotations: false,
    scrollTop: saved?.scrollTop ?? 0,
    scrollLeft: saved?.scrollLeft ?? 0,
  };
}

/** Parses a file with its adapter, falling back to the hex/fallback viewer on failure. */
async function loadDocumentFor(state: WorkspaceState, file: DetectedFile): Promise<ViewerDocument | undefined> {
  const cached = state.loadedDocuments[file.id];
  const buffer = state.fileBuffers[file.id];
  if (cached || !buffer) return cached;
  const adapter = viewerRegistry.resolve(file);
  try {
    return await adapter.load(
      { file, arrayBuffer: buffer },
      {
        isOfflineOrLocalMode: state.workspaceMode === 'local-guest',
        allowRemoteConversion: state.workspaceMode === 'persistent-cloud',
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to parse document';
    const fallbackAdapter = viewerRegistry.getById('FallbackViewerAdapter')!;
    return fallbackAdapter.load(
      { file: { ...file, errorReason: message }, arrayBuffer: buffer },
      { isOfflineOrLocalMode: true, allowRemoteConversion: false }
    );
  }
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  theme: 'dark',
  motion: 'system',
  explorerOpenMode: 'quick-view',
  workspaceMode: 'local-guest',
  isDistractionFree: false,
  leftSidebarOpen: true,
  rightInspectorOpen: false,
  activeInspectorTab: 'details',

  files: [],
  fileBuffers: {},
  loadedDocuments: {},
  folders: [
    { id: 'folder-specs', name: 'Architecture & Specs', parentId: null, color: '#3b82f6', createdAt: new Date().toISOString() },
    { id: 'folder-finance', name: 'Financial Workbooks', parentId: null, color: '#10b981', createdAt: new Date().toISOString() },
  ],
  sidebarFilter: 'all',
  fileManagerViewMode: 'grid',
  sortBy: 'date',
  sortOrder: 'desc',
  globalSearchQuery: '',
  selectedFileIds: [],
  duplicateNotice: null,

  tabs: [],
  activeTabId: null,
  comparisonTabId: null,
  closedTabsStack: [],
  recentFileIds: [],
  lastSessionByFileId: {},

  annotationsByFileId: {},
  annotationUndoStack: {},
  annotationRedoStack: {},
  bookmarksByFileId: {},
  conversionJobs: {},

  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark';
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', next === 'dark');
    }
    set({ theme: next });
  },

  setMotion: (motion) => {
    applyMotion(motion);
    set({ motion });
  },
  setWorkspaceMode: (workspaceMode) => set({ workspaceMode }),
  setDistractionFree: (isDistractionFree) => set({ isDistractionFree }),
  setLeftSidebarOpen: (leftSidebarOpen) => set({ leftSidebarOpen }),
  setRightInspectorOpen: (rightInspectorOpen) => set({ rightInspectorOpen }),
  setActiveInspectorTab: (activeInspectorTab) => set({ activeInspectorTab, rightInspectorOpen: true }),
  setSidebarFilter: (sidebarFilter) => set({ sidebarFilter }),
  setFileManagerViewMode: (fileManagerViewMode) => set({ fileManagerViewMode }),
  setSort: (sortBy, sortOrder) =>
    set((state) => ({
      sortBy,
      sortOrder: sortOrder ?? (state.sortBy === sortBy && state.sortOrder === 'asc' ? 'desc' : 'asc'),
    })),
  setGlobalSearchQuery: (globalSearchQuery) => set({ globalSearchQuery }),
  clearDuplicateNotice: () => set({ duplicateNotice: null }),

  initializeStarterFiles: () => {
    // StrictMode and HMR can call this twice; run the restore exactly once.
    initPromise ??= restoreOrSeedWorkspace();
    return initPromise;
  },

  importFiles: async (inputs, source, openFirstInTab = true) => {
    const createdFiles: DetectedFile[] = [];
    const nextBuffers = { ...get().fileBuffers };
    const existingFiles = [...get().files];
    let duplicateWarning: string | null = null;

    for (const item of inputs) {
      const arrayBuffer: ArrayBuffer =
        item.bytes instanceof Uint8Array
          ? (item.bytes.buffer.slice(
              item.bytes.byteOffset,
              item.bytes.byteOffset + item.bytes.byteLength
            ) as ArrayBuffer)
          : item.bytes;
      const uint8 = new Uint8Array(arrayBuffer);
      const checksum = await computeSha256Hex(uint8);

      // Duplicate detection via SHA-256 hash
      const duplicate = existingFiles.find((f) => f.checksum === checksum && !f.isTrashed);
      if (duplicate && source !== 'sample-fixture') {
        duplicateWarning = `Duplicate detected by SHA-256 (${checksum.slice(0, 10)}…): "${item.name}" matches existing file "${duplicate.originalName}".`;
      }

      const signature = inspectFileSignature(item.name, uint8.slice(0, 64), item.declaredMime ?? '');
      const id = `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();

      const detected: DetectedFile = {
        id,
        originalName: item.name,
        sanitizedName: sanitizeFilename(item.name),
        extension: signature.extension,
        declaredMimeType: item.declaredMime || signature.detectedMimeType,
        detectedMimeType: signature.detectedMimeType,
        category: signature.category,
        sizeBytes: uint8.byteLength,
        checksum,
        importSource: source,
        status: signature.conversionRequired
          ? 'conversion-required'
          : signature.category === 'unknown'
          ? 'unsupported'
          : 'ready',
        createdAt: now,
        lastModified: now,
        folderId: item.folderId ?? null,
        isFavorite: Boolean(item.isFavorite),
        isTrashed: false,
        hasMacrosWarning: signature.hasMacrosWarning,
        isSensitiveEnv: signature.isSensitiveEnv,
        magicSignatureHex: signature.magicSignatureHex,
        conversionFidelityNote: signature.conversionFidelityNote,
      };

      existingFiles.unshift(detected);
      nextBuffers[id] = arrayBuffer;
      createdFiles.push(detected);
    }

    set({
      files: existingFiles,
      fileBuffers: nextBuffers,
      duplicateNotice: duplicateWarning,
    });

    if (openFirstInTab && createdFiles.length > 0) {
      for (const f of createdFiles) {
        await get().openFileInTab(f.id);
      }
    }

    return createdFiles;
  },

  openFileInTab: async (fileId, openInComparison = false) => {
    const state = get();
    const file = state.files.find((f) => f.id === fileId);
    if (!file) return;

    set((prev) => ({
      recentFileIds: [fileId, ...prev.recentFileIds.filter((id) => id !== fileId)].slice(0, 12),
    }));

    // A file already in Quick View becomes a normal tab, keeping its page and zoom.
    const quickTab = state.tabs.find((t) => t.fileId === fileId && t.isQuickView);
    const normalTab = state.tabs.find((t) => t.fileId === fileId && !t.isQuickView);
    if (quickTab && !normalTab) {
      set((prev) => ({
        tabs: prev.tabs.map((t) => (t.tabId === quickTab.tabId ? { ...t, isQuickView: false } : t)),
        activeTabId: openInComparison ? prev.activeTabId : quickTab.tabId,
        comparisonTabId: openInComparison ? quickTab.tabId : prev.comparisonTabId,
      }));
      return;
    }
    const existingTab = normalTab;
    if (existingTab) {
      if (openInComparison) {
        set({ comparisonTabId: existingTab.tabId });
      } else {
        set({ activeTabId: existingTab.tabId });
      }
      return;
    }

    const adapter = viewerRegistry.resolve(file);
    const loadedDoc = await loadDocumentFor(state, file);

    const tabId = `tab-${fileId}`;
    const savedSession = state.lastSessionByFileId[fileId];
    const newTab = createInitialTabState(
      tabId,
      file,
      loadedDoc?.adapterId ?? adapter.id,
      savedSession
    );
    if (loadedDoc) {
      newTab.totalPages = Math.max(1, loadedDoc.unitCount);
    }

    set((prev) => ({
      loadedDocuments: loadedDoc
        ? { ...prev.loadedDocuments, [fileId]: loadedDoc }
        : prev.loadedDocuments,
      tabs: [...prev.tabs, newTab],
      activeTabId: openInComparison ? prev.activeTabId ?? tabId : tabId,
      comparisonTabId: openInComparison ? tabId : prev.comparisonTabId,
    }));
  },

  openQuickView: async (fileId) => {
    const state = get();
    const file = state.files.find((f) => f.id === fileId);
    if (!file) return null;
    set((prev) => ({
      recentFileIds: [fileId, ...prev.recentFileIds.filter((id) => id !== fileId)].slice(0, 12),
    }));
    const existing = state.tabs.find((t) => t.fileId === fileId && t.isQuickView);
    if (existing) return existing.tabId;
    const adapter = viewerRegistry.resolve(file);
    const loadedDoc = await loadDocumentFor(state, file);
    const tabId = `qv-${fileId}`;
    const tab = createInitialTabState(tabId, file, loadedDoc?.adapterId ?? adapter.id, state.lastSessionByFileId[fileId]);
    tab.isQuickView = true;
    tab.showThumbnails = false;
    if (loadedDoc) tab.totalPages = Math.max(1, loadedDoc.unitCount);
    set((prev) => ({
      loadedDocuments: loadedDoc ? { ...prev.loadedDocuments, [fileId]: loadedDoc } : prev.loadedDocuments,
      tabs: [...prev.tabs.filter((t) => t.tabId !== tabId), tab],
    }));
    return tabId;
  },

  closeQuickView: (tabId) => {
    const tab = get().tabs.find((t) => t.tabId === tabId && t.isQuickView);
    if (!tab) return;
    set((prev) => ({
      tabs: prev.tabs.filter((t) => t.tabId !== tabId),
      lastSessionByFileId: {
        ...prev.lastSessionByFileId,
        [tab.fileId]: { currentPage: tab.currentPage, zoom: tab.zoom, rotation: tab.rotation, pdfViewMode: tab.pdfViewMode },
      },
    }));
  },

  setExplorerOpenMode: (explorerOpenMode) => set({ explorerOpenMode }),

  closeTab: (tabId) => {
    const state = get();
    const target = state.tabs.find((t) => t.tabId === tabId);
    if (!target) return;

    const remaining = state.tabs.filter((t) => t.tabId !== tabId);
    let nextActive = state.activeTabId;
    if (state.activeTabId === tabId) {
      nextActive = remaining.length > 0 ? remaining[remaining.length - 1].tabId : null;
    }
    const nextComparison = state.comparisonTabId === tabId ? null : state.comparisonTabId;

    set((prev) => ({
      tabs: remaining,
      activeTabId: nextActive,
      comparisonTabId: nextComparison,
      closedTabsStack: [target.fileId, ...prev.closedTabsStack.filter((id) => id !== target.fileId)].slice(0, 15),
      lastSessionByFileId: {
        ...prev.lastSessionByFileId,
        [target.fileId]: target,
      },
    }));
  },

  closeOtherTabs: (tabId) => {
    const state = get();
    const keep = state.tabs.find((t) => t.tabId === tabId);
    if (!keep) return;
    set({
      tabs: [keep],
      activeTabId: keep.tabId,
      comparisonTabId: null,
    });
  },

  closeAllTabs: () => {
    set({
      tabs: [],
      activeTabId: null,
      comparisonTabId: null,
    });
  },

  restoreLastClosedTab: async () => {
    const stack = get().closedTabsStack;
    if (stack.length === 0) return;
    const [fileId, ...rest] = stack;
    set({ closedTabsStack: rest });
    await get().openFileInTab(fileId);
  },

  setActiveTab: (activeTabId) => set({ activeTabId }),
  setComparisonTab: (comparisonTabId) => set({ comparisonTabId }),

  reorderTabs: (fromIndex, toIndex) => {
    set((state) => {
      const next = [...state.tabs];
      if (fromIndex < 0 || fromIndex >= next.length || toIndex < 0 || toIndex >= next.length) {
        return state;
      }
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return { tabs: next };
    });
  },

  updateTabState: (tabId, patch) => {
    set((state) => {
      const nextTabs = state.tabs.map((t) => {
        if (t.tabId !== tabId) return t;
        const updated = { ...t, ...patch };
        // If searchQuery changed, compute matches from loadedDocument
        if (patch.searchQuery !== undefined && patch.searchMatches === undefined) {
          const doc = state.loadedDocuments[t.fileId];
          if (doc) {
            const matches = doc.search(patch.searchQuery);
            updated.searchMatches = matches;
            updated.activeMatchIndex = 0;
            if (matches.length > 0 && matches[0].pageOrIndex >= 1) {
              updated.currentPage = matches[0].pageOrIndex;
            }
          }
        }
        return updated;
      });
      const updatedTab = nextTabs.find((t) => t.tabId === tabId);
      return {
        tabs: nextTabs,
        lastSessionByFileId: updatedTab
          ? { ...state.lastSessionByFileId, [updatedTab.fileId]: updatedTab }
          : state.lastSessionByFileId,
      };
    });
  },

  toggleFavorite: (fileId) =>
    set((state) => ({
      files: state.files.map((f) => (f.id === fileId ? { ...f, isFavorite: !f.isFavorite } : f)),
    })),

  renameFile: (fileId, newName) =>
    set((state) => ({
      files: state.files.map((f) =>
        f.id === fileId
          ? { ...f, originalName: newName.trim() || f.originalName, sanitizedName: sanitizeFilename(newName) }
          : f
      ),
    })),

  moveFileToTrash: (fileId) => {
    const tab = get().tabs.find((t) => t.fileId === fileId);
    if (tab) get().closeTab(tab.tabId);
    set((state) => ({
      files: state.files.map((f) => (f.id === fileId ? { ...f, isTrashed: true } : f)),
    }));
  },

  restoreFileFromTrash: (fileId) =>
    set((state) => ({
      files: state.files.map((f) => (f.id === fileId ? { ...f, isTrashed: false } : f)),
    })),

  permanentlyRemoveFile: (fileId) => {
    const tab = get().tabs.find((t) => t.fileId === fileId);
    if (tab) get().closeTab(tab.tabId);
    set((state) => {
      const nextBuffers = { ...state.fileBuffers };
      const nextDocs = { ...state.loadedDocuments };
      nextDocs[fileId]?.dispose();
      delete nextBuffers[fileId];
      delete nextDocs[fileId];
      return {
        files: state.files.filter((f) => f.id !== fileId),
        fileBuffers: nextBuffers,
        loadedDocuments: nextDocs,
      };
    });
  },

  createFolder: (name) => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const folder: WorkspaceFolder = {
      id: `folder-${Date.now()}`,
      name: trimmed,
      parentId: null,
      color: '#6366f1',
      createdAt: new Date().toISOString(),
    };
    set((state) => ({ folders: [...state.folders, folder] }));
    return folder.id;
  },

  assignFileToFolder: (fileId, folderId) =>
    set((state) => ({
      files: state.files.map((f) => (f.id === fileId ? { ...f, folderId } : f)),
    })),

  addAnnotation: (fileId, input) => {
    const state = get();
    const file = state.files.find((f) => f.id === fileId);
    if (!file) return;
    const currentList = state.annotationsByFileId[fileId] ?? [];
    const now = new Date().toISOString();
    const newAnnotation: DocumentAnnotation = {
      ...input,
      id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      fileId,
      fileChecksum: file.checksum,
      createdAt: now,
      updatedAt: now,
    };

    set((prev) => ({
      annotationsByFileId: {
        ...prev.annotationsByFileId,
        [fileId]: [...currentList, newAnnotation],
      },
      annotationUndoStack: {
        ...prev.annotationUndoStack,
        [fileId]: [...(prev.annotationUndoStack[fileId] ?? []), currentList],
      },
      annotationRedoStack: {
        ...prev.annotationRedoStack,
        [fileId]: [],
      },
      tabs: prev.tabs.map((t) =>
        t.fileId === fileId ? { ...t, hasUnsavedAnnotations: true } : t
      ),
    }));
  },

  updateAnnotationComment: (fileId, annotationId, comment) => {
    set((prev) => {
      const currentList = prev.annotationsByFileId[fileId] ?? [];
      const nextList = currentList.map((a) =>
        a.id === annotationId ? { ...a, comment, updatedAt: new Date().toISOString() } : a
      );
      return {
        annotationsByFileId: { ...prev.annotationsByFileId, [fileId]: nextList },
        annotationUndoStack: {
          ...prev.annotationUndoStack,
          [fileId]: [...(prev.annotationUndoStack[fileId] ?? []), currentList],
        },
      };
    });
  },

  deleteAnnotation: (fileId, annotationId) => {
    set((prev) => {
      const currentList = prev.annotationsByFileId[fileId] ?? [];
      return {
        annotationsByFileId: {
          ...prev.annotationsByFileId,
          [fileId]: currentList.filter((a) => a.id !== annotationId),
        },
        annotationUndoStack: {
          ...prev.annotationUndoStack,
          [fileId]: [...(prev.annotationUndoStack[fileId] ?? []), currentList],
        },
      };
    });
  },

  undoAnnotation: (fileId) => {
    const state = get();
    const undoList = state.annotationUndoStack[fileId] ?? [];
    if (undoList.length === 0) return;
    const previousState = undoList[undoList.length - 1];
    const currentList = state.annotationsByFileId[fileId] ?? [];

    set((prev) => ({
      annotationsByFileId: {
        ...prev.annotationsByFileId,
        [fileId]: previousState,
      },
      annotationUndoStack: {
        ...prev.annotationUndoStack,
        [fileId]: undoList.slice(0, -1),
      },
      annotationRedoStack: {
        ...prev.annotationRedoStack,
        [fileId]: [...(prev.annotationRedoStack[fileId] ?? []), currentList],
      },
    }));
  },

  redoAnnotation: (fileId) => {
    const state = get();
    const redoList = state.annotationRedoStack[fileId] ?? [];
    if (redoList.length === 0) return;
    const nextState = redoList[redoList.length - 1];
    const currentList = state.annotationsByFileId[fileId] ?? [];

    set((prev) => ({
      annotationsByFileId: {
        ...prev.annotationsByFileId,
        [fileId]: nextState,
      },
      annotationUndoStack: {
        ...prev.annotationUndoStack,
        [fileId]: [...(prev.annotationUndoStack[fileId] ?? []), currentList],
      },
      annotationRedoStack: {
        ...prev.annotationRedoStack,
        [fileId]: redoList.slice(0, -1),
      },
    }));
  },

  toggleBookmark: (fileId, position, label) => {
    set((prev) => {
      const list = prev.bookmarksByFileId[fileId] ?? [];
      const exists = list.find((b) => b.position === position);
      const next = exists
        ? list.filter((b) => b.position !== position)
        : [
            ...list,
            {
              id: `bm-${Date.now()}`,
              fileId,
              position,
              label,
              createdAt: new Date().toISOString(),
            },
          ];
      return {
        bookmarksByFileId: { ...prev.bookmarksByFileId, [fileId]: next },
      };
    });
  },

  requestServerConversion: async (fileId) => {
    const file = get().files.find((f) => f.id === fileId);
    if (!file) return;
    const jobId = `job-${Date.now()}`;
    const job: ConversionJob = {
      id: jobId,
      fileId,
      fileChecksum: file.checksum,
      sourceFormat: file.extension,
      targetFormat: 'pdf',
      converterName: 'libreoffice-headless',
      status: 'processing',
      progress: 25,
      fidelityWarning:
        'Isolated LibreOffice headless worker converting document in non-root sandbox container (macros disabled).',
      startedAt: new Date().toISOString(),
    };
    set((prev) => ({
      conversionJobs: { ...prev.conversionJobs, [fileId]: job },
      files: prev.files.map((f) => (f.id === fileId ? { ...f, status: 'converting' } : f)),
    }));

    await new Promise((r) => setTimeout(r, 600));
    set((prev) => ({
      conversionJobs: {
        ...prev.conversionJobs,
        [fileId]: {
          ...job,
          status: 'completed',
          progress: 100,
          completedAt: new Date().toISOString(),
        },
      },
      files: prev.files.map((f) => (f.id === fileId ? { ...f, status: 'ready' } : f)),
    }));
  },
}));

// ---------------------------------------------------------------- persistence

const PERSIST_VERSION = 1;

interface PersistedWorkspace {
  version: number;
  seeded: boolean;
  theme: WorkspaceState['theme'];
  motion?: WorkspaceState['motion'];
  explorerOpenMode?: WorkspaceState['explorerOpenMode'];
  workspaceMode: WorkspaceState['workspaceMode'];
  leftSidebarOpen: boolean;
  rightInspectorOpen: boolean;
  activeInspectorTab: InspectorTab;
  files: DetectedFile[];
  folders: WorkspaceFolder[];
  sidebarFilter: SidebarFilter;
  fileManagerViewMode: WorkspaceState['fileManagerViewMode'];
  sortBy: WorkspaceState['sortBy'];
  sortOrder: WorkspaceState['sortOrder'];
  annotationsByFileId: WorkspaceState['annotationsByFileId'];
  bookmarksByFileId: WorkspaceState['bookmarksByFileId'];
  lastSessionByFileId: WorkspaceState['lastSessionByFileId'];
  recentFileIds?: string[];
  openTabFileIds: string[];
  activeFileId: string | null;
}

let initPromise: Promise<void> | null = null;
let hydrated = false;
let persistenceSuspended = false;

function applyMotion(motion: WorkspaceState['motion']) {
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('reduce-motion', motion === 'reduced');
  }
}

/** Wipes every saved file and setting, then reloads into a first-run workspace. */
export async function resetWorkspace(): Promise<void> {
  persistenceSuspended = true;
  if (saveTimer) clearTimeout(saveTimer);
  await clearWorkspace();
  window.location.reload();
}

/** View state worth restoring; search results and tool selection are transient. */
function sessionOf(tab: TabViewerState): Partial<TabViewerState> {
  return {
    currentPage: tab.currentPage,
    totalPages: tab.totalPages,
    zoom: tab.zoom,
    fitMode: tab.fitMode,
    rotation: tab.rotation,
    pdfViewMode: tab.pdfViewMode,
    docReadingMode: tab.docReadingMode,
    activeSheet: tab.activeSheet,
    ebookTheme: tab.ebookTheme,
    ebookFontSize: tab.ebookFontSize,
    showThumbnails: tab.showThumbnails,
    scrollTop: tab.scrollTop,
    scrollLeft: tab.scrollLeft,
  };
}

function toSnapshot(state: WorkspaceState): PersistedWorkspace {
  const lastSessionByFileId = { ...state.lastSessionByFileId };
  for (const tab of state.tabs) lastSessionByFileId[tab.fileId] = sessionOf(tab);
  const workspaceTabs = state.tabs.filter((t) => !t.isQuickView);
  const activeTab = workspaceTabs.find((t) => t.tabId === state.activeTabId);
  return {
    version: PERSIST_VERSION,
    seeded: true,
    theme: state.theme,
    motion: state.motion,
    explorerOpenMode: state.explorerOpenMode,
    workspaceMode: state.workspaceMode,
    leftSidebarOpen: state.leftSidebarOpen,
    rightInspectorOpen: state.rightInspectorOpen,
    activeInspectorTab: state.activeInspectorTab,
    files: state.files,
    folders: state.folders,
    sidebarFilter: state.sidebarFilter,
    fileManagerViewMode: state.fileManagerViewMode,
    sortBy: state.sortBy,
    sortOrder: state.sortOrder,
    annotationsByFileId: state.annotationsByFileId,
    bookmarksByFileId: state.bookmarksByFileId,
    lastSessionByFileId,
    recentFileIds: state.recentFileIds,
    openTabFileIds: workspaceTabs.map((t) => t.fileId),
    activeFileId: activeTab?.fileId ?? null,
  };
}

async function restoreOrSeedWorkspace(): Promise<void> {
  const store = useWorkspaceStore;
  const snapshot = await loadSnapshot<PersistedWorkspace>();

  if (snapshot && snapshot.version === PERSIST_VERSION) {
    const fileIds = snapshot.files.map((f) => f.id);
    const buffers = await loadBuffers(fileIds);
    markBuffersPersisted(Object.keys(buffers));
    const files = snapshot.files.filter((f) => buffers[f.id]);
    store.setState({
      theme: snapshot.theme,
      motion: snapshot.motion ?? 'system',
      explorerOpenMode: snapshot.explorerOpenMode ?? 'quick-view',
      workspaceMode: snapshot.workspaceMode,
      leftSidebarOpen: snapshot.leftSidebarOpen,
      rightInspectorOpen: snapshot.rightInspectorOpen,
      activeInspectorTab: snapshot.activeInspectorTab,
      files,
      fileBuffers: buffers,
      folders: snapshot.folders,
      sidebarFilter: snapshot.sidebarFilter,
      fileManagerViewMode: snapshot.fileManagerViewMode,
      sortBy: snapshot.sortBy,
      sortOrder: snapshot.sortOrder,
      annotationsByFileId: snapshot.annotationsByFileId,
      bookmarksByFileId: snapshot.bookmarksByFileId,
      lastSessionByFileId: snapshot.lastSessionByFileId,
      recentFileIds: (snapshot.recentFileIds ?? []).filter((id) => buffers[id]),
    });
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', snapshot.theme === 'dark');
    }
    applyMotion(snapshot.motion ?? 'system');
    // Reopen the tabs that were open, in order, then refocus the active one.
    for (const fileId of snapshot.openTabFileIds) {
      if (buffers[fileId]) await store.getState().openFileInTab(fileId);
    }
    const active = store.getState().tabs.find((t) => t.fileId === snapshot.activeFileId);
    store.setState({
      activeTabId: active?.tabId ?? store.getState().tabs[0]?.tabId ?? null,
      // Reopening tabs reshuffles recents; put the saved order back.
      recentFileIds: (snapshot.recentFileIds ?? []).filter((id) => buffers[id]),
    });
  } else if (store.getState().files.length === 0) {
    // First run only: put the sample gallery in the library, but open nothing.
    const { generateStarterWorkspaceSamples } = await import('../services/sampleFixtures');
    const samples = await generateStarterWorkspaceSamples();
    await store.getState().importFiles(
      samples.map((s) => ({
        name: s.name,
        bytes: s.bytes,
        declaredMime: s.mimeType,
        folderId: s.folderId,
        isFavorite: s.isFavorite,
      })),
      'sample-fixture',
      false
    );
  }

  hydrated = true;
  persistNow();
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persistNow() {
  if (!hydrated || persistenceSuspended) return;
  const state = useWorkspaceStore.getState();
  void saveWorkspace(toSnapshot(state), state.fileBuffers);
}

useWorkspaceStore.subscribe((state, prev) => {
  if (!hydrated) return;
  // Skip churn that has nothing to persist (search typing, transient notices).
  if (
    state.files === prev.files &&
    state.recentFileIds === prev.recentFileIds &&
    state.tabs === prev.tabs &&
    state.activeTabId === prev.activeTabId &&
    state.folders === prev.folders &&
    state.annotationsByFileId === prev.annotationsByFileId &&
    state.bookmarksByFileId === prev.bookmarksByFileId &&
    state.theme === prev.theme &&
    state.motion === prev.motion &&
    state.explorerOpenMode === prev.explorerOpenMode &&
    state.leftSidebarOpen === prev.leftSidebarOpen &&
    state.rightInspectorOpen === prev.rightInspectorOpen &&
    state.sidebarFilter === prev.sidebarFilter &&
    state.fileManagerViewMode === prev.fileManagerViewMode &&
    state.sortBy === prev.sortBy &&
    state.sortOrder === prev.sortOrder &&
    state.workspaceMode === prev.workspaceMode
  ) {
    return;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 400);
});

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', persistNow);
}

