import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { resetTestDatabase, testDb } from '../helpers/db.ts';
import { newActor, call, type Actor } from '../helpers/ops.ts';
import { setupSite, makeItem } from '../helpers/fixtures.ts';
import { OpError } from '../../src/ops/errors.ts';
import { withCompany } from '../../src/db/pool.ts';

before(resetTestDatabase);
const isCode = (code: string) => (e: unknown) => e instanceof OpError && e.code === code;

async function rfqWithTwoSuppliers(a: Actor) {
  await setupSite(a);
  const sheet = await makeItem(a, { sku: 'SS304', name: '304 sheet', base_uom: 'kg', physical_form: 'sheet' });
  const s1 = (await call(a, 'supplier_upsert', { name: 'Example Stockholders', origin: 'existing' })).supplier;
  const s2 = (await call(a, 'supplier_upsert', { name: 'Example Mill Direct', origin: 'discovered', discovery_sources: ['https://example.com/mills'] })).supplier;
  const contact = (await call(a, 'contact_upsert', { supplier_id: s1.id, full_name: 'Example Sales Lead', handles: ['quotes'] })).contact;
  const rfq = await call(a, 'rfq_create', { site_code: 'MAIN', trigger: 'low_stock', lines: [{ item_id: sheet.id, qty: 1416 }] });
  await call(a, 'rfq_add_recipients', { rfq_id: rfq.rfq_id, recipients: [{ supplier_id: s1.id, contact_id: contact.id }, { supplier_id: s2.id }] });
  return { sheet, s1, s2, contact, rfq };
}

test('outbound email marks the recipient contacted and the RFQ sent; follow-ups count', async () => {
  const a = await newActor();
  const { s1, contact, rfq } = await rfqWithTwoSuppliers(a);
  assert.equal(rfq.rfq_code, 'RFQ-0001');
  const first = await call(a, 'interaction_log', {
    supplier_id: s1.id, contact_id: contact.id, rfq_id: rfq.rfq_id, direction: 'out', channel: 'email', purpose: 'rfq',
    our_address: 'buyer@example.test', their_address: 'sales@example.com', subject: 'RFQ-0001 304 sheet',
    summary: 'Asked for 2 bundles of 304 1.5 mm 2B with 3.1 certs.', occurred_at: '2026-11-03T09:00:00Z',
  });
  assert.equal(first.rfq_recipient_status, 'contacted');
  await call(a, 'interaction_log', {
    supplier_id: s1.id, rfq_id: rfq.rfq_id, direction: 'out', channel: 'email', purpose: 'follow_up',
    summary: 'Reminder.', occurred_at: '2026-11-06T09:00:00Z',
  });
  const status = await call(a, 'outreach_status', { rfq_id: rfq.rfq_id });
  const row = status.recipients.find((r: any) => r.supplier_id === s1.id);
  assert.equal(row.status, 'contacted');
  assert.equal(row.follow_ups, 1);
  assert.ok(row.days_silent >= 0);
  assert.equal(status.rfq_status, 'sent');
  assert.deepEqual(status.counts, { contacted: 1, to_contact: 1 });
});

test('an inbound reply moves the recipient to replied and shows on the supplier', async () => {
  const a = await newActor();
  const { s2, rfq } = await rfqWithTwoSuppliers(a);
  await call(a, 'interaction_log', { supplier_id: s2.id, rfq_id: rfq.rfq_id, direction: 'out', channel: 'email', summary: 'RFQ sent.', occurred_at: '2026-11-03T09:00:00Z' });
  const reply = await call(a, 'interaction_log', {
    supplier_id: s2.id, rfq_id: rfq.rfq_id, direction: 'in', channel: 'email', summary: 'Quote attached, 14 days lead time.', occurred_at: '2026-11-04T02:00:00Z',
  });
  assert.equal(reply.rfq_recipient_status, 'replied');
  const got = await call(a, 'supplier_get', { supplier_id: s2.id });
  assert.equal(got.recent_interactions.length, 2);
  assert.ok(got.last_reply_at);
  assert.equal(got.origin, 'discovered');
});

test('contacts we may not contact on the user\'s behalf are refused', async () => {
  const a = await newActor();
  const { s1, rfq } = await rfqWithTwoSuppliers(a);
  const quiet = (await call(a, 'contact_upsert', { supplier_id: s1.id, full_name: 'Example Owner', may_contact_on_behalf: false })).contact;
  await assert.rejects(call(a, 'rfq_add_recipients', { rfq_id: rfq.rfq_id, recipients: [{ supplier_id: s1.id, contact_id: quiet.id }] }), isCode('conflict'));
  await assert.rejects(
    call(a, 'interaction_log', { supplier_id: s1.id, contact_id: quiet.id, direction: 'out', channel: 'email', summary: 'x', occurred_at: '2026-11-03T09:00:00Z' }),
    isCode('conflict'),
  );
});

test('logging against an RFQ needs the supplier to be a recipient', async () => {
  const a = await newActor();
  const { rfq } = await rfqWithTwoSuppliers(a);
  const other = (await call(a, 'supplier_upsert', { name: 'Not Asked Ltd', origin: 'existing' })).supplier;
  await assert.rejects(
    call(a, 'interaction_log', { supplier_id: other.id, rfq_id: rfq.rfq_id, direction: 'out', channel: 'email', summary: 'x', occurred_at: '2026-11-03T09:00:00Z' }),
    isCode('conflict'),
  );
});

test('blocked suppliers cannot be asked; recipients can be marked declined', async () => {
  const a = await newActor();
  const { s2, rfq } = await rfqWithTwoSuppliers(a);
  const blocked = (await call(a, 'supplier_upsert', { name: 'Blocked Co', origin: 'existing', status: 'blocked' })).supplier;
  await assert.rejects(call(a, 'rfq_add_recipients', { rfq_id: rfq.rfq_id, recipients: [{ supplier_id: blocked.id }] }), isCode('conflict'));
  const declined = await call(a, 'rfq_status_set', { rfq_id: rfq.rfq_id, supplier_id: s2.id, recipient_status: 'declined', note: 'No 1.5 mm in stock.' });
  assert.equal(declined.status, 'declined');
  const got = await call(a, 'rfq_get', { rfq_code: 'RFQ-0001' });
  assert.equal(got.lines[0].sku, 'SS304');
  assert.equal(got.recipients.length, 2);
});

test('interactions are append-only and private to the company', async () => {
  const a = await newActor();
  const b = await newActor();
  const { s1 } = await rfqWithTwoSuppliers(a);
  await call(a, 'interaction_log', { supplier_id: s1.id, direction: 'in', channel: 'phone', summary: 'Called about price rise.', occurred_at: '2026-11-03T09:00:00Z' });
  await assert.rejects(withCompany(testDb().app, a.session.companyId, (tx) => tx.query(`UPDATE interaction SET summary = 'x'`)), /permission denied/);
  await assert.rejects(
    call(b, 'interaction_log', { supplier_id: s1.id, direction: 'in', channel: 'phone', summary: 'x', occurred_at: '2026-11-03T09:00:00Z' }),
    isCode('not_found'),
  );
});
