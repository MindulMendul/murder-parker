const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = (process.env.BASE_URL || 'http://127.0.0.1:3212').replace(/\/$/, '');
const resultsDir = process.env.RESULTS_DIR || __dirname;
fs.mkdirSync(resultsDir, { recursive: true });
(async () => {
  const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox'] });
  const results = [];
  try {
    const context = await browser.newContext();
    const login = await context.request.post(`${base}/api/platform/guest`, { headers: { Origin: base }, data: { nickname: `카드${Date.now().toString().slice(-6)}` } });
    assert.equal(login.status(), 201);
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    for (const locale of ['ko', 'en']) for (const width of [1440, 768, 375, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${base}/${locale === 'en' ? 'en/' : ''}`);
      await page.getByRole('button', { name: locale === 'en' ? 'Create room' : '방 만들기', exact: false }).first().click();
      const cards = page.locator('.story-picker-grid article'); await cards.first().waitFor();
      assert.equal(await cards.count(), 4);
      assert.equal(await cards.locator('img').count(), 4);
      assert.equal(await cards.locator('button:enabled').count(), 1);
      assert.equal(await cards.locator('button:disabled').count(), 3);
      assert(await page.evaluate(() => [...document.querySelectorAll('.story-picker-grid img')].every(img => img.complete && img.naturalWidth === 640)));
      assert(await page.evaluate(() => {
        const dialog = document.querySelector('dialog');
        return document.documentElement.scrollWidth <= innerWidth && dialog.scrollWidth <= dialog.clientWidth;
      }));
      const available = cards.filter({ has: page.getByRole('heading', { name: '사라진 축제 초대장' }) });
      assert((await available.innerText()).includes(locale === 'en' ? '2 players' : '2명'));
      assert((await available.innerText()).includes(locale === 'en' ? '5 min' : '5분'));
      assert((await cards.first().innerText()).includes(locale === 'en' ? 'Not rated' : '평가 없음'));
      assert(!(await cards.first().innerText()).includes(locale === 'en' ? '0 ratings' : '0 개 평가'));
      await page.screenshot({ path: path.join(resultsDir, `after-${locale}-${width}.png`), fullPage: true });
      results.push({ locale, width, cards: 4, loadedThumbnails: 4, selectableCards: 1, disabledCards: 3, noOverflow: true });
      await page.keyboard.press('Escape');
    }
    // Exercise unusually long public catalog text without adding fake production records.
    await page.route('**/api/lobby/stories?*', async route => {
      const response = await route.fetch(); const data = await response.json();
      data.items[0].averageRating = 4.5; data.items[0].ratingCount = 12;
      data.items[0].title = '아주 긴 작품 제목과 줄바꿈 검증 '.repeat(8);
      data.items[0].subtitle = '소개 문구가 길어도 카드와 선택 버튼이 영역을 벗어나지 않아야 합니다. '.repeat(15);
      await route.fulfill({ response, json: data });
    });
    await page.setViewportSize({ width: 320, height: 900 }); await page.goto(base);
    await page.getByRole('button', { name: '방 만들기', exact: false }).first().click();
    await page.locator('.story-picker-grid h3').first().filter({ hasText: '아주 긴 작품' }).waitFor();
    assert(await page.evaluate(() => { const d = document.querySelector('dialog'); return d.scrollWidth <= d.clientWidth; }));
    assert((await page.locator('.story-picker-grid article').first().innerText()).includes('★ 4.5 / 5'));
    assert((await page.locator('.story-picker-grid article').first().innerText()).includes('12 개 평가'));
    await page.unroute('**/api/lobby/stories?*');
    await page.keyboard.press('Escape'); await page.goto(base);
    await page.getByRole('button', { name: '방 만들기', exact: false }).first().click();
    const available = page.locator('.story-picker-grid article').filter({ has: page.getByRole('heading', { name: '사라진 축제 초대장' }) });
    await available.getByRole('button').click(); await page.getByText('초대 코드', { exact: true }).waitFor();
    const state = await (await context.request.get(`${base}/api/lobby/state`)).json(); assert.equal(state.room.scenario.id, 'rehearsal');
    await page.getByRole('button', { name: '방 나가기', exact: false }).click();
    assert.deepEqual(errors, []);
    results.push({ longTitleAndDescriptionAt320: true, ratedAndUnratedCountDisplay: true, createdRealRoom: true, leftRoom: true, pageErrors: errors });
    fs.writeFileSync(path.join(resultsDir, 'browser-results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results)); await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
