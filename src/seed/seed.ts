import { loadConfig, ConfigError } from '../config.ts';
import { createDb, ownerPool } from '../db/pool.ts';
import { seedDemo } from './demo.ts';

// npm run seed: loads the two fictional demo companies and prints their demo keys once.
try {
  const cfg = loadConfig(process.env);
  const db = createDb(cfg, true);
  const owner = ownerPool(cfg, true);
  const companies = await seedDemo({ db, cfg }, owner);
  console.log('Demo data loaded (fictional companies). Keys are shown once:');
  for (const c of companies) {
    for (const u of c.users) console.log(`  ${c.name.padEnd(22)} ${u.email.padEnd(42)} ${u.scopes.padEnd(18)} ${u.key}`);
  }
  await Promise.all([db.app.end(), db.read.end(), owner.end()]);
} catch (e) {
  console.error(e instanceof ConfigError || e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
