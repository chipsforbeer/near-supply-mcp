import type pg from 'pg';
import { createPage, livePage } from './pages.ts';

const STARTER_PAGES = [
  {
    path: 'index.md',
    body_md: `# Index

Start here. This wiki is a set of Markdown files; folders group them.

- [[rules]]: how this company wants purchasing done; read it first
- [[current-status]]: what is going on right now
- [[log]]: one line per event, newest last

Folders: suppliers/ (one page per supplier), items/, projects/, decisions/, meetings/.
`,
  },
  {
    path: 'log.md',
    body_md: `# Log

One line per event, newest last: date, action, summary, pages, documents.
`,
  },
  {
    path: 'current-status.md',
    body_md: `# Current status

Nothing recorded yet. Keep this page to a short list of open requests, waiting replies and decisions due.
`,
  },
  {
    path: 'rules.md',
    body_md: `# Company rules

Read this before doing anything for this company. Only someone with the approve permission can change it.

- Ask the user before the first email to a newly found supplier.
- Say who you are writing for: "on behalf of" this company, signed with the user's name.
- Log every email or call with a supplier using interaction_log.
- Judge quotes and deliveries against the item's active spec and record the verdict with evaluation_log.
- Never share one supplier's prices or terms with another supplier.
- Keep each supplier's wiki page current: contacts, timeline, offers and verdicts, open issues.
`,
  },
] as const;

// Creates the starter pages for a company if they are missing. Runs inside a company transaction.
export async function ensureCompanyPages(tx: pg.PoolClient): Promise<void> {
  for (const page of STARTER_PAGES) {
    if (await livePage(tx, page.path)) continue;
    await createPage(tx, page, { userId: null, viaAgent: false, reason: 'starter page', mayChangeRules: true });
  }
}
