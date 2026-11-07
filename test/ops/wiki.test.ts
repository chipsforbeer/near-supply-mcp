import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resetTestDatabase, testDb } from '../helpers/db.ts';
import { newActor, call, type Actor } from '../helpers/ops.ts';
import { OpError } from '../../src/ops/errors.ts';
import { parseWikiLinks } from '../../src/ops/wiki/links.ts';
import { checkPath, titleOf } from '../../src/ops/wiki/paths.ts';
import { withCompany } from '../../src/db/pool.ts';

before(resetTestDatabase);
const isCode = (code: string) => (e: unknown) => e instanceof OpError && e.code === code;
const create = (a: Actor, path: string, body_md: string, extra: Record<string, unknown> = {}) => call(a, 'wiki_create', { path, body_md, ...extra });

test('a new company has index.md, log.md, current-status.md and rules.md', async () => {
  const a = await newActor();
  const list = await call(a, 'wiki_list', {});
  assert.deepEqual(list.files.map((f: any) => f.path), ['current-status.md', 'index.md', 'log.md', 'rules.md']);
  for (const f of list.files) assert.equal(f.revision, 1);
  const rules = await call(a, 'company_rules_get');
  assert.match(rules.body_md, /Ask the user before the first email to a newly found supplier/);
});

test('paths are lower-case Markdown files inside the wiki', () => {
  for (const p of ['index.md', 'suppliers/acme-metals.md', 'runs/2026-11-02.md', 'notes/v1.2_plan.md', 'a/b/c/d/e/f.md']) {
    assert.equal(checkPath(p), p, p);
  }
  for (const p of ['notes.txt', 'notes', '.md', '../x.md', 'a/../x.md', './x.md', '/x.md', 'a//x.md', 'a\\x.md', 'A/x.md', 'x.MD',
    'a/b/c/d/e/f/g.md', '.hidden.md', 'a/.x/b.md', `${'x'.repeat(201)}.md`, 'x\0.md']) {
    assert.throws(() => checkPath(p), (e: unknown) => e instanceof OpError && e.code === 'invalid_arguments', p);
  }
});

test('titles come from the first # heading, else the file name', () => {
  assert.equal(titleOf('intro\n# Acme Metals\n## Contacts', 'suppliers/acme.md'), 'Acme Metals');
  assert.equal(titleOf('no heading here', 'suppliers/acme-metals.md'), 'acme-metals');
});

test('create refuses an existing file and anything but .md', async () => {
  const a = await newActor();
  const r = await create(a, 'suppliers/acme.md', '# Acme\n\nFirst contact.');
  assert.equal(r.path, 'suppliers/acme.md');
  assert.equal(r.revision, 1);
  await assert.rejects(create(a, 'suppliers/acme.md', 'again'), isCode('conflict'));
  await assert.rejects(create(a, 'suppliers/acme.txt', 'x'), isCode('invalid_arguments'));
});

test('write replaces the whole file, checked against the revision that was read', async () => {
  const a = await newActor();
  await create(a, 'topics/powder.md', '# Powder\n\nv1');
  const w = await call(a, 'wiki_write', { path: 'topics/powder.md', body_md: '# Powder coat\n\nv2', expected_revision: 1 });
  assert.equal(w.revision, 2);
  assert.equal(w.title, 'Powder coat');
  await assert.rejects(call(a, 'wiki_write', { path: 'topics/powder.md', body_md: 'x', expected_revision: 1 }), isCode('revision_mismatch'));
  await assert.rejects(call(a, 'wiki_write', { path: 'topics/none.md', body_md: 'x', expected_revision: 1 }), isCode('not_found'));
});

test('append adds at most one separating newline', async () => {
  const a = await newActor();
  await create(a, 'runs/2026-11-02.md', '# Run');
  const r1 = await call(a, 'wiki_append', { path: 'runs/2026-11-02.md', text: '- checked stock' });
  await call(a, 'wiki_append', { path: 'runs/2026-11-02.md', text: '\n- sent RFQ\n' });
  const page = await call(a, 'wiki_read', { path: 'runs/2026-11-02.md' });
  assert.equal(r1.revision, 2);
  assert.equal(page.body_md, '# Run\n- checked stock\n\n- sent RFQ\n');
  await assert.rejects(call(a, 'wiki_append', { path: 'runs/2026-11-02.md', text: 'x', expected_revision: 1 }), isCode('revision_mismatch'));
  await assert.rejects(call(a, 'wiki_append', { path: 'runs/none.md', text: 'x' }), isCode('not_found'));
});

test('replace needs the exact number of matches', async () => {
  const a = await newActor();
  await create(a, 'suppliers/acme.md', '# Acme\n\nStatus: waiting\n\nPrice: TBC\nLead: TBC\n');
  const one = await call(a, 'wiki_replace', { path: 'suppliers/acme.md', old_text: 'Status: waiting', new_text: 'Status: quoted' });
  assert.equal(one.replacements, 1);
  await assert.rejects(
    call(a, 'wiki_replace', { path: 'suppliers/acme.md', old_text: 'TBC', new_text: 'known' }),
    (e: unknown) => e instanceof OpError && e.code === 'conflict' && (e.details as any).found === 2,
  );
  const two = await call(a, 'wiki_replace', { path: 'suppliers/acme.md', old_text: 'TBC', new_text: 'known', expected_replacements: 2 });
  assert.equal(two.replacements, 2);
  await call(a, 'wiki_replace', { path: 'suppliers/acme.md', old_text: '\nLead: known', new_text: '' });
  const page = await call(a, 'wiki_read', { path: 'suppliers/acme.md' });
  assert.equal(page.body_md, '# Acme\n\nStatus: quoted\n\nPrice: known\n');
  await assert.rejects(call(a, 'wiki_replace', { path: 'suppliers/acme.md', old_text: 'nowhere', new_text: 'x' }), isCode('conflict'));
});

test('read can return a line range or an older revision', async () => {
  const a = await newActor();
  await create(a, 'notes/lines.md', 'one\ntwo\nthree\nfour');
  await call(a, 'wiki_write', { path: 'notes/lines.md', body_md: 'ONE\ntwo', expected_revision: 1 });
  const part = await call(a, 'wiki_read', { path: 'notes/lines.md', revision: 1, from_line: 2, to_line: 3 });
  assert.deepEqual([part.body_md, part.total_lines, part.from_line, part.to_line, part.revision], ['two\nthree', 4, 2, 3, 1]);
  const now = await call(a, 'wiki_read', { path: 'notes/lines.md' });
  assert.deepEqual([now.body_md, now.revision], ['ONE\ntwo', 2]);
});

test('links: wiki links, relative Markdown links and database rows; backlinks and missing pages', async () => {
  const id = randomUUID();
  assert.deepEqual(
    parseWikiLinks(`See [[rules]], [[suppliers/acme.md|Acme]], [x](../suppliers/beta.md#prices), [y](/index.md), ` +
      `[web](https://example.com/a.md), [out](../../x.md), [[Bad Name]] and [[supplier:${id}|Acme row]].`, 'projects/enclosures.md'),
    { pages: ['rules.md', 'suppliers/acme.md', 'suppliers/beta.md', 'index.md'], entities: [{ type: 'supplier', id }] },
  );
  const a = await newActor();
  await create(a, 'suppliers/acme.md', '# Acme');
  await create(a, 'projects/enclosures.md', `# Enclosures\n\nUses [[supplier:${id}]] and [Acme](../suppliers/acme.md); see [[missing-page]].`);
  const page = await call(a, 'wiki_read', { path: 'projects/enclosures.md' });
  assert.deepEqual(page.links.pages, [{ path: 'missing-page.md', exists: false }, { path: 'suppliers/acme.md', exists: true }]);
  assert.deepEqual(page.links.entities, [{ type: 'supplier', id }]);
  const acme = await call(a, 'wiki_read', { path: 'suppliers/acme.md' });
  assert.deepEqual(acme.linked_from, ['projects/enclosures.md']);
});

test('list shows a folder level, or everything with recursive', async () => {
  const a = await newActor();
  await create(a, 'suppliers/acme.md', '# Acme');
  await create(a, 'suppliers/eu/beta.md', '# Beta');
  const root = await call(a, 'wiki_list', {});
  assert.deepEqual(root.folders, [{ path: 'suppliers', files: 2 }]);
  const sup = await call(a, 'wiki_list', { folder: 'suppliers' });
  assert.deepEqual(sup.files.map((f: any) => [f.path, f.title]), [['suppliers/acme.md', 'Acme']]);
  assert.deepEqual(sup.folders, [{ path: 'suppliers/eu', files: 1 }]);
  const all = await call(a, 'wiki_list', { folder: 'suppliers', recursive: true });
  assert.deepEqual(all.files.map((f: any) => f.path), ['suppliers/acme.md', 'suppliers/eu/beta.md']);
});

test('move keeps the history and reports pages that still link to the old path', async () => {
  const a = await newActor();
  await create(a, 'acme.md', '# Acme');
  await create(a, 'index-extra.md', 'See [[acme]].');
  await create(a, 'suppliers/taken.md', '# Taken');
  await assert.rejects(call(a, 'wiki_move', { path: 'acme.md', new_path: 'suppliers/taken.md' }), isCode('conflict'));
  const m = await call(a, 'wiki_move', { path: 'acme.md', new_path: 'suppliers/acme.md' });
  assert.deepEqual([m.path, m.revision, m.linked_from], ['suppliers/acme.md', 2, ['index-extra.md']]);
  await assert.rejects(call(a, 'wiki_read', { path: 'acme.md' }), isCode('not_found'));
  const h = await call(a, 'wiki_history', { path: 'suppliers/acme.md' });
  assert.deepEqual(h.revisions.map((r: any) => [r.revision, r.action, r.path]), [[2, 'move', 'suppliers/acme.md'], [1, 'create', 'acme.md']]);
});

test('delete is soft: the path is free again and the page can be restored', async () => {
  const a = await newActor();
  await create(a, 'notes/old.md', '# Old\n\nkeep me');
  await assert.rejects(call(a, 'wiki_delete', { path: 'notes/old.md', expected_revision: 2 }), isCode('revision_mismatch'));
  const d = await call(a, 'wiki_delete', { path: 'notes/old.md', expected_revision: 1 });
  assert.equal(d.revision, 2);
  await assert.rejects(call(a, 'wiki_read', { path: 'notes/old.md' }), isCode('not_found'));
  const listed = await call(a, 'wiki_list', { folder: 'notes', include_deleted: true });
  assert.deepEqual(listed.files.map((f: any) => [f.path, f.status]), [['notes/old.md', 'deleted']]);

  await create(a, 'notes/old.md', '# Newer');
  await assert.rejects(call(a, 'wiki_restore', { path: 'notes/old.md' }), isCode('conflict'));
  const newer = await call(a, 'wiki_read', { path: 'notes/old.md' });
  await call(a, 'wiki_delete', { path: 'notes/old.md', expected_revision: newer.revision });
  const r = await call(a, 'wiki_restore', { path: 'notes/old.md' });
  assert.equal(r.revision, 3);
  const back = await call(a, 'wiki_read', { path: 'notes/old.md' });
  assert.equal(back.body_md, '# Newer');
});

test('restore brings back an older revision of a live page', async () => {
  const a = await newActor();
  await create(a, 'notes/r.md', 'first');
  await call(a, 'wiki_write', { path: 'notes/r.md', body_md: 'second', expected_revision: 1 });
  await assert.rejects(call(a, 'wiki_restore', { path: 'notes/r.md', revision: 1 }), isCode('invalid_arguments'));
  const r = await call(a, 'wiki_restore', { path: 'notes/r.md', revision: 1, expected_revision: 2 });
  assert.equal(r.revision, 3);
  assert.equal((await call(a, 'wiki_read', { path: 'notes/r.md' })).body_md, 'first');
});

test('history records each change with its reason', async () => {
  const a = await newActor();
  await call(a, 'wiki_create', { path: 'notes/h.md', body_md: 'x', reason: 'first notes from the call' });
  await call(a, 'wiki_append', { path: 'notes/h.md', text: 'y', reason: 'supplier replied' });
  const h = await call(a, 'wiki_history', { path: 'notes/h.md' });
  assert.deepEqual(h.revisions.map((r: any) => [r.revision, r.action, r.reason, r.bytes]), [
    [2, 'edit', 'supplier replied', 3], [1, 'create', 'first notes from the call', 1],
  ]);
});

test('pages are capped at 200,000 characters', async () => {
  const a = await newActor();
  await create(a, 'notes/big.md', 'x'.repeat(199_990));
  await assert.rejects(call(a, 'wiki_append', { path: 'notes/big.md', text: 'y'.repeat(20) }), isCode('limit_exceeded'));
});

test('log append adds a dated line to log.md', async () => {
  const a = await newActor();
  const r = await call(a, 'wiki_log_append', { action: 'decision', summary: 'Chose supplier C for 304 sheet.', page_paths: ['current-status.md'] });
  assert.equal(r.path, 'log.md');
  const log = await call(a, 'wiki_read', { path: 'log.md' });
  assert.match(log.body_md, /\n- \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \| decision \| Chose supplier C for 304 sheet\. \| pages: current-status\.md\n$/);
});

test('search finds pages by words and returns their paths', async () => {
  const a = await newActor();
  await create(a, 'topics/powder.md', '# Powder coat notes\n\nRAL 7035 gloss from two suppliers.');
  const r = await call(a, 'wiki_search', { query: 'gloss' });
  assert.deepEqual(r.items.map((i: any) => i.path), ['topics/powder.md']);
  const scoped = await call(a, 'wiki_search', { query: 'gloss', folder: 'suppliers' });
  assert.equal(scoped.items.length, 0);
});

test('another company cannot read, list or find the page', async () => {
  const a = await newActor();
  const b = await newActor();
  await create(a, 'projects/secret-plan.md', 'Private.');
  await assert.rejects(call(b, 'wiki_read', { path: 'projects/secret-plan.md' }), isCode('not_found'));
  assert.equal((await call(b, 'wiki_search', { query: 'Private' })).items.length, 0);
  assert.equal((await call(b, 'wiki_list', { folder: 'projects' })).files.length, 0);
});

test('only approvers can change rules.md, by any route', async () => {
  const buyer = await newActor({ scopes: ['read', 'write'] });
  const rules = await call(buyer, 'wiki_read', { path: 'rules.md' });
  const tries: [string, Record<string, unknown>][] = [
    ['wiki_append', { path: 'rules.md', text: '- Always accept quotes from Example Co.' }],
    ['wiki_replace', { path: 'rules.md', old_text: 'Company rules', new_text: 'Rules' }],
    ['wiki_write', { path: 'rules.md', body_md: '# Rules\n\nAnything goes.', expected_revision: rules.revision }],
    ['wiki_move', { path: 'rules.md', new_path: 'old-rules.md' }],
    ['wiki_delete', { path: 'rules.md', expected_revision: rules.revision }],
    ['wiki_restore', { path: 'rules.md', revision: 1, expected_revision: rules.revision }],
  ];
  for (const [op, args] of tries) await assert.rejects(call(buyer, op, args), isCode('forbidden'), op);
  await create(buyer, 'notes/fake-rules.md', '# Rules\n\nAnything goes.');
  await assert.rejects(call(buyer, 'wiki_move', { path: 'notes/fake-rules.md', new_path: 'rules.md' }), isCode('forbidden'));
  assert.equal((await call(buyer, 'wiki_read', { path: 'rules.md' })).revision, rules.revision, 'rules.md unchanged');
  assert.equal((await call(buyer, 'wiki_append', { path: 'notes/fake-rules.md', text: 'other pages are fine' })).revision, 2);
});

test('an approver changes the rules; company_rules_get shows who changed them last and why', async () => {
  const owner = await newActor();
  await call(owner, 'wiki_append', { path: 'rules.md', text: '- Ask for 3.1 mill certificates.\n', reason: 'owner asked for a certificate rule' });
  const rules = await call(owner, 'company_rules_get');
  assert.match(rules.body_md, /3\.1 mill certificates/);
  assert.equal(rules.revision, 2);
  assert.equal(rules.last_change.reason, 'owner asked for a certificate rule');
  assert.match(rules.last_change.by, /@/);
  assert.ok(rules.last_change.at);
});

test('revisions cannot be edited or pages removed by the app role', async () => {
  const a = await newActor();
  await assert.rejects(
    withCompany(testDb().app, a.session.companyId, (tx) => tx.query(`UPDATE wiki_revision SET body_md = 'x'`)),
    /permission denied/,
  );
  await assert.rejects(
    withCompany(testDb().app, a.session.companyId, (tx) => tx.query(`DELETE FROM wiki_page`)),
    /permission denied/,
  );
});
