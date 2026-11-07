import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fromUnits } from './amount.ts';
import { loadConfig } from './config.ts';
import { ConfidentialRail } from './rails/confidential.ts';
import { NearRpc } from './rails/near-rpc.ts';
import { Runtime } from './runtime.ts';
import { shield } from './shield.ts';
import { openUrl, run } from './signin.ts';
import { buildServer } from './server.ts';
import { SupplyAuth, TokenFile } from './supply/auth.ts';
import { SupplyClient } from './supply/client.ts';

// stdout is the MCP channel: everything human-readable goes to stderr.
const cfg = loadConfig();
const auth = new SupplyAuth(new TokenFile(cfg.tokenFile), cfg.supplyMcpUrl);
const supply = new SupplyClient(cfg.supplyUrl, auth);

const rt = await new Runtime({ cfg, supply, auth }).init();

async function whoami() {
  const me = await supply.call<Record<string, unknown>>('whoami', {}, { reason: 'payment MCP: check sign-in' });
  console.error(JSON.stringify(me, null, 2));
}

async function login() {
  if (cfg.supplyApiKey && process.platform === 'darwin' && (await run('pbcopy', [], cfg.supplyApiKey))) {
    console.error('Your supplier-server key is on the clipboard: paste it into the sign-in page.');
  } else {
    console.error('Paste your supplier-server key (SUPPLY_API_KEY in .env.local) into the sign-in page.');
  }
  await auth.login(async (url) => {
    console.error(`Opening ${url.origin}${url.pathname} …\nIf no browser opens, visit:\n${url.href}`);
    await openUrl(url.href);
  });
  if (process.platform === 'darwin') await run('pbcopy', [], ''); // clear the clipboard
  console.error(`Signed in. Tokens saved to ${cfg.tokenFile}`);
  await whoami();
}

async function serve() {
  await buildServer(rt).connect(new StdioServerTransport());
  const payer = rt.payer;
  console.error(`near-payment-mcp: ${cfg.network} ${cfg.rail}, payer ${payer?.account_id ?? '(none yet: payment_setup_check)'}, ledger ${cfg.ledgerFile}`);
  if (!payer) return;
  // finish anything a previous run left after signing; never starts new payments
  Promise.resolve().then(() => rt.get().payments.reconcile()).then(
    (r) => r.length && console.error(`reconciled ${r.length} open payment(s)`),
    (e) => console.error(`reconcile at startup failed: ${(e as Error).message}`),
  );
}

const cmd = process.env.PAYMENT_MCP_COMMAND ?? process.argv[2] ?? 'serve';
if (cmd === 'login') await login();
else if (cmd === 'whoami') await whoami();
else if (cmd === 'logout') {
  const ok = await auth.revoke();
  await new TokenFile(cfg.tokenFile).save({});
  console.error(ok ? 'Session revoked at the server and removed locally.' : 'No session to revoke; local tokens cleared.');
} else if (cmd === 'serve') await serve();
else if (cmd === 'shield') {
  const amount = process.argv[3];
  if (!amount) throw new Error('usage: npm run shield -- <amount in USDC, e.g. 1.00>');
  if (cfg.rail !== 'confidential') throw new Error('shield is for the confidential rail: set NEAR_NETWORK=mainnet.');
  const rail = rt.get().rail as ConfidentialRail;
  const payer = cfg.payer ?? (() => { throw new Error('shield needs MAINNET_PAYER_ACCOUNT / MAINNET_PAYER_PRIVATE_KEY (a named account with USDC in its NEAR wallet).'); })();
  await shield({ cfg: { ...cfg, payer }, amount, api: rt.oneClick(), rpc: new NearRpc(cfg.rpcUrl), rail, log: (s) => console.error(s) });
} else if (cmd === 'balance') {
  const { rail } = rt.get();
  for (const [name, t] of Object.entries(cfg.policy.tokens)) console.error(`${rail.name} ${rt.payer!.account_id}: ${fromUnits(await rail.balance(t), t.decimals)} ${name}`);
} else if (cmd === 'setup-check') {
  console.error(JSON.stringify(await rt.setupCheck(), null, 2));
} else {
  console.error('commands: serve (default), login, whoami, logout, setup-check, shield <amount>, balance');
  process.exit(2);
}
