import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, 'generated');

function buildPdfFixture(pageCount) {
  let body = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  const kids = Array.from({ length: pageCount }, (_, i) => `${i + 3} 0 R`).join(' ');
  body += `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`;
  for (let p = 1; p <= pageCount; p++) {
    body += `${p + 2} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n`;
  }
  body += 'trailer\n<< /Root 1 0 R >>\n%%EOF\n';
  return Buffer.from(body, 'utf-8');
}

async function main() {
  await mkdir(outDir, { recursive: true });

  // 1. Simple PDF
  await writeFile(join(outDir, 'simple.pdf'), buildPdfFixture(3));
  // 2. 500-page PDF
  await writeFile(join(outDir, 'large-500-pages.pdf'), buildPdfFixture(500));
  // 3. CSV with special characters
  await writeFile(
    join(outDir, 'special-chars.csv'),
    'id,name,notes,amount\n1,"Café & Résumé","Line with, comma and ""quotes""",1420.50\n2,"Tokyo 東京","UTF-8 International",9800.00\n',
    'utf-8'
  );
  // 4. SVG with unsafe <script> content
  await writeFile(
    join(outDir, 'unsafe-script.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><script>alert("XSS")</script><circle cx="50" cy="50" r="40" onload="evil()"/></svg>',
    'utf-8'
  );
  // 5. HTML with script content
  await writeFile(
    join(outDir, 'unsafe-script.html'),
    '<!DOCTYPE html><html><body><h1>Test Document</h1><script>window.pwned = true;</script><p onclick="steal()">Safe paragraph</p></body></html>',
    'utf-8'
  );
  // 6. Corrupt document
  await writeFile(
    join(outDir, 'corrupt.docx'),
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xde, 0xad, 0xbe, 0xef])
  );
  // 7. Unsupported binary file
  await writeFile(
    join(outDir, 'proprietary-cad.dwg'),
    Buffer.from([0x41, 0x43, 0x31, 0x30, 0x33, 0x32, 0x00, 0x00, 0x1a, 0x2b])
  );

  console.log(`Generated representative format fixtures in ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
