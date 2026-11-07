import { parse } from 'libpg-query';
import { deparse } from 'pgsql-deparser';
import { OpError } from '../ops/errors.ts';
import { ALLOWED_FUNCTIONS, ALLOWED_NODES, ALLOWED_TYPES } from './allowlist.ts';

export const MAX_SQL_BYTES = 16_000;
const MAX_NODES = 4000;
const MAX_SELECTS = 20;
const MAX_JOINS = 12;
const MAX_DEPTH = 120;

type Json = Record<string, unknown>;
const reject = (message: string) => new OpError('invalid_arguments', message);
const isNodeKey = (k: string) => /^[A-Z]/.test(k);

function names(list: unknown): string[] {
  return Array.isArray(list) ? list.map((n) => String((n as { String?: { sval?: string } }).String?.sval ?? '')) : [];
}

// Typed struct fields (withClause, typeName, over, alias) come unwrapped in the tree, so their
// contents are checked where their parent node is handled.
function checkTypeName(typeName: unknown): void {
  const tn = (typeName ?? {}) as Json;
  const t = names(tn.names);
  const last = (t[t.length - 1] ?? '').toLowerCase();
  if (!ALLOWED_TYPES.has(last) || t.length > 2 || (t.length === 2 && t[0] !== 'pg_catalog')) {
    throw reject(`Casting to ${t.join('.') || 'that type'} is not allowed.`);
  }
  if (tn.arrayBounds) throw reject('Array casts are not allowed.');
}

// Walks the real Postgres parse tree. Every node type must be allow-listed; functions, casts and
// tables are checked; CTE names are only visible inside the query that defines them.
function check(tree: unknown, tables: ReadonlySet<string>, counters: { nodes: number; selects: number; joins: number }): void {
  const visit = (value: unknown, scope: ReadonlySet<string>, depth: number): void => {
    if (depth > MAX_DEPTH) throw reject('SQL is nested too deeply.');
    if (Array.isArray(value)) {
      for (const v of value) visit(v, scope, depth + 1);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, inner] of Object.entries(value as Json)) {
      if (!isNodeKey(key)) {
        visit(inner, scope, depth + 1);
        continue;
      }
      counters.nodes += 1;
      if (counters.nodes > MAX_NODES) throw reject('SQL is too complex.');
      if (!ALLOWED_NODES.has(key)) throw reject('SQL contains unsupported syntax or functions.');
      const node = (inner ?? {}) as Json;
      let childScope = scope;
      switch (key) {
        case 'SelectStmt': {
          counters.selects += 1;
          if (counters.selects > MAX_SELECTS) throw reject('SQL has too many SELECTs.');
          if (node.intoClause) throw reject('SELECT INTO is not allowed.');
          if (node.lockingClause) throw reject('Locking clauses are not allowed.');
          const raw = node.withClause as Json | undefined;
          const withClause = (raw?.WithClause as Json | undefined) ?? raw;
          if (withClause) {
            if (withClause.recursive) throw reject('Recursive queries are not supported.');
            const ctes = ((withClause.ctes as Json[]) ?? []).map((c) => String(((c.CommonTableExpr ?? c) as Json).ctename ?? ''));
            childScope = new Set([...scope, ...ctes]);
          }
          break;
        }
        case 'TypeCast':
          checkTypeName(node.typeName);
          break;
        case 'JoinExpr':
          counters.joins += 1;
          if (counters.joins > MAX_JOINS) throw reject('SQL has too many joins.');
          break;
        case 'RangeVar': {
          if (node.catalogname || (node.schemaname && node.schemaname !== 'public')) throw reject('Only tables of this database can be read.');
          const rel = String(node.relname ?? '');
          if (!(scope.has(rel) && !node.schemaname) && !tables.has(rel)) throw reject(`Table ${rel} is not readable.`);
          break;
        }
        case 'FuncCall': {
          const fn = names(node.funcname);
          if (fn.length !== 1 || !ALLOWED_FUNCTIONS.has(fn[0]!.toLowerCase())) throw reject(`Function ${fn.join('.')} is not allowed.`);
          if (node.func_variadic) throw reject('VARIADIC calls are not allowed.');
          break;
        }
        case 'TypeName':
          checkTypeName(node);
          break;
        default:
          break;
      }
      visit(node, childScope, depth + 1);
    }
  };
  visit(tree, new Set(), 0);
}

function literalInt(node: unknown): number | null {
  const c = (node as { A_Const?: { ival?: { ival?: number } } } | undefined)?.A_Const;
  if (!c || !('ival' in c)) return null;
  return c.ival?.ival ?? 0;
}

export type ValidatedSql = { sql: string; fingerprint: string };

// Validates one read-only SELECT and returns regenerated SQL with LIMIT max_rows + 1.
export async function validateSelect(sql: string, opts: { maxRows: number; tables: ReadonlySet<string> }): Promise<string> {
  if (typeof sql !== 'string' || !sql.trim()) throw reject('sql is required.');
  if (Buffer.byteLength(sql, 'utf8') > MAX_SQL_BYTES) throw reject('SQL is longer than 16 KB.');
  if (sql.includes('\0')) throw reject('SQL contains a NUL character.');
  if (sql.includes('--') || sql.includes('/*')) throw reject('SQL comments are not allowed.');
  let tree: { stmts?: { stmt: Json }[] };
  try {
    tree = await parse(sql);
  } catch {
    throw reject('SQL could not be parsed.');
  }
  if (!tree.stmts || tree.stmts.length !== 1) throw reject('Exactly one SELECT statement is allowed.');
  const stmt = tree.stmts[0]!.stmt;
  const select = stmt.SelectStmt as Json | undefined;
  if (!select || Object.keys(stmt).length !== 1) throw reject('Only SELECT statements are allowed.');
  check(stmt, opts.tables, { nodes: 0, selects: 0, joins: 0 });

  const cap = opts.maxRows + 1;
  if (select.limitCount !== undefined) {
    const n = literalInt(select.limitCount);
    if (n === null) throw reject('LIMIT must be a whole number.');
    if (n > cap) select.limitCount = { A_Const: { ival: { ival: cap } } };
  } else {
    select.limitCount = { A_Const: { ival: { ival: cap } } };
    select.limitOption = 'LIMIT_OPTION_COUNT';
  }
  if (select.limitOffset !== undefined && literalInt(select.limitOffset) === null) throw reject('OFFSET must be a whole number.');
  try {
    return await deparse(tree as never);
  } catch {
    throw reject('SQL could not be regenerated safely.');
  }
}
