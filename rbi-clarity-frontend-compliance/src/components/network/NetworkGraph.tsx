import { useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import { Maximize2, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { GraphLink, GraphNode } from "@/lib/network";
import { SELF } from "@/lib/network";

const W = 900;
const H = 560;

type SimNode = GraphNode & SimulationNodeDatum & { r: number };
type SimLink = GraphLink & { s: SimNode; t: SimNode };

const STATUS_FILL: Record<string, string> = {
  PROHIBITED: "#dc2626",
  BREACH: "#dc2626",
  POTENTIAL_BREACH: "#d97706",
  ASSESSMENT_REQUIRED: "#ca8a04",
  NEEDS_REVIEW: "#a16207",
  REPORTABLE: "#2563eb",
  PASS_WITH_CONDITIONS: "#16a34a",
  PASS: "#16a34a",
};

const edgeStyle = (l: GraphLink) => {
  const control = l.edge_type === "CONTROLS" || (l.edge_type === "OWNS" && /control/.test(l.label));
  const base = {
    stroke: "#64748b",
    width: 1.2,
    dash: undefined as string | undefined,
    opacity: 0.85,
  };
  if (control) Object.assign(base, { stroke: "#334155", width: 2.2 });
  else if (l.edge_type === "OWNS") Object.assign(base, { stroke: "#94a3b8", width: 1.2 });
  else if (l.edge_type === "ECONOMIC_DEPENDENCE") Object.assign(base, { stroke: "#ea580c", width: 2, dash: "6 4" });
  else if (l.edge_type === "COMMON_MANAGEMENT") Object.assign(base, { stroke: "#0891b2", width: 2, dash: "2 3" });
  else Object.assign(base, { stroke: "#7c3aed", width: 1.4 });
  if (l.status === "flagged") Object.assign(base, { dash: "3 3", opacity: 0.75 });
  if (l.status === "rebutted") Object.assign(base, { opacity: 0.2 });
  return base;
};

interface Props {
  nodes: GraphNode[];
  links: GraphLink[];
  selectedId?: string | null;
  highlight?: string[] | null;
  onSelect?: (id: string | null) => void;
}

/**
 * Force-directed drawing of a bank's counterparty network. The layout is
 * computed once per data change (300 ticks, deterministic), then drawn as
 * plain SVG: node size = exposure, colour = worst finding, edge style =
 * relationship type, dashed = flagged, faded = rebutted.
 */
export const NetworkGraph = ({ nodes, links, selectedId, highlight, onSelect }: Props) => {
  const layout = useMemo(() => {
    // The bank itself is drawn only when something links to it (directors,
    // promoters, shareholders, its own subsidiaries).
    const linked = new Set(links.flatMap((l) => [l.source, l.target]));
    const visible = nodes.filter((n) => n.id !== SELF || linked.has(SELF));
    const max = Math.max(1, ...visible.map((n) => n.exposure + n.exempt));
    const simNodes: SimNode[] = visible.map((n, i) => ({
      ...n,
      r: n.id === SELF ? 16 : 7 + 17 * Math.sqrt((n.exposure + n.exempt) / max),
      // deterministic start positions on a circle (no Math.random)
      x: W / 2 + Math.cos((2 * Math.PI * i) / Math.max(1, visible.length)) * 220,
      y: H / 2 + Math.sin((2 * Math.PI * i) / Math.max(1, visible.length)) * 180,
      fx: n.id === SELF ? W / 2 : undefined,
      fy: n.id === SELF ? H / 2 : undefined,
    }));
    const byId = new Map(simNodes.map((n) => [n.id, n]));
    const simLinks = links
      .filter((l) => byId.has(l.source) && byId.has(l.target))
      .map((l) => ({ ...l, s: byId.get(l.source)!, t: byId.get(l.target)! }));
    const sim = forceSimulation(simNodes)
      .force(
        "link",
        forceLink(simLinks.map((l) => ({ source: l.s, target: l.t, type: l.edge_type })))
          .distance((l) => ((l as { type: string }).type === "ECONOMIC_DEPENDENCE" ? 170 : 125))
          .strength(0.5),
      )
      .force("charge", forceManyBody().strength(-700))
      .force("center", forceCenter(W / 2, H / 2))
      .force("x", forceX(W / 2).strength(0.05))
      .force("y", forceY(H / 2).strength(0.08))
      .force("collide", forceCollide<SimNode>().radius((d) => d.r + 34).strength(0.9))
      .stop();
    for (let i = 0; i < 400; i++) sim.tick();
    // Fit the drawing to the nodes (labels included), keeping the canvas
    // aspect ratio so pan / zoom arithmetic stays simple.
    if (!simNodes.length) return { nodes: simNodes, links: simLinks as SimLink[], box: { x: 0, y: 0, w: W, h: H } };
    const pad = { x: 90, top: 30, bottom: 45 };
    const xs = simNodes.map((n) => n.x ?? 0);
    const ys = simNodes.map((n) => n.y ?? 0);
    let minX = Math.min(...xs) - pad.x;
    let maxX = Math.max(...xs) + pad.x;
    let minY = Math.min(...ys) - pad.top;
    let maxY = Math.max(...ys) + pad.bottom;
    let w = Math.max(maxX - minX, 420);
    let h = Math.max(maxY - minY, 260);
    if (w / h > W / H) h = (w * H) / W;
    else w = (h * W) / H;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    minX = cx - w / 2;
    minY = cy - h / 2;
    maxX = minX + w;
    maxY = minY + h;
    return { nodes: simNodes, links: simLinks as SimLink[], box: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
  }, [nodes, links]);
  const box = layout.box;

  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const toSvg = (dx: number, dy: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    const scale = rect ? box.w / rect.width : 1;
    return { dx: dx * scale, dy: dy * scale };
  };
  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if ((e.target as Element).closest("[data-node]")) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    const { dx, dy } = toSvg(e.clientX - drag.current.x, e.clientY - drag.current.y);
    setView((v) => ({ ...v, x: drag.current!.vx + dx, y: drag.current!.vy + dy }));
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const zoom = (factor: number) =>
    setView((v) => {
      const k = Math.min(3, Math.max(0.4, v.k * factor));
      // zoom around the centre of the drawing
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
    });
  const onWheel = (e: WheelEvent<SVGSVGElement>) => {
    if (!e.ctrlKey && !e.metaKey) return; // plain scroll keeps scrolling the page
    e.preventDefault();
    zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15);
  };

  const dim = (id: string) => !!highlight?.length && !highlight.includes(id);

  return (
    <div className="relative rounded-lg border border-border bg-background overflow-hidden">
      <div className="absolute right-2 top-2 z-10 flex gap-1">
        <Button size="icon" variant="outline" className="h-7 w-7 bg-card" onClick={() => zoom(1.25)} aria-label="Zoom in">
          <Plus className="h-3.5 w-3.5" />
        </Button>
        <Button size="icon" variant="outline" className="h-7 w-7 bg-card" onClick={() => zoom(0.8)} aria-label="Zoom out">
          <Minus className="h-3.5 w-3.5" />
        </Button>
        <Button size="icon" variant="outline" className="h-7 w-7 bg-card" onClick={() => setView({ x: 0, y: 0, k: 1 })} aria-label="Reset view">
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <svg
        ref={svgRef}
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
        className="w-full h-auto touch-none select-none cursor-grab active:cursor-grabbing"
        role="img"
        aria-label="Counterparty network"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onWheel={onWheel}
        onClick={(e) => {
          if (!(e.target as Element).closest("[data-node]")) onSelect?.(null);
        }}
      >
        <defs>
          {["#334155", "#94a3b8", "#ea580c", "#0891b2", "#7c3aed", "#64748b"].map((c) => (
            <marker key={c} id={`arrow-${c.slice(1)}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill={c} />
            </marker>
          ))}
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {layout.links.map((l) => {
            const st = edgeStyle(l);
            const dx = (l.t.x ?? 0) - (l.s.x ?? 0);
            const dy = (l.t.y ?? 0) - (l.s.y ?? 0);
            const len = Math.max(1, Math.hypot(dx, dy));
            const x1 = (l.s.x ?? 0) + (dx / len) * l.s.r;
            const y1 = (l.s.y ?? 0) + (dy / len) * l.s.r;
            const x2 = (l.t.x ?? 0) - (dx / len) * (l.t.r + 3);
            const y2 = (l.t.y ?? 0) - (dy / len) * (l.t.r + 3);
            const faded = dim(l.source) || dim(l.target);
            const undirected = l.edge_type === "COMMON_MANAGEMENT";
            return (
              <line
                key={String(l.id)}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={st.stroke}
                strokeWidth={st.width}
                strokeDasharray={st.dash}
                opacity={faded ? 0.12 : st.opacity}
                markerEnd={undirected ? undefined : `url(#arrow-${st.stroke.slice(1)})`}
              >
                <title>{l.label}</title>
              </line>
            );
          })}
          {layout.nodes.map((n) => {
            const self = n.id === SELF;
            const fill = self ? "hsl(var(--primary))" : n.status ? STATUS_FILL[n.status] ?? "#94a3b8" : "#94a3b8";
            const person = n.entity_type === "individual";
            const selected = selectedId === n.id;
            return (
              <g
                key={n.id}
                data-node
                transform={`translate(${n.x},${n.y})`}
                opacity={dim(n.id) ? 0.2 : 1}
                className="cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect?.(selected ? null : n.id);
                }}
              >
                {self ? (
                  <rect x={-n.r} y={-n.r} width={n.r * 2} height={n.r * 2} rx={5} fill={fill} />
                ) : (
                  <circle
                    r={n.r}
                    fill={person ? "hsl(var(--background))" : fill}
                    stroke={person ? fill : n.bank_group ? "hsl(var(--primary))" : "white"}
                    strokeWidth={person ? 3 : n.bank_group ? 3 : 1.5}
                    strokeDasharray={n.bank_group ? "3 2" : undefined}
                  />
                )}
                {selected && <circle r={n.r + 5} fill="none" stroke="hsl(var(--foreground))" strokeWidth={2} />}
                <text y={n.r + 12} textAnchor="middle" className="fill-foreground" style={{ fontSize: 11, fontWeight: self ? 600 : 400 }}>
                  {n.name.length > 26 ? `${n.name.slice(0, 24)}…` : n.name}
                </text>
                {n.exposure_pct !== null && n.exposure > 0 && (
                  <text y={n.r + 24} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: 10 }}>
                    {n.exposure_pct}%
                  </text>
                )}
                <title>
                  {`${n.name} (${n.entity_type})${n.exposure ? `\nExposure ₹${n.exposure} cr${n.exposure_pct !== null ? ` (${n.exposure_pct}% of capital base)` : ""}` : ""}${n.exempt ? `\nExempt ₹${n.exempt} cr` : ""}${n.bank_group ? `\nBank's own group: ${n.bank_group.replace(/_/g, " ")}` : ""}${n.status ? `\nWorst finding: ${n.status.replace(/_/g, " ").toLowerCase()}` : ""}`}
                </title>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
};

export const NetworkLegend = () => {
  const item = (el: JSX.Element, label: string) => (
    <span className="inline-flex items-center gap-1.5">
      {el}
      {label}
    </span>
  );
  const line = (stroke: string, dash?: string, width = 2, opacity = 1) => (
    <svg width="26" height="8" aria-hidden>
      <line x1="1" y1="4" x2="25" y2="4" stroke={stroke} strokeWidth={width} strokeDasharray={dash} opacity={opacity} />
    </svg>
  );
  const dot = (fill: string, ring?: string) => (
    <svg width="12" height="12" aria-hidden>
      <circle cx="6" cy="6" r="5" fill={fill} stroke={ring} strokeWidth={ring ? 2 : 0} />
    </svg>
  );
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground mt-2">
      {item(dot("#dc2626"), "Breach / prohibited")}
      {item(dot("#d97706"), "Potential breach / review")}
      {item(dot("#2563eb"), "Large exposure (report)")}
      {item(dot("#16a34a"), "Within limits")}
      {item(dot("hsl(var(--background))", "#94a3b8"), "Individual")}
      {item(line("#334155", undefined, 2.2), "Control (> 50% or other)")}
      {item(line("#94a3b8", undefined, 1.2), "Shareholding ≤ 50%")}
      {item(line("#ea580c", "6 4"), "Economic dependence")}
      {item(line("#0891b2", "2 3"), "Common management")}
      {item(line("#7c3aed", undefined, 1.4), "Director / relative / promoter")}
      {item(line("#64748b", "3 3"), "Flagged (unconfirmed)")}
      {item(line("#64748b", undefined, 2, 0.25), "Rebutted")}
      <span>Node size = exposure · Ctrl + scroll to zoom · drag to pan</span>
    </div>
  );
};
