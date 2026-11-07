import type pg from 'pg';
import type { Config } from '../config.ts';
import type { Db } from '../db/pool.ts';
import { adminCommands } from '../admin/commands.ts';
import { companyStarterPages } from '../admin/company-setup.ts';
import { SeedRunner } from './runner.ts';
import { seedMetalworks } from './metalworks.ts';
import { seedFoodplant } from './foodplant.ts';

export type SeededUser = { email: string; scopes: string; key: string };
export type SeededCompany = { id: string; slug: string; name: string; users: SeededUser[] };

const COMPANIES = [
  { slug: 'northbeck-metalworks', name: 'Northbeck Metalworks', seed: seedMetalworks },
  { slug: 'lark-hill-foods', name: 'Lark Hill Foods', seed: seedFoodplant },
] as const;

// Two unrelated fictional factories, each with an approver and a buyer and one API key each.
// Refuses to run twice: it never overwrites or merges into existing data.
export async function seedDemo(deps: { db: Db; cfg: Config }, owner: pg.Pool): Promise<SeededCompany[]> {
  const existing = await owner.query('SELECT slug FROM company WHERE slug = ANY($1)', [COMPANIES.map((c) => c.slug)]);
  if (existing.rowCount) throw new Error(`Demo data already exists (${existing.rows.map((r) => r.slug).join(', ')}); nothing changed.`);
  const admin = adminCommands(owner, deps.cfg.hmacSecret, companyStarterPages);
  const out: SeededCompany[] = [];
  for (const c of COMPANIES) {
    const company = await admin.createCompany({ name: c.name, slug: c.slug });
    const users: SeededUser[] = [];
    let ownerId = '';
    for (const [role, scopes] of [['owner', 'read,write,approve'], ['buyer', 'read,write']] as const) {
      const email = `${role}@${c.slug}.example.test`;
      const u = await admin.createUser({ email, displayName: `Demo ${role}` });
      if (role === 'owner') ownerId = u.id;
      await admin.grantMembership({ email, slug: c.slug, scopes });
      const { key } = await admin.issueKey({ email, label: 'demo key' });
      users.push({ email, scopes, key });
    }
    const runner = await SeedRunner.start(deps, company.id, ownerId);
    await c.seed(runner);
    await runner.finish();
    out.push({ id: company.id, slug: c.slug, name: c.name, users });
  }
  return out;
}
