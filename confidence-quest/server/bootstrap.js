import { openDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { loadConfig } from './config.js';
import { loadContent } from './services/content.js';
import { ensureAllocation } from './services/assignment.js';
import { ensureStudyMode, recordContentHashes } from './services/maintenance.js';

// Opens the database, checks content and prepares allocation. Shared by the server and scripts.
export function bootstrap(config = loadConfig()) {
  const content = loadContent(config.contentDir);
  const db = openDb(config.dbPath);
  migrate(db);
  ensureStudyMode(db, config.initialStudyMode);
  const warnings = [...content.warnings, ...ensureAllocation(db, content.study.allocation, config.allocationSeed)];
  const changed = recordContentHashes(db, content);
  if (changed.length) warnings.push(`Content changed since the last start: ${changed.join(', ')} (logged in events).`);
  return { config, content, db, warnings };
}

