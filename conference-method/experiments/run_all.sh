#!/usr/bin/env bash
# Rebuild the data and re-run every experiment that runs on a CPU without network access.
#   ENCODERS=tfidf,bge-onnx  (add mahabert,indicbert,xlmr,mpnet on a machine with the Hugging Face hub)
#   BGE_ONNX_DIR=models/bge-small-en-v1.5 (tokenizer.json + onnx/model.onnx)
set -euo pipefail
cd "$(dirname "$0")/.."
export PYTHONPATH="$PWD${PYTHONPATH:+:$PYTHONPATH}"
W="${REGCOMP_WORK:-work}"
ENC="${ENCODERS:-tfidf,bge-onnx}"
[ -f "$W/corpus/clauses.jsonl" ] || python -m regcomp.ingest --pdfs "${REGCOMP_PDFS:-../circulars}" --out "$W/corpus"
[ -f "$W/synth/units.jsonl" ]    || python -m synth.generate --out "$W/synth" --seed 7
[ -f "$W/anomaly/labels.jsonl" ] || python -m synth.anomaly --out "$W/anomaly"
python experiments/eval_extraction.py
python experiments/eval_linking.py --encoders "$ENC"
python experiments/eval_verification.py --encoders "$ENC"
python experiments/eval_anomaly.py
python experiments/eval_simplification.py
python experiments/bench_scalability.py --encoders "$ENC"
[ -f annotation/obligation_gold.csv ] && python experiments/eval_obligations.py || echo "obligation labels not adjudicated yet: skipping eval_obligations.py"
python -m pytest -q tests
