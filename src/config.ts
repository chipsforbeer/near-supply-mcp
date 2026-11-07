export type Config = {
  publicOrigin: string;
  port: number;
  listenHost: string;
  isLocalOrigin: boolean;
  databaseUrlApp: string;
  databaseUrlRead: string;
  databaseUrlOwner: string;
  hmacSecret: string;
  trustProxy: boolean;
};

export class ConfigError extends Error {}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Config {
  const problems: string[] = [];
  const need = (key: string): string => {
    const v = env[key]?.trim();
    if (!v) problems.push(`${key} is required.`);
    return v ?? '';
  };

  const originRaw = need('PUBLIC_ORIGIN');
  let publicOrigin = '';
  let isLocalOrigin = false;
  if (originRaw) {
    try {
      const u = new URL(originRaw);
      if (u.pathname !== '/' || u.search || u.hash) {
        problems.push('PUBLIC_ORIGIN must be an origin with no path, query or fragment.');
      }
      isLocalOrigin = LOCAL_HOSTS.has(u.hostname);
      if (!isLocalOrigin && u.protocol !== 'https:') {
        problems.push('PUBLIC_ORIGIN must use https unless it is a localhost origin.');
      }
      publicOrigin = u.origin;
    } catch {
      problems.push('PUBLIC_ORIGIN is not a valid URL.');
    }
  }

  const portRaw = env.PORT?.trim() || '8790';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('PORT must be an integer from 1 to 65535.');

  // Behind nginx the service listens on loopback only; inside a container it must listen on all interfaces.
  const listenHost = env.LISTEN_HOST?.trim() || '127.0.0.1';
  if (!['127.0.0.1', '::1', '0.0.0.0'].includes(listenHost)) problems.push('LISTEN_HOST must be 127.0.0.1, ::1 or 0.0.0.0.');

  const databaseUrlApp = need('DATABASE_URL_APP');
  const databaseUrlRead = need('DATABASE_URL_READ');
  const databaseUrlOwner = need('DATABASE_URL_OWNER');

  const hmacSecret = env.HMAC_SECRET ?? '';
  if (hmacSecret.length < 32) problems.push('HMAC_SECRET must be at least 32 characters.');

  const trustRaw = env.TRUST_PROXY?.trim() || 'false';
  if (trustRaw !== 'true' && trustRaw !== 'false') problems.push('TRUST_PROXY must be true or false.');

  if (problems.length) throw new ConfigError(`Configuration problems:\n- ${problems.join('\n- ')}`);

  return {
    publicOrigin, port, listenHost, isLocalOrigin, databaseUrlApp, databaseUrlRead, databaseUrlOwner,
    hmacSecret, trustProxy: trustRaw === 'true',
  };
}
