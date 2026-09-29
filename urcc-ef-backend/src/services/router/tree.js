/**
 * Small binary decision tree (entropy splits, Laplace-smoothed leaf rates) as
 * an alternative estimator of P(error | modality, features). Unlike the
 * logistic model it captures interactions such as "the LLM path is better for
 * Boolean requirements, but the rule engine for numeric ones with complete
 * structured evidence". The evaluation picks the estimator per modality by
 * validation log-loss. Deterministic and stored as plain JSON.
 */

const entropy = (p) => (p <= 0 || p >= 1 ? 0 : -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p)));

function build(X, y, idx, depth, opts) {
  const n = idx.length;
  const pos = idx.reduce((a, i) => a + y[i], 0);
  const leaf = { leaf: true, n, pos, p: (pos + 1) / (n + 2) };
  if (depth >= opts.maxDepth || n < 2 * opts.minLeaf || pos === 0 || pos === n) return leaf;
  const base = entropy(pos / n);
  let best = null;
  const d = X[0].length;
  for (let j = 0; j < d; j++) {
    const vals = [...new Set(idx.map((i) => X[i][j]))].sort((a, b) => a - b);
    if (vals.length < 2) continue;
    // candidate thresholds: midpoints, at most 16 per feature
    const step = Math.max(1, Math.floor(vals.length / 16));
    for (let k = 0; k + 1 < vals.length; k += step) {
      const t = (vals[k] + vals[k + 1]) / 2;
      let ln = 0;
      let lp = 0;
      for (const i of idx) {
        if (X[i][j] <= t) {
          ln++;
          lp += y[i];
        }
      }
      const rn = n - ln;
      if (ln < opts.minLeaf || rn < opts.minLeaf) continue;
      const rp = pos - lp;
      const gain = base - (ln / n) * entropy(lp / ln) - (rn / n) * entropy(rp / rn);
      if (!best || gain > best.gain) best = { j, t, gain };
    }
  }
  if (!best || best.gain < opts.minGain) return leaf;
  const L = idx.filter((i) => X[i][best.j] <= best.t);
  const Rr = idx.filter((i) => X[i][best.j] > best.t);
  return { leaf: false, j: best.j, t: best.t, n, left: build(X, y, L, depth + 1, opts), right: build(X, y, Rr, depth + 1, opts) };
}

function train(X, y, { maxDepth = 5, minLeaf = 15, minGain = 0.005 } = {}) {
  return { kind: "tree", root: build(X, y, X.map((_, i) => i), 0, { maxDepth, minLeaf, minGain }) };
}

function predict(model, x) {
  let node = model.root;
  while (!node.leaf) node = x[node.j] <= node.t ? node.left : node.right;
  return node.p;
}

/** Human-readable rules of the tree (for the paper / audit). */
function describe(model, names, node = model.root, prefix = "") {
  if (node.leaf) return [`${prefix || "(all)"} → P(error) = ${node.p.toFixed(3)} (n = ${node.n})`];
  return [
    ...describe(model, names, node.left, `${prefix}${prefix ? " & " : ""}${names[node.j]} ≤ ${node.t.toFixed(3)}`),
    ...describe(model, names, node.right, `${prefix}${prefix ? " & " : ""}${names[node.j]} > ${node.t.toFixed(3)}`),
  ];
}

module.exports = { train, predict, describe };
