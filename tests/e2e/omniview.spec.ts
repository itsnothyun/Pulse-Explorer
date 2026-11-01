import { test, expect } from '@playwright/test';

test.describe('OmniView End-to-End Universal Document Viewer Journeys', () => {
  test('executes full multi-format viewing, search, worksheet switching, tab state persistence, and fallback error state', async ({
    page,
  }) => {
    // 1. Open the application
    await page.goto('/');
    await expect(page.getByTestId('omniview-app-shell')).toBeVisible();

    // The workspace starts on the dashboard with nothing open; open samples from the library.
    await expect(page.getByTestId('dashboard-view')).toBeVisible();
    for (const name of ['Global_Revenue_Workbook.xlsx', 'Q4_Enterprise_Deck.pptx', 'OmniView_Architecture_Spec.pdf']) {
      await page.getByTestId('nav-library').click();
      await page.getByTestId(`library-file-${name}`).click();
    }

    // 2 & 3. Confirm the PDF is open and actual pages render
    await expect(page.getByTestId('pdf-viewer-root')).toBeVisible();
    await expect(page.getByTestId('pdf-page-1')).toBeVisible();
    await expect(page.getByTestId('pdf-page-1')).toContainText(
      'Universal Document Viewer Architecture'
    );

    // 4. Navigate to another page using thumbnail or toolbar
    await page.getByTestId('pdf-thumbnail-2').click();
    await expect(page.getByTestId('toolbar-page-input')).toHaveValue('2');

    // Zoom in on PDF tab (to 115%) so we can verify tab state persistence later
    await page.getByTestId('toolbar-zoom-in').click();
    await expect(page.getByTestId('toolbar-zoom-value')).toHaveText('115%');

    // 5. Search the PDF and confirm match count indicator
    const searchInput = page.getByTestId('in-document-search-input');
    await searchInput.fill('Normalized');
    await expect(page.getByTestId('in-document-match-count')).toHaveText(/^[1-9]\d*\/[1-9]\d*$/);

    // 6 & 7. Switch to the PowerPoint presentation tab and confirm slides render
    await page.getByTestId('file-tab-Q4_Enterprise_Deck.pptx').click();
    await expect(page.getByTestId('presentation-viewer-root')).toBeVisible();
    await expect(page.getByTestId('slide-stage-1')).toContainText(
      'OmniView Q4 Enterprise Architecture Review'
    );
    await page.getByTestId('slide-next-btn').click();
    await expect(page.getByTestId('slide-stage-2')).toContainText(
      'Plugin-Based ViewerAdapter Pipeline'
    );

    // 8 & 9. Open the Excel workbook tab and switch between worksheets
    await page.getByTestId('file-tab-Global_Revenue_Workbook.xlsx').click();
    await expect(page.getByTestId('spreadsheet-viewer-root')).toBeVisible();
    await expect(page.getByTestId('spreadsheet-viewer-root')).toContainText('North America');
    await page.getByTestId('worksheet-tab-Adapter_Telemetry_250').click();
    await expect(page.getByTestId('spreadsheet-viewer-root')).toContainText('JOB-1001');

    // 10 & 11. Switch back to the PDF tab and verify it preserved its zoom (115%) and search query
    await page.getByTestId('file-tab-OmniView_Architecture_Spec.pdf').click();
    await expect(page.getByTestId('toolbar-zoom-value')).toHaveText('115%');
    await expect(page.getByTestId('in-document-search-input')).toHaveValue('Normalized');

    // 12 & 13. Close a tab and restore it using Restore Tab
    await page.getByTestId('close-tab-Q4_Enterprise_Deck.pptx').click();
    await expect(page.getByTestId('file-tab-Q4_Enterprise_Deck.pptx')).toHaveCount(0);
    await page.getByTestId('restore-closed-tab-btn').click();
    await expect(page.getByTestId('file-tab-Q4_Enterprise_Deck.pptx')).toBeVisible();

    // 14 & 15. Attempt an unsupported binary format (.dwg) and confirm helpful FallbackViewer appears
    const fileInput = page.getByTestId('global-file-input');
    await fileInput.setInputFiles({
      name: 'proprietary-model.dwg',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from([0x41, 0x43, 0x31, 0x30, 0x33, 0x32, 0x00, 0xff, 0x1a, 0x2b]),
    });
    await expect(page.getByTestId('fallback-viewer-root')).toBeVisible();
    await expect(page.getByTestId('fallback-viewer-root')).toContainText(
      'Native Browser Preview Unavailable — Diagnostic Inspector Active'
    );
    await expect(page.getByTestId('fallback-viewer-root')).toContainText('proprietary-model.dwg');
  });
});
