import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

const keys = { PAYER_ACCOUNT: 't.testnet', PAYER_PRIVATE_KEY: 'ed25519:test', MAINNET_PAYER_ACCOUNT: 'm.near', MAINNET_PAYER_PRIVATE_KEY: 'ed25519:main' };

test('testnet: public rail, testnet payer variables', () => {
  const c = loadConfig({ ...keys });
  assert.equal(c.rail, 'public');
  assert.deepEqual(c.payer, { accountId: 't.testnet', key: 'ed25519:test' });
});

test('mainnet: confidential rail by default, and only the MAINNET_ payer variables', () => {
  const c = loadConfig({ ...keys, NEAR_NETWORK: 'mainnet' });
  assert.equal(c.rail, 'confidential');
  assert.deepEqual(c.payer, { accountId: 'm.near', key: 'ed25519:main' });
  assert.equal(loadConfig({ PAYER_ACCOUNT: 't.testnet', PAYER_PRIVATE_KEY: 'ed25519:test', NEAR_NETWORK: 'mainnet' }).payer, null);
  assert.equal(c.policy.tokens.usdc!.contract, '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1');
});

test('confidential on testnet is refused', () => {
  assert.throws(() => loadConfig({ RAIL: 'confidential' }), /mainnet only/);
});
