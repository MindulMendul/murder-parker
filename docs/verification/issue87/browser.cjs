const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const base = process.env.BASE_URL || 'http://127.0.0.1:3287';
const output = process.env.OUTPUT_DIR || 'docs/verification/issue87';
const sequential = (items, action) => items.reduce((previous, item) => previous.then(() => action(item)), Promise.resolve());
const screenshot = (page, name) => page.screenshot({ path: path.join(output, name), fullPage: true });
const draft = (source, published) => ({ package: source, published, thumbnailUrl: null, difficulty: 'normal' });

async function publish(author, source) {
  const response = await author.request.post(base + '/api/workshop/drafts', { data: draft(source, true) });
  assert.equal(response.status(), 201);
  return (await response.json()).item.id;
}

async function openStory(page, title, english = false) {
  const card = page.locator('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await card.getByRole('button', { name: english ? 'Details' : '자세히 보기', exact: true }).click();
  await page.getByRole('button', { name: english ? 'Play story' : '플레이하기', exact: false }).click();
}

async function inspectLocation(page, mechanics, location) {
  await page.locator('button').filter({ has: page.getByRole('heading', { name: location.name, exact: true }) }).click();
  await sequential(location.evidenceIds, async evidenceId => {
    const evidence = mechanics.evidence.find(item => item.id === evidenceId);
    await page.locator('aside').getByRole('button', { name: new RegExp(evidence.name) }).click();
    await page.getByText(evidence.detail, { exact: true }).waitFor();
  });
}

async function completeInvestigation(page, mechanics) {
  await sequential(mechanics.locations, location => inspectLocation(page, mechanics, location));
  await page.getByRole('button', { name: '1차 검증으로', exact: false }).click();
  await page.getByRole('button', { name: '증거 제시', exact: false }).click();
  await page.getByRole('button', { name: '범인을 지목하라', exact: false }).click();
  const culprit = mechanics.suspects.find(suspect => suspect.id === mechanics.solution.culpritId);
  await page.locator('button').filter({ has: page.getByRole('heading', { name: culprit.name, exact: true }) }).click();
  await sequential(mechanics.solution.requiredEvidenceIds.slice(0, 3), async evidenceId => {
    const evidence = mechanics.evidence.find(item => item.id === evidenceId);
    await page.locator('aside').getByRole('button', { name: new RegExp(evidence.name) }).click();
  });
  await page.getByRole('button', { name: '체포한다', exact: false }).click();
  await page.getByRole('heading', { name: '사건 종결', exact: true }).waitFor();
}

async function verifyPinnedDesktop(page, author, source, id, suffix) {
  await page.goto(base + '/workshop');
  const card = page.locator('article').filter({ has: page.getByRole('heading', { name: source.story.title, exact: true }) });
  await card.getByRole('button', { name: '자세히 보기', exact: true }).click();
  await screenshot(page, 'desktop-play-entry.png');
  await page.getByRole('button', { name: '플레이하기', exact: false }).click();
  await page.getByRole('heading', { name: source.story.title, exact: true }).waitFor();
  const response = page.waitForResponse(item => item.url() === base + '/api/game/sessions' && item.request().method() === 'POST');
  await page.getByRole('button', { name: '사건 시작하기', exact: false }).click();
  const started = await (await response).json();
  assert.equal(started.package.story.id, id);
  for (const forbidden of ['"solution"', '"revealsTruth"', '"scenes"', '"information"', '"resolution"']) {
    assert(!JSON.stringify(started).includes(forbidden));
  }
  await page.getByText('버전 1의 시작 장면', { exact: true }).waitFor();
  source.story.title = '수정된 버전 2 작품 ' + suffix;
  source.story.version = 2;
  source.content.scenes[0].cues = [{ type: 'dialogue.show', text: '버전 2의 새 장면' }];
  assert.equal((await author.request.put(base + '/api/workshop/drafts/' + id, { data: draft(source, false) })).status(), 200);
  assert.equal((await author.request.post(base + '/api/game/sessions', { data: { storyId: id } })).status(), 400);
  assert.equal((await author.request.get(base + '/api/game/stories/' + id)).status(), 404);
  await page.getByRole('button', { name: '장면 건너뛰기', exact: false }).click();
  await page.getByRole('button', { name: '현장 조사', exact: false }).click();
  await completeInvestigation(page, source.content.mechanics);
  const rejectedReplay = page.waitForResponse(item => item.url() === base + '/api/game/sessions' && item.request().method() === 'POST');
  await page.getByRole('button', { name: '다시 플레이하기', exact: false }).click();
  assert.equal((await rejectedReplay).status(), 400);
  await page.getByRole('heading', { name: '사건 종결', exact: true }).waitFor();
  await page.getByRole('button', { name: '5점', exact: true }).click();
  await page.getByText('평점을 저장했어. 고마워!', { exact: true }).waitFor();
  assert.equal((await author.request.put(base + '/api/workshop/drafts/' + id, { data: draft(source, true) })).status(), 200);
  await page.getByRole('button', { name: '창작마당으로 돌아가기', exact: true }).click();
  const meta = await (await page.request.get(base + '/api/workshop/stories/' + id)).json();
  assert.equal(meta.item.playCount, 1);
  assert.equal(meta.item.ratingCount, 1);
  assert.equal(meta.item.averageRating, 5);
  const official = await (await page.request.get(base + '/api/workshop/stories/deokil-trading-murder')).json();
  assert.equal(official.item.playCount, 0);
}

async function verifyNavigation(page, source, id) {
  await openStory(page, source.story.title);
  assert.equal(new URL(page.url()).searchParams.get('play'), id);
  await page.getByRole('button', { name: '사건 시작하기', exact: false }).click();
  await page.getByText('버전 2의 새 장면', { exact: true }).waitFor();
  await page.goBack();
  await page.getByRole('heading', { name: '창작마당', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('play'), null);
  await page.goForward();
  await page.getByRole('heading', { name: source.story.title, exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('play'), id);
  await page.getByRole('button', { name: '사건 시작하기', exact: false }).click();
  await page.getByText('버전 2의 새 장면', { exact: true }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: source.story.title, exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('play'), id);
  assert(await page.getByRole('button', { name: '사건 시작하기', exact: false }).isEnabled());
}

async function verifyMobile(page, source) {
  await page.goto(base + '/en/workshop');
  await openStory(page, source.story.title, true);
  await page.getByRole('heading', { name: source.story.title, exact: true }).waitFor();
  await page.getByRole('button', { name: 'Start the case', exact: false }).click();
  await page.getByText('버전 2의 새 장면', { exact: true }).waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await screenshot(page, 'mobile-opening.png');
  await page.getByRole('button', { name: '장면 건너뛰기', exact: false }).click();
  await page.getByRole('button', { name: 'Investigate the scene', exact: false }).click();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await screenshot(page, 'mobile-investigation.png');
}

async function verifyUnsupported(page, author, source, suffix) {
  source.story.title = '지원하지 않는 분기 검증 ' + suffix;
  source.content.scenes.push({ id: 'extra-ending', cues: [], choices: [] });
  await publish(author, source);
  await page.goto(base + '/workshop');
  await openStory(page, source.story.title);
  await page.getByRole('alert').filter({ hasText: '지원하지 않는 진행 방식' }).waitFor();
  assert(await page.getByRole('button', { name: '사건 시작하기', exact: false }).isDisabled());
}

async function verifyRoomGuard(browser, storyId, suffix) {
  const context = await browser.newContext({ extraHTTPHeaders: { Origin: base } });
  try {
    const login = await context.request.post(base + '/api/platform/guest', { data: { nickname: '방검증' + String(suffix).slice(-6) } });
    assert.equal(login.status(), 201);
    const room = await context.request.post(base + '/api/lobby/rooms', { data: { scenarioId: 'rehearsal' } });
    assert.equal(room.status(), 201);
    const page = await context.newPage();
    await page.goto(base + '/workshop?play=' + encodeURIComponent(storyId));
    await page.getByRole('status').filter({ hasText: '참가 중인 방에서 나온 뒤' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '사건 시작하기', exact: false }).count(), 0);
  } finally { await context.close(); }
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true, args: ['--no-sandbox'] });
  try {
    const author = await browser.newContext({ extraHTTPHeaders: { Origin: base } });
    const source = JSON.parse(fs.readFileSync('apps/server/stories/deokil-trading-murder.mstory', 'utf8'));
    const suffix = Date.now();
    source.story.title = '공개 창작 수사 · 버전 고정 검증 ' + suffix;
    source.content.scenes[0].cues = [{ type: 'dialogue.show', text: '버전 1의 시작 장면' }];
    const login = await author.request.post(base + '/api/platform/guest', { data: { nickname: '작품검증' + String(suffix).slice(-6) } });
    assert.equal(login.status(), 201);
    const id = await publish(author, source);
    const errors = [];
    const player = await browser.newContext({ viewport: { width: 1280, height: 960 } });
    const desktop = await player.newPage();
    desktop.on('pageerror', error => errors.push(error.message));
    await verifyPinnedDesktop(desktop, author, source, id, suffix);
    await verifyNavigation(desktop, source, id);
    const mobile = await browser.newContext({ viewport: { width: 320, height: 780 } });
    const smallPage = await mobile.newPage();
    smallPage.on('pageerror', error => errors.push(error.message));
    await verifyMobile(smallPage, source);
    await verifyUnsupported(smallPage, author, source, suffix);
    await verifyRoomGuard(browser, id, suffix);
    await mobile.close();
    await player.close();
    await author.close();
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify({
      desktop: { width: 1280, playFromPublicCard: true, pinnedDuringEditAndUnpublish: true, newPlayOfPrivateRejected: true, investigation: true, completed: true, rating: true, canonicalMetrics: true },
      mobile: { width: 320, locale: 'en', updatedVersionOpening: true, investigation: true, noOverflow: true },
      privateFieldsAbsent: true, unsupportedFormatExplainedInBrowser: true, failedReplayRetainsRating: true, backForwardRefreshSelection: true, roomMembershipUrlGuard: true, pageErrors: errors,
    }, null, 2));
    console.log('Browser workshop play assertions passed');
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exit(1); });
