const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function assertDisposableTestTarget(baseUrl, environment = process.env) {
  let target;
  try {
    target = new URL(baseUrl);
  } catch {
    throw new Error('Refusing browser verification: BASE_URL must be a local http(s) origin.');
  }

  const hostname = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(target.protocol)
      || target.username !== ''
      || target.password !== ''
      || !LOOPBACK_HOSTS.has(hostname)
      || target.pathname !== '/'
      || target.search !== ''
      || target.hash !== '') {
    throw new Error('Refusing browser verification: BASE_URL must be an exact localhost, 127.0.0.1, or [::1] origin without credentials or a path.');
  }

  if (environment.DISPOSABLE_TEST_SERVER !== '1') {
    throw new Error('Refusing browser verification: start your own local server with DATABASE_PATH=:memory:, then set DISPOSABLE_TEST_SERVER=1. These scripts create guest sessions and may create rooms or delete the test account.');
  }

  return target;
}

module.exports = { assertDisposableTestTarget };
