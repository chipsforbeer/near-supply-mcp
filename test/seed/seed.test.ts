import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resetTestDatabase, testDb, testConfig, testOwnerPool } from '../helpers/db.ts';
import { seedDemo, type SeededCompany } from '../../src/seed/demo.ts';
import { runOperation } from '../../src/ops/run.ts';
import { startToolAudit } from '../../src/audit/audit.ts';
import type { OpContext } from '../../src/ops/types.ts';

let companies: SeededCompany[];
before(async () => {
  await resetTestDatabase();
  companies = await seedDemo({ db: testDb(), cfg: testConfig() }, testOwnerPool());
});

async function asCompany(companyId: string): Promise<OpContext> {
  const owner = await testOwnerPool().query(`SELECT m.user_id FROM membership m WHERE m.company_id = $1 AND 'approve' = ANY (m.scopes)`, [companyId]);
  const session = { userId: owner.rows[0].user_id, companyId, sessionId: randomUUID(), scopes: ['read', 'write', 'approve'] as const, client: 'test' as const };
  const s = { ...session, scopes: [...session.scopes] };
  return { db: testDb(), cfg: testConfig(), session: s, toolAuditId: await startToolAudit(testDb(), s, 'test', 'check seed', null) };
}

test('two companies with an approver and a buyer each', () => {
  assert.deepEqual(companies.map((c) => c.slug), ['northbeck-metalworks', 'lark-hill-foods']);
  for (const c of companies) {
    assert.deepEqual(c.users.map((u) => u.scopes), ['read,write,approve', 'read,write']);
    assert.ok(c.users.every((u) => u.email.endsWith('.example.test') && u.key.startsWith('sik_')));
  }
});

test('stainless sheet is due for reorder at the metal shop, 2 bundles suggested', async () => {
  const r = (await runOperation('low_stock_report', {}, await asCompany(companies[0]!.id))) as any;
  const sheet = r.items.find((i: any) => i.sku === 'SS304-1.5');
  assert.equal(sheet.status, 'reorder');
  assert.equal(sheet.suggest_display, '2 x bundle of 20 sheets');
  assert.equal(sheet.preferred_supplier, 'Example Stainless Stockholders');
});

test('pale malt is due for reorder at the brewery, one pallet suggested', async () => {
  const r = (await runOperation('low_stock_report', {}, await asCompany(companies[1]!.id))) as any;
  const malt = r.items.find((i: any) => i.sku === 'MALT-PALE');
  assert.equal(malt.status, 'reorder');
  assert.equal(malt.on_hand, '700');
  assert.equal(malt.suggest_display, '1 x pallet of 40 sacks');
});

test('seeding twice is refused and changes nothing', async () => {
  await assert.rejects(seedDemo({ db: testDb(), cfg: testConfig() }, testOwnerPool()), /already exists/);
});
