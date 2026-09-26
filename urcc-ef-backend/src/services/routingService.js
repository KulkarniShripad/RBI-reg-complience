/**
 * ROUTING SERVICE — implements §5 of URCC-EF_Research_Blueprint.md.
 *
 * This is the "which reasoning modality should decide this clause"
 * decision, NOT "which LLM should I call" (that's a different, already
 * crowded problem — see the blueprint's §1.1 for why that distinction
 * matters for the research framing).
 *
 * Four possible routes per clause+bank-data instance:
 *   RULE_ENGINE   - deterministic SQL/operator evaluation (quantService.js)
 *   GRAPH         - connected-counterparty reasoning (design-only stub here,
 *                   see blueprint §7 — not evaluated against real data)
 *   RAG_LLM       - retrieval + Gemini judgment (qualService.js)
 *   HUMAN         - insufficient confidence anywhere; escalate
 *
 * Every routing decision returns WHY it routed where it did (the signals
 * that fired), because the whole point of the research contribution is
 * that the choice is explainable and driven by regulatory-clause features,
 * not a black-box classifier.
 */

const ROUTES = Object.freeze({
  RULE_ENGINE: "RULE_ENGINE",
  GRAPH: "GRAPH",
  RAG_LLM: "RAG_LLM",
  HUMAN: "HUMAN",
});

// Tunable thresholds - kept as named constants (not magic numbers) so an
// ablation can vary exactly one of these and report the effect, per the
// blueprint's ablation-study design (§ "Ablation Studies" carried over
// from the original brief).
const THRESHOLDS = {
  RETRIEVAL_SCORE_SPREAD_CONFIDENT: 0.15, // gap between top-1 and top-2 vector hits
  RETRIEVAL_SCORE_SPREAD_HIGH_RISK: 0.30, // stricter bar when risk_tier is high
  // Spread collapses toward zero when the evidence candidate pool is small
  // (e.g. a bank that has only submitted 1-2 evidence documents so far -
  // every candidate looks "equally similar" in relative terms even when
  // the top match is a genuinely strong absolute match). Confirmed by
  // testing against a real 2-document evidence pool: spread was 0.000 for
  // a clause whose top-1 absolute similarity was 0.89. Below this pool
  // size, fall back to an absolute-score floor instead of relative spread.
  SMALL_POOL_SIZE: 3,
  RETRIEVAL_ABS_SCORE_SMALL_POOL: 0.75,
  RETRIEVAL_ABS_SCORE_SMALL_POOL_HIGH_RISK: 0.85,
};

/**
 * @param {object} clause - row from clause_registry, joined with rule_atoms
 *   if it has one. Expected fields: clause_uri, clause_type, confidence
 *   ('high'|'low' from classifier.py), needs_llm_refinement.
 * @param {object|null} ruleAtom - matching row from rule_atoms, or null.
 * @param {object} context
 *   - evidenceAvailable: bool - was a value/evidence actually submitted?
 *   - graphDataAvailable: bool - is there ownership/exposure data for this bank?
 *   - retrievalTopScore, retrievalSecondScore: numbers from vector search
 *   - priorAgreement: 'AGREE' | 'DISAGREE' | 'NO_HISTORY'
 *   - riskTier: 'high' | 'standard'
 * @returns {{route: string, reasons: string[], decision: string|null}}
 *   decision is set only when the router itself can short-circuit
 *   (INSUFFICIENT_DATA); otherwise the caller executes the chosen route
 *   and the route's own result carries the decision.
 */
function route(clause, ruleAtom, context) {
  const reasons = [];

  // Step 0 — hard short-circuit: nothing to evaluate against
  if (!context.evidenceAvailable) {
    reasons.push("no bank-submitted value/evidence available for this clause");
    return { route: null, decision: "INSUFFICIENT_DATA", reasons };
  }

  // Step 1 — deterministic gate. Only clean, high-confidence quantitative
  // extractions go straight to the rule engine. A clause the classifier
  // itself marked needs_llm_refinement=1 (the ~90% of quant-signal clauses
  // your regex templates couldn't cleanly parse) is NOT trusted here even
  // if a rule_atom happens to exist, because the extraction confidence is
  // the signal, not just the presence of a rule_atom row.
  if (
    ruleAtom &&
    clause.clause_type === "quantitative" &&
    clause.confidence === "high" &&
    !clause.needs_llm_refinement
  ) {
    reasons.push(
      `quantitative clause, high extraction confidence, clean rule_atom (${ruleAtom.operator} ${ruleAtom.threshold_value}${ruleAtom.threshold_unit})`
    );
    return { route: ROUTES.RULE_ENGINE, decision: null, reasons };
  }
  if (ruleAtom) {
    reasons.push(
      `rule_atom exists but extraction confidence is '${clause.confidence}' or refinement was flagged - not trusting Route 1 alone`
    );
  }

  // Step 2 — relational/graph-eligible clauses, only if graph data exists
  // for this bank. This never fires in the current system (no real
  // ownership-graph data source - see blueprint §7) but the gate is real:
  // if graphDataAvailable is ever true, this branch is live, not aspirational.
  if (clause.clause_type === "relational" && context.graphDataAvailable) {
    reasons.push("relational clause with available ownership/exposure graph data");
    return { route: ROUTES.GRAPH, decision: null, reasons };
  }
  if (clause.clause_type === "relational") {
    reasons.push("relational clause but no graph data source available - falling through");
  }

  // Step 3 — retrieval + LLM, gated on retrieval confidence. Two distinct
  // confidence signals, not one - see THRESHOLDS.SMALL_POOL_SIZE comment
  // for why: relative spread (top-1 vs top-2) when the evidence pool is
  // large enough for "spread" to mean anything, OR an absolute-score
  // floor when the pool is too small for relative comparison to be
  // meaningful (this branch was added after observing spread=0.000 on a
  // genuinely strong top-1=0.89 match against a 2-document evidence pool
  // during testing - see git history / CHANGELOG for that finding).
  if (context.retrievalTopScore != null) {
    const spread = context.retrievalTopScore - (context.retrievalSecondScore ?? 0);
    const requiredSpread =
      context.riskTier === "high"
        ? THRESHOLDS.RETRIEVAL_SCORE_SPREAD_HIGH_RISK
        : THRESHOLDS.RETRIEVAL_SCORE_SPREAD_CONFIDENT;

    const poolSize = context.evidencePoolSize ?? 0;
    const smallPool = poolSize > 0 && poolSize < THRESHOLDS.SMALL_POOL_SIZE;
    const requiredAbsForSmallPool =
      context.riskTier === "high"
        ? THRESHOLDS.RETRIEVAL_ABS_SCORE_SMALL_POOL_HIGH_RISK
        : THRESHOLDS.RETRIEVAL_ABS_SCORE_SMALL_POOL;

    let confident = false;
    if (smallPool) {
      confident = context.retrievalTopScore >= requiredAbsForSmallPool;
      reasons.push(
        confident
          ? `small evidence pool (${poolSize} candidates) but absolute top score ${context.retrievalTopScore.toFixed(3)} >= ${requiredAbsForSmallPool} - using absolute-score confidence, not spread`
          : `small evidence pool (${poolSize} candidates): absolute top score ${context.retrievalTopScore.toFixed(3)} < required ${requiredAbsForSmallPool}`
      );
    } else {
      confident = spread >= requiredSpread;
      reasons.push(
        confident
          ? `retrieval confident: score spread ${spread.toFixed(3)} >= required ${requiredSpread} (risk_tier=${context.riskTier})`
          : `retrieval not confident enough: score spread ${spread.toFixed(3)} < required ${requiredSpread}`
      );
    }

    if (confident) {
      if (context.priorAgreement === "DISAGREE") {
        reasons.push("but this rule has a history of route disagreement - escalating instead");
      } else {
        return { route: ROUTES.RAG_LLM, decision: null, reasons };
      }
    }
  } else {
    reasons.push("no retrieval score available");
  }

  // Step 4 — fall through to human review
  reasons.push("no route met its confidence bar - escalating to human review");
  return { route: ROUTES.HUMAN, decision: "REQUIRES_HUMAN_REVIEW", reasons };
}

module.exports = { route, ROUTES, THRESHOLDS };
