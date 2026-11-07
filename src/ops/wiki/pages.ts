import type pg from 'pg';
import { OpError } from '../errors.ts';
import { viaAgent, type OpContext } from '../types.ts';
import { parseWikiLinks } from './links.ts';
import { titleOf } from './paths.ts';

export const MAX_PAGE_CHARS = 200_000;
export const ENTITY_TYPES = ['supplier', 'item', 'rfq', 'quote', 'po', 'lot', 'doc'] as const;

export type WikiActor = { userId: string | null; viaAgent: boolean; reason: string | null; mayChangeRules: boolean };

// Claude reads rules.md first and follows it, so only someone with approve may change it,
// whichever operation is used (create, edit, move to or from, delete, restore).
const RULES_PAGES = new Set(['rules.md']);

function guardRules(actor: WikiActor, ...paths: string[]): void {
  if (!actor.mayChangeRules && paths.some((p) => RULES_PAGES.has(p))) {
    throw new OpError('forbidden', 'Only someone with the approve permission can change rules.md (the company rules); ask an owner or approver.');
  }
}
export type WikiAction = 'create' | 'edit' | 'move' | 'delete' | 'restore';
export type Page = {
  id: string;
  path: string;
  title: string;
  body_md: string;
  revision: number;
  status: 'active' | 'deleted';
  entity_type: string | null;
  entity_id: string | null;
  updated_at: string;
};
export type PageResult = { path: string; title: string; revision: number; status: string; bytes: number };

const COLS = 'id, path, title, body_md, revision, status, entity_type, entity_id, updated_at';

export function wikiActor(ctx: OpContext): WikiActor {
  return {
    userId: ctx.session.userId,
    viaAgent: viaAgent(ctx.session),
    reason: ctx.reason ?? null,
    mayChangeRules: ctx.session.scopes.includes('approve'),
  };
}

// The live page at a path; locked when it is about to change.
export async function livePage(tx: pg.PoolClient, path: string, lock = false): Promise<Page | null> {
  const r = await tx.query(`SELECT ${COLS} FROM wiki_page WHERE path = $1 AND status = 'active'${lock ? ' FOR UPDATE' : ''}`, [path]);
  return r.rows[0] ?? null;
}

export async function requireLivePage(tx: pg.PoolClient, path: string, lock = true): Promise<Page> {
  const page = await livePage(tx, path, lock);
  if (!page) throw new OpError('not_found', `No page ${path}; wiki_list shows what exists, wiki_create makes a new one.`);
  return page;
}

// The most recently deleted page at a path.
export async function deletedPage(tx: pg.PoolClient, path: string, lock = false): Promise<Page | null> {
  const r = await tx.query(
    `SELECT ${COLS} FROM wiki_page WHERE path = $1 AND status = 'deleted' ORDER BY updated_at DESC, id LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [path],
  );
  return r.rows[0] ?? null;
}

export function checkRevision(page: Page, expected: number | undefined): void {
  if (expected !== undefined && page.revision !== expected) {
    throw new OpError('revision_mismatch', `${page.path} is at revision ${page.revision}, not ${expected}; read it again first.`);
  }
}

function checkSize(body: string): void {
  if (body.length > MAX_PAGE_CHARS) {
    throw new OpError('limit_exceeded', `A page holds at most ${MAX_PAGE_CHARS} characters (this would be ${body.length}); split it into more pages.`);
  }
}

function result(p: Pick<Page, 'path' | 'title' | 'revision' | 'status' | 'body_md'>): PageResult {
  return { path: p.path, title: p.title, revision: p.revision, status: p.status, bytes: Buffer.byteLength(p.body_md) };
}

async function recordRevision(tx: pg.PoolClient, page: Page, action: WikiAction, actor: WikiActor): Promise<void> {
  await tx.query(
    `INSERT INTO wiki_revision (page_id, revision, path, title, body_md, action, reason, author_user_id, via_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [page.id, page.revision, page.path, page.title, page.body_md, action, actor.reason, actor.userId, actor.viaAgent],
  );
}

// Outgoing links are kept for backlinks; a deleted page links nowhere.
async function refreshLinks(tx: pg.PoolClient, page: Page): Promise<void> {
  await tx.query('DELETE FROM wiki_link WHERE from_page_id = $1', [page.id]);
  if (page.status !== 'active') return;
  const links = parseWikiLinks(page.body_md, page.path);
  for (const to of links.pages) {
    if (to !== page.path) await tx.query('INSERT INTO wiki_link (from_page_id, to_path) VALUES ($1, $2)', [page.id, to]);
  }
  for (const e of links.entities) {
    await tx.query('INSERT INTO wiki_link (from_page_id, to_entity_type, to_entity_id) VALUES ($1, $2, $3)', [page.id, e.type, e.id]);
  }
}

export async function createPage(
  tx: pg.PoolClient,
  input: { path: string; body_md: string; entity_type?: string | null; entity_id?: string | null },
  actor: WikiActor,
): Promise<PageResult> {
  guardRules(actor, input.path);
  checkSize(input.body_md);
  const r = await tx.query(
    `INSERT INTO wiki_page (path, title, body_md, entity_type, entity_id, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (company_id, path) WHERE status = 'active' DO NOTHING
     RETURNING ${COLS}`,
    [input.path, titleOf(input.body_md, input.path), input.body_md, input.entity_type ?? null, input.entity_id ?? null, actor.userId],
  );
  const page: Page | undefined = r.rows[0];
  if (!page) throw new OpError('conflict', `${input.path} already exists; change it with wiki_write, wiki_replace or wiki_append.`);
  await recordRevision(tx, page, 'create', actor);
  await refreshLinks(tx, page);
  return result(page);
}

export type PageChange = {
  body_md?: string;
  path?: string;
  status?: 'active' | 'deleted';
  entity_type?: string | null;
  entity_id?: string | null;
};

// Every later change: one new revision with what happened and why. The page must be locked.
export async function changePage(tx: pg.PoolClient, page: Page, change: PageChange, action: WikiAction, actor: WikiActor): Promise<PageResult> {
  const body = change.body_md ?? page.body_md;
  const path = change.path ?? page.path;
  const status = change.status ?? page.status;
  guardRules(actor, page.path, path);
  checkSize(body);
  if (status === 'active' && (path !== page.path || page.status !== 'active') && (await livePage(tx, path))) {
    throw new OpError('conflict', `${path} already exists; move or delete that page first.`);
  }
  const entityType = change.entity_type !== undefined ? change.entity_type : page.entity_type;
  const entityId = change.entity_id !== undefined ? change.entity_id : page.entity_id;
  const r = await tx.query(
    `UPDATE wiki_page
        SET path = $3, title = $4, body_md = $5, status = $6, entity_type = $7, entity_id = $8,
            revision = revision + 1, updated_at = now(), updated_by = $9
      WHERE id = $1 AND revision = $2
      RETURNING ${COLS}`,
    [page.id, page.revision, path, titleOf(body, path), body, status, entityType, entityId, actor.userId],
  );
  const updated: Page | undefined = r.rows[0];
  if (!updated) throw new OpError('revision_mismatch', `${page.path} changed while this edit ran; read it again first.`);
  await recordRevision(tx, updated, action, actor);
  await refreshLinks(tx, updated);
  return result(updated);
}

// Live pages that link to a path.
export async function linkedFrom(tx: pg.PoolClient, path: string): Promise<string[]> {
  const r = await tx.query(
    `SELECT DISTINCT p.path FROM wiki_link l JOIN wiki_page p ON p.id = l.from_page_id
      WHERE l.to_path = $1 AND p.status = 'active' ORDER BY p.path`,
    [path],
  );
  return r.rows.map((x) => x.path);
}

// Appends with at most one separating newline.
export function appendText(before: string, text: string): string {
  return `${before}${before && !before.endsWith('\n') && text ? '\n' : ''}${text}`;
}
