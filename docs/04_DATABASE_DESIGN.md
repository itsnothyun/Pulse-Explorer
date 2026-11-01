# OmniView — Database Design & Persistence Schema

---

## 1. Entity-Relationship Diagram

The cloud persistence layer uses **PostgreSQL 16** managed via **Prisma ORM**. All primary keys use UUIDv4 (`uuid`), timestamps are stored in UTC (`TIMESTAMPTZ`), and structured metadata/anchors leverage indexed `JSONB` columns.

```mermaid
erDiagram
    USERS ||--o{ FOLDERS : owns
    USERS ||--o{ FILES : owns
    USERS ||--o{ VIEWER_SESSIONS : maintains
    USERS ||--o{ BOOKMARKS : creates
    USERS ||--o{ ANNOTATIONS : authors
    USERS ||--o{ CONVERSION_JOBS : requests
    USERS ||--o{ AUDIT_LOGS : generates

    FOLDERS ||--o{ FOLDERS : "parent_id (self-ref)"
    FOLDERS ||--o{ FILES : contains

    FILES ||--|{ FILE_VERSIONS : versions
    FILES ||--o{ PREVIEW_ARTIFACTS : caches
    FILES ||--o{ VIEWER_SESSIONS : tracks
    FILES ||--o{ BOOKMARKS : has
    FILES ||--o{ ANNOTATIONS : has
    FILES ||--o{ CONVERSION_JOBS : processes

    FILE_VERSIONS ||--o{ PREVIEW_ARTIFACTS : generates
    FILE_VERSIONS ||--o{ CONVERSION_JOBS : targets

    USERS {
        uuid id PK
        string email UK
        string display_name
        string password_hash
        string role "USER | ADMIN"
        jsonb preferences
        timestamptz created_at
        timestamptz updated_at
    }

    FOLDERS {
        uuid id PK
        uuid owner_id FK
        uuid parent_id FK "Nullable for root"
        string name
        string color_tag
        timestamptz created_at
        timestamptz updated_at
    }

    FILES {
        uuid id PK
        uuid owner_id FK
        uuid folder_id FK "Nullable"
        string original_name
        string detected_mime
        string file_family "PDF | WORD | SHEET | SLIDE | CODE | IMAGE | ARCHIVE | MEDIA | EBOOK | BINARY"
        bigint byte_size
        string sha256_hash
        int current_version
        boolean is_archived
        timestamptz created_at
        timestamptz updated_at
    }

    FILE_VERSIONS {
        uuid id PK
        uuid file_id FK
        int version_number
        string storage_key UK "S3/MinIO object key"
        bigint byte_size
        string sha256_hash
        string magic_signature
        jsonb extracted_metadata
        timestamptz created_at
    }

    PREVIEW_ARTIFACTS {
        uuid id PK
        uuid file_id FK
        uuid file_version_id FK
        string artifact_type "PDF_EXACT | THUMBNAIL_WEBP | WAVEFORM_JSON | TEXT_INDEX"
        string storage_key UK
        string mime_type
        bigint byte_size
        int page_count "Nullable"
        timestamptz expires_at "Nullable"
        timestamptz created_at
    }

    VIEWER_SESSIONS {
        uuid id PK
        uuid user_id FK
        uuid file_id FK
        int last_page
        float zoom_scale
        float scroll_top_norm
        float scroll_left_norm
        string active_sheet_or_tab
        string fidelity_mode "NATIVE_EXACT | SEMANTIC_STRUCTURED | CONVERTED_PDF | FALLBACK_HEX"
        jsonb view_state
        timestamptz last_opened_at
    }

    BOOKMARKS {
        uuid id PK
        uuid user_id FK
        uuid file_id FK
        string title
        string color
        jsonb target_anchor "Page, Line, Cell, Timecode, or Byte Offset"
        timestamptz created_at
    }

    ANNOTATIONS {
        uuid id PK
        uuid user_id FK
        uuid file_id FK
        string kind "HIGHLIGHT | NOTE | RECTANGLE | PIN"
        string content
        string color
        jsonb anchor "Normalized (0..1) rect, CellRange, LineRange, or TimecodeRange"
        boolean is_resolved
        timestamptz created_at
        timestamptz updated_at
    }

    CONVERSION_JOBS {
        uuid id PK
        uuid file_id FK
        uuid file_version_id FK
        uuid requested_by_id FK
        string job_type "LIBREOFFICE_PDF | FFMPEG_NORMALIZE | THUMBNAIL_GEN"
        string status "QUEUED | PROCESSING | COMPLETED | FAILED | CANCELLED"
        int attempts
        int duration_ms "Nullable"
        string error_code "Nullable"
        string error_message "Nullable"
        timestamptz started_at "Nullable"
        timestamptz completed_at "Nullable"
        timestamptz created_at
    }

    AUDIT_LOGS {
        uuid id PK
        uuid actor_id FK "Nullable for anonymous/system"
        string action "FILE_UPLOAD | FILE_VIEW | CONVERSION_START | SECURITY_BLOCK | ANNOTATION_MUTATE"
        string target_type "FILE | JOB | SESSION | SYSTEM"
        uuid target_id "Nullable"
        string ip_address
        string user_agent
        jsonb metadata
        timestamptz created_at
    }
```

---

## 2. Table Specifications & Indexing Strategy

### 2.1 `Users`
Stores authenticated workspace accounts and global viewer preferences (default theme, default zoom mode, preferred Office rendering fidelity).
- **Indexes**: `UNIQUE(email)`

### 2.2 `Folders`
Hierarchical virtual directory structure supporting arbitrary nesting.
- **Indexes**: `INDEX(owner_id, parent_id)`, `UNIQUE(owner_id, parent_id, name)`
- **Cascade Rule**: `ON DELETE SET NULL` for child `parent_id` or soft-archive propagation.

### 2.3 `Files` & `FileVersions`
Separates logical file identity (`Files`) from immutable content snapshots (`FileVersions`). Deduplication or integrity verification is powered by `sha256_hash`.
- **Indexes**:
  - `Files`: `INDEX(owner_id, folder_id)`, `INDEX(sha256_hash)`, `INDEX(file_family)`
  - `FileVersions`: `UNIQUE(file_id, version_number)`, `UNIQUE(storage_key)`

### 2.4 `PreviewArtifacts`
Caches derived outputs generated by `@omniview/worker` (e.g., `PDF_EXACT` produced by LibreOffice from a `.docx`/`.pptx`, `WAVEFORM_JSON` produced by FFmpeg, or page thumbnails).
- **Indexes**: `UNIQUE(file_version_id, artifact_type)`
- **Cache Hit Behavior**: Before enqueueing a new `ConversionJob`, the API checks if a `PreviewArtifact` already exists for `(file_version_id, 'PDF_EXACT')`. If present, it returns the cached artifact immediately in $<15\text{ms}$.

### 2.5 `ViewerSessions`
Persists per-user, per-file reading state so reopening a document on any device restores the exact page, scroll ratio (`0.0`–`1.0`), zoom level, active spreadsheet tab, or archive path.
- **Indexes**: `UNIQUE(user_id, file_id)`, `INDEX(user_id, last_opened_at DESC)`

### 2.6 `Bookmarks` & `Annotations`
Stores user-created navigational markers and visual/contextual annotations.
- **Anchor Schema (`JSONB`)**:
  ```json
  {
    "type": "NORMALIZED_RECT",
    "pageIndex": 3,
    "x": 0.142,
    "y": 0.285,
    "width": 0.410,
    "height": 0.032
  }
  ```
- **Indexes**: `INDEX(file_id, user_id)`, `GIN(anchor)` for fast page/sheet filtering.

### 2.7 `ConversionJobs`
Tracks asynchronous BullMQ worker execution state, retry counts, execution duration, and failure diagnostics.
- **Indexes**: `INDEX(status, created_at)`, `INDEX(file_version_id)`

### 2.8 `AuditLogs`
Append-only security and compliance log recording file uploads, conversions, and security policy triggers (such as blocked zip bombs, blocked SSRF URLs, or stripped SVG scripts).
- **Indexes**: `INDEX(actor_id, created_at DESC)`, `INDEX(action, created_at DESC)`
