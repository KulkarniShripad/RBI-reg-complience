import fs from 'node:fs';
import { getMeta, setMeta } from './connection.js';

export const SCHEMA_VERSION = '1';

// Builds the database from schema.sql if it is missing. Safe to run on every start.
export function migrate(db) {
  const existing = getMetaSafe(db, 'schema_version');
  if (existing && existing !== SCHEMA_VERSION) {
    throw new Error(`Database schema version ${existing} does not match this code (${SCHEMA_VERSION}).`);
  }
  db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  if (!existing) setMeta(db, 'schema_version', SCHEMA_VERSION);
}

function getMetaSafe(db, key) {
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  return hasMeta ? getMeta(db, key) : null;
}
