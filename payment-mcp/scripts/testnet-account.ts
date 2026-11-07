// Create a funded NEAR testnet account through the testnet faucet helper, and keep its key.
//   node scripts/testnet-account.ts <name>.testnet --env      key -> .env.local (PAYER_ACCOUNT / PAYER_PRIVATE_KEY)
//   node scripts/testnet-account.ts <name>.testnet --file     key -> ~/.config/near-payment-mcp/testnet-keys/<name>.json
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KeyPair } from 'near-api-js';

const [accountId, mode] = process.argv.slice(2);
if (!accountId?.endsWith('.testnet') || !['--env', '--file'].includes(mode ?? '')) {
  console.error('usage: node scripts/testnet-account.ts <name>.testnet --env|--file');
  process.exit(2);
}
if (mode === '--env' && existsSync('.env.local') && /^PAYER_PRIVATE_KEY=/m.test(readFileSync('.env.local', 'utf8'))) {
  console.error('.env.local already has PAYER_PRIVATE_KEY; refusing to overwrite it.');
  process.exit(1);
}

const kp = KeyPair.fromRandom('ed25519');
const res = await fetch('https://helper.nearprotocol.com/account', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: kp.getPublicKey().toString() }),
});
const text = await res.text();
if (!res.ok) {
  console.error(`Faucet helper refused (${res.status}): ${text.slice(0, 300)}`);
  process.exit(1);
}

// Key saved only after the account exists, so a failure leaves nothing behind.
if (mode === '--env') {
  appendFileSync('.env.local', `\nPAYER_ACCOUNT=${accountId}\nPAYER_PRIVATE_KEY=${kp.toString()}\n`, { mode: 0o600 });
  chmodSync('.env.local', 0o600);
  console.error(`Created ${accountId}; key appended to .env.local`);
} else {
  const dir = path.join(os.homedir(), '.config', 'near-payment-mcp', 'testnet-keys');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = path.join(dir, `${accountId}.json`);
  writeFileSync(f, JSON.stringify({ account_id: accountId, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  console.error(`Created ${accountId}; key saved to ${f}`);
}
