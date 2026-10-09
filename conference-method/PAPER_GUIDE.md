# Paper guide: what the code now backs, and what to change in the text

This guide covers the paper *"A Robust Framework for Banking Regulatory Compliance Verification"* (Conf_2).

Every result in the paper must come from a file in `results/`. If a number has no script behind it,
it does not go in the paper. Status labels used below:
* ✅ implemented and measured here
* 🟡 implemented; it runs with the GPU notebook or after annotation
* ✏️ the text must change

## 1. Claims, section by section

| Paper text | Status | Evidence / what to write |
|---|---|---|
| "RBI circular PDFs are parsed using PyPDF2" | ✏️ ✅ | Write **pypdf** (PyPDF2 is its deprecated predecessor). Code: `regcomp/ingest.py`. |
| "removal of headers, footers, and boilerplate" | ✅ | Page numbers, contents lines and running headers repeated on ≥ 40% of pages are removed; split words are repaired (23,702 repairs). |
| "Unicode normalization is applied to Devanagari text, sentences segmented using language-specific rules" | ✏️ | The directions are English. Their Hindi (Devanagari) pages are detected and dropped. Write: "NFKC normalisation; Devanagari and garbled lines are separated from the English text; abbreviation-aware sentence segmentation". Marathi appears on the **evidence** side (descriptions), not in the clauses. |
| "clauses are assigned unique identifiers linking them to their parent document and section" | ✅ | `doc_id:paragraph` ids with section path and pages. |
| "rule-based extractor ... obligation keywords combined with clause numbering" | ✅ | `regcomp/obligations.py`. It also requires a testable cue and excludes definition and scope clauses. |
| "convert abstract obligations into testable logical conditions" | ✅ | `regcomp/rules.py`: threshold, temporal, cardinality and set rules, with scope conditions, exceptions, grace periods, working days and remediation. |
| "A T5 sequence-to-sequence model then produces a simplified version" | 🟡 ✏️ | `regcomp/simplify.py`. flan-T5 with a guard: any lost number, negation, exception or modal makes it fall back to a deterministic rendering of the extracted rule. Report the guard pass rate from `results/simplification_gpu.md`. Until then, report only the template: Flesch–Kincaid grade 16.4 → 7.4 over 17 clauses. |
| "standardized into a unified schema and converted into natural-language descriptions" | ✅ | `regcomp/records.py`, 9 evidence types, English and Marathi templates. Replace the invented example ("Customer 12345 transferred Rs. 500,000 ...") with one from `work/synth/units.jsonl`. |
| "embedded using MahaBERT, IndicBERT, XLM-RoBERTa, mean pooling, unit-length normalisation, FAISS" | 🟡 | `regcomp/encoders.py`, `regcomp/index.py`. Numbers come from `results/linking_gpu.md` and `results/verification_gpu.md` (Colab). Here: TF-IDF and bge-small. |
| "threshold tuned between 0.72–0.85" | ✏️ | τ is chosen on the validation split per encoder. With top-5 linking it is **0** for both TF-IDF and bge-small, because the validators set the precision. bge-small's F1 falls from 81 to 5 across τ = 0.68–0.82 (`results/figures/fig_threshold_sweep.svg`). Write the τ the GPU run selects. |
| "threshold / temporal / cardinality / set validators" | ✅ | `regcomp/validators.py`; agreement with an independent labeller is tested in `tests/test_validators.py`. |
| "One-Class SVM and Isolation Forest detect statistical outliers **in embedding space**" | ✏️ ✅ | They run on **behavioural features of account-months** (turnover against balance, largest transaction against history, cheque-then-cash), for KYC para 40, which has no numeric condition. Isolation Forest: F1 55.1, ROC-AUC 0.989. One-Class SVM: F1 36.0. Static rules: F1 54.3. |
| "report ... with severity, risk scores, remediation suggestions, complete audit trail" | ✏️ ✅ | Findings carry the quote, direction, paragraph, pages, parameters, validator, outcome, how far the limit is exceeded (percentage over, days or hours late, shortfall, missing items), remediation where the clause states one (₹500/day), similarity, rank, τ, encoder, version and timestamp. There is no "risk score": write "exceedance" instead of "severity / risk scores". |
| Validator example "NEFT transactions above Rs. 200,000 must be reported within 24 hours" | ✏️ | This rule is not in the corpus. Use real ones, e.g. card closure within 7 working days with ₹500/day (Credit Cards Directions para 19), or the small-account balance of ₹50,000 excluding Government grants (KYC para 28). |
| "45 RBI circulars (Jan 2020–Dec 2025) ... 82 unique clauses" | ✏️ | 266 directions → 19,418 clauses → 4,018 operational. Commercial-bank scope: 43 directions, 780 operational clauses, 529 rules. Gold: 14 rules (9 paragraphs, 4 directions); 86 parallel clauses; 62 numeric limits. |
| "reviewed by two banking-compliance experts ... κ = 0.84" | 🟡 ✏️ | Remove this until the annotation is done (`annotation/`). Then report the κ that `annotation/kappa.py` prints, and describe the annotators truthfully. |
| "1,500 transactions, 300 KYC logs, 200 audit trails; 15% / 12% / 8% / 5% injected; 1,050/225/225" | ✏️ | 2,400 evidence units of 9 types, built from raw transaction, KYC and audit logs. 3,705 unit–rule checks, 1,072 violated (28.9%). 30% Marathi descriptions. Split 1,661 / 350 / 389. Labels come from an independent labeller. |
| Baselines: TF-IDF + LR / SVM (C = 1) / RF (100 trees, depth 10) | ✅ | Same settings in `experiments/eval_verification.py` (semantic-only) and `eval_obligations.py`. |
| Transformers fine-tuned 5 epochs at 2e-5; contrastive 3 epochs at 1e-5; bs 16; AdamW; warm-up 10% | 🟡 | `experiments/finetune_classifier.py`, `finetune_contrastive.py` (Colab). |
| Task 1 metrics "P / R / F1 / accuracy on a stratified 20% held-out set" | 🟡 ✏️ | Obligation detection is measured against adjudicated labels: `eval_obligations.py`, re-weighted by stratum. Rule extraction is exact-match on sets A, B, C1 and C2 (`results/extraction.md`). |
| Fig. 2: "precision 0.833, recall 1.000, F1 0.909, accuracy 0.958 vs naive 0.500/0.667/0.571/0.667" | ✏️ | Replace with `results/obligations.md` (after annotation; the keyword-only row is the naive baseline) and `results/extraction.md`. |
| Fig. 3: confusion matrices "5/24 ... 22 test transactions" | ✏️ | Use the confusion table in `results/verification.md`: 597 test checks; the hybrid with TF-IDF gives TP 126, FP 0, FN 28, TN 443. |
| "overall F1-score of 0.86" | ✏️ | Hybrid with TF-IDF: pair-level F1 **89.7** [85.3, 93.5] (English 97.2, Marathi 64.6). Replace this with the best GPU encoder's value once measured, and report **all** rows (oracle, rule-only, semantic-only). |
| Scalability "0.050 s at 10 ... 0.328 s at 10,000 records ... 30,000 transactions/second" | ✏️ | From `results/scalability.md` (4-core Xeon, no GPU): with TF-IDF, link and validate take 0.06–0.11 ms per unit up to 38,400 units; rule-only takes 0.38 ms and 529 rule evaluations per unit. bge-small encodes 30 texts/s on CPU, so transformer encoding dominates: report the GPU throughput from Colab. FAISS: 1.45 ms per query over 200k vectors. |
| Fig. 5: explainability percentages (0%, 40%, 50%, 80%, 100%) | ✏️ | Those percentages were not measured. Replace the figure with a qualitative table: rows are system types, columns are "cites source clause / deterministic / parameters inspectable / reproducible run record", with yes/no answers and a one-line reason each. Our row must state what the code does: every finding has a quote and a run record, and the validators are deterministic. Linking is deterministic for a fixed encoder. |
| Table I (comparison with literature F1) | ✏️ | The numbers come from different tasks and datasets and must not be compared directly. Also, [5] reports **98.2%** F1 on simulated data, not 0.82. Either drop the F1 column or label it "reported by the authors on their own data, not comparable". Keep the qualitative columns. |
| "advances the state of the art", "generalizing across banking institutions" | ✏️ | Not shown. Write what is shown: on 86 parallel provisions from 9 other institution categories, extraction was exact. |
| Limitations | ✏️ | Add: synthetic evidence; Marathi descriptions from author-written templates; extractor developed on the gold paragraphs; held-out numeric recall 55.6%; linking recall is the main error source; rule-only is a strong baseline when evidence is typed. |

## 2. New numbers for the abstract (CPU run; replace with GPU numbers where better)

> ... evaluated on 266 RBI directions and 2,400 synthetic evidence records (30% described in Marathi).
> Rule extraction reproduced all 14 hand-written gold rules and all 86 parallel provisions in other
> institution categories, and recovered 55.6% of 36 never-inspected numeric limits. With lexical
> linking, the hybrid verifier reached a pair-level F1 of 89.7% (precision 99.2%), against 55.6% for
> the best supervised text-only classifier; with oracle linking it was exact. Linking plus validation
> took under 0.11 ms per record up to 38,400 records on a 4-core CPU.

## 3. Figures

The SVGs in `results/figures/` are drawn by `experiments/make_figures.py` from the result JSON files:

| Figure | Replaces |
|---|---|
| `fig_verification.svg` | the single F1 claim: all systems, English and Marathi, 95% CI |
| `fig_threshold_sweep.svg` | "threshold tuned between 0.72–0.85" |
| `fig_linking_recall.svg` | (new) Recall@k per encoder and language |
| `fig_scalability.svg` | Fig. 4 |
| `fig_anomaly.svg` | (new) per-pattern detection and false alarms |

The confusion tables in `results/verification.md` replace Fig. 3. A qualitative table replaces Fig. 5.

## 4. References

The checks below were made with a web search on 9 October 2026. Re-check every entry on Google Scholar
or with its DOI before submission.

| Ref | Finding | Action |
|---|---|---|
| [1] Singh & Gupta, ICIS 2020 | not found | remove or replace |
| [2] Zhang, Li, Wang, IEEE Access 9 | not checked; the page range 45678–45692 looks invented | verify by DOI or remove |
| [3] Patel et al., ACM TIST 13(2) | not found | remove or replace |
| [4] Berger et al., IEEE BigData 2023, pp. 4626–4635 | **correct** ([IEEE Xplore](https://ieeexplore.ieee.org/document/10386518), [arXiv:2507.16642](https://arxiv.org/abs/2507.16642v1)) | keep; check the IFRS/HGB F1 values quoted in Table I against its tables |
| [5] Khanvilkar & Kommuru | exists as **arXiv:2506.01093** (2025), "Regulatory Graphs and GenAI for Real-Time Transaction Monitoring and Compliance Explanation in Banking" ([arXiv](https://arxiv.org/abs/2506.01093v1)); not a BigData 2025 paper; reports 98.2% F1 | fix the citation and the Table I value |
| [6] Kakani, Sinha, Reddy, IEEE TCSS | not found | remove |
| [7] LEGAL-BERT, Findings of EMNLP 2020 | well known | keep |
| [8] "CaseLaw-BERT", SIGIR 2021 | wrong; the real work is Zheng, Guha, Anderson, Henderson, Ho, "When Does Pretraining Help? ... CaseHOLD", ICAIL 2021 ([arXiv:2104.08671](https://arxiv.org/pdf/2104.08671)) | replace |
| [9] Araci, FinBERT, arXiv:1908.10063; [10] Huang, Wang, Yang, CAR; [11] BloombergGPT | well known | keep (check the year of [10]) |
| [12] Kothandapani, AAAI 2025 | not found | remove; a real alternative is "De Jure: Iterative LLM Self-Refinement for Structured Extraction of Regulatory Rules" ([arXiv:2604.02276](https://arxiv.org/pdf/2604.02276)) |
| [13] Yue et al., arXiv:2305.16344; [14] Sifa et al., DocEng 2019; [15] Ramamurthy et al., ALiBERT, DocEng 2021 | believed correct | verify |
| [16] Mirishli, CLSR vol. 51 | the work found is **Shahmar Mirishli**, "Regulating AI in Financial Services: Legal Frameworks and Compliance Challenges", [arXiv:2503.14541](https://arxiv.org/abs/2503.14541) (2025) | fix the citation |
| [17] EU AI Act proposal COM(2021) 206 | correct | keep (or cite the adopted Regulation (EU) 2024/1689) |
| [18] Rane, Mehta, Desai, IEEE Intelligent Systems | not found | remove |
| [19] "Turksen, Brown, White" | wrong authors and title; the real work is **U. Turksen, V. Benson, B. Adamyk**, "Legal implications of automated suspicious transaction monitoring: enhancing integrity of AI", *J. Banking Regulation* 25(4):359–377, 2024, doi:10.1057/s41261-024-00233-2 ([Aston](https://publications.aston.ac.uk/id/eprint/45938)) | fix |
| [20] Leippold, Finance Research Letters 2023 | well known | keep |
| [21] Kumar et al., ESWA 186:115741 | not found | remove |

Also consider citing the tools you use: pypdf, FAISS (Johnson et al., 2019), scikit-learn,
Sentence-BERT (Reimers & Gurevych, 2019), MahaBERT (Joshi, 2022), IndicBERT v2 (Doddapaneni et al., 2023),
XLM-R (Conneau et al., 2020), Isolation Forest (Liu et al., 2008), One-Class SVM (Schölkopf et al., 2001), T5 / Flan-T5.

## 5. Do not claim

* any κ, expert review or human rating before the annotation is done;
* MahaBERT, IndicBERT, XLM-R or mpnet numbers before the Colab run;
* that the system "never misses obligations" (perfect recall): measured linking recall is 81.8% with TF-IDF;
* 100% explainability or audit-readiness as a percentage;
* real bank data: all evidence is synthetic;
* that the anomaly detectors find violations: they raise REVIEW flags for a person to look at.
