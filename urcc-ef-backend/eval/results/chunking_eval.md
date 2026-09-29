# Structure-aware vs generic chunking (RQ2)

C3 = fixed 800-character windows with 200-character overlap over each document (33907 windows), same embedding model (BGE-small). A passage is relevant only if it contains the whole provision.

## Questions: hand-written (n = 36)

| Retrieval | Hit@1 | Hit@3 | Top-5 recall | MRR@10 |
|---|---|---|---|---|
| Structure-aware: keyword (C1) | 61.1% | 80.6% | 83.3% | 0.721 |
| Structure-aware: semantic | 61.1% | 66.7% | 80.6% | 0.675 |
| Structure-aware: hybrid (proposed) | 72.2% | 77.8% | 83.3% | 0.768 |
| Fixed windows: BM25 (C3) | 36.1% | 52.8% | 61.1% | 0.465 |
| Fixed windows: semantic (C3) | 55.6% | 69.4% | 72.2% | 0.635 |
| Fixed windows: hybrid RRF (C3) | 50.0% | 72.2% | 75.0% | 0.607 |

## Questions: generated from gold rules (n = 79)

| Retrieval | Hit@1 | Hit@3 | Top-5 recall | MRR@10 |
|---|---|---|---|---|
| Structure-aware: keyword (C1) | 46.8% | 69.6% | 75.9% | 0.593 |
| Structure-aware: semantic | 40.5% | 62.0% | 73.4% | 0.539 |
| Structure-aware: hybrid (proposed) | 53.2% | 70.9% | 81.0% | 0.635 |
| Fixed windows: BM25 (C3) | 20.3% | 40.5% | 48.1% | 0.316 |
| Fixed windows: semantic (C3) | 16.5% | 26.6% | 35.4% | 0.246 |
| Fixed windows: hybrid RRF (C3) | 19.0% | 39.2% | 44.3% | 0.309 |
