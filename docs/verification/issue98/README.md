# Issue 98 verification

PR #104 hides sign-out and account deletion inside account settings. The account deletion notice explains that the nickname, Google link, created stories, favorites, and sessions are removed permanently; the Google account itself and completed game records are not deleted. The privacy policy now documents the self-service deletion path and distinguishes it from Google sign-out.

- Integrated current `dev` at `0fd297f` while preserving the account UI and deletion behavior.
- `bash scripts/codex/verify.sh`: passed; 64 tests and 4,824 assertions.
- Actual Chromium/Playwright: Korean desktop (1440px) and English mobile (375px). Verified settings open and close, keyboard focus returns to the opener, logout cancel and confirmation, account deletion scope and cancel, and deletion only after confirmation. No browser runtime errors. See `browser-results.json` and screenshots.
- Server tests cover account deletion of owned content while preserving another owner's data, guest session revocation, active-room denial, rollback retaining account data and nickname reservation, successful nickname release after deletion, pending OAuth state invalidation, and Google logout retaining the account link and authored work.
- Test server used port 3183 and `/tmp/issue98-review.sqlite`; no real Google credentials or account were used.

Reproduce with Bun 1.4.4 and installed Playwright/Chromium:

```sh
PORT=3183 HOST=127.0.0.1 APP_ORIGIN=http://127.0.0.1:3183 \
DATABASE_PATH=/tmp/issue98-review.sqlite bun apps/server/src/index.ts

BASE_URL=http://127.0.0.1:3183 \
PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
CHROMIUM_PATH=/absolute/path/to/chromium \
PLAYWRIGHT_NO_SANDBOX=1 \
node docs/verification/issue98/browser.cjs
```

`PLAYWRIGHT_NO_SANDBOX=1` is only needed in a container that cannot launch Chromium with its normal sandbox. The repository `verify.sh --browser` still reports the configured `test:e2e` as missing; the actual browser run above is recorded separately.
