import fs from 'node:fs';
import path from 'node:path';

// Parses source/appendix_a_final_test.md (the verbatim test) into questions and an answer key.
export function parseAppendix(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const questions = [];
  let section = null;
  let current = null;
  let inCode = false;
  let code = [];
  let answerKey = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inCode) {
      if (line.startsWith('```')) {
        current.code = code.join('\n');
        inCode = false;
      } else code.push(line);
      continue;
    }
    const sectionMatch = /^## Section \d+: (.+)$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    const questionMatch = /^\*\*(Q\d+) \(([^)]+)\)\.\*\*\s?(.*)$/.exec(line);
    if (questionMatch) {
      current = { id: questionMatch[1], section, difficulty_label: questionMatch[2], prompt: questionMatch[3], options: [] };
      questions.push(current);
      continue;
    }
    const fence = /^```(\w*)$/.exec(line);
    if (fence && current) {
      inCode = true;
      code = [];
      current.language = fence[1] || undefined;
      continue;
    }
    const optionMatch = /^([A-D])\) (.+)$/.exec(line);
    if (optionMatch && current) {
      current.options.push({ key: optionMatch[1], text: optionMatch[2] });
      continue;
    }
    if (/^\| Answer \|/.test(line)) {
      const header = lines[i - 2].split('|').map((c) => c.trim()).filter(Boolean).slice(1);
      const letters = line.split('|').map((c) => c.trim()).filter(Boolean).slice(1);
      answerKey = Object.fromEntries(header.map((n, j) => [`Q${n}`, letters[j]]));
    }
  }
  return { questions, answerKey };
}

export function loadAppendix(contentDir) {
  return parseAppendix(fs.readFileSync(path.join(contentDir, 'source', 'appendix_a_final_test.md'), 'utf8'));
}

// Lists every difference between the JSON content and Appendix A (empty list = identical).
export function compareWithAppendix(content) {
  const source = loadAppendix(content.dir);
  const problems = [];
  if (source.questions.length !== content.questions.length) {
    problems.push(`Appendix A has ${source.questions.length} questions, questions.json has ${content.questions.length}`);
  }
  source.questions.forEach((src, i) => {
    const q = content.questions[i];
    if (!q) return;
    for (const field of ['id', 'section', 'difficulty_label', 'prompt', 'code', 'language']) {
      if ((src[field] ?? null) !== (q[field] ?? null)) problems.push(`${src.id}.${field}: expected ${JSON.stringify(src[field])}, got ${JSON.stringify(q[field])}`);
    }
    src.options.forEach((opt, j) => {
      const got = q.options[j];
      if (!got || got.key !== opt.key || got.text !== opt.text) {
        problems.push(`${src.id}.options.${opt.key}: expected ${JSON.stringify(opt.text)}, got ${JSON.stringify(got?.text)}`);
      }
    });
  });
  for (const [id, letter] of Object.entries(source.answerKey ?? {})) {
    if (content.answerKey[id] !== letter) problems.push(`answer_key.${id}: expected ${letter}, got ${content.answerKey[id]}`);
  }
  return problems;
}
