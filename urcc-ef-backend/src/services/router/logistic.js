/**
 * Minimal L2-regularised logistic regression (batch gradient descent), used
 * to estimate P(error | modality, features) for the adaptive router. Small,
 * dependency-free and deterministic so a trained model is reproducible and
 * can be stored as plain JSON next to the benchmark.
 */

const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/**
 * @param {number[][]} X  rows of features
 * @param {number[]} y    0/1 labels (1 = the modality got the case wrong)
 * @returns {{w:number[], b:number, train_loss:number, n:number, positive_rate:number}}
 */
function train(X, y, { epochs = 3000, lr = 0.5, l2 = 1e-3 } = {}) {
  const n = X.length;
  const d = X[0]?.length || 0;
  const w = new Array(d).fill(0);
  const pos = y.reduce((a, b) => a + b, 0) / Math.max(1, n);
  let b = Math.log((pos + 1e-3) / (1 - pos + 1e-3));
  for (let e = 0; e < epochs; e++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
    b -= lr * (gb / n);
  }
  let loss = 0;
  for (let i = 0; i < n; i++) {
    const p = predict({ w, b }, X[i]);
    loss += -(y[i] * Math.log(p + 1e-9) + (1 - y[i]) * Math.log(1 - p + 1e-9));
  }
  return { w, b, train_loss: loss / Math.max(1, n), n, positive_rate: pos };
}

function predict(model, x) {
  let z = model.b;
  for (let j = 0; j < model.w.length; j++) z += model.w[j] * x[j];
  return sigmoid(z);
}

module.exports = { train, predict, sigmoid };
