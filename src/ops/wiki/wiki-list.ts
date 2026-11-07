import { z } from 'zod';
import { defineOp } from '../define.ts';
import { inFolder, wikiFolder } from './paths.ts';

const MAX_FILES = 500;

export default defineOp({
  name: 'wiki_list',
  summary: 'List the wiki like a folder: the .md files and subfolders at one level, or every file below it with recursive.',
  kind: 'read',
  scope: 'read',
  input: z
    .object({
      folder: wikiFolder.default(''),
      recursive: z.boolean().default(false),
      include_deleted: z.boolean().default(false),
    })
    .strict(),
  async handler(args, tx) {
    const r = await tx.query(
      `SELECT path, title, revision, status, entity_type, entity_id, updated_at, octet_length(body_md) AS bytes
         FROM wiki_page
        WHERE ($1 = '' OR left(path, length($1) + 1) = $1 || '/') AND ($2 OR status = 'active')
        ORDER BY path, status, updated_at DESC`,
      [args.folder, args.include_deleted],
    );
    const depth = args.folder === '' ? 0 : args.folder.split('/').length;
    const files = [];
    const folders = new Map<string, number>();
    for (const row of r.rows) {
      if (!inFolder(row.path, args.folder)) continue;
      const parts = row.path.split('/');
      if (args.recursive || parts.length === depth + 1) files.push(row);
      if (!args.recursive && parts.length > depth + 1 && row.status === 'active') {
        const sub = parts.slice(0, depth + 1).join('/');
        folders.set(sub, (folders.get(sub) ?? 0) + 1);
      }
    }
    return {
      folder: args.folder,
      folders: [...folders].map(([path, count]) => ({ path, files: count })),
      files: files.slice(0, MAX_FILES),
      ...(files.length > MAX_FILES ? { truncated: true, total_files: files.length } : {}),
    };
  },
});
