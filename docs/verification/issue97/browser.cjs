const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { assertDisposableTestTarget } = require('../test-target-guard.cjs');

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:33723';
const browserArgs = process.env.CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [];
const widths = [1440, 1024, 768, 640, 375, 320];
const nickname = `${Date.now().toString(36).slice(-6)}${'N'.repeat(14)}`;
const resultsDir = path.resolve(process.env.RESULTS_DIR || 'docs/verification/issue97');
const selectors = ['.header-navigation a', '#language', '.identity .dot', '.identity-name', '.identity-tag'];

async function waitForStableHeader(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction((required) => {
    const signature = required.map((selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return [rect.left, rect.top, rect.width, rect.height].map((value) => value.toFixed(2)).join(',');
    });
    if (signature.some((box) => box === null)) return false;
    const serialized = JSON.stringify(signature);
    const state = window.__issue97StableHeader || { signature: null, frames: 0 };
    state.frames = serialized === state.signature ? state.frames + 1 : 0;
    state.signature = serialized;
    window.__issue97StableHeader = state;
    return state.frames >= 2;
  }, selectors, { polling: 'raf', timeout: 5000 });
}

(async () => {
  assertDisposableTestTarget(baseUrl);
  const browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    headless: true,
    args: browserArgs,
  });
  const pageErrors = [];
  try {
    const context = await browser.newContext();
    const loginPage = await context.newPage();
    await loginPage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    const login = await loginPage.evaluate(async (name) => {
      const response = await fetch('/api/platform/guest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nickname: name }),
      });
      return { status: response.status, body: await response.json() };
    }, nickname);
    assert.equal(login.status, 201, JSON.stringify(login));
    await loginPage.close();

    const localeRuns = await Promise.all(['ko', 'en'].map(async (locale) => {
      const pathForLocale = locale === 'en' ? '/en/' : '/';
      const pageRuns = await Promise.all(widths.map(async (width) => {
        const page = await context.newPage();
        page.on('pageerror', (error) => pageErrors.push(String(error)));
        await page.setViewportSize({ width, height: 900 });
        await page.goto(new URL(pathForLocale, baseUrl).toString(), { waitUntil: 'domcontentloaded' });
        await page.locator('.identity-name').waitFor();
        await waitForStableHeader(page);
        const measured = await page.evaluate((required) => {
          const boxes = Object.fromEntries(required.map((selector) => {
            const node = document.querySelector(selector);
            if (!node) return [selector, null];
            const rect = node.getBoundingClientRect();
            return [selector, { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, centerY: rect.top + rect.height / 2 }];
          }));
          const entries = Object.values(boxes).filter(Boolean);
          const withinViewport = entries.every((rect) => rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight);
          const noOverlap = entries.every((a, index) => entries.slice(index + 1).every((b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top));
          const identityCenters = ['.identity .dot', '.identity-name', '.identity-tag'].map((selector) => boxes[selector]?.centerY).filter(Number.isFinite);
          const verticalCenterDelta = Math.max(...identityCenters) - Math.min(...identityCenters);
          return {
            scrollWidth: document.documentElement.scrollWidth,
            viewportWidth: innerWidth,
            withinViewport,
            noOverlap,
            verticalCenterDelta,
            nickname: document.querySelector('.identity-name')?.textContent.trim(),
            accountTag: document.querySelector('.identity-tag')?.textContent.trim(),
            language: document.documentElement.lang,
            workshopHref: document.querySelector('.header-navigation a')?.getAttribute('href'),
            boxes,
          };
        }, selectors);
        const noOverflow = measured.scrollWidth <= width;
        const result = { locale, width, ...measured, noOverflow };
        assert.ok(noOverflow, `${locale}/${width}: document overflow ${measured.scrollWidth}`);
        assert.ok(measured.withinViewport, `${locale}/${width}: header item outside viewport`);
        assert.ok(measured.noOverlap, `${locale}/${width}: header items overlap`);
        assert.ok(measured.verticalCenterDelta <= 4, `${locale}/${width}: identity alignment ${measured.verticalCenterDelta}px`);
        assert.equal(measured.nickname, nickname);
        assert.equal(measured.accountTag, 'GUEST');
        assert.equal(measured.language, locale);
        assert.ok(measured.workshopHref.includes(locale === 'en' ? '/en/workshop' : '/workshop'));

        if (width === 320 || width === 1440) {
          await fs.mkdir(resultsDir, { recursive: true });
          await page.screenshot({ path: path.join(resultsDir, `after-${locale}-${width}.png`), fullPage: true });
        }
        return { page, result };
      }));

      const functionalPage = pageRuns.find(({ result }) => result.width === 320).page;
      const alternate = locale === 'en' ? 'ko' : 'en';
      await functionalPage.locator('#language').selectOption(alternate);
      await functionalPage.waitForFunction((value) => document.documentElement.lang === value, alternate);
      await waitForStableHeader(functionalPage);
      const alternateHref = await functionalPage.locator('.header-navigation a').getAttribute('href');
      assert.ok(alternateHref.includes(alternate === 'en' ? '/en/workshop' : '/workshop'));
      await functionalPage.locator('#language').selectOption(locale);
      await functionalPage.waitForFunction((value) => document.documentElement.lang === value, locale);
      await waitForStableHeader(functionalPage);
      await functionalPage.locator('.header-navigation a').click();
      await functionalPage.waitForFunction((value) => location.pathname.replace(/\/$/, '') === value, locale === 'en' ? '/en/workshop' : '/workshop');
      await Promise.all(pageRuns.map(({ page }) => page.close()));
      return pageRuns.map(({ result }) => result);
    }));

    assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
    const results = localeRuns.flat();
    const output = {
      testedBase: process.env.TESTED_BASE_COMMIT || null,
      testedCodeCommit: process.env.TESTED_CODE_COMMIT || null,
      widths,
      locales: ['ko', 'en'],
      nicknameLength: nickname.length,
      pageErrors: 0,
      results,
    };
    await fs.writeFile(path.join(resultsDir, 'browser-results.json'), `${JSON.stringify(output, null, 2)}\n`);
    console.log(JSON.stringify({ locales: output.locales, widths: output.widths, cases: results.length, pageErrors: output.pageErrors, screenshots: ['after-ko-320.png', 'after-ko-1440.png', 'after-en-320.png', 'after-en-1440.png'] }, null, 2));
    await context.close();
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
