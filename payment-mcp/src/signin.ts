// Sign-in to the supplier server started from the chat (payment_sign_in), for users with no terminal.
// It opens the supplier server's own sign-in page in the browser; the user pastes their payment key
// THERE, never into the chat. The tool returns as soon as the page is open; the sign-in completes in the
// background and payment_setup_check reports it. SupplyAuth.login still refuses any session that holds
// "approve".

import { spawn } from 'node:child_process';
import type { SupplyAuth } from './supply/auth.ts';

export function run(cmd: string, args: string[], input?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'] });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
    if (input !== undefined) p.stdin!.end(input);
  });
}

export function openUrl(url: string): Promise<boolean> {
  if (process.platform === 'darwin') return run('open', [url]);
  if (process.platform === 'win32') return run('rundll32', ['url.dll,FileProtocolHandler', url]);
  return run('xdg-open', [url]);
}

/** macOS only: put the configured key on the clipboard for the sign-in page, and clear it afterwards. */
async function clipboard(text: string): Promise<boolean> {
  return process.platform === 'darwin' ? run('pbcopy', [], text) : false;
}

export type SignInState =
  | { state: 'idle' }
  | { state: 'waiting'; url: string; started_at: string; key_on_clipboard: boolean }
  | { state: 'signed_in'; at: string }
  | { state: 'failed'; error: string; at: string };

export class SignInFlow {
  private s: SignInState = { state: 'idle' };
  private readonly auth: SupplyAuth;
  private readonly key: string | undefined;
  private readonly open: (url: string) => Promise<boolean>;
  private readonly timeoutMs: number;
  constructor(o: { auth: SupplyAuth; supplyApiKey?: string; open?: (url: string) => Promise<boolean>; timeoutMs?: number }) {
    this.auth = o.auth;
    this.key = o.supplyApiKey;
    this.open = o.open ?? openUrl;
    this.timeoutMs = o.timeoutMs ?? 10 * 60_000;
  }

  get current(): SignInState {
    return this.s;
  }

  /** Opens the sign-in page and resolves once it is open (or the attempt failed before that). */
  async start(): Promise<SignInState & { browser_opened?: boolean }> {
    if (this.s.state === 'waiting') return this.s;
    let opened!: (v: { url: string; ok: boolean }) => void;
    const urlReady = new Promise<{ url: string; ok: boolean }>((r) => (opened = r));
    const onClip = this.key ? await clipboard(this.key) : false;
    const done = this.auth.login(async (url) => {
      const ok = await this.open(url.href);
      this.s = { state: 'waiting', url: url.href, started_at: new Date().toISOString(), key_on_clipboard: onClip };
      opened({ url: url.href, ok });
    }, this.timeoutMs);
    done.then(
      () => (this.s = { state: 'signed_in', at: new Date().toISOString() }),
      (e) => (this.s = { state: 'failed', error: (e as Error).message, at: new Date().toISOString() }),
    ).finally(() => onClip && clipboard(''));
    // login() fails before opening a page if the server is unreachable: report that instead of hanging
    const first = await Promise.race([urlReady, done.then(() => null, () => null)]);
    if (!first) return this.s;
    return { ...this.s, browser_opened: first.ok };
  }
}
