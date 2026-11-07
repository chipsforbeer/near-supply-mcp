import { migrate } from './migrate.ts';

const url = process.env.DATABASE_URL_OWNER;
if (!url) {
  console.error('DATABASE_URL_OWNER is required.');
  process.exit(1);
}
const applied = await migrate(url);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
