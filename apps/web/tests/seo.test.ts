import { expect, test } from 'bun:test';
import { siteOrigin } from '../src/shared/seo/metadata';

test('blank site URL uses the same default as an unset URL while invalid origins remain rejected', () => {
  expect(siteOrigin('')).toBe(siteOrigin());
  expect(siteOrigin('https://example.com/')).toBe('https://example.com');
  for (const origin of ['invalid', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?x=1', 'javascript:alert(1)']) {
    expect(() => siteOrigin(origin)).toThrow();
  }
});
