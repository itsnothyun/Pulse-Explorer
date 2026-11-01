export type FileCategory =
  | 'pdf'
  | 'word'
  | 'presentation'
  | 'spreadsheet'
  | 'image'
  | 'ebook'
  | 'code'
  | 'text'
  | 'audio'
  | 'video'
  | 'archive'
  | 'unknown';

export type ImportSource =
  | 'local-drag-drop'
  | 'local-picker'
  | 'folder-import'
  | 'clipboard'
  | 'url-import'
  | 'archive-entry'
  | 'desktop-open-with'
  | 'sample-fixture';

export type FileProcessingStatus =
  | 'ready'
  | 'inspecting'
  | 'converting'
  | 'conversion-required'
  | 'error'
  | 'unsupported';

export interface DetectedFile {
  id: string;
  originalName: string;
  sanitizedName: string;
  extension: string;
  declaredMimeType: string;
  detectedMimeType: string;
  category: FileCategory;
  sizeBytes: number;
  checksum: string;
  importSource: ImportSource;
  status: FileProcessingStatus;
  createdAt: string;
  lastModified: string;
  folderId?: string | null;
  isFavorite?: boolean;
  isTrashed?: boolean;
  isEncrypted?: boolean;
  hasMacrosWarning?: boolean;
  isSensitiveEnv?: boolean;
  magicSignatureHex?: string;
  conversionFidelityNote?: string;
  errorReason?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ViewerCapabilities {
  search: boolean;
  zoom: boolean;
  print: boolean;
  download: boolean;
  thumbnails: boolean;
  annotations: boolean;
  fullscreen: boolean;
  textSelection: boolean;
  rotate: boolean;
  pagination: boolean;
  sheets: boolean;
  slides: boolean;
  chapters: boolean;
  presentationMode: boolean;
  readingModes: boolean;
  mediaControls: boolean;
}

export type PDFViewMode = 'continuous' | 'single' | 'facing';
export type FitMode = 'custom' | 'fit-width' | 'fit-page' | 'actual-size';
export type DocumentReadingMode = 'print-layout' | 'reading' | 'raw';
export type EbookTheme = 'light' | 'sepia' | 'dark';

export interface NormalizedRect {
  /** Normalized 0..1 relative to page/canvas width */
  x: number;
  /** Normalized 0..1 relative to page/canvas height */
  y: number;
  /** Normalized 0..1 width */
  width: number;
  /** Normalized 0..1 height */
  height: number;
}

export interface NormalizedPoint {
  x: number;
  y: number;
}

export type AnnotationType =
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'note'
  | 'freehand'
  | 'rectangle'
  | 'bookmark';

export interface DocumentAnnotation {
  id: string;
  fileId: string;
  fileChecksum: string;
  pageNumber: number; // 1-based page/slide/sheet index
  type: AnnotationType;
  color: string;
  rect?: NormalizedRect;
  points?: NormalizedPoint[];
  selectedText?: string;
  comment?: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentBookmark {
  id: string;
  fileId: string;
  position: number | string; // Page number, slide index, or EPUB CFI / chapter id
  label: string;
  createdAt: string;
}

export interface SearchMatch {
  id: string;
  fileId: string;
  locationLabel: string; // e.g., "Page 3", "Slide 2", "Sheet 'Sales' B14", "Line 42"
  pageOrIndex: number;
  snippet: string;
  matchIndexInUnit: number;
}

export interface OutlineItem {
  id: string;
  title: string;
  pageOrPosition: number | string;
  level: number;
  children?: OutlineItem[];
}

export interface ArchiveEntryItem {
  path: string;
  name: string;
  isDirectory: boolean;
  compressedSize: number;
  uncompressedSize: number;
  extension: string;
  lastModified?: string;
  safetyStatus: 'safe' | 'suspicious-traversal' | 'ratio-exceeded';
}

export interface TabViewerState {
  tabId: string;
  /** Shown in the Quick View overlay only; hidden from the tab bar and session restore. */
  isQuickView?: boolean;
  fileId: string;
  adapterId: string;
  currentPage: number;
  totalPages: number;
  zoom: number;
  fitMode: FitMode;
  rotation: number;
  pdfViewMode: PDFViewMode;
  docReadingMode: DocumentReadingMode;
  activeSheet?: string;
  ebookTheme?: EbookTheme;
  ebookFontSize?: number;
  searchQuery: string;
  searchMatches: SearchMatch[];
  activeMatchIndex: number;
  showThumbnails: boolean;
  showAnnotations: boolean;
  activeAnnotationTool: AnnotationType | 'select';
  activeAnnotationColor: string;
  hasUnsavedAnnotations: boolean;
  scrollTop: number;
  scrollLeft: number;
}

export interface WorkspaceFolder {
  id: string;
  name: string;
  parentId: string | null;
  color?: string;
  createdAt: string;
}

export type ConversionJobStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ConversionJob {
  id: string;
  fileId: string;
  fileChecksum: string;
  sourceFormat: string;
  targetFormat: 'pdf' | 'html-preview' | 'slides-json' | 'image-png';
  converterName: 'libreoffice-headless' | 'onlyoffice' | 'ffmpeg' | 'epub-converter';
  status: ConversionJobStatus;
  progress: number;
  fidelityWarning?: string;
  errorMessage?: string;
  startedAt: string;
  completedAt?: string;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
