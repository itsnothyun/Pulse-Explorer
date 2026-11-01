import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Brand, Eyebrow, Pip, PixelText, Scanner, Sweep } from './components/pulse/Pixel';
import { Menu } from './components/pulse/Menu';
import { Dashboard } from './components/Dashboard';
import { QuickView } from './components/QuickView';
import { RecentView } from './components/RecentView';
import { PcFilesSection } from './components/PcFilesSection';
import { SettingsModal, type SettingsTab } from './components/SettingsModal';
import { PixelIcon, categoryGlyph, type PixelIconName } from './components/pulse/PixelIcon';
import { Select } from './components/pulse/Select';
import { Segmented } from './components/pulse/Segmented';
import { NewCollectionModal } from './components/NewCollectionModal';
import { CommandPalette, type Command } from './components/CommandPalette';
import { FileContextMenu, type FileMenuState } from './components/FileContextMenu';
import { useEnterOnChange } from './components/pulse/motion';
import { WindowControls } from './components/pulse/WindowControls';
import { TYPE_EXTENSIONS, isDesktop, openDefaultAppsSettings, startWindowDrag, subscribeToOpenWithFiles, syncExplorerOpenMode } from './services/desktopBridge';
import {
  Archive,
  BookMarked,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Cloud,
  Code2,
  Columns,
  Download,
  Eye,
  FileCode,
  Files,
  FileSpreadsheet,
  FileText,
  Film,
  Folder,
  FolderPlus,
  Globe,
  Grid,
  HardDrive,
  Highlighter,
  History,
  Home,
  Image as ImageIcon,
  Info,
  Keyboard,
  LayoutGrid,
  List,
  Maximize2,
  MoreHorizontal,
  MessageSquare,
  Minimize2,
  Moon,
  MousePointer,
  Music,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  PenTool,
  Plus,
  Presentation,
  Printer,
  Redo2,
  RotateCcw,
  RotateCw,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  Star,
  Sun,
  Trash2,
  Underline,
  Undo2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { AnnotationType, DetectedFile, FileCategory } from '@omniview/shared-types';
import { formatFileSize } from '@omniview/utilities';
import {
  useWorkspaceStore,
  viewerRegistry,
  type SidebarFilter,
} from './stores/useWorkspaceStore';
import { ViewerHost } from './components/viewers/ViewerHost';

export function getCategoryIcon(category: FileCategory, className = 'w-4 h-4') {
  switch (category) {
    case 'pdf':
      return <FileText className={`${className} text-rose-400`} />;
    case 'word':
      return <FileText className={`${className} text-blue-400`} />;
    case 'presentation':
      return <Presentation className={`${className} text-orange-400`} />;
    case 'spreadsheet':
      return <FileSpreadsheet className={`${className} text-emerald-400`} />;
    case 'image':
      return <ImageIcon className={`${className} text-purple-400`} />;
    case 'ebook':
      return <BookOpen className={`${className} text-amber-400`} />;
    case 'code':
    case 'text':
      return <FileCode className={`${className} text-cyan-400`} />;
    case 'audio':
      return <Music className={`${className} text-pink-400`} />;
    case 'video':
      return <Film className={`${className} text-indigo-400`} />;
    case 'archive':
      return <Archive className={`${className} text-yellow-400`} />;
    default:
      return <FileText className={`${className} text-slate-400`} />;
  }
}

export const App: React.FC = () => {
  const {
    theme,
    workspaceMode,
    isDistractionFree,
    leftSidebarOpen,
    rightInspectorOpen,
    activeInspectorTab,
    files,
    fileBuffers,
    loadedDocuments,
    folders,
    sidebarFilter,
    fileManagerViewMode,
    sortBy,
    sortOrder,
    globalSearchQuery,
    duplicateNotice,
    tabs,
    activeTabId,
    comparisonTabId,
    closedTabsStack,
    annotationsByFileId,
    bookmarksByFileId,
    toggleTheme,
    setWorkspaceMode,
    setDistractionFree,
    setLeftSidebarOpen,
    setRightInspectorOpen,
    setActiveInspectorTab,
    setSidebarFilter,
    setFileManagerViewMode,
    setSort,
    setGlobalSearchQuery,
    clearDuplicateNotice,
    initializeStarterFiles,
    importFiles,
    openFileInTab,
    closeTab,
    closeOtherTabs,
    closeAllTabs,
    restoreLastClosedTab,
    setActiveTab,
    setComparisonTab,
    updateTabState,
    toggleFavorite,
    moveFileToTrash,
    restoreFileFromTrash,
    permanentlyRemoveFile,
    createFolder,
    deleteAnnotation,
    undoAnnotation,
    redoAnnotation,
  } = useWorkspaceStore();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inDocSearchInputRef = useRef<HTMLInputElement | null>(null);

  const [isDraggingOver, setIsDraggingOver] = useState<boolean>(false);
  const [showLibraryDrawer, setShowLibraryDrawer] = useState<boolean>(false);
  const [showUrlImportModal, setShowUrlImportModal] = useState<boolean>(false);
  const [urlImportInput, setUrlImportInput] = useState<string>('');
  const [urlImportError, setUrlImportError] = useState<string | null>(null);
  const [showShortcutsModal, setShowShortcutsModal] = useState<boolean>(false);
  const [showNewCollection, setShowNewCollection] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quickViewQueue, setQuickViewQueue] = useState<string[] | null>(null);
  const explorerOpenMode = useWorkspaceStore((s) => s.explorerOpenMode);
  const explorerOpenModeRef = useRef(explorerOpenMode);
  useEffect(() => {
    void syncExplorerOpenMode(explorerOpenMode);
  }, [explorerOpenMode]);
  explorerOpenModeRef.current = explorerOpenMode;
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const openSettings = (tab: SettingsTab = 'general') => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  };
  const [showHome, setShowHome] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [fileMenu, setFileMenu] = useState<FileMenuState | null>(null);
  const [typesOpen, setTypesOpen] = useState(true);
  const viewportRef = useRef<HTMLDivElement>(null);
  const quickViewOpenRef = useRef(false);
  quickViewOpenRef.current = Boolean(quickViewQueue);
  const recentFileIds = useWorkspaceStore((s) => s.recentFileIds);
  const renameFile = useWorkspaceStore((s) => s.renameFile);
  const assignFileToFolder = useWorkspaceStore((s) => s.assignFileToFolder);

  /** The three places: home (dashboard), library (filtered files) and the open document. */
  const goHome = () => {
    setShowHome(true);
    setShowLibraryDrawer(false);
  };
  const goLibrary = (filter?: SidebarFilter) => {
    if (filter) setSidebarFilter(filter);
    setShowLibraryDrawer(true);
    setShowHome(false);
  };
  const openFile = (fileId: string) => {
    setShowLibraryDrawer(false);
    void openFileInTab(fileId).then(() => setShowHome(false));
  };

  // Initialize starter real binary files on mount
  useEffect(() => {
    void initializeStarterFiles();
  }, [initializeStarterFiles]);

  useEffect(() => {
    setShowHome(false);
  }, [activeTabId]);

  const activeTab = useMemo(
    () => tabs.find((t) => t.tabId === activeTabId) ?? null,
    [tabs, activeTabId]
  );
  const activeFile = useMemo(
    () => (activeTab ? files.find((f) => f.id === activeTab.fileId) ?? null : null),
    [files, activeTab]
  );
  const activeCapabilities = useMemo(() => {
    if (!activeFile) return null;
    return viewerRegistry.resolve(activeFile).getCapabilities(activeFile);
  }, [activeFile]);

  const comparisonTab = useMemo(
    () => (comparisonTabId ? tabs.find((t) => t.tabId === comparisonTabId) ?? null : null),
    [tabs, comparisonTabId]
  );
  const comparisonFile = useMemo(
    () => (comparisonTab ? files.find((f) => f.id === comparisonTab.fileId) ?? null : null),
    [files, comparisonTab]
  );

  // Filtered & sorted files for workspace sidebar and library view
  const filteredFiles = useMemo(() => {
    return files
      .filter((f) => {
        if (sidebarFilter === 'trash') return Boolean(f.isTrashed);
        if (f.isTrashed) return false;
        if (sidebarFilter === 'favorites') return Boolean(f.isFavorite);
        if (sidebarFilter.startsWith('folder:')) {
          const folderId = sidebarFilter.replace('folder:', '');
          return f.folderId === folderId;
        }
        if (sidebarFilter === 'recent') return recentFileIds.includes(f.id);
        if (sidebarFilter !== 'all') {
          return f.category === sidebarFilter;
        }
        return true;
      })
      .filter((f) => {
        const q = globalSearchQuery.trim().toLowerCase();
        if (!q) return true;
        const nameMatch =
          f.originalName.toLowerCase().includes(q) ||
          f.extension.toLowerCase().includes(q) ||
          f.detectedMimeType.toLowerCase().includes(q);
        if (nameMatch) return true;
        // Also check indexed extracted document text
        const doc = loadedDocuments[f.id];
        return Boolean(
          doc && doc.extractedTextByUnit.some((unit) => unit.toLowerCase().includes(q))
        );
      })
      .sort((a, b) => {
        if (sidebarFilter === 'recent') return recentFileIds.indexOf(a.id) - recentFileIds.indexOf(b.id);
        const dir = sortOrder === 'asc' ? 1 : -1;
        if (sortBy === 'name') return a.originalName.localeCompare(b.originalName) * dir;
        if (sortBy === 'size') return (a.sizeBytes - b.sizeBytes) * dir;
        return (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * dir;
      });
  }, [files, sidebarFilter, globalSearchQuery, loadedDocuments, sortBy, sortOrder, recentFileIds]);

  // Context-Aware Keyboard Shortcuts (Section 17)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (quickViewOpenRef.current) return;
      const target = e.target as HTMLElement | null;
      const isInput =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);

      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (mod && e.key === 'Tab' && tabs.length > 1) {
        e.preventDefault();
        const i = tabs.findIndex((t) => t.tabId === activeTabId);
        const next = tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length];
        setActiveTab(next.tabId);
        setShowLibraryDrawer(false);
        setShowHome(false);
        return;
      }
      if (mod && /^[1-9]$/.test(e.key) && !isInput) {
        const t = e.key === '9' ? tabs[tabs.length - 1] : tabs[Number(e.key) - 1];
        if (t) {
          e.preventDefault();
          setActiveTab(t.tabId);
          setShowLibraryDrawer(false);
          setShowHome(false);
        }
        return;
      }
      if (mod && e.key.toLowerCase() === 'w' && activeTab) {
        e.preventDefault();
        closeTab(activeTab.tabId);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        fileInputRef.current?.click();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        if (activeTab && activeCapabilities?.search) {
          e.preventDefault();
          inDocSearchInputRef.current?.focus();
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
        if (activeTab && activeCapabilities?.print) {
          e.preventDefault();
          window.print();
        }
        return;
      }
      if (e.key === 'Escape' && isDistractionFree) {
        e.preventDefault();
        setDistractionFree(false);
        return;
      }

      if (isInput || !activeTab) return;

      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        updateTabState(activeTab.tabId, { zoom: Math.min(300, activeTab.zoom + 15) });
      } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        updateTabState(activeTab.tabId, { zoom: Math.max(40, activeTab.zoom - 15) });
      } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        updateTabState(activeTab.tabId, { zoom: 100 });
      } else if (e.key === 'ArrowRight') {
        if (activeTab.currentPage < activeTab.totalPages) {
          updateTabState(activeTab.tabId, { currentPage: activeTab.currentPage + 1 });
        }
      } else if (e.key === 'ArrowLeft') {
        if (activeTab.currentPage > 1) {
          updateTabState(activeTab.tabId, { currentPage: activeTab.currentPage - 1 });
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeTab, activeCapabilities, isDistractionFree, setDistractionFree, updateTabState, tabs, activeTabId, setActiveTab, closeTab]);

  // Global Clipboard Paste Handler
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      const pastedFiles = Array.from(e.clipboardData?.files ?? []);
      if (pastedFiles.length === 0) return;
      const items = await Promise.all(
        pastedFiles.map(async (f) => ({
          name: f.name,
          bytes: await f.arrayBuffer(),
          declaredMime: f.type,
        }))
      );
      await importFiles(items, 'clipboard', true);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [importFiles, openFileInTab]);

  // Panels overlay instead of squeezing the document on narrow windows; close them when crossing down.
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 1023px)');
    const medium = window.matchMedia('(max-width: 1279px)');
    const onNarrow = () => narrow.matches && setLeftSidebarOpen(false);
    const onMedium = () => medium.matches && setRightInspectorOpen(false);
    onNarrow();
    narrow.addEventListener('change', onNarrow);
    medium.addEventListener('change', onMedium);
    return () => {
      narrow.removeEventListener('change', onNarrow);
      medium.removeEventListener('change', onMedium);
    };
  }, [setLeftSidebarOpen, setRightInspectorOpen]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    const onOpened = (ids: string[], forceTab = false) => {
      if (ids.length === 0) return;
      if (!forceTab && explorerOpenModeRef.current === 'quick-view') {
        setQuickViewQueue(ids);
      } else {
        setShowLibraryDrawer(false);
        void (async () => {
          for (const id of ids) await openFileInTab(id);
          setShowHome(false);
        })();
      }
    };
    void subscribeToOpenWithFiles(importFiles, onOpened).then((fn) => {
      if (cancelled) fn();
      else unsubscribe = fn;
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [importFiles]);

  const handleBrowserFileSelect = async (fileList: FileList | null, source: 'local-picker' | 'local-drag-drop') => {
    if (!fileList || fileList.length === 0) return;
    const items = await Promise.all(
      Array.from(fileList).map(async (f) => ({
        name: f.name,
        bytes: await f.arrayBuffer(),
        declaredMime: f.type,
      }))
    );
    await importFiles(items, source, true);
    setShowLibraryDrawer(false);
  };

  const currentView: 'home' | 'library' | 'viewer' = showLibraryDrawer
    ? 'library'
    : showHome || !activeTab || !activeFile
    ? 'home'
    : 'viewer';
  useEnterOnChange(viewportRef, currentView === 'viewer' ? `viewer:${activeTabId}` : currentView);

  const liveCount = files.filter((f) => !f.isTrashed).length;
  const libraryTitle =
    sidebarFilter === 'all'
      ? 'Library'
      : sidebarFilter === 'recent'
      ? 'Recent'
      : sidebarFilter === 'favorites'
      ? 'Favorites'
      : sidebarFilter === 'trash'
      ? 'Trash'
      : sidebarFilter.startsWith('folder:')
      ? folders.find((fo) => `folder:${fo.id}` === sidebarFilter)?.name ?? 'Collection'
      : ({ pdf: 'PDF', word: 'Documents', presentation: 'Slides', spreadsheet: 'Sheets', ebook: 'eBooks', image: 'Images', code: 'Code', audio: 'Media', video: 'Media', archive: 'Archives' } as Record<string, string>)[sidebarFilter] ?? 'Library';
  const trashCount = files.filter((f) => f.isTrashed).length;
  const typeNav = (
    [
      { id: 'pdf', label: 'PDF', icon: 'pdf', cats: ['pdf'] },
      { id: 'word', label: 'Documents', icon: 'word', cats: ['word'] },
      { id: 'presentation', label: 'Slides', icon: 'presentation', cats: ['presentation'] },
      { id: 'spreadsheet', label: 'Sheets', icon: 'spreadsheet', cats: ['spreadsheet'] },
      { id: 'ebook', label: 'eBooks', icon: 'ebook', cats: ['ebook'] },
      { id: 'image', label: 'Images', icon: 'image', cats: ['image'] },
      { id: 'code', label: 'Code', icon: 'code', cats: ['code'] },
      { id: 'audio', label: 'Media', icon: 'audio', cats: ['audio', 'video'] },
      { id: 'archive', label: 'Archives', icon: 'archive', cats: ['archive'] },
    ] as { id: SidebarFilter; label: string; icon: FileCategory; cats: FileCategory[] }[]
  )
    .map((t) => ({ ...t, count: files.filter((f) => !f.isTrashed && t.cats.includes(f.category)).length }))
    .filter((t) => t.count > 0);

  const commands: Command[] = [
    ...tabs.map((t, i) => {
      const f = files.find((fl) => fl.id === t.fileId);
      return {
        id: `tab-${t.tabId}`,
        group: 'Open tabs' as const,
        label: f?.originalName ?? 'Tab',
        hint: i < 8 ? `Ctrl ${i + 1}` : undefined,
        icon: f ? getCategoryIcon(f.category, 'w-3.5 h-3.5') : undefined,
        run: () => {
          setActiveTab(t.tabId);
          setShowLibraryDrawer(false);
          setShowHome(false);
        },
      };
    }),
    { id: 'go-home', group: 'Go to', label: 'Home', icon: <Home className="w-3.5 h-3.5" />, run: goHome },
    { id: 'go-library', group: 'Go to', label: 'Library', icon: <Files className="w-3.5 h-3.5" />, run: () => goLibrary('all') },
    { id: 'go-recent', group: 'Go to', label: 'Recent', icon: <Clock className="w-3.5 h-3.5" />, run: () => goLibrary('recent') },
    { id: 'go-favorites', group: 'Go to', label: 'Favorites', icon: <Star className="w-3.5 h-3.5" />, run: () => goLibrary('favorites') },
    ...folders.map((fo) => ({
      id: `go-folder-${fo.id}`,
      group: 'Go to' as const,
      label: fo.name,
      keywords: 'collection folder',
      icon: <Folder className="w-3.5 h-3.5" />,
      run: () => goLibrary(`folder:${fo.id}` as SidebarFilter),
    })),
    { id: 'act-open', group: 'Actions', label: 'Open files…', hint: 'Ctrl O', icon: <Upload className="w-3.5 h-3.5" />, run: () => fileInputRef.current?.click() },
    { id: 'act-collection', group: 'Actions', label: 'New collection…', keywords: 'folder group', icon: <Plus className="w-3.5 h-3.5" />, run: () => setShowNewCollection(true) },
    { id: 'act-url', group: 'Actions', label: 'Import from URL…', icon: <Globe className="w-3.5 h-3.5" />, run: () => setShowUrlImportModal(true) },
    { id: 'act-sidebar', group: 'Actions', label: leftSidebarOpen ? 'Hide sidebar' : 'Show sidebar', icon: <PanelLeftOpen className="w-3.5 h-3.5" />, run: () => setLeftSidebarOpen(!leftSidebarOpen) },
    ...(activeFile
      ? [
          { id: 'act-details', group: 'Actions' as const, label: rightInspectorOpen ? 'Hide details' : 'Show details', icon: <PanelRightOpen className="w-3.5 h-3.5" />, run: () => setRightInspectorOpen(!rightInspectorOpen) },
          { id: 'act-fullscreen', group: 'Actions' as const, label: 'Focus mode', keywords: 'fullscreen distraction free', icon: <Maximize2 className="w-3.5 h-3.5" />, run: () => setDistractionFree(true) },
          { id: 'act-download', group: 'Actions' as const, label: 'Download original', icon: <Download className="w-3.5 h-3.5" />, run: () => handleDownloadOriginal(activeFile) },
        ]
      : []),
    ...(closedTabsStack.length > 0
      ? [{ id: 'act-reopen', group: 'Actions' as const, label: 'Reopen closed tab', icon: <History className="w-3.5 h-3.5" />, run: () => void restoreLastClosedTab() }]
      : []),
    { id: 'act-settings', group: 'Actions', label: 'Settings', keywords: 'preferences theme motion', icon: <PixelIcon name="settings" size={7} />, run: () => openSettings('general') },
    { id: 'act-shortcuts', group: 'Actions', label: 'Keyboard shortcuts', icon: <Keyboard className="w-3.5 h-3.5" />, run: () => openSettings('shortcuts') },
    ...(isDesktop()
      ? [{ id: 'act-default', group: 'Actions' as const, label: 'Set Pulse as default app…', keywords: 'associate open with', run: () => void openDefaultAppsSettings() }]
      : []),
    ...files
      .filter((f) => !f.isTrashed)
      .map((f) => ({
        id: `file-${f.id}`,
        group: 'Files' as const,
        label: f.originalName,
        keywords: `${f.extension} ${f.category}`,
        icon: getCategoryIcon(f.category, 'w-3.5 h-3.5'),
        run: () => openFile(f.id),
      })),
  ];

  const handleDownloadOriginal = (file: DetectedFile) => {
    const buffer = fileBuffers[file.id];
    if (!buffer) return;
    const blob = new Blob([buffer], { type: file.detectedMimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.originalName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSafeUrlImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setUrlImportError(null);
    const raw = urlImportInput.trim();
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        setUrlImportError('Only HTTP/HTTPS URLs are permitted.');
        return;
      }
      const host = parsed.hostname.toLowerCase();
      if (
        host === 'localhost' ||
        host.startsWith('127.') ||
        host.startsWith('10.') ||
        host.startsWith('192.168.') ||
        host.startsWith('169.254.') ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
      ) {
        setUrlImportError(
          'SSRF Protection: Private network, loopback, and cloud metadata addresses are strictly blocked.'
        );
        return;
      }
      const res = await fetch(parsed.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const name = parsed.pathname.split('/').pop() || 'imported-document.txt';
      await importFiles(
        [{ name, bytes: buf, declaredMime: res.headers.get('content-type') || '' }],
        'url-import',
        true
      );
      setShowUrlImportModal(false);
      setUrlImportInput('');
    } catch (err) {
      setUrlImportError(
        err instanceof Error ? err.message : 'Unable to fetch remote document.'
      );
    }
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setIsDraggingOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setIsDraggingOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDraggingOver(false);
        void handleBrowserFileSelect(e.dataTransfer.files, 'local-drag-drop');
      }}
      className={`flex flex-col h-screen w-screen overflow-hidden ${
        theme === 'dark' ? 'bg-slate-950 text-slate-100' : 'bg-slate-100 text-slate-900'
      }`}
      data-testid="omniview-app-shell"
    >
      {/* Hidden Native File Input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        data-testid="global-file-input"
        className="hidden"
        onChange={(e) => {
          void handleBrowserFileSelect(e.target.files, 'local-picker');
          e.currentTarget.value = '';
        }}
      />

      {/* Global Drag & Drop Overlay */}
      {isDraggingOver && (
        <div className="anim-fade fixed inset-0 z-50 bg-slate-950/90 border border-dotted border-slate-600 m-3 rounded-xl flex flex-col items-center justify-center gap-5 pointer-events-none">
          <Sweep />
          <Scanner big />
          <h2>
            <PixelText text="DROP TO VIEW" dot={8} label="Drop files anywhere to inspect and render locally" align="center" />
          </h2>
          <p className="text-sm text-slate-300">Drop files anywhere to inspect and render locally.</p>
          <p className="text-xs text-slate-400 font-mono">
            PDF • DOCX • PPTX • XLSX • CSV • EPUB • SVG/PNG • Code • Audio/Video • ZIP
          </p>
        </div>
      )}

      {/* Duplicate Detection Toast Notice */}
      {duplicateNotice && (
        <div role="status" className="anim-toast fixed bottom-10 right-6 z-50 max-w-md rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 shadow-2xl flex items-start gap-3 text-xs">
          <Info className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1 text-slate-200">{duplicateNotice}</div>
          <button
            onClick={clearDuplicateNotice}
            className="text-slate-400 hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* =================================================================== */}
      {/* TOP GLOBAL HEADER BAR */}
      {/* =================================================================== */}
      {!isDistractionFree && (
        <header onMouseDown={(e) => startWindowDrag(e)} className="h-12 shrink-0 border-b border-slate-800 bg-slate-950 pl-3 flex items-center justify-between gap-4">
          {/* Brand & Sidebar Toggle */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => setLeftSidebarOpen(!leftSidebarOpen)}
              className="icon-btn"
              title="Toggle sidebar"
            >
              <PixelIcon name="sidebar" size={14} />
            </button>

            <button
              onClick={() => {
                setShowHome(true);
                setShowLibraryDrawer(false);
              }}
              className="rounded focus-visible:outline-offset-4"
              title="Home"
              data-testid="home-button"
            >
              <Brand />
            </button>
          </div>

          {/* Global File & Content Search */}
          <div className="flex-1 max-w-sm relative hidden md:block">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              data-testid="global-search-input"
              value={globalSearchQuery}
              onChange={(e) => {
                setGlobalSearchQuery(e.target.value);
                if (e.target.value) goLibrary();
              }}
              placeholder="Search files"
              className="w-full pl-9 pr-8 py-1.5 rounded-lg bg-transparent border border-slate-800 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
            />
            {globalSearchQuery && (
              <button
                onClick={() => setGlobalSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Right side: open (only when the sidebar is hidden) and the details panel */}
          <div className="flex items-center gap-1">
            {!leftSidebarOpen && (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="icon-btn anim-fade"
                title="Open files (Ctrl O)"
                aria-label="Open files"
              >
                <PixelIcon name="open" size={14} />
              </button>
            )}
            {activeFile && currentView === 'viewer' && (
              <button
                onClick={() => setRightInspectorOpen(!rightInspectorOpen)}
                aria-pressed={rightInspectorOpen}
                className={`icon-btn ${rightInspectorOpen ? 'icon-btn-on' : ''}`}
                title="Details panel"
              >
                <PixelIcon name="details" size={14} />
              </button>
            )}
          </div>
          <WindowControls />
        </header>
      )}

      {/* =================================================================== */}
      {/* MAIN 3-COLUMN WORKSPACE BODY */}
      {/* =================================================================== */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* A. LEFT WORKSPACE SIDEBAR */}
        {!isDistractionFree && (
          <aside
            data-testid="left-workspace-sidebar"
            data-open={leftSidebarOpen}
            aria-hidden={!leftSidebarOpen}
            inert={!leftSidebarOpen}
            className="sidebar border-r border-slate-800 bg-slate-950"
          >
           <div className="sidebar-inner flex flex-col h-full">
            <div className="p-2.5 overflow-y-auto flex-1 space-y-6 no-scrollbar">
              <button
                onClick={() => fileInputRef.current?.click()}
                data-testid="open-file-button"
                className="pulse-btn w-full !justify-start"
              >
                <PixelIcon name="open" size={14} />
                <span className="flex-1 text-left">Open files</span>
                <kbd className="pulse-kbd">Ctrl O</kbd>
              </button>

              {/* Places */}
              <nav aria-label="Places" className="space-y-0.5">
                {(
                  [
                    { key: 'home', label: 'Home', icon: 'home', active: currentView === 'home', go: goHome, testId: 'nav-home' },
                    {
                      key: 'all',
                      label: 'Library',
                      icon: 'library',
                      count: liveCount,
                      active: currentView === 'library' && sidebarFilter === 'all',
                      go: () => goLibrary('all'),
                      testId: 'nav-library',
                    },
                    {
                      key: 'recent',
                      label: 'Recent',
                      icon: 'recent',
                      active: currentView === 'library' && sidebarFilter === 'recent',
                      go: () => goLibrary('recent'),
                      testId: 'nav-recent',
                    },
                    {
                      key: 'favorites',
                      label: 'Favorites',
                      icon: 'star',
                      count: files.filter((f) => f.isFavorite && !f.isTrashed).length,
                      active: currentView === 'library' && sidebarFilter === 'favorites',
                      go: () => goLibrary('favorites'),
                      testId: 'nav-favorites',
                    },
                  ] as { key: string; label: string; icon: PixelIconName; count?: number; active: boolean; go: () => void; testId: string }[]
                ).map((item) => {
                  return (
                    <button
                      key={item.key}
                      data-testid={item.testId}
                      onClick={item.go}
                      aria-current={item.active ? 'page' : undefined}
                      className={`nav-item w-full flex items-center gap-2.5 px-2.5 h-8 text-[13px] ${
                        item.active ? 'bg-slate-800 text-white font-medium' : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
                      }`}
                    >
                      <PixelIcon name={item.icon} size={14} />
                      <span className="flex-1 text-left">{item.label}</span>
                      {item.count !== undefined && (
                        <span className="nav-count font-mono text-[11px] tabular-nums text-slate-500">{item.count}</span>
                      )}
                    </button>
                  );
                })}
              </nav>

              {/* File types (only the ones present) */}
              {typeNav.length > 0 && (
                <div className="space-y-0.5">
                  <button
                    onClick={() => setTypesOpen((v) => !v)}
                    aria-expanded={typesOpen}
                    className="w-full flex items-center justify-between px-2.5 pb-2 text-slate-500 hover:text-slate-300"
                  >
                    <PixelText text="TYPES" dot={1.5} className="px-eye" label="Types" />
                    <PixelIcon name="chevronDown" size={7} className={`transition-transform duration-200 ${typesOpen ? '' : '-rotate-90'}`} />
                  </button>
                  {typesOpen && (
                    <div className="space-y-0.5 anim-fade">
                      {typeNav.map((item) => {
                        const active = currentView === 'library' && sidebarFilter === item.id;
                        return (
                          <button
                            key={item.id}
                            onClick={() => goLibrary(item.id)}
                            aria-current={active ? 'page' : undefined}
                            className={`nav-item w-full flex items-center gap-2.5 px-2.5 h-8 text-[13px] ${
                              active ? 'bg-slate-800 text-white font-medium' : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
                            }`}
                          >
                            <PixelIcon name={categoryGlyph(item.icon)} size={14} />
                            <span className="flex-1 text-left">{item.label}</span>
                            <span className="nav-count font-mono text-[11px] tabular-nums text-slate-500">{item.count}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Collections / Folders */}
              <div className="space-y-1.5">
                <div className="px-2.5 pb-1 flex items-center justify-between text-slate-500">
                  <PixelText text="COLLECTIONS" dot={1.5} className="px-eye" label="Collections" />
                  <button
                    onClick={() => setShowNewCollection(true)}
                    className="icon-btn !w-6 !h-6"
                    title="New collection"
                    aria-haspopup="dialog"
                    data-testid="new-collection-button"
                  >
                    <PixelIcon name="plus" size={7} />
                  </button>
                </div>
                {folders.length === 0 && (
                  <button
                    onClick={() => setShowNewCollection(true)}
                    className="w-full text-left px-2.5 py-1.5 rounded text-xs text-slate-500 hover:text-slate-200"
                  >
                    Group files into a collection…
                  </button>
                )}
                {folders.map((folder) => {
                  const filterKey: SidebarFilter = `folder:${folder.id}`;
                  return (
                    <button
                      key={folder.id}
                      onClick={() => goLibrary(filterKey)}
                      aria-current={currentView === 'library' && sidebarFilter === filterKey ? 'page' : undefined}
                      className={`nav-item w-full flex items-center gap-2.5 px-2.5 h-8 text-[13px] ${
                        currentView === 'library' && sidebarFilter === filterKey
                          ? 'bg-slate-800 text-white font-medium'
                          : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
                      }`}
                    >
                      <PixelIcon name="folder" size={14} />
                      <span className="flex-1 text-left truncate">{folder.name}</span>
                      <span className="nav-count font-mono text-[11px] tabular-nums text-slate-500">
                        {files.filter((f) => f.folderId === folder.id && !f.isTrashed).length}
                      </span>
                    </button>
                  );
                })}
              </div>

            </div>

            <div className="p-2.5 border-t border-slate-800 space-y-0.5">
              {trashCount > 0 && (
                <button
                  onClick={() => goLibrary('trash')}
                  aria-current={currentView === 'library' && sidebarFilter === 'trash' ? 'page' : undefined}
                  className={`nav-item w-full flex items-center gap-2.5 px-2.5 h-8 text-[13px] ${
                    currentView === 'library' && sidebarFilter === 'trash'
                      ? 'bg-slate-800 text-white font-medium'
                      : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
                  }`}
                >
                  <PixelIcon name="trash" size={14} />
                  <span className="flex-1 text-left">Trash</span>
                  <span className="nav-count font-mono text-[11px] tabular-nums text-slate-500">{trashCount}</span>
                </button>
              )}
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setPaletteOpen(true)}
                  data-testid="open-command-palette"
                  className="pulse-wellbtn flex-1 min-w-0"
                >
                  <PixelIcon name="search" size={7} />
                  <span className="flex-1 text-left truncate">Jump to…</span>
                  <kbd className="pulse-kbd">Ctrl K</kbd>
                </button>
                <button
                  onClick={() => openSettings('general')}
                  className="icon-btn !w-[30px] !h-[30px]"
                  title="Settings"
                  aria-label="Settings"
                  aria-haspopup="dialog"
                  data-testid="open-settings"
                >
                  <PixelIcon name="settings" size={14} />
                </button>
              </div>
            </div>
           </div>
          </aside>
        )}

        {/* B. CENTRAL WORKSPACE (TABS + CONTEXTUAL TOOLBAR + VIEWER / SPLIT VIEW) */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* C. FILE TABS BAR */}
          {!isDistractionFree && (
            <div
              data-testid="file-tabs-bar"
              className="h-9 shrink-0 border-b border-slate-800 bg-slate-950 px-1.5 flex items-end justify-between gap-2"
            >
              <div className="flex items-end gap-0.5 min-w-0 overflow-x-auto no-scrollbar h-full">
                {tabs.map((tab) => {
                  const file = files.find((f) => f.id === tab.fileId);
                  if (!file) return null;
                  const isActive = tab.tabId === activeTabId;
                  return (
                    <div
                      key={tab.tabId}
                      data-testid={`file-tab-${file.originalName}`}
                      onClick={() => {
                        setActiveTab(tab.tabId);
                        setShowLibraryDrawer(false);
                        setShowHome(false);
                      }}
                      className={`group relative flex items-center gap-2 h-full px-3 text-xs cursor-pointer transition select-none max-w-[200px] shrink-0 ${
                        isActive
                          ? 'tab-active text-white after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-slate-50'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {getCategoryIcon(file.category, 'w-3.5 h-3.5 shrink-0')}
                      <span className="truncate">{file.originalName}</span>
                      {tab.hasUnsavedAnnotations && (
                        <span
                          className="w-2 h-2 rounded-full bg-blue-400 shrink-0"
                          title="Has active annotations"
                        />
                      )}
                      <button
                        data-testid={`close-tab-${file.originalName}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTab(tab.tabId);
                        }}
                        className={`p-0.5 rounded hover:bg-slate-700 text-slate-400 hover:text-white ${isActive ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
                        title="Close tab"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* Tab overflow: restore, compare, close */}
              <div className="flex items-center gap-0.5 shrink-0 self-center">
                {closedTabsStack.length > 0 && (
                  <button
                    data-testid="restore-closed-tab-btn"
                    onClick={() => void restoreLastClosedTab()}
                    className="icon-btn"
                    title="Reopen closed tab"
                  >
                    <History className="w-3.5 h-3.5" />
                  </button>
                )}
                {tabs.length > 0 && activeTab && (
                  <Menu
                    label="Tab options"
                    trigger={<MoreHorizontal className="w-4 h-4" />}
                    items={[
                      ...(tabs.length > 1
                        ? [
                            {
                              label: 'Single view',
                              checked: !comparisonTabId,
                              onSelect: () => setComparisonTab(null),
                            },
                            ...tabs
                              .filter((t) => t.tabId !== activeTab.tabId)
                              .map((t) => ({
                                label: `Compare with ${files.find((fl) => fl.id === t.fileId)?.originalName ?? 'tab'}`,
                                checked: comparisonTabId === t.tabId,
                                onSelect: () => setComparisonTab(t.tabId),
                              })),
                            'divider' as const,
                            { label: 'Close other tabs', onSelect: () => closeOtherTabs(activeTab.tabId) },
                          ]
                        : []),
                      { label: 'Close all tabs', onSelect: closeAllTabs },
                    ]}
                  />
                )}
              </div>
            </div>
          )}

          {/* E. CONTEXTUAL FORMAT-AWARE TOOLBAR */}
          {activeTab && activeFile && activeCapabilities && !showLibraryDrawer && !showHome && (
            <div
              data-testid="contextual-toolbar"
              className="h-10 shrink-0 border-b border-slate-800 bg-slate-950 px-2 flex items-center justify-between gap-3 overflow-x-auto no-scrollbar"
            >
              {/* Left Group: Thumbnails Toggle & Page/Slide/Chapter Navigation */}
              <div className="flex items-center gap-2">
                {activeCapabilities.thumbnails && (
                  <button
                    onClick={() =>
                      updateTabState(activeTab.tabId, {
                        showThumbnails: !activeTab.showThumbnails,
                      })
                    }
                    aria-pressed={activeTab.showThumbnails}
                    className={`icon-btn ${activeTab.showThumbnails ? 'icon-btn-on' : ''}`}
                    title="Page thumbnails"
                  >
                    <PanelLeftOpen className="w-4 h-4" />
                  </button>
                )}

                {activeCapabilities.pagination && (
                  <div className="flex items-center gap-1 text-xs text-slate-400">
                    <button
                      data-testid="toolbar-prev-page"
                      disabled={activeTab.currentPage <= 1}
                      onClick={() =>
                        updateTabState(activeTab.tabId, {
                          currentPage: Math.max(1, activeTab.currentPage - 1),
                        })
                      }
                      className="p-0.5 hover:text-white disabled:opacity-30"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                    </button>
                    <input
                      type="number"
                      aria-label="Page number"
                      data-testid="toolbar-page-input"
                      min={1}
                      max={activeTab.totalPages}
                      value={activeTab.currentPage}
                      onChange={(e) => {
                        const val = Math.max(
                          1,
                          Math.min(activeTab.totalPages, Number(e.target.value) || 1)
                        );
                        updateTabState(activeTab.tabId, { currentPage: val });
                      }}
                      className="w-8 text-center bg-transparent font-mono tabular-nums text-slate-100 rounded hover:bg-slate-800/60 focus:bg-slate-800 focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                    />
                    <span className="text-slate-500 font-mono">
                      / {activeTab.totalPages}
                    </span>
                    <button
                      data-testid="toolbar-next-page"
                      disabled={activeTab.currentPage >= activeTab.totalPages}
                      onClick={() =>
                        updateTabState(activeTab.tabId, {
                          currentPage: Math.min(
                            activeTab.totalPages,
                            activeTab.currentPage + 1
                          ),
                        })
                      }
                      className="p-0.5 hover:text-white disabled:opacity-30"
                    >
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                {/* PDF Reading Layout Mode Selector */}
                {activeFile.category === 'pdf' && (
                  <Select
                    label="Page layout"
                    className="hidden lg:block"
                    value={activeTab.pdfViewMode}
                    onChange={(v) => updateTabState(activeTab.tabId, { pdfViewMode: v })}
                    options={[
                      { value: 'continuous', label: 'Scroll' },
                      { value: 'single', label: 'Single page' },
                      { value: 'facing', label: 'Two pages' },
                    ]}
                  />
                )}
              </div>

              {/* Center Group: Zoom, Rotate & Normalized Annotation Tools */}
              <div className="flex items-center gap-1">
                {activeCapabilities.zoom && (
                  <div className="flex items-center gap-0.5 text-xs">
                    <button
                      data-testid="toolbar-zoom-out"
                      onClick={() =>
                        updateTabState(activeTab.tabId, {
                          zoom: Math.max(40, activeTab.zoom - 15),
                        })
                      }
                      className="icon-btn"
                      title="Zoom out"
                    >
                      <ZoomOut className="w-3.5 h-3.5" />
                    </button>
                    <button
                      data-testid="toolbar-zoom-value"
                      onClick={() => updateTabState(activeTab.tabId, { zoom: 100 })}
                      className="font-mono tabular-nums text-slate-200 w-12 text-center rounded py-0.5 hover:bg-slate-800/60"
                      title="Reset to 100%"
                    >
                      {activeTab.zoom}%
                    </button>
                    <button
                      data-testid="toolbar-zoom-in"
                      onClick={() =>
                        updateTabState(activeTab.tabId, {
                          zoom: Math.min(300, activeTab.zoom + 15),
                        })
                      }
                      className="icon-btn"
                      title="Zoom in"
                    >
                      <ZoomIn className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                {activeCapabilities.rotate && (
                  <button
                    onClick={() =>
                      updateTabState(activeTab.tabId, {
                        rotation: (activeTab.rotation + 90) % 360,
                      })
                    }
                    className="icon-btn"
                    title="Rotate 90°"
                  >
                    <RotateCw className="w-3.5 h-3.5" />
                  </button>
                )}

                {/* Annotation Toolset (PDF & Supported Docs) */}
                {activeCapabilities.annotations && (
                  <div className="hidden md:flex items-center gap-0.5 pl-2 ml-1 border-l border-slate-800">
                    {(
                      [
                        { id: 'select', icon: MousePointer, label: 'Select Text' },
                        { id: 'highlight', icon: Highlighter, label: 'Highlight' },
                        { id: 'underline', icon: Underline, label: 'Underline' },
                        { id: 'rectangle', icon: Square, label: 'Rectangle' },
                        { id: 'freehand', icon: PenTool, label: 'Freehand Ink' },
                        { id: 'note', icon: MessageSquare, label: 'Note' },
                      ] as {
                        id: AnnotationType | 'select';
                        icon: React.FC<{ className?: string }>;
                        label: string;
                      }[]
                    ).map((tool) => {
                      const IconComp = tool.icon;
                      const isActive = activeTab.activeAnnotationTool === tool.id;
                      return (
                        <button
                          key={tool.id}
                          data-testid={`annotation-tool-${tool.id}`}
                          onClick={() =>
                            updateTabState(activeTab.tabId, {
                              activeAnnotationTool: tool.id,
                            })
                          }
                          title={tool.label}
                          aria-pressed={isActive}
                          className={`icon-btn ${isActive ? 'icon-btn-active' : ''}`}
                        >
                          <IconComp className="w-3.5 h-3.5" />
                        </button>
                      );
                    })}
                    <button
                      onClick={() => undoAnnotation(activeFile.id)}
                      className="icon-btn ml-1"
                      title="Undo Annotation"
                    >
                      <Undo2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => redoAnnotation(activeFile.id)}
                      className="icon-btn"
                      title="Redo Annotation"
                    >
                      <Redo2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>

              {/* Right Group: In-Document Search, Print, Download & Fullscreen */}
              <div className="flex items-center gap-0.5">
                {activeCapabilities.search && (
                  <div className="flex items-center gap-1 rounded border border-slate-800 focus-within:border-slate-500 px-2 h-7">
                    <Search className="w-3.5 h-3.5 text-slate-400" />
                    <input
                      ref={inDocSearchInputRef}
                      type="text"
                      data-testid="in-document-search-input"
                      value={activeTab.searchQuery}
                      onChange={(e) =>
                        updateTabState(activeTab.tabId, { searchQuery: e.target.value })
                      }
                      placeholder="Find"
                      className="w-28 bg-transparent text-xs text-slate-100 focus:outline-none"
                    />
                    {activeTab.searchQuery && (
                      <span
                        data-testid="in-document-match-count"
                        className="text-[11px] font-mono text-blue-300 px-1"
                      >
                        {activeTab.searchMatches.length > 0
                          ? `${activeTab.activeMatchIndex + 1}/${activeTab.searchMatches.length}`
                          : '0/0'}
                      </span>
                    )}
                    {activeTab.searchMatches.length > 1 && (
                      <>
                        <button
                          onClick={() => {
                            const nextIdx =
                              (activeTab.activeMatchIndex - 1 + activeTab.searchMatches.length) %
                              activeTab.searchMatches.length;
                            const match = activeTab.searchMatches[nextIdx];
                            updateTabState(activeTab.tabId, {
                              activeMatchIndex: nextIdx,
                              currentPage: match?.pageOrIndex ?? activeTab.currentPage,
                            });
                          }}
                          className="p-0.5 text-slate-400 hover:text-white"
                        >
                          <ChevronUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => {
                            const nextIdx =
                              (activeTab.activeMatchIndex + 1) % activeTab.searchMatches.length;
                            const match = activeTab.searchMatches[nextIdx];
                            updateTabState(activeTab.tabId, {
                              activeMatchIndex: nextIdx,
                              currentPage: match?.pageOrIndex ?? activeTab.currentPage,
                            });
                          }}
                          className="p-0.5 text-slate-400 hover:text-white"
                        >
                          <ChevronDown className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                )}

                {activeCapabilities.print && (
                  <button
                    onClick={() => window.print()}
                    className="icon-btn"
                    title="Print"
                  >
                    <Printer className="w-3.5 h-3.5" />
                  </button>
                )}

                {activeCapabilities.download && (
                  <button
                    onClick={() => handleDownloadOriginal(activeFile)}
                    className="icon-btn"
                    title="Download original"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                )}

                <button
                  onClick={() => setDistractionFree(!isDistractionFree)}
                  className="icon-btn"
                  title={isDistractionFree ? 'Exit Fullscreen (Esc)' : 'Distraction-Free Fullscreen'}
                >
                  {isDistractionFree ? (
                    <Minimize2 className="w-3.5 h-3.5" />
                  ) : (
                    <Maximize2 className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            </div>
          )}

          {/* CENTRAL VIEWPORT OR FILE MANAGER LIBRARY */}
          <div ref={viewportRef} className="flex-1 flex overflow-hidden relative">
            {!showLibraryDrawer && (showHome || !activeTab || !activeFile) ? (
              <Dashboard
                getIcon={getCategoryIcon}
                onOpenFile={openFile}
                onOpenPicker={() => fileInputRef.current?.click()}
                onImportUrl={() => setShowUrlImportModal(true)}
                onShowLibrary={() => goLibrary('all')}
                onFileContextMenu={(file, x, y) => setFileMenu({ file, x, y })}
                onQuickView={(id) => setQuickViewQueue([id])}
              />
            ) : currentView === 'library' && sidebarFilter === 'recent' ? (
              <RecentView
                query={globalSearchQuery}
                onOpenFile={openFile}
                onFileContextMenu={(file, x, y) => setFileMenu({ file, x, y })}
                onQuickView={(id) => setQuickViewQueue([id])}
              />
            ) : showLibraryDrawer || !activeTab || !activeFile ? (
              <div
                data-testid="file-manager-view"
                className="flex-1 overflow-auto p-6 bg-slate-950 space-y-6"
              >
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
                  <div className="space-y-3">
                    <Eyebrow text="WORKSPACE" />
                    <h2>
                      <PixelText key={libraryTitle} text={libraryTitle.toUpperCase()} dot={5} label={libraryTitle} assemble />
                    </h2>
                    <p className="text-sm text-slate-400">
                      {filteredFiles.length} {filteredFiles.length === 1 ? 'file' : 'files'}
                      {globalSearchQuery && <> matching “{globalSearchQuery}”</>}
                      {sidebarFilter === 'trash' && filteredFiles.length > 0 && ' · removed files stay here until deleted forever'}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <Select
                      label="Sort files"
                      prefix="Sort"
                      align="end"
                      value={sortBy}
                      onChange={(v) => setSort(v, v === 'name' ? 'asc' : 'desc')}
                      options={[
                        { value: 'date', label: 'Date added' },
                        { value: 'name', label: 'Name' },
                        { value: 'size', label: 'Size' },
                      ]}
                    />
                    <Segmented
                      label="View as"
                      value={fileManagerViewMode}
                      onChange={setFileManagerViewMode}
                      options={[
                        { value: 'grid', label: 'Grid', icon: <PixelIcon name="sheet" size={7} /> },
                        { value: 'list', label: 'List', icon: <PixelIcon name="doc" size={7} /> },
                      ]}
                    />
                  </div>
                </div>

                {fileManagerViewMode === 'grid' ? (
                  <div key={sidebarFilter} className="anim-stagger grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {filteredFiles.map((file) => (
                      <div
                        key={file.id}
                        data-testid={`library-file-${file.originalName}`}
                        onClick={() => openFile(file.id)}
                        tabIndex={0}
                        role="button"
                        aria-label={`${file.originalName}. Enter to open, Space for Quick View`}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            openFile(file.id);
                          } else if (e.key === ' ') {
                            e.preventDefault();
                            setQuickViewQueue([file.id]);
                          }
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setFileMenu({ file, x: e.clientX, y: e.clientY });
                        }}
                        className="lib-card group focus-visible:outline-2 focus-visible:outline-slate-50 focus-visible:-outline-offset-2 rounded-xl border border-slate-800 bg-slate-950 hover:border-slate-500 hover:bg-slate-900/60 p-4 cursor-pointer flex flex-col justify-between gap-4"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                            {getCategoryIcon(file.category, 'w-6 h-6')}
                          </div>
                          <span className="px-2 py-0.5 rounded bg-slate-950 border border-slate-800 font-mono uppercase text-[10px] text-slate-400">
                            .{file.extension}
                          </span>
                        </div>

                        <div>
                          <div className="text-sm font-semibold text-slate-100 truncate">
                            {file.originalName}
                          </div>
                          <div className="text-[11px] text-slate-400 mt-0.5">
                            {formatFileSize(file.sizeBytes)}
                          </div>
                        </div>

                        {file.isTrashed && (
                          <div className="flex items-center gap-3 pt-2 border-t border-slate-800 text-[11px]">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                restoreFileFromTrash(file.id);
                              }}
                              className="text-slate-100 hover:underline"
                            >
                              Restore
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                permanentlyRemoveFile(file.id);
                              }}
                              className="text-slate-400 hover:text-white hover:underline"
                            >
                              Delete forever
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-slate-800 bg-slate-900/60 overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-950 text-slate-400">
                        <tr>
                          <th className="px-4 py-2.5">Name</th>
                          <th className="px-4 py-2.5">Category</th>
                          <th className="px-4 py-2.5">Size</th>
                          <th className="px-4 py-2.5">Magic Bytes</th>
                          <th className="px-4 py-2.5">Checksum</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800">
                        {filteredFiles.map((file) => (
                          <tr
                            key={file.id}
                            onClick={() => openFile(file.id)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              setFileMenu({ file, x: e.clientX, y: e.clientY });
                            }}
                            className="hover:bg-slate-800/60 cursor-pointer"
                          >
                            <td className="px-4 py-2.5 font-medium text-white flex items-center gap-2">
                              {getCategoryIcon(file.category, 'w-4 h-4')}
                              <span>{file.originalName}</span>
                            </td>
                            <td className="px-4 py-2.5 uppercase font-mono text-slate-400">
                              {file.category}
                            </td>
                            <td className="px-4 py-2.5 font-mono text-slate-300">
                              {formatFileSize(file.sizeBytes)}
                            </td>
                            <td className="px-4 py-2.5 font-mono text-slate-400">
                              {file.magicSignatureHex || 'TEXT'}
                            </td>
                            <td className="px-4 py-2.5 font-mono text-slate-400">
                              {file.checksum.slice(0, 12)}…
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {TYPE_EXTENSIONS[sidebarFilter] && (
                  <PcFilesSection
                    type={sidebarFilter}
                    label={libraryTitle}
                    query={globalSearchQuery}
                    onQuickView={(id) => setQuickViewQueue([id])}
                  />
                )}
              </div>
            ) : (
              <>
                {/* Primary Active Document Viewer */}
                <div className="flex-1 h-full overflow-hidden">
                  <ViewerHost
                    file={activeFile}
                    tab={activeTab}
                    buffer={fileBuffers[activeFile.id]}
                    document={loadedDocuments[activeFile.id]}
                  />
                </div>

                {/* Optional Side-by-Side Comparison Split View */}
                {comparisonTab && comparisonFile && (
                  <div
                    data-testid="split-comparison-pane"
                    className="flex-1 h-full border-l-2 border-blue-500/40 overflow-hidden flex flex-col"
                  >
                    <div className="h-8 bg-slate-900 border-b border-slate-800 px-3 flex items-center justify-between text-xs">
                      <span className="font-medium text-blue-300 truncate">
                        Side-by-Side Comparison: {comparisonFile.originalName}
                      </span>
                      <button
                        onClick={() => setComparisonTab(null)}
                        className="text-slate-400 hover:text-white"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="flex-1 overflow-hidden">
                      <ViewerHost
                        file={comparisonFile}
                        tab={comparisonTab}
                        buffer={fileBuffers[comparisonFile.id]}
                        document={loadedDocuments[comparisonFile.id]}
                      />
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* BOTTOM STATUS BAR */}
          <footer className="h-6 shrink-0 border-t border-slate-800 bg-slate-950 px-3 flex items-center justify-between text-[11px] text-slate-400">
            <div className="flex items-center gap-3 min-w-0">
              {activeFile && activeTab ? (
                <>
                  <span className="truncate text-slate-300">{activeFile.originalName}</span>
                  {activeTab.totalPages > 1 && (
                    <span className="font-mono tabular-nums">
                      {activeTab.currentPage} / {activeTab.totalPages}
                    </span>
                  )}
                </>
              ) : (
                <span>No file open</span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() =>
                  setWorkspaceMode(workspaceMode === 'local-guest' ? 'persistent-cloud' : 'local-guest')
                }
                data-testid="workspace-mode-toggle"
                className="flex items-center gap-1.5 h-5 px-2 rounded hover:bg-slate-800/60 hover:text-slate-100"
                title={
                  workspaceMode === 'local-guest'
                    ? 'Files stay on this device. Click to use the cloud workspace.'
                    : 'Cloud workspace. Click to keep files on this device only.'
                }
              >
                {workspaceMode === 'local-guest' ? <Pip className="!w-1.5 !h-1.5" /> : <Cloud className="w-3 h-3" />}
                {workspaceMode === 'local-guest' ? 'On this device' : 'Cloud'}
              </button>
              <span className="flex items-center gap-1.5 px-2" title="Original files are never modified">
                <ShieldCheck className="w-3 h-3" />
                Read-only
              </span>
              {isDistractionFree && (
                <button onClick={() => setDistractionFree(false)} className="text-slate-100 hover:underline">
                  Exit fullscreen (Esc)
                </button>
              )}
            </div>
          </footer>
        </main>

        {/* D. RIGHT INSPECTOR SIDEBAR */}
        {!isDistractionFree && rightInspectorOpen && activeFile && activeTab && (
          <aside
            data-testid="right-inspector-sidebar"
            className="anim-slide-right w-64 shrink-0 border-l border-slate-800 bg-slate-950 flex flex-col overflow-hidden max-xl:absolute max-xl:inset-y-0 max-xl:right-0 max-xl:z-30 max-xl:shadow-lg"
          >
            {/* Inspector Tab Selector */}
            <div className="grid grid-cols-4 border-b border-slate-800 text-[11px] font-medium">
              {(
                [
                  { id: 'details', label: 'Details' },
                  { id: 'outline', label: 'Outline' },
                  { id: 'annotations', label: 'Notes' },
                  { id: 'search', label: 'Matches' },
                ] as const
              ).map((tabItem) => (
                <button
                  key={tabItem.id}
                  onClick={() => setActiveInspectorTab(tabItem.id)}
                  className={`py-2.5 text-center border-b transition ${
                    activeInspectorTab === tabItem.id
                      ? 'border-slate-50 text-white'
                      : 'border-transparent text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tabItem.label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
              {activeInspectorTab === 'details' && (
                <div className="space-y-4">
                  <div>
                    <div className="space-y-3">
                      <div>
                        <span className="text-slate-500 block text-[10px]">Original Filename</span>
                        <span className="font-medium text-slate-100 break-all">
                          {activeFile.originalName}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <span className="text-slate-500 block text-[10px]">Extension</span>
                          <span className="font-mono uppercase text-slate-200">
                            .{activeFile.extension}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-500 block text-[10px]">Size</span>
                          <span className="font-mono text-slate-200">
                            {formatFileSize(activeFile.sizeBytes)}
                          </span>
                        </div>
                      </div>
                      <div>
                        <span className="text-slate-500 block text-[10px]">Detected MIME</span>
                        <span className="font-mono text-blue-300 break-all text-[11px]">
                          {activeFile.detectedMimeType}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-500 block text-[10px]">
                          Magic Signature Bytes
                        </span>
                        <span className="font-mono text-amber-300 text-[11px]">
                          {activeFile.magicSignatureHex || 'ASCII / UTF-8'}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-500 block text-[10px]">
                          SHA-256 Content Checksum
                        </span>
                        <span className="font-mono text-slate-300 break-all text-[10px]">
                          {activeFile.checksum}
                        </span>
                      </div>
                    </div>
                  </div>

                </div>
              )}

              {activeInspectorTab === 'outline' && (
                <div className="space-y-4">
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-2">
                      Bookmarks ({(bookmarksByFileId[activeFile.id] ?? []).length})
                    </div>
                    {(bookmarksByFileId[activeFile.id] ?? []).length === 0 ? (
                      <p className="text-slate-500 text-xs">No bookmarks added yet.</p>
                    ) : (
                      <div className="space-y-1">
                        {(bookmarksByFileId[activeFile.id] ?? []).map((bm) => (
                          <button
                            key={bm.id}
                            onClick={() =>
                              updateTabState(activeTab.tabId, {
                                currentPage: Number(bm.position) || 1,
                              })
                            }
                            className="w-full text-left px-2.5 py-1.5 rounded bg-slate-950 border border-slate-800 hover:border-blue-500/40 flex items-center gap-2 text-slate-200"
                          >
                            <BookMarked className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                            <span className="truncate">{bm.label}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-2">
                      Document Structure
                    </div>
                    {(loadedDocuments[activeFile.id]?.outline ?? []).map((item) => (
                      <button
                        key={item.id}
                        onClick={() =>
                          updateTabState(activeTab.tabId, {
                            currentPage: Number(item.pageOrPosition) || 1,
                          })
                        }
                        className="w-full text-left px-2.5 py-1.5 rounded hover:bg-slate-800 text-slate-300 truncate block"
                      >
                        {item.title}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {activeInspectorTab === 'annotations' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                      Version-Locked Annotations (
                      {(annotationsByFileId[activeFile.id] ?? []).length})
                    </span>
                    <button
                      onClick={() =>
                        updateTabState(activeTab.tabId, {
                          showAnnotations: !activeTab.showAnnotations,
                        })
                      }
                      className="text-[11px] text-blue-400 hover:underline"
                    >
                      {activeTab.showAnnotations ? 'Hide Layer' : 'Show Layer'}
                    </button>
                  </div>

                  {(annotationsByFileId[activeFile.id] ?? []).length === 0 ? (
                    <p className="text-slate-500 text-xs">
                      Select an annotation tool in the toolbar and click/drag on a page.
                    </p>
                  ) : (
                    (annotationsByFileId[activeFile.id] ?? []).map((ann) => (
                      <div
                        key={ann.id}
                        className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 space-y-1.5"
                      >
                        <div className="flex items-center justify-between">
                          <button
                            onClick={() =>
                              updateTabState(activeTab.tabId, {
                                currentPage: ann.pageNumber,
                              })
                            }
                            className="font-semibold text-blue-300 hover:underline capitalize"
                          >
                            {ann.type} — Page {ann.pageNumber}
                          </button>
                          <button
                            onClick={() => deleteAnnotation(activeFile.id, ann.id)}
                            className="text-slate-500 hover:text-rose-400"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <p className="text-slate-300 text-[11px]">{ann.comment}</p>
                        <div className="text-[10px] font-mono text-slate-500">
                          Checksum: {ann.fileChecksum.slice(0, 10)}…
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}

              {activeInspectorTab === 'search' && (
                <div className="space-y-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    In-Document Matches ({activeTab.searchMatches.length})
                  </div>
                  {activeTab.searchMatches.map((m, idx) => (
                    <button
                      key={m.id}
                      onClick={() =>
                        updateTabState(activeTab.tabId, {
                          activeMatchIndex: idx,
                          currentPage: m.pageOrIndex,
                        })
                      }
                      className={`w-full text-left p-2.5 rounded-lg border transition ${
                        idx === activeTab.activeMatchIndex
                          ? 'border-blue-500 bg-blue-500/15 text-white'
                          : 'border-slate-800 bg-slate-950 text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      <div className="text-[11px] font-semibold text-blue-300 mb-0.5">
                        {m.locationLabel}
                      </div>
                      <div className="text-[11px] text-slate-300 line-clamp-2">{m.snippet}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* =================================================================== */}
      {/* SAFE REMOTE URL IMPORT MODAL */}
      {/* =================================================================== */}
      {showUrlImportModal && (
        <div className="anim-fade fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="anim-pop-center max-w-md w-full rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white">
                Import Document from Controlled URL
              </h3>
              <button
                onClick={() => setShowUrlImportModal(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-400">
              Private network IP ranges, localhost, and cloud metadata endpoints are blocked to prevent SSRF.
            </p>
            <form onSubmit={(e) => void handleSafeUrlImport(e)} className="space-y-3">
              <input
                type="text"
                value={urlImportInput}
                onChange={(e) => setUrlImportInput(e.target.value)}
                placeholder="https://example.com/document.pdf"
                className="w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-xs text-white"
              />
              {urlImportError && (
                <div className="p-2.5 rounded bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs">
                  {urlImportError}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowUrlImportModal(false)}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 text-xs text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="pulse-btn pulse-btn-sm"
                >
                  Inspect & Import
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* KEYBOARD SHORTCUTS MODAL */}
      {/* =================================================================== */}
      {showShortcutsModal && (
        <div className="anim-fade fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="anim-pop-center max-w-md w-full rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">Keyboard shortcuts</h3>
              <button
                onClick={() => setShowShortcutsModal(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="divide-y divide-slate-800 text-xs">
              {[
                ['Jump to anything', 'Ctrl K'],
                ['Open files', 'Ctrl O'],
                ['Find in document', 'Ctrl F'],
                ['Next / previous tab', 'Ctrl Tab / Ctrl Shift Tab'],
                ['Go to tab 1 to 8, last tab', 'Ctrl 1 to 8, Ctrl 9'],
                ['Close tab', 'Ctrl W'],
                ['Zoom in / out / reset', 'Ctrl + / - / 0'],
                ['Previous / next page', 'Left / Right'],
                ['Print', 'Ctrl P'],
                ['Exit fullscreen', 'Esc'],
              ].map(([action, key]) => (
                <div key={action} className="py-2 flex items-center justify-between">
                  <span className="text-slate-300">{action}</span>
                  <kbd className="px-2 py-0.5 rounded-sm border border-slate-700 font-mono text-[11px] text-slate-300">
                    {key}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {quickViewQueue && (
        <QuickView
          queue={quickViewQueue}
          onClose={() => setQuickViewQueue(null)}
          onOpenInWorkspace={(id) => {
            setQuickViewQueue(null);
            openFile(id);
          }}
          onDownload={handleDownloadOriginal}
        />
      )}
      <SettingsModal
        open={settingsOpen}
        tab={settingsTab}
        onTabChange={setSettingsTab}
        onClose={() => setSettingsOpen(false)}
        onImportUrl={() => setShowUrlImportModal(true)}
      />
      <NewCollectionModal
        open={showNewCollection}
        files={files}
        existingNames={folders.map((f) => f.name)}
        getIcon={getCategoryIcon}
        onClose={() => setShowNewCollection(false)}
        onCreate={(name, fileIds) => {
          const id = createFolder(name);
          if (!id) return;
          fileIds.forEach((fid) => assignFileToFolder(fid, id));
          goLibrary(`folder:${id}` as SidebarFilter);
        }}
      />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      <FileContextMenu
        state={fileMenu}
        folders={folders}
        canCompare={Boolean(activeTab)}
        onClose={() => setFileMenu(null)}
        onOpen={(f) => openFile(f.id)}
        onQuickView={(f) => setQuickViewQueue([f.id])}
        onCompare={(f) => {
          void openFileInTab(f.id, true);
        }}
        onToggleFavorite={(f) => toggleFavorite(f.id)}
        onRename={(f, name) => renameFile(f.id, name)}
        onMove={(f, folderId) => assignFileToFolder(f.id, folderId)}
        onDownload={handleDownloadOriginal}
        onTrash={(f) => moveFileToTrash(f.id)}
      />
    </div>
  );
};
