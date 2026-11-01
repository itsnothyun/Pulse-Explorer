# OmniView — Project Overview & Product Vision

> **"One application. Multiple file formats. One consistent viewing experience."**

---

## 1. Mission & Product Vision

**OmniView** is a production-grade, privacy-first, universal multi-format document, media, code, and archive viewer engineered for the modern web and desktop. Users today are forced to context-switch across dozens of specialized, bloated, or privacy-invasive software suites just to inspect everyday files—opening Acrobat for PDFs, Microsoft Office for `.docx`/`.xlsx`/`.pptx`, VS Code for source files, 7-Zip for archives, Calibre for eBooks, and hex editors for unknown binaries.

OmniView eliminates this fragmentation by providing a **single, unified, deterministic viewport** capable of inspecting, searching, annotating, and navigating dozens of heterogeneous file formats with zero mandatory cloud uploads.

---

## 2. Non-Negotiable Engineering Principles

1. **Local-First & Zero-Trust Privacy by Default**
   - Every file opened via local drag-and-drop or file picker stays inside the user's browser memory (`ArrayBuffer` / `Blob` / IndexedDB) or local OS filesystem (Tauri Desktop).
   - No telemetry, file contents, or metadata are transmitted to any remote server unless the user explicitly authenticates and opts into Cloud Workspace persistence or Server-Side High-Fidelity Conversion.
   - Sensitive configuration files (`.env`, `.pem`, `.key`, credentials) are hard-blocked from remote upload at the client router level.

2. **Fidelity Transparency**
   - Different formats and execution environments offer different levels of visual fidelity. OmniView never misleads the user about rendering accuracy.
   - Every active viewport displays an explicit **Fidelity Badge**:
     - `NATIVE_EXACT` — Pixel-accurate native rendering (e.g., PDF via PDF.js canvas + text layer, PNG/WebP, MP4).
     - `SEMANTIC_STRUCTURED` — High-speed client-side structural rendering (e.g., `.docx` via Mammoth, `.xlsx` data grid via SheetJS, `.pptx` slide XML parser).
     - `CONVERTED_PDF` — Server-assisted LibreOffice / headless conversion to PDF/A for exact pagination when requested.
     - `FALLBACK_HEX` — Safe binary inspection when a format is unrecognized or corrupted.

3. **Defense-in-Depth Security**
   - File extensions and browser-reported MIME types are treated as untrusted hints. Routing is governed by **magic-byte signature inspection** (`file-type` / custom header signatures) combined with structural validation.
   - Untrusted markup (SVG, HTML, Markdown, EPUB XHTML, DOCX HTML output) passes through strict DOMPurify AST sanitization stripping `<script>`, `foreignObject`, inline event handlers (`onload`, `onerror`), and external network fetches.
   - Office macros (`vbaProject.bin`, `.xlsm`, `.docm`) are never executed.
   - Archive inspection enforces strict Zip-Bomb ratio thresholds, maximum entry counts, byte ceilings, and path traversal (`../`) sanitization.

4. **Uniform Shell & Normalized Annotations**
   - Regardless of whether the user is viewing a 500-page PDF, a TypeScript module, a multi-sheet financial workbook, or a 30-slide deck, the surrounding shell provides a unified command bar (`Ctrl/Cmd+K`), search lifecycle, outline/TOC drawer, metadata inspector, zoom controller, and normalized `(0..1)` coordinate annotation layer.

5. **Extensible Adapter Architecture**
   - Every format renderer implements a strict, deterministic `ViewerAdapter` contract (`canHandle`, `mount`, `SearchController`, `NavigationController`, `AnnotationController`, `destroy`), allowing new formats to be registered without modifying core shell logic.

---

## 3. Operating Modes: Guest/Local vs. Persistent Cloud Workspace

| Capability | Guest / Local Mode (Default) | Persistent Cloud Workspace Mode (Opt-In) |
| :--- | :--- | :--- |
| **Authentication** | None required | JWT / OAuth2 Session (`Users` table) |
| **File Storage** | Ephemeral Browser Memory + IndexedDB (`idb`) | S3-Compatible Object Storage (MinIO / AWS S3) + PostgreSQL metadata |
| **Rendering Pipeline** | 100% Client-Side WebAssembly & JS Engines | Client-Side Engines + Optional BullMQ / LibreOffice Worker Conversion |
| **Annotations & Bookmarks** | Persisted locally in IndexedDB keyed by SHA-256 file hash | Synced to PostgreSQL (`Annotations`, `Bookmarks`, `ViewerSessions`) |
| **Session Resume** | Local `localStorage` + IndexedDB | Cross-device state sync (page, scroll, zoom, active sheet/tab) |
| **Sensitive File Guard (`.env`)** | Allowed (strictly local memory) | **Hard-blocked** from upload before network serialization |

---

## 4. Universal Format Support Matrix & Fidelity Transparency

| Category | Extensions | Magic / Structural Detection | Primary Client Engine | Optional Cloud Worker Pipeline | Fidelity Tier | Search | Annotations |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **PDF Documents** | `.pdf` | `%PDF-` (`25 50 44 46 2D`) | Mozilla `pdfjs-dist` (Canvas + Text + Outline) | N/A (Native Exact) | `NATIVE_EXACT` | Full text + highlight | Normalized Page `(0..1)` |
| **Word Processing** | `.docx`, `.doc`, `.odt`, `.rtf` | PKZIP + `word/document.xml` / OLE2 | `mammoth` + DOMPurify semantic HTML | LibreOffice Headless -> PDF | `SEMANTIC_STRUCTURED` / `CONVERTED_PDF` | Full DOM text search | Block / Page Anchored |
| **Presentations** | `.pptx`, `.ppt`, `.odp` | PKZIP + `ppt/presentation.xml` | Client OOXML Slide Parser (`p:sld`) | LibreOffice Headless -> PDF | `SEMANTIC_STRUCTURED` / `CONVERTED_PDF` | Slide text & notes | Slide Normalized `(0..1)` |
| **Spreadsheets & Tabular** | `.xlsx`, `.xls`, `.ods`, `.csv`, `.tsv` | PKZIP + `xl/workbook.xml` / Delimiter sniff | `xlsx` (SheetJS) + `papaparse` Virtual Grid | LibreOffice Headless -> PDF | `SEMANTIC_STRUCTURED` | Cell coordinate & regex | Cell Reference (`Sheet1!B12`) |
| **Images & Vector** | `.png`, `.jpg`, `.webp`, `.gif`, `.bmp`, `.ico`, `.svg` | PNG/JPEG/RIFF/GIF magic bytes / `<svg` | Pan/Zoom Canvas + Sanitized SVG DOM | ImageMagick / Sharp thumbnails | `NATIVE_EXACT` | Metadata search | Image Normalized `(0..1)` |
| **eBooks** | `.epub`, `.fb2` | PKZIP + `META-INF/container.xml` / XML | JSZip OPF Spine + Sandboxed Reader | Calibre / LibreOffice -> PDF | `SEMANTIC_STRUCTURED` | Chapter text search | Chapter + CFI / Offset |
| **Code, Markup & Config** | `.ts`, `.js`, `.py`, `.go`, `.rs`, `.json`, `.yaml`, `.toml`, `.xml`, `.md`, `.html`, `.css`, `.sql`, `.sh`, `.env`, `.ini`, `.log` | UTF-8 BOM /启发式 text + syntax grammar | Monaco Editor / Shiki + `marked` (for `.md`) | N/A | `NATIVE_EXACT` | Regex + Case/Word match | Line / Column Range |
| **Audio & Video** | `.mp4`, `.webm`, `.ogg`, `.mp3`, `.wav`, `.flac`, `.aac` | `ftyp`, `EBML`, `OggS`, `ID3`, `RIFF`, `fLaC` | HTML5 Media Element + Web Audio API Waveform | FFmpeg (`Dockerfile.worker`) transcode | `NATIVE_EXACT` | Timestamp / cue jump | Timecode Range (`startMs..endMs`) |
| **Archives** | `.zip`, `.tar`, `.gz`, `.tgz` | `PK\x03\x04`, `ustar`, `\x1f\x8b` | `jszip` + DecompressionStream virtual tree | Recursive Malware/Ratio Scanner | `SEMANTIC_STRUCTURED` | Filename & path filter | Virtual Entry Notes |
| **Unknown / Binary** | `*.*` (Any unrecognized or corrupt file) | Fallback when magic/UTF-8 checks fail | **Fallback Hex & ASCII Inspector** | N/A | `FALLBACK_HEX` | Hex byte sequence & ASCII | Byte Offset (`0x0000..0xFFFF`) |
