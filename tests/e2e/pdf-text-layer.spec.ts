import { test, expect } from '@playwright/test';

test.describe('PDF viewer text layer', () => {
  test('shows only the page, with invisible selectable text and visible search hits', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('nav-library').click();
    await page.getByTestId('library-file-OmniView_Architecture_Spec.pdf').click();

    const pdfPage = page.getByTestId('pdf-page-1');
    await expect(pdfPage).toBeVisible();
    // The text is still in the DOM for copy, search and screen readers...
    await expect(pdfPage).toContainText('Universal Document Viewer Architecture');

    // ...but it is not drawn as a second copy under the page.
    await expect(pdfPage.getByText(/PDF Page 1 •/)).toHaveCount(0);
    const span = pdfPage.locator('.pdf-text-layer span').first();
    await expect(span).toBeAttached();
    expect(await span.evaluate((el) => getComputedStyle(el).color)).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    const page1 = await pdfPage.boundingBox();
    expect(page1!.height).toBeLessThan(page1!.width * 1.6); // a page, not a page plus a text dump

    await page.screenshot({ path: 'test-results/pdf-page.png' });

    // Search tints the matching runs.
    await page.getByTestId('in-document-search-input').fill('Normalized');
    await expect(pdfPage.locator('.pdf-hit').first()).toBeAttached({ timeout: 5000 });
  });

  test('bookmark still works from the page corner', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('nav-library').click();
    await page.getByTestId('library-file-OmniView_Architecture_Spec.pdf').click();
    const pdfPage = page.getByTestId('pdf-page-1');
    await pdfPage.hover();
    await pdfPage.getByRole('button', { name: 'Bookmark page 1' }).click();
    await expect(pdfPage.getByRole('button', { name: 'Remove bookmark from page 1' })).toBeVisible();
  });
});
