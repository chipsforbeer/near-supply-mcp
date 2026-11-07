import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { withCompany } from '../../db/pool.ts';
import { mapDbError } from '../run.ts';
import { validateSelect } from '../../sql/guard.ts';
import { READABLE_TABLES } from '../../sql/allowlist.ts';

const MAX_RESULT_CHARS = 1_000_000;

export default defineOp({
  name: 'sql_query',
  summary:
    'Run your own read-only SQL (one SELECT; joins, CTEs, aggregates and window functions allowed) over this company\'s tables. Only this company\'s rows are visible. Returns columns and rows (max_rows, default 100, up to 1000) and whether the result was truncated.',
  kind: 'read',
  scope: 'read',
  input: z.object({ sql: z.string().min(1).max(16_000), max_rows: z.number().int().min(1).max(1000).default(100) }).strict(),
  async handler(args, _tx, ctx) {
    const safe = await validateSelect(args.sql, { maxRows: args.max_rows, tables: READABLE_TABLES });
    const result = await withCompany(
      ctx.db.read,
      ctx.session.companyId,
      (tx) => tx.query({ text: safe, rowMode: 'array' }),
      { readOnly: true, statementTimeoutMs: 10_000 },
    ).catch((e: unknown) => {
      const mapped = mapDbError(e);
      if (mapped instanceof OpError) throw mapped;
      const code = (e as { code?: string }).code ?? '';
      if (code === '42501') throw new OpError('forbidden', 'That table or column is not readable.');
      if (/^42/.test(code)) throw new OpError('invalid_arguments', 'The query refers to something that does not exist or is used incorrectly.');
      throw new OpError('internal', 'The query failed; details withheld.');
    });
    const columns = result.fields.map((f) => f.name);
    let rows = result.rows as unknown[][];
    let truncated = rows.length > args.max_rows;
    if (truncated) rows = rows.slice(0, args.max_rows);
    let size = 0;
    const kept: unknown[][] = [];
    for (const row of rows) {
      size += JSON.stringify(row).length;
      if (size > MAX_RESULT_CHARS) {
        truncated = true;
        break;
      }
      kept.push(row);
    }
    return { columns, rows: kept, row_count: kept.length, truncated };
  },
});
