// Renders extension/icons/icon.svg to the PNG sizes Chrome needs.
// Usage: node scripts/make-icons.js   (requires Playwright's Chromium)
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const iconsDir = path.join(__dirname, '..', 'extension', 'icons');

(async () => {
  const svg = await fs.readFile(path.join(iconsDir, 'icon.svg'), 'utf8');
  const browser = await chromium.launch();
  try {
    for (const size of [16, 32, 48, 128]) {
      const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
      await page.setContent(
        `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`
      );
      await page.screenshot({ path: path.join(iconsDir, `icon${size}.png`), omitBackground: true });
      await page.close();
      console.log(`wrote icon${size}.png`);
    }
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
