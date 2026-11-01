export const OMNIVIEW_CONFIG = {
  appName: 'OmniView',
  appVersion: '1.0.0',
  apiVersion: 'v1',
  limits: {
    maxFileSizeBytes: 500 * 1024 * 1024, // 500 MB
    maxArchiveEntries: 10000,
    maxArchiveUncompressedBytes: 1024 * 1024 * 1024, // 1 GB decompression bomb threshold
    maxCompressionRatio: 100, // Zip bomb ratio detection
    maxSpreadsheetInitialRows: 50000,
    maxCodeDirectRenderBytes: 25 * 1024 * 1024, // 25 MB
    conversionTimeoutMs: 60000, // 60s conversion worker timeout
  },
  security: {
    allowLocalEnvFilesOnly: true,
    disableExcelMacros: true,
    sanitizeSvgScripts: true,
    sanitizeHtmlScripts: true,
    blockPrivateNetworkUrlImports: true,
  },
} as const;
