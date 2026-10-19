// Writes every research export, the data dictionary and the content files (with hashes)
// to data/exports/<timestamp>/. Pilot rows are excluded.
// Usage: node scripts/export_all.js [output-dir] [--pilot]     (--pilot exports only the pilot rows)
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig } from '../server/config.js';
import { bootstrap } from '../server/bootstrap.js';
import { EXPORTS, buildExport } from '../server/services/exporter.js';
import { CONTENT_FILES } from '../server/services/content.js';

const pilot = process.argv.includes('--pilot');
const target = process.argv.slice(2).find((a) => !a.startsWith('--'));
const config = loadConfig();
const { db, content } = bootstrap(config);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.resolve(target ?? path.join(config.exportDir, pilot ? `PILOT-${stamp}` : stamp));
fs.mkdirSync(path.join(outDir, 'content'), { recursive: true });

for (const [name, file] of Object.entries(EXPORTS)) {
  fs.writeFileSync(path.join(outDir, file), buildExport(db, content, name, { pilot }));
}
fs.copyFileSync(path.join(ROOT, 'docs', 'data_dictionary.md'), path.join(outDir, 'data_dictionary.md'));
const hashes = [];
for (const file of CONTENT_FILES) {
  fs.copyFileSync(path.join(content.dir, file), path.join(outDir, 'content', file));
  hashes.push(`${content.hashes[file]}  ${file}`);
}
fs.writeFileSync(path.join(outDir, 'content', 'SHA256SUMS'), `${hashes.join('\n')}\n`);
db.close();
console.log(`Exports written to ${outDir}`);
