import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Building2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { getBanks, type Bank } from "@/lib/api";
import { categoryLabel, useCategories } from "@/lib/categories";
import {
  QUARTER_MONTHS,
  formatPeriod,
  fyOptions,
  getErrorMessage,
  parsePeriod,
  periodForDate,
  type Period,
} from "@/lib/compliance";
import { BankSetup } from "@/components/compliance/BankSetup";
import { QuantitativeForm, type QuantFormState } from "@/components/compliance/QuantitativeForm";
import { QualitativeEvidence, type QualState } from "@/components/compliance/QualitativeEvidence";
import { RunCheck, type RunOutcome } from "@/components/compliance/RunCheck";
import { ResultsView } from "@/components/compliance/ResultsView";
import { RunHistory } from "@/components/compliance/RunHistory";
import { EmptyState, ErrorState } from "@/components/compliance/shared";

type Tab = "setup" | "quant" | "qual" | "run" | "history";
const TABS: Tab[] = ["setup", "quant", "qual", "run", "history"];

const CompliancePage = () => {
  const { toast } = useToast();
  const categories = useCategories(false);
  const [params, setParams] = useSearchParams();

  const [banks, setBanks] = useState<Bank[]>([]);
  const [banksLoading, setBanksLoading] = useState(true);
  const [banksError, setBanksError] = useState<string | null>(null);

  const bankId = params.get("bank") ?? "";
  const period: Period = parsePeriod(params.get("period")) ?? periodForDate(new Date());
  const periodLabel = formatPeriod(period);
  const tabParam = params.get("tab") as Tab | null;
  const tab: Tab = tabParam && TABS.includes(tabParam) ? tabParam : bankId ? "quant" : "setup";

  const [quantState, setQuantState] = useState<QuantFormState | null>(null);
  const [qualState, setQualState] = useState<QualState | null>(null);
  const [lastRun, setLastRun] = useState<RunOutcome | null>(null);
  const [historyKey, setHistoryKey] = useState(0);

  const selectedBank = useMemo(() => banks.find((b) => b.bank_id === bankId) ?? null, [banks, bankId]);
  const unsaved = (quantState?.dirty ?? 0) + (qualState?.unsaved ?? 0);

  const updateParams = useCallback(
    (patch: Record<string, string | null>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          Object.entries(patch).forEach(([k, v]) => (v === null ? next.delete(k) : next.set(k, v)));
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const loadBanks = useCallback(async () => {
    setBanksLoading(true);
    setBanksError(null);
    try {
      setBanks(await getBanks());
    } catch (err) {
      setBanksError(getErrorMessage(err, "Could not load banks."));
    } finally {
      setBanksLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBanks();
  }, [loadBanks]);

  // Drop a stale ?bank= that no longer exists
  useEffect(() => {
    if (!banksLoading && !banksError && bankId && !banks.some((b) => b.bank_id === bankId)) {
      updateParams({ bank: null, tab: "setup" });
      toast({ title: "Bank not found", description: `${bankId} is not registered. Select or create a bank.` });
    }
  }, [banksLoading, banksError, bankId, banks, updateParams, toast]);

  // Warn before leaving the page with unsaved data
  useEffect(() => {
    if (!unsaved) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [unsaved]);

  const confirmDiscard = () =>
    unsaved === 0 ||
    window.confirm(`You have ${unsaved} unsaved entr${unsaved === 1 ? "y" : "ies"}. Switching will discard ${unsaved === 1 ? "it" : "them"}. Continue?`);

  const resetContext = () => {
    setQuantState(null);
    setQualState(null);
    setLastRun(null);
  };

  const selectBank = (id: string) => {
    if (id === bankId) return;
    if (!confirmDiscard()) return;
    resetContext();
    updateParams({ bank: id, tab: tab === "setup" ? "setup" : tab });
  };

  const selectPeriod = (p: Period) => {
    const label = formatPeriod(p);
    if (label === periodLabel) return;
    if (!confirmDiscard()) return;
    resetContext();
    updateParams({ period: label });
  };

  const onBankSaved = (bank: Bank) => {
    const previous = banks.find((b) => b.bank_id === bank.bank_id);
    const exists = !!previous;
    setBanks((bs) => (exists ? bs.map((b) => (b.bank_id === bank.bank_id ? { ...b, ...bank } : b)) : [...bs, bank]));
    if (bank.bank_id !== bankId) {
      resetContext();
      updateParams({ bank: bank.bank_id, tab: "quant" });
    } else if (previous && previous.institution_category !== bank.institution_category) {
      // Category may have changed → applicable rules change; remount forms.
      resetContext();
      setHistoryKey((k) => k + 1);
    }
    loadBanks();
  };

  const onRunComplete = (r: RunOutcome) => {
    setLastRun(r);
    if (r.persisted) setHistoryKey((k) => k + 1);
  };

  const contextKey = `${bankId}|${periodLabel}|${selectedBank?.institution_category ?? ""}`;
  const years = fyOptions();
  if (!years.includes(period.fyStart)) years.push(period.fyStart);

  return (
    <div className="p-4 sm:p-6 md:p-10 max-w-6xl mx-auto">
      <h1 className="font-display text-2xl font-bold text-foreground mb-2">Compliance Checker</h1>
      <p className="text-muted-foreground mb-6">
        Check a bank's reported figures and policy evidence against applicable RBI rules.
      </p>

      <Card className="p-4 mb-5">
        <div className="grid grid-cols-2 lg:grid-cols-[minmax(0,1fr)_160px_170px] gap-3 items-end">
          <div className="space-y-1.5 col-span-2 lg:col-span-1 min-w-0">
            <Label>Bank</Label>
            {banksError && !banks.length ? (
              <ErrorState compact message={banksError} onRetry={loadBanks} retrying={banksLoading} />
            ) : (
              <Select value={selectedBank ? bankId : ""} onValueChange={selectBank} disabled={banksLoading}>
                <SelectTrigger aria-label="Bank">
                  <SelectValue placeholder={banksLoading ? "Loading banks…" : banks.length ? "Select a bank" : "No banks yet"} />
                </SelectTrigger>
                <SelectContent>
                  {banks.map((b) => (
                    <SelectItem key={b.bank_id} value={b.bank_id}>
                      {b.bank_name} ({b.bank_id})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Quarter</Label>
            <Select value={String(period.quarter)} onValueChange={(v) => selectPeriod({ ...period, quarter: Number(v) as Period["quarter"] })}>
              <SelectTrigger aria-label="Quarter"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[1, 2, 3, 4].map((q) => (
                  <SelectItem key={q} value={String(q)}>Q{q} ({QUARTER_MONTHS[q]})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Financial year</Label>
            <Select value={String(period.fyStart)} onValueChange={(v) => selectPeriod({ ...period, fyStart: Number(v) })}>
              <SelectTrigger aria-label="Financial year"><SelectValue /></SelectTrigger>
              <SelectContent>
                {years.sort((a, b) => b - a).map((y) => (
                  <SelectItem key={y} value={String(y)}>FY {y}-{String((y + 1) % 100).padStart(2, "0")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-3 text-xs text-muted-foreground">
          <span>Reporting period</span>
          <Badge variant="outline" className="text-xs">{periodLabel}</Badge>
          {selectedBank && (
            <>
              <span className="ml-1">Category</span>
              <Badge variant="secondary" className="text-xs">{categoryLabel(categories, selectedBank.institution_category)}</Badge>
            </>
          )}
          {unsaved > 0 && <span className="ml-auto text-yellow-800">{unsaved} unsaved</span>}
        </div>
      </Card>

      <Tabs value={tab} onValueChange={(v) => updateParams({ tab: v })}>
        <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 mb-4">
          <TabsList className="w-max sm:w-full justify-start">
            <TabsTrigger value="setup">Bank Setup</TabsTrigger>
            <TabsTrigger value="quant" disabled={!selectedBank}>
              Quantitative{quantState ? ` (${quantState.submitted}/${quantState.total})` : ""}
            </TabsTrigger>
            <TabsTrigger value="qual" disabled={!selectedBank}>
              Qualitative{qualState ? ` (${qualState.saved})` : ""}
            </TabsTrigger>
            <TabsTrigger value="run" disabled={!selectedBank}>Run &amp; Results</TabsTrigger>
            <TabsTrigger value="history" disabled={!selectedBank}>History</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="setup" className="mt-0">
          <BankSetup
            banks={banks}
            loading={banksLoading}
            error={banksError}
            onRetry={loadBanks}
            selectedBank={selectedBank}
            onSelect={selectBank}
            onSaved={onBankSaved}
          />
        </TabsContent>

        {selectedBank ? (
          <>
            {/* Force-mounted so unsaved entries survive tab switches */}
            <TabsContent value="quant" forceMount className="mt-0 data-[state=inactive]:hidden">
              <QuantitativeForm key={contextKey} bankId={bankId} period={periodLabel} onStateChange={setQuantState} />
            </TabsContent>
            <TabsContent value="qual" forceMount className="mt-0 data-[state=inactive]:hidden">
              <QualitativeEvidence key={contextKey} bankId={bankId} period={periodLabel} onStateChange={setQualState} />
            </TabsContent>
            <TabsContent value="run" className="mt-0 space-y-4">
              <RunCheck key={contextKey} bankId={bankId} period={periodLabel} quant={quantState} qual={qualState} onComplete={onRunComplete} />
              {lastRun && (
                <ResultsView
                  key={`${lastRun.run_id}-${lastRun.ranAt}`}
                  runId={lastRun.run_id}
                  period={lastRun.period}
                  runDate={lastRun.ranAt}
                  report={lastRun.report}
                  quant={lastRun.quant_results}
                  qual={lastRun.qual_results}
                  persisted={lastRun.persisted}
                />
              )}
            </TabsContent>
            <TabsContent value="history" className="mt-0">
              <RunHistory key={bankId} bankId={bankId} period={periodLabel} refreshKey={historyKey} />
            </TabsContent>
          </>
        ) : (
          tab !== "setup" && (
            <Card className="p-5">
              <EmptyState
                icon={<Building2 className="h-5 w-5" />}
                title="Select a bank first"
                description="Choose a bank above or create one in Bank Setup."
                action={<Button size="sm" onClick={() => updateParams({ tab: "setup" })}>Go to Bank Setup</Button>}
              />
            </Card>
          )
        )}
      </Tabs>
    </div>
  );
};

export default CompliancePage;
