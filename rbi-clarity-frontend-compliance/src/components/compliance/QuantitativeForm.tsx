import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { AlertTriangle, Calculator, CheckCircle, Loader2, Save, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  getApplicableRules,
  getQuantitativeSubmissions,
  submitQuantitativeData,
  type ApplicableRule,
  type QuantitativeSubmission,
  type QuantitativeSubmissionInput,
  type QuantitativeSubmissionResult,
  type SubmissionFlag,
} from "@/lib/api";
import {
  WARNING_BADGE,
  flagText,
  formatThreshold,
  getErrorMessage,
  parseNumber,
  ruleLabel,
  validateNumber,
} from "@/lib/compliance";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState, LoadingState, SectionHeading } from "./shared";

export interface QuantFormState {
  total: number;
  submitted: number;
  dirty: number;
  /** rule_id → label shown on the form, for rules that have a saved value */
  labels: Record<string, string>;
}

interface Row {
  value: string;
  note: string;
  savedValue: string | null;
  savedNote: string;
  error: string | null;
  flags: SubmissionFlag[];
}

const blankRow = (): Row => ({ value: "", note: "", savedValue: null, savedNote: "", error: null, flags: [] });

type Filter = "all" | "pending" | "submitted" | "issues";

const isDirty = (r: Row) => r.value.trim() !== "" && (r.value.trim() !== (r.savedValue ?? "") || r.note.trim() !== r.savedNote);

const timeOf = (s: QuantitativeSubmission) => {
  const t = Date.parse(s.submitted_at || s.created_at || "");
  return Number.isNaN(t) ? 0 : t;
};

interface Props {
  bankId: string;
  period: string;
  onStateChange: (s: QuantFormState) => void;
}

export const QuantitativeForm = ({ bankId, period, onStateChange }: Props) => {
  const { toast } = useToast();
  const [rules, setRules] = useState<ApplicableRule[]>([]);
  const [rows, setRows] = useState<Record<number, Row>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const savingRef = useRef(false);

  const applySubmissions = useCallback(
    (subs: QuantitativeSubmission[]) => {
      const latest = new Map<number, QuantitativeSubmission>();
      subs
        .filter((s) => s.period_label === period)
        .forEach((s) => {
          const prev = latest.get(Number(s.rule_id));
          // Later timestamp wins; equal/missing timestamps fall back to array order (last wins).
          if (!prev || timeOf(s) >= timeOf(prev)) latest.set(Number(s.rule_id), s);
        });
      setRows((current) => {
        const next = { ...current };
        latest.forEach((s, ruleId) => {
          const row = next[ruleId] ?? blankRow();
          const savedValue = s.reported_value === null || s.reported_value === undefined ? null : String(s.reported_value);
          const savedNote = s.source_note ?? "";
          const keepEdits = isDirty(row);
          next[ruleId] = {
            ...row,
            savedValue,
            savedNote,
            value: keepEdits ? row.value : savedValue ?? "",
            note: keepEdits ? row.note : savedNote,
            flags: s.flags ?? row.flags,
          };
        });
        return next;
      });
    },
    [period],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRestoreError(null);
    try {
      const [rulesRes, subsRes] = await Promise.allSettled([
        getApplicableRules(bankId, period),
        getQuantitativeSubmissions(bankId),
      ]);
      if (rulesRes.status === "rejected") {
        setError(getErrorMessage(rulesRes.reason, "Could not load applicable rules."));
        return;
      }
      setRules(rulesRes.value);
      setRows((current) => {
        const next: Record<number, Row> = {};
        rulesRes.value.forEach((r) => (next[r.rule_id] = current[r.rule_id] ?? blankRow()));
        return next;
      });
      if (subsRes.status === "fulfilled") applySubmissions(subsRes.value);
      else setRestoreError(getErrorMessage(subsRes.reason, "Could not restore saved values."));
    } finally {
      setLoading(false);
    }
  }, [bankId, period, applySubmissions]);

  useEffect(() => {
    load();
  }, [load]);

  const retryRestore = async () => {
    setRestoring(true);
    try {
      applySubmissions(await getQuantitativeSubmissions(bankId));
      setRestoreError(null);
    } catch (err) {
      setRestoreError(getErrorMessage(err, "Could not restore saved values."));
    } finally {
      setRestoring(false);
    }
  };

  const isSubmitted = useCallback(
    (r: ApplicableRule) => rows[r.rule_id]?.savedValue !== null && rows[r.rule_id]?.savedValue !== undefined
      ? true
      : !!r.already_submitted,
    [rows],
  );

  // Report state upward (readiness + labels for LLM mapping check)
  const summary = useMemo<QuantFormState>(() => {
    const labels: Record<string, string> = {};
    let submitted = 0;
    let dirty = 0;
    rules.forEach((r) => {
      const row = rows[r.rule_id];
      if (isSubmitted(r)) {
        submitted++;
        labels[String(r.rule_id)] = ruleLabel(r);
      }
      if (row && isDirty(row)) dirty++;
    });
    return { total: rules.length, submitted, dirty, labels };
  }, [rules, rows, isSubmitted]);

  useEffect(() => {
    onStateChange(summary);
  }, [summary, onStateChange]);

  const updateRow = (ruleId: number, patch: Partial<Row>) =>
    setRows((rs) => ({ ...rs, [ruleId]: { ...(rs[ruleId] ?? blankRow()), ...patch } }));

  const applyResults = (results: QuantitativeSubmissionResult[], sent: QuantitativeSubmissionInput[]) => {
    const byRule = new Map(results.map((r) => [Number(r.rule_id), r]));
    // Decide outcomes eagerly (state updaters run lazily, so counts must not be computed inside them).
    const outcomes = sent.map((s) => {
      const res = byRule.get(s.rule_id);
      const flags = res?.flags ?? [];
      // A 2xx response without a per-rule entry is treated as accepted.
      const ok = !res || res.ok !== false;
      const error = ok
        ? null
        : res?.error || res?.detail || (flags.length ? flags.map(flagText).join("; ") : "Rejected by the backend");
      return { ruleId: s.rule_id, ok, flags, error };
    });
    setRows((current) => {
      const next = { ...current };
      outcomes.forEach((o) => {
        const row = next[o.ruleId] ?? blankRow();
        next[o.ruleId] = o.ok
          ? { ...row, savedValue: row.value.trim(), savedNote: row.note.trim(), error: null, flags: o.flags }
          : { ...row, error: o.error, flags: o.flags };
      });
      return next;
    });
    return {
      ok: outcomes.filter((o) => o.ok).length,
      rejected: outcomes.filter((o) => !o.ok).length,
      flagged: outcomes.filter((o) => o.ok && o.flags.length).length,
    };
  };

  const handleSave = async () => {
    if (savingRef.current) return;
    const dirtyIds = rules.map((r) => r.rule_id).filter((id) => rows[id] && isDirty(rows[id]));
    if (!dirtyIds.length) {
      toast({ title: "Nothing to save", description: "Enter or change a value first." });
      return;
    }
    let invalid = 0;
    const validationErrors: Record<number, string> = {};
    dirtyIds.forEach((id) => {
      const msg = validateNumber(rows[id].value);
      if (msg) {
        validationErrors[id] = msg;
        invalid++;
      }
    });
    if (invalid) {
      setRows((rs) => {
        const next = { ...rs };
        Object.entries(validationErrors).forEach(([id, msg]) => (next[Number(id)] = { ...next[Number(id)], error: msg }));
        return next;
      });
      setFilter("issues");
      toast({ title: "Fix invalid values", description: `${invalid} field(s) need a valid number.`, variant: "destructive" });
      return;
    }

    const payload: QuantitativeSubmissionInput[] = dirtyIds.map((id) => ({
      rule_id: id,
      reported_value: parseNumber(rows[id].value),
      period_label: period,
      source_note: rows[id].note.trim() || "Manual entry",
    }));

    savingRef.current = true;
    setSaving(true);
    try {
      const results = await submitQuantitativeData(bankId, payload);
      const { ok, rejected, flagged } = applyResults(results, payload);
      if (rejected) {
        setFilter("issues");
        toast({
          title: "Some values were rejected",
          description: `${ok} saved, ${rejected} rejected. Entered values have been kept.`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Quantitative data saved",
          description: `${ok} value(s) saved for ${period}${flagged ? `, ${flagged} with anomaly flags` : ""}.`,
        });
      }
    } catch (err) {
      // Per-rule errors may come back in a 4xx body using the same shape
      const body = axios.isAxiosError(err) ? err.response?.data : null;
      if (Array.isArray(body) && body.some((b) => b && typeof b === "object" && "rule_id" in b)) {
        const { ok, rejected } = applyResults(body as QuantitativeSubmissionResult[], payload);
        setFilter("issues");
        toast({ title: "Some values were rejected", description: `${ok} saved, ${rejected} rejected.`, variant: "destructive" });
      } else {
        toast({
          title: "Could not save values",
          description: `${getErrorMessage(err)} Your entries are kept — try again.`,
          variant: "destructive",
        });
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rules.filter((r) => {
      const row = rows[r.rule_id];
      if (filter === "pending" && isSubmitted(r)) return false;
      if (filter === "submitted" && !isSubmitted(r)) return false;
      if (filter === "issues" && !(row?.error || row?.flags.length || r.mapping_status === "unverified")) return false;
      if (!q) return true;
      return [ruleLabel(r), r.variable_text, r.rbi_ref, r.clause_text, String(r.rule_id)]
        .filter(Boolean)
        .some((t) => String(t).toLowerCase().includes(q));
    });
  }, [rules, rows, query, filter, isSubmitted]);

  if (loading) return <Card className="p-5"><LoadingState label="Loading applicable rules…" /></Card>;
  if (error) return <Card className="p-5"><ErrorState message={error} onRetry={load} /></Card>;
  if (!rules.length)
    return (
      <Card className="p-5">
        <EmptyState
          icon={<Calculator className="h-5 w-5" />}
          title="No quantitative rules apply"
          description={`The backend returned no numeric rules for this bank's category in ${period}.`}
          action={<Button variant="outline" size="sm" onClick={load}>Reload</Button>}
        />
      </Card>
    );

  const filters: { id: Filter; label: string }[] = [
    { id: "all", label: `All (${rules.length})` },
    { id: "pending", label: `Pending (${rules.length - summary.submitted})` },
    { id: "submitted", label: `Submitted (${summary.submitted})` },
    { id: "issues", label: "Issues" },
  ];

  return (
    <Card className="p-4 sm:p-5">
      <SectionHeading
        title="Quantitative data"
        description={`Enter reported figures for ${period}. Thresholds come from the backend rule set.`}
      />

      {restoreError && (
        <div className="mb-4">
          <ErrorState
            compact
            message={`Saved values could not be restored: ${restoreError}`}
            onRetry={retryRestore}
            retrying={restoring}
          />
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-2 mb-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search label, variable or RBI reference…"
            className="pl-9"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {filters.map((f) => (
            <Button
              key={f.id}
              size="sm"
              variant={filter === f.id ? "default" : "outline"}
              onClick={() => setFilter(f.id)}
              className="h-9"
            >
              {f.label}
            </Button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState title="No rules match" description="Adjust the search or filter." />
      ) : (
        <ul className="divide-y divide-border border border-border rounded-lg">
          {visible.map((r) => {
            const row = rows[r.rule_id] ?? blankRow();
            const label = ruleLabel(r);
            const showVariable = !!r.form_label?.trim() && !!r.variable_text?.trim() && r.form_label.trim() !== r.variable_text.trim();
            const submitted = isSubmitted(r);
            const dirty = isDirty(row);
            const clauseOpen = !!expanded[r.rule_id];
            const shortUnit = !!r.threshold_unit && r.threshold_unit.trim().length <= 5;
            return (
              <li key={r.rule_id} className="p-3 sm:p-4">
                <div className="flex flex-col md:flex-row md:items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
                      <p className="text-sm font-medium text-foreground break-words">{label}</p>
                      {submitted && !dirty && (
                        <Badge variant="outline" className="text-[10px] px-2 py-0 bg-green-100 text-green-800 border-green-300">
                          <CheckCircle className="h-3 w-3 mr-1" /> Submitted
                        </Badge>
                      )}
                      {dirty && (
                        <Badge variant="outline" className="text-[10px] px-2 py-0">Unsaved</Badge>
                      )}
                      {r.mapping_status === "unverified" && (
                        <Badge variant="outline" className={cn("text-[10px] px-2 py-0", WARNING_BADGE)}>
                          Unverified mapping
                        </Badge>
                      )}
                      {r.computed_by_network && (
                        <Badge
                          variant="outline"
                          className="text-[10px] px-2 py-0 bg-blue-50 text-blue-800 border-blue-200"
                          title="Aggregated over the counterparty network in the Network tab"
                        >
                          Computed by network check
                        </Badge>
                      )}
                    </div>
                    {showVariable && (
                      <p className="text-xs text-muted-foreground mt-0.5 break-words">Variable: {r.variable_text}</p>
                    )}
                    <div className="flex flex-wrap items-center gap-1.5 mt-2">
                      <Badge variant="secondary" className="text-xs">
                        {formatThreshold(r.operator, r.threshold_value, r.threshold_unit)}
                      </Badge>
                      {r.rbi_ref && <Badge variant="outline" className="text-xs font-normal">{r.rbi_ref}</Badge>}
                      {r.page_number !== null && r.page_number !== undefined && r.page_number !== "" && (
                        <span className="text-xs text-muted-foreground">Page {r.page_number}</span>
                      )}
                      <span className="text-xs text-muted-foreground">Rule {r.rule_id}</span>
                    </div>
                    {r.clause_text && (
                      <div className="mt-2">
                        <p className={cn("text-xs text-muted-foreground break-words", !clauseOpen && "line-clamp-2")}>
                          {r.clause_text}
                        </p>
                        {r.clause_text.length > 160 && (
                          <button
                            type="button"
                            className="text-xs text-primary hover:underline mt-0.5"
                            onClick={() => setExpanded((e) => ({ ...e, [r.rule_id]: !clauseOpen }))}
                          >
                            {clauseOpen ? "Show less" : "Show full clause"}
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-1 lg:grid-cols-2 gap-2 md:w-72 lg:w-96 shrink-0">
                    <div>
                      <div className="relative">
                        <Input
                          inputMode="decimal"
                          aria-label={`Reported value for ${label}`}
                          value={row.value}
                          disabled={saving}
                          placeholder="Reported value"
                          onChange={(e) => updateRow(r.rule_id, { value: e.target.value, error: null })}
                          onBlur={(e) => {
                            const msg = validateNumber(e.target.value);
                            if (msg) updateRow(r.rule_id, { error: msg });
                          }}
                          aria-invalid={!!row.error}
                          className={cn(shortUnit && "pr-12", row.error && "border-destructive")}
                        />
                        {shortUnit && (
                          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none max-w-[3rem] truncate">
                            {r.threshold_unit}
                          </span>
                        )}
                      </div>
                      {r.threshold_unit && !shortUnit && (
                        <p className="text-xs text-muted-foreground mt-1 break-words">Unit: {r.threshold_unit}</p>
                      )}
                    </div>
                    <Input
                      aria-label={`Source note for ${label}`}
                      value={row.note}
                      disabled={saving}
                      placeholder="Source note (optional)"
                      onChange={(e) => updateRow(r.rule_id, { note: e.target.value })}
                    />
                    {row.value.trim() === "" && row.savedValue !== null && (
                      <p className="text-xs text-muted-foreground sm:col-span-2 md:col-span-1 lg:col-span-2">
                        Saved value {row.savedValue} is kept. Enter a new value to replace it.
                      </p>
                    )}
                  </div>
                </div>

                {(row.error || row.flags.length > 0) && (
                  <div className="mt-2 space-y-1">
                    {row.error && <p className="text-xs text-destructive" role="alert">{row.error}</p>}
                    {row.flags.map((f, i) => (
                      <p key={i} className="text-xs text-yellow-800 flex items-start gap-1.5">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />
                        <span className="break-words">Anomaly flag: {flagText(f)}</span>
                      </p>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="sticky bottom-0 -mx-4 sm:-mx-5 -mb-4 sm:-mb-5 mt-4 px-4 sm:px-5 py-3 bg-card border-t border-border rounded-b-lg flex flex-col sm:flex-row sm:items-center gap-2 justify-between">
        <p className="text-sm text-muted-foreground">
          {summary.submitted} of {summary.total} submitted
          {summary.dirty > 0 && <span className="text-foreground font-medium"> · {summary.dirty} unsaved</span>}
        </p>
        <Button onClick={handleSave} disabled={saving || summary.dirty === 0}>
          {saving ? (
            <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Saving…</>
          ) : (
            <><Save className="h-4 w-4 mr-1.5" /> Save {summary.dirty || ""} value{summary.dirty === 1 ? "" : "s"}</>
          )}
        </Button>
      </div>
    </Card>
  );
};
