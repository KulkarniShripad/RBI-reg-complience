# URCC-EF Research Blueprint: Adaptive Neuro-Symbolic Compliance Reasoning for RBI Regulation

*A critical research and implementation blueprint. Written to disagree with parts of the original proposal where the literature doesn't support them — per the explicit brief not to simply agree.*

---

## 0. The one-paragraph verdict

Your proposed architecture is technically sound and buildable. It is **not**, as specified, a single coherent research contribution — it's roughly four separate research programs (rule extraction, adaptive routing, graph reasoning, benchmark construction) bundled into one system diagram, and two of those four (generic "adaptive LLM routing" and "hybrid neuro-symbolic compliance") sit in **very crowded, active 2025–2026 literatures** where a from-scratch B.Tech implementation will not out-novel dedicated papers. The parts that *are* genuinely under-explored are narrower than what you proposed: **India/RBI-specific rule extraction**, and **routing between reasoning *modalities* (symbolic/graph/semantic/human) driven by regulatory-clause features, not generic query-difficulty/cost proxies**. Build around those two, keep everything else as engineering infrastructure that supports the experiments, and treat the graph subsystem as a scoped-out theoretical design chapter, not an experimental claim.

---

## 1. What the literature actually shows (searched, not assumed)

### 1.1 "Adaptive/cost-aware LLM routing" is a saturated field, not an open problem

This is the most important correction to make before you write a proposal. Routing queries across multiple LLMs by cost, difficulty, or confidence is an extremely active subfield with dozens of 2024–2026 papers: RouteLLM (learning to route from preference data), FrugalGPT, HybridLLM, GraphRouter, CARGO (confidence-aware routing), contextual-bandit routers under budget constraints, and surveys explicitly framing the design space along exactly the axes you listed (query features, model metadata, historical performance; rules vs. classifiers vs. RL). <cite index="126-1,138-1">One recent paper frames LLM routing explicitly as a contextual bandit problem learning from partial supervision.</cite> <cite index="127-1">A 2026 survey on dynamic routing and cascading organizes the entire design space along the same three axes your proposal independently arrived at — decision timing, input signals, and computation method.</cite>

**Implication:** if your "Route 1–4" router is instantiated as *cost-aware LLM selection* (which model to call), reviewers with any familiarity with this literature will immediately place it against RouteLLM/HybridLLM/FrugalGPT and ask why it's different. It probably won't survive that comparison as a primary contribution.

**What's genuinely different in your proposal, and worth keeping:** your router doesn't choose *which LLM*, it chooses *which reasoning paradigm* — a deterministic rule engine, a graph traversal, a retrieval+LLM pipeline, or a human — for a *regulatory compliance* decision specifically. That's a much thinner literature (see 1.2). Reframe the contribution as **modality routing for neuro-symbolic compliance reasoning**, not **LLM routing**, and cite the LLM-routing literature only to explicitly distinguish your problem from it in the related-work section. This single reframe is probably the highest-leverage change to make to your whole proposal.

### 1.2 Neuro-symbolic compliance is real, active, and closer to what you're proposing than you may realize

This is not a green field either, but it's much thinner than routing, and closer to your actual idea:

- <cite index="147-1">A January 2026 paper integrates LLMs with SMT solvers for financial-legal compliance, having the LLM generate formal constraints that a solver then checks for consistency and computes minimal corrections for, evaluated on 87 Taiwan Financial Supervisory Commission enforcement cases with 86.2% correct SMT-code generation.</cite>
- <cite index="152-1">GraphCompliance (already in your earlier project's related-work) aligns a Policy Graph against a Context Graph via a "Compliance Gate" that structurally constrains the final LLM judgment, and the authors themselves flag extending to finance as future work they have not done.</cite>
- <cite index="144-1">A cybersecurity-compliance paper combines neural prediction with symbolic rule-based explanation specifically to get both accuracy and rule-traceable explanations, describing this hybrid direction as still limited by hand-crafted symbolic rules.</cite>
- <cite index="149-1">A public-sector accountability paper explicitly identifies the gap your project sits in: existing symbolic compliance systems rely on hand-enumerated rules disconnected from unstructured natural-language regulatory text, and LLMs are the bridge — but notes this bridging work has mostly targeted generic legal-concept extraction, not a specific national regulator's full corpus.</cite>

**Implication:** "hybrid neuro-symbolic architecture for regulatory compliance" as a bare claim is not novel — it's the recognized 2025–2026 direction, with multiple concrete instantiations (LLM+SMT, LLM+graph-alignment, LLM+rule-engine). What's still absent, confirmed across every paper found in both this search round and your project's earlier related-work check: **none of them target Indian/RBI banking regulation**, and none combine *four* reasoning modalities (deterministic rules + graph + RAG/LLM + human escalation) with a *learned or formally justified routing policy between all four* — most existing systems are two-way (LLM+one symbolic backend).

### 1.3 Synthetic regulatory-compliance benchmarks are also an established, rigorous practice — your dataset needs to match this bar to be credible, but the *idea* of doing it is not itself novel

- <cite index="175-1">Compliance-to-Code decomposes 1,159 real Chinese financial-regulation clauses into structured "Compliance Units" (subject, condition, constraint, contextual information) and further compiles 307 of them into executable, tested Python code with chain-of-thought justification — a far more rigorous validation bar than ground-truth labels alone.</cite>
- <cite index="174-1">FinAuditing builds a taxonomy-structured benchmark from *real* XBRL filings and reports that model accuracy drops 60–90% on hierarchical multi-document structures — evidence that a synthetic benchmark's difficulty needs to reflect real structural complexity, not just varied thresholds.</cite>
- <cite index="176-1">CNFinBench uses over 13,000 instances validated across multiple expert-review stages, including dedicated adversarial-case review by anti-fraud specialists.</cite>
- <cite index="170-1">ComplianceNLP, a knowledge-graph-augmented RAG system for cross-framework regulatory gap detection, reports 87.7 F1 on gap detection and explicitly measures robustness by re-testing on synthetically perturbed policies, finding graduated F1 degradation under moderate vs. aggressive perturbation — this is close to your "boundary/near-boundary/adversarial case" design and is a good methodological template to follow.</cite>

**Implication:** your synthetic-benchmark plan (§10 of your brief) is methodologically sound and matches current best practice, but it will read as *infrastructure supporting the evaluation*, not as a standalone contribution, because comparable rigor already exists elsewhere. Cite these as precedent for your methodology; don't claim the benchmark itself as a headline contribution — claim what you *learn* from routing/extraction experiments run on it.

### 1.4 What is confirmed still absent (this is your actual opening)

Across every source found in this search round and the prior project's related-work check (GraphCompliance, Galli et al. on the EU AI Act, PrivComp-KG, RAGulating Compliance, Compliance-to-Code, CNFinBench, FinAuditing, ComplianceNLP): **not one targets Indian regulation, RBI, or Reserve-Bank-style Master Directions.** They cluster around GDPR, EU AI Act, SEC/US filings, MiFID II, Basel III, and Chinese financial law. This is a real, checkable gap, and it's the one claim in your whole proposal that a literature review will not contradict.

---

## 2. Direct answers to your "Final Research Positioning" questions (§26)

**Is this feasible for a B.Tech project?** The *engineering* is feasible — you've already built most of it (structural parser, classifier, chunker, relational+vector store, working compliance-check demo against 266 real documents). The *research* as originally scoped (5 subsystems, 4-way routing, graph reasoning, formal optimization, full evaluation suite) is not feasible for one person in a B.Tech timeline. Cut to two subsystems as primary, one as secondary/theoretical.

**Sufficiently substantial for a journal paper?** Yes, *if* narrowed. A well-executed, honestly-evaluated rule-extraction pipeline + modality router for one under-served regulatory domain, with a real (not toy) benchmark and real ablations, is a legitimate applied-AI/RegTech journal contribution (think: Expert Systems with Applications, Journal of Banking Regulation, or an AI-and-law / NLLP-adjacent venue). It is not, as originally scoped, a top-tier ML-conference contribution — you don't have the routing-theory novelty for that bar (see 1.1).

**Primary contribution:** the **regulatory-feature-driven modality router** (Route 1–4, but justified by clause structure and extraction confidence, not generic difficulty/cost) — evaluated against the fixed-hybrid and rule-only/LLM-only baselines, on your own benchmark.

**Secondary contributions:** (a) the schema-constrained RBI rule-extraction pipeline with measured precision/recall against a human-annotated sample (you already have real, measured numbers — 387/3,984 clean rule-atom yield, 94% document-parse coverage — this is publishable *as measured*, not as a headline claim); (b) the synthetic benchmark itself, released as an artifact, positioned as "first RBI-domain compliance benchmark," which is defensible given the confirmed gap in 1.4.

**Should the counterparty graph subsystem be included?** As a *theoretical/design* chapter only — see §7 below. Do not present graph-based results as an experimental contribution unless you can source real MCA ownership data, which you almost certainly cannot on this timeline. This matches the fallback you yourself proposed in your message.

**Is automatic rule extraction sufficiently novel?** Not extraction-in-general (LLM-based clause-to-structured-rule extraction is well studied, e.g. Compliance-to-Code, CODE-ACCORD, Galli et al.). Extraction *from RBI's specific drafting templates*, with the three real structural variants and real bugs your project already found (the "Chatper" typo, TOC-pagination heuristic failure, legacy decimal-numbering template) is a legitimate, modest, *methods*-level contribution because it's grounded in measured failure modes on real documents, which most extraction papers report only in aggregate.

**Is adaptive routing sufficiently novel?** Not as LLM-routing (see 1.1). Reframed as regulatory-modality routing with a formally stated (not just descriptive) objective, evaluated against your own fixed-hybrid baseline — yes, this is the strongest candidate for your primary contribution, *specifically because* the neuro-symbolic-compliance literature found in 1.2 is mostly two-modality (LLM+one symbolic backend), not four-way.

**Would a synthetic benchmark strengthen the paper?** Yes, but as supporting infrastructure with its own validity checks (inter-annotator agreement on a sample, perturbation robustness test like ComplianceNLP's), not as the headline.

**What would make this merely an engineering project instead of research?** Presenting the working pipeline (which is real and good) without a *comparison* — i.e., without baselines, ablations, and a stated hypothesis about *when* each reasoning modality wins or loses. You already have the engineering. The paper needs the experiment.

**What experiments are absolutely necessary?** (1) Routing-policy comparison (static vs. rule-first vs. confidence-threshold vs. your proposed policy) on accuracy/cost/latency; (2) rule-extraction accuracy against a held-out human-annotated sample of RBI clauses; (3) an ablation removing each component (per your §16) to show the system isn't "just an LLM with extra steps." Nothing else is load-bearing for a first paper.

**What would reviewers criticize?** (a) A synthetic-only benchmark with no real-bank validation — mitigate by being explicit about this limitation, exactly as your existing project docs already do well; (b) claiming routing novelty without engaging the LLM-routing literature — mitigate by citing and distinguishing, as in 1.1; (c) an underpowered graph subsystem presented as evaluated — mitigate by scoping it to theory-only, explicitly.

**Biggest implementation risks:** LLM API cost/rate limits during benchmark generation and routing experiments (budget for this explicitly); rule-extraction accuracy plateauing below a publishable threshold on the harder clause types (you already measured this at ~10% clean-template yield — plan the paper's narrative around *this being the finding*, not a defect to hide, exactly per your project's own "measure before estimating" norm).

**What should be removed to keep this manageable?** Full graph DB implementation with real ownership data (infeasible — no data source); a learned/RL routing policy (needs far more labeled routing decisions than one B.Tech timeline produces — start with a rule-based/formal routing policy and treat learned routing as future work); OPA/Drools as the rule engine (unnecessary infrastructure weight — your existing Python/SQL deterministic evaluator already *is* the rule engine; don't add a DSL you don't need).

**What should be added to increase novelty?** A **held-out human-annotated evaluation set** for rule extraction (even 150–200 clauses, doubly annotated) — this is what separates "we built a pipeline" from "we measured extraction accuracy," and none of your current numbers are validated against independent human judgment yet.

---

## 3. Recommended final architecture (cut from your original)

```
RBI PDFs (confirmed structural variants: Directions / legacy decimal / Guidelines)
        │
        ▼
Structure-aware parser  ──────────────────►  Relational store (SQLite→Postgres)
        │                                     clause_registry, rule_atoms,
        ▼                                     definitions, cross_references
Clause classifier (quant/qual/relational/hybrid)
        │
        ▼
Rule extraction (regex-first, LLM-refinement for the ~90% regex misses)
        │                                     Vector store (embeddings of
        ▼                                     EVERY clause type)
┌───────────────────────────────┐                    │
│   MODALITY ROUTER (primary    │◄───────────────────┘
│   research contribution)      │
└───────────────────────────────┘
    │        │        │        │
    ▼        ▼        ▼        ▼
 Rule     Graph     RAG+LLM   Human
 Engine   (design/  (Gemini,  Review
 (SQL)    theory     grounded  Queue
          only, §7)  in clause
                      text)
    │        │        │        │
    └────────┴────────┴────────┘
              ▼
     Evidence + confidence
              ▼
     Compliance decision + audit trail
     (COMPLIANT / NON_COMPLIANT /
      INSUFFICIENT_DATA / AMBIGUOUS /
      REQUIRES_HUMAN_REVIEW)
```

Graph reasoning is drawn *dotted* in the actual diagram you submit — it feeds the router conceptually but is evaluated only against synthetic data with that limitation stated on the same page as any result touching it, never buried in a limitations section at the end.

---

## 4. Regulatory rule representation (revised schema)

Your proposed `Rule` object is reasonable but under-specifies the two things that actually vary across RBI clause types. Extend it:

```json
{
  "rule_id": "rbi://rrb/c8094e287b8b0292/para29",
  "source_document": "RBI/DOR/2025-26/260",
  "clause_uri": "rbi://rrb/c8094e287b8b0292/para29",
  "rule_type": "quantitative | boolean | conditional | temporal | qualitative | relational | procedural",
  "condition": {
    "subject": "HTM category investments",
    "operator": "<=",
    "threshold": 25,
    "unit": "%",
    "reference_metric": "total investments",
    "temporal_scope": null
  },
  "qualifiers": {
    "conditional_logic": null,
    "exceptions": [],
    "applies_if": null
  },
  "applicability": ["Regional_Rural_Bank"],
  "effective_from": "2025-XX-XX",
  "effective_to": null,
  "superseded_by": null,
  "version": 1,
  "extraction_confidence": "high | low",
  "extraction_method": "regex_template | llm_refined | human_curated",
  "extraction_evidence": "shall not exceed 25 per cent",
  "human_reviewed": false,
  "cims_mapping": {
    "return_code": null,
    "field_tag": null,
    "mapping_status": "unverified | approved"
  }
}
```

This is close to Compliance-to-Code's subject/condition/constraint/context decomposition — cite it as precedent, don't present the shape of this schema itself as novel. What *is* worth reporting as a finding is which `rule_type` values your regex-first extractor handles cleanly vs. which require LLM refinement — that's your measured extraction-accuracy table.

**Relational DB:** stay on SQLite→Postgres exactly as your existing project already planned; this is a mechanical swap, not a research decision, and you were right not to over-index on it.

**Vector DB:** for a student prototype, **pgvector** over Qdrant/Milvus/Weaviate — one fewer service to run, one fewer thing to explain in a methods section that isn't about vector-DB engineering, and it sits in the same Postgres instance as your relational store once you migrate off SQLite. Only move to a dedicated vector engine if you specifically need ANN performance at a scale your 266–500 document corpus won't reach. Say this plainly in the paper: the vector DB choice is an engineering decision, explicitly not a research variable.

**Rule engine:** don't add Drools/OPA. <cite index="141-1">Neuro-symbolic process-automation research treats the symbolic layer as whatever formal system a domain state machine actually needs, not a fixed product choice</cite> — for pure numeric threshold evaluation, a Python/SQL evaluator over `rule_atoms` (what you already built) is the deterministic layer. Introducing a general-purpose rule-DSL engine adds infrastructure weight with no research payoff for this scope.

---

## 5. The routing algorithm (your primary contribution) — design + pseudocode

### 5.1 Principled routing signals (regulatory-specific, not generic LLM-difficulty proxies)

| Signal | Source | Used for |
|---|---|---|
| `rule_type` | classifier output | hard gate: quantitative/boolean/temporal → Route 1 by default |
| `extraction_confidence` | regex-template match vs. LLM-refined vs. unmatched | low confidence → never trust Route 1 alone |
| `relational_keyword_hit` | classifier's relational-keyword list | routes toward Route 2 (graph) *when graph data exists*, else Route 4 |
| `retrieval_score_spread` | top-k vector similarity gap | large gap = confident retrieval → Route 3; flat/low = Route 4 |
| `evidence_completeness` | required bank-data fields present? | missing → INSUFFICIENT_DATA, short-circuits before any reasoning route |
| `historical_agreement` | did Route 1 and Route 3 agree on this rule_id in past runs? | persistent disagreement → force Route 4 |
| `risk_tier` | clause maps to a breach with regulatory penalty vs. procedural note | scales the human-review threshold (§5.3) |

### 5.2 Formal objective (grounded, not decorative)

Minimize expected cost subject to an accuracy floor, per rule instance *i*:

```
Cost(route) = α · P(error | route, features_i) · RiskWeight(clause_i)
            + β · LLMCallCost(route)
            + γ · Latency(route)

choose route* = argmin_route Cost(route)
subject to: P(error | route*, features_i) ≤ ε_max(risk_tier_i)
```

This is honest about being a **cost-sensitive decision rule over a small, enumerable route set (4 options)**, not a learned policy — which is the right scope for your data volume. Present it as a formal decision rule with measured `P(error | route, features)` estimated from your benchmark's confusion matrices per route, not as an RL/bandit policy (that needs far more labeled interaction data than you'll have — this is exactly the gap several of the LLM-routing papers found above spend their whole paper solving, at much larger scale than you have available).

### 5.3 Pseudocode

```python
def route(clause, bank_data, history, risk_registry):
    # Step 0 — hard short-circuit: missing required data
    if not evidence_available(clause, bank_data):
        return Decision.INSUFFICIENT_DATA, route=None

    # Step 1 — deterministic gate for clean quantitative/boolean/temporal rules
    if clause.rule_type in {"quantitative", "boolean", "temporal"} \
       and clause.extraction_confidence == "high":
        result = rule_engine.evaluate(clause, bank_data)
        if result.status != "AMBIGUOUS":
            return result, Route.RULE_ENGINE

    # Step 2 — relational/graph-eligible clauses, only if graph data exists
    if clause.relational_keyword_hit and graph_db.has_data(clause.entity_scope):
        result = graph_reasoner.evaluate(clause, bank_data)
        if result.confidence >= THRESHOLD_GRAPH:
            return result, Route.GRAPH

    # Step 3 — retrieval + LLM for qualitative/ambiguous/low-confidence cases
    retrieval = vector_search(clause.text, bank_data.evidence_corpus)
    if retrieval.score_spread >= THRESHOLD_RETRIEVAL_CONFIDENT:
        result = llm_judge(clause, retrieval.top_evidence)
        agreement = check_agreement(result, history.get(clause.rule_id))
        if result.confidence == "high" and agreement != "PERSISTENT_DISAGREEMENT":
            return result, Route.RAG_LLM

    # Step 4 — fall through to human review; risk tier scales how eagerly
    # Step 3 falls through here (see THRESHOLD_RETRIEVAL_CONFIDENT tuning
    # per risk_tier — high-risk clauses use a stricter threshold)
    return Decision.REQUIRES_HUMAN_REVIEW, Route.HUMAN
```

### 5.4 Baselines to compare this against (your §14, tightened)

1. **Rule-only** — every clause forced through Route 1; qualitative clauses default to INSUFFICIENT_DATA. Shows the ceiling of pure determinism.
2. **LLM-only** — raw clause text + raw bank data straight to Gemini, no retrieval, no rule engine. Shows the hallucination/inconsistency floor you're arguing against.
3. **RAG+LLM (no router)** — Route 3 for everything. Shows what you lose by *not* having a router (this is your most important baseline — it directly tests whether the router earns its complexity).
4. **Fixed hybrid** — a manually-written if/else on `rule_type` only (no confidence signals, no history, no risk tiering). This isolates the value of your *specific* routing signals vs. a naive hybrid a competent engineer would build without the research.
5. **Proposed adaptive router.**

The comparison that actually matters for your paper is **4 vs. 5** — if your router doesn't beat a naive fixed hybrid by a real margin on accuracy, cost, *or* latency (ideally shown as a Pareto improvement, not just one metric), you don't have a result yet, no matter how principled the design looks on paper.

---

## 6. Rule extraction as a secondary contribution — what to actually measure

You already have real numbers from the existing project; treat rule-extraction accuracy as a formal experiment, not a pipeline statistic:

| Metric | How to compute | Your existing baseline |
|---|---|---|
| Clause segmentation accuracy | parser output vs. hand-checked TOC/paragraph boundaries on a sample | not yet measured — do this first, it's cheap |
| Rule-type classification P/R/F1 | classifier output vs. human-labeled sample (≥150 clauses, 2 annotators, report Cohen's κ) | not yet measured |
| Operator/threshold/unit accuracy | regex-matched `rule_atoms` vs. hand-verified | 387 atoms exist — spot-check a stratified sample |
| Extraction completeness (recall) | how many clauses *should* have yielded a rule_atom but didn't | this is your known ~10%-yield finding — report it as recall, framed honestly |
| Executability rate | of extracted rule_atoms, how many actually run against a submitted value without error | should be ~100% by construction; report if not |

The single highest-value addition here: **get a second human annotator** (a classmate, or yourself at two sittings a week apart) to independently label 150–200 clauses, and report inter-annotator agreement before comparing either annotator to your pipeline. Every rigorous extraction paper found above does this; your project doesn't have it yet, and a reviewer will ask for it immediately.

---

## 7. The counterparty graph subsystem — recommended treatment

**Do not build this as an evaluated subsystem.** Recommendation, restated plainly: Option A (core paper, no graph results). Include a **design-only section** covering:

- Graph schema: `:CONTROLS` (ownership, sourced conceptually from MCA filings), `:ECONOMIC_INTERDEPENDENCE` (transactional, RBI's own framework treats these as rebuttable — model them as `confidence: "flagged" | "confirmed"` edges, never asserted fact)
- Connected-component / group detection algorithm (standard graph traversal — Neo4j or even NetworkX over your existing relational store is fine for a design description)
- Exposure aggregation logic against the RBI Large Exposures Framework thresholds you already sourced (~20% single counterparty, ~25% connected group)
- An explicit **synthetic evaluation on hand-constructed ownership graphs** (5–10 small synthetic corporate structures), reported *as a proof-of-concept*, with a one-sentence limitation on every figure/table that touches it: *"evaluated on synthetic ownership data; real deployment requires MCA registry integration, not available in this study."*

This gets you the "we thought about it seriously and know exactly what's missing" credit reviewers give, without the risk of an underpowered experimental claim.

---

## 8. Research questions (revised)

**RQ1.** Does a regulatory-feature-driven modality router outperform a fixed rule-type-based hybrid and a RAG+LLM-only baseline on accuracy, cost, and latency simultaneously (Pareto comparison), for RBI compliance checking?

**RQ2.** How much of the router's benefit comes from extraction-confidence signals specifically, versus rule-type alone? (Direct ablation: router with confidence signal removed vs. full router.)

**RQ3.** What is the measured precision/recall/F1 of schema-constrained rule extraction from RBI Master Directions, broken down by the three confirmed structural template variants, against an independently human-annotated sample?

**RQ4.** Does evidence-grounded (retrieval-anchored) LLM judgment reduce unsupported/hallucinated compliance verdicts compared to an LLM-only baseline, measured by citation/evidence-faithfulness rate on the benchmark's adversarial and contradictory-evidence cases?

**RQ5 (secondary, design-only).** *[Not experimentally answered]* Could connected-counterparty graph reasoning detect concentration risk invisible to row-level rule checks? Answered by worked synthetic examples, explicitly not by a quantitative evaluation claim.

Dropped from your original list: a generic "hybrid beats LLM-only" RQ1 — this is already answered repeatedly in the literature found above (GraphCompliance, ComplianceNLP, the SMT-solver paper all show this); re-demonstrating it isn't a contribution, it's a sanity check you report in a table, not a headline finding.

---

## 9. Evaluation metrics — trimmed to what you can actually run

Keep, from your §15: compliance accuracy/precision/recall/F1/FPR/FNR; extraction P/R/F1 (§6 above); routing accuracy and unnecessary-LLM-call rate; cost per case and token count; evidence-citation accuracy (compare cited `clause_uri` against ground truth). **Drop** "routing overhead" and "throughput" as headline metrics — at your data scale these will not be statistically meaningful and will read as padding. Report them in an appendix table if you have them, not in the main results.

---

## 10. Novelty statement (defensible version, for your actual paper)

> We present an adaptive reasoning-modality router for RBI regulatory compliance checking that selects between deterministic rule evaluation, retrieval-grounded LLM judgment, and human escalation based on regulatory-clause-derived confidence signals, evaluated against fixed-hybrid and single-modality baselines on a benchmark constructed from schema-constrained extraction of India's Reserve Bank Master Directions — the first such benchmark and system targeting Indian central-bank financial regulation, a domain confirmed absent from the current GDPR/EU-AI-Act/SEC/China-centric regulatory-NLP and neuro-symbolic-compliance literature.

Everything in that sentence is a claim the searches above actually support. Do not add "novel hybrid architecture using LLMs and rule engines" as a separate claim — say what's specifically different (modality router driven by regulatory features; India/RBI domain), not that hybridization itself is new.

---

## 11. Candidate paper titles

1. *"Adaptive Modality Routing for Regulatory Compliance Reasoning: A Case Study on Indian Banking Regulation"*
2. *"From RBI Master Directions to Executable Compliance Rules: A Schema-Constrained Extraction Pipeline and Benchmark"*
3. *"When to Trust the Rule Engine: Confidence-Driven Reasoning-Path Selection for Neuro-Symbolic Regulatory Compliance"*

(1) is the strongest single title if the router is your headline result; (2) if extraction accuracy ends up being your strongest, most defensible number by submission time — keep both drafts alive until your experiments are done, don't commit early.

---

## 12. Hypothesis, variables, and what "convincing evidence" looks like

**Central hypothesis:** For regulatory compliance checking in a domain with heterogeneous clause types, routing each clause to the cheapest reasoning modality that meets a risk-scaled accuracy floor achieves better accuracy-cost-latency trade-offs than either a single modality alone or a naive rule-type-only hybrid.

**Independent variables:** routing policy (5 conditions from §5.4); clause `rule_type`; `extraction_confidence` tier; `risk_tier`.

**Dependent variables:** compliance decision accuracy vs. ground truth; LLM call count/cost; end-to-end latency; evidence-citation faithfulness.

**Convincing evidence** = the proposed router is Pareto-better than the fixed-hybrid baseline on at least two of {accuracy, cost, latency} while not losing more than a small, stated margin on the third, **and** the ablation (RQ2) shows the confidence signal specifically — not just rule-type — drives that improvement. Anything less than that second point is a fixed hybrid with extra steps, and a careful reviewer will say so.

---

## 13. Implementation roadmap (what to build first)

1. **Human-annotate the extraction eval set** (150–200 clauses, 2 annotators) — do this *before* more pipeline work; it's the thing every reviewer will ask for and it's cheap now, expensive to retrofit later.
2. **Freeze the rule representation schema** (§4) and migrate `rule_atoms`/`clause_registry` to match, including the `extraction_confidence`/`extraction_method` fields the router needs.
3. **Build the fixed-hybrid baseline first**, not the adaptive router — you need it working before you can show the router beats it, and it's most of the router's plumbing anyway (this is also literally the backend already built in this conversation — the deterministic quant check + Gemini-graded qual check *is* your fixed-hybrid baseline once the modality-selection logic is made explicit and toggleable).
4. **Implement the adaptive router** as a thin decision layer on top of step 3's plumbing (§5.3 pseudocode → real code).
5. **Generate the synthetic benchmark** from your real extracted rules (compliant/non-compliant/boundary/near-boundary/ambiguous/missing/adversarial/contradictory/version cases per rule, per your §10 — this part of your original plan was already right).
6. **Run the 5-way baseline comparison + ablations.**
7. **Write up extraction accuracy (RQ3) and router results (RQ1/RQ2) as the two main result sections; graph subsystem as design-only appendix.**

---

## 14. What I'd cut entirely, stated plainly (per your instruction to critically evaluate)

- **Drools/OPA/custom DSL** — unneeded infrastructure; your SQL evaluator already is the rule engine.
- **Neo4j with real data** — no data source exists; keep as design-only (§7).
- **A learned/RL routing policy** — needs far more labeled routing interactions than this project will generate; state as future work.
- **"Adaptive routing" framed as LLM-model-selection** — reframe as modality-selection or it collides head-on with a saturated literature (§1.1).
- **Claiming the hybrid-beats-LLM-only result as novel** — already shown repeatedly in 2025–2026 papers (§1.2); demote to a sanity-check table, not a finding.
- **Throughput/overhead as headline efficiency metrics** — not statistically meaningful at your data scale.
