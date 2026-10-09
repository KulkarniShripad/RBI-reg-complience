"""Contrastive fine-tuning of an encoder on (evidence description, governing clause) pairs.

Pairs come from the train split only: every unit with an applicable gold rule is paired with
that rule's clause text (English and Marathi descriptions alike). Loss: multiple negatives
ranking (in-batch negatives, no duplicate clauses inside a batch). Protocol (paper Sec. IV-B):
3 epochs, learning rate 1e-5, batch size 16, AdamW, linear warm-up over 10% of steps.
The model is saved to work/models/contrastive-<base>; evaluate it with
  python experiments/eval_linking.py --encoders st:work/models/contrastive-mpnet --tag ft
  python experiments/eval_verification.py --encoders st:work/models/contrastive-mpnet --tag ft

Needs requirements-gpu.txt (sentence-transformers, torch).

python experiments/finetune_contrastive.py --base mpnet
"""
from __future__ import annotations

import argparse
import os

from common import CORPUS, SYNTH, WORK, need

from regcomp.encoders import ALIASES
from regcomp.pipeline import Pipeline
from regcomp.records import read_units


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="mpnet", help="mpnet | mahabert | indicbert | xlmr | any HF / ST name")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--lr", type=float, default=1e-5)
    ap.add_argument("--batch", type=int, default=16)
    a = ap.parse_args()
    need(os.path.join(SYNTH, "units.jsonl"), "python -m synth.generate --out work/synth")
    from sentence_transformers import InputExample, SentenceTransformer, losses, models
    from sentence_transformers.datasets import NoDuplicatesDataLoader

    p = Pipeline(CORPUS, log=print)
    clause_text = {cid: p.clause_text(p.by_id[cid]) for cid in set(p.gold_clause.values()) if cid in p.by_id}
    units = [u for u in read_units(os.path.join(SYNTH, "units.jsonl")) if u.split == "train"]
    pairs = [InputExample(texts=[u.text, clause_text[p.gold_clause[g]]]) for u in units for g in u.truth if p.gold_clause[g] in clause_text]
    print(f"{len(pairs)} training pairs from {len(units)} train units")

    kind, name = ALIASES.get(a.base, ("st" if "sentence-transformers" in a.base else "hf", a.base))
    if kind == "st":
        model = SentenceTransformer(name)
    else:   # plain encoder: mean pooling on top, as in the paper
        word = models.Transformer(name, max_seq_length=256)
        model = SentenceTransformer(modules=[word, models.Pooling(word.get_word_embedding_dimension(), pooling_mode="mean")])
    loader = NoDuplicatesDataLoader(pairs, batch_size=a.batch)
    loss = losses.MultipleNegativesRankingLoss(model)
    steps = a.epochs * len(loader)
    model.fit(train_objectives=[(loader, loss)], epochs=a.epochs, warmup_steps=int(0.1 * steps),
              optimizer_params={"lr": a.lr}, show_progress_bar=True)
    out = os.path.join(WORK, "models", f"contrastive-{a.base.split('/')[-1]}")
    model.save(out)
    print(f"saved {out}")


if __name__ == "__main__":
    main()
