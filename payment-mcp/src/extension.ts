// Entry point for the Claude desktop extension. The app runs it in its built-in Node (an Electron
// utility process), whose stderr does not reach the app's logs, so startup problems are also written to
// ~/.config/near-payment-mcp/extension.log. Nothing secret is logged: config errors name variables,
// never their values.
import { appendFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = path.join(os.homedir(), '.config', 'near-payment-mcp');
const logFile = path.join(dir, 'extension.log');

function log(msg: string) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 });
  } catch {
    // logging must never stop the server
  }
  console.error(msg);
}

const fatal = (what: string) => (e: unknown) => {
  log(`${what}: ${(e as Error)?.stack ?? String(e)}`);
  process.exit(1);
};
process.on('uncaughtException', fatal('uncaught exception'));
process.on('unhandledRejection', fatal('unhandled rejection'));

log(`starting: node ${process.versions.node}, electron ${process.versions.electron ?? '-'}, ${process.platform}`);
process.env.PAYMENT_MCP_COMMAND = 'serve'; // the app may pass extra arguments; the extension only ever serves
try {
  await import('./main.ts');
  log('server running');
} catch (e) {
  fatal('startup failed')(e);
}
