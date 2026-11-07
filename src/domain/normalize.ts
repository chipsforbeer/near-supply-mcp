// Normalised forms used to spot the same supplier entered twice.

const LEGAL_SUFFIXES = new Set([
  'ltd', 'limited', 'inc', 'incorporated', 'co', 'corp', 'corporation', 'company', 'gmbh', 'llc', 'plc', 'sa',
  'sas', 'bv', 'nv', 'ag', 'pte', 'sdn', 'bhd', 'pty', 'srl', 'spa', 'kk', 'oy', 'ab', 'as', 'the', 'and',
]);

// Shared mailbox providers say nothing about which company someone works for.
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com',
  'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'qq.com', '163.com', '126.com', 'yeah.net', 'sina.com',
  'naver.com', 'daum.net', 'yandex.ru', 'mail.ru', 'gmx.com', 'gmx.de', 'web.de', 'zoho.com',
]);

export function normName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9぀-ヿ㐀-鿿]+/g, ' ')
    .split(' ')
    .filter((w) => w && !LEGAL_SUFFIXES.has(w))
    .join(' ');
}

// "https://www.acme-metals.example/contact" or "sales@acme-metals.example" -> "acme-metals.example"
export function normDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (s.includes('@')) s = s.split('@').pop() ?? '';
  try {
    if (!/^[a-z]+:\/\//.test(s)) s = `http://${s}`;
    s = new URL(s).hostname;
  } catch {
    return null;
  }
  s = s.replace(/^www\./, '');
  return s.includes('.') ? s : null;
}

export function companyDomain(input: string | null | undefined): string | null {
  const d = normDomain(input);
  return d && !FREE_MAIL.has(d) ? d : null;
}

// Digits only; the last 8 digits are compared so country codes, area-code trunk zeros and spacing do not matter.
export function normPhone(input: string): string {
  return input.replace(/\D/g, '');
}

export function phoneTail(input: string): string {
  return normPhone(input).slice(-8);
}

export function normMethodValue(type: string, value: string): string {
  const v = value.trim();
  if (type === 'email') return v.toLowerCase();
  if (['phone', 'mobile', 'sms', 'whatsapp', 'fax'].includes(type)) return normPhone(v);
  if (type === 'website_form' || type === 'portal') return normDomain(v) ?? v.toLowerCase();
  return v.toLowerCase();
}
