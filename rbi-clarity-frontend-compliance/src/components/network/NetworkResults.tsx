import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Network, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SourceViewer, type SourceTarget } from "@/components/SourceViewer";
import { StatusBadge, EmptyState } from "@/components/compliance/shared";
import type { NetworkCheck, NetworkResult, RuleSource } from "@/lib/network";
import { human } from "@/lib/network";
import { cn } from "@/lib/utils";

const SEVERITY = ["PROHIBITED", "BREACH", "POTENTIAL_BREACH", "NEEDS_REVIEW", "ASSESSMENT_REQUIRED", "REPORTABLE", "PASS_WITH_CONDITIONS", "PASS", "INFO"];
const ISSUES = new Set(["PROHIBITED", "BREACH", "POTENTIAL_BREACH", "NEEDS_REVIEW", "ASSESSMENT_REQUIRED"]);
const rank = (s: string) => {
  const i = SEVERITY.indexOf(s);
  return i === -1 ? SEVERITY.length : i;
};
const cr = (x: number | null | undefined) => (x === null || x === undefined ? "–" : `₹${x.toLocaleString("en-IN", { maximumFractionDigits: 2 })} cr`);

type Filter = "issues" | "reportable" | "all";

export const SourceLink = ({ source, onOpen }: { source: RuleSource; onOpen: (t: SourceTarget) => void }) =>
  source.verified && source.clause_uri ? (
    <Button
      variant="link"
      size="sm"
      className="h-auto p-0 text-xs"
      onClick={() =>
        onOpen({
          clauseUri: source.clause_uri!,
          highlight: source.excerpt,
          label: source.doc_title,
          preview: { doc_id: source.doc_id, doc_title: source.doc_title, rbi_ref: source.rbi_ref, page: source.page_number, paragraph: source.paragraph },
        })
      }
    >
      <FileText className="h-3 w-3 mr-1" />
      {source.rbi_ref ? `${source.rbi_ref}, ` : ""}para {source.paragraph}, p. {source.page_number}
    </Button>
  ) : (
    <span className="text-xs text-yellow-800">Source not verified in corpus{source.reason ? `: ${source.reason}` : ""}</span>
  );

const ResultRow = ({ r, onOpen }: { r: NetworkResult; onOpen: (t: SourceTarget) => void }) => {
  const [open, setOpen] = useState(ISSUES.has(r.status) && (r.subject.type === "group" || !!r.path));
  const members = r.subject.members ?? [];
  return (
    <li className="rounded-lg border border-border bg-card">
      <button type="button" className="w-full text-left p-3 flex items-start gap-3" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <ChevronDown className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />}
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={r.status} />
            <span className="font-medium text-sm text-foreground break-words">{r.subject.name}</span>
            <Badge variant="secondary" className="text-[10px]">
              {r.subject.type === "group" ? `group of ${members.length}` : r.subject.type === "aggregate" ? "aggregate" : human(r.subject.entity_type)}
            </Badge>
            {r.provisional && <Badge variant="outline" className="text-[10px] border-yellow-300 text-yellow-800">depends on flagged links</Badge>}
          </div>
          <p className="text-xs text-muted-foreground mt-1 break-words">{r.rule_label}</p>
          {r.exposure !== undefined && r.exposure !== null && (
            <p className="text-xs mt-1">
              <span className="text-foreground font-medium">{cr(r.exposure)}</span>
              {r.exposure_pct !== null && r.exposure_pct !== undefined && (
                <span className="text-muted-foreground">
                  {" "}= {r.exposure_pct}% of {r.base_label ?? "capital"}
                  {r.limit_pct !== null && r.limit_pct !== undefined && ` · limit ${r.limit_pct}%`}
                  {r.allowed_pct !== null && r.allowed_pct !== undefined && r.allowed_pct !== r.limit_pct && ` (allowed ${r.allowed_pct}%)`}
                  {r.headroom !== null && r.headroom !== undefined && ` · ${r.headroom >= 0 ? "headroom" : "excess"} ${cr(Math.abs(r.headroom))}`}
                </span>
              )}
            </p>
          )}
        </div>
      </button>
      {open && (
        <div className="px-3 pb-3 pl-10 space-y-2 text-xs">
          {r.reasons.length > 0 && (
            <ul className="list-disc pl-4 space-y-0.5 text-muted-foreground">
              {r.reasons.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          )}
          {members.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground text-left">
                    <th className="py-1 pr-2 font-medium">Member</th>
                    <th className="py-1 pr-2 font-medium text-right">Exposure</th>
                    <th className="py-1 font-medium">Why it is in the group</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.id} className="border-t border-border align-top">
                      <td className="py-1 pr-2 text-foreground">{m.name}</td>
                      <td className="py-1 pr-2 text-right whitespace-nowrap">{m.excluded ? <span className="text-muted-foreground">{m.excluded}</span> : cr(m.exposure)}</td>
                      <td className="py-1 text-muted-foreground">{m.reason === "anchor" ? "controlling / anchor entity" : m.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {r.links && r.links.length > 0 && (
            <div>
              <p className="font-medium text-foreground mb-0.5">Links used</p>
              <ul className="space-y-0.5">
                {r.links.map((l, i) => (
                  <li key={i} className={cn("text-muted-foreground", l.status === "flagged" && "text-yellow-800")}>
                    {l.label}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
            <SourceLink source={r.source} onOpen={onOpen} />
            {(r.extra_sources ?? []).map((s, i) => (
              <SourceLink key={i} source={s} onOpen={onOpen} />
            ))}
          </div>
          {r.source.verified && r.source.excerpt && (
            <blockquote className="border-l-2 border-border pl-2 text-muted-foreground italic">{r.source.excerpt}</blockquote>
          )}
        </div>
      )}
    </li>
  );
};

interface Props {
  check: Pick<NetworkCheck, "results" | "groups" | "summary" | "notes"> & { message?: string; has_data?: boolean };
  compact?: boolean;
}

/** Findings of a network check: counts, the rows (issues first) and the groups found. */
export const NetworkResults = ({ check, compact }: Props) => {
  const [filter, setFilter] = useState<Filter>("issues");
  const [target, setTarget] = useState<SourceTarget | null>(null);
  const results = useMemo(() => [...(check.results ?? [])].sort((a, b) => rank(a.status) - rank(b.status)), [check.results]);
  const counts = check.summary?.status_counts ?? {};
  const issues = results.filter((r) => ISSUES.has(r.status));
  const shown = filter === "all" ? results : filter === "issues" ? issues : results.filter((r) => r.status === "REPORTABLE");

  if (!check.has_data && !results.length) {
    return (
      <EmptyState
        icon={<Network className="h-5 w-5" />}
        title="No network data for this period"
        description={check.message ?? "Enter counterparties and exposures in the Network tab to run the network check."}
      />
    );
  }

  return (
    <div className="space-y-4">
      {check.summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            ["Counterparties", check.summary.counterparties],
            ["Connected groups", check.summary.groups + (check.summary.provisional_groups ? ` (+${check.summary.provisional_groups} if flagged)` : "")],
            ["Breaches / prohibited", (counts.BREACH ?? 0) + (counts.PROHIBITED ?? 0)],
            ["To review", (counts.POTENTIAL_BREACH ?? 0) + (counts.NEEDS_REVIEW ?? 0) + (counts.ASSESSMENT_REQUIRED ?? 0)],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-lg border border-border bg-background/50 px-3 py-2">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="text-lg font-semibold text-foreground">{value}</p>
            </div>
          ))}
        </div>
      )}

      {check.notes?.length > 0 && (
        <ul className="text-xs text-muted-foreground list-disc pl-4">
          {check.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        {(
          [
            ["issues", `Issues (${issues.length})`],
            ["reportable", `Reportable (${counts.REPORTABLE ?? 0})`],
            ["all", `All checks (${results.length})`],
          ] as [Filter, string][]
        ).map(([f, label]) => (
          <Button key={f} size="sm" variant={filter === f ? "default" : "outline"} onClick={() => setFilter(f)}>
            {label}
          </Button>
        ))}
      </div>

      {shown.length ? (
        <ul className="space-y-2">
          {shown.slice(0, compact ? 50 : 500).map((r) => (
            <ResultRow key={r.id} r={r} onOpen={setTarget} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground py-4 text-center">
          {filter === "issues" ? "No breaches, prohibited exposures or items to review." : "Nothing in this view."}
        </p>
      )}

      {!compact && check.groups?.length > 0 && (
        <div>
          <p className="text-sm font-medium text-foreground mb-2 flex items-center gap-1.5">
            <Users className="h-4 w-4" /> Groups of connected counterparties
          </p>
          <ul className="grid gap-2 md:grid-cols-2">
            {check.groups.map((g) => (
              <li key={g.group_id} className="rounded-lg border border-border p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span className="font-medium text-sm text-foreground">{g.name}</span>
                  {g.basis.map((b) => (
                    <Badge key={b} variant="secondary" className="text-[10px]">{human(b)}</Badge>
                  ))}
                  {g.provisional && <Badge variant="outline" className="text-[10px] border-yellow-300 text-yellow-800">only with flagged links</Badge>}
                </div>
                <p className="text-muted-foreground">{g.members.map((m) => m.name).join(" · ")}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <SourceViewer target={target} onClose={() => setTarget(null)} />
    </div>
  );
};
