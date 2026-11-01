# OmniView — Technology Stack & Open-Source Licensing Matrix

---

## 1. Core Stack Overview

OmniView selects battle-tested, permissively licensed open-source libraries for its core runtime while isolating optional copyleft/MPL server conversion binaries (`LibreOffice`, `FFmpeg`, `ONLYOFFICE`) behind process boundaries or optional container profiles.

---

## 2. Frontend, Rendering & Shared Libraries

| Component / Library | Package Name | Version Target | License | Role in OmniView | Commercial / Distribution Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **React** | `react`, `react-dom` | `^18.3.x` | `MIT` | Declarative UI shell and adapter viewport host | Permissive |
| **TypeScript** | `typescript` | `^5.6.x` | `Apache-2.0` | Strict static typing across all monorepo packages | Permissive |
| **Vite** | `vite` | `^5.4.x` | `MIT` | Lightning-fast ESM bundler and worker asset pipeline | Permissive |
| **Tailwind CSS** | `tailwindcss` | `^3.4.x` | `MIT` | Utility-first styling, dark/light theme tokens | Permissive |
| **Zustand** | `zustand` | `^5.0.x` | `MIT` | Deterministic state management for shell, tabs, zoom, and annotations | Permissive |
| **Lucide Icons** | `lucide-react` | `^0.450.x` | `ISC` | Consistent iconography across toolbars and file trees | Permissive |
| **Mozilla PDF.js** | `pdfjs-dist` | `^4.7.x` | `Apache-2.0` | Native client-side PDF canvas rendering, text layer, and outline extraction | Permissive |
| **Mammoth.js** | `mammoth` | `^1.8.x` | `BSD-2-Clause` | Client-side `.docx` to clean semantic HTML conversion | Permissive |
| **SheetJS Community** | `xlsx` | `^0.18.5` | `Apache-2.0` | Client-side `.xlsx`, `.xls`, `.ods` workbook parsing and formula extraction | Permissive (`Apache-2.0`) |
| **Papa Parse** | `papaparse` | `^5.4.x` | `MIT` | Streaming, RFC-4180 compliant `.csv` and `.tsv` parser | Permissive |
| **JSZip** | `jszip` | `^3.10.x` | `MIT` / `GPLv3` (Dual) | Client-side inspection of `.zip`, `.docx`, `.pptx`, `.epub` containers | Used under **MIT** license |
| **Marked** | `marked` | `^14.1.x` | `MIT` | High-speed Markdown AST parser and HTML compiler | Permissive |
| **DOMPurify** | `dompurify` | `^3.1.x` | `Apache-2.0` / `MPL-2.0` | Strict XSS sanitization for HTML, SVG, Markdown, EPUB, and DOCX output | Permissive |
| **Highlight.js / Shiki** | `shiki` / `prismjs` | `^1.x` | `MIT` | Syntax highlighting for 40+ programming languages and config formats | Permissive |
| **IDB** | `idb` | `^8.0.x` | `ISC` | Promise-based IndexedDB wrapper for offline files, sessions, and annotations | Permissive |

---

## 3. Backend API, Database & Queue Libraries

| Component / Library | Package Name | Version Target | License | Role in OmniView | Commercial / Distribution Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Node.js LTS** | `node` | `>=20.18.0` | `MIT` | Server & worker JavaScript runtime | Permissive |
| **Fastify** | `fastify` | `^5.0.x` | `MIT` | High-throughput, schema-validated HTTP API server | Permissive |
| **Zod** | `zod` | `^3.23.x` | `MIT` | Runtime request/response validation and DTO parsing | Permissive |
| **Prisma ORM** | `@prisma/client`, `prisma` | `^5.20.x` | `Apache-2.0` | Type-safe PostgreSQL schema migrations and queries | Permissive |
| **BullMQ** | `bullmq` | `^5.15.x` | `MIT` | Redis-backed distributed job queue for document conversion | Permissive |
| **ioredis** | `ioredis` | `^5.4.x` | `MIT` | Redis client for caching and BullMQ transport | Permissive |
| **AWS SDK v3 S3** | `@aws-sdk/client-s3` | `^3.650.x` | `Apache-2.0` | S3 / MinIO object storage streaming and pre-signed URLs | Permissive |
| **Pino** | `pino` | `^9.4.x` | `MIT` | Structured JSON audit and operational logging | Permissive |

---

## 4. Infrastructure, Conversion Workers & Desktop Shell

| Component / Binary | Version Target | License | Invocation Model | Licensing & Compliance Disclosure |
| :--- | :--- | :--- | :--- | :--- |
| **PostgreSQL** | `16-alpine` | `PostgreSQL License` (MIT-like) | TCP Socket via Prisma | Permissive open-source license. |
| **Redis** | `7-alpine` | `BSD-3-Clause` (Redis 7.2) | TCP Socket via BullMQ | Redis 7.2 uses classic BSD-3-Clause. Compatible with Valkey (`BSD-3-Clause`). |
| **MinIO** | `RELEASE.2024+` | `AGPL-3.0` (Server Binary) | S3 HTTP API Only | MinIO is used strictly as an unmodified storage infrastructure container in local/dev Docker Compose. Production deployments can drop-in AWS S3, Cloudflare R2, or Ceph with zero code changes. |
| **LibreOffice Headless** | `7.6+` / `24.2+` | `MPL-2.0` | Isolated CLI subprocess (`soffice --headless`) in `Dockerfile.worker` | Invoked as an unmodified separate OS process in the worker container. No source code linking occurs. Fully compliant with commercial and proprietary distribution under MPL-2.0. |
| **FFmpeg** | `6.1+` | `LGPL-2.1+` / `GPL-2.0+` | Isolated CLI subprocess (`ffmpeg`) in `Dockerfile.worker` | Invoked as an unmodified separate OS executable for optional audio/video stream normalization and waveform extraction. Ensure non-free codecs remain disabled in commercial redistribution builds. |
| **ONLYOFFICE Document Server (Optional Enterprise Profile)** | `8.x` | `AGPL-3.0` / Commercial License | Optional external webhook service (disabled by default) | **Explicit Disclosure**: ONLYOFFICE is **not** bundled or enabled by default. Organizations requiring collaborative real-time editing via ONLYOFFICE must either comply with `AGPL-3.0` network disclosure terms or obtain a commercial license from Ascensio System SIA. |
| **Tauri v2** | `^2.0.0` | `MIT` OR `Apache-2.0` | Native Rust desktop binary (`@omniview/desktop`) | Dual-licensed MIT/Apache-2.0. Produces small (<15 MB) native installers for Windows (`.msi`/`.exe`), macOS (`.dmg`), and Linux (`.AppImage`/`.deb`) without bundling Chromium. |

---

## 5. License Verification Policy

1. **Zero GPL/AGPL Libraries Linked in Client or API Code**: All npm dependencies installed in `packages/*` and `apps/*` are restricted to permissive licenses (`MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `MPL-2.0`).
2. **Process Boundary Isolation**: External conversion tools (`soffice`, `ffmpeg`) execute strictly via `execFile` with explicit argument arrays (never shell string interpolation) inside `@omniview/worker`.
