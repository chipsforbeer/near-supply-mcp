import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../src/config.ts';

const base = {
  PUBLIC_ORIGIN: 'https://mcp.example.com',
  DATABASE_URL_APP: 'postgres://a', DATABASE_URL_READ: 'postgres://r', DATABASE_URL_OWNER: 'postgres://o',
  HMAC_SECRET: 'x'.repeat(40),
};

test('valid production config loads', () => {
  const c = loadConfig(base);
  assert.equal(c.isLocalOrigin, false);
  assert.equal(c.port, 8790);
  assert.equal(c.trustProxy, false);
});

test('settings for the old file storage are ignored, not required', () => {
  const c = loadConfig({ ...base, STORAGE_BACKEND: 'gcs', DOCS_BUCKET: 'b', SCAN_MODE: 'clamd', CLAMD_SOCKET: '/x', TMP_DIR: '/tmp/x' });
  assert.equal('storage' in c, false);
});

test('plain http on a public origin is refused', () => {
  assert.throws(() => loadConfig({ ...base, PUBLIC_ORIGIN: 'http://mcp.example.com' }), ConfigError);
});

test('short HMAC secret and missing URLs are all reported', () => {
  try {
    loadConfig({ PUBLIC_ORIGIN: 'https://mcp.example.com', HMAC_SECRET: 'short' });
    assert.fail('expected ConfigError');
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    assert.match(e.message, /HMAC_SECRET/);
    assert.match(e.message, /DATABASE_URL_APP/);
  }
});

test('a local origin may use plain http', () => {
  const c = loadConfig({ ...base, PUBLIC_ORIGIN: 'http://127.0.0.1:8790' });
  assert.equal(c.isLocalOrigin, true);
});
