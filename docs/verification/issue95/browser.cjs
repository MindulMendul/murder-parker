const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { assertDisposableTestTarget } = require('../test-target-guard.cjs');

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:3215';
const browserArgs = process.env.CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [];

(async () => {
  assertDisposableTestTarget(baseUrl);
  const browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    headless: true,
    args: browserArgs,
  });
  let contexts = [];
  const errors = [];

  try {
    const sessions = await Promise.all(
      Array.from({ length: 3 }, async (_, index) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        page.on('pageerror', (error) => errors.push(String(error)));
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

        const guest = await page.evaluate(async (nickname) => {
          const response = await fetch('/api/platform/guest', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ nickname }),
          });
          return { status: response.status, body: await response.json() };
        }, `R${Date.now().toString(36).slice(-6)}${index}`);
        assert.equal(guest.status, 201, JSON.stringify(guest));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('section[aria-labelledby="lobby-rooms-title"]').waitFor();

        await page.evaluate(() => {
          window.latest = null;
          window.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/lobby/ws`);
          window.ws.onmessage = (event) => {
            if (event.currentTarget !== window.ws || event.origin !== new URL(window.ws.url).origin) return;
            const message = JSON.parse(event.data);
            if (message.type === 'snapshot') window.latest = message.data;
          };
        });
        await page.waitForFunction(() => window.latest?.me, null, { timeout: 5000 });
        return { context, page };
      }),
    );
    contexts = sessions.map(({ context }) => context);
    const [host, joiner, observer] = sessions.map(({ page }) => page);

    const created = await host.evaluate(async () => {
      const response = await fetch('/api/lobby/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenarioId: 'rehearsal' }),
      });
      return { status: response.status, body: await response.json() };
    });
    assert.equal(created.status, 201, JSON.stringify(created));
    const roomId = created.body.roomId;
    await observer.waitForFunction(
      (id) => window.latest?.rooms.some((room) => room.id === id),
      roomId,
      { timeout: 5000 },
    );
    const availableRoomVisible = await observer.evaluate((id) =>
      window.latest?.rooms.some((room) => room.id === id), roomId);
    const code = await host.evaluate(() => window.latest.room?.code);
    const availableRoomVisibleInUI = await observer.locator('.room-card').filter({ hasText: code }).count() === 1;
    assert.ok(availableRoomVisibleInUI);

    const joined = await joiner.evaluate(async (roomCode) => {
      const response = await fetch('/api/lobby/rooms/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: roomCode }),
      });
      return { status: response.status, body: await response.json() };
    }, code);
    assert.equal(joined.status, 200, JSON.stringify(joined));
    await observer.waitForFunction(
      (id) => !window.latest?.rooms.some((room) => room.id === id),
      roomId,
      { timeout: 5000 },
    );
    const full = await observer.evaluate(async () => {
      const response = await fetch('/api/lobby/state');
      return (await response.json()).rooms;
    });
    const fullRoomHidden = !full.some((room) => room.id === roomId);
    assert.ok(fullRoomHidden);
    const fullRoomHiddenInUI = await observer.locator('.room-card').filter({ hasText: code }).count() === 0;
    assert.ok(fullRoomHiddenInUI);

    const left = await joiner.evaluate(
      () =>
        new Promise((resolve) => {
          const requestId = crypto.randomUUID();
          const handleMessage = (event) => {
            if (event.currentTarget !== window.ws || event.origin !== new URL(window.ws.url).origin) return;
            const message = JSON.parse(event.data);
            if (message.type === 'ack' && message.requestId === requestId) {
              window.ws.removeEventListener('message', handleMessage);
              resolve(true);
            }
          };
          window.ws.addEventListener('message', handleMessage);
          window.ws.send(JSON.stringify({ type: 'leave', requestId }));
        }),
    );
    assert.equal(left, true);
    await observer.waitForFunction(
      (id) => window.latest?.rooms.some((room) => room.id === id),
      roomId,
      { timeout: 5000 },
    );
    const vacancyRestoresListing = await observer.evaluate((id) =>
      window.latest?.rooms.some((room) => room.id === id), roomId);
    const vacancyRestoresListingInUI = await observer.locator('.room-card').filter({ hasText: code }).count() === 1;
    assert.ok(vacancyRestoresListingInUI);

    const rejoined = await joiner.evaluate(async (roomCode) => {
      const response = await fetch('/api/lobby/rooms/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: roomCode }),
      });
      return response.status;
    }, code);
    assert.equal(rejoined, 200);
    await observer.waitForFunction(
      (id) => !window.latest?.rooms.some((room) => room.id === id),
      roomId,
      { timeout: 5000 },
    );
    const refilledRoomHidden = await observer.evaluate((id) =>
      !window.latest?.rooms.some((room) => room.id === id), roomId);
    const refilledRoomHiddenInUI = await observer.locator('.room-card').filter({ hasText: code }).count() === 0;
    assert.ok(refilledRoomHiddenInUI);

    const start = await host.evaluate(
      () =>
        new Promise((resolve) => {
          const requestId = crypto.randomUUID();
          const handleMessage = (event) => {
            if (event.currentTarget !== window.ws || event.origin !== new URL(window.ws.url).origin) return;
            const message = JSON.parse(event.data);
            if (message.type === 'ack' && message.requestId === requestId) {
              window.ws.removeEventListener('message', handleMessage);
              resolve(message);
            }
          };
          window.ws.addEventListener('message', handleMessage);
          window.ws.send(JSON.stringify({ type: 'start', requestId }));
        }),
    );
    assert.equal(start.type, 'ack', JSON.stringify(start));
    await observer.waitForFunction(
      (id) => !window.latest?.rooms.some((room) => room.id === id),
      roomId,
      { timeout: 5000 },
    );
    const playingRoomHidden = await observer.evaluate((id) =>
      !window.latest?.rooms.some((room) => room.id === id), roomId);
    const playingRoomHiddenInUI = await observer.locator('.room-card').filter({ hasText: code }).count() === 0;
    assert.ok(playingRoomHiddenInUI);
    const hostState = await host.evaluate(() => window.latest.room);
    assert.equal(hostState.status, 'playing');
    assert.ok(availableRoomVisible);
    assert.ok(vacancyRestoresListing);
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(JSON.stringify({
      contexts: sessions.length,
      availableRoomVisible,
      availableRoomVisibleInUI,
      fullRoomHidden,
      fullRoomHiddenInUI,
      vacancyRestoresListing,
      vacancyRestoresListingInUI,
      refilledRoomHidden,
      refilledRoomHiddenInUI,
      playingRoomHidden,
      playingRoomHiddenInUI,
      hostRoomStatus: hostState.status,
      pageErrors: errors.length,
    }, null, 2));
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
