// Small helpers: placeholder filling, randomness, slug titles, per-language text.

import type { LangId, PerLang } from '../content/types';

export type Rng = () => number;

/** Fills {placeholders} in a template. Unknown placeholders are left as they are. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => (key in vars ? String(vars[key]) : m));
}

/** Removes the **bold** markers (for stored and exported text). */
export function plain(text: string): string {
  return text.replace(/\*\*/g, '');
}

/** Fisher-Yates shuffle; returns a new array. */
export function shuffle<T>(items: readonly T[], rng: Rng = Math.random): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function pick<T>(items: readonly T[], rng: Rng = Math.random): T {
  return items[Math.floor(rng() * items.length)];
}

/** "top-k-frequent-elements" → "Top K Frequent Elements" */
export function slugTitle(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Returns the text for the given language when the value is per-language. */
export function langText(text: string | PerLang<string>, lang: LangId): string {
  return typeof text === 'string' ? text : text[lang];
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** Rounds to 4 decimals so stored numbers stay readable (33.3333 instead of 33.333333333333336). */
export function r4(v: number | null): number | null {
  return v === null ? null : Math.round(v * 10000) / 10000;
}
