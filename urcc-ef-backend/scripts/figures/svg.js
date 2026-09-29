/**
 * Minimal SVG toolkit for the report / journal figures: black-and-white
 * architecture boxes and grayscale charts. Plain strings, no dependencies,
 * deterministic output.
 */
const FONT = "Helvetica, Arial, sans-serif";
const INK = "#111111";
const MUTED = "#555555";
const GRID = "#e2e2e2";
const GRAY = "#8a8a8a";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Approximate rendered width of Helvetica text. */
const textWidth = (s, size = 12, bold = false) => String(s).length * size * (bold ? 0.58 : 0.53);

function doc(w, h, body, { title = "", desc = "" } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="${FONT}" role="img"${title ? ` aria-label="${esc(title)}"` : ""}>
${title ? `<title>${esc(title)}</title>` : ""}${desc ? `<desc>${esc(desc)}</desc>` : ""}
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${INK}"/></marker>
  <marker id="arrow-muted" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${GRAY}"/></marker>
  <pattern id="hatch45" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><rect width="6" height="6" fill="#ffffff"/><line x1="0" y1="0" x2="0" y2="6" stroke="${INK}" stroke-width="2"/></pattern>
  <pattern id="hatch135" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(135)"><rect width="6" height="6" fill="#ffffff"/><line x1="0" y1="0" x2="0" y2="6" stroke="${GRAY}" stroke-width="2"/></pattern>
</defs>
<rect width="${w}" height="${h}" fill="#ffffff"/>
${body}
</svg>
`;
}

function text(x, y, s, { size = 12, weight = 400, anchor = "start", fill = INK, italic = false, baseline = null } = {}) {
  return `<text x="${r(x)}" y="${r(y)}" font-size="${size}"${weight !== 400 ? ` font-weight="${weight}"` : ""}${anchor !== "start" ? ` text-anchor="${anchor}"` : ""}${italic ? ` font-style="italic"` : ""}${baseline ? ` dominant-baseline="${baseline}"` : ""} fill="${fill}">${esc(s)}</text>`;
}
const r = (v) => Math.round(v * 10) / 10;

// ── architecture primitives ──

/**
 * A box with a bold title and body lines.
 * opts: strong (thicker stroke), dashed (optional / external), align ('center'|'left'), tag (small right-aligned note)
 */
function box(x, y, w, h, title, lines = [], opts = {}) {
  const { strong = false, dashed = false, align = "center", tag = null, titleSize = 14, lineSize = 11.5, fill = "#ffffff" } = opts;
  const sw = strong ? 2.4 : 1.2;
  const out = [`<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" rx="6" fill="${fill}" stroke="${INK}" stroke-width="${sw}"${dashed ? ' stroke-dasharray="6 4"' : ""}/>`];
  const cx = align === "center" ? x + w / 2 : x + 14;
  const anchor = align === "center" ? "middle" : "start";
  const titleH = title ? titleSize * 1.2 : 0;
  const gap = title && lines.length ? 8 : 0;
  const lineH = lineSize * 1.5;
  const blockH = titleH + gap + lines.length * lineH;
  const start = y + (h - blockH) / 2;
  if (title) out.push(text(cx, start + titleSize * 0.92, title, { size: titleSize, weight: 700, anchor }));
  lines.forEach((l, i) => out.push(text(cx, start + titleH + gap + i * lineH + lineSize * 1.05, l, { size: lineSize, anchor, fill: "#222222" })));
  if (tag) out.push(text(x + w - 10, y + h - 8, tag, { size: 10, anchor: "end", fill: MUTED, italic: true }));
  return out.join("\n");
}

/** Database cylinder. */
function store(x, y, w, h, title, lines = [], { lineSize = 11.5 } = {}) {
  const ry = 9;
  const body = `<path d="M${r(x)},${r(y + ry)} a${r(w / 2)},${ry} 0 0,0 ${r(w)},0 a${r(w / 2)},${ry} 0 0,0 ${r(-w)},0 v${r(h - 2 * ry)} a${r(w / 2)},${ry} 0 0,0 ${r(w)},0 v${r(-(h - 2 * ry))}" fill="#ffffff" stroke="${INK}" stroke-width="1.4"/>`;
  const out = [body];
  const lineH = lineSize * 1.5;
  const blockH = 14 * 1.2 + (lines.length ? 8 : 0) + lines.length * lineH;
  const start = y + 2 * ry + (h - 2 * ry - blockH) / 2 - 2;
  out.push(text(x + w / 2, start + 14 * 0.92, title, { size: 14, weight: 700, anchor: "middle" }));
  lines.forEach((l, i) => out.push(text(x + w / 2, start + 14 * 1.2 + 8 + i * lineH + lineSize * 1.05, l, { size: lineSize, anchor: "middle", fill: "#222222" })));
  return out.join("\n");
}

/** Decision diamond. */
function diamond(cx, cy, w, h, lines) {
  const out = [`<path d="M${r(cx)},${r(cy - h / 2)} L${r(cx + w / 2)},${r(cy)} L${r(cx)},${r(cy + h / 2)} L${r(cx - w / 2)},${r(cy)} z" fill="#ffffff" stroke="${INK}" stroke-width="1.4"/>`];
  const lh = 15;
  let y0 = cy - ((lines.length - 1) * lh) / 2 + 4;
  for (const l of lines) {
    out.push(text(cx, y0, l, { size: 11.5, anchor: "middle" }));
    y0 += lh;
  }
  return out.join("\n");
}

/** Rounded pill (terminal / label). */
function pill(cx, cy, label, { w = null, size = 11.5, strong = false, filled = false } = {}) {
  const ww = w || textWidth(label, size, true) + 28;
  return `<rect x="${r(cx - ww / 2)}" y="${r(cy - 14)}" width="${r(ww)}" height="28" rx="14" fill="${filled ? INK : "#ffffff"}" stroke="${INK}" stroke-width="${strong ? 2 : 1.2}"/>` + text(cx, cy + 4, label, { size, weight: 700, anchor: "middle", fill: filled ? "#ffffff" : INK });
}

/** Polyline arrow through points [[x,y],...]; optional label at a point. */
function arrow(points, { label = null, at = null, dashed = false, muted = false, labelAnchor = "start", both = false } = {}) {
  const d = points.map((p, i) => `${i ? "L" : "M"}${r(p[0])},${r(p[1])}`).join(" ");
  const out = [`<path d="${d}" fill="none" stroke="${muted ? GRAY : INK}" stroke-width="1.3"${dashed ? ' stroke-dasharray="5 4"' : ""} marker-end="url(#${muted ? "arrow-muted" : "arrow"})"${both ? ` marker-start="url(#${muted ? "arrow-muted" : "arrow"})"` : ""}/>`];
  if (label) {
    const [lx, ly] = at || points[Math.floor(points.length / 2)];
    out.push(text(lx, ly, label, { size: 10.5, italic: true, fill: "#333333", anchor: labelAnchor }));
  }
  return out.join("\n");
}

function line(x1, y1, x2, y2, { stroke = INK, width = 1, dash = null } = {}) {
  return `<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
}

// ── chart primitives ──

/** Grayscale series fills, print-safe: solid ink, solid gray, ink hatch, gray hatch. */
const SERIES_FILL = [INK, GRAY, "url(#hatch45)", "url(#hatch135)"];

/** A bar with a 3px rounded data end, square at the baseline (horizontal). */
function hbar(x0, y, len, h, fill) {
  if (len <= 0.5) return "";
  const rr = Math.min(3, len / 2, h / 2);
  const x1 = x0 + len;
  return `<path d="M${r(x0)},${r(y)} H${r(x1 - rr)} Q${r(x1)},${r(y)} ${r(x1)},${r(y + rr)} V${r(y + h - rr)} Q${r(x1)},${r(y + h)} ${r(x1 - rr)},${r(y + h)} H${r(x0)} z" fill="${fill}"/>`;
}
/** Vertical column with a rounded top. */
function vbar(x, yBase, len, w, fill) {
  if (len <= 0.5) return "";
  const rr = Math.min(3, len / 2, w / 2);
  const y1 = yBase - len;
  return `<path d="M${r(x)},${r(yBase)} V${r(y1 + rr)} Q${r(x)},${r(y1)} ${r(x + rr)},${r(y1)} H${r(x + w - rr)} Q${r(x + w)},${r(y1)} ${r(x + w)},${r(y1 + rr)} V${r(yBase)} z" fill="${fill}"/>`;
}

/** Legend row: [{label, fill}] or [{label, marker}] starting at x,y. */
function legend(x, y, items) {
  const out = [];
  let cx = x;
  for (const it of items) {
    if (it.marker) out.push(it.marker(cx + 6, y - 4));
    else out.push(`<rect x="${r(cx)}" y="${r(y - 10)}" width="12" height="12" rx="2" fill="${it.fill}"${it.fill.startsWith("url") ? ` stroke="${INK}" stroke-width="0.6"` : ""}/>`);
    out.push(text(cx + 18, y, it.label, { size: 11.5, fill: "#222222" }));
    cx += 18 + textWidth(it.label, 11.5) + 22;
  }
  return out.join("\n");
}

/** Marker shapes for dot plots (distinguishable in grayscale). */
const MARKERS = [
  (x, y) => `<circle cx="${r(x)}" cy="${r(y)}" r="5.5" fill="${INK}" stroke="#ffffff" stroke-width="2"/>`,
  (x, y) => `<rect x="${r(x - 5)}" y="${r(y - 5)}" width="10" height="10" fill="${GRAY}" stroke="#ffffff" stroke-width="2"/>`,
  (x, y) => `<path d="M${r(x)},${r(y - 6.5)} L${r(x + 6.5)},${r(y)} L${r(x)},${r(y + 6.5)} L${r(x - 6.5)},${r(y)} z" fill="#ffffff" stroke="${INK}" stroke-width="1.6"/>`,
  (x, y) => `<path d="M${r(x)},${r(y - 6)} L${r(x + 6.5)},${r(y + 5)} L${r(x - 6.5)},${r(y + 5)} z" fill="#ffffff" stroke="${GRAY}" stroke-width="1.8"/>`,
];

module.exports = { FONT, INK, MUTED, GRID, GRAY, esc, textWidth, doc, text, box, store, diamond, pill, arrow, line, hbar, vbar, legend, SERIES_FILL, MARKERS, r };
