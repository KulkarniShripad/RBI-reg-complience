/**
 * The five compliance decisions of the journal (Sec. VII.K) and how every
 * status the subsystems already produce maps onto them.
 *
 * The subsystems keep their own, more specific statuses (a "buffer
 * shortfall" says more than "non-compliant"), so nothing that reads
 * `status` changes; `decision` is added next to it:
 *
 *   COMPLIANT              the evidence satisfies the rule's stated requirement
 *   NON_COMPLIANT          the evidence affirmatively fails it
 *   INSUFFICIENT_DATA      a required evidence field is missing
 *   AMBIGUOUS              the evidence neither clearly satisfies nor violates it
 *   REQUIRES_HUMAN_REVIEW  no automated modality can give a defensible decision
 */

const DECISIONS = Object.freeze({
  COMPLIANT: "COMPLIANT",
  NON_COMPLIANT: "NON_COMPLIANT",
  INSUFFICIENT_DATA: "INSUFFICIENT_DATA",
  AMBIGUOUS: "AMBIGUOUS",
  REQUIRES_HUMAN_REVIEW: "REQUIRES_HUMAN_REVIEW",
});

const STATUS_TO_DECISION = {
  // deterministic checks
  PASS: DECISIONS.COMPLIANT,
  PASS_WITH_CONDITIONS: DECISIONS.COMPLIANT, // allowed by a transition in the same paragraph
  BREACH: DECISIONS.NON_COMPLIANT,
  BUFFER_SHORTFALL: DECISIONS.NON_COMPLIANT, // fails the buffer requirement (not the minimum)
  TARGET_SHORTFALL: DECISIONS.NON_COMPLIANT, // fails the lending target
  NOT_REPORTED: DECISIONS.INSUFFICIENT_DATA,
  NOT_DISCLOSED: DECISIONS.INSUFFICIENT_DATA,
  INSUFFICIENT_DATA: DECISIONS.INSUFFICIENT_DATA,
  // qualitative (LLM-judged)
  COVERED: DECISIONS.COMPLIANT,
  PARTIAL: DECISIONS.AMBIGUOUS,
  LIKELY_GAP: DECISIONS.NON_COMPLIANT,
  NOT_DEMONSTRATED: DECISIONS.NON_COMPLIANT,
  EVIDENCE_FOUND: DECISIONS.REQUIRES_HUMAN_REVIEW, // matched but not judged
  // disclosure completeness
  PRESENT: DECISIONS.COMPLIANT,
  LIKELY_MISSING: DECISIONS.NON_COMPLIANT,
  // network (graph) check
  PROHIBITED: DECISIONS.NON_COMPLIANT,
  POTENTIAL_BREACH: DECISIONS.AMBIGUOUS, // breach only through unconfirmed links
  ASSESSMENT_REQUIRED: DECISIONS.INSUFFICIENT_DATA, // economic-dependence assessment missing
  REPORTABLE: DECISIONS.COMPLIANT, // a reporting duty, not a violation
  INFO: DECISIONS.COMPLIANT,
  // escalation
  NEEDS_REVIEW: DECISIONS.REQUIRES_HUMAN_REVIEW,
  CANDIDATE: DECISIONS.REQUIRES_HUMAN_REVIEW,
  REQUIRES_HUMAN_REVIEW: DECISIONS.REQUIRES_HUMAN_REVIEW,
  // already a decision
  COMPLIANT: DECISIONS.COMPLIANT,
  NON_COMPLIANT: DECISIONS.NON_COMPLIANT,
  AMBIGUOUS: DECISIONS.AMBIGUOUS,
};

function decisionOf(status) {
  return STATUS_TO_DECISION[String(status || "").toUpperCase()] || DECISIONS.REQUIRES_HUMAN_REVIEW;
}

/** Adds `decision` to every row (rows are copied, not mutated). */
function withDecisions(rows) {
  return (rows || []).map((r) => ({ ...r, decision: decisionOf(r.status) }));
}

function decisionCounts(rows) {
  const out = Object.fromEntries(Object.values(DECISIONS).map((d) => [d, 0]));
  for (const r of rows || []) out[r.decision || decisionOf(r.status)]++;
  return out;
}

// ── Corrective recommendations (journal Sec. VII.I) ──
// Derived from the rule's own requirement, never from an LLM, and worded as
// a recommendation so it is not read as a binding regulatory determination.

const fmt = (v, unit) => {
  const n = Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return unit === "%" ? `${n}%` : unit ? `${n} ${unit}` : n;
};
const ref = (s) => (s && s.rbi_ref ? ` (${s.rbi_ref}${s.paragraph ? `, para ${s.paragraph}` : ""})` : "");

/** Recommendation for a figure-based rule result ({metric_label, reported_value, threshold, operator, unit, level, source}). */
function recommendForRule(r) {
  if (!r || r.reported_value === null || r.reported_value === undefined || r.threshold === null || r.threshold === undefined) return null;
  const d = r.decision || decisionOf(r.status);
  if (d !== DECISIONS.NON_COMPLIANT) return null;
  const gap = Math.abs(Number(r.threshold) - Number(r.reported_value));
  const gapText = r.unit === "%" ? `${fmt(gap, "")} percentage points` : fmt(gap, r.unit);
  const upper = r.operator === "<=" || r.operator === "<";
  const bound = upper ? (r.operator === "<" ? "below" : "at most") : r.operator === ">" ? "above" : "at least";
  const base = `${upper ? "Reduce" : "Raise"} ${r.metric_label || "the figure"} from ${fmt(r.reported_value, r.unit)} to ${bound} ${fmt(r.threshold, r.unit)}`;
  if (r.level === "buffer") {
    return `${base} (a gap of ${gapText}) to restore the capital conservation buffer; until then restrict distributions (dividends, share buybacks, discretionary bonuses) as the buffer paragraph requires${ref(r.source)}.`;
  }
  if (r.level === "target") {
    return `${base} (a shortfall of ${gapText}); the shortfall is allocated to RIDF / other funds as the direction provides${ref(r.source)}.`;
  }
  return `${base} (a gap of ${gapText}) and document the remediation plan for the Board${ref(r.source)}.`;
}

/** Recommendation for a network (graph) result. */
function recommendForNetwork(r) {
  const d = r.decision || decisionOf(r.status);
  if (d !== DECISIONS.NON_COMPLIANT) return null;
  const who = r.subject?.name || "the counterparty";
  if (r.status === "PROHIBITED") {
    return `Do not grant (or recall / seek RBI guidance on) the facility to ${who}; the path to the bank's director / promoter shown above makes it a prohibited related-party loan${ref(r.source)}.`;
  }
  if (r.exposure && r.exposure_pct && r.limit_pct) {
    const excess = r.exposure - (r.exposure * r.limit_pct) / r.exposure_pct;
    return `Reduce exposure to ${who} from ${fmt(r.exposure_pct, "%")} to at most ${fmt(r.limit_pct, "%")} of the capital base (about ₹${fmt(excess, "")} crore), e.g. by sell-down, credit risk mitigation or not renewing limits${ref(r.source)}.`;
  }
  return `Bring the exposure to ${who} within the limit${ref(r.source)}.`;
}

/** Recommendation for a qualitative / disclosure result. */
function recommendForQualitative(r, kind = "obligation") {
  const d = r.decision || decisionOf(r.status);
  if (d !== DECISIONS.NON_COMPLIANT) return null;
  if (kind === "disclosure") {
    return `Add the "${r.label}" disclosure to the published document${ref(r.source)}.`;
  }
  return `Record documented evidence (Board-approved policy, minutes or procedure) that addresses this obligation${ref({ rbi_ref: r.rbi_ref, paragraph: r.paragraph })}.`;
}

module.exports = {
  DECISIONS,
  STATUS_TO_DECISION,
  decisionOf,
  withDecisions,
  decisionCounts,
  recommendForRule,
  recommendForNetwork,
  recommendForQualitative,
};
