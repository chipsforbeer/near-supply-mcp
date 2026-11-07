// The payer wallet when none is configured: a fresh NEAR implicit account, created on request
// (wallet_create). An implicit account's id is its public key in hex, so it exists as soon as the key
// does: no registration, no NEAR for gas, and no add_public_key on intents.near. The confidential rail
// never sends a public transaction, so this account never needs NEAR at all.
//
// The private key is kept in a 0600 file next to the ledger and is never returned to Claude. Losing the
// file loses the funds in the account: back it up (the README says how).

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { KeyPair, type KeyPairString } from 'near-api-js';

export type Wallet = { accountId: string; key: KeyPairString };

export const implicitId = (key: KeyPairString): string =>
  Buffer.from(KeyPair.fromString(key).getPublicKey().data).toString('hex');

export async function loadWallet(file: string): Promise<Wallet | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  const w = JSON.parse(raw) as { account_id?: string; private_key?: string };
  if (!w.account_id || !w.private_key?.startsWith('ed25519:')) throw new Error(`Wallet file ${file} is not valid.`);
  const key = w.private_key as KeyPairString;
  if (implicitId(key) !== w.account_id) throw new Error(`Wallet file ${file}: the key does not match account ${w.account_id}.`);
  return { accountId: w.account_id, key };
}

/** Creates the wallet file. Refuses to replace an existing one: that would orphan its funds. */
export async function createWallet(file: string): Promise<Wallet> {
  if (await loadWallet(file)) throw new Error(`A wallet already exists at ${file}; it is never replaced.`);
  const key = KeyPair.fromRandom('ed25519').toString() as KeyPairString;
  const wallet = { accountId: implicitId(key), key };
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // flag 'wx': fail rather than overwrite if another process created it in the meantime
  await writeFile(file, JSON.stringify({ account_id: wallet.accountId, private_key: key, created_at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await chmod(file, 0o600).catch(() => undefined);
  return wallet;
}
