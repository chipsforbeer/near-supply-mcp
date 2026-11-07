// Shared by the e2e suites: sign in to the local demo supplier server (fictional Northbeck Metalworks).
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SupplyAuth, TokenFile } from '../../src/supply/auth.ts';
import { SupplyClient } from '../../src/supply/client.ts';
import { signInHeadless } from './signin.ts';

export const BASE = process.env.E2E_SUPPLY_URL ?? 'http://127.0.0.1:8790';
export const OWNER = 'owner@northbeck-metalworks.example.test'; // human approver
export const BUYER = 'buyer@northbeck-metalworks.example.test'; // the payment MCP: read+write, no approve

export function demoKey(email: string): string {
  const env = email.startsWith('owner') ? process.env.SUPPLY_OWNER_KEY : process.env.SUPPLY_BUYER_KEY;
  if (env) return env;
  const f = path.join(os.homedir(), '.config', 'near-payment-mcp', 'local-demo-keys.txt');
  const line = existsSync(f) ? readFileSync(f, 'utf8').split('\n').find((l) => l.includes(email)) : undefined;
  if (!line) throw new Error(`No demo key for ${email}`);
  return line.trim().split(/\s+/).at(-1)!;
}

export async function clientFor(dir: string, email: string, scope: string): Promise<SupplyClient> {
  const store = new TokenFile(path.join(dir, `${email}.json`));
  await store.save(await signInHeadless(BASE, demoKey(email), scope));
  return new SupplyClient(new URL(BASE), new SupplyAuth(store, new URL('/mcp', BASE)));
}

/** Owner-side helpers for building test POs on the demo server. */
export function demoPos(owner: SupplyClient, runId: string) {
  let n = 0;
  const rk = (what: string) => `e2e-${runId}-${++n}-${what}`;
  const write = (op: string, args: Record<string, unknown>, reason: string) => owner.call<any>(op, args, { reason: `e2e: ${reason}`, requestKey: rk(op) });
  let supplierId = '';
  let itemId = '';
  return {
    async init() {
      const ids = await owner.call<{ rows: string[][] }>('sql_query', { sql: "SELECT id FROM supplier WHERE name = 'Example Fasteners'" }, { reason: 'e2e: find test supplier' });
      supplierId = ids.rows[0]![0]!;
      const items = await owner.call<{ rows: string[][] }>('sql_query', { sql: "SELECT id FROM item WHERE sku = 'SS304-1.5'" }, { reason: 'e2e: find test item' });
      itemId = items.rows[0]![0]!;
    },
    setPayout: (account: string, token = 'usdc') =>
      write('supplier_payout_account_set', { supplier_id: supplierId, network: 'near', account_id: account, token, note: 'e2e test account controlled by the developer' }, 'set payout account'),
    /** A small PO: qty kg × price, no freight, approved up to its total. */
    async approvedPo(qty: string, price: string, approve = true): Promise<{ po_id: string; po_code: string }> {
      const po = await write('po_create', { supplier_id: supplierId, site_code: 'MAIN', currency: 'USD', freight_cost: 0, lines: [{ item_id: itemId, qty, uom: 'kg', price_per_base: price }], notes: 'near-payment-mcp e2e test' }, 'test PO');
      if (approve) await write('po_approve', { po_id: po.po_id, approved_max_amount: po.total }, 'approve test PO');
      return po;
    },
  };
}
