# Rule extraction

| Test set | Rules | Exact match | 95% CI (Wilson) | Clause detected as operational |
|---|---:|---:|---|---:|
| A. Development (gold, 9 clauses) | 14 | 100.0% | [78.5, 100.0] | 100.0% |
| B. Parallel held-out (other categories) | 86 | 100.0% | [95.7, 100.0] | 100.0% |
| C1. Numeric, figure requirements (used for error analysis) | 24 of 26 located | 100.0% (value 100.0%) | [86.2, 100.0] | 100.0% |
| C2. Numeric, network limits (held-out: never inspected) | 36 of 36 located | 55.6% (value 55.6%) | [39.6, 70.5] | 94.4% |

Main system's extractor on set C (its own segmentation): exact 85.5%, value 85.5% of 62.

## Parameter agreement (development set A)

| Parameter | Agreement |
|---|---:|
| aggregate | 100.0% |
| anchor | 100.0% |
| conditions | 100.0% |
| exceptions | 100.0% |
| field | 100.0% |
| grace | 100.0% |
| op | 100.0% |
| per_category | 100.0% |
| period | 100.0% |
| remediation | 100.0% |
| required | 100.0% |
| sub | 100.0% |
| target | 100.0% |
| unit | 100.0% |
| value | 100.0% |
| when | 100.0% |
| window | 100.0% |

Rules extracted from the 9 gold clauses: 20; matching a gold rule: 14; others: 6 (an upper bound on spurious rules: some state real obligations the gold set does not cover).

## Parallel set B by institution category

| Category | Exact / clauses |
|---|---:|
| All_India_Financial_Institutions | 5 / 5 |
| Asset_Reconstruction_Companies | 4 / 4 |
| NBFC | 7 / 7 |
| Regional_Rural_Bank | 11 / 11 |
| Rural_Cooperative_Bank | 9 / 9 |
| Urban_Cooperative_Bank | 13 / 13 |
| cross-sector | 2 / 2 |
| local area banks | 11 / 11 |
| payment banks | 11 / 11 |
| small financial banks | 13 / 13 |
