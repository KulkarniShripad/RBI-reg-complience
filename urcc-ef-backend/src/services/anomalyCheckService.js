/**
 * Deterministic sanity checks on a submitted quantitative value, run
 * BEFORE it's accepted into bank_quant_submissions. None of this needs to
 * know "the truth" of what the number represents - it only needs to know
 * what's PLAUSIBLE, which is checkable without any LLM:
 *
 *  1. Range validation by unit - a '%' field outside [0,100] is wrong
 *     regardless of what it's labeled. A day-count field can't be negative.
 *  2. Period-over-period anomaly - compare against this bank's own
 *     submission history for the SAME rule_id. A jump that's implausibly
 *     large (z-score based) gets flagged - this is exactly the "deposits
 *     entered where withdrawals should be" class of error: the number is
 *     valid on its own, but wildly inconsistent with the bank's own trend.
 *
 * These never block a submission outright (a real, large swing can be a
 * genuine event) - they attach a `flags` array the reviewer sees alongside
 * the deterministic PASS/BREACH verdict, same non-blocking pattern as the
 * LLM mapping-check warning in quantComplianceService.js.
 */
const db = require("../config/db");

function rangeCheck(value, unit) {
  const flags = [];
  const u = (unit || "").toLowerCase();
  if (u === "%") {
    if (value < 0 || value > 100) flags.push(`Value ${value}% is outside the plausible 0-100% range for a percentage field.`);
  }
  if (u.includes("day")) {
    if (value < 0) flags.push(`Value ${value} is negative for a day-count field.`);
    if (value > 3660) flags.push(`Value ${value} days (>10 years) is implausible for a compliance turnaround field - double check units.`);
  }
  if (value < 0 && !u.includes("crore") && !u.includes("lakh")) {
    // Negative monetary figures can occasionally be legitimate (e.g. a net
    // position); percentages/day-counts almost never should be, hence the
    // more specific checks above. This is a soft catch-all for anything else.
    flags.push(`Value ${value} is negative - confirm this is expected for this field.`);
  }
  return flags;
}

/**
 * z-score style check against the bank's own history for this rule_id.
 * With few data points this is necessarily rough - flagged as "low
 * confidence" rather than suppressed, since even 2-3 points can catch an
 * obvious swap (e.g. this quarter's HTM% suddenly equals what looks like
 * last quarter's totally different CRR% value).
 */
function trendAnomalyCheck(bankId, ruleId, newValue, excludePeriod) {
  const history = db
    .prepare(
      `SELECT reported_value FROM bank_quant_submissions
       WHERE bank_id = ? AND rule_id = ? AND period_label != ?
       ORDER BY submitted_at DESC LIMIT 8`
    )
    .all(bankId, ruleId, excludePeriod || "")
    .map((r) => r.reported_value);

  if (history.length < 2) return []; // not enough history to say anything meaningful

  const mean = history.reduce((a, b) => a + b, 0) / history.length;
  const variance = history.reduce((a, b) => a + (b - mean) ** 2, 0) / history.length;
  const stddev = Math.sqrt(variance);

  if (stddev === 0) {
    // Perfectly flat history - any change at all is worth a low-confidence note
    if (newValue !== mean) {
      return [
        `This bank has reported exactly ${mean} for every prior period; ${newValue} is the first change. Worth a manual glance, not necessarily an error.`,
      ];
    }
    return [];
  }

  const z = Math.abs((newValue - mean) / stddev);
  if (z > 3) {
    return [
      `Value ${newValue} is ${z.toFixed(1)} standard deviations from this bank's own recent history ` +
        `(mean ${mean.toFixed(2)}, last ${history.length} periods). Large jumps are sometimes real events, ` +
        `but this is also the exact pattern a wrong-field data-entry error produces - confirm before treating as final.`,
    ];
  }
  return [];
}

function checkSubmission({ bankId, ruleId, reportedValue, periodLabel }) {
  const rule = db.prepare(`SELECT threshold_unit FROM rule_atoms WHERE rule_id = ?`).get(ruleId);
  const flags = [
    ...rangeCheck(reportedValue, rule?.threshold_unit),
    ...trendAnomalyCheck(bankId, ruleId, reportedValue, periodLabel),
  ];
  return flags;
}

module.exports = { checkSubmission, rangeCheck, trendAnomalyCheck };
