import JSZip from 'jszip';
import * as XLSX from 'xlsx';

/**
 * Generates a real, spec-compliant multi-page PDF 1.4 binary document with selectable text streams
 * so Mozilla PDF.js parses and renders actual pages onto HTML5 canvas.
 */
export function buildRealMultipagePdfBytes(pagesText: { title: string; lines: string[] }[]): Uint8Array {
  const encoder = new TextEncoder();
  const objects: string[] = [];

  // Object 1: Catalog
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);

  // Object 3: Font Helvetica
  const fontObjNum = 3;
  // Object 4: Font Helvetica-Bold
  const fontBoldObjNum = 4;

  const pageObjNums: number[] = [];
  let nextObjNum = 5;

  const pageAndContentObjs: { num: number; body: string }[] = [];

  const escapePdfText = (s: string) =>
    s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

  for (let i = 0; i < pagesText.length; i++) {
    const pageNum = nextObjNum++;
    const contentNum = nextObjNum++;
    pageObjNums.push(pageNum);

    const pageData = pagesText[i];
    const streamCommands: string[] = [
      'q',
      '0.97 0.98 1.0 rg',
      '36 740 540 38 re f',
      '0.12 0.25 0.68 rg',
      '36 740 4 38 re f',
      'BT',
      '/F2 16 Tf',
      '0.08 0.12 0.22 rg',
      '52 753 Td',
      `(${escapePdfText(pageData.title)}) Tj`,
      'ET',
      'BT',
      '/F1 11 Tf',
      '0.18 0.22 0.30 rg',
      '48 705 Td',
      '18 TL',
    ];

    for (const line of pageData.lines) {
      streamCommands.push(`(${escapePdfText(line)}) Tj T*`);
    }

    streamCommands.push(
      'ET',
      'BT',
      '/F1 9 Tf',
      '0.45 0.50 0.58 rg',
      '48 36 Td',
      `(OmniView PDF.js Engine  |  Page ${i + 1} of ${pagesText.length}  |  Normalized Coordinate Space Ready) Tj`,
      'ET',
      'Q'
    );

    const streamBody = streamCommands.join('\n');
    const streamByteLen = encoder.encode(streamBody).length;

    pageAndContentObjs.push({
      num: pageNum,
      body: `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjNum} 0 R /F2 ${fontBoldObjNum} 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`,
    });

    pageAndContentObjs.push({
      num: contentNum,
      body: `${contentNum} 0 obj\n<< /Length ${streamByteLen} >>\nstream\n${streamBody}\nendstream\nendobj\n`,
    });
  }

  // Object 2: Pages root
  const kidsList = pageObjNums.map((n) => `${n} 0 R`).join(' ');
  const orderedObjects: { num: number; body: string }[] = [
    { num: 1, body: `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` },
    {
      num: 2,
      body: `2 0 obj\n<< /Type /Pages /Kids [${kidsList}] /Count ${pageObjNums.length} >>\nendobj\n`,
    },
    {
      num: 3,
      body: `3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
    },
    {
      num: 4,
      body: `4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n`,
    },
    ...pageAndContentObjs,
  ];

  let pdfText = '%PDF-1.4\n';
  const offsets: number[] = [0]; // index 0 is free object

  for (const obj of orderedObjects) {
    offsets[obj.num] = encoder.encode(pdfText).length;
    pdfText += obj.body;
  }

  const xrefOffset = encoder.encode(pdfText).length;
  const totalObjects = orderedObjects.length + 1;
  pdfText += `xref\n0 ${totalObjects}\n`;
  pdfText += `0000000000 65535 f \n`;
  for (let idx = 1; idx < totalObjects; idx++) {
    const off = String(offsets[idx] ?? 0).padStart(10, '0');
    pdfText += `${off} 00000 n \n`;
  }

  pdfText += `trailer\n<< /Size ${totalObjects} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(pdfText);
}

/**
 * Generates a real OpenXML .docx binary archive readable by Mammoth and WordViewerAdapter.
 */
export async function buildRealDocxBytes(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>OmniView Architecture &amp; Security Specification</w:t></w:r></w:p>
    <w:p><w:r><w:t>This Microsoft Word OpenXML (.docx) document is parsed directly from its binary ZIP/XML structure without fabricating sample content.</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>1. Executive Summary</w:t></w:r></w:p>
    <w:p><w:r><w:t>OmniView provides a unified document viewing interface across PDF, Word, PowerPoint, Excel, EPUB, Code, Media, and Archive containers while enforcing strict zero-trust security boundaries.</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>2. Rendering Fidelity Matrix</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Format Family</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Primary Engine</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Fidelity Guarantee</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>PDF (.pdf)</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Mozilla PDF.js</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Exact vector &amp; page-level fidelity</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Word (.docx)</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Mammoth + LibreOffice Worker</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Semantic HTML locally; exact pagination via PDF worker</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>3. Defense-in-Depth Controls</w:t></w:r></w:p>
    <w:p><w:r><w:t>All imported documents undergo magic-byte inspection, SHA-256 deduplication, and strict script/macro sanitization prior to rendering.</w:t></w:r></w:p>
  </w:body>
</w:document>`
  );
  return await zip.generateAsync({ type: 'uint8array' });
}

/**
 * Generates a real OpenXML .pptx binary presentation with multiple slides, tables, and speaker notes.
 */
export async function buildRealPptxBytes(): Promise<Uint8Array> {
  const zip = new JSZip();

  const slideData = [
    {
      title: 'OmniView Q4 Enterprise Architecture Review',
      bullets: [
        'One Application. Multiple File Formats. One Consistent Viewing Experience.',
        'Zero-Trust Local-First Processing with Opt-In Cloud Persistence',
        'Normalized Coordinate Annotation Engine (Zoom-Invariant)',
      ],
      notes: 'Welcome stakeholders. Emphasize that local files never leave the browser unless the user explicitly triggers remote conversion or cloud storage.',
    },
    {
      title: 'Plugin-Based ViewerAdapter Pipeline',
      bullets: [
        '1. Magic-byte signature inspection (%PDF-, PK\\x03\\x04, OLE2, RIFF, ID3)',
        '2. Priority-ordered capability resolution via ViewerAdapterRegistry',
        '3. Isolated conversion worker fallback for legacy binary formats (.doc, .ppt)',
        '4. Transparent hex & diagnostic fallback when no renderer applies',
      ],
      notes: 'Walk through the 9-step resolution pipeline defined in Section 10 of the architecture spec.',
    },
    {
      title: 'Performance Benchmarks & Virtualization Budgets',
      bullets: [
        '500-Page PDF: Lazy page viewport rendering via IntersectionObserver',
        '50,000-Row Workbook: Windowed virtual row slicing at 60 FPS',
        'Memory Discipline: Explicit URL.revokeObjectURL() on tab close',
      ],
      notes: 'Highlight that no base64 transport is used for large files; binary ArrayBuffers and Blob URLs are used exclusively.',
      table: [
        ['Workload', 'Target Latency', 'Measured Memory'],
        ['PDF Page Render', '< 45 ms', '38 MB'],
        ['10k Row XLSX Grid', '< 30 ms', '42 MB'],
        ['Archive Inspection', '< 20 ms', '19 MB'],
      ],
    },
  ];

  slideData.forEach((s, idx) => {
    const slideNum = idx + 1;
    const bulletXml = s.bullets
      .map((b) => `<a:p><a:r><a:t>${b}</a:t></a:r></a:p>`)
      .join('');

    const tableXml = s.table
      ? `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>${s.table
          .map(
            (row) =>
              `<a:tr>${row
                .map((cell) => `<a:tc><a:txBody><a:p><a:r><a:t>${cell}</a:t></a:r></a:p></a:txBody></a:tc>`)
                .join('')}</a:tr>`
          )
          .join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
      : '';

    zip.file(
      `ppt/slides/slide${slideNum}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:p><a:r><a:t>${s.title}</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
        <p:txBody>${bulletXml}</p:txBody>
      </p:sp>
      ${tableXml}
    </p:spTree>
  </p:cSld>
</p:sld>`
    );

    zip.file(
      `ppt/notesSlides/notesSlide${slideNum}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${s.notes}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
</p:notes>`
    );
  });

  return await zip.generateAsync({ type: 'uint8array' });
}

/**
 * Generates a real multi-sheet .xlsx binary workbook with formulas, numbers, and financial data.
 */
export function buildRealXlsxBytes(): Uint8Array {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Revenue Summary with formulas
  const revenueAoA: (string | number)[][] = [
    ['Region', 'Q1 Revenue ($)', 'Q2 Revenue ($)', 'Q3 Revenue ($)', 'Q4 Revenue ($)', 'Annual Total ($)', 'YoY Growth %'],
    ['North America', 420500, 465200, 512800, 589400, 1987900, 18.4],
    ['Europe (EMEA)', 310200, 328900, 355100, 398000, 1392200, 14.2],
    ['Asia-Pacific', 245000, 279400, 318600, 372500, 1215500, 24.8],
    ['Latin America', 98400, 112300, 126900, 145200, 482800, 19.1],
    ['Total / Average', 1074100, 1185800, 1313400, 1505100, 5078400, 19.13],
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(revenueAoA);
  // Attach real Excel formulas to Annual Total column (F2:F6)
  ws1['F2'] = { t: 'n', v: 1987900, f: 'SUM(B2:E2)' };
  ws1['F3'] = { t: 'n', v: 1392200, f: 'SUM(B3:E3)' };
  ws1['F4'] = { t: 'n', v: 1215500, f: 'SUM(B4:E4)' };
  ws1['F5'] = { t: 'n', v: 482800, f: 'SUM(B5:E5)' };
  ws1['F6'] = { t: 'n', v: 5078400, f: 'SUM(F2:F5)' };
  XLSX.utils.book_append_sheet(wb, ws1, 'Revenue_Summary');

  // Sheet 2: Format Telemetry (250 rows for virtualized grid verification)
  const telemetryRows: (string | number)[][] = [
    ['Job_ID', 'Format', 'Adapter_Engine', 'File_Size_KB', 'Render_Latency_ms', 'Security_Status'],
  ];
  const formats = [
    ['PDF', 'PDFViewerAdapter'],
    ['DOCX', 'WordViewerAdapter'],
    ['PPTX', 'PresentationViewerAdapter'],
    ['XLSX', 'SpreadsheetViewerAdapter'],
    ['EPUB', 'EbookViewerAdapter'],
    ['SVG', 'ImageViewerAdapter'],
  ];
  for (let i = 1; i <= 250; i++) {
    const f = formats[i % formats.length];
    telemetryRows.push([
      `JOB-${String(1000 + i)}`,
      f[0],
      f[1],
      (i * 47) % 12400 + 24,
      (i * 7) % 65 + 8,
      'VERIFIED_SAFE',
    ]);
  }
  const ws2 = XLSX.utils.aoa_to_sheet(telemetryRows);
  XLSX.utils.book_append_sheet(wb, ws2, 'Adapter_Telemetry_250');

  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new Uint8Array(out);
}

/**
 * Generates a real spec-compliant EPUB eBook container with META-INF/container.xml, content.opf, and 3 chapters.
 */
export async function buildRealEpubBytes(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  );
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Designing Universal Document Systems</dc:title>
    <dc:creator>Dr. Elena Vance &amp; OmniView Systems Group</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="chapter3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>
  </spine>
</package>`
  );
  zip.file(
    'OEBPS/chapter1.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<html><head><title>Chapter 1: The Fragmentation of File Formats</title></head>
<body>
  <h1>Chapter 1: The Fragmentation of File Formats</h1>
  <p>Modern knowledge workers navigate dozens of incompatible containers every day—fixed-layout PDFs, flow-oriented OpenXML manuscripts, multi-dimensional spreadsheets, and packaged archives.</p>
  <p>A universal viewer must preserve the intrinsic semantics of each medium: pages for print documents, slides with aspect-ratio fidelity for presentations, virtualized grids for workbooks, and customizable typography for long-form eBooks.</p>
</body></html>`
  );
  zip.file(
    'OEBPS/chapter2.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<html><head><title>Chapter 2: Zero-Trust Document Parsing</title></head>
<body>
  <h1>Chapter 2: Zero-Trust Document Parsing</h1>
  <p>Every imported document is an untrusted byte stream. Extensions lie; MIME headers can be spoofed. Therefore, format resolution begins at byte offset zero with cryptographic hashing and magic-signature verification.</p>
  <p>Embedded scripts in SVG images, VBA macros in spreadsheets, and path-traversal entries inside ZIP archives must be neutralized before any pixel reaches the screen.</p>
</body></html>`
  );
  zip.file(
    'OEBPS/chapter3.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<html><head><title>Chapter 3: Normalized Coordinate Annotations</title></head>
<body>
  <h1>Chapter 3: Normalized Coordinate Annotations</h1>
  <p>When a reader highlights a passage or draws a bounding box at 100% zoom, that annotation must remain anchored with sub-pixel precision at 250% zoom or Fit-Width mode. Storing coordinates in normalized [0..1] unit space guarantees resolution independence.</p>
</body></html>`
  );

  return await zip.generateAsync({ type: 'uint8array' });
}

/**
 * Generates an SVG graphic that includes an embedded <script> tag to prove OmniView strips scripts safely.
 */
export function buildSanitizedTestSvgBytes(): Uint8Array {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" width="640" height="360">
  <script>window.__UNSAFE_SVG_EXECUTED__ = true; alert('XSS');</script>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#1e3a8a"/>
    </linearGradient>
  </defs>
  <rect width="640" height="360" rx="16" fill="url(#bg)"/>
  <circle cx="160" cy="180" r="85" fill="#3b82f6" fill-opacity="0.25" stroke="#60a5fa" stroke-width="3"/>
  <polygon points="160,115 218,215 102,215" fill="#38bdf8" fill-opacity="0.45" stroke="#bae6fd" stroke-width="2"/>
  <text x="285" y="145" fill="#f8fafc" font-family="Inter, sans-serif" font-size="24" font-weight="bold">OmniView Vector Pipeline</text>
  <text x="285" y="185" fill="#93c5fd" font-family="Inter, sans-serif" font-size="15">Resolution-Independent SVG Diagram</text>
  <text x="285" y="220" fill="#34d399" font-family="monospace" font-size="13">[SECURITY] Embedded &lt;script&gt; neutralized</text>
</svg>`;
  return new TextEncoder().encode(svg);
}

/**
 * Generates a real synthesized PCM .wav audio file (2-second harmonic chord) so AudioViewerAdapter plays real audio.
 */
export function buildRealWavAudioBytes(): Uint8Array {
  const sampleRate = 22050;
  const durationSeconds = 2;
  const numSamples = sampleRate * durationSeconds;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const envelope = Math.exp(-t * 1.4);
    const wave =
      0.45 * Math.sin(2 * Math.PI * 440 * t) +
      0.3 * Math.sin(2 * Math.PI * 554.37 * t) +
      0.25 * Math.sin(2 * Math.PI * 659.25 * t);
    const sample = Math.max(-1, Math.min(1, wave * envelope));
    view.setInt16(44 + i * 2, sample * 32767, true);
  }

  return new Uint8Array(buffer);
}

/**
 * Generates a real .zip archive with nested folders, inspectable files, and a simulated path-traversal entry to verify defense.
 */
export async function buildRealZipBytes(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    'README.md',
    '# OmniView Release Bundle\n\nThis archive contains nested configuration and documentation files.\nClick "Preview Entry" on any safe entry to open it in a new tab!'
  );
  zip.file(
    'config/production.json',
    JSON.stringify(
      {
        service: 'omniview-cluster',
        region: 'us-east-1',
        security: {
          sandboxedConversion: true,
          disableExcelMacros: true,
          maxArchiveCompressionRatio: 100,
        },
      },
      null,
      2
    )
  );
  zip.file('data/metrics.csv', 'metric,value,unit\npdf_render_p95,28,ms\ngrid_scroll_fps,60,fps\nmemory_ceiling,180,MB\n');
  // Include a placeholder path of exact byte length 14 ("TRAVERSAL_DIR/") and patch it in the binary ZIP
  // to "../../../../.." so JSZip's writer does not strip the "../" segments before encoding.
  zip.file('TRAVERSAL_DIR/shadow-traversal-attempt.txt', 'blocked-content');
  const rawZip = await zip.generateAsync({ type: 'uint8array' });
  const needle = new TextEncoder().encode('TRAVERSAL_DIR/');
  const replacement = new TextEncoder().encode('../../../../../'); // wait: 14 bytes: "../../../../.."
  const patchBytes = new TextEncoder().encode('../../../../..');
  for (let i = 0; i <= rawZip.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (rawZip[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      rawZip.set(patchBytes, i);
    }
  }
  void replacement;
  return rawZip;
}

export interface GeneratedSampleFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  folderId?: string;
  isFavorite?: boolean;
}

export async function generateStarterWorkspaceSamples(): Promise<GeneratedSampleFile[]> {
  const pdfBytes = buildRealMultipagePdfBytes([
    {
      title: 'OmniView — Universal Document Viewer Architecture (Page 1)',
      lines: [
        'Document ID: OV-SPEC-2026-001   |   Classification: Engineering Architecture',
        '--------------------------------------------------------------------------------',
        '1. CORE OBJECTIVE',
        'One application. Multiple file formats. One consistent viewing experience.',
        'OmniView renders real binary PDFs, Word documents, PowerPoint slide decks,',
        'Excel workbooks, EPUB eBooks, SVG/raster images, source code, media, and',
        'archives inside a unified, zero-trust workspace.',
        '',
        '2. NORMALIZED COORDINATE ANNOTATIONS',
        'Use the toolbar above to add Highlights, Rectangles, Freehand ink, or Notes.',
        'All annotations are stored in normalized [0..1] page coordinates and locked',
        'to the SHA-256 checksum of this file so they scale accurately at any zoom.',
        '',
        '3. FULL-TEXT IN-DOCUMENT SEARCH',
        'Try searching for "Normalized", "Zero-Trust", or "Virtualization" using the',
        'search bar in the toolbar (or press Ctrl/Cmd + F) to jump across pages.',
      ],
    },
    {
      title: 'Section 2: Defense-in-Depth & Sandbox Isolation (Page 2)',
      lines: [
        '4. ZERO-TRUST FILE INSPECTION',
        'Every imported file is inspected at byte offset 0 for magic signatures:',
        '  * PDF Documents: %PDF-1.x header verification',
        '  * OpenXML & EPUB: PK\\x03\\x04 container inspection',
        '  * Legacy Office: D0 CF 11 E0 A1 B1 1A E1 OLE2 compound header detection',
        '',
        '5. MALICIOUS CONTENT NEUTRALIZATION',
        '  * Excel (.xlsm / .xlsx): VBA macros are never executed; cached values shown.',
        '  * Vector Graphics (.svg): <script>, <foreignObject>, and onload stripped.',
        '  * Archives (.zip): Path traversal (../) and zip bombs (>100:1 ratio) blocked.',
        '',
        '6. VIRTUALIZED PERFORMANCE BUDGETS',
        'Large multi-page documents and 50,000-row spreadsheets use windowed rendering',
        'and Blob URL lifecycle management to maintain 60 FPS responsiveness.',
      ],
    },
    {
      title: 'Section 3: Desktop & Cloud Persistence Strategy (Page 3)',
      lines: [
        '7. LOCAL GUEST MODE VS. OPT-IN PERSISTENT WORKSPACE',
        'By default, OmniView processes supported formats 100% locally in memory.',
        'Private documents are never uploaded unless the user opts into Cloud Storage',
        'or explicitly authorizes isolated server-side LibreOffice conversion.',
        '',
        '8. TAURI V2 DESKTOP INTEGRATION',
        'The same frontend runs natively on Windows, macOS, and Linux via Tauri v2',
        'with scoped filesystem permissions and OS Open-With file associations.',
      ],
    },
  ]);

  const [docxBytes, pptxBytes, epubBytes, zipBytes] = await Promise.all([
    buildRealDocxBytes(),
    buildRealPptxBytes(),
    buildRealEpubBytes(),
    buildRealZipBytes(),
  ]);

  const xlsxBytes = buildRealXlsxBytes();
  const svgBytes = buildSanitizedTestSvgBytes();
  const wavBytes = buildRealWavAudioBytes();

  const tsCode = `// OmniView ViewerAdapter Plugin Contract
import type { DetectedFile, ViewerCapabilities } from '@omniview/shared-types';

export interface ViewerAdapter<TPayload = unknown> {
  readonly id: string;
  readonly displayName: string;
  readonly priority: number;

  supports(file: DetectedFile): boolean;
  getCapabilities(file: DetectedFile): ViewerCapabilities;
}

export function verifyNormalizedCoord(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, Number(value.toFixed(6))));
}
`;

  return [
    {
      name: 'OmniView_Architecture_Spec.pdf',
      mimeType: 'application/pdf',
      bytes: pdfBytes,
      folderId: 'folder-specs',
      isFavorite: true,
    },
    {
      name: 'Q4_Enterprise_Deck.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      bytes: pptxBytes,
      folderId: 'folder-specs',
      isFavorite: true,
    },
    {
      name: 'Global_Revenue_Workbook.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes: xlsxBytes,
      folderId: 'folder-finance',
      isFavorite: true,
    },
    {
      name: 'Security_Engineering_Standard.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: docxBytes,
      folderId: 'folder-specs',
    },
    {
      name: 'Designing_Universal_Document_Systems.epub',
      mimeType: 'application/epub+zip',
      bytes: epubBytes,
    },
    {
      name: 'Vector_Pipeline_Sanitized.svg',
      mimeType: 'image/svg+xml',
      bytes: svgBytes,
    },
    {
      name: 'ViewerAdapterContract.ts',
      mimeType: 'text/typescript',
      bytes: new TextEncoder().encode(tsCode),
    },
    {
      name: 'Acoustic_Harmonic_Test.wav',
      mimeType: 'audio/wav',
      bytes: wavBytes,
    },
    {
      name: 'Release_Bundle_Inspect.zip',
      mimeType: 'application/zip',
      bytes: zipBytes,
    },
  ];
}
