import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resetTestDatabase, testDb, testConfig, testOwnerPool } from '../helpers/db.ts';
import { startTestServer, type TestServer } from '../helpers/http.ts';
import { seedDemo, type SeededCompany } from '../../src/seed/demo.ts';
import { createBridge, type Bridge } from '../../bridge/bridge.ts';
import { fileStore } from '../../bridge/token-store.ts';
import { SAMPLE_DOCS, writeSampleDocs } from '../../scripts/make-sample-docs.ts';

let server: TestServer;
let dir: string;
let companies: SeededCompany[];
let bridge: Bridge;
let client: Client;

before(async () => {
  await resetTestDatabase();
  dir = await mkdtemp(path.join(tmpdir(), 'sim-e2e-'));
  companies = await seedDemo({ db: testDb(), cfg: testConfig() }, testOwnerPool());
  server = await startTestServer();
  const key = companies[0]!.users[0]!.key;
  bridge = await createBridge({
    server: server.url,
    store: fileStore(path.join(dir, 'tokens.json')),
    callbackTimeoutMs: 20_000,
    openBrowser: async (authUrl) => {
      const a = await fetch(authUrl, { redirect: 'manual' });
      const page = await fetch(new URL(a.headers.get('location')!, server.url), { redirect: 'manual' });
      const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0]!;
      const html = await page.text();
      const field = (n: string) => html.match(new RegExp(`name="${n}" value="([^"]+)"`))![1]!;
      const post = await fetch(`${server.url}/oauth/signin`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        body: new URLSearchParams({ request: field('request'), csrf: field('csrf'), key }),
      });
      await fetch(post.headers.get('location')!);
    },
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await bridge.server.connect(st);
  client = new Client({ name: 'claude-code-e2e', version: '1' });
  await client.connect(ct);
});
after(async () => {
  await bridge.close();
  await server.close();
});

// Runs code through the bridge the way Claude does; fails the test on any error result.
async function exec(code: string, reason: string): Promise<any> {
  const r = await client.callTool({ name: 'execute', arguments: { code, reason } });
  const text = (r.content as { text: string }[])[0]!.text;
  assert.notEqual(r.isError, true, text);
  return JSON.parse(text);
}

// Keeps an attachment the way Claude does: it reads the file on this machine (here, the sample's
// known lines stand in for Claude reading the PDF), hashes it, and saves the path and the text.
async function keep(file: string, title: string, kind: string): Promise<string> {
  const text = SAMPLE_DOCS[path.basename(file)]!.join('\n');
  const sha256 = createHash('sha256').update(await readFile(file)).digest('hex');
  const args = { kind, title, location: file, sha256, text, request_key: `keep-${randomUUID()}`, reason: `save ${title}` };
  return (await exec(`async () => api.call('document_add', ${JSON.stringify(args)})`, `save ${title}`)).document_id;
}

test('low stock to received goods, end to end through the bridge', async () => {
  const rk = () => `'k-${randomUUID()}'`;
  const now = new Date().toISOString();

  // 1. What needs ordering, under the company's rules.
  const start = await exec(
    `async () => {
      const rules = await api.call('company_rules_get', {});
      const low = await api.call('low_stock_report', {});
      return { rules: rules.body_md, sheet: low.items.find(i => i.sku === 'SS304-1.5') };
    }`,
    'morning restock check',
  );
  assert.match(start.rules, /3\.1 mill certificates/);
  assert.equal(start.sheet.status, 'reorder');
  assert.equal(start.sheet.suggest_display, '2 x bundle of 20 sheets');
  const sheetId = start.sheet.item_id as string;

  // 2. Existing supplier plus a newly found one; RFQ; emails logged as sent.
  const rfq = await exec(
    `async () => {
      const existing = await api.call('supplier_search', { item_id: '${sheetId}' });
      const dupes = await api.call('supplier_find_duplicates', { name: 'Example Mill Direct', website: 'https://mill-direct.example.com' });
      if (dupes.matches.length) throw new Error('unexpected duplicate');
      const found = await api.call('supplier_upsert', { name: 'Example Mill Direct', origin: 'discovered', website: 'https://mill-direct.example.com',
        supplier_type: 'manufacturer', discovery_sources: ['https://directory.example.com/stainless-mills'], request_key: ${rk()}, reason: 'new source for 304 sheet' });
      const c = await api.call('contact_upsert', { supplier_id: found.supplier.id, full_name: 'Morgan Example', handles: ['quotes'], language: 'en', request_key: ${rk()}, reason: 'sales contact from their website' });
      await api.call('contact_method_add', { supplier_id: found.supplier.id, contact_id: c.contact.id, type: 'email', value: 'sales@mill-direct.example.com', is_preferred: true, request_key: ${rk()}, reason: 'email from their website' });
      const r = await api.call('rfq_create', { site_code: 'MAIN', trigger: 'low_stock', lines: [{ item_id: '${sheetId}', qty: 2, pack: 'bundle of 20 sheets' }], request_key: ${rk()}, reason: 'sheet below reorder point' });
      const stock = existing.items[0].id;
      await api.call('rfq_add_recipients', { rfq_id: r.rfq_id, recipients: [{ supplier_id: stock }, { supplier_id: found.supplier.id, contact_id: c.contact.id }], request_key: ${rk()}, reason: 'ask current and new supplier' });
      for (const s of [stock, found.supplier.id]) {
        await api.call('interaction_log', { supplier_id: s, rfq_id: r.rfq_id, direction: 'out', channel: 'email', purpose: 'rfq', our_address: 'owner@northbeck-metalworks.example.test',
          subject: r.rfq_code + ' 304 sheet 1.5 mm', summary: 'Asked for 2 bundles of 304 1.5 mm 2B with 3.1 certs.', occurred_at: '${now}', request_key: 'out-' + s, reason: 'log the RFQ email' });
      }
      return { rfq_id: r.rfq_id, line_id: r.lines[0].id, stock, mill: found.supplier.id, status: await api.call('outreach_status', { rfq_id: r.rfq_id }) };
    }`,
    'request quotes for 304 sheet',
  );
  assert.deepEqual(rfq.status.counts, { contacted: 2 });

  // 3. Replies arrive as PDF attachments; Claude saves them to disk and keeps them by path and text.
  const files = await writeSampleDocs(path.join(dir, 'mail'));
  const millQuoteDoc = await keep(files[0]!, 'Quote Q-5531 from Example Mill Direct', 'quote');
  const stockQuoteDoc = await keep(files[1]!, 'Quote 7781 from Example Stainless Stockholders', 'quote');

  // 4. Record the quotes, judge them against the spec, compare.
  const compared = await exec(
    `async () => {
      const doc = await api.call('document_get', { document_id: '${millQuoteDoc}' });
      if (!doc.text.includes('2.95 USD per kg')) throw new Error('quote text not saved');
      if (!doc.location.endsWith('quote-example-mill-direct.pdf')) throw new Error('quote location not saved');
      await api.call('interaction_log', { supplier_id: '${rfq.mill}', rfq_id: '${rfq.rfq_id}', direction: 'in', channel: 'email', summary: 'Quote Q-5531 attached.', occurred_at: '${now}', document_ids: ['${millQuoteDoc}'], request_key: ${rk()}, reason: 'log reply' });
      await api.call('interaction_log', { supplier_id: '${rfq.stock}', rfq_id: '${rfq.rfq_id}', direction: 'in', channel: 'email', summary: 'Quote 7781 attached; offers 1.4 mm.', occurred_at: '${now}', document_ids: ['${stockQuoteDoc}'], request_key: ${rk()}, reason: 'log reply' });
      const qm = await api.call('quote_record', { rfq_id: '${rfq.rfq_id}', supplier_id: '${rfq.mill}', quote_ref: 'Q-5531', received_at: '${now}', currency: 'USD', lead_time_days: 12, freight_cost: 60,
        source_document_id: '${millQuoteDoc}', lines: [{ rfq_line_id: '${rfq.line_id}', item_id: '${sheetId}', pack_qty: 1, pack_uom: 'kg', price_per_pack: '2.95' }], request_key: ${rk()}, reason: 'record quote' });
      const qs = await api.call('quote_record', { rfq_id: '${rfq.rfq_id}', supplier_id: '${rfq.stock}', quote_ref: '7781', received_at: '${now}', currency: 'USD', lead_time_days: 7,
        source_document_id: '${stockQuoteDoc}', lines: [{ rfq_line_id: '${rfq.line_id}', item_id: '${sheetId}', pack_qty: 1, pack_uom: 'kg', price_per_pack: '2.80' }], request_key: ${rk()}, reason: 'record quote' });
      await api.call('evaluation_log', { subject_type: 'quote_line', subject_id: qm.lines[0].quote_line_id, verdict: 'good',
        reasoning: '304/304L dual certified meets 304; 1.5 mm, 2B, 3.1 certificate per heat.', evidence_document_ids: ['${millQuoteDoc}'], request_key: ${rk()}, reason: 'judge against spec v1' });
      await api.call('evaluation_log', { subject_type: 'quote_line', subject_id: qs.lines[0].quote_line_id, verdict: 'not_good',
        reasoning: '1.4 mm offered, outside 1.5 +/- 0.08 mm; only a 2.2 test report.', evidence_document_ids: ['${stockQuoteDoc}'], request_key: ${rk()}, reason: 'judge against spec v1' });
      const cmp = await api.call('quote_compare', { rfq_id: '${rfq.rfq_id}' });
      return { quote_id: qm.quote_id, quote_line_id: qm.lines[0].quote_line_id, line: cmp.lines[0] };
    }`,
    'record and compare sheet quotes',
  );
  assert.deepEqual(compared.line.offers.map((o: any) => o.supplier), ['Example Mill Direct']);
  assert.deepEqual(compared.line.rejected.map((o: any) => o.supplier), ['Example Stainless Stockholders']);
  assert.equal(compared.line.offers[0].landed_per_base, '2.992373');

  // 5. Order, approve with a cap, payment hand-off for the payment MCP, record the payment.
  const paid = await exec(
    `async () => {
      const po = await api.call('po_create', { supplier_id: '${rfq.mill}', site_code: 'MAIN', quote_id: '${compared.quote_id}', currency: 'USD', freight_cost: 60,
        lines: [{ item_id: '${sheetId}', qty: 2, pack: 'bundle of 20 sheets', price_per_base: '2.95', quote_line_id: '${compared.quote_line_id}' }], request_key: ${rk()}, reason: 'order from best valid quote' });
      await api.call('po_approve', { po_id: po.po_id, approved_max_amount: '4300', request_key: ${rk()}, reason: 'owner approval within budget' });
      await api.call('supplier_payout_account_set', { supplier_id: '${rfq.mill}', network: 'near', account_id: 'mill-direct.testnet', token: 'usdc', note: 'confirmed by phone with supplier', request_key: ${rk()}, reason: 'set payout account' });
      const instr = await api.call('po_payment_instruction', { po_id: po.po_id, request_key: ${rk()}, reason: 'hand off to payment MCP' });
      const rec = await api.call('po_payment_record', { po_id: po.po_id, network: 'near', payment_ref: 'testnet-tx-example-0001', outcome: 'paid', request_key: ${rk()}, reason: 'payment MCP reported success' });
      return { po_id: po.po_id, line_id: po.lines[0].po_line_id, total: po.total, instr, rec };
    }`,
    'order and pay for sheet',
  );
  assert.equal(Number(paid.total), 1416 * 2.95 + 60);
  assert.equal(paid.instr.account_id, 'mill-direct.testnet');
  assert.equal(paid.rec.payment_status, 'paid');

  // 6. Delivery with its mill certificate: received into quarantine, judged, released.
  const certDoc = await keep(files[2]!, 'Mill certificate heat 5531-77', 'mill_cert');
  const received = await exec(
    `async () => {
      await api.call('po_receive', { po_id: '${paid.po_id}', location_code: 'QC', lines: [{ po_line_id: '${paid.line_id}', qty: 2, pack: 'bundle of 20 sheets', lot_code: 'HEAT-5531-77', cert_document_id: '${certDoc}' }], request_key: ${rk()}, reason: 'delivery arrived' });
      const lots = await api.call('sql_query', { sql: "SELECT id FROM lot WHERE lot_code = 'HEAT-5531-77'" });
      await api.call('evaluation_log', { subject_type: 'lot', subject_id: lots.rows[0][0], verdict: 'good', reasoning: 'Cert shows 1.49-1.51 mm, 304/304L, 3.1 certificate.', evidence_document_ids: ['${certDoc}'], request_key: ${rk()}, reason: 'check cert against spec' });
      await api.call('lot_status_set', { lot_id: lots.rows[0][0], status: 'released', note: 'Mill cert checked against spec v1: pass.', request_key: ${rk()}, reason: 'release checked lot' });
      await api.call('stock_move', { item_id: '${sheetId}', type: 'transfer', qty: 2, pack: 'bundle of 20 sheets', site_code: 'MAIN', location_code: 'QC', to_location_code: 'A-01', lot_code: 'HEAT-5531-77', request_key: ${rk()}, reason: 'cert passed, move to rack' });
      const low = await api.call('low_stock_report', { include_ok: true });
      return { po: await api.call('po_get', { po_id: '${paid.po_id}' }), sheet: low.items.find(i => i.sku === 'SS304-1.5') };
    }`,
    'receive and check delivery',
  );
  assert.equal(received.po.status, 'received');
  assert.equal(received.sheet.status, 'ok');

  // 7. Everything that happened is in the audit log with its reason.
  const audit = await exec(`async () => (await api.call('audit_list', { limit: 50 })).items.map(i => i.reason)`, 'review what was done');
  for (const reason of ['morning restock check', 'request quotes for 304 sheet', 'order and pay for sheet', 'receive and check delivery']) {
    assert.ok(audit.includes(reason), reason);
  }
});
