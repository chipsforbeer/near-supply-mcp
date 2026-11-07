import pg from 'pg';
import { adminCommands } from './commands.ts';
import { companyStarterPages } from './company-setup.ts';

const USAGE = `Usage: npm run admin -- <command> [--flag value ...]
  company:create   --name "Example Metalworks" --slug example-metalworks
  user:create      --email buyer@example.com --name "Buyer Name"
  membership:grant --email buyer@example.com --company example-metalworks --scopes read,write,approve
  key:issue        --email buyer@example.com --label "laptop bridge"
  key:revoke       --id <key id>
  user:disable     --email buyer@example.com
Needs DATABASE_URL_OWNER and HMAC_SECRET in the environment.`;

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) throw new Error(`Unexpected argument: ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`Missing value for ${a}`);
    out[a.slice(2)] = v;
    i += 1;
  }
  return out;
}

function need(f: Record<string, string>, name: string): string {
  const v = f[name];
  if (!v) throw new Error(`--${name} is required.`);
  return v;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const ownerUrl = process.env.DATABASE_URL_OWNER;
  const secret = process.env.HMAC_SECRET ?? '';
  if (!command || command === 'help') {
    console.log(USAGE);
    return;
  }
  if (!ownerUrl || secret.length < 32) throw new Error('DATABASE_URL_OWNER and HMAC_SECRET (32+ chars) are required.');
  const owner = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  try {
    const admin = adminCommands(owner, secret, companyStarterPages);
    const f = flags(rest);
    switch (command) {
      case 'company:create':
        console.log(await admin.createCompany({ name: need(f, 'name'), slug: need(f, 'slug') }));
        break;
      case 'user:create':
        console.log(await admin.createUser({ email: need(f, 'email'), displayName: need(f, 'name') }));
        break;
      case 'membership:grant':
        console.log(await admin.grantMembership({ email: need(f, 'email'), slug: need(f, 'company'), scopes: need(f, 'scopes') }));
        break;
      case 'key:issue': {
        const { keyId, key } = await admin.issueKey({ email: need(f, 'email'), label: need(f, 'label') });
        console.log(`Key id: ${keyId}`);
        console.log(`API key (shown once, store it now): ${key}`);
        break;
      }
      case 'key:revoke': {
        const { sessionsEnded } = await admin.revokeKey({ keyId: need(f, 'id') });
        console.log(`Key revoked; ${sessionsEnded} session(s) it opened ended.`);
        break;
      }
      case 'user:disable': {
        const { sessionsEnded } = await admin.disableUser({ email: need(f, 'email') });
        console.log(`User disabled; ${sessionsEnded} session(s) ended.`);
        break;
      }
      default:
        throw new Error(`Unknown command: ${command}\n${USAGE}`);
    }
  } finally {
    await owner.end();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
