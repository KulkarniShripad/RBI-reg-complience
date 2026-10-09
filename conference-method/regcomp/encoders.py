"""Text encoders for clause/evidence linking (paper Sec. III, "semantic compliance verification").

Every encoder maps texts to L2-normalised vectors, so inner product = cosine.

  tfidf       word 1-2 gram TF-IDF fitted on the clause corpus (sparse; lexical baseline)
  bge-onnx    BAAI bge-small-en-v1.5 run through onnxruntime from a local copy
              (CLS pooling, query instruction on the evidence side); English only
  mahabert    l3cube-pune/marathi-bert-v2                 mean pooling
  indicbert   ai4bharat/IndicBERTv2-MLM-only              mean pooling
  xlmr        xlm-roberta-base                            mean pooling
  mpnet       sentence-transformers/paraphrase-multilingual-mpnet-base-v2
  hf:<name or dir>   any Hugging Face encoder, mean pooling (e.g. a fine-tuned checkpoint)
  st:<name or dir>   any sentence-transformers model (e.g. finetune_contrastive.py output)

The Hugging Face encoders need `pip install -r requirements-gpu.txt` and network
access to the Hugging Face hub (or a local copy); see README.md.
"""
from __future__ import annotations

import os

import numpy as np

ALIASES = {
    "mahabert": ("hf", "l3cube-pune/marathi-bert-v2"),
    "indicbert": ("hf", "ai4bharat/IndicBERTv2-MLM-only"),
    "xlmr": ("hf", "xlm-roberta-base"),
    "mpnet": ("st", "sentence-transformers/paraphrase-multilingual-mpnet-base-v2"),
}
BGE_QUERY = "Represent this sentence for searching relevant passages: "


def _l2(x: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(x, axis=1, keepdims=True)
    return (x / np.maximum(n, 1e-12)).astype(np.float32)


class Encoder:
    name = "base"
    sparse = False

    def fit(self, docs: list[str]) -> "Encoder":
        return self

    def encode_docs(self, texts: list[str]):
        raise NotImplementedError

    def encode_queries(self, texts: list[str]):
        return self.encode_docs(texts)


class TfidfEncoder(Encoder):
    name = "tfidf"
    sparse = True

    def __init__(self, **kw):
        from sklearn.feature_extraction.text import TfidfVectorizer
        self.vec = TfidfVectorizer(ngram_range=(1, 2), min_df=1, sublinear_tf=True, lowercase=True,
                                   token_pattern=r"(?u)\b\w[\w/-]*\b", **kw)

    def fit(self, docs):
        self.vec.fit(docs)
        return self

    def encode_docs(self, texts):
        return self.vec.transform(texts)        # rows are already L2-normalised


class OnnxBgeEncoder(Encoder):
    """bge-small-en-v1.5 from a local directory holding tokenizer.json and onnx/model.onnx."""

    def __init__(self, path: str, max_len: int = 512, batch: int = 32, threads: int | None = None):
        import onnxruntime as ort
        from tokenizers import Tokenizer
        self.name = "bge-onnx"
        self.tok = Tokenizer.from_file(os.path.join(path, "tokenizer.json"))
        self.tok.enable_truncation(max_len)
        self.tok.enable_padding(pad_id=0, pad_token="[PAD]")
        so = ort.SessionOptions()
        if threads:
            so.intra_op_num_threads = threads
        self.sess = ort.InferenceSession(os.path.join(path, "onnx", "model.onnx"), so, providers=["CPUExecutionProvider"])
        self.inputs = {i.name for i in self.sess.get_inputs()}
        self.batch = batch

    def _run(self, texts):
        out = []
        order = np.argsort([len(t) for t in texts])        # length-sorted batches: less padding
        for i in range(0, len(texts), self.batch):
            idx = order[i:i + self.batch]
            enc = self.tok.encode_batch([texts[j] for j in idx])
            ids = np.array([e.ids for e in enc], dtype=np.int64)
            mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
            feed = {"input_ids": ids, "attention_mask": mask}
            if "token_type_ids" in self.inputs:
                feed["token_type_ids"] = np.zeros_like(ids)
            h = self.sess.run(None, feed)[0]
            out.append((idx, h[:, 0, :]))                    # CLS pooling (as trained)
        vec = np.zeros((len(texts), out[0][1].shape[1]), dtype=np.float32) if out else np.zeros((0, 384), np.float32)
        for idx, v in out:
            vec[idx] = v
        return _l2(vec)

    def encode_docs(self, texts):
        return self._run(texts)

    def encode_queries(self, texts):
        return self._run([BGE_QUERY + t for t in texts])


class HFEncoder(Encoder):
    """Mean-pooled hidden states of a Hugging Face encoder (MahaBERT, IndicBERT, XLM-R, fine-tuned dirs)."""

    def __init__(self, model: str, max_len: int = 256, batch: int = 32, device: str | None = None):
        import torch
        from transformers import AutoModel, AutoTokenizer
        self.torch = torch
        self.name = model.rstrip("/").split("/")[-1]
        self.tok = AutoTokenizer.from_pretrained(model)
        self.model = AutoModel.from_pretrained(model)
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.model.to(self.device).eval()
        self.max_len, self.batch = max_len, batch

    def encode_docs(self, texts):
        torch = self.torch
        out = np.zeros((len(texts), self.model.config.hidden_size), dtype=np.float32)
        order = np.argsort([len(t) for t in texts])
        with torch.no_grad():
            for i in range(0, len(texts), self.batch):
                idx = order[i:i + self.batch]
                enc = self.tok([texts[j] for j in idx], padding=True, truncation=True, max_length=self.max_len,
                               return_tensors="pt").to(self.device)
                h = self.model(**enc).last_hidden_state
                m = enc["attention_mask"].unsqueeze(-1).float()
                out[idx] = ((h * m).sum(1) / m.sum(1).clamp(min=1e-9)).cpu().numpy()
        return _l2(out)


class STEncoder(Encoder):
    def __init__(self, model: str, batch: int = 32, device: str | None = None):
        from sentence_transformers import SentenceTransformer
        self.name = model.rstrip("/").split("/")[-1]
        self.model = SentenceTransformer(model, device=device)
        self.batch = batch

    def encode_docs(self, texts):
        return _l2(np.asarray(self.model.encode(texts, batch_size=self.batch, show_progress_bar=False, convert_to_numpy=True)))


def default_bge_path() -> str:
    return os.environ.get("BGE_ONNX_DIR", os.path.join(os.path.dirname(__file__), "..", "models", "bge-small-en-v1.5"))


def get_encoder(spec: str, **kw) -> Encoder:
    if spec == "tfidf":
        return TfidfEncoder()
    if spec == "bge-onnx" or spec.startswith("bge-onnx:"):
        path = spec.split(":", 1)[1] if ":" in spec else default_bge_path()
        return OnnxBgeEncoder(path, **kw)
    if spec in ALIASES:
        kind, name = ALIASES[spec]
        enc = HFEncoder(name, **kw) if kind == "hf" else STEncoder(name, **kw)
        enc.name = spec
        return enc
    if spec.startswith("hf:"):
        return HFEncoder(spec[3:], **kw)
    if spec.startswith("st:"):
        return STEncoder(spec[3:], **kw)
    raise ValueError(f"unknown encoder {spec!r}")
