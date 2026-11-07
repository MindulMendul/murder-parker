const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:3170';
const resultsPath = process.env.RESULTS_PATH || 'docs/verification/issue70/browser-results.json';
const executablePath = process.env.CHROMIUM_PATH;
const launchOptions = { headless: true };

if (executablePath) launchOptions.executablePath = executablePath;
if (process.env.PLAYWRIGHT_NO_SANDBOX === '1') launchOptions.args = ['--no-sandbox'];

async function verifyViewport(browser, locale, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const localePath = locale === 'en' ? '/en/' : '/';
    await page.goto(new URL(`${localePath}workshop`, baseUrl).toString());

    const disclosure = page.locator('.filter-disclosure');
    await disclosure.waitFor();
    const initiallyClosed = (await disclosure.getAttribute('open')) === null;
    assert(initiallyClosed);

    const summary = disclosure.locator('summary');
    await summary.focus();
    await page.keyboard.press('Enter');
    const filters = page.locator('.workshop-filters');
    await filters.waitFor({ state: 'visible' });
    const enterOpens = (await disclosure.getAttribute('open')) !== null;
    assert(enterOpens);

    const search = filters.locator('input[type="search"]').first();
    await search.fill(`no-results-${locale}-${width}`);
    await page.waitForTimeout(400);
    const activeFilterCount = await page.locator('.filter-count').innerText();
    assert.equal(activeFilterCount, '1');

    await summary.focus();
    await page.keyboard.press('Space');
    const spaceCloses = (await disclosure.getAttribute('open')) === null;
    assert(spaceCloses);
    await summary.click();
    const conditionPreserved = (await search.inputValue()) === `no-results-${locale}-${width}`;
    assert(conditionPreserved);

    const resetLabel = locale === 'en' ? 'Reset filters' : '필터 초기화';
    await page.getByRole('button', { name: resetLabel, exact: true }).click();
    await page.waitForTimeout(400);
    const resetClearsSearch = (await search.inputValue()) === '';
    const resetClearsCount = (await page.locator('.filter-count').count()) === 0;
    assert(resetClearsSearch && resetClearsCount);

    await summary.click();
    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    assert(noOverflow);
    await page.screenshot({ path: `docs/verification/issue70/${locale}-${width}-collapsed.png`, fullPage: true });
    await summary.click();
    await page.screenshot({ path: `docs/verification/issue70/${locale}-${width}-expanded.png`, fullPage: true });
    assert.deepEqual(errors, []);

    return {
      locale,
      width,
      initiallyClosed,
      enterOpens,
      spaceCloses,
      conditionPreserved,
      resetClearsSearch,
      resetClearsCount,
      noOverflow,
      pageErrors: errors,
    };
  } finally {
    await context.close();
  }
}

async function main() {
  const browser = await chromium.launch(launchOptions);
  try {
    const results = [];
    for (const locale of ['ko', 'en']) {
      for (const width of [1440, 768, 375, 320]) {
        results.push(await verifyViewport(browser, locale, width));
      }
    }
    fs.writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
    console.log(JSON.stringify(results));
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
