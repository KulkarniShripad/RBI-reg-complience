# RegComp — hybrid semantic-symbolic verification of RBI compliance

A standalone implementation of the method in the conference paper *"A Robust Framework for
Banking Regulatory Compliance Verification"*. Every number in [`results/`](results) is
produced by a script in this folder from the RBI directions in [`../circulars`](../circulars).
The main system in the rest of the repository is not used, except as the source of one
held-out test set (`data/numeric_gold.json`).

```
 RBI PDFs ─► ingest (pypdf, cleaning, clause ids) ─► obligation detection ─► rule extraction ─► simplification
                                                                                 │
 bank logs ─► unified schema ─► evidence units ─► NL descriptions (en / mr)      │  threshold · temporal
                                         │                                       ▼  cardinality · set
                                         └──► encoder ─► FAISS top-k clauses ─► validators ─► findings + audit trail
 account-months ─► behavioural features ─► Isolation Forest / One-Class SVM ─► REVIEW flags (KYC para 40)
```

| Paper component | Code |
|---|---|
| PDF parsing, header/footer/boilerplate removal, clause identifiers | `regcomp/ingest.py`, `regcomp/text.py` |
| Obligation detection (obligation keyword + numbered clause + testable cue) | `regcomp/obligations.py` |
| Rule extraction into testable conditions | `regcomp/rules.py`, `regcomp/lexicon.py` |
| T5 simplification (guarded) and template rendering of the rules | `regcomp/simplify.py` |
| Unified schema, evidence units, English and Marathi descriptions | `regcomp/records.py` |
| MahaBERT / IndicBERT / XLM-R (mean pooling), multilingual mpnet, bge-small (ONNX), TF-IDF | `regcomp/encoders.py` |
| FAISS inner-product index | `regcomp/index.py` |
| Threshold, temporal, cardinality and set validators | `regcomp/validators.py`, `regcomp/calendar.py` |
| One-Class SVM and Isolation Forest for the clause with no programmatic condition | `regcomp/anomaly.py` |
| Findings with source quote, parameters, validator, similarity, τ, encoder, version and timestamp | `regcomp/pipeline.py` |
| Metrics (P/R/F1, bootstrap CIs, Recall@k, MRR, κ) | `regcomp/metrics.py` |

## Data

* **Regulations:** 266 RBI directions (PDF) → 19,418 clauses. Scoped to a commercial bank (its own
  directions plus cross-sector ones), that gives 43 directions, 780 operational clauses, and
  529 extracted rules from 267 clauses.
* **Gold rules:** `data/gold_rules.yaml` has 14 machine-testable rules from 9 paragraphs of 4 commercial-bank
  directions:
  * KYC: small accounts, wire-transfer information, CKYCR deadlines, CDD documents, periodic updation with intimations and reminders;
  * Credit Cards: closure within 7 working days with ₹500/day, CIC update;
  * Internal Ombudsman: 30-day decision;
  * Outsourcing: 6-hour cyber incident reporting.

  Each rule is located by an exact quote. The parameters are written by hand.
* **Evidence (synthetic, because bank data is confidential):** `python -m synth.generate`
  * Writes raw transaction, KYC and audit logs.
  * Standardises them into 2,400 evidence units of 9 types.
  * Gives 30% of the units a Marathi description.
  * 3,705 (unit, rule) checks, 1,072 of them violated.
  * Includes boundary, exception and grace-period cases.
  * Split 70/15/15 by hash into 1,661 / 350 / 389 units.
  * Labels come from `synth/gold.py`, a labeller written separately from the validators. It shares no code with `regcomp/` and does not use extracted parameters.
* **Monitoring data:** `python -m synth.anomaly`
  * 12,000 account-months.
  * 2.5% of them carry one of the three patterns of KYC para 40.
  * 10% carry benign irregularities (bonus, fixed-deposit maturity, festival spending) that should not be flagged.

## Run

```bash
cd conference-method
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
# optional, for the bge-onnx rows: a local copy of bge-small-en-v1.5 (tokenizer.json + onnx/model.onnx)
huggingface-cli download Xenova/bge-small-en-v1.5 tokenizer.json onnx/model.onnx --local-dir models/bge-small-en-v1.5
export BGE_ONNX_DIR=models/bge-small-en-v1.5
./experiments/run_all.sh                 # ingest (~5 min), generate, every CPU experiment, tests
python experiments/make_figures.py       # results/figures/*.svg
```

To produce a compliance report for one set of records, run:
`python -m regcomp.pipeline --corpus work/corpus --units work/synth/units.jsonl --encoder tfidf --out results/run`
It writes `findings.jsonl` and `report.md`.

The transformer encoders, contrastive fine-tuning, fine-tuned classifiers and flan-T5 need a GPU and the
Hugging Face hub. Open [`experiments/colab_gpu.ipynb`](experiments/colab_gpu.ipynb) in Colab
(about 1 hour on a T4); it writes `results/*_gpu.md` and `results/*_ft.md`.

## Results (CPU, this repository's run)

Rule extraction (`results/extraction.md`):

| Test set | Rules | Exact match |
|---|---:|---:|
| Development: the 14 gold rules | 14 | 100% |
| Parallel held-out: the same provisions in other sectors' directions (NBFC, SFB, UCB, RRB, ...) | 86 | 100% |
| Numeric C1: figure requirements (used once for error analysis) | 24 | 100% |
| **Numeric C2: network limits (held-out, never inspected)** | 36 | **55.6%** [39.6, 70.5] |

C2 was 41.7% before the one round of error analysis on C1.

Verification on the test split (`results/verification.md`), pair = (unit, rule), with 95% bootstrap CIs:

| System | P | R | F1 | F1 English | F1 Marathi | Validator calls / unit |
|---|---:|---:|---:|---:|---:|---:|
| oracle link (gold clauses, extracted rules) | 100 | 100 | 100 | 100 | 100 | 2.6 |
| rule-only (every rule, no linking) | 93.9 | 100 | 96.9 [95.0, 98.5] | 96.9 | 96.7 | 529 |
| **hybrid, TF-IDF linking** | 99.2 | 81.8 | **89.7** [85.3, 93.5] | 97.2 | 64.6 | 8.1 |
| hybrid, bge-small (English-only) linking | 100 | 68.2 | 81.1 [75.1, 86.3] | 92.7 | 37.0 | 6.9 |
| best semantic-only baseline (TF-IDF + SVM, supervised) | 42.2 | 81.2 | 55.6 [50.1, 60.8] | 59.4 | 46.2 | – |

Read this as follows:
* Extraction and validation are exact once linking is right (oracle row).
* Linking recall is the bottleneck, above all for Marathi with encoders that cannot read Marathi. That is the motivation for the multilingual encoders and the contrastive fine-tuning of the GPU notebook.
* Rule-only scores higher here because every evidence type is typed and every rule is scope-gated. It also produces more false alarms and evaluates 65 times as many rules per record.
* τ chosen on validation is 0 for both encoders. With top-5 linking, the validators are the precision gate: a semantic match is necessary but never sufficient.

Monitoring, KYC para 40 (`results/anomaly.md`), at a 5% review budget:

| Detector | P | R | F1 | ROC-AUC |
|---|---:|---:|---:|---:|
| Isolation Forest (5 seeds) | 39.8 | 89.5 | 55.1 ± 0.8 | 0.989 |
| One-Class SVM | 24.5 | 67.5 | 36.0 | 0.886 |
| static red-flag rules | 48.1 | 62.5 | 54.3 | – |

Scalability (`results/scalability.md`; 4-core Xeon, no GPU):
* 53 pages/s ingestion.
* 4,500 clauses/s obligation detection.
* Linking plus validation takes 0.06–0.11 ms per unit from 2,400 to 38,400 units with TF-IDF.
* bge-small encodes 30 texts/s on CPU.
* FAISS takes 1.45 ms per query over 200,000 vectors of dimension 384.

Not measured yet (they need people or a GPU):
* obligation-detection P/R/F1 and κ, from the annotation kit in [`annotation/`](annotation);
* MahaBERT, IndicBERT, XLM-R and mpnet rows, from the Colab notebook;
* flan-T5 output and its guard rate;
* Marathi template quality, from native-speaker review.

## Honesty notes

* The extractor was developed while reading the 9 gold paragraphs and the C1 numeric set. Held-out scores are B and C2.
* The Marathi descriptions come from templates written by the authors. They need native-speaker review (annotation task 3) before any claim about Marathi fluency.
* The synthetic evidence follows the regulation, but it is not real bank data. Violation rates are set by the generator.
* G04's gold parameters were revised once, after re-reading the sentence that follows the list. The change and the reason are recorded in `data/gold_rules.yaml`.
* The contrastive linker is trained on train-split pairs whose clauses are the same 9 gold clauses the test units link to. It measures adaptation to these provisions, not generalisation to unseen clauses.

See [`PAPER_GUIDE.md`](PAPER_GUIDE.md) for what to change in the paper.
