# Pulse Explorer (OmniView)

> One application. Multiple file formats. One consistent viewing experience.

Pulse Explorer is a privacy-first, local-first universal viewer for documents, spreadsheets, presentations, code, media, eBooks, archives and raw binaries. It runs in the browser and as a native desktop app (Tauri v2), with an optional containerized conversion pipeline for high-fidelity rendering. Internally the packages are namespaced `@omniview/*`.

## Features

- **Broad format coverage**
  - Documents: `.pdf`, `.docx`, `.doc`, `.odt`, `.rtf`
  - Presentations: `.pptx`, `.ppt`, `.odp`
  - Spreadsheets: `.xlsx`, `.xls`, `.ods`, `.csv`, `.tsv`
  - Images and vector: `.png`, `.jpg`, `.webp`, `.gif`, `.bmp`, `.ico`, `.svg` (visual and XML source views)
  - eBooks: `.epub`, `.fb2`
  - Code and config: `.ts`, `.js`, `.py`, `.go`, `.rs`, `.json`, `.yaml`, `.toml`, `.xml`, `.md`, `.html`, `.css`, `.sql`, `.sh`, `.ini`, `.log`, plus a masked `.env` inspector
  - Audio and video: `.mp4`, `.webm`, `.ogg`, `.mp3`, `.wav`, `.flac`, `.aac`
  - Archives: `.zip`, `.tar`, `.gz`, `.tgz` with a virtual tree and recursive inner-file preview
  - Fallback: hex and ASCII inspector for unknown or corrupted files
- **Local-first security**
  - Magic-byte detection instead of trusting file extensions
  - DOMPurify sanitization for SVG, HTML, Markdown, EPUB and DOCX output
  - Office macros (`vbaProject.bin`) are never executed
  - Zip-bomb ratio ceiling (100:1) and zip-slip path traversal protection
  - `.env` and secret files are blocked from remote upload
- **Annotations and session continuity**: zoom-invariant normalized (`0..1`) coordinates, cell references, line ranges and media timecodes, stored in IndexedDB and optionally synced to PostgreSQL.

## Repository layout

```text
apps/
  web/              React + Tailwind + Zustand shell (Vite)
  api/              Fastify REST API + Prisma
  worker/           Sandboxed LibreOffice / FFmpeg conversion worker
  desktop/          Tauri v2 desktop shell
packages/
  shared-types/     Domain interfaces and DTOs
  utilities/        Magic bytes, sanitizers, zip guard
  viewer-core/      Adapter registry and session store
  viewer-adapters/  Per-format rendering engines
  ui/  config/      Shared UI and config
infrastructure/
  compose.yaml      PostgreSQL 16, Redis 7, MinIO, API, worker
  docker/           Worker Dockerfile
docs/               Architecture, security and roadmap specs
tests/              Integration (Vitest) and e2e (Playwright) tests
```

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org) 20 or newer
- [pnpm](https://pnpm.io) 11 (`corepack enable` will pick up the pinned version)
- Optional, for the full stack: Docker and Docker Compose
- Optional, for the native desktop build: the [Tauri prerequisites](https://tauri.app/start/prerequisites/) (Rust toolchain and platform build tools)

### Install

```bash
git clone https://github.com/itsnothyun/Pulse-Explorer.git
cd Pulse-Explorer
pnpm install
```

### Run the web app (local-first mode)

```bash
pnpm dev
```

Open http://localhost:5173. The app includes a sample file gallery and accepts any local file by drag and drop.

### Run the desktop app

```bash
pnpm desktop          # lightweight launcher (on Windows you can also run OmniView-Desktop.cmd)
pnpm desktop:tauri    # native Tauri dev window (requires Rust)
pnpm desktop:build    # production desktop bundle
```

See [apps/desktop/OFFLINE_SUPPORT_MATRIX.md](apps/desktop/OFFLINE_SUPPORT_MATRIX.md) for what works offline.

### Optional: API, worker and backing services

```bash
docker compose -f infrastructure/compose.yaml up --build -d
```

This starts PostgreSQL (5432), Redis (6379), MinIO (9000/9001), the API (4000) and the hardened worker. Ports can be overridden with `POSTGRES_PORT`, `REDIS_PORT`, `MINIO_API_PORT`, `MINIO_CONSOLE_PORT` and `API_PORT`. To run the services individually: `pnpm dev:api`, `pnpm dev:worker`, or `pnpm dev:all` for everything.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Web app dev server |
| `pnpm dev:all` | All apps via Turborepo |
| `pnpm build` | Build every package and app |
| `pnpm typecheck` | Type-check the workspace |
| `pnpm test` | Run Vitest tests |
| `pnpm test:unit` | Integration tests only |
| `pnpm fixtures:generate` | Generate sample files in `tests/fixtures/generated` |
| `pnpm test:e2e` | Playwright end-to-end tests (generate fixtures first) |

First-time e2e run: `pnpm exec playwright install`, then `pnpm fixtures:generate`, then `pnpm test:e2e`.

## Documentation

- [Project overview](docs/00_PROJECT_OVERVIEW.md)
- [System architecture](docs/01_SYSTEM_ARCHITECTURE.md)
- [Tech stack and licenses](docs/02_TECH_STACK_AND_LICENSES.md)
- [Rendering engine strategy](docs/03_RENDERING_ENGINE_STRATEGY.md)
- [Database design](docs/04_DATABASE_DESIGN.md)
- [Security architecture](docs/05_SECURITY_ARCHITECTURE.md)
- [Implementation roadmap](docs/06_IMPLEMENTATION_ROADMAP.md)