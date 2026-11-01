import { test, expect, type Page } from '@playwright/test';

/** Holds the mouse on a library card until the convert circle opens. */
async function holdFile(page: Page, name: string) {
  const card = page.getByTestId(`library-file-${name}`);
  await card.scrollIntoViewIfNeeded();
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.getByRole('menu', { name: `Convert ${name}` })).toBeVisible({ timeout: 3000 });
  await page.waitForTimeout(450); // let the zones finish fanning out
}

/** Drags from the held position onto a zone and lets go. */
async function dropOn(page: Page, zoneLabel: string) {
  const zone = page.locator(`button[data-zone][aria-label="${zoneLabel}"]`);
  const box = (await zone.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
}

test.describe('Long-press convert circle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('omniview-app-shell')).toBeVisible();
    await page.getByTestId('nav-library').click();
  });

  test('hold, drag to a format, release: result lands next to the original', async ({ page }) => {
    await holdFile(page, 'Vector_Pipeline_Sanitized.svg');
    await page.screenshot({ path: 'test-results/convert-circle.png' });
    await dropOn(page, 'Convert to PNG');
    await expect(page.getByText('Saved Vector_Pipeline_Sanitized.png')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('library-file-Vector_Pipeline_Sanitized.png')).toBeVisible();
    // The release that ended the long press must not have opened the original.
    await expect(page.getByTestId('pdf-viewer-root')).toHaveCount(0);
    await expect(page.getByTestId('library-file-Vector_Pipeline_Sanitized.svg')).toBeVisible();
  });

  test('release on empty space keeps the circle open for tap selection', async ({ page }) => {
    await holdFile(page, 'Global_Revenue_Workbook.xlsx');
    await page.mouse.up();
    const zone = page.locator('button[data-zone][aria-label="Convert to CSV"]');
    await expect(zone).toBeEnabled();
    await zone.click();
    await expect(page.getByText('Saved Global_Revenue_Workbook.csv')).toBeVisible({ timeout: 15000 });
  });

  test('Escape closes the circle without converting', async ({ page }) => {
    await holdFile(page, 'Release_Bundle_Inspect.zip');
    await page.mouse.up();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: /Convert/ })).toHaveCount(0);
  });

  test('docx -> pdf, zip -> tar.gz', async ({ page }) => {
    await holdFile(page, 'Security_Engineering_Standard.docx');
    await dropOn(page, 'Convert to PDF');
    await expect(page.getByText('Saved Security_Engineering_Standard.pdf')).toBeVisible({ timeout: 15000 });

    await holdFile(page, 'Release_Bundle_Inspect.zip');
    await dropOn(page, 'Convert to TAR.GZ');
    await expect(page.getByText('Saved Release_Bundle_Inspect.tgz')).toBeVisible({ timeout: 15000 });
  });

  test('pdf compress reports a result or an honest refusal', async ({ page }) => {
    await holdFile(page, 'OmniView_Architecture_Spec.pdf');
    await dropOn(page, 'Compress, Balanced');
    await expect(page.getByText(/Saved OmniView_Architecture_Spec \(compressed\)\.pdf|Already as small/)).toBeVisible({ timeout: 30000 });
  });

  test('wav -> mp3 runs FFmpeg WebAssembly fully on-device', async ({ page }) => {
    test.setTimeout(150000);
    const external: string[] = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (!['localhost', '127.0.0.1'].includes(u.hostname) && !u.protocol.startsWith('data') && !u.protocol.startsWith('blob')) external.push(r.url());
    });
    await holdFile(page, 'Acoustic_Harmonic_Test.wav');
    await dropOn(page, 'Convert to MP3');
    await expect(page.getByText('Saved Acoustic_Harmonic_Test.mp3')).toBeVisible({ timeout: 120000 });
    expect(external.filter((u) => /ffmpeg|unpkg|jsdelivr|cdn/i.test(u))).toEqual([]);
  });
});
