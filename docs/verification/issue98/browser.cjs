const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertDisposableTestTarget } = require('../test-target-guard.cjs');

const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:3183').replace(/\/$/, '');
const resultsPath = process.env.RESULTS_PATH || 'docs/verification/issue98/browser-results.json';
const imagePath = process.env.IMAGE_PATH || 'docs/verification/issue98';
const launchOptions = { headless: true };
if (process.env.CHROMIUM_PATH) launchOptions.executablePath = process.env.CHROMIUM_PATH;
if (process.env.PLAYWRIGHT_NO_SANDBOX === '1') launchOptions.args = ['--no-sandbox'];

const label = (locale, ko, en) => locale === 'en' ? en : ko;

async function signIn(page, locale) {
  await page.goto(`${baseUrl}/${locale === 'en' ? 'en/' : ''}`);
  const response = await page.evaluate(async () => {
    const result = await fetch('/api/platform/guest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: `Review${crypto.randomUUID().slice(0, 7)}` }),
    });
    return { ok: result.ok, status: result.status };
  });
  assert(response.ok, `Guest session should be created: ${response.status}`);
}

async function checkSettings(browser, locale, width, deleteAccount) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await signIn(page, locale);
    const accountPath = locale === 'en' ? '/en/mypage' : '/mypage';
    await page.goto(`${baseUrl}${accountPath}`);
    const opener = page.getByRole('button', { name: label(locale, '계정 설정', 'Account settings'), exact: true });
    await opener.waitFor();
    await opener.click();
    const heading = page.getByRole('heading', { name: label(locale, '계정 설정', 'Account settings') });
    await heading.waitFor();
    const settingsOpen = await heading.isVisible();
    assert(settingsOpen);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), await heading.textContent());
    await page.screenshot({ path: path.join(imagePath, `${locale}-${width}-settings.png`), fullPage: true });

    await page.getByRole('button', { name: label(locale, '설정 닫기', 'Close settings'), exact: true }).click();
    const focusReturned = await opener.evaluate(element => document.activeElement === element);
    assert(focusReturned, 'Closing settings should return focus to its opener');
    let logoutCancelled;
    let logoutCompleted;
    let deleteScopeShown;
    let deleteCancelled;
    let deleteCompleted;

    await opener.click();
    if (!deleteAccount) {
      await page.getByRole('button', { name: label(locale, '로그아웃', 'Sign out'), exact: true }).click();
      await page.getByText(label(locale, '로그아웃할까요?', 'Sign out now?')).waitFor();
      await page.getByRole('button', { name: label(locale, '취소', 'Cancel'), exact: true }).click();
      logoutCancelled = await page.getByRole('heading', { name: label(locale, '계정 설정', 'Account settings') }).isVisible();
      assert(logoutCancelled);
      await page.getByRole('button', { name: label(locale, '로그아웃', 'Sign out'), exact: true }).click();
      await page.getByRole('button', { name: label(locale, '로그아웃 확인', 'Confirm sign out'), exact: true }).click();
      await page.waitForURL(`${baseUrl}${locale === 'en' ? '/en/' : '/'}`);
      const profile = await page.evaluate(() => fetch('/api/platform/account').then(r => r.json()));
      logoutCompleted = profile.me === null;
      assert(logoutCompleted);
    } else {
      await page.getByRole('button', { name: label(locale, '회원탈퇴', 'Delete account'), exact: true }).click();
      const scope = label(locale,
        '탈퇴하면 닉네임, 구글 계정 연결, 만든 작품(공개 작품 포함), 즐겨찾기와 모든 로그인 세션이 삭제되며 복구할 수 없어요.',
        'Deleting your account permanently removes your nickname, Google account link, stories (including published stories), favorites and all sign-in sessions.');
      deleteScopeShown = await page.getByText(scope, { exact: false }).isVisible();
      assert(deleteScopeShown);
      await page.screenshot({ path: path.join(imagePath, `${locale}-${width}-delete-confirm.png`), fullPage: true });
      await page.getByRole('button', { name: label(locale, '취소', 'Cancel'), exact: true }).click();
      deleteCancelled = await page.getByRole('heading', { name: label(locale, '계정 설정', 'Account settings') }).isVisible();
      assert(deleteCancelled);
      await page.getByRole('button', { name: label(locale, '회원탈퇴', 'Delete account'), exact: true }).click();
      await page.getByRole('button', { name: label(locale, '회원탈퇴 확인', 'Confirm account deletion'), exact: true }).click();
      await page.waitForURL(`${baseUrl}${locale === 'en' ? '/en/' : '/'}`);
      const profile = await page.evaluate(() => fetch('/api/platform/account').then(r => r.json()));
      deleteCompleted = profile.me === null;
      assert(deleteCompleted);
    }
    assert.deepEqual(errors, []);
    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    assert(noOverflow);
    return { locale, width, settingsOpen, focusReturned, logoutCancelled, logoutCompleted, deleteScopeShown, deleteCancelled, deleteCompleted, noOverflow, pageErrors: errors };
  } finally {
    await context.close();
  }
}

async function main() {
  assertDisposableTestTarget(baseUrl);
  fs.mkdirSync(imagePath, { recursive: true });
  const browser = await chromium.launch(launchOptions);
  try {
    const results = [];
    for (const [locale, width, deleteAccount] of [['ko', 1440, false], ['en', 375, true]]) {
      results.push(await checkSettings(browser, locale, width, deleteAccount));
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
