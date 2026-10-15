// All study content, imported at build time and validated once at startup.
// Edit the JSON files, not the components.

import questions from './questions.json';
import ui from './ui-text.json';
import feedback from './feedback.json';
import packs from './packs.json';
import config from './config.json';
import { validateContent } from './validate';
import type { Content } from './types';

let cached: Content | null = null;

/** Returns the validated content. Throws a ContentError if any file is malformed. */
export function loadContent(): Content {
  if (!cached) cached = validateContent({ questions, ui, feedback, packs, config });
  return cached;
}

export * from './types';
