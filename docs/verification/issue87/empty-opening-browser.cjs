const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '../../..');
const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:3194').replace(/\/$/, '');
const outputDir = process.env.OUTPUT_DIR || __dirname;
const source = JSON.parse(fs.readFileSync(path.join(repo, 'apps/server/stories/deokil-trading-murder.mstory'), 'utf8'));
const launchOptions = { headless: true };
if (process.env.CHROMIUM_PATH) launchOptions.executablePath = process.env.CHROMIUM_PATH;
if (process.env.PLAYWRIGHT_NO_SANDBOX === '1') launchOptions.args = ['--no-sandbox'];

async function createPublishedEmptyOpening(page) {
  await page.goto(`${baseUrl}/`);
  const guest = await page.evaluate(async () => {
    const response = await fetch('/api/platform/guest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: `CueCheck${crypto.randomUUID().slice(0, 6)}` }),
    });
    return { ok: response.ok, status: response.status };
  });
  assert(guest.ok, `Guest setup failed: ${guest.status}`);

  const packageData = structuredClone(source);
  packageData.content.scenes.find(scene => scene.id === packageData.story.startSceneId).cues = [];
  const saved = await page.evaluate(async pkg => {
    const response = await fetch('/api/workshop/drafts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ package: pkg, published: true, thumbnailUrl: null, difficulty: null }),
    });
    const data = await response.json();
    return { ok: response.ok, status: response.status, id: data.item?.id, error: data.error };
  }, packageData);
  assert(saved.ok, `Published story setup failed: ${saved.status} ${saved.error || ''}`);
  return saved.id;
}

async function checkEmptyOpening(browser, locale, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  try {
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const storyId = await createPublishedEmptyOpening(page);
    await page.goto(`${baseUrl}/${locale === 'en' ? 'en/' : ''}workshop?play=${encodeURIComponent(storyId)}`);
    const startName = locale === 'en' ? 'Start the case' : '사건 시작하기';
    await page.getByRole('button', { name: startName, exact: false }).click();
    await page.getByText(locale === 'en' ? 'This story has no opening narration. You can begin investigating now.' : '시작 장면에 대사가 없어요. 바로 조사할 수 있어요.').waitFor();
    const emptyCueMessage = await page.getByText(locale === 'en' ? 'This story has no opening narration. You can begin investigating now.' : '시작 장면에 대사가 없어요. 바로 조사할 수 있어요.').isVisible();
    const beginName = locale === 'en' ? 'Begin investigation' : '조사 시작하기';
    const begin = page.getByRole('button', { name: beginName, exact: false });
    const canBeginInvestigation = await begin.isEnabled();
    await begin.click();
    const suspectsHeading = locale === 'en' ? 'The suspects' : '등장인물';
    await page.getByRole('heading', { name: suspectsHeading, exact: false }).waitFor();
    const reachedSuspects = await page.getByRole('heading', { name: suspectsHeading, exact: false }).isVisible();
    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    assert(emptyCueMessage && canBeginInvestigation && reachedSuspects && noOverflow);
    assert.deepEqual(pageErrors, []);
    await page.screenshot({ path: path.join(outputDir, `${locale}-${width}-empty-opening.png`), fullPage: true });
    return { locale, width, emptyCueMessage, canBeginInvestigation, reachedSuspects, noOverflow, pageErrors };
  } finally {
    await context.close();
  }
}

(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch(launchOptions);
  try {
    const results = [];
    results.push(await checkEmptyOpening(browser, 'ko', 1440));
    results.push(await checkEmptyOpening(browser, 'en', 375));
    fs.writeFileSync(path.join(outputDir, 'empty-opening-browser-results.json'), JSON.stringify(results, null, 2) + '\n');
    console.log(JSON.stringify(results));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
