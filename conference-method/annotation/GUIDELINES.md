# Annotation guidelines

Four small annotation tasks back the paper's human-judged numbers. Each task is done
**independently by two annotators** (A and B). Annotators must not see the system's output
or each other's labels. Agreement (Cohen's κ, or weighted κ for ratings) is computed
before adjudication; a third person adjudicates the disagreements. Report κ, the number
of items and the annotators' background (e.g. "two final-year students trained with these
guidelines" or "a compliance officer with N years at a commercial bank"). Do not describe
annotators as experts unless they are.

Create the sheets with

```
python annotation/make_sheets.py          # writes the *_A.csv / *_B.csv sheets and hidden keys
```

and after both annotators finish:

```
python annotation/kappa.py                # κ per task, writes *_adjudicate.csv with the disagreements
# the adjudicator fills the "final" column of each *_adjudicate.csv, then:
python annotation/kappa.py --finalise     # writes obligation_gold.csv, rules_gold.csv, ...
python experiments/eval_obligations.py    # detector and baselines against the adjudicated labels
```

---

## Task 1 — Obligation detection (`obligation_A.csv`, `obligation_B.csv`)

One row per clause (a numbered paragraph of an RBI direction). Label each clause:

| Label | Use when |
|---|---|
| `OPERATIONAL` | The clause **imposes a duty on the regulated entity** that could be checked against the entity's own records: a limit, a deadline, a frequency, a required document or field, a reporting duty, a prohibition. |
| `NON_OPERATIONAL` | Definitions, scope and applicability, commencement, repeal, statements of purpose, powers of the RBI, procedural text addressed to the RBI, explanations, illustrations, cross-reference-only text, a purely permissive "may". |
| `UNSURE` | Only if the clause genuinely cannot be decided. Say why in `notes`. |

Decide on the clause as written. Do not use knowledge of other paragraphs. A clause that mixes
a definition with a testable duty is `OPERATIONAL`.

Examples (from the corpus):

* *"The bank shall upload onto CKYCR within 10 days of commencement of an account-based
  relationship ..."* → `OPERATIONAL` (deadline on the bank's own records).
* *"'Small Account' means a savings account opened in terms of ..."* → `NON_OPERATIONAL` (definition).
* *"These Directions shall come into force with immediate effect."* → `NON_OPERATIONAL`.
* *"The bank may consider adopting appropriate innovations including AI and ML ..."* → `NON_OPERATIONAL` (permission).
* *"Any request for closure of a credit card shall be honoured within seven working days ..."* → `OPERATIONAL`.

## Task 2 — Extracted rule parameters (`rules_A.csv`, `rules_B.csv`)

One row per rule the system extracted, with its source sentence. For each listed parameter
(`kind`, `field`, `op`, `value`, `period`, `anchor`, `target`, `window`, `unit`, `required`,
`conditions`, `exceptions`), mark `1` if it is a correct reading of the sentence, `0` if it is
wrong, blank if the parameter is not applicable. In `whole_rule_correct` mark `1` only if a
validator using these parameters would reach the same verdict as a careful human reading
of the sentence. Use `notes` to say what is wrong.

## Task 3 — Marathi evidence descriptions (`marathi_A.csv`, `marathi_B.csv`)

Native Marathi speakers only. Each row shows an English description of a record and the
Marathi description generated from the same record. Rate:

* `adequacy_1to5`: does the Marathi text state the same facts (amounts, dates, counts, events)?
  5 = all facts, 1 = misleading.
* `fluency_1to5`: is it natural Marathi a bank officer would write? 5 = natural, 1 = unreadable.
* Write corrections in `corrected_text`; they will be used to fix the templates in
  `regcomp/records.py`.

## Task 4 — Simplified clauses (`simplification_sample.csv`, made by `experiments/eval_simplification.py`)

Each row shows the source sentence(s) and a simplified text (the producing system is hidden).
Rate:

* `faithful_1to5`: 5 = every obligation, number, deadline, condition and exception is kept;
  1 = the meaning changed. Any changed number or dropped exception is at most 2.
* `clear_1to5`: how quickly a bank officer would understand what to do.

---

## What not to do

* Do not copy the system's labels into the sheets, and do not show them to annotators.
* Do not adjudicate your own disagreements.
* Do not drop items that were hard; label them `UNSURE` and report how many there were.
