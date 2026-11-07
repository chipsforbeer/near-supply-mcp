import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isPublicAddress } from './public-address.ts';

// Checks what would become public with this repo before it is published: every tracked or
// not-ignored file, every commit author, committer and message, and with --history every
// line ever added in any commit. It flags email addresses outside reserved example domains,
// public IP addresses, secret-shaped strings and the private terms listed in
// .privacy/terms.txt (gitignored, one term per line). Exact emails and addresses that
// are known to be fine (test fixtures) are listed with their reasons in scripts/privacy-allow.txt.
// Usage: npm run privacy-scan [-- --history] [-- --without-private-terms]
// Exit code: 0 clean, 1 findings, 2 could not scan.

export type Finding = { kind: 'email' | 'ip' | 'secret' | 'term'; match: string; line: number };
export type Rules = { terms: string[]; allow: Set<string> };

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?!\.?\d)/g;
const IPV6 = /(?<![\w:.])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:.])/gi;
const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}/g,
  /\bsik_[A-Za-z0-9_-]{24,}/g,
  /\bed25519:[1-9A-HJ-NP-Za-km-z]{80,90}\b/g,
  /\bsecp256k1:[1-9A-HJ-NP-Za-km-z]{40,90}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /"private_key_id"\s*:/g,
];
// Hashes and integrity strings: short terms can occur in them by chance, so terms skip them.
const HASH_RUN = /[A-Za-z0-9+/=]{40,}/g;
// RFC 2606 and 6761 reserved names, plus GitHub's private commit addresses.
const RESERVED_DOMAIN = /(?:^|\.)(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/i;

export function isAllowedEmail(email: string): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  return RESERVED_DOMAIN.test(domain) || domain === 'users.noreply.github.com';
}

export function parseList(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

export function scanText(text: string, rules: Rules): Finding[] {
  const out: Finding[] = [];
  const terms = rules.terms.map((t) => t.toLowerCase());
  text.split(/\r?\n/).forEach((content, i) => {
    const line = i + 1;
    for (const m of content.match(EMAIL) ?? []) {
      if (!isAllowedEmail(m) && !rules.allow.has(m)) out.push({ kind: 'email', match: m, line });
    }
    for (const m of [...(content.match(IPV4) ?? []), ...(content.match(IPV6) ?? [])]) {
      if (isPublicAddress(m) && !rules.allow.has(m)) out.push({ kind: 'ip', match: m, line });
    }
    for (const re of SECRETS) for (const m of content.match(re) ?? []) out.push({ kind: 'secret', match: `${m.slice(0, 12)}...`, line });
    const lower = content.replace(HASH_RUN, ' ').toLowerCase();
    for (const t of terms) if (lower.includes(t)) out.push({ kind: 'term', match: t, line });
  });
  return out;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
}

type Located = Finding & { where: string };

function scanFiles(root: string, rules: Rules): Located[] {
  const out: Located[] = [];
  const files = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  for (const file of [...new Set(files)]) {
    for (const f of scanText(file, rules)) out.push({ ...f, where: `${file} (file name)` });
    const full = path.join(root, file);
    if (!existsSync(full)) {
      console.log(`note: ${file} is tracked but deleted in the working tree; --history covers its old content`);
      continue;
    }
    // latin1 keeps every byte, so text inside binary files (PDF, images) is checked too.
    for (const f of scanText(readFileSync(full).toString('latin1'), rules)) out.push({ ...f, where: `${file}:${f.line}` });
  }
  return out;
}

function scanCommits(root: string, rules: Rules): Located[] {
  const out: Located[] = [];
  const log = git(root, ['log', '--all', '--format=%H%x1f%an <%ae>%x1f%cn <%ce>%x1f%B%x1e']);
  for (const entry of log.split('\x1e').map((e) => e.trim()).filter(Boolean)) {
    const [sha = '', author = '', committer = '', message = ''] = entry.split('\x1f');
    const id = sha.slice(0, 7);
    for (const f of scanText(author, rules)) out.push({ ...f, where: `commit ${id} author` });
    for (const f of scanText(committer, rules)) out.push({ ...f, where: `commit ${id} committer` });
    for (const f of scanText(message, rules)) out.push({ ...f, where: `commit ${id} message line ${f.line}` });
  }
  return out;
}

// Every line ever added in any commit, so content that was later removed is still caught.
function scanHistory(root: string, rules: Rules): Located[] {
  const out: Located[] = [];
  const seen = new Set<string>();
  const patch = git(root, ['log', '--all', '-p', '--no-color', '--text', '--no-ext-diff', '--format=%x01%H']);
  let sha = '';
  let file = '';
  let added: string[] = [];
  const flush = () => {
    for (const f of scanText(added.join('\n'), rules)) {
      const key = `${f.kind}|${f.match}|${file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...f, where: `history ${sha.slice(0, 7)} ${file} (added line ${f.line})` });
    }
    added = [];
  };
  for (const line of patch.split('\n')) {
    if (line.startsWith('\x01')) {
      flush();
      sha = line.slice(1);
    } else if (line.startsWith('+++ ')) {
      flush();
      file = line.slice(4).replace(/^b\//, '');
    } else if (line.startsWith('+')) {
      added.push(line.slice(1));
    }
  }
  flush();
  return out;
}

function main(): number {
  const argv = process.argv.slice(2);
  const known = new Set(['--history', '--without-private-terms']);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length) {
    console.error(`Unknown option: ${unknown.join(' ')}\nUsage: npm run privacy-scan [-- --history] [-- --without-private-terms]`);
    return 2;
  }
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const termsFile = path.join(root, '.privacy', 'terms.txt');
  let terms: string[] = [];
  if (argv.includes('--without-private-terms')) {
    console.log('note: private terms NOT checked (--without-private-terms)');
  } else {
    if (!existsSync(termsFile)) {
      console.error('.privacy/terms.txt is missing. Create it (gitignored, one private term per line) or pass --without-private-terms.');
      return 2;
    }
    terms = parseList(readFileSync(termsFile, 'utf8'));
    const short = terms.filter((t) => t.length < 3);
    if (!terms.length || short.length) {
      console.error('.privacy/terms.txt must list at least one term, each 3 or more characters long.');
      return 2;
    }
  }
  const allow = new Set(parseList(readFileSync(path.join(root, 'scripts', 'privacy-allow.txt'), 'utf8')));
  const rules = { terms, allow };
  const found = [...scanFiles(root, rules), ...scanCommits(root, rules), ...(argv.includes('--history') ? scanHistory(root, rules) : [])];
  for (const f of found) console.log(`${f.where}  ${f.kind}  ${f.match}`);
  const scope = `files, commit authors and messages${argv.includes('--history') ? ' and full history' : ''}`;
  console.log(found.length ? `\n${found.length} finding(s) in ${scope}.` : `Clean: ${scope} (${terms.length} private terms).`);
  return found.length ? 1 : 0;
}

// Run only as a command, not when imported by tests.
if (process.argv[1]?.endsWith('privacy-scan.ts')) process.exitCode = main();
