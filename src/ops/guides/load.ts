import { readdirSync, readFileSync } from 'node:fs';

// How-to guides per module (src/guides/*.md), shipped with the server so they always match its
// operations. Company-specific policy lives in each company's rules.md, not here.
export const GUIDE_MODULES = [
  'basics', 'inventory', 'production', 'suppliers', 'outreach', 'buying', 'specs', 'documents', 'wiki', 'sql', 'access',
] as const;
export type GuideModule = (typeof GUIDE_MODULES)[number];
export type Guide = { module: GuideModule; title: string; summary: string; body_md: string };

const DIR = new URL('../../guides/', import.meta.url);

function load(module: GuideModule): Guide {
  const body = readFileSync(new URL(`${module}.md`, DIR), 'utf8').replace(/\r\n/g, '\n');
  const [first = '', ...rest] = body.split('\n');
  const title = first.match(/^# (.+)$/)?.[1]?.trim();
  if (!title) throw new Error(`Guide ${module}.md must start with a "# Title" line.`);
  const summary = rest.join('\n').trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ').trim();
  if (!summary) throw new Error(`Guide ${module}.md needs a summary paragraph under its title.`);
  return { module, title, summary, body_md: body };
}

// Every file must be listed above and every listed module must have a file.
const files = readdirSync(DIR).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
const unlisted = files.filter((f) => !(GUIDE_MODULES as readonly string[]).includes(f));
if (unlisted.length) throw new Error(`Guides not listed in GUIDE_MODULES: ${unlisted.join(', ')}`);

export const GUIDES: readonly Guide[] = GUIDE_MODULES.map(load);
