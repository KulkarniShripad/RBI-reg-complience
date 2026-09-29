/**
 * Effective-dated rules (journal Sec. V.L): a threshold that changes on a
 * stated date, read from the paragraph that states the schedule, so a check
 * "as on" a date uses the version in force on that date.
 *
 * Implemented for the schedules the corpus states explicitly:
 *   crr            Cash Reserve Ratio phase-down 3.75 → 3.5 → 3.25 → 3.0 per
 *                  cent of NDTL from four reporting fortnights of 2025
 *                  (CRR/SLR directions of every bank category, para 8-9)
 *   ucb_net_worth  UCB minimum net worth: 50% of ₹5 crore by 31-Mar-2026, the
 *                  full ₹5 crore by 31-Mar-2028 (UCB capital directions, para 6)
 *
 * Every schedule is parsed from the corpus at runtime; if the paragraph is not
 * found the rule has no versions and callers treat it as unverified.
 */
const db = require("../../config/db");

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

const CRR_RE =
  /not be less than ([\d.]+) per cent, ([\d.]+) per cent, ([\d.]+) per cent and ([\d.]+) per cent of its NDTL[\s\S]*?effective from the reporting fortnight beginning ([A-Za-z]+) (\d{1,2}), ([A-Za-z]+) (\d{1,2}), ([A-Za-z]+) (\d{1,2}) and ([A-Za-z]+) (\d{1,2}), (\d{4})/i;
const NW_RE = /at least 50 per cent of the applicable minimum net worth on or before March 31, (\d{4}) and the entire stipulated minimum net worth on or before March 31, (\d{4})/i;

const cache = new Map();

function findClause(category, titleRe, textRe) {
  const docs = db
    .prepare("SELECT d.doc_id, d.title, d.rbi_ref FROM documents d JOIN document_categories dc ON dc.doc_id = d.doc_id WHERE dc.category = ?")
    .all(category)
    .filter((d) => titleRe.test(d.title));
  for (const d of docs) {
    for (const c of db.prepare("SELECT clause_uri, paragraph_number, page_number, clause_text FROM clause_registry WHERE doc_id = ? ORDER BY seq").all(d.doc_id)) {
      const m = textRe.exec(c.clause_text);
      if (m) return { m, clause: c, doc: d };
    }
  }
  return null;
}

/**
 * @returns {{rule:string, category:string, unit:string, operator:string,
 *   versions:{version:number, effective_from:string, threshold:number}[],
 *   source:{clause_uri:string, paragraph:string, page_number:number, rbi_ref:string, doc_title:string}}|null}
 */
function schedule(category, rule) {
  const key = `${category}:${rule}`;
  if (cache.has(key)) return cache.get(key);
  let out = null;
  if (rule === "crr") {
    const hit = findClause(category, /Cash Reserve Ratio and Statutory Liquidity Ratio/i, CRR_RE);
    if (hit) {
      const m = hit.m;
      const year = Number(m[13]);
      const vals = [m[1], m[2], m[3], m[4]].map(Number);
      const dates = [[m[5], m[6]], [m[7], m[8]], [m[9], m[10]], [m[11], m[12]]].map(([mon, d]) => iso(year, MONTHS[mon.toLowerCase()], Number(d)));
      out = {
        rule, category, unit: "% of NDTL", operator: ">=",
        versions: vals.map((v, i) => ({ version: i + 1, effective_from: dates[i], threshold: v })),
        source: { clause_uri: hit.clause.clause_uri, paragraph: hit.clause.paragraph_number, page_number: hit.clause.page_number, rbi_ref: hit.doc.rbi_ref, doc_title: hit.doc.title },
      };
    }
  } else if (rule === "ucb_net_worth" && category === "urban_cooperative_banks") {
    const hit = findClause(category, /Urban Co-operative Banks - Prudential Norms on Capital Adequacy/i, NW_RE);
    if (hit) {
      out = {
        rule, category, unit: "₹ crore", operator: ">=",
        versions: [
          { version: 1, effective_from: iso(Number(hit.m[1]), 3, 31), threshold: 2.5 },
          { version: 2, effective_from: iso(Number(hit.m[2]), 3, 31), threshold: 5 },
        ],
        source: { clause_uri: hit.clause.clause_uri, paragraph: hit.clause.paragraph_number, page_number: hit.clause.page_number, rbi_ref: hit.doc.rbi_ref, doc_title: hit.doc.title },
      };
    }
  }
  cache.set(key, out);
  return out;
}

/** The version in force on `asOf` (ISO date), or null before the first version. */
function versionAt(sched, asOf) {
  if (!sched || !asOf) return null;
  let cur = null;
  for (const v of sched.versions) if (v.effective_from <= asOf) cur = v;
  return cur;
}

module.exports = { schedule, versionAt };
