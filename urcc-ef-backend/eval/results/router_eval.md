# Adaptive Compliance Checking - measured results (test split, n = 294)

Judge for the LLM paths: **surrogate**. RAG+LLM and LLM-only outcomes use the offline surrogate judge (deterministic reading heuristics standing in for the LLM); LLM cost and latency are modelled from Gemini 2.5 Flash list prices and an assumed latency. Re-run with --judge gemini to measure the real model.

Error-model estimator chosen on validation: DETERMINISTIC → tree (val log-loss logistic 0.0627, tree 0.043); RAG_LLM → logistic (val log-loss logistic 0.4667, tree 0.814).

Benchmark: 1393 cases from 215 rules; splits train 840 / validation 259 / test 294 (by rule). τ_acc = 0.95. R4 parameters chosen on validation: α = 1, β = 0.1, γ = 0.001, MIN_EVIDENCE = 0.75; R2 θ = 0.85.

## Systems (Tables VII / X / XI)

| System | Accuracy | End-to-end acc. | Macro-F1 | NC F1 | FPR | FNR | Escalated | LLM calls | Citation acc. | Halluc. rate | USD / case | Mean latency (ms) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B1 Rule-only | 66% | 66% | 0.554 | 0.787 | 0% | 35% | 0% | 0% | 100% | 0% | 0.00000 | 0 |
| B2 LLM-only (no retrieval) | 56.8% | 56.8% | 0.522 | 0.575 | 16.5% | 46.4% | 0% | 100% | 37.4% | 62.6% | 0.00130 | 2700 |
| B3 RAG+LLM | 72.5% | 72.5% | 0.711 | 0.623 | 11% | 41.2% | 0% | 100% | 100% | 0% | 0.00050 | 1860 |
| B4 / R3 Fixed hybrid | 85.4% | 85.4% | 0.779 | 0.851 | 0% | 17.5% | 0% | 34.7% | 100% | 0% | 0.00020 | 645.3 |
| R0 Earlier heuristic router | 83.3% | 92.9% | 0.811 | 0.791 | 0% | 11.3% | 19.1% | 17% | 100% | 0% | 0.28580 | 114602.1 |
| R1 Static rule-first | 86.4% | 86.4% | 0.823 | 0.829 | 0% | 17.5% | 0% | 46.6% | 100% | 0% | 0.00020 | 866.8 |
| R2 Confidence threshold (θ=0.85) | 71.8% | 95.6% | 0.613 | 0.793 | 0% | 9.3% | 34.7% | 11.9% | 100% | 0% | 0.52050 | 208384.7 |
| R4 Proposed adaptive | 92.2% | 96.9% | 0.907 | 0.889 | 0% | 3.1% | 12.9% | 20.1% | 100% | 0% | 0.19400 | 77924.3 |
| R4 at R0's cost budget | 86.4% | 99% | 0.871 | 0.838 | 0% | 0% | 25.2% | 7.8% | 100% | 0% | 0.37760 | 151165.9 |
| R4 fully automated (no human) | 87.8% | 87.8% | 0.834 | 0.842 | 0% | 17.5% | 0% | 33% | 100% | 0% | 0.00020 | 613.7 |
| Oracle (cheapest correct route) | 94.2% | 100% | 0.943 | 0.904 | 0% | 0% | 11.9% | 22.1% | 100% | 0% | 0.17870 | 71839.8 |

LLM calls avoided by R4 relative to B3: **79.9%**.

Accuracy = the decision is in the case's acceptable set; end-to-end accuracy additionally counts an escalation as resolved correctly by the human reviewer (cost and latency of the reviewer are charged).

## Routing accuracy against the reference route (cheapest correct modality)

| Router | Routing accuracy |
|---|---|
| B1 Rule-only | 66% |
| B2 LLM-only (no retrieval) | 0% |
| B3 RAG+LLM | 22.1% |
| B4 / R3 Fixed hybrid | 79.6% |
| R0 Earlier heuristic router | 77.5% |
| R1 Static rule-first | 74.2% |
| R2 Confidence threshold (θ=0.85) | 69% |
| R4 Proposed adaptive | 93.2% |
| R4 at R0's cost budget | 85% |
| R4 fully automated (no human) | 87.8% |
| Oracle (cheapest correct route) | 100% |

## Accuracy by case type (Table X)

| Case type | B2 LLM-only (no retrieval) | B3 RAG+LLM | B4 / R3 Fixed hybrid | R0 Earlier heuristic router | R4 Proposed adaptive | R4 at R0's cost budget | B2 wrong-citation rate |
|---|---|---|---|---|---|---|---|
| adversarial | 46.2% | 46.2% | 56.4% | 56.4% | 56.4% | 56.4% | 56.4% |
| ambiguous | 40% | 40% | 20% | 66.7% | 80% | 90% | 60% |
| boundary | 85% | 90% | 100% | 100% | 100% | 100% | 55% |
| compliant | 87.5% | 95% | 100% | 82.5% | 100% | 75% | 57.5% |
| contradictory | 55.6% | 75% | 94.4% | 100% | 100% | 100% | 55.6% |
| cross_version | 50% | 50% | 100% | 100% | 100% | 100% | 40% |
| missing_data | 20.5% | 92.3% | 100% | 92.3% | 100% | 100% | 97.4% |
| near_boundary | 64.7% | 76.5% | 100% | 100% | 100% | 100% | 58.8% |
| non_compliant | 65.2% | 71.7% | 100% | 73.9% | 100% | 78.3% | 60.9% |

## Accuracy by requirement category

| Category | B2 LLM-only (no retrieval) | B3 RAG+LLM | B4 / R3 Fixed hybrid | R0 Earlier heuristic router | R4 Proposed adaptive | R4 at R0's cost budget |
|---|---|---|---|---|---|---|
| A | 47.7% | 66.1% | 89.9% | 97.3% | 97.3% | 97.3% |
| B | 75% | 91.7% | 66.7% | 75% | 100% | 100% |
| C | 73.3% | 73.3% | 100% | 80% | 100% | 100% |
| D | 77.1% | 91.7% | 100% | 100% | 100% | 100% |
| E | 54.8% | 71.4% | 71.4% | 61.9% | 79.8% | 64.3% |
| F | 61.1% | 77.8% | 77.8% | 55.6% | 83.3% | 61.1% |
| G | 12.5% | 12.5% | 100% | 100% | 100% | 100% |

## Ablations (Table XV)

| Configuration | Accuracy | End-to-end acc. | Halluc. rate | USD / case | Mean latency (ms) |
|---|---|---|---|---|---|
| Full proposed system | 92.2% | 96.9% | 0% | 0.19400 | 77924.3 |
| − adaptive routing (→ B4) | 85.4% | 85.4% | 0% | 0.00020 | 645.3 |
| − rule engine (→ B3) | 72.5% | 72.5% | 0% | 0.00050 | 1860 |
| − evidence grounding (→ B2) | 56.8% | 56.8% | 62.6% | 0.00130 | 2700 |
| − hard override | 92.2% | 96.9% | 0% | 0.19400 | 77924.3 |
| − learned error model (historical accuracy only) | 84.4% | 94.6% | 0% | 0.30620 | 122683.1 |
| − evidence-completeness gate | 91.8% | 96.6% | 0% | 0.18380 | 73962.9 |

## Significance (test split; paired cluster bootstrap by rule, 2,000 resamples; exact McNemar)

| Comparison | Δ accuracy [95% CI] | McNemar p | Δ end-to-end [95% CI] | McNemar p |
|---|---|---|---|---|
| R4 Proposed adaptive vs R0 Earlier heuristic router | +8.8 pp [+5.3 pp, +12.7 pp] | 2.98e-8 | +4.1 pp [+1.7 pp, +6.8 pp] | 0.000488 |
| R4 Proposed adaptive vs B4 / R3 Fixed hybrid | +6.8 pp [+4.3 pp, +9.4 pp] | 0.00000191 | +11.6 pp [+8.0 pp, +15.4 pp] | 1.16e-10 |
| R4 Proposed adaptive vs R1 Static rule-first | +5.8 pp [+3.2 pp, +8.4 pp] | 0.0000763 | +10.5 pp [+6.9 pp, +14.4 pp] | 7.92e-9 |
| R4 Proposed adaptive vs B3 RAG+LLM | +19.7 pp [+13.5 pp, +26.2 pp] | 1.06e-16 | +24.5 pp [+18.3 pp, +30.7 pp] | 7.94e-21 |
| R4 fully automated (no human) vs R1 Static rule-first | +1.4 pp [+0.0 pp, +3.0 pp] | 0.219 | +1.4 pp [+0.0 pp, +3.0 pp] | 0.219 |
| R4 fully automated (no human) vs B4 / R3 Fixed hybrid | +2.4 pp [+0.7 pp, +4.3 pp] | 0.0156 | +2.4 pp [+0.7 pp, +4.3 pp] | 0.0156 |

Adaptive router adopted in the running system (routed endpoint): **yes (tau operating point)** (adopted only if an operating point chosen on validation is at least as accurate as the earlier heuristic router R0, on both accuracies and at ≤ 5% extra cost, on the validation and the test split).
