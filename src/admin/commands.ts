import type pg from 'pg';
import { generateApiKey, hmac } from '../auth/keys.ts';
import type { Scope } from '../ops/types.ts';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SCOPES: readonly Scope[] = ['read', 'write', 'approve'];

export function parseScopes(raw: string | string[]): Scope[] {
  const list = (Array.isArray(raw) ? raw : raw.split(',')).map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((s) => !SCOPES.includes(s as Scope));
  if (bad.length) throw new Error(`Unknown scope(s): ${bad.join(', ')}. Allowed: read, write, approve.`);
  if (!list.includes('read')) throw new Error('Every membership needs the read scope.');
  return [...new Set(list)] as Scope[];
}

export type AfterCompanyCreated = (owner: pg.Pool, companyId: string) => Promise<void>;

// Provisioning runs as the owner role from the server's shell; there is no admin HTTP API.
export function adminCommands(owner: pg.Pool, hmacSecret: string, afterCompanyCreated?: AfterCompanyCreated) {
  async function userIdByEmail(email: string): Promise<string> {
    const r = await owner.query('SELECT id FROM app_user WHERE email = $1', [email.toLowerCase()]);
    if (!r.rows[0]) throw new Error(`No user with email ${email}.`);
    return r.rows[0].id as string;
  }

  async function inTransaction<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  // Ends every live session of a key or a user, one session_revoked event each.
  async function endSessions(c: pg.PoolClient, column: 'api_key_id' | 'user_id', id: string): Promise<number> {
    const s = await c.query(
      `UPDATE oauth_session SET revoked_at = now() WHERE ${column} = $1 AND revoked_at IS NULL
       RETURNING id, user_id, company_id, client_id, api_key_id`,
      [id],
    );
    for (const x of s.rows) {
      await c.query(
        `INSERT INTO auth_event (kind, user_id, company_id, client_id, api_key_id, session_id) VALUES ('session_revoked', $1, $2, $3, $4, $5)`,
        [x.user_id, x.company_id, x.client_id, x.api_key_id, x.id],
      );
    }
    return s.rowCount ?? 0;
  }

  return {
    async createCompany(input: { name: string; slug: string }): Promise<{ id: string; slug: string }> {
      const r = await owner.query('INSERT INTO company (name, slug) VALUES ($1, $2) RETURNING id, slug', [input.name.trim(), input.slug]);
      const company = r.rows[0] as { id: string; slug: string };
      if (afterCompanyCreated) await afterCompanyCreated(owner, company.id);
      return company;
    },

    async createUser(input: { email: string; displayName: string }): Promise<{ id: string }> {
      const email = input.email.trim().toLowerCase();
      if (!EMAIL.test(email)) throw new Error('Invalid email address.');
      const r = await owner.query('INSERT INTO app_user (email, display_name) VALUES ($1, $2) RETURNING id', [email, input.displayName.trim()]);
      return { id: r.rows[0].id as string };
    },

    async grantMembership(input: { email: string; slug: string; scopes: string | string[] }): Promise<{ scopes: Scope[] }> {
      const scopes = parseScopes(input.scopes);
      const userId = await userIdByEmail(input.email);
      const c = await owner.query('SELECT id FROM company WHERE slug = $1', [input.slug]);
      if (!c.rows[0]) throw new Error(`No company with slug ${input.slug}.`);
      await owner.query(
        `INSERT INTO membership (user_id, company_id, scopes) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, company_id) DO UPDATE SET scopes = EXCLUDED.scopes, disabled_at = NULL`,
        [userId, c.rows[0].id, scopes],
      );
      return { scopes };
    },

    async issueKey(input: { email: string; label: string }): Promise<{ keyId: string; key: string }> {
      const userId = await userIdByEmail(input.email);
      const key = generateApiKey();
      const r = await owner.query('INSERT INTO api_key (user_id, key_hmac, label) VALUES ($1, $2, $3) RETURNING id', [userId, hmac(hmacSecret, key), input.label.trim()]);
      return { keyId: r.rows[0].id as string, key };
    },

    // The sessions a key opened end with it; both are recorded as auth events.
    async revokeKey(input: { keyId: string }): Promise<{ sessionsEnded: number }> {
      return inTransaction(async (c) => {
        const k = await c.query('UPDATE api_key SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING user_id', [input.keyId]);
        if (!k.rows[0]) throw new Error('No active key with that id.');
        await c.query(`INSERT INTO auth_event (kind, user_id, api_key_id) VALUES ('key_revoked', $1, $2)`, [k.rows[0].user_id, input.keyId]);
        return { sessionsEnded: await endSessions(c, 'api_key_id', input.keyId) };
      });
    },

    async disableUser(input: { email: string }): Promise<{ sessionsEnded: number }> {
      const userId = await userIdByEmail(input.email);
      return inTransaction(async (c) => {
        await c.query('UPDATE app_user SET disabled_at = now() WHERE id = $1', [userId]);
        return { sessionsEnded: await endSessions(c, 'user_id', userId) };
      });
    },
  };
}

export type AdminCommands = ReturnType<typeof adminCommands>;
