import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { resetTestDatabase, testOwnerPool } from '../helpers/db.ts';
import { newActor, call } from '../helpers/ops.ts';
import { makeItem } from '../helpers/fixtures.ts';
import { OpError } from '../../src/ops/errors.ts';
import { runOperation } from '../../src/ops/run.ts';
import { buildOpenApi } from '../../src/ops/openapi.ts';

before(resetTestDatabase);
const isCode = (code: string) => (e: unknown) => e instanceof OpError && e.code === code;

test('captured text is stored once, linked, searchable and readable in chunks', async () => {
  const a = await newActor();
  const { supplier } = await call(a, 'supplier_upsert', { name: 'Example Maltings', origin: 'existing' });
  const text = `Thanks for the RFQ. Pale malt 0.92 USD/kg FCA, 14 days. ${'x'.repeat(300)}`;
  const doc = await call(a, 'document_capture_text', {
    title: 'Reply from Example Maltings', kind: 'email', text, source: 'mail', source_ref: 'gmail:18c2f0a1b2',
    links: [{ entity_type: 'supplier', entity_id: supplier.id, role: 'quote reply' }],
  });
  assert.equal(doc.text_source, 'claude');
  const again = await call(a, 'document_capture_text', { title: 'Same', kind: 'email', text, source: 'mail' });
  assert.equal(again.document_id, doc.document_id);
  assert.equal(again.duplicate, true);
  const first = await call(a, 'document_get', { document_id: doc.document_id, max_chars: 100 });
  assert.equal(first.text.length, 100);
  assert.equal(first.next_offset, 100);
  assert.equal(first.links[0].role, 'quote reply');
  assert.equal(first.location, null);
  const found = await call(a, 'document_search', { query: 'FCA' });
  assert.equal(found.items[0].document_id, doc.document_id);
});

test('links to things that do not exist are refused', async () => {
  const a = await newActor();
  await assert.rejects(
    call(a, 'document_capture_text', { title: 't', kind: 'note', text: 'x', source: 'note', links: [{ entity_type: 'item', entity_id: '00000000-0000-4000-8000-000000000000' }] }),
    isCode('not_found'),
  );
});

test('a local file is kept as a location with the text Claude read, and says whose machine it is on', async () => {
  const a = await newActor();
  const item = await makeItem(a, { sku: 'SS304', name: '304 sheet', base_uom: 'kg' });
  const location = 'C:\\Users\\buyer\\Documents\\certs\\mill-cert-4471.pdf';
  const sha256 = 'a'.repeat(64);
  const r = await call(a, 'document_add', {
    title: 'Mill cert heat 4471', kind: 'mill_cert', location, sha256, valid_until: '2026-12-01',
    text: 'Example Mill Certificate EN 10204 3.1. Heat 4471. Thickness 1.50 mm.',
    links: [{ entity_type: 'item', entity_id: item.id }],
  });
  assert.equal(r.duplicate, false);
  assert.equal(r.location, location);
  assert.equal(r.text_source, 'claude');
  const got = await call(a, 'document_get', { document_id: r.document_id });
  assert.equal(got.location, location);
  assert.equal(got.source, 'file');
  assert.equal(got.sha256, sha256);
  assert.equal(got.saved_by.user_id, a.session.userId);
  assert.match(got.text, /Heat 4471/);
  assert.equal(got.storage_key, undefined);
  const found = await call(a, 'document_search', { query: '4471' });
  assert.equal(found.items[0].document_id, r.document_id);
  assert.equal(found.items[0].location, location);
  const expiring = await call(a, 'documents_expiring', { within_days: 365 });
  assert.equal(expiring.items[0].document_id, r.document_id);
  assert.equal(expiring.items[0].location, location);

  const sameFile = await call(a, 'document_add', { title: 'Copy', kind: 'mill_cert', location: 'D:\\backup\\cert.pdf', sha256 });
  assert.equal(sameFile.document_id, r.document_id);
  assert.equal(sameFile.duplicate, true);
  const samePath = await call(a, 'document_add', { title: 'Again', kind: 'mill_cert', location });
  assert.equal(samePath.document_id, r.document_id);
  assert.equal(samePath.duplicate, true);
});

test('a link is kept as a url location; no text is fine', async () => {
  const a = await newActor();
  const r = await call(a, 'document_add', { title: 'Datasheet', kind: 'spec_sheet', location: 'https://files.example.com/ds-304.pdf' });
  assert.equal(r.text_source, 'none');
  const got = await call(a, 'document_get', { document_id: r.document_id });
  assert.equal(got.source, 'url');
  assert.equal(got.text, '');
  assert.equal(got.sha256, null);
});

test('document_update moves, renames, retexts and clears fields, and the change log keeps the before and after', async () => {
  const a = await newActor();
  const r = await call(a, 'document_add', { title: 'Quote', kind: 'quote', location: 'C:\\old\\q.pdf', valid_until: '2027-01-01' });
  const u = await call(a, 'document_update', {
    document_id: r.document_id, location: 'C:\\new\\q.pdf', title: 'Quote Q-1', text: 'Price 2.95 USD/kg', valid_until: null,
  });
  assert.equal(u.location, 'C:\\new\\q.pdf');
  const got = await call(a, 'document_get', { document_id: r.document_id });
  assert.equal(got.title, 'Quote Q-1');
  assert.equal(got.text, 'Price 2.95 USD/kg');
  assert.equal(got.text_source, 'claude');
  assert.equal(got.valid_until, null);
  const hist = await call(a, 'change_history', { table: 'document', row_id: r.document_id });
  const update = hist.items.find((h: { action: string }) => h.action === 'update');
  assert.equal(update.before.location, 'C:\\old\\q.pdf');
  assert.equal(update.after.location, 'C:\\new\\q.pdf');
  const cleared = await call(a, 'document_update', { document_id: r.document_id, location: null });
  assert.equal(cleared.location, null);
  await assert.rejects(call(a, 'document_update', { document_id: r.document_id }), isCode('invalid_arguments'));
});

test('document_add needs a location; the server stores no files and offers no file operations', async () => {
  const a = await newActor();
  await assert.rejects(call(a, 'document_add', { title: 't', kind: 'note' }), isCode('invalid_arguments'));
  const spec = buildOpenApi(['read', 'write', 'approve']) as { paths: Record<string, unknown> };
  for (const gone of ['document_fetch_url', 'document_register', 'document_locate']) {
    assert.equal(spec.paths[`/operations/${gone}`], undefined, gone);
    await assert.rejects(runOperation(gone, {}, await a.ctx()), isCode('unknown_operation'));
  }
  const cols = await testOwnerPool().query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'document' AND column_name IN ('storage_backend', 'storage_key', 'scan_status')`,
  );
  assert.equal(cols.rowCount, 0);
});
