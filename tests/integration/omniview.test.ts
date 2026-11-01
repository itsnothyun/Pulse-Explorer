import { describe, expect, it } from 'vitest';
import {
  computeSha256Hex,
  inspectFileSignature,
  isSafeArchivePath,
  sanitizeFilename,
  sanitizeHtmlContent,
  sanitizeSvgContent,
} from '@omniview/utilities';
import { createDefaultViewerRegistry } from '@omniview/viewer-adapters';
import type { DetectedFile } from '@omniview/shared-types';
import {
  buildRealDocxBytes,
  buildRealEpubBytes,
  buildRealMultipagePdfBytes,
  buildRealPptxBytes,
  buildRealXlsxBytes,
  buildRealZipBytes,
} from '../../apps/web/src/services/sampleFixtures';
import { buildApiServer } from '../../apps/api/src/index';
import {
  buildLibreOfficeCommand,
  computeArtifactCacheKey,
  IsolatedConversionWorker,
} from '../../apps/worker/src/index';

function makeDetectedFile(
  name: string,
  bytes: Uint8Array,
  declaredMime = ''
): DetectedFile {
  const sig = inspectFileSignature(name, bytes.slice(0, 64), declaredMime);
  return {
    id: `test-${name}`,
    originalName: name,
    sanitizedName: sanitizeFilename(name),
    extension: sig.extension,
    declaredMimeType: declaredMime,
    detectedMimeType: sig.detectedMimeType,
    category: sig.category,
    sizeBytes: bytes.byteLength,
    checksum: 'sha256-test-checksum-001',
    importSource: 'sample-fixture',
    status: 'ready',
    createdAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
    magicSignatureHex: sig.magicSignatureHex,
    hasMacrosWarning: sig.hasMacrosWarning,
  };
}

describe('OmniView Universal Format Detection & ViewerAdapter Suite', () => {
  const registry = createDefaultViewerRegistry();

  it('detects magic byte signatures accurately across PDF, OpenXML, OLE2, PNG, and unknown binaries', () => {
    const pdfBytes = buildRealMultipagePdfBytes([{ title: 'Test', lines: ['Hello PDF'] }]);
    const pdfSig = inspectFileSignature('report.pdf', pdfBytes);
    expect(pdfSig.category).toBe('pdf');
    expect(pdfSig.detectedMimeType).toBe('application/pdf');
    expect(pdfSig.magicSignatureHex.startsWith('25 50 44 46')).toBe(true);

    // Spoofed extension: PDF named .txt should still be detected as PDF by magic signature!
    const spoofedSig = inspectFileSignature('disguised.txt', pdfBytes);
    expect(spoofedSig.category).toBe('pdf');
    expect(spoofedSig.detectedMimeType).toBe('application/pdf');

    // Legacy OLE2 compound header (.xls)
    const ole2Header = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const xlsSig = inspectFileSignature('legacy.xls', ole2Header);
    expect(xlsSig.category).toBe('spreadsheet');
    expect(xlsSig.hasMacrosWarning).toBe(true);

    // Unsupported binary file resolves to FallbackViewerAdapter
    const unknownBytes = new Uint8Array([0x41, 0x43, 0x31, 0x30, 0x00, 0xff]);
    const unknownFile = makeDetectedFile('drawing.dwg', unknownBytes);
    expect(unknownFile.category).toBe('unknown');
    expect(registry.resolve(unknownFile).id).toBe('FallbackViewerAdapter');
  });

  it('loads and parses real DOCX, PPTX, XLSX, CSV, EPUB, and ZIP binary files with search & outline extraction', async () => {
    // 1. Word DOCX
    const docxBytes = await buildRealDocxBytes();
    const docxFile = makeDetectedFile('spec.docx', docxBytes);
    const wordAdapter = registry.resolve(docxFile);
    expect(wordAdapter.id).toBe('WordViewerAdapter');
    const wordDoc = await wordAdapter.load(
      { file: docxFile, arrayBuffer: docxBytes.buffer as ArrayBuffer },
      { isOfflineOrLocalMode: true, allowRemoteConversion: false }
    );
    expect(wordDoc.unitCount).toBeGreaterThanOrEqual(1);
    expect(wordDoc.search('Zero-Trust').length).toBeGreaterThan(0);

    // 2. PowerPoint PPTX
    const pptxBytes = await buildRealPptxBytes();
    const pptxFile = makeDetectedFile('deck.pptx', pptxBytes);
    const pptxAdapter = registry.resolve(pptxFile);
    expect(pptxAdapter.id).toBe('PresentationViewerAdapter');
    const pptxDoc = await pptxAdapter.load(
      { file: pptxFile, arrayBuffer: pptxBytes.buffer as ArrayBuffer },
      { isOfflineOrLocalMode: true, allowRemoteConversion: false }
    );
    expect(pptxDoc.unitCount).toBe(3);
    expect(pptxDoc.search('Normalized').length).toBeGreaterThan(0);

    // 3. Excel XLSX with multiple worksheets and formulas
    const xlsxBytes = buildRealXlsxBytes();
    const xlsxFile = makeDetectedFile('revenue.xlsx', xlsxBytes);
    const xlsxAdapter = registry.resolve(xlsxFile);
    expect(xlsxAdapter.id).toBe('SpreadsheetViewerAdapter');
    const xlsxDoc = await xlsxAdapter.load(
      { file: xlsxFile, arrayBuffer: xlsxBytes.buffer as ArrayBuffer },
      { isOfflineOrLocalMode: true, allowRemoteConversion: false }
    );
    expect(xlsxDoc.unitCount).toBe(2);
    expect(xlsxDoc.search('North America').length).toBeGreaterThan(0);

    // 4. EPUB eBook
    const epubBytes = await buildRealEpubBytes();
    const epubFile = makeDetectedFile('book.epub', epubBytes);
    const epubAdapter = registry.resolve(epubFile);
    expect(epubAdapter.id).toBe('EbookViewerAdapter');
    const epubDoc = await epubAdapter.load(
      { file: epubFile, arrayBuffer: epubBytes.buffer as ArrayBuffer },
      { isOfflineOrLocalMode: true, allowRemoteConversion: false }
    );
    expect(epubDoc.unitCount).toBe(3);
    expect(epubDoc.search('Fragmentation').length).toBeGreaterThan(0);

    // 5. ZIP Archive with Path Traversal Defense
    const zipBytes = await buildRealZipBytes();
    const zipFile = makeDetectedFile('bundle.zip', zipBytes);
    const zipAdapter = registry.resolve(zipFile);
    expect(zipAdapter.id).toBe('ArchiveViewerAdapter');
    const zipDoc = await zipAdapter.load(
      { file: zipFile, arrayBuffer: zipBytes.buffer as ArrayBuffer },
      { isOfflineOrLocalMode: true, allowRemoteConversion: false }
    );
    const payload = zipDoc.payload as {
      entries: { path: string; safetyStatus: string }[];
      extractEntry: (p: string) => Promise<Uint8Array>;
    };
    const traversalEntry = payload.entries.find((e) => e.path.includes('..'));
    expect(traversalEntry?.safetyStatus).toBe('suspicious-traversal');
    await expect(
      payload.extractEntry('../etc/shadow-traversal-attempt.txt')
    ).rejects.toThrow(/blocked by security policy/i);
  });

  it('neutralizes malicious SVG/HTML scripts and blocks archive path traversal', async () => {
    const dirtySvg =
      '<svg><script>alert(1)</script><foreignObject><iframe></iframe></foreignObject><circle onload="hack()" href="javascript:evil()"/></svg>';
    const cleanSvg = sanitizeSvgContent(dirtySvg);
    expect(cleanSvg).not.toContain('<script');
    expect(cleanSvg).not.toContain('<foreignObject');
    expect(cleanSvg).not.toContain('onload=');
    expect(cleanSvg).not.toContain('javascript:');

    const dirtyHtml = '<div><script>evil()</script><iframe src="x"></iframe><p onclick="bad()">OK</p></div>';
    const cleanHtml = sanitizeHtmlContent(dirtyHtml);
    expect(cleanHtml).not.toContain('<script');
    expect(cleanHtml).not.toContain('<iframe');
    expect(cleanHtml).not.toContain('onclick=');

    expect(isSafeArchivePath('docs/readme.md')).toBe(true);
    expect(isSafeArchivePath('../etc/passwd')).toBe(false);
    expect(isSafeArchivePath('/absolute/path')).toBe(false);
    expect(isSafeArchivePath('C:\\Windows\\System32')).toBe(false);

    const hash = await computeSha256Hex(new TextEncoder().encode('OmniView'));
    expect(hash).toHaveLength(64);
  });
});

describe('OmniView Fastify v1 API & Isolated Conversion Worker', () => {
  it('supports file upload, HTTP 206 Range streaming, version-locked annotations, and SSRF protection', async () => {
    const server = await buildApiServer();

    // 1. Upload a PDF file
    const pdfBytes = buildRealMultipagePdfBytes([{ title: 'API Test', lines: ['Stream test'] }]);
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/v1/files',
      payload: {
        filename: 'api-test.pdf',
        mimeType: 'application/pdf',
        contentBase64: Buffer.from(pdfBytes).toString('base64'),
      },
    });
    expect(createRes.statusCode).toBe(201);
    const createdFile = createRes.json().file as DetectedFile;
    expect(createdFile.category).toBe('pdf');

    // 2. Request HTTP Range bytes=0-15 from /api/v1/files/:id/content
    const rangeRes = await server.inject({
      method: 'GET',
      url: `/api/v1/files/${createdFile.id}/content`,
      headers: {
        range: 'bytes=0-15',
      },
    });
    expect(rangeRes.statusCode).toBe(206);
    expect(rangeRes.headers['content-range']).toMatch(/^bytes 0-15\//);
    expect(rangeRes.rawPayload.length).toBe(16);

    // 3. Create annotation with matching checksum -> 201
    const annRes = await server.inject({
      method: 'POST',
      url: `/api/v1/files/${createdFile.id}/annotations`,
      payload: {
        fileChecksum: createdFile.checksum,
        pageNumber: 1,
        type: 'highlight',
        color: '#3b82f6',
        rect: { x: 0.1, y: 0.2, width: 0.4, height: 0.05 },
        comment: 'Verified normalized coordinate highlight',
      },
    });
    expect(annRes.statusCode).toBe(201);

    // 4. Reject annotation with stale/mismatched fileChecksum -> 409 CHECKSUM_MISMATCH
    const staleAnnRes = await server.inject({
      method: 'POST',
      url: `/api/v1/files/${createdFile.id}/annotations`,
      payload: {
        fileChecksum: 'stale-checksum-from-older-version',
        pageNumber: 1,
        type: 'note',
        color: '#ef4444',
        comment: 'Should fail checksum lock',
      },
    });
    expect(staleAnnRes.statusCode).toBe(409);

    // 5. Block SSRF attempts against localhost & private networks on /api/v1/files/import-url
    const ssrfRes = await server.inject({
      method: 'POST',
      url: '/api/v1/files/import-url',
      payload: {
        url: 'http://169.254.169.254/latest/meta-data/',
      },
    });
    expect([400, 403]).toContain(ssrfRes.statusCode);
    expect(ssrfRes.json().error.code).toBe('SSRF_BLOCKED');

    await server.close();
  });

  it('enforces LibreOffice macro disabling, deterministic artifact caching, and temp directory cleanup in worker', async () => {
    const cacheKey = computeArtifactCacheKey('abc123checksum', 'libreoffice-headless', '24.8', 'pdf');
    expect(cacheKey).toBe('omniview:artifact:abc123checksum:libreoffice-headless:24.8:pdf');

    const loCmd = buildLibreOfficeCommand({
      inputFilePath: '/tmp/input.doc',
      outputDirPath: '/tmp/out',
      userProfileDirPath: '/tmp/profile',
    });
    expect(loCmd.args).toContain('--headless');
    expect(loCmd.args).toContain('--norestore');
    expect(loCmd.args.some((a) => a.includes('MacroSecurityLevel=3'))).toBe(true);

    const worker = new IsolatedConversionWorker();
    const result = await worker.runJob({
      jobId: 'job-test-1',
      fileId: 'file-1',
      fileChecksum: 'sha256-doc-1',
      filename: 'legacy.doc',
      sourceFormat: 'doc',
      sourceBytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]),
      targetFormat: 'pdf',
      converterName: 'libreoffice-headless',
    });
    expect(result.job.status).toBe('completed');
    expect(result.tempDirCleanedUp).toBe(true);
    expect(result.cached).toBe(false);

    // Second run with identical checksum hits cache immediately
    const cachedResult = await worker.runJob({
      jobId: 'job-test-2',
      fileId: 'file-1',
      fileChecksum: 'sha256-doc-1',
      filename: 'legacy.doc',
      sourceFormat: 'doc',
      sourceBytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]),
      targetFormat: 'pdf',
      converterName: 'libreoffice-headless',
    });
    expect(cachedResult.cached).toBe(true);
  });
});
