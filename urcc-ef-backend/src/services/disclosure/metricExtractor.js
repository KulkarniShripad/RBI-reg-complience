/**
 * Finds the bank's own reported figures in document text (deterministic).
 *
 * For each line and each metric label found in it, the first plausible number
 * AFTER the label is a candidate. In tables that is the current-period column
 * (KM1, Notes to Accounts and results tables all put the current period
 * first). Candidates are scored and the best one per metric is kept, with the
 * others listed as alternatives for review:
 *
 *   + table row (cells), "%" on the number, a Pillar 3 key-metrics page,
 *     standalone figures
 *   - a regulatory minimum / requirement nearby (e.g. "minimum CRAR of 9%"),
 *     consolidated figures, a number far from its label
 *
 * Amounts are converted to ₹ crore using the unit stated on the line or page
 * ("₹ in lakh", "Rs. million", "(Amount in ₹ crore)").
 */
const catalog = require("./metricCatalog");

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const NUMBER = /\(?-?(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d+)?\)?(?:\s*%|\s*per\s*cent)?/gi;
const REQUIREMENT_CONTEXT = /\b(?:minimum|min\.|required|requirement|regulatory\s+(?:limit|norm|requirement)|prescribed|stipulated|mandated|threshold|at\s+least|not\s+less\s+than)\b/i;
const UNIT_WORDS = [
  [/\b(?:crores?|cr\.?)(?![a-z])/i, 1, "crore"],
  [/\blakhs?\b|\blacs?\b/i, 0.01, "lakh"],
  [/\b(?:millions?|mn)\b/i, 0.1, "million"],
  [/\b(?:billions?|bn)\b/i, 100, "billion"],
  [/\bthousands?\b|'000/i, 0.0001, "thousand"],
];

function unitOf(text) {
  const t = String(text || "");
  if (!/₹|\brs\.?|\binr\b|amount|rupees|\bin\b/i.test(t)) return null;
  for (const [re, factor, name] of UNIT_WORDS) if (re.test(t)) return { factor, name };
  return null;
}

function parseNumber(tok) {
  const neg = /^\(.*\)$/.test(tok.replace(/\s*%|\s*per\s*cent/i, "").trim()) || /^-/.test(tok.trim());
  const num = parseFloat(tok.replace(/[(),%\s]|per\s*cent/gi, "").replace(/^-/, ""));
  if (!Number.isFinite(num)) return null;
  return neg ? -num : num;
}

/** Numbers in `text`, skipping dates, years, row numbers glued to letters, "Q1", "FY25" etc. */
function numbersIn(text) {
  const out = [];
  NUMBER.lastIndex = 0;
  let m;
  while ((m = NUMBER.exec(text))) {
    const tok = m[0];
    const start = m.index;
    const end = start + tok.length;
    const before = text.slice(Math.max(0, start - 12), start);
    const after = text.slice(end, end + 12);
    if (/[A-Za-z]$/.test(before) && !/\s$/.test(before)) continue; // Q1, FY25, T-1 glued
    if (/^[A-Za-z]/.test(after) && !/^\s/.test(after) && !/^(?:cr|crore|%)/i.test(after)) continue;
    if (/^[./-]\d/.test(after) || /\d[./-]$/.test(before)) continue; // 30.06.2025, 30/06/2025
    if (new RegExp(`(?:${MONTHS})\\.?\\s*,?\\s*$`, "i").test(before)) continue; // June 30
    if (new RegExp(`^\\s*(?:st|nd|rd|th)?\\s*(?:${MONTHS})\\b`, "i").test(after)) continue; // 30th June
    const value = parseNumber(tok);
    if (value === null) continue;
    const pct = /%|per\s*cent/i.test(tok);
    const isYear = !pct && Number.isInteger(value) && value >= 1990 && value <= 2100 && !/,/.test(tok);
    if (isYear) continue;
    out.push({ value, pct, start, end, raw: tok.trim() });
  }
  return out;
}

function labelMatches(metric, text) {
  const hits = [];
  const patterns = [...metric.labels.map((re) => [re, false]), ...(metric.pctOnly || []).map((re) => [re, true])];
  for (const [re, pctOnly] of patterns) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    let m;
    while ((m = g.exec(text))) {
      if (m[0].length === 0) {
        g.lastIndex++;
        continue;
      }
      const window = text.slice(Math.max(0, m.index - 25), m.index + m[0].length);
      if (metric.exclude && metric.exclude.test(window)) continue;
      hits.push({ start: m.index, end: m.index + m[0].length, label: m[0], pctOnly });
    }
  }
  // keep the earliest distinct positions
  // earliest first; at the same position a specific label beats a pctOnly one
  hits.sort((a, b) => a.start - b.start || a.pctOnly - b.pctOnly || b.end - a.end);
  const kept = [];
  for (const h of hits) if (!kept.length || h.start >= kept[kept.length - 1].end) kept.push(h);
  return kept;
}

function pageContext(page) {
  const head = page.lines.slice(0, 15).join(" ");
  const all = page.lines.join(" ");
  const basis = /\bconsolidated\b/i.test(head) && !/\bstandalone\b/i.test(head)
    ? "consolidated"
    : /\bstandalone\b|\bsolo\b/i.test(head)
      ? "standalone"
      : null;
  let unit = null;
  for (const l of page.lines) {
    if (/(?:₹|rs\.?|inr|amount|rupees)\s*(?:in\s*)?(?:crores?|cr\b|lakhs?|million|mn|billion|thousands?|'000)|\(\s*in\s*(?:crores?|lakhs?|million|billion)\s*\)/i.test(l)) {
      unit = unitOf(l);
      if (unit) break;
    }
  }
  return { basis, unit, keyMetrics: /\bKM1\b|key\s+(?:prudential\s+)?metrics|key\s+(?:prudential\s+)?ratios/i.test(all) };
}

/**
 * @param {{page:number, lines:string[]}[]} pages
 * @param {{docUnit?:{factor:number,name:string}}} [opts]
 * @returns {{metrics: Object<string, object>, candidates: number}}
 */
function extractMetrics(pages, opts = {}) {
  const found = new Map(); // key -> candidates[]
  let docUnit = opts.docUnit || null;
  if (!docUnit) {
    const counts = new Map();
    for (const p of pages) {
      const u = pageContext(p).unit;
      if (u) counts.set(u.name, { u, n: (counts.get(u.name)?.n || 0) + 1 });
    }
    docUnit = [...counts.values()].sort((a, b) => b.n - a.n)[0]?.u || null;
  }

  for (const page of pages) {
    const ctx = pageContext(page);
    page.lines.forEach((line, li) => {
      const isRow = line.includes(" | ");
      for (const metric of catalog.METRICS) {
        for (const hit of labelMatches(metric, line)) {
          let rest = line.slice(hit.end);
          let joinedNext = false;
          let nums = numbersIn(rest);
          // label alone on its line, values on the next one ("CRAR (%)" / "15.88 | 16.12")
          if (!nums.length && li + 1 < page.lines.length && /^[\s|()\d.,%-]+$/.test(page.lines[li + 1])) {
            rest = page.lines[li + 1];
            nums = numbersIn(rest);
            joinedNext = true;
          }
          if (!nums.length) continue;

          // narrative "from 2.88% to 2.25%": the reported value is the "to" one
          const fromTo = /\bfrom\s+[\d.,]+\s*(?:%|per\s*cent)?\s+to\s+/i.exec(rest);
          if (fromTo) nums = nums.filter((n) => n.start >= fromTo.index + fromTo[0].length);

          const lineUnit = metric.kind === "amount" ? unitOf(rest.slice(0, 40)) || unitOf(line) : null;
          for (const n of nums.slice(0, 3)) {
            let value = n.value;
            let unitNote = null;
            if (metric.kind === "amount") {
              const u = lineUnit || ctx.unit || docUnit;
              if (u) {
                value = +(value * u.factor).toFixed(4);
                unitNote = u.name;
              }
              if (n.pct) continue;
            } else if (/\b(?:crores?|lakhs?|₹|rs\.?)\b/i.test(rest.slice(Math.max(0, n.start - 6), n.end + 8)) && !n.pct) {
              continue; // an amount on a ratio row
            }
            if (value < metric.range[0] || value > metric.range[1]) continue;
            if (hit.pctOnly && !n.pct) continue;
            // a bare small integer in a ratio row is usually a row / note number
            if (metric.kind === "ratio" && !n.pct && !/\./.test(n.raw) && value < 3 && nums.length > 1) continue;

            const gap = rest.slice(0, n.start);
            let score = 2;
            const why = [];
            if (isRow || joinedNext) (score += 2), why.push("table row");
            if (n.pct || /\(%\)|%\s*$|\bratio\b|per\s*cent/i.test(hit.label + gap)) (score += 1), why.push("percentage");
            if (ctx.keyMetrics && metric.kind === "ratio") (score += 1), why.push("key metrics page");
            const around = line.slice(Math.max(0, hit.start - 40), hit.end + n.end + 10);
            if (REQUIREMENT_CONTEXT.test(around)) (score -= 5), why.push("near a regulatory minimum");
            if (gap.replace(/[\s|:()%-]/g, "").length > 40) (score -= 2), why.push("far from its label");
            const lineBasis = /\bconsolidated\b/i.test(line) ? "consolidated" : /\bstandalone\b/i.test(line) ? "standalone" : ctx.basis;
            if (lineBasis === "standalone") score += 1;
            if (lineBasis === "consolidated") (score -= 1), why.push("consolidated");
            if (metric.kind === "amount" && !unitNote) (score -= 2), why.push("unit not stated - assumed ₹ crore");
            if (metric.kind === "amount" && lineUnit) (score += 1), why.push(`unit on the line (${lineUnit.name})`);
            if (n !== nums[0]) score -= 2;

            const list = found.get(metric.key) || [];
            list.push({
              value,
              unit: metric.unit,
              basis: lineBasis,
              page: page.page,
              snippet: (joinedNext ? `${line} ⏎ ${page.lines[li + 1]}` : line).slice(0, 300),
              method: isRow || joinedNext ? "table" : "text",
              score,
              why,
              unit_note: unitNote,
            });
            found.set(metric.key, list);
            break; // first acceptable number after this label only
          }
        }
      }
    });
  }

  const metrics = {};
  for (const [key, list] of found) {
    list.sort((a, b) => b.score - a.score || a.page - b.page);
    const best = list[0];
    const distinct = [];
    for (const c of list.slice(1)) {
      if (c.value !== best.value && !distinct.some((d) => d.value === c.value)) distinct.push(c);
    }
    const agreeing = list.filter((c) => c.value === best.value).length;
    const confidence = best.score >= 5 || (best.score >= 4 && agreeing >= 2) ? "high" : best.score >= 3 ? "medium" : "low";
    metrics[key] = {
      metric_key: key,
      value: best.value,
      unit: best.unit,
      basis: best.basis,
      page: best.page,
      snippet: best.snippet,
      method: best.method,
      confidence,
      why: best.why,
      unit_note: best.unit_note,
      alternatives: distinct.slice(0, 4).map((c) => ({ value: c.value, page: c.page, snippet: c.snippet, basis: c.basis })),
    };
  }
  return { metrics, candidates: [...found.values()].reduce((n, l) => n + l.length, 0) };
}

/** Structured figures (JSON upload, spreadsheet with a name/value layout). */
function metricsFromStructured(rows) {
  const metrics = {};
  const unknown = [];
  for (const r of rows) {
    const metric = catalog.metricForAlias(r.name);
    if (!metric) {
      unknown.push(r.name);
      continue;
    }
    let value = r.value;
    const u = metric.kind === "amount" ? unitOf(`₹ ${r.unit || ""}`) : null;
    if (u) value = +(value * u.factor).toFixed(4);
    metrics[metric.key] = {
      metric_key: metric.key,
      value,
      unit: metric.unit,
      basis: r.basis || null,
      page: r.page || 1,
      snippet: `${r.name}: ${r.value}${r.unit ? ` ${r.unit}` : ""}`,
      method: "structured",
      confidence: "high",
      why: ["named field"],
      alternatives: [],
    };
  }
  return { metrics, unknown };
}

module.exports = { extractMetrics, metricsFromStructured, numbersIn, unitOf, labelMatches };
