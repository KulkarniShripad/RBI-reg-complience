# Journal updates: what the system now implements and measures

Branch `journal-updates`. This document does three things:

1. It lists which claims of the journal draft are now implemented, and where, with the measured result for each.
2. It gives revised text for every section that changed, with measured tables in place of the draft's placeholder numbers.
3. It states what is still simulated or modelled, so the paper can say so explicitly.

Every number below comes from a script in the repository and can be regenerated (see §11). The raw outputs are in `urcc-ef-backend/eval/results/`.

---

## 1. Summary: journal claim → implementation → evidence

| Journal element | Before this branch | Now | Evidence |
|---|---|---|---|
| Five decision labels (COMPLIANT, NON_COMPLIANT, INSUFFICIENT_DATA, AMBIGUOUS, REQUIRES_HUMAN_REVIEW) | Engine-specific statuses (PASS, BREACH, NEEDS_REVIEW …) | Every result carries a `decision` next to its original `status` (non-breaking); the reports show the decision and a recommended action for breaches | `src/services/decisions.js`; Auto Check report, Bank Explorer |
| Requirement taxonomy A–G (Table IV) + risk level | Not present | Deterministic classifier over clause text and rule atoms; agrees with the gold categories on 85.5% of rules | `src/services/router/ruleTaxonomy.js`; `eval/results/extraction_gold.md` |
| Synthetic compliance benchmark | Not present | 1,393 labelled cases over 215 real RBI rules, 9 case types, split into train / validation / test by rule | `scripts/benchmark/build_benchmark.js` → `eval/compliance_benchmark.json` |
| Adaptive, cost-aware router (Algorithm 1) | Hand-written heuristic router | Learned P(error \| modality, features), cost-aware argmin, gates and hard override. It is **adopted in the running system** because it beats the heuristic router on validation and test | `src/services/router/adaptiveRouter.js`; `eval/router_model.json`; `eval/results/router_eval.md` |
| Baselines B1–B4 and routers R1–R3 | Only the fixed hybrid pipeline | All implemented and evaluated through the same code path, plus an Oracle | `scripts/eval_router.js` |
| Versioned rules (temporal validity) | Latest value only | CRR phase-down (4 dates, 7 categories) and the UCB net-worth glide path parsed from the corpus; the rule engine applies the version in force on the as-of date | `src/services/router/versionedRules.js` |
| Rule-extraction quality (RQ3) | Not measured | Gold set of 62 hand-verified rules. Exact recall 85.5%, up from 45.2% after the extraction fixes in this branch; operator accuracy 100% | `scripts/eval_extraction_gold.js` |
| Structure-aware vs generic chunking (RQ2, baseline C3) | Not measured | Clause-aligned hybrid retrieval: MRR@10 0.635 vs 0.309 for fixed 800-character windows (Top-5 recall 81% vs 48%) on 79 gold-rule questions; also 36 hand-written questions | `scripts/eval_chunking.js` |
| Plain-language simplification (RQ4) | Not present | Guarded rule-based simplifier (Gemini optional), API endpoint and source-viewer toggle; meaning preservation measured | `src/services/simplifyService.js`; `scripts/eval_simplification.js` |
| Significance testing | – | Paired cluster bootstrap (by rule) and exact McNemar for every headline comparison | `eval/results/router_eval.md` |
| Architecture diagram | v2 (partly aspirational) | v3, drawn from the code as it is | `urcc-ef-backend/urcc-architecture-v3.svg` |

---

## 2. Revised abstract (suggested)

> Regulatory compliance checking in Indian banking combines numeric limits, procedural obligations, conditional and time-bound requirements, qualitative standards and multi-entity exposure rules. No single reasoning method handles all of them reliably or cheaply. We present URCC-EF, a unified framework that extracts clause-aligned rules from 264 Reserve Bank of India directions (21,632 clauses, 4,544 rule atoms). It classifies every obligation into a seven-way requirement taxonomy and routes each (rule, evidence) pair to a deterministic rule engine, a graph evaluator for connected counterparties, a retrieval-grounded LLM, or human review. The router learns the error probability of each modality from features of the rule and the evidence, then minimises a risk-weighted error cost plus monetary and latency cost, with hard safety gates. On a benchmark of 1,393 cases over 215 real rules, evaluated on held-out rules, the router reaches 92.2% automated accuracy and 96.9% end-to-end accuracy at US$0.19 per case. That is +8.8 pp (95% CI +5.3 to +12.7) and +4.1 pp over a hand-designed router, at 32% lower cost, and +19.7 pp over RAG+LLM alone. It avoids 80% of LLM calls relative to RAG+LLM and produces no uncited decisions, while an LLM without retrieval mis-cites 62.6% of its decisions. Rule extraction recovers 85.5% of hand-verified thresholds with 100% operator accuracy. Clause-aligned retrieval doubles MRR@10 over generic fixed-length chunks (0.635 vs 0.309). A guarded plain-language layer preserves every extracted rule on re-extraction.

(The LLM paths in these numbers use an offline surrogate judge; see §9. Replace the numbers after `npm run eval:router:gemini`.)

---

## 3. System architecture (Sec. V): corrections to the draft

Use `urcc-architecture-v3.svg`. Changes relative to the v2 diagram and text:

- **Storage.** The system uses SQLite for everything: documents, clause registry, rule atoms, definitions, cross-references, FTS5 keyword index, routing log, bank data, and the graph store as relational tables. A SQLite vector table holds the BGE-small (384-d) embeddings. There is no separate graph database or vector server.
- **Four modalities, not three.** DETERMINISTIC is two engines. The *rule engine* handles categories A, C and D, and B when a structured flag exists. The *graph evaluator* handles category G: connected-counterparty grouping following RBI's own illustrations (Concentration Risk Management Directions, paras 20–30), aggregate exposure limits, and Section 20 related-party prohibitions. The other two modalities are RAG+LLM and HUMAN.
- **Decisions.** The paper's five labels are the output vocabulary. The original engine statuses are kept for traceability, and each decision cites the governing paragraph.
- **Recommended action (Sec. V, outputs).** For a numeric breach the report states the gap and the target, for example: "Raise CRAR from 8.2% to at least 9% (a gap of 0.8 percentage points)". For network breaches it names the counterparty or group and the excess.
- **Two routes into compliance checking.**
  - *Auto Check:* upload a bank's annual report or Pillar 3 disclosure; figures are extracted, anchored rules evaluated and a report generated.
  - *Bank Explorer:* stored bank data (quantitative submissions, qualitative evidence, counterparty network) with a manual check and history.
- **Comprehension.** Hybrid retrieval: FTS5 keyword search plus semantic search over clause-aligned chunks, fused. It is used by a chat with clickable citations and by a source viewer showing the paragraph, PDF page, extracted rule atoms and an optional plain-language restatement.

---

## 4. Requirement taxonomy (Sec. VI.A, Table IV): measured distribution

The classifier is deterministic: keyword and structure rules over the clause text, its clause type, and the first requirement atom and the sentence that states it. It adds `requires_semantic_interpretation` and a risk level (high: capital, liquidity, exposure, KYC/AML, NPA, CRR/SLR; medium: reporting, timelines, grievance, outsourcing, cyber, audit; low: the rest).

**Table IV (measured).** 14,838 obligation clauses in the corpus:

| Category | Meaning | Obligations | Share | Modality in the fixed table (R3) |
|---|---|---|---|---|
| A | Quantitative threshold | 438 | 3.0% | Rule engine |
| B | Boolean / procedural existence | 399 | 2.7% | Rule engine if a structured flag exists, else RAG+LLM |
| C | Conditional | 39 | 0.3% | Rule engine (condition + threshold) |
| D | Temporal / deadline | 1,341 | 9.0% | Rule engine |
| E | Qualitative / semantic | 11,741 | 79.1% | RAG+LLM |
| F | Relational (related party, subsidiaries) | 815 | 5.5% | RAG+LLM |
| G | Multi-entity / connected counterparties | 65 | 0.4% | Graph evaluator |

Risk levels: high 6,110, medium 3,177, low 5,551. 12,692 obligations (85.5%) require semantic interpretation.

Agreement with the gold categories of 62 hand-verified rules is 85.5%. All disagreements are rules whose threshold the extractor did not recover, so the classifier fell back to E.

**Suggested text:** "Most RBI obligations (79%) are qualitative, but the quantitative, temporal and multi-entity minority (13%) carries most of the supervisory risk and is exactly where deterministic evaluation is both possible and necessary. This asymmetry motivates routing rather than a single reasoning method."

---

## 5. Benchmark (Sec. VII): construction

`scripts/benchmark/build_benchmark.js` (seed 7; deterministic).

- **Rules** (215 distinct):
  - the 26 anchored figure rules (verified paragraphs);
  - quantitative, temporal and conditional atoms sampled from high-confidence extractions;
  - existence (B), qualitative (E) and relational (F) obligations;
  - two versioned rules (CRR, UCB net worth);
  - graph scenarios (G).
- **Case types** (Table VI):

  | Case type | Cases |
  |---|---|
  | compliant | 203 |
  | non-compliant | 207 |
  | boundary (exactly at threshold) | 89 |
  | near-boundary | 146 |
  | missing data | 190 |
  | adversarial | 189 |
  | contradictory | 173 |
  | ambiguous | 150 |
  | cross-version | 46 |

  - *Adversarial* cases have narrative text that contradicts the figures, or state an intention rather than an implementation.
  - *Contradictory* cases have a bank statement and an inspection finding that disagree.
  - *Cross-version* cases have the same value on dates on either side of a threshold change.
- **By category:**

  | Category | Cases |
  |---|---|
  | A | 487 |
  | B | 216 |
  | C | 80 |
  | D | 192 |
  | E | 288 |
  | F | 96 |
  | G | 34 |

  1,359 cases are template-generated and 34 are hand-authored (the graph scenarios).
- **Each case** has the entity, the rule (with its real clause URI and text), structured fields, source documents, narrative, the expected decision, the *acceptable* decisions (e.g. AMBIGUOUS or REQUIRES_HUMAN_REVIEW for partial implementation), a reason, a difficulty level and a split.
- **Splits are by rule** (hash of the rule key): train 840, validation 259, test 294. No rule in the test split was seen during training or tuning.

---

## 6. Adaptive router (Sec. VIII): final algorithm

```
Algorithm 1  ρ(rule r, evidence E) → (modality, decision)
 1  f ← features(r, E)                               ▷ Table V
 2  if f.evidence_completeness = 0      return (—, INSUFFICIENT_DATA)
 3  if f.evidence_completeness < MIN    return (HUMAN, REQUIRES_HUMAN_REVIEW)
 4  if f.rule_engine_applicability = 1 ∧ f.evidence_completeness = 1
        ∧ f.text_structured_conflict = 0               ▷ hard override
                                        return (DETERMINISTIC, engine(r, E))
 5  for m ∈ {DETERMINISTIC, RAG_LLM, HUMAN}:
        C(m) ← α · P̂(error | m, f) · risk(r) + β · USD(m) + γ · latency(m)
 6  m* ← argmin_m C(m)
 7  return (m*, run m* on (r, E))
```

The change from the draft is the third condition of the hard override. The override is "correct by construction" only if no evidence contradicts the structured data. Without this condition, 8 of the 31 validation errors were cases where the structured flag said "met" and the narrative recorded an inspection finding to the contrary.

**Table V (implemented features):**
- one-hot rule type A–G;
- requires_semantic_interpretation;
- structured_field_availability;
- retrieval_confidence (max BGE similarity between evidence and clause sentences);
- rule_engine_applicability;
- evidence_completeness (text-only evidence for a numeric field counts 0.5);
- historical_accuracy_deterministic and historical_accuracy_rag_llm (per category, leave-one-out on train);
- risk_level;
- source_conflict;
- narrative_present;
- **text_structured_conflict** (new; a contrast followed by a negation in the narrative while structured evidence exists);
- **text_uncertainty_cue** (new; in-progress / intention wording).

The two new features were added after error analysis on the **validation split only**.

**Error model.** For each automated modality, an L2 logistic regression and a depth-5 decision tree (entropy splits, Laplace leaves) are trained on the train split. The one with the lower validation log-loss is kept:
- DETERMINISTIC → tree (0.043 vs 0.063)
- RAG_LLM → logistic (0.467 vs 0.814)

The tree is exported as readable rules for audit.

**Tuning.** Grid over β ∈ {0.1, 0.3, 1, 3, 10, 30}, γ ∈ {0, 10⁻⁴, 10⁻³, 10⁻²} and MIN ∈ {0.5, 0.75, 1}, with α = 1. The cheapest configuration on validation with end-to-end accuracy ≥ τ = 0.95 is chosen: β = 0.1, γ = 10⁻³, MIN = 0.75. Two further operating points are also chosen on validation:
- *cost-matched*: best accuracy at no more than R0's validation cost;
- *fully automated*: no human route.

**Adoption.** The running system (`/api/compliance/routed`) uses Algorithm 1 only if a validation-chosen operating point is at least as accurate as the previous heuristic router R0 on both accuracies, at no more than 5% extra cost, on both the validation and the test split. It passed; `ROUTER_POLICY=heuristic` restores the old router.

---

## 7. Experimental setup (Sec. IX)

- **Baselines.**
  - B1 rule-only
  - B2 LLM-only without retrieval (the model must locate the governing clause itself)
  - B3 RAG+LLM for every rule
  - B4 = R3 fixed hybrid table by category
- **Routers.**
  - R0 the earlier hand-written router (`routingService.js`)
  - R1 static rule-first
  - R2 single retrieval-confidence threshold (θ tuned on validation)
  - R4 the proposed router at three operating points
  - Oracle: the cheapest correct modality per case
- **Metrics.**
  - *Automated accuracy* counts a decision correct if it is in the acceptable set; escalations count as not decided.
  - *End-to-end accuracy* counts an escalation as resolved by the reviewer, whose cost and latency are charged.
  - Also: macro-F1 over the five decisions, NON_COMPLIANT F1, false-positive and false-negative rates, escalation rate, LLM-call rate, citation accuracy (the decision cites the governing paragraph), hallucination rate (decisions citing a wrong paragraph), USD and latency per case.
- **Cost model** (`eval/cost_model.json`):
  - Gemini 2.5 Flash list prices: US$0.30 / 1M input tokens and US$2.50 / 1M output tokens, with a 350-token prompt overhead and 120 output tokens.
  - LLM latency 1.8 s; retrieval 60 ms.
  - Human review US$1.50 and 10 minutes per case, with a 2% error rate.
  - Rule-engine and graph latency are measured.

---

## 8. Results (Sec. X)

### 8.1 Compliance accuracy and cost (Tables VII / XI), test split, n = 294

| System | Accuracy | End-to-end | Macro-F1 | NC F1 | FNR | Escalated | LLM calls | Halluc. | USD / case |
|---|---|---|---|---|---|---|---|---|---|
| B1 Rule-only | 66.0% | 66.0% | 0.554 | 0.787 | 35.0% | 0% | 0% | 0% | 0.0000 |
| B2 LLM-only (no retrieval) | 56.8% | 56.8% | 0.522 | 0.575 | 46.4% | 0% | 100% | **62.6%** | 0.0013 |
| B3 RAG+LLM | 72.5% | 72.5% | 0.711 | 0.623 | 41.2% | 0% | 100% | 0% | 0.0005 |
| B4 / R3 Fixed hybrid | 85.4% | 85.4% | 0.779 | 0.851 | 17.5% | 0% | 34.7% | 0% | 0.0002 |
| R0 Earlier heuristic router | 83.3% | 92.9% | 0.811 | 0.791 | 11.3% | 19.1% | 17.0% | 0% | 0.2858 |
| R1 Static rule-first | 86.4% | 86.4% | 0.823 | 0.829 | 17.5% | 0% | 46.6% | 0% | 0.0002 |
| R2 Confidence threshold (θ = 0.85) | 71.8% | 95.6% | 0.613 | 0.793 | 9.3% | 34.7% | 11.9% | 0% | 0.5205 |
| **R4 Proposed adaptive (τ)** | **92.2%** | **96.9%** | **0.907** | **0.889** | **3.1%** | 12.9% | 20.1% | 0% | 0.1940 |
| R4 at R0's cost budget | 86.4% | 99.0% | 0.871 | 0.838 | 0% | 25.2% | 7.8% | 0% | 0.3776 |
| R4 fully automated | 87.8% | 87.8% | 0.834 | 0.842 | 17.5% | 0% | 33.0% | 0% | 0.0002 |
| Oracle | 94.2% | 100% | 0.943 | 0.904 | 0% | 11.9% | 22.1% | 0% | 0.1787 |

False-positive rate is 0% for every system except B2 (16.5%) and B3 (11.0%). R4 avoids 79.9% of the LLM calls of B3. Routing accuracy against the cheapest-correct reference route is 93.2% for R4, against 77.5% for R0 and 79.6% for B4.

**Suggested text:** "The adaptive router closes 77% of the gap between the best fixed hybrid (85.4%) and the oracle (94.2%) in automated accuracy. It escalates a third less than the heuristic router while being more accurate, because the learned error model escalates only where no automated modality is reliable. Removing retrieval grounding (B2) collapses citation accuracy to 37.4%: an LLM that must find the governing clause itself cites the wrong paragraph in most decisions."

### 8.2 Significance

Paired cluster bootstrap over rules (2,000 resamples), because cases of one rule are not independent; exact McNemar on discordant cases.

| Comparison | Δ automated accuracy [95% CI] | p | Δ end-to-end [95% CI] | p |
|---|---|---|---|---|
| R4 vs R0 | +8.8 pp [+5.3, +12.7] | 3.0e-8 | +4.1 pp [+1.7, +6.8] | 4.9e-4 |
| R4 vs B4 | +6.8 pp [+4.3, +9.4] | 1.9e-6 | +11.6 pp [+8.0, +15.4] | 1.2e-10 |
| R4 vs R1 | +5.8 pp [+3.2, +8.4] | 7.6e-5 | +10.5 pp [+6.9, +14.4] | 7.9e-9 |
| R4 vs B3 | +19.7 pp [+13.5, +26.2] | 1.1e-16 | +24.5 pp [+18.3, +30.7] | 7.9e-21 |
| R4 automated vs R1 | +1.4 pp [0.0, +3.0] | 0.22 | – | – |
| R4 automated vs B4 | +2.4 pp [+0.7, +4.3] | 0.016 | – | – |

Report the fully automated operating point honestly. Without human review, the learned router is only marginally better than a static rule-first policy; its advantage comes from knowing *when to escalate*.

### 8.3 By case type (Table X), automated accuracy

| Case type | B3 RAG+LLM | B4 Fixed | R0 | R4 |
|---|---|---|---|---|
| compliant | 95.0% | 100% | 82.5% | 100% |
| non-compliant | 71.7% | 100% | 73.9% | 100% |
| boundary | 90.0% | 100% | 100% | 100% |
| near-boundary | 76.5% | 100% | 100% | 100% |
| missing data | 92.3% | 100% | 92.3% | 100% |
| contradictory | 75.0% | 94.4% | 100% | 100% |
| cross-version | 50.0% | 100% | 100% | 100% |
| ambiguous | 40.0% | 20.0% | 66.7% | 80.0% |
| adversarial | 46.2% | 56.4% | 56.4% | 56.4% |

Adversarial cases remain the open problem for every system. These are mainly qualitative obligations where the bank states an intention ("intends to … in due course") and the expected decision is NON_COMPLIANT. That is a reading problem for the judge, not a routing problem, and should be stated as a limitation.

### 8.4 By requirement category, automated accuracy

| Category | B3 | B4 | R0 | R4 |
|---|---|---|---|---|
| A | 66.1% | 89.9% | 97.3% | 97.3% |
| B | 91.7% | 66.7% | 75.0% | 100% |
| C | 73.3% | 100% | 80.0% | 100% |
| D | 91.7% | 100% | 100% | 100% |
| E | 71.4% | 71.4% | 61.9% | 79.8% |
| F | 77.8% | 77.8% | 55.6% | 83.3% |
| G | 12.5% | 100% | 100% | 100% |

### 8.5 Ablations (Table XV)

| Configuration | Accuracy | End-to-end | USD / case |
|---|---|---|---|
| Full system (R4) | 92.2% | 96.9% | 0.194 |
| − adaptive routing (→ B4) | 85.4% | 85.4% | 0.0002 |
| − rule engine (→ B3) | 72.5% | 72.5% | 0.0005 |
| − evidence grounding (→ B2) | 56.8% | 56.8% | 0.0013 |
| − learned error model (historical accuracy only) | 84.4% | 94.6% | 0.306 |
| − evidence-completeness gate | 91.8% | 96.6% | 0.184 |
| − hard override | 92.2% | 96.9% | 0.194 |

The learned error model is the largest single contribution among the router components (−7.8 pp without it). Removing the hard override does not change accuracy on this benchmark, because the learned model already sends those cases to the rule engine. The override is kept as a guarantee: correct by construction, independent of training data.

**Frontier figure.** `eval/results/frontier.svg` / `frontier.csv` plot all 72 tuned configurations plus the baselines in accuracy vs USD per case, with the Pareto frontier marked.

### 8.6 Rule extraction (RQ3, Table IX)

Gold set: 26 figure requirements and 36 network limits, each verified by hand against its paragraph (62 rules in 39 paragraphs).

| Subset | n | Exact recall (operator + value) | Operator accuracy | Taxonomy agreement |
|---|---|---|---|---|
| All | 62 | 85.5% | 100% | 85.5% |
| Figure requirements | 26 | 88.5% | 100% | 88.5% |
| Network limits | 36 | 83.3% | 100% | 83.3% |

Atom precision in the gold paragraphs is at least 79.3% of 87 percentage atoms. This is a lower bound, because a paragraph can state other legitimate numbers.

Extraction changes in this branch, all in `classifier.py` and covered by `test_pipeline.py`:
- "not be higher than" as an upper bound;
- number words before "per cent";
- list-item limits under a "shall adhere to the following limits" lead-in;
- a coordinated second value ("4 per cent and 3.5 per cent for other banks").

These raised exact recall from 45.2% to 85.5% (network limits from 16.7% to 83.3%). Corpus after re-extraction: 264 documents, 21,632 clauses, 4,544 rule atoms (1,222 requirements), 2,433 definitions, 7,516 cross-references.

### 8.7 Structure-aware vs generic chunking (RQ2)

`scripts/eval_chunking.js`. The system's clause-aligned chunks are compared with the generic baseline C3: each document cut into fixed 800-character windows with 200-character overlap (33,907 windows), searched with BM25, with the same BGE-small embeddings, and with both fused by reciprocal-rank fusion.

Questions:
- 36 hand-written questions (`eval/retrieval_eval.json`);
- 79 questions generated from the verified gold rules, with the numbers removed from the question.

A passage is relevant if it contains the whole provision (the rule's verified source text) in a document that applies to the right institution category.

| Retrieval | Hand-written: Hit@1 | Top-5 recall | MRR@10 | Gold-rule questions: Hit@1 | Top-5 recall | MRR@10 |
|---|---|---|---|---|---|---|
| Structure-aware keyword (C1) | 61.1% | 83.3% | 0.721 | 46.8% | 75.9% | 0.593 |
| Structure-aware semantic | 61.1% | 80.6% | 0.675 | 40.5% | 73.4% | 0.539 |
| **Structure-aware hybrid (proposed)** | **72.2%** | **83.3%** | **0.768** | **53.2%** | **81.0%** | **0.635** |
| Fixed windows BM25 (C3) | 36.1% | 61.1% | 0.465 | 20.3% | 48.1% | 0.316 |
| Fixed windows semantic (C3) | 55.6% | 72.2% | 0.635 | 16.5% | 35.4% | 0.246 |
| Fixed windows hybrid (C3) | 50.0% | 75.0% | 0.607 | 19.0% | 44.3% | 0.309 |

**Suggested text:** "Clause-aligned chunking roughly doubles MRR@10 on rule-seeking questions (0.635 vs 0.309 for the best fixed-window configuration) and raises Top-5 recall from 48% to 81%. Fixed windows often cut a provision from the proviso or threshold that completes it, so the retrieved passage is not by itself a sufficient basis for a compliance decision."

Caveat for the paper: the whole-provision relevance criterion is intentionally strict, because a decision must cite a complete provision; it partly penalises windows by construction. Report the definition with the table.

### 8.8 Plain-language simplification (RQ4)

`scripts/eval_simplification.js`: 272 obligation clauses stratified by category (up to 40 each). Rule-based simplifier with the meaning guard.

| Category | n | FKGL | Words / sentence | Guard pass | Rule re-extraction agreement | Semantic similarity |
|---|---|---|---|---|---|---|
| All | 272 | 15.74 → 15.64 | 31.1 → 30.4 | 99.6% | 100% (107 clauses with atoms) | 0.992 |
| A | 40 | 14.29 → 14.23 | 29.9 → 29.0 | 100% | 100% | 0.990 |
| C | 32 | 15.22 → 14.86 | 33.7 → 31.9 | 100% | 100% | 0.992 |
| G | 40 | 15.52 → 15.41 | 29.5 → 29.1 | 100% | 100% | 0.992 |

*Rule re-extraction agreement* means the extraction pipeline, run on the simplified text, returns exactly the same (operator, value, unit) atoms as on the original. It is a machine check that the requirement a reader would act on is unchanged.

**Suggested text:** "A deterministic rewriter preserves meaning perfectly (100% re-extraction agreement) but improves readability only marginally (FKGL −0.1). Meaningful readability gains need a generative rewriter. We therefore accept an LLM rewrite only when it passes the same guard, and otherwise fall back to the rule-based text."

Run `npm run eval:simplification -- --llm` with a Gemini key to report the LLM variant.

### 8.8.1 Other regression evaluations (unchanged behaviour)

- Network (graph) evaluator: 40/40 expectations on 6 synthetic ownership scenarios (`npm run eval:graph`).
- Auto Check on 11 real public disclosures: 142/142 expectations (`npm run eval:disclosures`).
- Test suites: backend 45/45 (plus Python pipeline tests); frontend 35/35.

---

## 9. Threats to validity (add to the paper)

1. **Surrogate judge.** The RAG+LLM and LLM-only outcomes above come from an offline surrogate judge, because no API key was available in the evaluation environment. It uses deterministic reading heuristics over the same retrieved evidence and embedding relevance, not an LLM. The Gemini judge is implemented (`--judge gemini`) with the same prompt contract (a JSON decision among the five labels, with a cited clause). Rerun before submission; the router retrains on whatever judge produced the outcomes.
2. **Modelled cost and latency.** LLM and human costs are modelled from list prices and assumptions (§7); deterministic latencies are measured.
3. **Synthetic benchmark.** Cases are template-generated over real rules by the authors, so wording diversity is limited. Mitigations:
   - splits by rule;
   - hyperparameters chosen on validation only;
   - the two added features came from validation error analysis;
   - the real-document evaluation (142/142 on 11 real disclosures) is reported separately.
4. **Adoption check uses the test split as a gate.** No parameter is fitted on test, but the adoption decision looks at test results. Report the validation numbers alongside: R4 94.6% / 95.8% vs R0 85.3% / 95.0% on validation.
5. **Graph data** is synthetic; real deployment needs the bank's counterparty data and company-registry (MCA) data.

---

## 10. Claims to soften or remove from the draft

- Anything describing a separate graph database, a vector server or a knowledge-graph store beyond SQLite tables.
- Any measured LLM accuracy, cost or latency, until the Gemini rerun is done. Until then, say "surrogate judge" and "modelled cost".
- Readability improvement from simplification: report the measured FKGL change (small for the rule-based method) rather than an assumed gain.
- "The router always escalates uncertain cases": at the τ operating point it escalates 12.9% of test cases, and FNR is 3.1%, not 0.

---

## 11. Reproducing every number

From `urcc-ef-backend/`. The numbers were produced on a corpus re-extracted with this branch's `classifier.py`, so rebuild the corpus first; the committed `data/urcc_ef.db` predates the extraction fixes:

```bash
npm run setup                  # build:corpus (re-extraction) + build:vectors
npm run build:benchmark        # eval/compliance_benchmark.json
npm run eval:extraction        # eval/results/extraction_gold.{json,md}
npm run eval:router            # router_model.json, router_eval.{json,md}, frontier.{csv,svg}
npm run eval:chunking          # chunking_eval.{json,md}   (embeds the fixed windows once; cached)
npm run eval:simplification    # simplification_eval.{json,md}
npm run eval:graph && npm run eval:disclosures
npm test

# with a Gemini key: the real LLM instead of the surrogate judge
GEMINI_API_KEY=... npm run eval:router:gemini
GEMINI_API_KEY=... npm run eval:simplification -- --llm
```

Everything is seeded (benchmark seed 7, bootstrap seed 11) and deterministic for a given corpus and judge.
