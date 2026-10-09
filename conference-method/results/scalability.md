# Scalability (Intel(R) Xeon(R) Processor @ 2.10GHz, 4 CPUs, 15.7 GB RAM, GPU: none)

Ingestion: 20 PDFs, 1016 pages in 19.2s (53.0 pages/s).

Obligation detection: 4547 clauses/s over 19418 clauses; rule extraction: 664 operational clauses/s (4018 clauses → 2767 rules).

| Encoder | Texts/s |
|---|---:|
| tfidf | 4298.1 |
| bge-onnx | 30.6 |

| Vectors | dim 384: ms/query | dim 768: ms/query |
|---:|---:|---:|
| 1,000 | 0.013 | 0.012 |
| 10,000 | 0.069 | 0.145 |
| 50,000 | 0.340 | 0.669 |
| 200,000 | 1.318 | 2.517 |

| Units | Link ms/unit | Validate ms/unit | Validator calls/unit | Rule-only ms/unit | Rule-only calls/unit |
|---:|---:|---:|---:|---:|---:|
| 2,400 | 0.05 | 0.017 | 8.1 | 0.365 | 529 |
| 9,600 | 0.04 | 0.029 | 8.2 | 0.382 | 529 |
| 38,400 | 0.08 | 0.026 | 8.1 | nan | nan |
