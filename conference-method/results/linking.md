# Linking: evidence description → clause (test split, 337 units)

| Encoder | Lang | Pairs | R@1 | R@3 | R@5 [95% CI] | R@10 | MRR [95% CI] |
|---|---|---:|---:|---:|---|---:|---|
| tfidf | all | 597 | 63.5 | 70.2 | 80.1 [77.0, 83.4] | 83.4 | 0.691 [0.659, 0.724] |
| tfidf | en | 422 | 82.2 | 91.7 | 94.1 [91.9, 96.2] | 98.8 | 0.876 [0.849, 0.900] |
| tfidf | mr | 175 | 18.3 | 18.3 | 46.3 [39.4, 53.7] | 46.3 | 0.245 [0.191, 0.300] |
| bge-onnx | all | 597 | 59.0 | 65.7 | 67.5 [63.7, 71.2] | 70.2 | 0.630 [0.593, 0.668] |
| bge-onnx | en | 422 | 75.8 | 85.3 | 87.7 [84.4, 90.8] | 91.2 | 0.814 [0.779, 0.847] |
| bge-onnx | mr | 175 | 18.3 | 18.3 | 18.9 [13.1, 24.6] | 19.4 | 0.185 [0.129, 0.242] |

## R@5 by evidence type

| Encoder | card_closure | complaint | cyber_incident | kyc_info_update | kyc_onboarding | kyc_periodic | small_account_year | wire_transfer |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| tfidf | 68.2 | 76.3 | 77.8 | 100.0 | 79.8 | 100.0 | 75.0 | 69.1 |
| bge-onnx | 68.2 | 28.9 | 77.8 | 100.0 | 56.5 | 73.2 | 72.9 | 70.9 |
