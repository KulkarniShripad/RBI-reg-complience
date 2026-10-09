"""RegComp: hybrid semantic-symbolic verification of RBI regulatory compliance.

Pipeline (paper Sec. III):
  ingest      regulatory PDFs -> cleaned, identified clauses           (ingest.py)
  obligations clause -> operational obligation or not                   (obligations.py)
  rules       operational clause -> machine-testable rule parameters    (rules.py)
  simplify    clause -> plain-language restatement (T5, guarded)        (simplify.py)
  records     operational logs -> evidence units + NL descriptions      (records.py)
  link        evidence unit -> top-k clauses by cosine similarity       (encoders.py, index.py)
  validate    linked (unit, rule) -> threshold / temporal / cardinality / set check
  anomaly     units with no programmatic rule -> review flags           (anomaly.py)
  report      violations with source, parameters and audit trail        (pipeline.py)
"""

__version__ = "0.1.0"
