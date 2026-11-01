import type {
  ConversionJob,
  DetectedFile,
  DocumentAnnotation,
  DocumentBookmark,
  PDFViewMode,
  EbookTheme,
  WorkspaceFolder,
} from '@omniview/shared-types';
import {
  computeSha256Hex,
  inspectFileSignature,
  sanitizeFilename,
} from '@omniview/utilities';

export interface UserPreferences {
  theme: 'dark' | 'light' | 'system';
  defaultZoom: number;
  defaultPdfViewMode: PDFViewMode;
  defaultEbookTheme: EbookTheme;
  sidebarCollapsed: boolean;
  showThumbnailsByDefault: boolean;
  recentFileIds: string[];
}

export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  preferences: UserPreferences;
  createdAt: string;
  updatedAt: string;
}

export interface StoredFileVersion {
  id: string;
  fileId: string;
  versionNumber: number;
  checksum: string;
  sizeBytes: number;
  detectedMimeType: string;
  createdAt: string;
}

export interface StoredPreviewArtifact {
  id: string;
  fileId: string;
  fileChecksum: string;
  converterName: string;
  converterVersion: string;
  cacheKey: string;
  artifactFormat: 'pdf' | 'html-preview' | 'slides-json' | 'image-png';
  mimeType: string;
  sizeBytes: number;
  content: Buffer;
  pageCount?: number;
  fidelityWarning?: string;
  createdAt: string;
}

export interface StoredAuditLog {
  id: string;
  userId: string;
  fileId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export class OmniViewMemoryStore {
  public currentUser: UserProfile;
  public files = new Map<string, DetectedFile>();
  public fileContents = new Map<string, Buffer>();
  public fileVersions = new Map<string, StoredFileVersion[]>();
  public folders = new Map<string, WorkspaceFolder>();
  public annotations = new Map<string, DocumentAnnotation>();
  public bookmarks = new Map<string, DocumentBookmark>();
  public conversionJobs = new Map<string, ConversionJob>();
  public previewArtifacts = new Map<string, StoredPreviewArtifact>();
  public auditLogs: StoredAuditLog[] = [];

  private idCounter = 1000;

  constructor() {
    const now = new Date().toISOString();
    this.currentUser = {
      id: 'usr-omniview-default',
      email: 'architect@omniview.local',
      displayName: 'OmniView Workspace User',
      preferences: {
        theme: 'dark',
        defaultZoom: 1,
        defaultPdfViewMode: 'continuous',
        defaultEbookTheme: 'sepia',
        sidebarCollapsed: false,
        showThumbnailsByDefault: true,
        recentFileIds: [],
      },
      createdAt: now,
      updatedAt: now,
    };

    this.seedDefaults();
  }

  public nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.idCounter}`;
  }

  private seedDefaults(): void {
    const now = new Date().toISOString();
    const defaultFolders: WorkspaceFolder[] = [
      {
        id: 'fld-engineering',
        name: 'Engineering Specs',
        parentId: null,
        color: '#6366f1',
        createdAt: now,
      },
      {
        id: 'fld-finance',
        name: 'Financial Models',
        parentId: null,
        color: '#10b981',
        createdAt: now,
      },
      {
        id: 'fld-presentations',
        name: 'Executive Decks',
        parentId: null,
        color: '#f59e0b',
        createdAt: now,
      },
    ];

    for (const folder of defaultFolders) {
      this.folders.set(folder.id, folder);
    }

    // Seed a sample PDF and Markdown file so fresh API queries have realistic entries
    const pdfBuffer = Buffer.from(
      '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n%%EOF\n',
      'utf-8'
    );
    const pdfInspection = inspectFileSignature('OmniView-Architecture-Guide.pdf', new Uint8Array(pdfBuffer), 'application/pdf');
    const pdfFile: DetectedFile = {
      id: 'file-seed-pdf',
      originalName: 'OmniView-Architecture-Guide.pdf',
      sanitizedName: 'OmniView-Architecture-Guide.pdf',
      extension: pdfInspection.extension,
      declaredMimeType: 'application/pdf',
      detectedMimeType: pdfInspection.detectedMimeType,
      category: pdfInspection.category,
      sizeBytes: pdfBuffer.byteLength,
      checksum: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      importSource: 'sample-fixture',
      status: 'ready',
      createdAt: now,
      lastModified: now,
      folderId: 'fld-engineering',
      isFavorite: true,
      isTrashed: false,
      isEncrypted: false,
      hasMacrosWarning: false,
      isSensitiveEnv: false,
      magicSignatureHex: pdfInspection.magicSignatureHex,
      metadata: {
        pageCount: 4,
        author: 'OmniView Core Team',
      },
    };
    this.files.set(pdfFile.id, pdfFile);
    this.fileContents.set(pdfFile.id, pdfBuffer);
    this.fileVersions.set(pdfFile.id, [
      {
        id: 'ver-seed-pdf-1',
        fileId: pdfFile.id,
        versionNumber: 1,
        checksum: pdfFile.checksum,
        sizeBytes: pdfFile.sizeBytes,
        detectedMimeType: pdfFile.detectedMimeType,
        createdAt: now,
      },
    ]);
  }

  public async registerFile(params: {
    id?: string;
    filename: string;
    declaredMimeType?: string;
    content: Buffer;
    importSource?: DetectedFile['importSource'];
    folderId?: string | null;
    metadata?: Record<string, string | number | boolean | null>;
  }): Promise<DetectedFile> {
    const now = new Date().toISOString();
    const sanitizedName = sanitizeFilename(params.filename);
    const uint8 = new Uint8Array(params.content);
    const inspection = inspectFileSignature(
      sanitizedName,
      uint8.subarray(0, 128),
      params.declaredMimeType ?? ''
    );
    const checksum = await computeSha256Hex(uint8);
    const id = params.id ?? this.nextId('file');

    const detected: DetectedFile = {
      id,
      originalName: params.filename,
      sanitizedName,
      extension: inspection.extension,
      declaredMimeType: params.declaredMimeType || inspection.detectedMimeType,
      detectedMimeType: inspection.detectedMimeType,
      category: inspection.category,
      sizeBytes: params.content.byteLength,
      checksum,
      importSource: params.importSource ?? 'local-picker',
      status: inspection.conversionRequired ? 'conversion-required' : 'ready',
      createdAt: now,
      lastModified: now,
      folderId: params.folderId ?? null,
      isFavorite: false,
      isTrashed: false,
      isEncrypted: false,
      hasMacrosWarning: inspection.hasMacrosWarning,
      isSensitiveEnv: inspection.isSensitiveEnv,
      magicSignatureHex: inspection.magicSignatureHex,
      conversionFidelityNote: inspection.conversionFidelityNote,
      metadata: params.metadata ?? {},
    };

    this.files.set(id, detected);
    this.fileContents.set(id, params.content);

    const existingVersions = this.fileVersions.get(id) ?? [];
    existingVersions.push({
      id: this.nextId('ver'),
      fileId: id,
      versionNumber: existingVersions.length + 1,
      checksum,
      sizeBytes: params.content.byteLength,
      detectedMimeType: inspection.detectedMimeType,
      createdAt: now,
    });
    this.fileVersions.set(id, existingVersions);

    this.recordAudit('file.created', 'file', id, {
      filename: sanitizedName,
      checksum,
      sizeBytes: params.content.byteLength,
      category: inspection.category,
    });

    return detected;
  }

  public recordAudit(
    action: string,
    resourceType: string,
    resourceId?: string,
    details: Record<string, unknown> = {}
  ): void {
    this.auditLogs.push({
      id: this.nextId('audit'),
      userId: this.currentUser.id,
      fileId: resourceType === 'file' ? resourceId : undefined,
      action,
      resourceType,
      resourceId,
      details,
      createdAt: new Date().toISOString(),
    });
  }
}
