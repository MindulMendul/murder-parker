const assert = require('node:assert/strict');
const test = require('node:test');
const { assertDisposableTestTarget } = require('../test-target-guard.cjs');

test('permits only explicitly disposable exact loopback origins', () => {
  for (const origin of ['http://localhost:3000', 'https://127.0.0.1:8443', 'http://[::1]:3000']) {
    assert.equal(assertDisposableTestTarget(origin, { DISPOSABLE_TEST_SERVER: '1' }).origin, origin);
  }
});

test('rejects production, QA, and private network targets before any browser activity', () => {
  for (const origin of [
    'https://mindul-murder-mystery.duckdns.org',
    'https://qa-mindul-murder-mystery.duckdns.org',
    'http://10.1.2.3:3000',
    'http://192.168.1.4:3000',
    'http://172.16.0.4:3000',
    'http://[fd00::1]:3000',
  ]) {
    assert.throws(() => assertDisposableTestTarget(origin, { DISPOSABLE_TEST_SERVER: '1' }));
  }
});

test('rejects credentials and origin lookalikes even when disposable mode is acknowledged', () => {
  for (const origin of [
    'http://user@localhost:3000',
    'http://localhost@qa-mindul-murder-mystery.duckdns.org',
    'http://localhost.example:3000',
    'http://localhost:3000/path',
  ]) {
    assert.throws(() => assertDisposableTestTarget(origin, { DISPOSABLE_TEST_SERVER: '1' }));
  }
});

test('requires explicit disposable-server acknowledgment for loopback targets', () => {
  for (const flag of [undefined, '0', 'true']) {
    assert.throws(() => assertDisposableTestTarget('http://127.0.0.1:3000', { DISPOSABLE_TEST_SERVER: flag }), /DISPOSABLE_TEST_SERVER=1/);
  }
});
