import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedEmail, parseList, scanText } from '../../scripts/privacy-scan.ts';

// Values that should be flagged are assembled at run time so this file passes the scan itself.
const at = (local: string, domain: string) => `${local}@${domain}`;
const dots = (...parts: number[]) => parts.join('.');

test('emails: reserved example domains and GitHub noreply pass, anything else is flagged', () => {
  for (const e of ['buyer@example.com', 'sales@mill-direct.example.com', 'owner@x.example.test', 'q@acme.example', 'a@b.example.org',
    '1+someone@users.noreply.github.com']) assert.equal(isAllowedEmail(e), true, e);
  for (const e of [at('jo', 'mailhost.com'), at('a', 'example.com.evil.net'), at('x', 'notexample.com')]) assert.equal(isAllowedEmail(e), false, e);
  const found = scanText(`ok buyer@example.com\nmail ${at('jo', 'mailhost.com')} here`, { terms: [], allow: new Set() });
  assert.deepEqual(found, [{ kind: 'email', match: at('jo', 'mailhost.com'), line: 2 }]);
});

test('ip addresses: only public ones are flagged, and the allow list exempts exact values', () => {
  const v6 = ['2606', '4700', '4700', '', '1001'].join(':');
  const text = ['127.0.0.1 10.0.0.1 192.0.2.10 169.254.169.254', `dns ${dots(8, 8, 4, 4)}`, 'version 1.2.3 and 1.2.3.4.5',
    `v6 2001:db8::1 ::1 fe80::1 ${v6}`, 'time 12:30:45'].join('\n');
  const found = scanText(text, { terms: [], allow: new Set() });
  assert.deepEqual(found.map((f) => [f.kind, f.match, f.line]), [['ip', dots(8, 8, 4, 4), 2], ['ip', v6, 4]]);
  assert.deepEqual(scanText(text, { terms: [], allow: new Set([dots(8, 8, 4, 4), v6]) }), []);
});

test('secret-shaped strings are flagged and cannot be allowed', () => {
  const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  const pem = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
  const found = scanText(`a ${key}\n${pem}`, { terms: [], allow: new Set([key]) });
  assert.deepEqual(found.map((f) => [f.kind, f.line]), [['secret', 1], ['secret', 2]]);
});

test('private terms match case-insensitively on every line', () => {
  const found = scanText('nothing\nHello Acme-Private-Term\nacme-private-term again', { terms: ['acme-private-term'], allow: new Set() });
  assert.deepEqual(found.map((f) => [f.kind, f.line]), [['term', 2], ['term', 3]]);
});

test('supplier credentials, NEAR signing keys, and JWTs are flagged without exposing the full secret', () => {
  const secrets = ['sik_' + 'a'.repeat(32), 'ed25519:' + 'A'.repeat(88),
    'secp256k1:' + 'B'.repeat(44), 'eyJ' + 'a'.repeat(20) + '.' + 'b'.repeat(20) + '.' + 'c'.repeat(20)];
  for (const secret of secrets) {
    const findings = scanText(secret, { terms: [], allow: new Set([secret]) });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.kind, 'secret');
    assert.ok(!findings[0]?.match.includes(secret));
  }
  assert.deepEqual(scanText('ed25519:... secp256k1:... sik_...', { terms: [], allow: new Set() }), []);
});

test('terms are not matched inside hashes, but are matched next to them', () => {
  const hash = 'sha512-' + 'faYHw0anBbcKWF3zFTEnxSFOAGUX9GFbgCiQYwQzvX9iGXZLqT0';
  assert.deepEqual(scanText(`"integrity": "${hash}"`, { terms: ['qzvx'], allow: new Set() }), []);
  assert.equal(scanText(`${hash} qzvx`, { terms: ['qzvx'], allow: new Set() }).length, 1);
});

test('list files skip blank lines and comments', () => {
  assert.deepEqual(parseList('# reason\n8.8.8.8\n\n  spaced  \n'), ['8.8.8.8', 'spaced']);
});
