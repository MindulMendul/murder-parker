const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertDisposableTestTarget } = require('../test-target-guard.cjs');

const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:3210').replace(/\/$/, '');
const resultsPath = process.env.RESULTS_PATH || '.codex-results/issue110-browser';
const executablePath = process.env.CHROMIUM_PATH;
const labels = {
  ko: { create: '방 만들기', close: '작품 선택 닫기', modes: '게임 모드' },
  en: { create: 'Create room', close: 'Close story picker', modes: 'Game modes' },
};

function storySection(page) {
  return page.locator('section[aria-labelledby="lobby-stories-title"]');
}

function storyCard(page, title) {
  return storySection(page).locator('article').filter({
    has: page.getByRole('heading', { name: title, exact: true }),
  });
}

function state(page) {
  return page.evaluate(() => fetch('/api/lobby/state').then(response => response.json()));
}

async function signIn(page, locale = 'ko') {
  await page.goto(`${baseUrl}/${locale === 'en' ? 'en/' : ''}`);
  await page.evaluate(async () => {
    const response = await fetch('/api/platform/guest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: `test${crypto.randomUUID().slice(0, 6)}` }),
    });
    if (!response.ok) throw new Error('Guest sign-in failed');
  });
  await page.reload();
  await storySection(page).waitFor();
}

async function checkCodeEditing(page) {
  const details = page.locator('main details');
  await details.locator('summary').click();
  const input = page.locator('#code');
  await input.fill('ABC');
  assert(await details.locator('form button').isDisabled());
  await input.fill('');
  assert.equal(await details.getAttribute('open'), '');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'code');
  await input.fill('ABCDEF');
  assert(await details.locator('form button').isEnabled());
}

async function checkRoomControls(page, scenarios, label) {
  const top = page.getByRole('button', { name: label.create, exact: true });
  assert((await top.boundingBox()).width < 210);
  await top.click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: label.close }).click();

  const available = scenarios.find(story => story.available);
  await storyCard(page, available.title).getByRole('button').click();
  await page.getByText('ROOM DETAILS', { exact: true }).waitFor();
  await page.getByRole('button', { name: '방 나가기 ↗', exact: true }).click();
  await storySection(page).waitFor();
  await Promise.all(scenarios.filter(story => !story.available).map(async story => {
    assert(await storyCard(page, story.title).getByRole('button').isDisabled());
  }));
  await checkCodeEditing(page);
}

async function checkLayout(browser, locale, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await signIn(page, locale);
    const snapshot = await state(page);
    const stories = storySection(page);
    assert.equal(await stories.locator('article').count(), snapshot.scenarios.length);
    assert.deepEqual(await stories.locator('h3').allTextContents(), snapshot.scenarios.map(story => story.title));
    const bounds = await stories.locator('article').first().boundingBox();
    assert(bounds.y < 360, `Cards too low: ${bounds.y}`);
    assert.equal(await page.getByText('PLAY SPACE', { exact: true }).count(), 0);
    assert.equal(await page.getByText(labels[locale].modes, { exact: true }).count(), 0);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(resultsPath, `after-${locale}-${width}.png`), fullPage: true });
    await checkRoomControls(page, snapshot.scenarios, labels[locale]);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    return {
      locale, width, realCards: snapshot.scenarios.length, firstCardTop: bounds.y,
      compactCreateButton: true, pickerOpenClose: true, cardRoomCreateAndLeave: true,
      unavailableDisabled: true, codeValidation: true, clearedCodeKeepsFormAndFocus: true,
      noOverflow: true, pageErrors: errors,
    };
  } finally {
    await context.close();
  }
}

async function checkInviteHistory(guest, code) {
  await guest.goto(`${baseUrl}/?room=${code}`);
  await storySection(guest).waitFor();
  assert.equal(await guest.locator('#code').inputValue(), code);
  assert.equal(await guest.locator('main details').getAttribute('open'), '');
  await guest.locator('main details form button').click();
  await guest.getByText('ROOM DETAILS', { exact: true }).waitFor();
  const joined = await state(guest);
  assert.equal(joined.room.code, code);
  assert.equal(joined.room.count, 2);
  await guest.getByRole('button', { name: '방 나가기 ↗', exact: true }).click();
  await storySection(guest).waitFor();
  assert.equal(await guest.locator('#code').inputValue(), '');

  await guest.getByRole('button', { name: labels.ko.create, exact: true }).click();
  await guest.getByRole('dialog').getByRole('button', { name: '작품 둘러보기 ↗', exact: true }).click();
  await guest.waitForURL(`${baseUrl}/workshop`);
  await guest.goBack();
  await storySection(guest).waitFor();
  assert.equal(await guest.locator('#code').inputValue(), code);
  assert.equal(await guest.locator('main details').getAttribute('open'), '');
  await guest.locator('#code').fill('');
  assert.equal(await guest.locator('main details').getAttribute('open'), '');
  assert.equal(await guest.evaluate(() => document.activeElement.id), 'code');
}

async function checkInviteJoin(browser) {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const [host, guest] = await Promise.all(contexts.map(context => context.newPage()));
    await Promise.all([signIn(host), signIn(guest)]);
    const snapshot = await state(host);
    const available = snapshot.scenarios.find(story => story.available);
    await storyCard(host, available.title).getByRole('button').click();
    await host.getByText('ROOM DETAILS', { exact: true }).waitFor();
    const hosted = await state(host);
    await checkInviteHistory(guest, hosted.room.code);
    await host.getByRole('button', { name: '방 나가기 ↗', exact: true }).click();
    return { inviteCodeJoin: true, inviteHistoryRestoresCodeAndForm: true, twoActualGuests: true };
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
}

async function main() {
  assertDisposableTestTarget(baseUrl);
  fs.mkdirSync(resultsPath, { recursive: true });
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const cases = ['ko', 'en'].flatMap(locale => [1440, 768, 375, 320].map(width => ({ locale, width })));
    const results = [];
    // Keep complete user flows sequential so rooms from another case cannot affect them.
    await cases.reduce((previous, testCase) => previous.then(async () => {
      results.push(await checkLayout(browser, testCase.locale, testCase.width));
    }), Promise.resolve());
    results.push(await checkInviteJoin(browser));
    fs.writeFileSync(path.join(resultsPath, 'browser-results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results));
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
