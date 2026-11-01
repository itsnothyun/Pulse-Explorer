# Security Policy

Pulse Explorer opens files from untrusted sources, so security is part of the design, not an add-on. The full threat model is in [docs/05_SECURITY_ARCHITECTURE.md](docs/05_SECURITY_ARCHITECTURE.md).

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately through GitHub: **Security → Report a vulnerability** on this repository
(<https://github.com/itsnothyun/Pulse-Explorer/security/advisories/new>).

Include what you found, the file or steps that trigger it, and the version or commit. You can expect an acknowledgement within a few days. Fixes are released first, then disclosed, and reporters are credited unless they prefer otherwise.

## Supported versions

Only the latest commit on `main` and the most recent installer receive security fixes.

## What is in scope

- A crafted file that runs script, escapes sanitization, or reads or writes outside the app
- Archive handling: zip bombs, zip-slip and tar path traversal
- Conversion and compression output that leaks data or executes content
- Desktop shell: Tauri capabilities, content security policy, IPC commands and the installer
- The optional API and worker: SSRF, container escape, authentication gaps

Out of scope: issues that need an already-compromised machine, social engineering, and findings in third-party dependencies with no reachable path (report those upstream).

## Security model in short

| Area | Protection |
| --- | --- |
| File identity | Type is decided from magic bytes, not the extension or declared MIME type |
| Rendering | DOMPurify sanitization for SVG, HTML, Markdown, EPUB and DOCX output |
| Office files | Macros (`vbaProject.bin`) and DDE formulas are never executed; a notice is shown |
| Archives | 100:1 ratio ceiling, 1 GB expansion cap, and rejection of `..`, absolute and drive-letter paths in zip and tar |
| Secrets | `.env` and secret files are masked in the viewer and blocked from any remote upload |
| Conversion | Runs on-device (WebAssembly and browser APIs). Nothing is uploaded and no CDN is contacted. The original file is never modified; results are saved as new files |
| Desktop | Least-privilege Tauri v2 capabilities, a strict CSP (`object-src 'none'`, `frame-src 'none'`, no remote scripts), and no network access beyond the local API |
| Remote URL import | SSRF guard that resolves DNS first and blocks loopback, link-local, private ranges and internal service names |
| Worker (optional) | Non-root container, read-only root filesystem, all capabilities dropped, `no-new-privileges`, isolated network |

## Known limitations

- The content security policy allows `wasm-unsafe-eval`, which WebAssembly (FFmpeg, PDF rendering) needs. It does not allow `unsafe-eval` for JavaScript.
- Local files are stored unencrypted in the browser's IndexedDB. Anyone with access to your user profile can read them. Use **Settings → Files → Clear workspace** on shared machines.
- Conversions of untrusted media run FFmpeg in the app's own WebAssembly sandbox. A malformed file can crash or stall a conversion, but cannot reach beyond the page.
- The installer is not code-signed yet, so Windows SmartScreen may warn on first run.

## For contributors

- Never add `eval`, `new Function`, or `innerHTML` with unsanitized input.
- Route any HTML or SVG you render through the existing sanitizers in `@omniview/utilities`.
- Keep new Tauri permissions to the minimum and justify them in the pull request.
- Treat every file, archive entry name and URL as hostile input.
