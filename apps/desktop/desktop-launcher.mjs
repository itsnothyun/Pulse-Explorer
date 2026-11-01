#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const distDir = resolve(__dirname, '../web/dist');
const PORT = Number(process.env.OMNIVIEW_DESKTOP_PORT || 5178);

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

async function startEmbeddedDesktopServer() {
  const server = createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
      let relPath = decodeURIComponent(reqUrl.pathname);
      if (relPath === '/') relPath = '/index.html';

      let filePath = join(distDir, relPath);
      try {
        const st = await stat(filePath);
        if (st.isDirectory()) filePath = join(filePath, 'index.html');
      } catch {
        filePath = join(distDir, 'index.html');
      }

      const data = await readFile(filePath);
      const ext = extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_MAP[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('OmniView Desktop Asset Error: ' + (err?.message || String(err)));
    }
  });

  await new Promise((resolveListen) => server.listen(PORT, '127.0.0.1', resolveListen));
  const appUrl = `http://127.0.0.1:${PORT}`;
  console.log(`[OmniView Desktop] Embedded offline runtime active at ${appUrl}`);

  // Launch Native Windows App Window (WebView2 / Edge App Mode or Chrome App Mode — no address bar, standalone desktop window)
  const edgePaths = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];

  let launched = false;
  for (const edgeBin of edgePaths) {
    try {
      await stat(edgeBin);
      const child = spawn(
        edgeBin,
        [
          `--app=${appUrl}`,
          '--window-size=1440,920',
          '--app-name=OmniView',
          '--new-window',
        ],
        { detached: true, stdio: 'ignore' }
      );
      child.unref();
      launched = true;
      console.log('[OmniView Desktop] Opened native standalone desktop window.');
      break;
    } catch {
      // Try next path
    }
  }

  if (!launched) {
    const child = spawn('cmd.exe', ['/c', 'start', '', appUrl], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  }
}

startEmbeddedDesktopServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
