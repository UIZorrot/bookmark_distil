import { test, expect, chromium } from '@playwright/test';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const extensionPath = path.join(rootDir, 'dist');
const extensionArgPath = extensionPath.replace(/\\/g, '/');
const zhihuFixturePath = path.join(rootDir, 'example.html');
const zhihuCollectionId = '782964767';
const zhihuCollectionUrl = `https://www.zhihu.com/collection/${zhihuCollectionId}`;

async function waitForExtensionId(
  page: import('@playwright/test').Page,
  context: import('@playwright/test').BrowserContext
) {
  for (let i = 0; i < 100; i++) {
    const idFromContentScript = await page.evaluate(() =>
      document.documentElement.getAttribute('data-bookmark-distil-extension-id')
    );
    if (idFromContentScript) return idFromContentScript;

    const sw = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
    if (sw) return new URL(sw.url()).host;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Extension id not detected from content script or service worker.');
}

test('smoke: load extension, crawl mocked Zhihu collection, persist results', async ({ browserName: _browserName }, testInfo) => {
  test.setTimeout(90_000);
  void _browserName;
  const userDataDir = testInfo.outputPath('user-data');

  const launchArgs = [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    `--disable-extensions-except=${extensionArgPath}`,
    `--load-extension=${extensionArgPath}`,
  ];

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: launchArgs,
  });

  const attachDialogHandler = (p: import('@playwright/test').Page) => {
    p.on('dialog', async (d) => {
      await d.accept();
    });
  };

  for (const p of context.pages()) attachDialogHandler(p);
  context.on('page', attachDialogHandler);

  const zhihuFixtureHtml = await fs.readFile(zhihuFixturePath, 'utf8');
  await context.route(new RegExp(`https://www\\.zhihu\\.com/collection/${zhihuCollectionId}(\\?.*)?$`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: zhihuFixtureHtml,
    });
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(zhihuCollectionUrl, { waitUntil: 'domcontentloaded' });
  console.log('e2e: fixture collection page loaded');
  const extensionId = await waitForExtensionId(page, context);
  console.log('e2e: extension id detected', extensionId);
  const popup = await context.newPage();
  popup.setDefaultTimeout(10_000);
  attachDialogHandler(popup);

  await popup.goto(`chrome-extension://${extensionId}/index.html`, { waitUntil: 'domcontentloaded' });
  console.log('e2e: app page loaded');

  await popup.getByRole('button', { name: /Overview|概览/ }).click();
  await popup.getByPlaceholder(/Zhihu collection|知乎收藏夹/).fill(zhihuCollectionUrl);
  await popup.getByRole('button', { name: /Start crawling|开始抓取/ }).click();
  console.log('e2e: crawl requested from app');

  await expect.poll(async () => {
    return await popup.evaluate(async (collectionId) => {
      const data = await chrome.storage.local.get(['collections']);
      const col = data.collections?.[`zhihu:collection:${collectionId}`];
      return typeof col?.lastUpdated === 'number';
    }, zhihuCollectionId);
  }, { timeout: 60_000 }).toBe(true);

  await context.close();
});
