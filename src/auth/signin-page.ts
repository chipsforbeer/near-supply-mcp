import { randomBytes } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { withSystem, type Db } from '../db/pool.ts';
import type { Config } from '../config.ts';
import { API_KEY_PATTERN, hmac, safeEqual } from './keys.ts';
import { authEvent, type KeySignInProvider } from './provider.ts';
import type { Scope } from '../ops/types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CSRF_COOKIE = 'si_csrf';
const TICKET_TTL_SECONDS = 300;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

function layout(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in</title><style>
body{font-family:system-ui,sans-serif;background:#f6f6f4;color:#1d1d1b;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{background:#fff;border:1px solid #ddd;border-radius:10px;padding:28px;max-width:420px;width:calc(100% - 32px)}
h1{font-size:20px;margin:0 0 12px}p{line-height:1.45}label{display:block;margin:14px 0 6px;font-weight:600}
input[type=password]{width:100%;box-sizing:border-box;padding:10px;font-size:15px;border:1px solid #bbb;border-radius:6px}
button{margin-top:16px;padding:10px 16px;font-size:15px;border:0;border-radius:6px;background:#1d1d1b;color:#fff;cursor:pointer}
.err{color:#a40000}.opt{display:block;margin:8px 0}
</style></head><body><main>${body}</main></body></html>`;
}

function send(res: Response, status: number, body: string): void {
  res
    .status(status)
    .set({
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' http://127.0.0.1:* http://localhost:*; frame-ancestors 'none'",
    })
    .type('html')
    .send(layout(body));
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function keyForm(requestId: string, csrf: string, error?: string): string {
  return `<h1>Sign in</h1>
<p>Paste the API key your administrator gave you. It connects this MCP client to your company's data.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/oauth/signin">
<input type="hidden" name="request" value="${esc(requestId)}"><input type="hidden" name="csrf" value="${esc(csrf)}">
<label for="key">API key</label><input id="key" name="key" type="password" autocomplete="off" required autofocus>
<button type="submit">Continue</button></form>`;
}

function companyForm(requestId: string, csrf: string, ticket: string, companies: { id: string; name: string }[]): string {
  const options = companies
    .map((c, i) => `<label class="opt"><input type="radio" name="company" value="${esc(c.id)}"${i === 0 ? ' checked' : ''}> ${esc(c.name)}</label>`)
    .join('');
  return `<h1>Choose a company</h1><p>This connection will only see the company you choose.</p>
<form method="post" action="/oauth/signin">
<input type="hidden" name="request" value="${esc(requestId)}"><input type="hidden" name="csrf" value="${esc(csrf)}">
<input type="hidden" name="ticket" value="${esc(ticket)}">${options}<button type="submit">Continue</button></form>`;
}

// A short-lived proof that this browser already presented a valid key for this request,
// so the company choice never puts the key back into the page.
// It carries the key's id too, so the session still knows which key opened it.
function makeTicket(secret: string, requestId: string, userId: string, keyId: string): string {
  const exp = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS;
  return `${userId}.${keyId}.${exp}.${hmac(secret, `company-choice|${requestId}|${userId}|${keyId}|${exp}`)}`;
}

function readTicket(secret: string, requestId: string, ticket: string): { userId: string; keyId: string } | null {
  const [userId, keyId, expRaw, mac] = ticket.split('.');
  if (!userId || !keyId || !expRaw || !mac || !UUID.test(userId) || !UUID.test(keyId)) return null;
  if (Number(expRaw) < Date.now() / 1000) return null;
  return safeEqual(mac, hmac(secret, `company-choice|${requestId}|${userId}|${keyId}|${expRaw}`)) ? { userId, keyId } : null;
}

export function signInRouter(db: Db, cfg: Config, provider: KeySignInProvider, perIpPerMinute: number): express.Router {
  const router = express.Router();
  const secure = cfg.publicOrigin.startsWith('https://');

  const perIp = rateLimit({
    windowMs: 60_000,
    limit: perIpPerMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      void withSystem(db.app, (tx) => authEvent(tx, 'signin_rate_limited', { ip: req.ip ?? null })).catch(() => undefined);
      send(res, 429, '<h1>Too many attempts</h1><p>Wait a minute and try again.</p>');
    },
  });
  const overall = rateLimit({
    windowMs: 60_000,
    limit: 100,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: () => 'all',
    validate: false,
    handler: (_req, res) => send(res, 429, '<h1>Busy</h1><p>Too many sign-in attempts right now. Try again shortly.</p>'),
  });

  const newCsrf = (res: Response): string => {
    const token = randomBytes(24).toString('base64url');
    res.cookie(CSRF_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure, path: '/oauth/signin', maxAge: 600_000 });
    return token;
  };

  router.get('/oauth/signin', async (req, res) => {
    const requestId = String(req.query.request ?? '');
    if (!UUID.test(requestId)) return send(res, 400, '<h1>Invalid request</h1><p>Start the sign-in again from your MCP client.</p>');
    const p = await db.app.query('SELECT 1 FROM oauth_pending WHERE id = $1 AND used_at IS NULL AND expires_at > now()', [requestId]);
    if (!p.rowCount) return send(res, 400, '<h1>Sign-in expired</h1><p>Start the sign-in again from your MCP client.</p>');
    return send(res, 200, keyForm(requestId, newCsrf(res)));
  });

  router.post('/oauth/signin', overall, perIp, express.urlencoded({ extended: false, limit: '8kb' }), async (req, res) => {
    const body = req.body as Record<string, string | undefined>;
    const requestId = String(body.request ?? '');
    if (!UUID.test(requestId)) return send(res, 400, '<h1>Invalid request</h1><p>Start the sign-in again from your MCP client.</p>');
    const cookie = readCookie(req, CSRF_COOKIE);
    if (!cookie || !body.csrf || !safeEqual(cookie, body.csrf)) {
      return send(res, 400, keyForm(requestId, newCsrf(res), 'Your sign-in form expired. Paste the key again.'));
    }
    const ip = req.ip ?? null;
    try {
      const outcome = await withSystem(db.app, async (tx) => {
        let userId: string;
        let keyId: string;
        if (body.ticket) {
          const fromTicket = readTicket(cfg.hmacSecret, requestId, body.ticket);
          if (!fromTicket) return { kind: 'form' as const, error: 'That choice expired. Paste the key again.' };
          ({ userId, keyId } = fromTicket);
        } else {
          const key = String(body.key ?? '').trim();
          const k = API_KEY_PATTERN.test(key)
            ? await tx.query(
                `SELECT k.id, k.user_id FROM api_key k JOIN app_user u ON u.id = k.user_id
                  WHERE k.key_hmac = $1 AND k.revoked_at IS NULL AND u.disabled_at IS NULL`,
                [hmac(cfg.hmacSecret, key)],
              )
            : { rows: [] as { id: string; user_id: string }[] };
          const found = k.rows[0];
          if (!found) {
            await authEvent(tx, 'signin_bad_key', { ip });
            return { kind: 'form' as const, error: 'That key is not valid. Check it and try again.' };
          }
          userId = found.user_id;
          keyId = found.id;
          await tx.query('UPDATE api_key SET last_used_at = now() WHERE id = $1', [found.id]);
        }
        const m = await tx.query(
          `SELECT m.company_id AS id, c.name, m.scopes FROM membership m JOIN company c ON c.id = m.company_id
            WHERE m.user_id = $1 AND m.disabled_at IS NULL ORDER BY c.name`,
          [userId],
        );
        const memberships = m.rows as { id: string; name: string; scopes: Scope[] }[];
        if (!memberships.length) {
          await authEvent(tx, 'signin_no_membership', { userId, ip, apiKeyId: keyId });
          return { kind: 'message' as const, error: 'This key is valid but not linked to any company. Ask your administrator.' };
        }
        let chosen = memberships.length === 1 ? memberships[0] : undefined;
        if (body.company) chosen = memberships.find((x) => x.id === body.company);
        if (!chosen) {
          return { kind: 'choose' as const, ticket: makeTicket(cfg.hmacSecret, requestId, userId, keyId), companies: memberships };
        }
        const { redirectTo, clientId } = await provider.issueCode(tx, requestId, userId, chosen.id, chosen.scopes, keyId);
        await authEvent(tx, 'signin_ok', { userId, companyId: chosen.id, clientId, ip, apiKeyId: keyId });
        return { kind: 'redirect' as const, redirectTo };
      });
      switch (outcome.kind) {
        case 'redirect':
          res.clearCookie(CSRF_COOKIE, { path: '/oauth/signin' });
          return res.redirect(302, outcome.redirectTo);
        case 'choose':
          return send(res, 200, companyForm(requestId, newCsrf(res), outcome.ticket, outcome.companies));
        case 'message':
          return send(res, 403, `<h1>No company access</h1><p>${esc(outcome.error)}</p>`);
        default:
          return send(res, 401, keyForm(requestId, newCsrf(res), outcome.error));
      }
    } catch (e) {
      const message = e instanceof OAuthError ? e.message : 'Sign-in failed. Start again from your MCP client.';
      return send(res, 400, `<h1>Sign-in failed</h1><p>${esc(message)}</p>`);
    }
  });

  return router;
}
