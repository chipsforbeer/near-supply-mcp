import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defineOp } from '../define.ts';
import { OpError } from '../errors.ts';
import { setList } from '../suppliers/common.ts';
import { DOC_KINDS, LINK_TYPES, addLinks, insertDocument, linkSchema } from './ingest.ts';
import { isoDate, limit } from '../schemas.ts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const location = z.string().trim().min(1).max(2000);
const isUrl = (s: string) => /^https?:\/\//i.test(s);

export const documentGet = defineOp({
  name: 'document_get',
  summary:
    'A document\'s details, where the file is (location: a path on the machine of the person who saved it, or a link), what it is ' +
    'linked to, and the text saved with it. Long texts come in chunks: pass offset to read on.',
  kind: 'read',
  scope: 'read',
  input: z
    .object({ document_id: z.uuid(), offset: z.number().int().min(0).default(0), max_chars: z.number().int().min(1).max(200_000).default(50_000) })
    .strict(),
  async handler(args, tx) {
    const r = await tx.query(
      `SELECT d.id AS document_id, d.kind, d.title, d.location, d.source, d.source_ref, d.mime, d.size_bytes, d.sha256, d.text_source,
              d.valid_until, d.captured_at,
              json_build_object('user_id', u.id, 'display_name', u.display_name, 'email', u.email) AS saved_by,
              length(coalesce(d.text_content, '')) AS text_length,
              substr(coalesce(d.text_content, ''), $2 + 1, $3) AS text
         FROM document d LEFT JOIN app_user u ON u.id = d.captured_by
        WHERE d.id = $1`,
      [args.document_id, args.offset, args.max_chars],
    );
    const doc = r.rows[0];
    if (!doc) throw new OpError('not_found', 'Document not found.');
    const links = await tx.query('SELECT entity_type, entity_id, role FROM document_link WHERE document_id = $1', [doc.document_id]);
    const next = args.offset + args.max_chars;
    return { ...doc, next_offset: next < doc.text_length ? next : null, links: links.rows };
  },
});

export const documentLink = defineOp({
  name: 'document_link',
  summary: 'Attach an existing document to an item, spec, supplier, contact, RFQ, quote, lot, PO, production run, wiki page, interaction or evaluation.',
  kind: 'write',
  scope: 'write',
  input: z.object({ document_id: z.uuid(), entity_type: z.enum(LINK_TYPES), entity_id: z.uuid(), role: z.string().max(120).optional() }).strict(),
  async handler(args, tx) {
    const d = await tx.query('SELECT 1 FROM document WHERE id = $1', [args.document_id]);
    if (!d.rowCount) throw new OpError('not_found', 'Document not found.');
    await addLinks(tx, args.document_id, [{ entity_type: args.entity_type, entity_id: args.entity_id, role: args.role }]);
    return { linked: true };
  },
});

export const documentSearch = defineOp({
  name: 'document_search',
  summary: 'Full-text search across document titles and saved text, with a short highlighted snippet and where each file is.',
  kind: 'read',
  scope: 'read',
  input: z.object({ query: z.string().trim().min(1).max(200), kind: z.enum(DOC_KINDS).optional(), limit: limit(50, 10) }).strict(),
  async handler(args, tx) {
    const r = await tx.query(
      `SELECT d.id AS document_id, d.kind, d.title, d.location, d.valid_until, d.captured_at,
              ts_headline('simple', left(coalesce(d.text_content, d.title), 100000), q, 'MaxFragments=2, MaxWords=25, MinWords=8') AS snippet,
              ts_rank(d.search, q) AS rank
         FROM document d, websearch_to_tsquery('simple', $1) q
        WHERE d.search @@ q AND ($2::text IS NULL OR d.kind = $2)
        ORDER BY rank DESC, d.captured_at DESC LIMIT $3`,
      [args.query, args.kind ?? null, args.limit],
    );
    return { items: r.rows };
  },
});

export const documentsExpiring = defineOp({
  name: 'documents_expiring',
  summary: 'Certificates, SDS and other documents whose valid_until is within the next N days (or already past), with what they belong to and where each file is.',
  kind: 'read',
  scope: 'read',
  input: z.object({ within_days: z.number().int().min(1).max(365).default(60) }).strict(),
  async handler(args, tx) {
    const r = await tx.query(
      `SELECT d.id AS document_id, d.kind, d.title, d.location, d.valid_until, (d.valid_until < current_date) AS expired,
              coalesce((SELECT json_agg(json_build_object('entity_type', l.entity_type, 'entity_id', l.entity_id, 'role', l.role))
                          FROM document_link l WHERE l.document_id = d.id), '[]'::json) AS links
         FROM document d
        WHERE d.valid_until IS NOT NULL AND d.valid_until <= current_date + $1::int
        ORDER BY d.valid_until`,
      [args.within_days],
    );
    return { items: r.rows };
  },
});

export const documentCaptureText = defineOp({
  name: 'document_capture_text',
  summary:
    'Keep text you already have as a document (an email body, a short reply, notes from a call) with where it came from (mail provider + message id). For a file, use document_add.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      title: z.string().trim().min(1).max(300),
      kind: z.enum(DOC_KINDS),
      text: z.string().min(1).max(200_000),
      source: z.enum(['mail', 'note']),
      source_ref: z.string().max(1000).optional(),
      valid_until: isoDate.optional(),
      links: z.array(linkSchema).max(20).optional(),
    })
    .strict(),
  async handler(args, tx, ctx) {
    return insertDocument(tx, ctx, {
      kind: args.kind, title: args.title, source: args.source, location: null, sha256: sha256(args.text),
      size: Buffer.byteLength(args.text, 'utf8'), mime: 'text/plain', text: args.text,
      source_ref: args.source_ref, valid_until: args.valid_until, links: args.links,
    });
  },
});

export const documentAdd = defineOp({
  name: 'document_add',
  summary:
    'Keep a file as a document without sending it: its location (the full path on this computer, or a link), what it is, and the ' +
    'text you read from it that matters (prices, values, dates), so it can be searched and cited. The server stores no files; ' +
    'open the file at its location with your own tools. Pass sha256 (and size_bytes) of the file when you can: the same file ' +
    'saved twice, or the same location, returns the existing document.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      title: z.string().trim().min(1).max(300),
      kind: z.enum(DOC_KINDS),
      location,
      text: z.string().min(1).max(200_000).optional(),
      sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).transform((s) => s.toLowerCase()).optional(),
      size_bytes: z.number().int().min(0).optional(),
      mime: z.string().max(200).optional(),
      source_ref: z.string().max(1000).optional(),
      valid_until: isoDate.optional(),
      links: z.array(linkSchema).max(20).optional(),
    })
    .strict(),
  async handler(args, tx, ctx) {
    return insertDocument(tx, ctx, {
      kind: args.kind, title: args.title, source: isUrl(args.location) ? 'url' : 'file', location: args.location,
      sha256: args.sha256 ?? null, size: args.size_bytes ?? null, mime: args.mime ?? null, text: args.text ?? null,
      source_ref: args.source_ref, valid_until: args.valid_until, links: args.links,
    });
  },
});

const UPDATE_COLUMNS: Record<string, string> = {
  title: 'title', kind: 'kind', location: 'location', text: 'text_content', text_source: 'text_source', valid_until: 'valid_until',
};

export const documentUpdate = defineOp({
  name: 'document_update',
  summary:
    'Change a document: a new location when the file moved, the title or kind, the saved text (replaces it), or valid_until. ' +
    'Fields left out keep their value; null clears location or valid_until.',
  kind: 'write',
  scope: 'write',
  input: z
    .object({
      document_id: z.uuid(),
      title: z.string().trim().min(1).max(300).optional(),
      kind: z.enum(DOC_KINDS).optional(),
      location: location.nullable().optional(),
      text: z.string().min(1).max(200_000).optional(),
      valid_until: isoDate.nullable().optional(),
    })
    .strict(),
  async handler(args, tx) {
    const fields: Record<string, unknown> = { ...args, text_source: args.text === undefined ? undefined : 'claude' };
    const set = setList(UPDATE_COLUMNS, fields, 2);
    if (!set.sql.length) throw new OpError('invalid_arguments', 'Pass at least one field to change.');
    const r = await tx.query(
      `UPDATE document SET ${set.sql.join(', ')} WHERE id = $1 RETURNING id AS document_id, title, kind, location, text_source, valid_until`,
      [args.document_id, ...set.values],
    );
    if (!r.rows[0]) throw new OpError('not_found', 'Document not found.');
    return r.rows[0];
  },
});
