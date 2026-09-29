/**
 * Requirement-category taxonomy of the journal (Sec. VI.A, Table IV), derived
 * from what the extraction pipeline already stores: the clause text, its
 * clause_type / role, and its extracted rule atoms.
 *
 *   A  quantitative         thresholds, ratios, numeric limits
 *   B  Boolean / procedural existence checks (a Board-approved policy, a committee, a register)
 *   C  conditional          if / unless / provided that ... then a requirement
 *   D  temporal             deadlines, periodic reporting, "within N days"
 *   E  qualitative          "adequate", "reasonable", "appropriate", due diligence
 *   F  relational           parent / subsidiary, related-party requirements
 *   G  multi-entity         aggregation across connected counterparties (graph)
 *
 * Also derived (router features, Table V):
 *   requires_semantic_interpretation  true when no closed-form test exists
 *   risk_level                        high | medium | low (capital, liquidity,
 *                                     exposure, KYC/AML are high; reporting and
 *                                     timelines medium; formats / documentation low)
 *
 * Deterministic keyword and structure rules; no LLM.
 */

const TEMPORAL_UNITS = new Set(["days", "working_days", "months", "years", "hours", "weeks"]);
const QUANT_UNITS = /^(%|₹|₹ crore|₹ lakh|crore|lakh|times|bps|x)$/i;

const RE = {
  multiEntity: /group of connected (?:counterparties|nbfcs|borrowers|entities)|connected counterpart|connected nbfcs|borrower group|group (?:borrower|obligor|nbfc)|group exposure|aggregate (?:group )?exposure to (?:a|the) group|aggregate group exposure|economic(?:ally)? dependen/i,
  relational: /\b(?:subsidiar(?:y|ies)|holding company|parent (?:bank|company|entity)|related part(?:y|ies)|relatives? of|director(?:s)? (?:of|or)|promoter(?:s)?|associate(?:s)? of|joint venture|group entit(?:y|ies)|intra-group)\b/i,
  conditional: /\b(?:if|unless|provided that|in case|where (?:a|the) (?:bank|entity)|subject to (?:the )?condition|only when|in the event)\b/i,
  temporal: /\bwithin (?:a period of )?(?:\d+|one|two|three|four|five|six|seven|ten|fifteen|thirty|sixty|ninety)\s+(?:working\s+)?(?:days?|months?|weeks?|years?)|\bnot later than\b|\bon or before\b|\b(?:monthly|quarterly|half[- ]yearly|annually|every (?:month|quarter|year))\b|\bfortnight/i,
  booleanExistence: /\bshall (?:have|put in place|frame|formulate|adopt|constitute|set up|establish|maintain) (?:a|an|its own)?\s*(?:comprehensive\s+|well[- ]documented\s+|board[- ]approved\s+|written\s+)*(?:policy|committee|framework|system|mechanism|procedure|register|process|plan|charter|code)\b|\bboard[- ]approved (?:policy|framework)\b|\bshall be approved by (?:its|the) board\b/i,
  qualitative: /\b(?:adequate|appropriate|reasonable|sufficient|effective|robust|proper|satisfactory|prudent|due diligence|fit and proper|to the satisfaction|as far as possible|best efforts?|commensurate)\b/i,
  highRisk: /capital|crar|cet\s*1|tier\s*[12]|leverage|liquidity|lcr|nsfr|exposure|concentration|large exposure|related part|kyc|know your customer|money laundering|\baml\b|\bnpa\b|provision|fraud|cash reserve|statutory liquidity|\bcrr\b|\bslr\b/i,
  mediumRisk: /report|return|submit|disclos|within \d+ days|timeline|interest rate|priority sector|grievance|complaint|outsourc|cyber|audit/i,
};

const CATEGORY_LABELS = {
  A: "Quantitative",
  B: "Boolean / procedural",
  C: "Conditional",
  D: "Temporal",
  E: "Qualitative / semantic",
  F: "Relational",
  G: "Multi-entity / connected-counterparty",
};

/**
 * @param {{clause_text?:string, clause_type?:string, doc_title?:string,
 *          atom?:{operator?:string, threshold_unit?:string, atom_kind?:string}|null,
 *          graphCovered?:boolean}} x
 * @returns {{rule_type:string, rule_type_label:string, requires_semantic_interpretation:boolean,
 *            risk_level:'high'|'medium'|'low', deterministic:boolean}}
 */
function classifyRule(x) {
  const text = String(x.clause_text || "");
  const atom = x.atom || null;
  const unit = atom?.threshold_unit || "";
  let type;
  if (x.graphCovered || RE.multiEntity.test(text)) type = "G";
  else if (atom && (atom.operator === "within_days" || TEMPORAL_UNITS.has(unit))) type = "D";
  // conditional only when the condition governs the sentence that states the limit
  else if (atom && QUANT_UNITS.test(unit) && RE.conditional.test(atom.sentence || text) && atom.atom_kind !== "condition") type = "C";
  else if (atom && QUANT_UNITS.test(unit)) type = "A";
  else if (x.clause_type === "relational" || RE.relational.test(text)) type = "F";
  else if (RE.temporal.test(text)) type = "D";
  else if (RE.booleanExistence.test(text) && !RE.qualitative.test(text.replace(RE.booleanExistence, ""))) type = "B";
  else if (RE.booleanExistence.test(text)) type = "B";
  else type = "E";

  const riskText = `${x.doc_title || ""} ${text}`;
  const risk_level = RE.highRisk.test(riskText) ? "high" : RE.mediumRisk.test(riskText) ? "medium" : "low";
  // no closed-form test: qualitative standards, and relational requirements the
  // network check does not encode
  const requires_semantic_interpretation = type === "E" || type === "F" || (type === "B" && RE.qualitative.test(text));
  return {
    rule_type: type,
    rule_type_label: CATEGORY_LABELS[type],
    requires_semantic_interpretation,
    risk_level,
    deterministic: ["A", "C", "D", "G"].includes(type) || (type === "B" && !requires_semantic_interpretation),
  };
}

const RISK_WEIGHT = { high: 3, medium: 2, low: 1 };

module.exports = { classifyRule, CATEGORY_LABELS, RISK_WEIGHT, RE };
