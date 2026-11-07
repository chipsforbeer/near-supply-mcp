import { z } from 'zod';
import { ops } from './catalogue.ts';
import type { Scope } from './types.ts';

type JsonSchema = Record<string, unknown> & { properties?: Record<string, unknown>; required?: string[] };

const WRITE_FIELDS = {
  request_key: {
    type: 'string', minLength: 8, maxLength: 128,
    description: 'Unique per write. Reuse the same key only to retry the same write.',
  },
  reason: {
    type: 'string', minLength: 1, maxLength: 500,
    description: 'Why this change is being made. Stored in the audit log and visible to the company; no secrets.',
  },
};

// The operation catalogue that search and execute see: only what the caller's scopes allow.
export function buildOpenApi(scopes: Scope[]): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const def of [...ops.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (def.hidden || !scopes.includes(def.scope)) continue;
    const schema = z.toJSONSchema(def.input, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
    delete schema.$schema;
    if (def.kind === 'write') {
      schema.properties = { ...(schema.properties ?? {}), ...WRITE_FIELDS };
      schema.required = [...(schema.required ?? []), 'request_key', 'reason'];
    }
    paths[`/operations/${def.name}`] = {
      post: {
        operationId: def.name,
        summary: def.summary,
        'x-kind': def.kind,
        'x-scope': def.scope,
        requestBody: { required: true, content: { 'application/json': { schema } } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'supplier-inventory operations', version: '1' },
    paths,
  };
}
