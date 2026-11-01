# OmniView Desktop — Offline vs. Conversion-Dependent Support Matrix

OmniView Desktop (`@omniview/desktop`, built on **Tauri v2**) is engineered for local-first, privacy-preserving inspection of documents, spreadsheets, presentations, code, archives, and media.

All primary format families render **100% offline** inside the desktop webview without requiring any network connectivity or external server process. Legacy binary formats or exotic media containers can optionally invoke a local LibreOffice/FFmpeg conversion worker when installed on the host machine.

---

## 1. Fully Offline Formats (Zero External Worker Required)

| Category | Extensions | Rendering Pipeline | Offline Fidelity & Security Notes |
| :--- | :--- | :--- | :--- |
| **PDF Documents** | `.pdf` | Local PDF.js Canvas + Text Layer + Outline Engine | Full pagination, continuous/single/facing modes, search highlighting, annotations, bookmarks, and password prompts work completely offline. |
| **Modern Word Processing** | `.docx`, `.rtf`, `.md`, `.markdown`, `.html`, `.htm`, `.txt`, `.log` | Local OpenXML / Mammoth / Markdown / Sanitized HTML Engine | Renders headings, tables, inline images, lists, and reading/print modes offline. Scripts (`<script>`, event attributes) are stripped before DOM mount. |
| **Spreadsheets & Tabular Data** | `.xlsx`, `.xls`, `.xlsm`, `.ods`, `.csv`, `.tsv` | Local SheetJS + Virtualized Grid Engine | Multi-sheet tabs, frozen headers, column resize, sorting, filtering, and formula bar inspection work offline. Macros in `.xlsm`/`.xls` are never executed. |
| **Modern Presentations** | `.pptx`, `.ppsx` | Local OpenXML Slide Deck Parser (`JSZip` + DrawingML XML) | Slide geometry, text boxes, shapes, embedded images, slide sorter thumbnails, speaker notes, and fullscreen presentation mode work offline. |
| **E-Books** | `.epub`, `.fb2` | Local EPUB Container / XHTML Chapter Reader | Chapter TOC, typography controls, Light/Sepia/Dark themes, text search, and reading progress persistence work offline. |
| **Source Code & Structured Config** | `.js`, `.ts`, `.tsx`, `.py`, `.rs`, `.go`, `.java`, `.c`, `.cpp`, `.sql`, `.json`, `.yaml`, `.yml`, `.xml`, `.toml`, `.env`, `.sh`, `.css` | Local Syntax Highlighting + JSON/YAML/XML Tree Inspector | Line numbers, word wrap, fold regions, and `.env` secret masking with explicit local-only warning banner work offline. |
| **Images** | `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.bmp`, `.avif`, `.svg`, `.tif`, `.tiff` | Native Decode + Sanitized SVG Pipeline + EXIF Inspector | Pan/zoom, 90° rotation, checkerboard transparency toggle, and script-sanitized SVG preview work offline. |
| **Audio & Video** | `.mp3`, `.wav`, `.ogg`, `.m4a`, `.flac`, `.aac`, `.mp4`, `.webm`, `.mov` | Native HTML5 Media + WebAudio Waveform Analyzer | Playback speed (`0.5x`–`2x`), seek bar, volume, and waveform visualization work offline for OS/WebView-supported codecs. |
| **Archives** | `.zip`, `.tar`, `.gz`, `.tgz` | Local Archive Tree Inspector + Zip-Slip / Bomb Guard | Directory hierarchy browsing, compression ratio checks, path traversal (`../`) blocking, and click-to-preview inner files work offline. |

---

## 2. Conversion-Enhanced or Worker-Dependent Formats

| Category | Extensions | Local Fallback Behavior (Offline) | Optional Worker Enhancement (`@omniview/worker`) |
| :--- | :--- | :--- | :--- |
| **Legacy Binary Office** | `.doc`, `.ppt` | Displays magic-byte signature (`D0 CF 11 E0`), metadata summary, and clear guidance banner. | When local LibreOffice (`soffice --headless` with `MacroSecurityLevel=3`) is available, converts to PDF for exact paginated preview. |
| **OpenDocument Presentations & Apple iWork** | `.odp`, `.pages`, `.numbers`, `.key` | Inspects container structure / embedded `QuickLook/Preview.pdf` if present inside package. | Converts to PDF via isolated LibreOffice worker when exact layout rendering is requested. |
| **Legacy E-Books** | `.mobi` | Displays metadata and header inspection. | Converts to `.epub` / HTML chapters via local e-book conversion worker. |
| **Non-Web Video Codecs** | `.avi`, `.mkv` (with HEVC/AC-3) | Plays directly if the host OS WebView media pipeline supports the codec; otherwise shows codec diagnostic panel. | Transcodes to browser-compatible H.264/AAC `.mp4` via local `ffmpeg` worker. |
| **Proprietary Archives** | `.7z`, `.rar` | Detects magic signature (`37 7A BC AF` / `52 61 72 21`) and displays security & metadata summary. | Extracts directory listing in isolated worker sandbox with strict decompression limits. |

---

## 3. Desktop Security & Capability Guarantees

1. **Least-Privilege Capabilities (`src-tauri/capabilities/default.json`)**:
   - Only `dialog:allow-open`, `fs:allow-read-file`, `fs:allow-stat`, and `window-state` permissions are granted.
   - No arbitrary shell execution permission is exposed to the frontend webview.
2. **OS "Open With" Integration (`src-tauri/src/main.rs`)**:
   - CLI file paths passed by the OS are canonicalized and verified as regular files in Rust before emitting `omniview://open-with-files` or serving bytes via `consume_startup_open_with_files`.
3. **Strict Content Security Policy**:
   - Blocks `<object>`, `<embed>`, `<frame>`, and untrusted remote scripts (`object-src 'none'; frame-src 'none'`).
