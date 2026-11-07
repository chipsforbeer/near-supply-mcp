import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { resetTestDatabase } from '../helpers/db.ts';
import { newActor, call } from '../helpers/ops.ts';
import { OpError } from '../../src/ops/errors.ts';
import { ops } from '../../src/ops/catalogue.ts';
import { GUIDES } from '../../src/ops/guides/load.ts';

before(resetTestDatabase);

// Words in backticks that are neither operations, arguments nor argument values: result
// fields, file names. Anything else snake_case must be real.
const NOT_ARGUMENTS = new Set([
  'saved_by', 'suggest_display', 'linked_from', 'needs_lead_time', 'needs_usage_history',
  'row_count', 'current-status', 'stock_balance', 'rfq-ss304-2026-11-03',
  // error codes (src/ops/errors.ts)
  'invalid_arguments', 'not_found', 'revision_mismatch', 'request_key_reused', 'limit_exceeded',
]);

function vocabulary(): Set<string> {
  const words = new Set<string>();
  const walk = (s: unknown) => {
    if (!s || typeof s !== 'object') return;
    const o = s as Record<string, unknown>;
    if (Array.isArray(o.enum)) for (const v of o.enum) if (typeof v === 'string') words.add(v);
    if (o.properties && typeof o.properties === 'object') {
      for (const [k, v] of Object.entries(o.properties)) {
        words.add(k);
        walk(v);
      }
    }
    for (const key of ['items', 'anyOf', 'oneOf', 'allOf']) {
      const v = o[key];
      if (Array.isArray(v)) v.forEach(walk);
      else walk(v);
    }
  };
  for (const d of ops.values()) {
    words.add(d.name);
    walk(z.toJSONSchema(d.input, { io: 'input', unrepresentable: 'any' }));
  }
  return words;
}

test('guide_list names every module in order with a title, summary and its operations', async () => {
  const a = await newActor();
  const r = await call(a, 'guide_list');
  assert.deepEqual(r.guides.map((g: any) => g.module), [
    'basics', 'inventory', 'production', 'suppliers', 'outreach', 'buying', 'specs', 'documents', 'wiki', 'sql', 'access',
  ]);
  for (const g of r.guides) {
    assert.ok(g.title && g.summary, g.module);
    assert.ok(g.operations.length > 0, `${g.module} lists operations`);
  }
  assert.ok(r.guides.find((g: any) => g.module === 'buying').operations.includes('po_payment_instruction'));
});

test('guide_get returns one guide; an unknown module is refused', async () => {
  const a = await newActor({ scopes: ['read'] });
  const g = await call(a, 'guide_get', { module: 'buying' });
  assert.equal(g.module, 'buying');
  assert.match(g.body_md, /^# Buying/);
  await assert.rejects(call(a, 'guide_get', { module: 'nothing' }), (e: unknown) => e instanceof OpError && e.code === 'invalid_arguments');
});

test('every operation is covered by a guide', () => {
  const text = GUIDES.map((g) => g.body_md).join('\n');
  const missing = [...ops.values()].filter((d) => !d.hidden && !text.includes(`\`${d.name}\``)).map((d) => d.name);
  assert.deepEqual(missing, []);
});

test('guides only name real operations, arguments and values', () => {
  const known = vocabulary();
  const problems: string[] = [];
  for (const g of GUIDES) {
    for (const m of g.body_md.matchAll(/api\.call\('([a-z_]+)'/g)) if (!ops.has(m[1]!)) problems.push(`${g.module}: api.call ${m[1]}`);
    for (const m of g.body_md.matchAll(/`([a-z][a-z0-9]*(?:[_-][a-z0-9]+)+)`/g)) {
      const w = m[1]!;
      if (!known.has(w) && !NOT_ARGUMENTS.has(w)) problems.push(`${g.module}: ${w}`);
    }
  }
  assert.deepEqual(problems, []);
});
