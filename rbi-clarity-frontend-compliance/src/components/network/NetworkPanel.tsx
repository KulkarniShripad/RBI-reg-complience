import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Flag, FlaskConical, Loader2, Network, Pencil, Play, Plus, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import type { Bank } from "@/lib/api";
import { getErrorMessage } from "@/lib/compliance";
import {
  CAPITAL_FIELDS,
  EDGE_LABELS,
  ECON_CRITERIA,
  SELF,
  capitalFieldsFor,
  deleteEdge,
  deleteEntity,
  deleteExposure,
  getNetwork,
  getNetworkRules,
  getScenarios,
  getVocabulary,
  human,
  loadScenario,
  reviewEdge,
  runNetworkCheck,
  saveCapital,
  saveEdges,
  saveEntities,
  saveExposures,
  saveProfile,
  type NetworkCapital,
  type NetworkCheck,
  type NetworkData,
  type NetworkEdge,
  type NetworkEntity,
  type NetworkRule,
  type Scenario,
  type Vocabulary,
} from "@/lib/network";
import { EmptyState, ErrorState, LoadingState, SectionHeading, StatusBadge } from "@/components/compliance/shared";
import { NetworkGraph, NetworkLegend } from "./NetworkGraph";
import { NetworkResults, SourceLink } from "./NetworkResults";
import { EdgeDialog, EntityDialog, ExposureDialog } from "./NetworkForms";
import { NetworkImport } from "./NetworkImport";
import { SourceViewer, type SourceTarget } from "@/components/SourceViewer";

interface Props {
  bank: Bank;
  period: string;
  /** A sample network was opened as a new demo bank - switch to it. */
  onOpenBank: (bankId: string) => void;
}

type Sub = "graph" | "findings" | "parties" | "links" | "exposures" | "import" | "rules";

const cr = (x: number | null | undefined) => (x === null || x === undefined ? "–" : `₹${Number(x).toLocaleString("en-IN", { maximumFractionDigits: 2 })} cr`);

const edgeDetail = (e: NetworkEdge) => {
  if (e.edge_type === "OWNS") return `${e.ownership_pct}%`;
  if (e.edge_type === "CONTROLS") return e.basis ? human(e.basis) : "";
  if (e.edge_type === "ECONOMIC_DEPENDENCE") return `${e.criterion ? `criterion ${e.criterion}` : ""}${e.bidirectional ? " · two-way" : ""}`;
  if (e.edge_type === "INTERESTED_IN") return human(e.role);
  if (e.edge_type === "RELATIVE_OF") return human(e.relation);
  return "";
};

export const NetworkPanel = ({ bank, period, onOpenBank }: Props) => {
  const { toast } = useToast();
  const bankId = bank.bank_id;
  const category = bank.institution_category;
  const [vocab, setVocab] = useState<Vocabulary | null>(null);
  const [data, setData] = useState<NetworkData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<NetworkCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [includeFlagged, setIncludeFlagged] = useState(true);
  const [sub, setSub] = useState<Sub>("graph");
  const [selected, setSelected] = useState<string | null>(null);
  const [highlightGroup, setHighlightGroup] = useState<string | null>(null);
  const [entityDialog, setEntityDialog] = useState<{ open: boolean; initial: NetworkEntity | null }>({ open: false, initial: null });
  const [edgeDialog, setEdgeDialog] = useState(false);
  const [exposureDialog, setExposureDialog] = useState(false);
  const [scenarioDialog, setScenarioDialog] = useState(false);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [scenarioNote, setScenarioNote] = useState("");
  const [loadingScenario, setLoadingScenario] = useState<string | null>(null);
  const [rules, setRules] = useState<NetworkRule[] | null>(null);
  const [capital, setCapital] = useState<Record<string, string>>({});
  const [savingCapital, setSavingCapital] = useState(false);
  const [sourceTarget, setSourceTarget] = useState<SourceTarget | null>(null);

  const runCheck = useCallback(
    async (opts: { persist?: boolean; quiet?: boolean } = {}) => {
      setChecking(true);
      try {
        const res = await runNetworkCheck(bankId, period, { include_flagged: includeFlagged, persist: opts.persist });
        setCheck(res);
        if (!opts.quiet) {
          const c = res.summary?.status_counts ?? {};
          toast({
            title: "Network check complete",
            description: res.has_data
              ? `${(c.BREACH ?? 0) + (c.PROHIBITED ?? 0)} breach / prohibited, ${(c.POTENTIAL_BREACH ?? 0) + (c.NEEDS_REVIEW ?? 0) + (c.ASSESSMENT_REQUIRED ?? 0)} to review${res.graph_run_id ? ` · saved as run #${res.graph_run_id}` : ""}.`
              : res.message,
          });
        }
      } catch (err) {
        if (!opts.quiet) toast({ title: "Network check failed", description: getErrorMessage(err), variant: "destructive" });
      } finally {
        setChecking(false);
      }
    },
    [bankId, period, includeFlagged, toast],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [v, d] = await Promise.all([getVocabulary(), getNetwork(bankId, period)]);
      setVocab(v);
      setData(d);
      setCapital(Object.fromEntries(CAPITAL_FIELDS.map((f) => [f.key, d.capital?.[f.key] == null ? "" : String(d.capital[f.key])])));
      await runCheck({ quiet: true });
    } catch (err) {
      setError(getErrorMessage(err, "Could not load the network."));
    } finally {
      setLoading(false);
    }
  }, [bankId, period, runCheck]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bankId, period]);

  // Re-evaluate when the flagged-links switch changes.
  useEffect(() => {
    if (data) runCheck({ quiet: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeFlagged]);

  useEffect(() => {
    if (sub === "rules" && !rules) getNetworkRules(category).then(setRules).catch(() => setRules([]));
  }, [sub, rules, category]);

  const refresh = async () => {
    const d = await getNetwork(bankId, period);
    setData(d);
    await runCheck({ quiet: true });
  };

  const guard = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      await refresh();
      if (done) toast({ title: done });
    } catch (err) {
      toast({ title: "Not saved", description: getErrorMessage(err), variant: "destructive" });
    }
  };

  const openScenarios = async () => {
    setScenarioDialog(true);
    if (!scenarios.length) {
      try {
        const s = await getScenarios();
        setScenarios(s.scenarios);
        setScenarioNote(s.note);
      } catch (err) {
        toast({ title: "Could not load samples", description: getErrorMessage(err), variant: "destructive" });
      }
    }
  };

  const applyScenario = async (sc: Scenario, intoThisBank: boolean) => {
    if (intoThisBank && !window.confirm(`Replace ${bank.bank_name}'s counterparty network (and its ${period} exposures) with this sample?`)) return;
    setLoadingScenario(sc.id);
    try {
      const r = await loadScenario(sc.id, { period_label: period, bank_id: intoThisBank ? bankId : undefined });
      setScenarioDialog(false);
      toast({ title: "Sample network loaded", description: `${r.imported.entities} counterparties, ${r.imported.edges} relationships, ${r.imported.exposures} exposures.` });
      if (r.bank_id !== bankId) onOpenBank(r.bank_id);
      else await load();
    } catch (err) {
      toast({ title: "Could not load the sample", description: getErrorMessage(err), variant: "destructive" });
    } finally {
      setLoadingScenario(null);
    }
  };

  const saveCapitalForm = async () => {
    setSavingCapital(true);
    try {
      const body: NetworkCapital = Object.fromEntries(
        CAPITAL_FIELDS.map((f) => [f.key, capital[f.key] === "" || capital[f.key] === undefined ? null : Number(capital[f.key])]),
      );
      await saveCapital(bankId, period, body);
      await refresh();
      toast({ title: "Capital saved", description: `Capital base for ${period} updated.` });
    } catch (err) {
      toast({ title: "Capital not saved", description: getErrorMessage(err), variant: "destructive" });
    } finally {
      setSavingCapital(false);
    }
  };

  const review = (edge: NetworkEdge, status: string) => {
    const note =
      status === "rebutted"
        ? window.prompt("Why does this link not create a single risk? (e.g. demonstrated to RBI, alternative buyers / funding available)")
        : status === "confirmed"
          ? window.prompt("Evidence for confirming this link (optional)") ?? ""
          : "";
    if (note === null) return;
    guard(() => reviewEdge(bankId, edge.edge_id!, status, note || undefined), `Relationship ${status}`);
  };

  const entities = useMemo(() => data?.entities ?? [], [data]);
  const nameOf = useMemo(() => {
    const m = new Map(entities.map((e) => [e.entity_id, e.name]));
    return (id: string) => (id === SELF ? `${bank.bank_name} (this bank)` : m.get(id) ?? id);
  }, [entities, bank.bank_name]);
  const exposureBy = useMemo(() => {
    const m = new Map<string, number>();
    (data?.exposures ?? []).forEach((x) => m.set(x.entity_id, (m.get(x.entity_id) ?? 0) + Number(x.amount)));
    return m;
  }, [data]);

  const graphNodes = check?.has_data
    ? check.graph.nodes
    : entities.map((e) => ({ id: e.entity_id, name: e.entity_id === SELF ? bank.bank_name : e.name, entity_type: e.entity_type, exposure: exposureBy.get(e.entity_id) ?? 0, exempt: 0, exposure_pct: null, status: null, group_ids: [], bank_group: e.group_relation ?? null }));
  const graphLinks = check?.has_data
    ? check.graph.edges
    : (data?.edges ?? []).map((e) => ({ id: e.edge_id ?? `${e.from_entity}-${e.to_entity}`, source: e.from_entity, target: e.to_entity, edge_type: e.edge_type, status: e.status ?? "confirmed", label: `${nameOf(e.from_entity)} ${EDGE_LABELS[e.edge_type] ?? e.edge_type} ${nameOf(e.to_entity)}` }));
  // Drawing thousands of nodes is unreadable (and slow): above MAX_DRAWN show
  // the counterparties with findings, the largest exposures, the highlighted
  // group and the selected node, and say so.
  const MAX_DRAWN = 300;
  const drawn = useMemo(() => {
    if (graphNodes.length <= MAX_DRAWN) return { nodes: graphNodes, links: graphLinks, trimmed: 0 };
    const keep = new Set<string>([SELF]);
    const issue = new Set(["PROHIBITED", "BREACH", "POTENTIAL_BREACH", "NEEDS_REVIEW", "ASSESSMENT_REQUIRED"]);
    graphNodes.filter((n) => n.status && issue.has(n.status)).forEach((n) => keep.add(n.id));
    const hl = highlightGroup ? check?.groups.find((g) => g.group_id === highlightGroup)?.members.map((m) => m.id) ?? [] : [];
    hl.forEach((id) => keep.add(id));
    if (selected) keep.add(selected);
    [...graphNodes].sort((a, b) => b.exposure - a.exposure).forEach((n) => keep.size < MAX_DRAWN && keep.add(n.id));
    const nodes = graphNodes.filter((n) => keep.has(n.id));
    const links = graphLinks.filter((l) => keep.has(l.source) && keep.has(l.target));
    return { nodes, links, trimmed: graphNodes.length - nodes.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [check, data, highlightGroup, selected]);
  const highlightIds = highlightGroup ? check?.groups.find((g) => g.group_id === highlightGroup)?.members.map((m) => m.id) ?? null : null;
  const selectedFindings = selected ? (check?.results ?? []).filter((r) => r.subject.id === selected || r.subject.members?.some((m) => m.id === selected)) : [];
  const flagged = (data?.edges ?? []).filter((e) => e.status === "flagged");
  const needed = capitalFieldsFor(category);
  const counts = check?.summary?.status_counts ?? {};

  if (loading && !data) return <Card className="p-5"><LoadingState label="Loading counterparty network…" /></Card>;
  if (error || !data || !vocab) return <Card className="p-5"><ErrorState message={error ?? "Could not load the network."} onRetry={load} retrying={loading} /></Card>;

  return (
    <div className="space-y-4">
      <Card className="p-4 sm:p-5">
        <SectionHeading
          title="Counterparty network"
          actions={
            <>
              <Button variant="outline" size="sm" onClick={openScenarios}>
                <FlaskConical className="h-4 w-4 mr-1.5" /> Sample networks
              </Button>
              <Button size="sm" onClick={() => runCheck({ persist: true })} disabled={checking}>
                {checking ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Play className="h-4 w-4 mr-1.5" />}
                Run &amp; save check
              </Button>
            </>
          }
        />

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Capital base for {period} (₹ crore)</p>
            <div className="grid grid-cols-2 gap-2">
              {CAPITAL_FIELDS.filter((f) => needed.includes(f.key)).map((f) => (
                <div key={f.key} className="space-y-1">
                  <Label htmlFor={`cap-${f.key}`} className="text-xs">{f.label}</Label>
                  <Input id={`cap-${f.key}`} inputMode="decimal" value={capital[f.key] ?? ""} onChange={(e) => setCapital((c) => ({ ...c, [f.key]: e.target.value }))} title={f.hint} />
                </div>
              ))}
            </div>
            <Button size="sm" variant="outline" className="mt-2" onClick={saveCapitalForm} disabled={savingCapital}>
              {savingCapital && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}Save capital
            </Button>
          </div>
          <div className="space-y-3">
            {category === "nbfc" && (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">NBFC layer</Label>
                  <Select value={data.profile?.nbfc_layer ?? ""} onValueChange={(v) => guard(() => saveProfile(bankId, { ...data.profile, nbfc_layer: v }), "Profile saved")}>
                    <SelectTrigger aria-label="NBFC layer"><SelectValue placeholder="Select layer" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="BL">Base layer</SelectItem>
                      <SelectItem value="ML">Middle layer</SelectItem>
                      <SelectItem value="UL">Upper layer</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <label className="flex items-end gap-2 text-sm pb-2">
                  <Switch checked={!!data.profile?.nbfc_is_ifc} onCheckedChange={(v) => guard(() => saveProfile(bankId, { ...data.profile, nbfc_is_ifc: v ? 1 : 0 }), "Profile saved")} />
                  Infrastructure Finance Company
                </label>
              </div>
            )}
            {category === "rural_cooperative_banks" && (
              <div className="space-y-1 max-w-[200px]">
                <Label className="text-xs">NABARD inspection rating</Label>
                <Select value={data.profile?.rcb_rating ?? ""} onValueChange={(v) => guard(() => saveProfile(bankId, { ...data.profile, rcb_rating: v }), "Profile saved")}>
                  <SelectTrigger aria-label="NABARD rating"><SelectValue placeholder="Select rating" /></SelectTrigger>
                  <SelectContent>
                    {["A", "B+", "B", "C", "D"].map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
              <div>
                <Label htmlFor="incl-flagged">Consider flagged links</Label>
              </div>
              <Switch id="incl-flagged" checked={includeFlagged} onCheckedChange={setIncludeFlagged} />
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline">{entities.length - 1} counterparties</Badge>
              <Badge variant="outline">{data.edges.length} relationships</Badge>
              <Badge variant="outline">{data.exposures.length} exposures in {period}</Badge>
              {flagged.length > 0 && <Badge variant="outline" className="border-yellow-300 text-yellow-800">{flagged.length} flagged to review</Badge>}
              {check?.summary?.overall && <StatusBadge status={check.summary.overall} />}
            </div>
          </div>
        </div>
      </Card>

      <Tabs value={sub} onValueChange={(v) => setSub(v as Sub)}>
        <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
          <TabsList className="w-max">
            <TabsTrigger value="graph">Graph</TabsTrigger>
            <TabsTrigger value="findings">
              Findings{check?.has_data ? ` (${(counts.BREACH ?? 0) + (counts.PROHIBITED ?? 0) + (counts.POTENTIAL_BREACH ?? 0) + (counts.NEEDS_REVIEW ?? 0) + (counts.ASSESSMENT_REQUIRED ?? 0)})` : ""}
            </TabsTrigger>
            <TabsTrigger value="parties">Counterparties</TabsTrigger>
            <TabsTrigger value="links">Relationships{flagged.length ? ` (${flagged.length} flagged)` : ""}</TabsTrigger>
            <TabsTrigger value="exposures">Exposures</TabsTrigger>
            <TabsTrigger value="import">Import / export</TabsTrigger>
            <TabsTrigger value="rules">Rules checked</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="graph" className="mt-3">
          {entities.length <= 1 ? (
            <Card className="p-5">
              <EmptyState
                icon={<Network className="h-5 w-5" />}
                title="No counterparties yet"
                description="Add counterparties, relationships and exposures, import them from CSV, or open a sample network to see how the check works."
                action={
                  <div className="flex flex-wrap gap-2 justify-center">
                    <Button size="sm" onClick={() => setEntityDialog({ open: true, initial: null })}><Plus className="h-4 w-4 mr-1" /> Add counterparty</Button>
                    <Button size="sm" variant="outline" onClick={openScenarios}><FlaskConical className="h-4 w-4 mr-1" /> Sample networks</Button>
                  </div>
                }
              />
            </Card>
          ) : (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
              <Card className="p-3">
                {drawn.trimmed > 0 && (
                  <p className="text-xs text-muted-foreground mb-2">
                    Showing {drawn.nodes.length} of {graphNodes.length} parties: those with findings, the largest exposures and the selected group. Every party is still checked.
                  </p>
                )}
                <NetworkGraph nodes={drawn.nodes} links={drawn.links} selectedId={selected} highlight={highlightIds} onSelect={setSelected} />
                <NetworkLegend />
              </Card>
              <div className="space-y-3">
                {check?.groups && check.groups.length > 0 && (
                  <Card className="p-3">
                    <p className="text-sm font-medium mb-2">Connected groups</p>
                    <div className="flex flex-wrap gap-1.5">
                      {check.groups.map((g) => (
                        <Button key={g.group_id} size="sm" variant={highlightGroup === g.group_id ? "default" : "outline"} className="h-7 text-xs" onClick={() => setHighlightGroup((h) => (h === g.group_id ? null : g.group_id))}>
                          {g.name} ({g.members.length}){g.provisional ? " ?" : ""}
                        </Button>
                      ))}
                    </div>
                  </Card>
                )}
                <Card className="p-3 text-sm">
                  {selected ? (
                    <div className="space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-medium break-words">{nameOf(selected)}</p>
                        <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setSelected(null)} aria-label="Close details"><X className="h-3.5 w-3.5" /></Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {selected === SELF ? "The reporting bank" : `${human(entities.find((e) => e.entity_id === selected)?.entity_type)} · ${selected}`}
                        {exposureBy.get(selected) ? ` · exposure ${cr(exposureBy.get(selected))}` : ""}
                      </p>
                      <div>
                        <p className="text-xs font-medium mb-1">Relationships</p>
                        <ul className="text-xs text-muted-foreground space-y-0.5">
                          {data.edges.filter((e) => e.from_entity === selected || e.to_entity === selected).map((e) => (
                            <li key={e.edge_id} className={e.status === "rebutted" ? "line-through" : e.status === "flagged" ? "text-yellow-800" : ""}>
                              {nameOf(e.from_entity)} — {EDGE_LABELS[e.edge_type] ?? e.edge_type} {edgeDetail(e) && `(${edgeDetail(e)})`} → {nameOf(e.to_entity)}
                            </li>
                          ))}
                        </ul>
                      </div>
                      {selectedFindings.length > 0 && (
                        <div>
                          <p className="text-xs font-medium mb-1">Findings</p>
                          <ul className="space-y-1.5">
                            {selectedFindings.slice(0, 8).map((r) => (
                              <li key={r.id} className="text-xs">
                                <StatusBadge status={r.status} className="mr-1.5" />
                                {r.rule_label}
                                {r.exposure_pct != null && ` · ${r.exposure_pct}% vs ${r.limit_pct}%`}
                                <div><SourceLink source={r.source} onOpen={setSourceTarget} /></div>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">Select a node to see its relationships and findings. Select a group to highlight its members.</p>
                  )}
                </Card>
                {check?.summary?.largest_exposures && check.summary.largest_exposures.length > 0 && (
                  <Card className="p-3">
                    <p className="text-sm font-medium mb-2">Largest exposures</p>
                    <ul className="text-xs space-y-1">
                      {check.summary.largest_exposures.slice(0, 8).map((x) => (
                        <li key={x.id} className="flex justify-between gap-2">
                          <button type="button" className="truncate text-left hover:underline" onClick={() => setSelected(x.id)}>{x.name}</button>
                          <span className="text-muted-foreground whitespace-nowrap">{cr(x.exposure)}{x.exposure_pct != null ? ` · ${x.exposure_pct}%` : ""}</span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="findings" className="mt-3">
          <Card className="p-4 sm:p-5">
            {check ? <NetworkResults check={check} /> : <LoadingState label="Running the network check…" />}
            {check && !check.applicable && <p className="text-sm text-muted-foreground mt-3">{check.message}</p>}
          </Card>
        </TabsContent>

        <TabsContent value="parties" className="mt-3">
          <Card className="p-4 sm:p-5">
            <SectionHeading
              title="Counterparties"
              actions={<Button size="sm" onClick={() => setEntityDialog({ open: true, initial: null })}><Plus className="h-4 w-4 mr-1" /> Add</Button>}
            />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border">
                    <th className="py-2 pr-3 font-medium">Name</th>
                    <th className="py-2 pr-3 font-medium">ID</th>
                    <th className="py-2 pr-3 font-medium">Type</th>
                    <th className="py-2 pr-3 font-medium">Bank's group</th>
                    <th className="py-2 pr-3 font-medium text-right">Exposure</th>
                    <th className="py-2 font-medium sr-only">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {entities.filter((e) => e.entity_id !== SELF).map((e) => (
                    <tr key={e.entity_id} className="border-b border-border last:border-0">
                      <td className="py-2 pr-3">{e.name}</td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground break-all">{e.entity_id}</td>
                      <td className="py-2 pr-3">{human(e.entity_type)}</td>
                      <td className="py-2 pr-3 text-xs">{e.group_relation ? human(e.group_relation) : ""}</td>
                      <td className="py-2 pr-3 text-right whitespace-nowrap">{exposureBy.get(e.entity_id) ? cr(exposureBy.get(e.entity_id)) : "–"}</td>
                      <td className="py-2 text-right whitespace-nowrap">
                        <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Edit ${e.name}`} onClick={() => setEntityDialog({ open: true, initial: e })}><Pencil className="h-3.5 w-3.5" /></Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          aria-label={`Delete ${e.name}`}
                          onClick={() => window.confirm(`Delete ${e.name} with its relationships and exposures?`) && guard(() => deleteEntity(bankId, e.entity_id), "Counterparty deleted")}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {entities.length <= 1 && <p className="text-sm text-muted-foreground py-6 text-center">No counterparties yet.</p>}
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="links" className="mt-3">
          <Card className="p-4 sm:p-5">
            <SectionHeading
              title="Relationships"
              actions={<Button size="sm" onClick={() => setEdgeDialog(true)} disabled={entities.length <= 1}><Plus className="h-4 w-4 mr-1" /> Add</Button>}
            />
            <ul className="space-y-2">
              {[...data.edges].sort((a, b) => (a.status === "flagged" ? -1 : 0) - (b.status === "flagged" ? -1 : 0)).map((e) => (
                <li key={e.edge_id} className="rounded-lg border border-border p-3 text-sm flex flex-col sm:flex-row sm:items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className={e.status === "rebutted" ? "line-through text-muted-foreground" : ""}>
                      <span className="font-medium">{nameOf(e.from_entity)}</span> <span className="text-muted-foreground">{EDGE_LABELS[e.edge_type] ?? e.edge_type}</span>{" "}
                      <span className="font-medium">{nameOf(e.to_entity)}</span> {edgeDetail(e) && <Badge variant="secondary" className="text-[10px] ml-1">{edgeDetail(e)}</Badge>}
                    </div>
                    {e.edge_type === "ECONOMIC_DEPENDENCE" && e.criterion ? <p className="text-xs text-muted-foreground">{ECON_CRITERIA[e.criterion]}</p> : null}
                    {e.evidence && <p className="text-xs text-muted-foreground mt-0.5">Evidence: {e.evidence}</p>}
                    {e.review_note && <p className="text-xs text-muted-foreground mt-0.5">Review note: {e.review_note}</p>}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Badge variant="outline" className={e.status === "flagged" ? "border-yellow-300 text-yellow-800" : e.status === "rebutted" ? "text-muted-foreground" : "border-green-300 text-green-800"}>
                      {e.status}
                    </Badge>
                    {e.status !== "confirmed" && <Button size="icon" variant="ghost" className="h-7 w-7" title="Confirm" aria-label="Confirm link" onClick={() => review(e, "confirmed")}><Check className="h-3.5 w-3.5" /></Button>}
                    {e.status !== "flagged" && <Button size="icon" variant="ghost" className="h-7 w-7" title="Flag for review" aria-label="Flag link" onClick={() => review(e, "flagged")}><Flag className="h-3.5 w-3.5" /></Button>}
                    {e.status !== "rebutted" && <Button size="icon" variant="ghost" className="h-7 w-7" title="Rebut" aria-label="Rebut link" onClick={() => review(e, "rebutted")}><X className="h-3.5 w-3.5" /></Button>}
                    <Button size="icon" variant="ghost" className="h-7 w-7" title="Delete" aria-label="Delete link" onClick={() => window.confirm("Delete this relationship?") && guard(() => deleteEdge(bankId, e.edge_id!), "Relationship deleted")}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                </li>
              ))}
            </ul>
            {!data.edges.length && <p className="text-sm text-muted-foreground py-6 text-center">No relationships yet.</p>}
          </Card>
        </TabsContent>

        <TabsContent value="exposures" className="mt-3">
          <Card className="p-4 sm:p-5">
            <SectionHeading
              title={`Exposures in ${period}`}
              actions={<Button size="sm" onClick={() => setExposureDialog(true)} disabled={entities.length <= 1}><Plus className="h-4 w-4 mr-1" /> Add</Button>}
            />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border">
                    <th className="py-2 pr-3 font-medium">Counterparty</th>
                    <th className="py-2 pr-3 font-medium">Kind</th>
                    <th className="py-2 pr-3 font-medium text-right">Amount</th>
                    <th className="py-2 pr-3 font-medium">Mitigation / flags</th>
                    <th className="py-2 font-medium sr-only">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.exposures.map((x) => (
                    <tr key={x.exposure_id} className="border-b border-border last:border-0 align-top">
                      <td className="py-2 pr-3">{nameOf(x.entity_id)}</td>
                      <td className="py-2 pr-3">{human(x.exposure_kind)}</td>
                      <td className="py-2 pr-3 text-right whitespace-nowrap">
                        {cr(x.amount)}
                        {x.sanctioned_limit ? <div className="text-xs text-muted-foreground">limit {cr(x.sanctioned_limit)}</div> : null}
                      </td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground">
                        {[
                          x.crm_amount ? `CRM ${cr(x.crm_amount)}${x.crm_provider ? ` from ${nameOf(x.crm_provider)}` : ""}` : null,
                          x.infrastructure ? "infrastructure" : null,
                          x.exempt_reason ? `exempt: ${human(x.exempt_reason)}` : null,
                          x.board_approved_excess ? "Board-approved excess" : null,
                          x.section20_exception ? `exception: ${x.section20_exception}` : null,
                        ].filter(Boolean).join(" · ")}
                      </td>
                      <td className="py-2 text-right">
                        <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Delete exposure" onClick={() => window.confirm("Delete this exposure?") && guard(() => deleteExposure(bankId, x.exposure_id!), "Exposure deleted")}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!data.exposures.length && (
                <p className="text-sm text-muted-foreground py-6 text-center">
                  No exposures for {period}.{data.periods.length ? ` Other periods with data: ${data.periods.map((p) => p.period_label).join(", ")}.` : ""}
                </p>
              )}
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="import" className="mt-3">
          <NetworkImport bankId={bankId} period={period} onImported={load} />
        </TabsContent>

        <TabsContent value="rules" className="mt-3">
          <Card className="p-4 sm:p-5">
            <SectionHeading title="Rules the network check applies" />
            {!rules ? (
              <LoadingState label="Loading rules…" />
            ) : rules.length ? (
              <ul className="space-y-2">
                {rules.map((r) => (
                  <li key={r.key} className="rounded-lg border border-border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{r.label}</span>
                      <Badge variant="secondary" className="text-[10px]">{human(r.kind)}</Badge>
                      {!r.source.verified && <Badge variant="outline" className="text-[10px] border-yellow-300 text-yellow-800">not applied</Badge>}
                    </div>
                    {r.source.verified && r.source.excerpt && <p className="text-xs text-muted-foreground mt-1 italic">{r.source.excerpt}</p>}
                    <div className="mt-1"><SourceLink source={r.source} onOpen={setSourceTarget} /></div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No counterparty-concentration or related-party rules are encoded for this institution category (none were found in its directions).</p>
            )}
          </Card>
        </TabsContent>
      </Tabs>

      <EntityDialog
        open={entityDialog.open}
        onOpenChange={(o) => setEntityDialog((d) => ({ ...d, open: o }))}
        vocab={vocab}
        initial={entityDialog.initial}
        existingIds={new Set(entities.map((e) => e.entity_id))}
        onSave={async (e) => {
          await saveEntities(bankId, [e]);
          await refresh();
        }}
      />
      <EdgeDialog
        open={edgeDialog}
        onOpenChange={setEdgeDialog}
        vocab={vocab}
        entities={entities}
        bankName={bank.bank_name}
        onSave={async (e) => {
          await saveEdges(bankId, [e]);
          await refresh();
        }}
      />
      <ExposureDialog
        open={exposureDialog}
        onOpenChange={setExposureDialog}
        vocab={vocab}
        entities={entities}
        period={period}
        category={category}
        onSave={async (x) => {
          await saveExposures(bankId, period, [x]);
          await refresh();
        }}
      />

      <Dialog open={scenarioDialog} onOpenChange={setScenarioDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Sample networks</DialogTitle>
            <DialogDescription>{scenarioNote || "Synthetic networks that show how the check works."}</DialogDescription>
          </DialogHeader>
          <ul className="space-y-3">
            {scenarios.map((sc) => (
              <li key={sc.id} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-sm">{sc.title}</span>
                  <Badge variant="secondary" className="text-[10px]">{human(sc.category)}</Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-1">{sc.description}</p>
                <div className="flex flex-wrap gap-2 mt-2">
                  <Button size="sm" onClick={() => applyScenario(sc, false)} disabled={!!loadingScenario}>
                    {loadingScenario === sc.id && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}Open as a demo bank
                  </Button>
                  {sc.category === category && (
                    <Button size="sm" variant="outline" onClick={() => applyScenario(sc, true)} disabled={!!loadingScenario}>
                      Load into {bank.bank_name}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>

      <SourceViewer target={sourceTarget} onClose={() => setSourceTarget(null)} />
    </div>
  );
};
