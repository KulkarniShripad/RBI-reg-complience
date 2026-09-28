/**
 * Requirements on published figures, per institution category, each anchored
 * to the paragraph of the Master Direction that states it.
 *
 * A rule is applied only after its anchor is found in the corpus: the
 * direction's title must match `source.title` and one of its paragraphs must
 * contain `source.text` (which includes the number itself). If RBI changes the
 * paragraph and the corpus is rebuilt, a rule whose wording or number no
 * longer matches is reported as NEEDS_REVIEW instead of being applied with a
 * stale threshold. The threshold shown in the report is the one in that
 * paragraph; the excerpt is quoted in the report.
 *
 * Levels
 *   minimum  below it is a BREACH
 *   buffer   a capital buffer above the minimum; below it the bank is not in
 *            breach but capital distribution constraints apply (BUFFER_SHORTFALL)
 *   target   a lending target; a shortfall has consequences (e.g. RIDF
 *            contribution) but is not a breach (TARGET_SHORTFALL)
 */
const db = require("../../config/db");
const { periodEnd } = require("./profileDetector");

const CAPITAL = {
  cb: /^Reserve Bank of India \(Commercial Banks - Prudential Norms on Capital Adequacy\)/i,
  sfb: /^Reserve Bank of India \(Small Finance Banks – Prudential Norms on Capital Adequacy\)/i,
  pb: /^Reserve Bank of India \(Payments Banks – Prudential Norms on Capital Adequacy\)/i,
  ucb: /^Reserve Bank of India \(Urban Co-operative Banks - Prudential Norms on Capital Adequacy\)/i,
  rrb: /^Reserve Bank of India \(Regional Rural Banks - Prudential Norms on Capital Adequacy\)/i,
  lab: /^Reserve Bank of India \(Local Area Banks - Prudential Norms on Capital Adequacy\)/i,
  rcb: /^Reserve Bank of India \(Rural Co-operative Banks - Prudential Norms on Capital Adequacy\)/i,
};
const ALM = {
  cb: /^Reserve Bank of India \(Commercial Banks – Asset Liability Management\)/i,
  sfb: /^Reserve Bank of India \(Small Finance Banks – Asset Liability Management\)/i,
};
const PSL = /^Reserve Bank of India \(Priority Sector Lending – Targets and Classification\)/i;

const CB = "commercial_banks";
const SFB = "small_finance_banks";
const PB = "payments_banks";
const UCB = "urban_cooperative_banks";
const RRB = "regional_rural_banks";
const LAB = "local_area_banks";
const RCB = "rural_cooperative_banks";

const rule = (r) => ({ op: ">=", level: "minimum", ...r });

const RULES = [
  // ── Commercial banks ──
  rule({ key: "cb_crar", category: CB, metric: "crar", threshold: 9, label: "Minimum total capital (CRAR) of 9% of RWAs",
    source: { title: CAPITAL.cb, text: /Capital to Risk-Weighted Assets Ratio \(CRAR\) shall be at least 9 per cent/i } }),
  rule({ key: "cb_cet1", category: CB, metric: "cet1_ratio", threshold: 5.5, label: "Minimum CET1 capital of 5.5% of RWAs",
    source: { title: CAPITAL.cb, text: /CET1 capital shall be at least 5\.5 per cent of the RWAs/i } }),
  rule({ key: "cb_tier1", category: CB, metric: "tier1_ratio", threshold: 7, label: "Minimum Tier 1 capital of 7% of RWAs",
    source: { title: CAPITAL.cb, text: /Tier 1 capital shall be at least 7 per cent of the RWAs/i } }),
  rule({ key: "cb_crar_ccb", category: CB, metric: "crar", threshold: 11.5, level: "buffer",
    label: "CRAR including the 2.5% capital conservation buffer (9% + 2.5%)",
    note: "Below this level the bank is not in breach, but capital distribution constraints (dividends, bonuses) apply.",
    source: { title: CAPITAL.cb, text: /maintain a CCB of 2\.5 per cent which shall comprise of CET1 capital, above the regulatory minimum capital requirement of 9 per cent/i } }),
  rule({ key: "cb_cet1_ccb", category: CB, metric: "cet1_ratio", threshold: 8, level: "buffer",
    label: "CET1 including the 2.5% capital conservation buffer (5.5% + 2.5%)",
    note: "The buffer is held in CET1; below 8% capital distribution constraints apply.",
    source: { title: CAPITAL.cb, text: /maintain a CCB of 2\.5 per cent which shall comprise of CET1 capital/i } }),
  rule({ key: "cb_leverage_dsib", category: CB, metric: "leverage_ratio", threshold: 4, when: (p) => !!p.is_dsib,
    label: "Minimum leverage ratio of 4% (D-SIB)",
    source: { title: CAPITAL.cb, text: /minimum leverage ratio for a Domestic Systemically Important Bank \(D-\s?SIB\) shall be 4 per cent and 3\.5 per cent for other banks/i } }),
  rule({ key: "cb_leverage", category: CB, metric: "leverage_ratio", threshold: 3.5, when: (p) => !p.is_dsib,
    label: "Minimum leverage ratio of 3.5% (banks other than D-SIBs)",
    source: { title: CAPITAL.cb, text: /minimum leverage ratio for a Domestic Systemically Important Bank \(D-\s?SIB\) shall be 4 per cent and 3\.5 per cent for other banks/i } }),
  rule({ key: "cb_lcr", category: CB, metric: "lcr", threshold: 100, label: "Liquidity Coverage Ratio of at least 100%",
    source: { title: ALM.cb, text: /maintain LCR at a minimum of 100 per cent/i } }),
  rule({ key: "cb_nsfr", category: CB, metric: "nsfr", threshold: 100, label: "Net Stable Funding Ratio of at least 100%",
    source: { title: ALM.cb, text: /maintain NSFR of at a minimum of 100 per cent/i } }),
  rule({ key: "cb_psl", category: CB, metric: "psl_anbc_pct", threshold: 40, level: "target",
    label: "Total priority sector lending target of 40% of ANBC",
    note: "Applies to domestic commercial banks and foreign banks with 20 or more branches; a shortfall is allocated to RIDF / other funds rather than being a breach.",
    source: { title: PSL, text: /40 per cent of ANBC/i } }),

  // ── Small finance banks ──
  rule({ key: "sfb_crar", category: SFB, metric: "crar", threshold: 15, label: "Minimum total capital (CRAR) of 15% of RWAs",
    source: { title: CAPITAL.sfb, text: /capital to risk-weighted assets ratio \(CRAR\) shall be at least 15 per cent/i } }),
  rule({ key: "sfb_cet1", category: SFB, metric: "cet1_ratio", threshold: 6, label: "Minimum CET1 capital of 6% of RWAs",
    source: { title: CAPITAL.sfb, text: /CET1 capital shall be at least 6 per cent of the RWAs/i } }),
  rule({ key: "sfb_tier1", category: SFB, metric: "tier1_ratio", threshold: 7.5, label: "Minimum Tier 1 capital of 7.5% of RWAs",
    source: { title: CAPITAL.sfb, text: /Tier 1 capital shall be at least 7\.5 per cent of the RWAs/i } }),
  rule({ key: "sfb_leverage", category: SFB, metric: "leverage_ratio", threshold: 4.5, label: "Minimum leverage ratio of 4.5%",
    source: { title: CAPITAL.sfb, text: /minimum leverage ratio for a bank shall be 4\.5 per cent/i } }),
  rule({ key: "sfb_lcr", category: SFB, metric: "lcr", threshold: 100, label: "Liquidity Coverage Ratio of at least 100%",
    source: { title: ALM.sfb, text: /maintain LCR at a minimum of 100 per cent/i } }),
  rule({ key: "sfb_nsfr", category: SFB, metric: "nsfr", threshold: 100, label: "Net Stable Funding Ratio of at least 100%",
    source: { title: ALM.sfb, text: /maintain NSFR of at a minimum of 100 per cent/i } }),

  // ── Payments banks ──
  rule({ key: "pb_crar", category: PB, metric: "crar", threshold: 15, label: "Minimum total capital (CRAR) of 15% of RWAs",
    source: { title: CAPITAL.pb, text: /Capital to Risk Weighted Asset Ratio \(CRAR\) shall be at least 15 per cent/i } }),
  rule({ key: "pb_cet1", category: PB, metric: "cet1_ratio", threshold: 6, label: "Minimum CET1 capital of 6% of RWAs",
    source: { title: CAPITAL.pb, text: /CET\s?1 capital shall be at least 6 per cent of the RWAs/i } }),
  rule({ key: "pb_tier1", category: PB, metric: "tier1_ratio", threshold: 7.5, label: "Minimum Tier 1 capital of 7.5% of RWAs",
    source: { title: CAPITAL.pb, text: /Tier 1 Capital shall be at least 7\.5 per cent of the RWAs/i } }),
  rule({ key: "pb_leverage", category: PB, metric: "leverage_ratio", threshold: 3, label: "Minimum leverage ratio of 3%",
    note: "Outside liabilities may not exceed 33.33 times net worth.",
    source: { title: CAPITAL.pb, text: /leverage ratio of not less than 3 per cent/i } }),

  // ── Urban co-operative banks ──
  rule({ key: "ucb_crar", category: UCB, metric: "crar",
    threshold: (p) => (p.ucb_tier === 1 ? { value: 9, note: "Tier 1 UCB" } : p.ucb_tier ? { value: 12, note: `Tier ${p.ucb_tier} UCB` } : null),
    bounds: [9, 12],
    label: "Minimum CRAR: 9% for Tier 1 UCBs, 12% for Tiers 2 to 4",
    note: "The tier follows from deposits (Tier 1 up to ₹100 crore, Tier 2 up to ₹1,000 crore, Tier 3 up to ₹10,000 crore, Tier 4 above).",
    source: { title: CAPITAL.ucb, text: /Tier 1 UCB shall maintain a minimum CRAR of 9 per cent[\s\S]*Tiers 2 to 4 shall maintain a minimum CRAR of 12 per cent/i } }),
  rule({ key: "ucb_net_worth", category: UCB, metric: "net_worth", threshold: 5, unit: "₹ crore",
    label: "Minimum net worth of ₹5 crore (₹2 crore for a Tier 1 UCB in a single district)",
    evaluate: ucbNetWorth,
    source: { title: CAPITAL.ucb, text: /All other UCBs \(of all tiers\) shall have minimum net worth of ₹5 crore/i } }),

  // ── Regional rural banks, local area banks, rural co-operative banks ──
  rule({ key: "rrb_crar", category: RRB, metric: "crar", threshold: 9, label: "Minimum CRAR of 9%",
    source: { title: CAPITAL.rrb, text: /RRB is required to maintain a minimum Capital to Risk Weighted Assets Ratio \(CRAR\) of 9 per cent/i } }),
  rule({ key: "rrb_tier1", category: RRB, metric: "tier1_ratio", threshold: 7, label: "Minimum Tier 1 capital of 7% of RWAs",
    source: { title: CAPITAL.rrb, text: /total Tier 1 Capital shall not be less than 7 per cent of RWAs/i } }),
  rule({ key: "lab_crar", category: LAB, metric: "crar", threshold: 9, label: "Minimum CRAR of 9%",
    source: { title: CAPITAL.lab, text: /LAB shall maintain a minimum Capital to Risk-weighted Assets Ratio \(CRAR\) of 9 per cent/i } }),
  rule({ key: "rcb_crar", category: RCB, metric: "crar", threshold: 9, label: "Minimum CRAR of 9%",
    source: { title: CAPITAL.rcb, text: /RCB shall maintain a minimum Capital to Risk Weighted Assets Ratio \(CRAR\) of 9 per cent/i } }),
];

/** UCB net worth with the phase-in in the same paragraph (50% by 31-Mar-2026, 100% by 31-Mar-2028). */
function ucbNetWorth(value, profile) {
  const asOf = profile.as_of_date || periodEnd(profile.period_label) || null;
  if (value >= 5) return { status: "PASS", threshold: 5 };
  if (asOf && asOf < "2028-03-31") {
    const interim = asOf >= "2026-03-31" ? 2.5 : null;
    if (interim === null || value >= interim) {
      return {
        status: "PASS_WITH_CONDITIONS",
        threshold: 5,
        note: `Below ₹5 crore, but the paragraph allows a glide path: 50% (₹2.5 crore) by 31 March 2026 and the full amount by 31 March 2028. ${
          value < 2 ? "" : "A Tier 1 UCB operating in a single district needs only ₹2 crore."
        }`.trim(),
      };
    }
    return { status: "BREACH", threshold: interim, note: "Below the interim requirement of 50% of ₹5 crore due by 31 March 2026." };
  }
  if (value >= 2) {
    return { status: "NEEDS_REVIEW", threshold: 5, note: "Meets ₹2 crore, which is enough only for a Tier 1 UCB operating in a single district." };
  }
  return { status: "BREACH", threshold: 5 };
}

// ── Anchoring to the corpus ──

const sourceCache = new Map();

function excerptAround(text, re) {
  const m = re.exec(text);
  if (!m) return text.slice(0, 400);
  const starts = [...text.slice(0, m.index).matchAll(/(?:[.;:]\s|\n|^\(\d+\)\s)/g)];
  const from = starts.length ? starts[starts.length - 1].index + 1 : 0;
  const tail = text.slice(m.index + m[0].length);
  const stop = tail.search(/[.;](?:\s|$)|\n/);
  const to = m.index + m[0].length + (stop === -1 ? Math.min(tail.length, 200) : stop + 1);
  let s = text.slice(Math.max(from, m.index - 300), to).trim();
  if (s.length > 700) s = `${s.slice(0, 697)}…`;
  return s;
}

/** Paragraph that states the rule, or {verified:false}. Cached per process. */
function resolveSource(r) {
  const cacheKey = `${r.category}:${r.source.title.source}:${r.source.text.source}`;
  if (sourceCache.has(cacheKey)) return sourceCache.get(cacheKey);
  let result = { verified: false, reason: "The paragraph stating this rule was not found in the corpus for this category." };
  try {
    const docs = db
      .prepare(
        `SELECT d.doc_id, d.title, d.rbi_ref FROM documents d
         JOIN document_categories dc ON dc.doc_id = d.doc_id WHERE dc.category = ?`
      )
      .all(r.category)
      .filter((d) => r.source.title.test(d.title));
    if (!docs.length) {
      result = { verified: false, reason: "The direction that states this rule is not in the corpus." };
    }
    for (const d of docs) {
      const clauses = db
        .prepare(`SELECT clause_uri, paragraph_number, page_number, clause_text FROM clause_registry WHERE doc_id = ? ORDER BY seq`)
        .all(d.doc_id);
      const hit = clauses.find((c) => r.source.text.test(c.clause_text));
      if (hit) {
        result = {
          verified: true,
          clause_uri: hit.clause_uri,
          doc_id: d.doc_id,
          doc_title: d.title,
          rbi_ref: d.rbi_ref,
          paragraph: hit.paragraph_number,
          page_number: hit.page_number,
          excerpt: excerptAround(hit.clause_text, new RegExp(r.source.text.source, r.source.text.flags.replace("g", ""))),
        };
        break;
      }
    }
  } catch (err) {
    result = { verified: false, reason: `corpus lookup failed: ${err.message}` };
  }
  sourceCache.set(cacheKey, result);
  return result;
}

function rulesFor(category, profile = {}) {
  return RULES.filter((r) => r.category === category && (!r.when || r.when(profile)));
}

const cmp = { ">=": (v, t) => v >= t, "<=": (v, t) => v <= t, ">": (v, t) => v > t, "<": (v, t) => v < t };

/**
 * Deterministic verdict for one rule and one reported value.
 * @returns {{status:string, threshold:number|null, note?:string}}
 */
function evaluateRule(r, value, profile = {}) {
  if (r.evaluate) return r.evaluate(value, profile);
  let threshold = r.threshold;
  let note = null;
  if (typeof threshold === "function") {
    const t = threshold(profile);
    if (!t) {
      const [lo, hi] = r.bounds;
      if (cmp[r.op](value, hi)) return { status: "PASS", threshold: hi, note: `Meets the higher requirement (${hi}%) whatever the tier.` };
      if (!cmp[r.op](value, lo)) return { status: "BREACH", threshold: lo, note: `Below the lowest requirement (${lo}%) whatever the tier.` };
      return { status: "NEEDS_REVIEW", threshold: null, note: `Between ${lo}% and ${hi}%: the result depends on the bank's tier, which could not be determined (deposits not found).` };
    }
    threshold = t.value;
    note = t.note;
  }
  const ok = cmp[r.op](value, threshold);
  if (ok) return { status: "PASS", threshold, note };
  const status = r.level === "buffer" ? "BUFFER_SHORTFALL" : r.level === "target" ? "TARGET_SHORTFALL" : "BREACH";
  return { status, threshold, note };
}

function clearCache() {
  sourceCache.clear();
}

module.exports = { RULES, rulesFor, resolveSource, evaluateRule, clearCache, excerptAround };
