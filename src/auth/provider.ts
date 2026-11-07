import type { Response } from 'express';
import type pg from 'pg';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidTargetError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { withSystem, type Db } from '../db/pool.ts';
import type { Config } from '../config.ts';
import { generateToken, hmac } from './keys.ts';
import type { Client, Scope } from '../ops/types.ts';

export const BRIDGE_CLIENT_NAME = 'supplier-inventory-bridge';
const ACCESS_TTL_SECONDS = 3600;
// A session ends this long after sign-in, however often its tokens are refreshed.
export const SESSION_TTL_DAYS = 30;
const PENDING_TTL_MINUTES = 10;
const CODE_TTL_MINUTES = 5;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const ALL_SCOPES: Scope[] = ['read', 'write', 'approve'];

export type SessionExtra = { userId: string; companyId: string; sessionId: string; client: Client };

export function isLoopbackRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && LOOPBACK.has(u.hostname) && !u.hash;
  } catch {
    return false;
  }
}

function sameResource(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\/+$/, '');
  return norm(a) === norm(b);
}

export async function authEvent(
  tx: pg.PoolClient,
  kind: string,
  data: {
    userId?: string | null; companyId?: string | null; clientId?: string | null; ip?: string | null;
    apiKeyId?: string | null; sessionId?: string | null;
  } = {},
): Promise<void> {
  await tx.query(
    'INSERT INTO auth_event (kind, user_id, company_id, client_id, ip, api_key_id, session_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [kind, data.userId ?? null, data.companyId ?? null, data.clientId ?? null, data.ip ?? null, data.apiKeyId ?? null, data.sessionId ?? null],
  );
}

// OAuth 2.1 authorization server for this MCP. The human step is a key typed on our own
// sign-in page (see signin-page.ts); everything else follows the MCP authorization spec.
export class KeySignInProvider implements OAuthServerProvider {
  private readonly db: Db;
  private readonly cfg: Config;
  readonly resourceUrl: string;

  constructor(db: Db, cfg: Config) {
    this.db = db;
    this.cfg = cfg;
    this.resourceUrl = new URL('/mcp', cfg.publicOrigin).href;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    const db = this.db;
    return {
      async getClient(clientId: string) {
        const r = await db.app.query('SELECT metadata FROM oauth_client WHERE client_id = $1', [clientId]);
        return (r.rows[0]?.metadata as OAuthClientInformationFull | undefined) ?? undefined;
      },
      async registerClient(client) {
        const uris = client.redirect_uris ?? [];
        if (!uris.length || !uris.every((u) => isLoopbackRedirect(String(u)))) {
          throw new InvalidClientMetadataError('Only loopback redirect URIs (http://127.0.0.1 or http://localhost) are accepted.');
        }
        // Public clients only: PKCE protects the code; no client secrets are issued or stored.
        const { client_secret: _secret, client_secret_expires_at: _expiry, ...rest } = client as OAuthClientInformationFull;
        const full = {
          ...rest,
          token_endpoint_auth_method: 'none',
          client_id: crypto.randomUUID(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
        } as OAuthClientInformationFull;
        await db.app.query(
          'INSERT INTO oauth_client (client_id, client_name, redirect_uris, metadata) VALUES ($1, $2, $3, $4)',
          [full.client_id, full.client_name ?? null, uris.map(String), JSON.stringify(full)],
        );
        return full;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (!params.resource || !sameResource(params.resource.href, this.resourceUrl)) {
      throw new InvalidTargetError(`resource must be ${this.resourceUrl}`);
    }
    const requested = (params.scopes ?? []).filter((s): s is Scope => (ALL_SCOPES as string[]).includes(s));
    const r = await this.db.app.query(
      `INSERT INTO oauth_pending (client_id, redirect_uri, code_challenge, state, scopes, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7)) RETURNING id`,
      [client.client_id, params.redirectUri, params.codeChallenge, params.state ?? null, requested, this.resourceUrl, PENDING_TTL_MINUTES],
    );
    res.redirect(302, `/oauth/signin?request=${encodeURIComponent(r.rows[0].id)}`);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const r = await this.db.app.query(
      `SELECT p.code_challenge FROM oauth_code c JOIN oauth_pending p ON p.id = c.pending_id
        WHERE c.code_hmac = $1 AND p.client_id = $2 AND c.used_at IS NULL AND c.expires_at > now()`,
      [hmac(this.cfg.hmacSecret, authorizationCode), client.client_id],
    );
    if (!r.rows[0]) throw new InvalidGrantError('Authorization code is invalid or expired.');
    return r.rows[0].code_challenge as string;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    if (resource && !sameResource(resource.href, this.resourceUrl)) throw new InvalidTargetError(`resource must be ${this.resourceUrl}`);
    return withSystem(this.db.app, async (tx) => {
      const r = await tx.query(
        `SELECT c.code_hmac, c.user_id, c.company_id, c.scopes, c.api_key_id, p.redirect_uri, p.client_id
           FROM oauth_code c JOIN oauth_pending p ON p.id = c.pending_id
          WHERE c.code_hmac = $1 AND c.used_at IS NULL AND c.expires_at > now()
          FOR UPDATE OF c`,
        [hmac(this.cfg.hmacSecret, authorizationCode)],
      );
      const code = r.rows[0];
      if (!code || code.client_id !== client.client_id) throw new InvalidGrantError('Authorization code is invalid or expired.');
      if (redirectUri && redirectUri !== code.redirect_uri) throw new InvalidGrantError('redirect_uri does not match.');
      await tx.query('UPDATE oauth_code SET used_at = now() WHERE code_hmac = $1', [code.code_hmac]);
      const { tokens, sessionId } = await this.issueSession(tx, {
        userId: code.user_id, companyId: code.company_id, clientId: client.client_id, scopes: code.scopes, apiKeyId: code.api_key_id,
      });
      await authEvent(tx, 'token_issued', {
        userId: code.user_id, companyId: code.company_id, clientId: client.client_id, apiKeyId: code.api_key_id, sessionId,
      });
      return tokens;
    });
  }

  private async issueSession(
    tx: pg.PoolClient,
    s: { userId: string; companyId: string; clientId: string; scopes: string[]; apiKeyId: string | null },
  ): Promise<{ tokens: OAuthTokens; sessionId: string }> {
    const access = generateToken();
    const refresh = generateToken();
    const r = await tx.query(
      `INSERT INTO oauth_session (user_id, company_id, client_id, scopes, resource, access_hmac, access_expires_at, refresh_hmac,
                                  api_key_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7), $8, $9, now() + make_interval(days => $10))
       RETURNING id`,
      [s.userId, s.companyId, s.clientId, s.scopes, this.resourceUrl, hmac(this.cfg.hmacSecret, access), ACCESS_TTL_SECONDS,
        hmac(this.cfg.hmacSecret, refresh), s.apiKeyId, SESSION_TTL_DAYS],
    );
    return {
      tokens: { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL_SECONDS, refresh_token: refresh, scope: s.scopes.join(' ') },
      sessionId: r.rows[0].id,
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    if (resource && !sameResource(resource.href, this.resourceUrl)) throw new InvalidTargetError(`resource must be ${this.resourceUrl}`);
    const refreshHmac = hmac(this.cfg.hmacSecret, refreshToken);
    // A reused refresh token revokes its whole session; that must persist even though we refuse.
    const reused = await withSystem(this.db.app, async (tx) => {
      const used = await tx.query('SELECT session_id FROM oauth_used_refresh WHERE refresh_hmac = $1', [refreshHmac]);
      if (!used.rows[0]) return false;
      const s = await tx.query(
        'UPDATE oauth_session SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING user_id, company_id, api_key_id',
        [used.rows[0].session_id],
      );
      await authEvent(tx, 'refresh_reused', {
        userId: s.rows[0]?.user_id, companyId: s.rows[0]?.company_id, clientId: client.client_id,
        apiKeyId: s.rows[0]?.api_key_id, sessionId: used.rows[0].session_id,
      });
      return true;
    });
    if (reused) throw new InvalidGrantError('Refresh token was already used; the session is revoked. Sign in again.');

    return withSystem(this.db.app, async (tx) => {
      const r = await tx.query(
        `SELECT s.id, s.user_id, s.company_id, s.client_id, s.scopes, s.api_key_id
           FROM oauth_session s
           JOIN app_user u ON u.id = s.user_id AND u.disabled_at IS NULL
           JOIN membership m ON m.user_id = s.user_id AND m.company_id = s.company_id AND m.disabled_at IS NULL
           JOIN api_key k ON k.id = s.api_key_id AND k.revoked_at IS NULL
          WHERE s.refresh_hmac = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
          FOR UPDATE OF s`,
        [refreshHmac],
      );
      const s = r.rows[0];
      if (!s || s.client_id !== client.client_id) throw new InvalidGrantError('Refresh token is invalid.');
      const access = generateToken();
      const refresh = generateToken();
      await tx.query('INSERT INTO oauth_used_refresh (refresh_hmac, session_id) VALUES ($1, $2)', [refreshHmac, s.id]);
      await tx.query(
        `UPDATE oauth_session SET access_hmac = $2, access_expires_at = now() + make_interval(secs => $3), refresh_hmac = $4 WHERE id = $1`,
        [s.id, hmac(this.cfg.hmacSecret, access), ACCESS_TTL_SECONDS, hmac(this.cfg.hmacSecret, refresh)],
      );
      await authEvent(tx, 'refresh_rotated', {
        userId: s.user_id, companyId: s.company_id, clientId: client.client_id, apiKeyId: s.api_key_id, sessionId: s.id,
      });
      return { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL_SECONDS, refresh_token: refresh, scope: (s.scopes as string[]).join(' ') };
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const r = await this.db.app.query(
      `SELECT s.id, s.user_id, s.company_id, s.client_id, s.scopes, s.resource, s.access_expires_at,
              m.scopes AS member_scopes, oc.client_name
         FROM oauth_session s
         JOIN app_user u ON u.id = s.user_id AND u.disabled_at IS NULL
         JOIN membership m ON m.user_id = s.user_id AND m.company_id = s.company_id AND m.disabled_at IS NULL
         JOIN oauth_client oc ON oc.client_id = s.client_id
         JOIN api_key k ON k.id = s.api_key_id AND k.revoked_at IS NULL
        WHERE s.access_hmac = $1 AND s.revoked_at IS NULL AND s.access_expires_at > now() AND s.expires_at > now()`,
      [hmac(this.cfg.hmacSecret, token)],
    );
    const s = r.rows[0];
    if (!s) throw new InvalidTokenError('Access token is invalid or expired.');
    // Last use, written at most once a minute per session.
    await this.db.app.query(
      `UPDATE oauth_session SET last_used_at = now()
        WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      [s.id],
    );
    const memberScopes = s.member_scopes as string[];
    const scopes = (s.scopes as string[]).filter((x) => memberScopes.includes(x));
    const extra: SessionExtra = {
      userId: s.user_id,
      companyId: s.company_id,
      sessionId: s.id,
      client: s.client_name === BRIDGE_CLIENT_NAME ? 'bridge' : 'direct',
    };
    return {
      token,
      clientId: s.client_id,
      scopes,
      expiresAt: Math.floor(new Date(s.access_expires_at).getTime() / 1000),
      resource: new URL(s.resource),
      extra,
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: { token: string }): Promise<void> {
    const h = hmac(this.cfg.hmacSecret, request.token);
    await withSystem(this.db.app, async (tx) => {
      const r = await tx.query(
        `UPDATE oauth_session SET revoked_at = now()
          WHERE (access_hmac = $1 OR refresh_hmac = $1) AND revoked_at IS NULL
          RETURNING id, user_id, company_id, client_id, api_key_id`,
        [h],
      );
      const x = r.rows[0];
      if (x) await authEvent(tx, 'session_revoked', { userId: x.user_id, companyId: x.company_id, clientId: x.client_id, apiKeyId: x.api_key_id, sessionId: x.id });
    });
  }

  // Called by the sign-in page after a valid key (and company choice when needed).
  async issueCode(
    tx: pg.PoolClient,
    pendingId: string,
    userId: string,
    companyId: string,
    memberScopes: Scope[],
    apiKeyId: string,
  ): Promise<{ redirectTo: string; clientId: string }> {
    const p = await tx.query(
      `SELECT id, client_id, redirect_uri, state, scopes FROM oauth_pending
        WHERE id = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
      [pendingId],
    );
    const pending = p.rows[0];
    if (!pending) throw new InvalidRequestError('This sign-in request has expired. Start again from your MCP client.');
    const requested = pending.scopes as string[];
    const scopes = requested.length ? memberScopes.filter((s) => requested.includes(s)) : memberScopes;
    if (!scopes.includes('read')) scopes.unshift('read');
    const code = generateToken();
    await tx.query('UPDATE oauth_pending SET used_at = now() WHERE id = $1', [pendingId]);
    await tx.query(
      `INSERT INTO oauth_code (code_hmac, pending_id, user_id, company_id, scopes, expires_at, api_key_id)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6), $7)`,
      [hmac(this.cfg.hmacSecret, code), pendingId, userId, companyId, scopes, CODE_TTL_MINUTES, apiKeyId],
    );
    const target = new URL(pending.redirect_uri);
    target.searchParams.set('code', code);
    if (pending.state) target.searchParams.set('state', pending.state);
    return { redirectTo: target.href, clientId: pending.client_id };
  }
}
