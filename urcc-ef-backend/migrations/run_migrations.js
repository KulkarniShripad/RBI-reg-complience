/**
 * Run with: npm run migrate
 * Safe to run multiple times - checks before ALTERing, and every CREATE
 * TABLE in the .sql files uses IF NOT EXISTS.
 */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const env = require("../src/config/env");

const db = new Database(env.db.relationalPath);
db.pragma("journal_mode = WAL");

console.log(`[migrate] target DB: ${env.db.relationalPath}`);

// 1. Run additive .sql files in this folder, in filename order.
const files = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith(".sql"))
  .sort();

for (const file of files) {
  console.log(`[migrate] applying ${file}`);
  const sql = fs.readFileSync(path.join(__dirname, file), "utf8");
  db.exec(sql);
}

// 2. Guarded ALTER TABLE ADD COLUMN for the `documents` version-tracking
//    columns, since SQLite has no "ADD COLUMN IF NOT EXISTS".
const documentsCols = db.prepare("PRAGMA table_info(documents)").all().map((c) => c.name);
const wantedCols = [
  { name: "source_url", ddl: "ALTER TABLE documents ADD COLUMN source_url TEXT" },
  { name: "last_updated_label", ddl: "ALTER TABLE documents ADD COLUMN last_updated_label TEXT" },
  { name: "superseded_by", ddl: "ALTER TABLE documents ADD COLUMN superseded_by TEXT" },
];
for (const col of wantedCols) {
  if (!documentsCols.includes(col.name)) {
    console.log(`[migrate] adding documents.${col.name}`);
    db.exec(col.ddl);
  } else {
    console.log(`[migrate] documents.${col.name} already present, skipping`);
  }
}

console.log("[migrate] done.");
db.close();
