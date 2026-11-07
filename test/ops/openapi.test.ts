import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { buildOpenApi } from '../../src/ops/openapi.ts';
import { registerTestOp } from '../../src/ops/catalogue.ts';
import { defineOp } from '../../src/ops/define.ts';

registerTestOp(
  defineOp({
    name: 'test_catalogue_write',
    summary: 'test only',
    kind: 'write',
    scope: 'write',
    input: z.object({ value: z.string() }).strict(),
    async handler() {
      return {};
    },
  }),
);

test('read-only scopes see no write operations', () => {
  const spec = buildOpenApi(['read']) as { paths: Record<string, any> };
  assert.ok(spec.paths['/operations/whoami']);
  assert.equal(spec.paths['/operations/test_catalogue_write'], undefined);
});

test('writes require request_key and reason', () => {
  const spec = buildOpenApi(['read', 'write']) as { paths: Record<string, any> };
  const schema = spec.paths['/operations/test_catalogue_write'].post.requestBody.content['application/json'].schema;
  assert.ok(schema.required.includes('request_key'));
  assert.ok(schema.required.includes('reason'));
  assert.ok(schema.required.includes('value'));
});
