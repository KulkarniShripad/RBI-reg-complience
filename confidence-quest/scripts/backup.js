// Takes a consistent copy of the database (safe while the server is running).
// Usage: node scripts/backup.js [label]     e.g.  node scripts/backup.js before-session-1
// Then copy the file in data/backups/ off the host (USB stick, shared drive).
import { loadConfig } from '../server/config.js';
import { openDb } from '../server/db/connection.js';
import { migrate } from '../server/db/migrate.js';
import { backupDatabase } from '../server/services/maintenance.js';

const config = loadConfig();
const db = openDb(config.dbPath);
migrate(db);
const file = await backupDatabase(db, config.backupDir, process.argv[2] ?? 'script');
db.close();
console.log(`Backup written: ${file}`);
