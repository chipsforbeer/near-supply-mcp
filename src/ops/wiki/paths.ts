import { z } from 'zod';
import { OpError } from '../errors.ts';

// Wiki pages are Markdown files: lower-case names, folders separated by /, ending in .md.
// The database checks the same rule (migration 013).
const SEGMENT = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/;
const MAX_PATH = 200;
const MAX_DEPTH = 6;
const NAMING = 'use lower-case letters, digits, - and _ in each name, folders separated by /, no leading / and no . or ..';

export function pathProblem(p: string): string | null {
  if (p.length > MAX_PATH) return `at most ${MAX_PATH} characters`;
  if (!p.endsWith('.md')) return 'wiki pages are Markdown files ending in .md';
  const parts = p.split('/');
  if (parts.length > MAX_DEPTH) return `at most ${MAX_DEPTH - 1} folders deep`;
  if (!parts.every((s) => SEGMENT.test(s))) return NAMING;
  return null;
}

function folderProblem(f: string): string | null {
  if (f === '') return null;
  if (f.length > MAX_PATH) return `at most ${MAX_PATH} characters`;
  const parts = f.split('/');
  if (parts.length > MAX_DEPTH - 1) return `at most ${MAX_DEPTH - 1} folders deep`;
  if (!parts.every((s) => SEGMENT.test(s))) return NAMING;
  return null;
}

export function checkPath(p: string): string {
  const problem = pathProblem(p);
  if (problem) throw new OpError('invalid_arguments', `Wiki path ${JSON.stringify(p.slice(0, 80))}: ${problem}.`);
  return p;
}

export const wikiPath = z.string().superRefine((v, ctx) => {
  const problem = pathProblem(v);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

// A folder is a path prefix: '' is the wiki root; a trailing / is accepted.
export const wikiFolder = z
  .string()
  .transform((v) => v.replace(/\/+$/, ''))
  .superRefine((v, ctx) => {
    const problem = folderProblem(v);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

// The first "# " heading, else the file name without .md.
export function titleOf(body: string, path: string): string {
  for (const line of body.split('\n')) {
    const m = line.match(/^#\s+(.+?)\s*#*\s*$/);
    if (m?.[1]) return m[1].slice(0, 200);
  }
  return path.split('/').at(-1)!.slice(0, -3);
}

// Resolves a Markdown link target against the linking page: /x.md from the wiki root,
// anything else relative to the page's folder. Null when it leaves the wiki.
export function resolveLink(fromPath: string, target: string): string | null {
  const out = target.startsWith('/') ? [] : fromPath.split('/').slice(0, -1);
  for (const part of target.replace(/^\/+/, '').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!out.length) return null;
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out.join('/');
}

export function inFolder(path: string, folder: string): boolean {
  return folder === '' || path.startsWith(`${folder}/`);
}
