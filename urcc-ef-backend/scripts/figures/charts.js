/**
 * Evaluation figures (grayscale, print-safe) drawn from eval/results/*.json.
 * Static figures for a paper: identity is carried by shade + texture +
 * marker shape, never by colour alone, and every chart has a legend or
 * direct labels.
 */
const fs = require("fs");
const path = require("path");
const S = require("./svg");

const { doc, text, line, hbar, vbar, legend, SERIES_FILL, MARKERS, INK, MUTED, GRID, GRAY, textWidth } = S;
const RES = path.join(__dirname, "..", "..", "eval", "results");
const load = (f) => JSON.parse(fs.readFileSync(path.join(RES, f), "utf8"));
const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;
const fmtInt = (n) => n.toLocaleString("en-US");

const TYPE_LABEL = { A: "A  Quantitative", B: "B  Boolean / procedural", C: "C  Conditional", D: "D  Temporal", E: "E  Qualitative", F: "F  Relational", G: "G  Multi-entity" };
const CASE_LABEL = { compliant: "Compliant", non_compliant: "Non-compliant", boundary: "Boundary", near_boundary: "Near-boundary", missing_data: "Missing data", contradictory: "Contradictory", cross_version: "Cross-version", ambiguous: "Ambiguous", adversarial: "Adversarial" };
const SYS_SHORT = {
  "B1 Rule-only": "B1 Rule-only",
  "B2 LLM-only (no retrieval)": "B2 LLM-only",
  "B3 RAG+LLM": "B3 RAG + LLM",
  "B4 / R3 Fixed hybrid": "B4 Fixed hybrid",
  "R0 Earlier heuristic router": "R0 Heuristic router",
  "R1 Static rule-first": "R1 Static rule-first",
  "R4 Proposed adaptive": "R4 Adaptive (proposed)",
  "R4 at R0's cost budget": "R4 at R0's cost",
  "R4 fully automated (no human)": "R4 Fully automated",
  "Oracle (cheapest correct route)": "Oracle",
};
const shortSys = (k) => SYS_SHORT[k] || k.replace(/\s*\(θ=[\d.]+\)/, "").replace("Confidence threshold", "Threshold");

/** x-axis with gridlines for a horizontal value scale. */
function xAxis(x0, x1, yTop, yBot, ticks, scale, fmt) {
  const out = [];
  for (const t of ticks) {
    const x = scale(t);
    out.push(line(x, yTop, x, yBot, { stroke: GRID, width: 1 }));
    out.push(text(x, yBot + 16, fmt(t), { size: 11, anchor: "middle", fill: MUTED }));
  }
  out.push(line(x0, yBot, x1, yBot, { stroke: "#9a9a9a", width: 1 }));
  return out.join("\n");
}
function yAxis(xL, xR, y0, y1, ticks, scale, fmt) {
  const out = [];
  for (const t of ticks) {
    const y = scale(t);
    out.push(line(xL, y, xR, y, { stroke: GRID, width: 1 }));
    out.push(text(xL - 8, y + 4, fmt(t), { size: 11, anchor: "end", fill: MUTED }));
  }
  out.push(line(xL, y0, xR, y0, { stroke: "#9a9a9a", width: 1 }));
  return out.join("\n");
}

// ── Fig. 8: requirement taxonomy over the corpus ──
function taxonomyDistribution() {
  const g = load("extraction_gold.json").corpus_taxonomy;
  const types = ["A", "B", "C", "D", "E", "F", "G"];
  const W = 760;
  const L = 190;
  const R = 150;
  const rowH = 34;
  const top = 20;
  const H = top + types.length * rowH + 50;
  const max = 12000;
  const sx = (v) => L + (v / max) * (W - L - R);
  const b = [xAxis(L, W - R, top, top + types.length * rowH, [0, 3000, 6000, 9000, 12000], sx, fmtInt)];
  types.forEach((t, i) => {
    const y = top + i * rowH + 8;
    const v = g.by_type[t] || 0;
    b.push(text(L - 12, y + 13, TYPE_LABEL[t], { size: 12, anchor: "end" }));
    b.push(hbar(L, y, sx(v) - L, 18, t === "E" ? GRAY : INK));
    b.push(text(sx(v) + 8, y + 13, `${fmtInt(v)}  (${pct(v / g.n)})`, { size: 11.5 }));
  });
  b.push(text(L + (W - L - R) / 2, H - 6, `obligation clauses (n = ${fmtInt(g.n)})`, { size: 11.5, anchor: "middle", fill: MUTED }));
  return doc(W, H, b.join("\n"), { title: "Requirement categories A–G over all RBI obligations" });
}

// ── Fig. 9: benchmark composition ──
function benchmarkComposition() {
  const bm = load("router_eval.json").benchmark;
  const W = 900;
  const panel = (x0, w, entries, heading, labelW) => {
    const out = [text(x0, 24, heading, { size: 13, weight: 700 })];
    const L = x0 + labelW;
    const Rr = x0 + w - 50;
    const rowH = 26;
    const top = 40;
    const max = Math.max(...entries.map((e) => e[1]));
    const niceMax = Math.ceil(max / 100) * 100;
    const sx = (v) => L + (v / niceMax) * (Rr - L);
    const ticks = [0, niceMax / 2, niceMax];
    out.push(xAxis(L, Rr, top, top + entries.length * rowH, ticks, sx, fmtInt));
    entries.forEach(([k, v], i) => {
      const y = top + i * rowH + 6;
      out.push(text(L - 10, y + 12, k, { size: 11.5, anchor: "end" }));
      out.push(hbar(L, y, sx(v) - L, 16, INK));
      out.push(text(sx(v) + 6, y + 12, fmtInt(v), { size: 11 }));
    });
    return { svg: out.join("\n"), h: top + entries.length * rowH + 26 };
  };
  const ct = Object.entries(bm.by_case_type).sort((a, b) => b[1] - a[1]).map(([k, v]) => [CASE_LABEL[k] || k, v]);
  const rt = ["A", "B", "C", "D", "E", "F", "G"].map((t) => [TYPE_LABEL[t], bm.by_rule_type[t] || 0]);
  const p1 = panel(20, 430, ct, "(a) by case type", 110);
  const p2 = panel(470, 430, rt, "(b) by requirement category", 160);
  const H = Math.max(p1.h, p2.h) + 34;
  const note = `${fmtInt(bm.total)} cases from ${bm.distinct_rules} rules · train ${bm.by_split.train} / validation ${bm.by_split.validation} / test ${bm.by_split.test} (split by rule)`;
  return doc(W, H, [p1.svg, p2.svg, text(W / 2, H - 10, note, { size: 11.5, anchor: "middle", fill: MUTED })].join("\n"), { title: "Benchmark composition" });
}

// ── Fig. 10: accuracy of every system ──
function systemAccuracy() {
  const res = load("router_eval.json").results;
  const names = Object.keys(res);
  const W = 820;
  const L = 200;
  const R = 70;
  const groupH = 40;
  const top = 44;
  const H = top + names.length * groupH + 44;
  const sx = (v) => L + v * (W - L - R);
  const b = [legend(L, 20, [{ label: "Automated accuracy (escalations count as undecided)", fill: SERIES_FILL[0] }, { label: "End-to-end accuracy", fill: SERIES_FILL[1] }])];
  b.push(xAxis(L, W - R, top, top + names.length * groupH, [0, 0.25, 0.5, 0.75, 1], sx, (t) => `${t * 100}%`));
  names.forEach((n, i) => {
    const y = top + i * groupH + 6;
    const m = res[n];
    const strong = n === "R4 Proposed adaptive";
    b.push(text(L - 10, y + 17, shortSys(n), { size: 12, anchor: "end", weight: strong ? 700 : 400 }));
    b.push(hbar(L, y, sx(m.accuracy) - L, 13, SERIES_FILL[0]));
    b.push(hbar(L, y + 15, sx(m.end_to_end_accuracy) - L, 13, SERIES_FILL[1]));
    b.push(text(sx(m.accuracy) + 5, y + 11, pct(m.accuracy), { size: 10.5 }));
    b.push(text(sx(m.end_to_end_accuracy) + 5, y + 26, pct(m.end_to_end_accuracy), { size: 10.5, fill: MUTED }));
  });
  b.push(text(L + (W - L - R) / 2, H - 8, "test split, n = 294 cases on rules never seen in training or tuning", { size: 11.5, anchor: "middle", fill: MUTED }));
  return doc(W, H, b.join("\n"), { title: "Compliance accuracy of baselines and routers" });
}

// ── Fig. 11: accuracy–cost plane ──
function accuracyCost() {
  const rows = fs.readFileSync(path.join(RES, "frontier.csv"), "utf8").trim().split("\n").slice(1).map((l) => {
    const [label, beta, gamma, minEv, e2e, acc, usd, lat, pareto] = l.split(",");
    return { label, e2e: +e2e, acc: +acc, usd: +usd, pareto: pareto === "true" };
  });
  // the three R4 rows in order: τ point, cost-matched, fully automated
  let k = 0;
  const r4Names = ["R4 (τ)", "R4 at R0's cost", "R4 automated"];
  for (const r of rows) if (r.label === "R4") r.label = r4Names[k++];
  const W = 820;
  const H = 520;
  const L = 70;
  const Rr = W - 30;
  const T = 30;
  const B = H - 70;
  const floor = 5e-5;
  const lx = (v) => Math.log10(Math.max(v, floor));
  const x0 = lx(floor);
  const x1 = lx(1);
  const sx = (v) => L + ((lx(v) - x0) / (x1 - x0)) * (Rr - L);
  const sy = (v) => B - ((v - 0.5) / 0.5) * (B - T);
  const b = [];
  // axes
  const xt = [floor, 1e-4, 1e-3, 1e-2, 1e-1, 1];
  b.push(xAxis(L, Rr, T, B, xt, sx, (t) => (t === floor ? "0" : t >= 0.01 ? `$${t}` : `$${t.toExponential(0).replace("e-", "e−")}`)));
  b.push(yAxis(L, Rr, B, T, [0.5, 0.6, 0.7, 0.8, 0.9, 1], sy, (t) => `${Math.round(t * 100)}%`));
  b.push(text((L + Rr) / 2, H - 30, "cost per case (US$, log scale; 0 plotted at the left edge)", { size: 12, anchor: "middle", fill: MUTED }));
  b.push(`<text transform="translate(18 ${(T + B) / 2}) rotate(-90)" font-size="12" text-anchor="middle" fill="${MUTED}">end-to-end accuracy</text>`);
  // configs
  const cfg = rows.filter((r) => r.label === "R4-config");
  for (const c of cfg) b.push(`<circle cx="${S.r(sx(c.usd))}" cy="${S.r(sy(c.e2e))}" r="3" fill="#b5b5b5"/>`);
  // Pareto frontier over configs + named systems (max accuracy at ≤ cost)
  const all = rows.slice().sort((a, b) => a.usd - b.usd || b.e2e - a.e2e);
  const front = [];
  let best = -1;
  for (const p of all) if (p.e2e > best + 1e-9) {
    front.push(p);
    best = p.e2e;
  }
  const d = front.map((p, i) => `${i ? "L" : "M"}${S.r(sx(p.usd))},${S.r(sy(p.e2e))}`).join(" ");
  b.push(`<path d="${d}" fill="none" stroke="${INK}" stroke-width="1.5" stroke-dasharray="4 3"/>`);
  // named systems
  const named = rows.filter((r) => r.label !== "R4-config");
  const offs = { B1: [8, 14], B2: [8, 4], B3: [8, 4], B4: [-8, 16, "end"], R0: [8, 16], R1: [-8, -8, "end"], R2: [8, 4], "R4 (τ)": [-8, -10, "end"], "R4 at R0's cost": [-8, -10, "end"], "R4 automated": [8, -8] };
  for (const p of named) {
    const x = sx(p.usd);
    const y = sy(p.e2e);
    const isR4 = p.label.startsWith("R4");
    b.push(isR4 ? MARKERS[0](x, y) : MARKERS[2](x, y));
    const [dx, dy, anc] = offs[p.label] || [8, 4];
    b.push(text(x + dx, y + dy, `${p.label}  ${pct(p.e2e)}`, { size: 11, anchor: anc || "start", weight: p.label === "R4 (τ)" ? 700 : 400 }));
  }
  const LX = 470;
  const LY = B - 96;
  b.push(legend(LX, LY, [{ label: "R4 operating points", marker: MARKERS[0] }]));
  b.push(legend(LX, LY + 22, [{ label: "baselines and other routers", marker: MARKERS[2] }]));
  b.push(legend(LX, LY + 44, [{ label: "72 tuned R4 configurations", marker: (x, y) => `<circle cx="${x}" cy="${y}" r="3" fill="#b5b5b5"/>` }]));
  b.push(line(LX - 1, LY + 62, LX + 13, LY + 62, { stroke: INK, width: 1.5, dash: "4 3" }));
  b.push(text(LX + 18, LY + 66, "Pareto frontier", { size: 11.5, fill: "#222222" }));
  return doc(W, H, b.join("\n"), { title: "Accuracy–cost trade-off" });
}

/** Dot plot: rows × systems. */
function dotPlot(rowsKV, systems, title, rowLabel, { note = "" } = {}) {
  const W = 820;
  const L = 170;
  const R = 40;
  const rowH = 40;
  const top = 50;
  const H = top + rowsKV.length * rowH + 50;
  // systems are dodged vertically so tied values stay visible
  const dodge = (s) => (s - (systems.length - 1) / 2) * 7;
  const sx = (v) => L + v * (W - L - R);
  const b = [legend(L, 22, systems.map((s, i) => ({ label: s.label, marker: MARKERS[i] })))];
  b.push(xAxis(L, W - R, top, top + rowsKV.length * rowH, [0, 0.25, 0.5, 0.75, 1], sx, (t) => `${t * 100}%`));
  rowsKV.forEach(([k, label], i) => {
    const y = top + i * rowH + rowH / 2;
    b.push(line(L, y, W - R, y, { stroke: "#f0f0f0", width: 1 }));
    b.push(text(L - 10, y + 4, label, { size: 12, anchor: "end" }));
    // draw lower-priority systems first so R4 sits on top
    for (let s = systems.length - 1; s >= 0; s--) {
      const v = systems[s].values[k];
      if (v === undefined) continue;
      b.push(MARKERS[s](sx(v), y + dodge(s)));
    }
  });
  if (note) b.push(text(L + (W - L - R) / 2, H - 10, `${note}; markers offset vertically so ties stay visible`, { size: 11.5, anchor: "middle", fill: MUTED }));
  return doc(W, H, b.join("\n"), { title });
}

// ── Fig. 12: accuracy by case type ──
function accuracyByCaseType() {
  const r = load("router_eval.json");
  const pick = ["R4 Proposed adaptive", "R0 Earlier heuristic router", "B4 / R3 Fixed hybrid", "B3 RAG+LLM"];
  const systems = pick.map((n) => ({ label: shortSys(n), values: Object.fromEntries(Object.entries(r.by_case_type[n]).map(([k, v]) => [k, v.accuracy])) }));
  const order = ["compliant", "non_compliant", "boundary", "near_boundary", "missing_data", "contradictory", "cross_version", "ambiguous", "adversarial"];
  const n = r.by_case_type[pick[0]];
  return dotPlot(order.map((k) => [k, `${CASE_LABEL[k]} (${n[k].n})`]), systems, "Automated accuracy by case type", "case type", { note: "automated accuracy, test split (n per case type in brackets)" });
}

// ── Fig. 13: accuracy by requirement category ──
function accuracyByCategory() {
  const r = load("router_eval.json");
  const pick = ["R4 Proposed adaptive", "R0 Earlier heuristic router", "B4 / R3 Fixed hybrid", "B3 RAG+LLM"];
  const systems = pick.map((n) => ({ label: shortSys(n), values: Object.fromEntries(Object.entries(r.by_rule_type[n]).map(([k, v]) => [k, v.accuracy])) }));
  const n = r.by_rule_type[pick[0]];
  return dotPlot(["A", "B", "C", "D", "E", "F", "G"].map((k) => [k, `${TYPE_LABEL[k]} (${n[k].n})`]), systems, "Automated accuracy by requirement category", "category", { note: "automated accuracy, test split (n per category in brackets)" });
}

// ── Fig. 14: ablations ──
function ablations() {
  const a = load("router_eval.json").ablations;
  const names = Object.keys(a);
  const W = 820;
  const L = 300;
  const R = 70;
  const groupH = 40;
  const top = 44;
  const H = top + names.length * groupH + 20;
  const sx = (v) => L + v * (W - L - R);
  const b = [legend(L, 20, [{ label: "Automated accuracy", fill: SERIES_FILL[0] }, { label: "End-to-end accuracy", fill: SERIES_FILL[1] }])];
  b.push(xAxis(L, W - R, top, top + names.length * groupH, [0, 0.25, 0.5, 0.75, 1], sx, (t) => `${t * 100}%`));
  names.forEach((n, i) => {
    const y = top + i * groupH + 6;
    const m = a[n];
    b.push(text(L - 10, y + 17, n.replace("Full proposed system", "Full system (R4)"), { size: 12, anchor: "end", weight: i === 0 ? 700 : 400 }));
    b.push(hbar(L, y, sx(m.accuracy) - L, 13, SERIES_FILL[0]));
    b.push(hbar(L, y + 15, sx(m.end_to_end_accuracy) - L, 13, SERIES_FILL[1]));
    b.push(text(sx(m.accuracy) + 5, y + 11, pct(m.accuracy), { size: 10.5 }));
    b.push(text(sx(m.end_to_end_accuracy) + 5, y + 26, pct(m.end_to_end_accuracy), { size: 10.5, fill: MUTED }));
  });
  return doc(W, H + 16, b.join("\n"), { title: "Ablation study" });
}

// ── Fig. 15: significance (forest plot) ──
function significance() {
  const sig = load("router_eval.json").significance;
  const W = 820;
  const L = 330;
  const R = 40;
  const rowH = 44;
  const top = 50;
  const H = top + sig.length * rowH + 50;
  const lo = -0.05;
  const hi = 0.35;
  const sx = (v) => L + ((v - lo) / (hi - lo)) * (W - L - R);
  const b = [legend(L, 22, [{ label: "Δ automated accuracy", marker: MARKERS[0] }, { label: "Δ end-to-end accuracy", marker: MARKERS[1] }])];
  b.push(xAxis(L, W - R, top, top + sig.length * rowH, [0, 0.1, 0.2, 0.3], sx, (t) => `${t > 0 ? "+" : ""}${Math.round(t * 100)} pp`));
  b.push(line(sx(0), top, sx(0), top + sig.length * rowH, { stroke: INK, width: 1.2 }));
  sig.forEach((s, i) => {
    const y = top + i * rowH + 14;
    const lab = `${shortSys(s.a).replace(" (proposed)", "")} vs ${shortSys(s.b)}`;
    b.push(text(L - 12, y + 12, lab, { size: 12, anchor: "end" }));
    const autoOnly = s.a.includes("fully automated");
    const draw = (m, dy, k) => {
      b.push(line(sx(m.ci95[0]), y + dy, sx(m.ci95[1]), y + dy, { stroke: k ? GRAY : INK, width: 2 }));
      b.push(MARKERS[k](sx(m.difference), y + dy));
    };
    draw(s.accuracy, 4, 0);
    if (!autoOnly) draw(s.end_to_end, 20, 1);
    const p = s.accuracy.mcnemar_p;
    b.push(text(W - R, y + 8, `p = ${p < 0.001 ? p.toExponential(0).replace("e-", "e−") : p.toFixed(3)}`, { size: 10.5, anchor: "end", fill: MUTED }));
  });
  b.push(text(L + (W - L - R) / 2, H - 10, "difference with 95% cluster-bootstrap CI (by rule, 2,000 resamples); p = exact McNemar, automated accuracy", { size: 11, anchor: "middle", fill: MUTED }));
  return doc(W, H, b.join("\n"), { title: "Significance of the router's improvements" });
}

// ── Fig. 16: confusion matrices ──
function confusion() {
  const conf = load("router_eval.json").confusion;
  const D = ["COMPLIANT", "NON_COMPLIANT", "INSUFFICIENT_DATA", "AMBIGUOUS", "REQUIRES_HUMAN_REVIEW"];
  const lab = ["Compliant", "Non-compliant", "Insufficient", "Ambiguous", "Human review"];
  const panels = [["R4 Proposed adaptive", "(a) R4 adaptive router"], ["R0 Earlier heuristic router", "(b) R0 heuristic router"]];
  const cell = 52;
  const L = 120;
  const pw = L + 5 * cell + 40;
  const W = 2 * pw + 20;
  const top = 128;
  const H = top + 5 * cell + 70;
  const b = [];
  panels.forEach(([key, title], pi) => {
    const ox = pi * (pw + 20);
    const m = conf[key];
    b.push(text(ox + L, 22, title, { size: 13, weight: 700 }));
    b.push(text(ox + L + (5 * cell) / 2, 42, "produced decision", { size: 11, anchor: "middle", fill: MUTED }));
    lab.forEach((l, j) => b.push(`<text transform="translate(${ox + L + j * cell + cell / 2 + 4} ${top - 8}) rotate(-90)" font-size="11" fill="${INK}">${l}</text>`));
    D.forEach((d, i) => {
      const rowTotal = D.reduce((a, e) => a + m[d][e], 0);
      b.push(text(ox + L - 8, top + i * cell + cell / 2 + 4, lab[i], { size: 11, anchor: "end" }));
      D.forEach((e, j) => {
        const v = m[d][e];
        const share = rowTotal ? v / rowTotal : 0;
        const g = Math.round(255 - share * 225);
        const fill = `rgb(${g},${g},${g})`;
        b.push(`<rect x="${ox + L + j * cell + 1}" y="${top + i * cell + 1}" width="${cell - 2}" height="${cell - 2}" fill="${fill}" stroke="${i === j ? INK : "none"}" stroke-width="${i === j ? 1.5 : 0}"/>`);
        if (v) b.push(text(ox + L + j * cell + cell / 2, top + i * cell + cell / 2 + 4, v, { size: 12, anchor: "middle", fill: share > 0.6 ? "#ffffff" : INK, weight: i === j ? 700 : 400 }));
      });
    });
    b.push(`<text transform="translate(${ox + 14} ${top + 2.5 * cell}) rotate(-90)" font-size="11" text-anchor="middle" fill="${MUTED}">expected decision</text>`);
  });
  b.push(text(W / 2, H - 14, "test split; shade = share of the expected row; an escalation counts as Human review; diagonal outlined", { size: 11, anchor: "middle", fill: MUTED }));
  return doc(W, H, b.join("\n"), { title: "Decision confusion matrices" });
}

// ── Fig. 17: route mix per category ──
function routeMix() {
  const mix = load("router_eval.json").route_mix_by_rule_type["R4 Proposed adaptive"];
  const routes = [["DETERMINISTIC", "Rule engine / graph"], ["RAG_LLM", "RAG + LLM"], ["HUMAN", "Human review"], ["NONE", "Declined (no evidence)"]];
  const types = ["A", "B", "C", "D", "E", "F", "G"];
  const W = 820;
  const L = 190;
  const R = 70;
  const rowH = 34;
  const top = 50;
  const H = top + types.length * rowH + 40;
  const sx = (v) => L + v * (W - L - R);
  const b = [legend(L, 22, routes.map(([, l], i) => ({ label: l, fill: SERIES_FILL[i] })))];
  b.push(xAxis(L, W - R, top, top + types.length * rowH, [0, 0.25, 0.5, 0.75, 1], sx, (t) => `${t * 100}%`));
  types.forEach((t, i) => {
    const y = top + i * rowH + 8;
    const g = mix[t] || {};
    const n = routes.reduce((a, [k]) => a + (g[k] || 0), 0);
    b.push(text(L - 10, y + 13, TYPE_LABEL[t], { size: 12, anchor: "end" }));
    let acc = 0;
    routes.forEach(([k], j) => {
      const v = (g[k] || 0) / (n || 1);
      if (v > 0) {
        const x = sx(acc);
        const w = sx(acc + v) - x - (acc + v < 0.999 ? 2 : 0);
        b.push(`<rect x="${S.r(x)}" y="${y}" width="${S.r(Math.max(w, 0.5))}" height="18" fill="${SERIES_FILL[j]}"/>`);
      }
      acc += v;
    });
    b.push(text(W - R + 8, y + 13, `n = ${n}`, { size: 11, fill: MUTED }));
  });
  b.push(text(L + (W - L - R) / 2, H - 8, "share of test cases routed to each modality by R4", { size: 11.5, anchor: "middle", fill: MUTED }));
  return doc(W, H, b.join("\n"), { title: "Where the adaptive router sends each requirement category" });
}

// ── Fig. 18: extraction recall ──
function extraction() {
  const g = load("extraction_gold.json");
  const groups = [["All gold rules", "overall", g.overall.n], ["Figure requirements", "figures", g.by_set.figures.n], ["Network limits", "network", g.by_set.network.n]];
  const after = { overall: g.overall.exact_recall, figures: g.by_set.figures.exact_recall, network: g.by_set.network.exact_recall };
  const before = { overall: g.before_fixes.overall.exact_recall, figures: g.before_fixes.figures.exact_recall, network: g.before_fixes.network.exact_recall };
  const W = 720;
  const H = 400;
  const L = 70;
  const Rr = W - 30;
  const T = 50;
  const B = H - 70;
  const sy = (v) => B - v * (B - T);
  const b = [legend(L, 24, [{ label: "before the extraction fixes", fill: SERIES_FILL[1] }, { label: "after (this version)", fill: SERIES_FILL[0] }])];
  b.push(yAxis(L, Rr, B, T, [0, 0.25, 0.5, 0.75, 1], sy, (t) => `${t * 100}%`));
  const gw = (Rr - L) / groups.length;
  const bw = 40;
  groups.forEach(([lab, k, n], i) => {
    const cx = L + gw * i + gw / 2;
    b.push(vbar(cx - bw - 2, B, B - sy(before[k]), bw, SERIES_FILL[1]));
    b.push(vbar(cx + 2, B, B - sy(after[k]), bw, SERIES_FILL[0]));
    b.push(text(cx - bw / 2 - 2, sy(before[k]) - 6, pct(before[k]), { size: 11, anchor: "middle", fill: MUTED }));
    b.push(text(cx + bw / 2 + 2, sy(after[k]) - 6, pct(after[k]), { size: 11, anchor: "middle", weight: 700 }));
    b.push(text(cx, B + 18, `${lab} (n = ${n})`, { size: 12, anchor: "middle" }));
  });
  b.push(text((L + Rr) / 2, H - 22, `exact recall (operator + value) on the hand-verified gold set; operator accuracy ${pct(g.overall.operator_accuracy, 0)}`, { size: 11.5, anchor: "middle", fill: MUTED }));
  b.push(`<text transform="translate(18 ${(T + B) / 2}) rotate(-90)" font-size="12" text-anchor="middle" fill="${MUTED}">exact recall</text>`);
  return doc(W, H, b.join("\n"), { title: "Rule extraction recall against the gold set" });
}

// ── Fig. 19: retrieval, structure-aware vs fixed windows ──
function retrieval() {
  const c = load("chunking_eval.json");
  const sets = [["generated from gold rules", "(a) questions generated from gold rules"], ["hand-written", "(b) hand-written questions"]];
  const sysNames = Object.keys(c.sets["hand-written"]);
  const label = (s) => s.replace("Structure-aware: ", "Clause-aligned ").replace("Fixed windows: ", "Fixed windows ").replace(" (proposed)", " ★").replace(" (C1)", "").replace(" (C3)", "").replace("hybrid RRF", "hybrid");
  const W = 900;
  const pw = 430;
  const L = 170;
  const groupH = 38;
  const top = 64;
  const H = top + sysNames.length * groupH + 60;
  const b = [legend(20, 20, [{ label: "Top-5 recall", fill: SERIES_FILL[0] }, { label: "MRR@10", fill: SERIES_FILL[1] }])];
  sets.forEach(([key, title], pi) => {
    const ox = pi * (pw + 30);
    const x0 = ox + L;
    const x1 = ox + pw - 40;
    const sx = (v) => x0 + v * (x1 - x0);
    b.push(text(ox + 20, top - 16, `${title} (n = ${c.sets[key][sysNames[0]].n})`, { size: 12.5, weight: 700 }));
    b.push(xAxis(x0, x1, top, top + sysNames.length * groupH, [0, 0.5, 1], sx, (t) => t.toFixed(1)));
    sysNames.forEach((s, i) => {
      const m = c.sets[key][s];
      const y = top + i * groupH + 5;
      b.push(text(x0 - 8, y + 16, label(s), { size: 11.5, anchor: "end", weight: s.includes("proposed") ? 700 : 400 }));
      b.push(hbar(x0, y, sx(m.hit5) - x0, 12, SERIES_FILL[0]));
      b.push(hbar(x0, y + 14, sx(m.mrr10) - x0, 12, SERIES_FILL[1]));
      b.push(text(sx(m.hit5) + 4, y + 10, m.hit5.toFixed(2), { size: 10 }));
      b.push(text(sx(m.mrr10) + 4, y + 24, m.mrr10.toFixed(2), { size: 10, fill: MUTED }));
    });
    if (pi === 0) b.push(line(ox + 10, top + 3 * groupH, ox + pw - 20, top + 3 * groupH, { stroke: "#9a9a9a", width: 1, dash: "3 3" }));
    if (pi === 1) b.push(line(ox + 10, top + 3 * groupH, ox + pw - 20, top + 3 * groupH, { stroke: "#9a9a9a", width: 1, dash: "3 3" }));
  });
  b.push(text(W / 2, H - 12, `fixed windows: ${c.window_chars} characters, ${c.overlap_chars} overlap (${fmtInt(c.windows)} windows); a passage counts only if it contains the whole provision; ★ = proposed`, { size: 11, anchor: "middle", fill: MUTED }));
  return doc(W, H, b.join("\n"), { title: "Clause-aligned vs fixed-window retrieval" });
}

// ── Fig. 20: simplification ──
function simplification() {
  const s = load("simplification_eval.json");
  const types = Object.keys(s.by_rule_type).sort();
  const rows = [["All", s.overall], ...types.map((t) => [TYPE_LABEL[t], s.by_rule_type[t]])];
  const W = 820;
  const L = 190;
  const R = 230;
  const rowH = 32;
  const top = 56;
  const H = top + rows.length * rowH + 50;
  const lo = 13;
  const hi = 17;
  const sx = (v) => L + ((v - lo) / (hi - lo)) * (W - L - R);
  const b = [legend(L, 22, [{ label: "original", marker: MARKERS[2] }, { label: "simplified", marker: MARKERS[0] }])];
  b.push(xAxis(L, W - R, top, top + rows.length * rowH, [13, 14, 15, 16, 17], sx, (t) => `${t}`));
  b.push(text(W - R + 20, top - 10, "re-extraction", { size: 11, weight: 700 }));
  b.push(text(W - R + 120, top - 10, "guard pass", { size: 11, weight: 700 }));
  rows.forEach(([label, m], i) => {
    const y = top + i * rowH + rowH / 2;
    b.push(line(L, y, W - R, y, { stroke: "#f0f0f0", width: 1 }));
    b.push(text(L - 10, y + 4, `${label} (${m.n})`, { size: 12, anchor: "end", weight: i === 0 ? 700 : 400 }));
    b.push(line(sx(m.fkgl_before), y, sx(m.fkgl_after), y, { stroke: INK, width: 2 }));
    b.push(MARKERS[2](sx(m.fkgl_before), y));
    b.push(MARKERS[0](sx(m.fkgl_after), y));
    b.push(text(W - R + 20, y + 4, m.rule_reextraction_agreement === null ? "n/a" : `${pct(m.rule_reextraction_agreement, 0)} (${m.clauses_with_atoms})`, { size: 11 }));
    b.push(text(W - R + 120, y + 4, pct(m.guard_pass), { size: 11 }));
  });
  b.push(text(L + (W - L - R) / 2, H - 12, "Flesch–Kincaid grade level (lower = easier); rule-based simplifier with meaning guard", { size: 11, anchor: "middle", fill: MUTED }));
  return doc(W, H, b.join("\n"), { title: "Readability and meaning preservation of plain-language restatements" });
}

module.exports = { taxonomyDistribution, benchmarkComposition, systemAccuracy, accuracyCost, accuracyByCaseType, accuracyByCategory, ablations, significance, confusion, routeMix, extraction, retrieval, simplification };
