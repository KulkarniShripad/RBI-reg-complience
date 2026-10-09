# Monitoring without a programmatic rule (KYC para 40)

Account-months: train 8436, validation 1770, test 1794 (40 anomalous in test). Review budget 5% (threshold from unlabelled validation scores).

| Detector | P | R | F1 | ROC-AUC | AP | Unusual large | High turnover | 3rd-party cheque → cash | Benign irregular flagged | Normal flagged |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| iforest | 39.8 | 89.5 | 55.1 ± 0.8 | 0.989 | 0.735 | 93.8 | 75.4 | 100.0 | 27.5 | 0.2 |
| ocsvm | 24.5 | 67.5 | 36.0 | 0.886 | 0.256 | 100.0 | 30.8 | 63.6 | 35.0 | 1.2 |
| static_rules | 48.1 | 62.5 | 54.3 | nan | nan | 87.5 | 0.0 | 100.0 | 8.7 | 0.7 |

Static rules use thresholds fixed in advance; the detectors use no labels.

## Example REVIEW findings

- `acct_month:SB00481:2026-01` score 0.2134 (threshold 0.0766), truth: unusual_large; max_txn_to_history = 11.814 (z 16.51), max_txn_to_income = 11.643 (z 16.21), turnover_to_balance = 4.181 (z 7.24)
- `acct_month:SB00364:2025-10` score 0.206 (threshold 0.0766), truth: fd_maturity; cheque_then_cash = 0.766 (z 12.02), max_txn_to_income = 5.803 (z 10.76), turnover_to_balance = 3.459 (z 6.36)
- `acct_month:SB01070:2026-03` score 0.2032 (threshold 0.0766), truth: third_party_cash; cheque_then_cash = 0.938 (z 13.98), cash_withdrawal_share = 0.963 (z 7.29), max_txn_to_history = 2.285 (z 4.41)
- `acct_month:SB01479:2026-03` score 0.2028 (threshold 0.0766), truth: unusual_large; max_txn_to_history = 9.533 (z 14.77), max_txn_to_income = 9.626 (z 14.68), turnover_to_balance = 3.434 (z 6.32)
- `acct_month:SB00053:2026-02` score 0.1992 (threshold 0.0766), truth: third_party_cash; cheque_then_cash = 0.843 (z 12.91), cash_withdrawal_share = 0.828 (z 6.45), max_txn_to_history = 2.342 (z 4.57)
