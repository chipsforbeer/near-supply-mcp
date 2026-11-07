import { spawn } from 'node:child_process';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBridge } from './bridge.ts';
import { fileStore, keyringStore, type TokenStore } from './token-store.ts';

const USAGE = `Usage: node bridge/main.ts --server <https://your-server> [--token-store keyring|file] [--token-file <path>]
Add it to Claude Code:  claude mcp add supply -- node <repo>/bridge/main.ts --server <url>`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Opens the sign-in page in the default browser. Never prints tokens.
function openBrowser(url: URL): Promise<void> {
  const target = url.href;
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', target.replace(/&/g, '^&')]]
    : process.platform === 'darwin' ? ['open', [target]]
    : ['xdg-open', [target]];
  process.stderr.write(`Opening the sign-in page in your browser. If it does not open, visit:\n${target}\n`);
  spawn(cmd, args as string[], { stdio: 'ignore', detached: true }).unref();
  return Promise.resolve();
}

async function main(): Promise<void> {
  const server = arg('server');
  if (!server) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  const u = new URL(server);
  if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    throw new Error('The server must use https (plain http only for a localhost server).');
  }
  const kind = arg('token-store') ?? 'keyring';
  let store: TokenStore;
  if (kind === 'file') {
    const file = arg('token-file');
    if (!file) throw new Error('--token-store file needs --token-file <path>.');
    store = fileStore(file);
  } else if (kind === 'keyring') {
    store = await keyringStore(u.origin);
  } else {
    throw new Error('--token-store must be keyring or file.');
  }
  const bridge = await createBridge({ server: u.origin, store, openBrowser });
  await bridge.server.connect(new StdioServerTransport());
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
