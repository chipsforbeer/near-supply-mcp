import { pathProblem, resolveLink } from './paths.ts';

const ENTITY = /^(supplier|item|doc|rfq|quote|po|lot):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const WIKI_LINK = /\[\[([^\]\n]{1,200})\]\]/g;
const MD_LINK = /\]\(([^)\s]{1,300})(?:\s+"[^"\n]*")?\)/g;

export type ParsedLinks = { pages: string[]; entities: { type: string; id: string }[] };

// Page links, in order of appearance:
//   [[rules]] or [[suppliers/acme.md|Acme]]  from the wiki root (.md may be left off)
//   [Acme](../suppliers/acme.md)              relative to the linking page; /x.md from the root
// Database rows: [[supplier:<uuid>]], [[item:<uuid>]] and the other entity kinds.
export function parseWikiLinks(md: string, fromPath: string): ParsedLinks {
  const pages = new Set<string>();
  const entities = new Map<string, { type: string; id: string }>();
  for (const m of md.matchAll(WIKI_LINK)) {
    const target = (m[1] ?? '').split('|')[0]!.trim();
    const e = target.match(ENTITY);
    if (e) {
      const type = e[1]!.toLowerCase();
      const id = e[2]!.toLowerCase();
      entities.set(`${type}:${id}`, { type, id });
      continue;
    }
    const path = target.endsWith('.md') ? target : `${target}.md`;
    if (!pathProblem(path)) pages.add(path);
  }
  for (const m of md.matchAll(MD_LINK)) {
    const raw = m[1] ?? '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#')) continue;
    const target = raw.split('#')[0]!;
    if (!target.endsWith('.md')) continue;
    const path = resolveLink(fromPath, target);
    if (path && !pathProblem(path)) pages.add(path);
  }
  return { pages: [...pages], entities: [...entities.values()] };
}
