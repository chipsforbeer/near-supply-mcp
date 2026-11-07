import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

export type StoredAuth = {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  obtainedAt?: number;
};

export type TokenStore = {
  kind: 'keyring' | 'file';
  load(): Promise<StoredAuth>;
  save(value: StoredAuth): Promise<void>;
};

// The operating system's credential store: Windows Credential Manager, macOS Keychain, Linux Secret Service.
export async function keyringStore(server: string): Promise<TokenStore> {
  let Entry: typeof import('@napi-rs/keyring').Entry;
  try {
    ({ Entry } = await import('@napi-rs/keyring'));
    const probe = new Entry('supplier-inventory-mcp', `probe:${server}`);
    probe.getPassword();
  } catch {
    throw new Error(
      'No OS credential store is available. Rerun with --token-store file --token-file <path> to keep tokens in a file only you can read.',
    );
  }
  const entry = new Entry('supplier-inventory-mcp', server);
  return {
    kind: 'keyring',
    async load() {
      const raw = entry.getPassword();
      return raw ? (JSON.parse(raw) as StoredAuth) : {};
    },
    async save(value) {
      entry.setPassword(JSON.stringify(value));
    },
  };
}

// Only when asked for explicitly: a JSON file readable by the current user only.
export function fileStore(filePath: string): TokenStore {
  const abs = path.resolve(filePath);
  return {
    kind: 'file',
    async load() {
      try {
        return JSON.parse(await readFile(abs, 'utf8')) as StoredAuth;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
        throw e;
      }
    },
    async save(value) {
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, JSON.stringify(value), { mode: 0o600 });
      await chmod(abs, 0o600).catch(() => undefined);
    },
  };
}
