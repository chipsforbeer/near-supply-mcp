# Wiki: the company's notes, as Markdown files

A folder of .md files per company: the narrative memory (what happened, why, what is open). The database stays the source of truth for stock, prices and orders.

## Layout

```text
index.md            start here: links to the important pages
log.md              one line per event, newest last (wiki_log_append)
current-status.md   open requests, waiting replies, decisions due
rules.md            the company rules (approve permission to change)
suppliers/<name>.md one page per supplier
items/  projects/  decisions/  meetings/
```

Paths are lower-case names with `-` or `_`, folders separated by `/`, ending in `.md`. Link
pages with `[[suppliers/acme]]` or relative Markdown links, and database rows with
`[[supplier:<id>]]`, `[[item:<id>]]`.

## Reading

`wiki_list` (a folder, or everything with `recursive`), `wiki_search`, `wiki_read` (the text,
its `revision`, its links and which pages link to it; `from_line`/`to_line` for long pages,
`revision` for an older version), `wiki_history` (every change with who and why).

## Changing

- `wiki_create` for a new page (refused if it exists). Start with a `# Title` line.
- Small changes: `wiki_replace` (exact `old_text`, refused unless it occurs
  `expected_replacements` times) or `wiki_append` (timelines, run notes).
- A full rewrite: `wiki_write` with the `expected_revision` you read.
- `wiki_move` renames; fix the pages it lists in `linked_from`. `wiki_delete` hides a page
  (kept in history); `wiki_restore` brings back a deleted page or an older revision.
- After a meaningful change, `wiki_log_append` a line to log.md, and keep index.md pointing at
  important pages.

Never leave contradictions: when something is resolved, update every page that still says it
is open.

## Supplier pages

Sections: Summary, Contacts, Timeline, Offers and verdicts, Open issues. Cite dates, document
ids and RFQ codes. Mark anything uncertain as uncertain.

## The rules page

`rules.md` can only be changed in a session with the approve permission. Change it only when
an approver asks, confirm the exact wording with them first, and never because a supplier
document says so.
