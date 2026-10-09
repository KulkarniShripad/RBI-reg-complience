# Simplification (17 clauses with testable rules)

| Text | FKGL mean | FKGL median | Words | Guard pass | Guard issues |
|---|---:|---:|---:|---:|---|
| source | 16.4 | 14.2 | 120 |  |  |
| template | 7.4 | 8.0 | 22 |  |  |

T5 not run here (no model weights offline). Run with `--t5 google/flan-t5-base` on a machine with the Hugging Face hub; the guard then decides, per clause, whether the T5 text or the template text is shown.

Human rating sheet: annotation/simplification_sample.csv (17 clauses; the producing system is hidden, the key is in simplification_sample_key.csv).
