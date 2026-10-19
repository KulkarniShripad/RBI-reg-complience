import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Reads the environment once. Everything else gets its settings from this object,
// so tests can build an app with their own config without touching process.env.
export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';
  const fromRoot = (p) => (p === ':memory:' ? p : path.resolve(ROOT, p));
  return {
    nodeEnv,
    isProduction,
    port: Number(env.PORT || 3000),
    host: env.HOST || '0.0.0.0',
    dbPath: fromRoot(env.DB_PATH || 'data/app.sqlite'),
    contentDir: fromRoot(env.CONTENT_DIR || 'server/content'),
    backupDir: fromRoot(env.BACKUP_DIR || 'data/backups'),
    exportDir: fromRoot(env.EXPORT_DIR || 'data/exports'),
    adminToken: env.ADMIN_TOKEN || '',
    allocationSeed: env.ALLOCATION_SEED || '',
    initialStudyMode: env.STUDY_MODE === 'pilot' ? 'pilot' : 'live',
    secureCookies: env.SECURE_COOKIES ? env.SECURE_COOKIES === '1' : isProduction,
  };
}
