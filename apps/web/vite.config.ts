import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
  },
  optimizeDeps: {
    include: ['pdfjs-dist', 'mammoth', 'xlsx', 'papaparse', 'jszip', 'marked', 'fflate', 'yaml', 'pdf-lib'],
    // FFmpeg spawns its own module worker, which breaks when pre-bundled.
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  worker: { format: 'es' },
});
