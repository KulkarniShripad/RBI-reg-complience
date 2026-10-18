#!/usr/bin/env node
// Summarises the study's results from participants/* (completed sessions only).
//
//   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json node scripts/analyze.mjs [flags]
//
// Flags:
//   --pilot            analyse pilot (and debug) sessions instead of real ones
//   --include-flagged  keep participants with data-quality flags (rushed / many fast answers / left the tab)
//   --out <dir>        where to write summary.md (default ./export)
//
// RQ1  Is there a gap between how competent students feel and how competent they are?
//      → calibration gap in Block 1 (mean confidence − % correct), solved count vs accuracy,
//        trust in the solved count vs the gap.
// RQ2  Does concept-level feedback (Group B) make self-assessment more accurate than numbers alone (Group A)?
//      → change in gap, |gap| and Brier score from Block 1 to Block 2, B vs A; topic-level
//        alignment of self-ratings with accuracy before vs after feedback; belief in the solved
//        count before vs after; practice-pack choice.
// All tests are two-sided Welch t-tests (or z-tests for proportions); treat them as a first look,
// and pre-register the main test (Δ gap, B vs A) before collecting data.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const pilotOnly = flag('--pilot');
const includeFlagged = flag('--include-flagged');
const outDir = resolve(opt('--out', './export'));

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Set GOOGLE_APPLICATION_CREDENTIALS to your service-account JSON (see README → Analysing the results).');
  process.exit(1);
}
const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || undefined;
initializeApp(process.env.FIRESTORE_EMULATOR_HOST ? { projectId: projectId || 'demo-dsa' } : { credential: applicationDefault(), projectId });

// ---------------------------------------------------------------- statistics

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const nums = (xs) => xs.filter(isNum);
const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN);
const variance = (xs) => {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1);
};
const sd = (xs) => Math.sqrt(variance(xs));
const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function logGamma(x) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
function betacf(a, b, x) {
  let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}
/** Regularised incomplete beta I_x(a, b). */
function ibeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
const tP = (t, df) => (isNum(t) && df > 0 ? ibeta(df / (df + t * t), df / 2, 0.5) : NaN); // two-sided
function normP(z) {
  // two-sided p from a z score (Abramowitz & Stegun 7.1.26)
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 1 - erf;
}

function welch(a, b) {
  // b − a
  const na = a.length, nb = b.length;
  if (na < 2 || nb < 2) return { diff: mean(b) - mean(a), t: NaN, df: NaN, p: NaN, d: NaN };
  const va = variance(a), vb = variance(b);
  const se = Math.sqrt(va / na + vb / nb);
  const t = (mean(b) - mean(a)) / se;
  const df = (va / na + vb / nb) ** 2 / ((va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1));
  const pooled = Math.sqrt(((na - 1) * va + (nb - 1) * vb) / (na + nb - 2));
  return { diff: mean(b) - mean(a), t, df, p: tP(t, df), d: (mean(b) - mean(a)) / pooled };
}
function oneSample(xs, mu = 0) {
  const n = xs.length;
  if (n < 2) return { mean: mean(xs), t: NaN, df: NaN, p: NaN, d: NaN };
  const t = (mean(xs) - mu) / (sd(xs) / Math.sqrt(n));
  return { mean: mean(xs), t, df: n - 1, p: tP(t, n - 1), d: (mean(xs) - mu) / sd(xs) };
}
function ranks(xs) {
  const order = xs.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}
function correlation(x, y, spearman = false) {
  const pairs = x.map((v, i) => [v, y[i]]).filter(([u, v]) => isNum(u) && isNum(v));
  const n = pairs.length;
  if (n < 3) return { r: NaN, n, p: NaN };
  let xs = pairs.map((p) => p[0]), ys = pairs.map((p) => p[1]);
  if (spearman) { xs = ranks(xs); ys = ranks(ys); }
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  const r = sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
  const t = r * Math.sqrt((n - 2) / Math.max(1e-12, 1 - r * r));
  return { r, n, p: tP(t, n - 2) };
}
function twoProp(k1, n1, k2, n2) {
  if (!n1 || !n2) return { p: NaN };
  const p = (k1 + k2) / (n1 + n2);
  const z = (k2 / n2 - k1 / n1) / Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return { z, p: normP(z) };
}

const f = (v, d = 1) => (isNum(v) ? v.toFixed(d) : '–');
const fp = (p) => (!isNum(p) ? '–' : p < 0.001 ? '< .001' : p.toFixed(3).replace(/^0/, ''));
const msd = (xs, d = 1) => (xs.length ? `${f(mean(xs), d)} (${f(sd(xs), d)})` : '–');
const pct = (k, n) => (n ? `${Math.round((100 * k) / n)}% (${k}/${n})` : '–');

// ---------------------------------------------------------------- data

const snap = await getFirestore().collection('participants').get();
const all = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
const inScope = all.filter((p) => (pilotOnly ? p.pilot === true : p.pilot !== true) && p.withdrawn !== true);
const completed = inScope.filter((p) => p.status === 'completed' && p.derived && p.group);
const flagged = completed.filter((p) => (p.derived.qualityFlags ?? []).length > 0);
const flagCount = (k) => completed.filter((p) => (p.derived.qualityFlags ?? []).includes(k)).length;
const used = includeFlagged ? completed : completed.filter((p) => !(p.derived.qualityFlags ?? []).length);
const A = used.filter((p) => p.group === 'A');
const B = used.filter((p) => p.group === 'B');

const D = (p) => p.derived;
const get = (ps, fn) => nums(ps.map(fn));
const delta = (fn1, fn2) => (p) => (isNum(fn1(p)) && isNum(fn2(p)) ? fn2(p) - fn1(p) : NaN);
const minutes = (p) => {
  const a = p.createdAt?.toDate?.(), b = p.completedAt?.toDate?.();
  return a && b ? (b - a) / 60000 : NaN;
};

const out = [];
const line = (s = '') => out.push(s);
const table = (head, rows) => {
  line(`| ${head.join(' | ')} |`);
  line(`|${head.map(() => ' --- ').join('|')}|`);
  for (const r of rows) line(`| ${r.join(' | ')} |`);
  line();
};

line(`# DSA Self-Check: results summary`);
line();
line(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · ${pilotOnly ? '**pilot data**' : 'real data'} · ${includeFlagged ? 'flagged participants kept' : 'flagged participants excluded'}`);
line();

line(`## Sample`);
table(['', 'n'], [
  ['Started (not withdrawn)', inScope.length],
  ['Completed', completed.length],
  ['Flagged: said they rushed (seriousness check)', flagCount('notSerious')],
  ['Flagged: many very fast answers', flagCount('fast')],
  ['Flagged: left the tab on several questions', flagCount('away')],
  [`Analysed (${includeFlagged ? 'all completed' : 'completed, no flags'})`, used.length],
  ['… Group A (numbers only)', A.length],
  ['… Group B (numbers + topic feedback)', B.length],
  ['Median minutes to complete', f(median(nums(used.map(minutes))), 1)],
  ['Drop-out rate (started but not completed)', pct(inScope.length - completed.length, inScope.length)],
]);
if (used.length < 10) line(`> Fewer than 10 analysed participants: the numbers below are not meaningful yet.\n`);

line(`## RQ1: Is there a gap between how competent students feel and how competent they are?`);
line();
const gap1 = get(used, (p) => D(p).confGap1);
const os = oneSample(gap1);
line(`- **Block 1 calibration gap** (mean confidence − % correct, before any feedback): **${f(os.mean)} points** (SD ${f(sd(gap1))}), t(${f(os.df, 0)}) = ${f(os.t, 2)}, p ${fp(os.p)}, d = ${f(os.d, 2)}. Positive = overconfident.`);
const over = used.filter((p) => D(p).gapLabel1 === 'over').length;
const under = used.filter((p) => D(p).gapLabel1 === 'under').length;
line(`- Overconfident by more than 15 points: ${pct(over, used.length)}; underconfident: ${pct(under, used.length)}.`);
const sc = correlation(used.map((p) => p.profile?.solvedCount), used.map((p) => D(p).score1), true);
line(`- **Solved count vs real accuracy** (Block 1 score): Spearman ρ = ${f(sc.r, 2)} (n = ${sc.n}, p ${fp(sc.p)}). A weak link means the count is a poor guide to skill.`);
const tg = correlation(used.map((p) => p.beliefStart), used.map((p) => D(p).confGap1));
line(`- **Trusting the solved count** ("my solved count shows how good I really am", 1–7) vs the Block 1 gap: r = ${f(tg.r, 2)} (p ${fp(tg.p)}).`);
const pre = get(used, (p) => D(p).scoreGapStart);
line(`- Predicted − actual Block 1 score, guessed before seeing any question: ${msd(pre, 2)} questions (positive = expected to do better).`);
line();

line(`## RQ2: Does concept-level feedback help students judge their skill more accurately?`);
line();
line(`Change = Block 2 − Block 1 (Block 2 comes after the feedback). For the gap and the Brier score, a more negative change means more accurate self-assessment. Main test: **Δ gap, B vs A**.`);
line();
const rows = [];
const measure = (label, fn, decimals = 1) => {
  const a = get(A, fn), b = get(B, fn);
  const w = welch(a, b);
  rows.push([label, msd(a, decimals), msd(b, decimals), f(w.diff, decimals), f(w.d, 2), fp(w.p)]);
};
measure('Gap, Block 1', (p) => D(p).confGap1);
measure('Gap, Block 2', (p) => D(p).confGap2);
measure('**Δ gap** (main outcome)', delta((p) => D(p).confGap1, (p) => D(p).confGap2));
measure('Δ |gap|', delta((p) => D(p).absGap1, (p) => D(p).absGap2));
measure('Brier, Block 1', (p) => D(p).brier1, 3);
measure('Brier, Block 2', (p) => D(p).brier2, 3);
measure('Δ Brier', delta((p) => D(p).brier1, (p) => D(p).brier2), 3);
measure('Score, Block 1 (of 6)', (p) => D(p).score1, 2);
measure('Score, Block 2 (of 6)', (p) => D(p).score2, 2);
measure('Block 2 score guess − score', (p) => D(p).scoreGap2, 2);
measure('Topic self-rating ↔ accuracy, before (ρ)', (p) => D(p).ratingAlign1, 2);
measure('Topic self-rating ↔ accuracy, after feedback (ρ)', (p) => D(p).ratingAlign2, 2);
measure('Δ topic alignment', delta((p) => D(p).ratingAlign1, (p) => D(p).ratingAlign2), 2);
measure('Topic confidence ↔ accuracy, Block 2 (ρ)', (p) => D(p).confAlign2, 2);
measure('Trust in solved count, change (1–7)', (p) => D(p).beliefChange, 2);
measure('Seconds on the feedback screen', (p) => (isNum(p.feedback1?.timeOnScreenMs) ? p.feedback1.timeOnScreenMs / 1000 : NaN), 1);
table(['Measure', 'A mean (SD)', 'B mean (SD)', 'B − A', 'd', 'p'], rows);

const k = (ps, fn) => ps.filter(fn).length;
const med = twoProp(k(A, (p) => p.packType === 'medium'), A.length, k(B, (p) => p.packType === 'medium'), B.length);
const weak = twoProp(k(A, (p) => D(p).packIsWeakest === true), A.length, k(B, (p) => D(p).packIsWeakest === true), B.length);
line(`**Practice-pack choice** (a real choice made after the feedback):`);
line();
table(['', 'Group A', 'Group B', 'p'], [
  ['Chose the Medium pack (real skill over count)', pct(k(A, (p) => p.packType === 'medium'), A.length), pct(k(B, (p) => p.packType === 'medium'), B.length), fp(med.p)],
  ['Chose their own weakest topic', pct(k(A, (p) => D(p).packIsWeakest === true), A.length), pct(k(B, (p) => D(p).packIsWeakest === true), B.length), fp(weak.p)],
]);

line(`**What participants used to judge how they were doing:**`);
line();
const ui = JSON.parse(readFileSync(new URL('../src/content/ui-text.json', import.meta.url), 'utf8'));
const judgedLabel = (id) => ui.endSurvey.judgedBy.options.find((o) => o.id === id)?.label ?? id;
const options = [...new Set(used.map((p) => p.endSurvey?.judgedBy).filter(Boolean))];
table(['Answer', 'Group A', 'Group B'], options.map((o) => [judgedLabel(o), pct(k(A, (p) => p.endSurvey?.judgedBy === o), A.length), pct(k(B, (p) => p.endSurvey?.judgedBy === o), B.length)]));

line(`## How to read this`);
line();
line(`- **Gap**: average confidence minus % correct. 0 = well calibrated; +20 = 20 points more confident than accurate.`);
line(`- **Brier score**: squared distance between confidence and being right (0 = perfect, 0.25 ≈ always saying 50%).`);
line(`- **Topic alignment (ρ)**: does the participant rate highest the topics they actually do best on? +1 = perfect order.`);
line(`- **d**: Cohen's effect size (0.2 small, 0.5 medium, 0.8 large). **p**: two-sided Welch t-test (z-test for %).`);
line(`- Block 2 includes per-question feedback for everyone, so Block 2 confidence is partly informed by it in both groups; the A/B difference is the concept-level part.`);

mkdirSync(outDir, { recursive: true });
const file = join(outDir, 'summary.md');
writeFileSync(file, out.join('\n') + '\n', 'utf8');
console.log(out.join('\n'));
console.log(`\nWritten to ${file}`);
