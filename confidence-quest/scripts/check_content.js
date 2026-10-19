// Validates every content file and cross-checks questions.json against Appendix A.
// Usage: node scripts/check_content.js [content-dir]
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { ContentError, loadContent } from '../server/services/content.js';
import { compareWithAppendix } from './lib/appendix.js';

const dir = process.argv[2] ? path.resolve(process.argv[2]) : loadConfig().contentDir;
try {
  const content = loadContent(dir);
  const mismatches = compareWithAppendix(content);
  if (mismatches.length) {
    console.error(`questions.json / answer_key.json differ from Appendix A:\n  - ${mismatches.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`Content OK: ${content.questions.length} questions (${content.questionsVersion}), matches Appendix A.`);
  for (const w of content.warnings) console.log(`[warning] ${w}`);
} catch (err) {
  if (err instanceof ContentError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
