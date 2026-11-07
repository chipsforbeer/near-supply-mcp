import { loadConfig, ConfigError } from './config.ts';
import { createDb } from './db/pool.ts';
import { createApp } from './http/app.ts';

try {
  const cfg = loadConfig(process.env);
  const db = createDb(cfg);
  const app = createApp({ cfg, db });
  app.listen(cfg.port, cfg.listenHost, () => {
    console.log(`supplier-inventory listening on ${cfg.listenHost}:${cfg.port} for ${cfg.publicOrigin}`);
  });
} catch (e) {
  console.error(e instanceof ConfigError ? e.message : e);
  process.exit(1);
}
