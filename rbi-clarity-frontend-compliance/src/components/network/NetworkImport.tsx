import { useState } from "react";
import { Download, FileJson, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/compliance";
import { downloadText, parseCsv, toCsv } from "@/lib/csv";
import { exportNetwork, human, importNetwork, validationDetails, type ValidationDetail } from "@/lib/network";
import { SectionHeading } from "@/components/compliance/shared";

type Table = "entities" | "edges" | "exposures";

const TEMPLATES: Record<Table, { header: string[]; example: Record<string, string>[]; help: string }> = {
  entities: {
    header: ["entity_id", "name", "entity_type", "group_relation", "ite_class", "gold_loan_nbfc", "section8_company", "government_company", "non_strategic_investor", "pan", "cin", "lei"],
    example: [
      { entity_id: "L17110MH1973PLC019786", name: "Example Holdings Ltd", entity_type: "company" },
      { entity_id: "L17110MH1990PLC054828", name: "Example Steel Ltd", entity_type: "company" },
      { entity_id: "DIR-001", name: "A. Director", entity_type: "individual" },
    ],
    help: "entity_type: company, individual, firm, trust, bank, nbfc, insurer, government, ccp, fund, other. Flags: yes / no.",
  },
  edges: {
    header: ["from_entity", "to_entity", "edge_type", "ownership_pct", "basis", "criterion", "role", "relation", "bidirectional", "status", "evidence"],
    example: [
      { from_entity: "L17110MH1973PLC019786", to_entity: "L17110MH1990PLC054828", edge_type: "OWNS", ownership_pct: "62", status: "confirmed", evidence: "shareholding pattern Mar-2026" },
      { from_entity: "DIR-001", to_entity: "SELF", edge_type: "DIRECTOR_OF", status: "confirmed" },
    ],
    help: "edge_type: OWNS, CONTROLS, COMMON_MANAGEMENT, ECONOMIC_DEPENDENCE, DIRECTOR_OF, INTERESTED_IN, RELATIVE_OF, PROMOTER_OF. Use SELF for this bank. status: confirmed, flagged, rebutted.",
  },
  exposures: {
    header: ["entity_id", "exposure_kind", "amount", "sanctioned_limit", "crm_amount", "crm_provider", "infrastructure", "exempt_reason", "board_approved_excess", "section20_exception", "note"],
    example: [
      { entity_id: "L17110MH1973PLC019786", exposure_kind: "fund_based", amount: "120.5" },
      { entity_id: "L17110MH1990PLC054828", exposure_kind: "non_fund_based", amount: "40" },
    ],
    help: "Amounts in ₹ crore for the selected period. exposure_kind: fund_based, non_fund_based, investment, equity, interbank, derivative.",
  },
};

interface Props {
  bankId: string;
  period: string;
  onImported: () => void;
}

/** CSV import per table (templates included) and whole-network JSON import / export. */
export const NetworkImport = ({ bankId, period, onImported }: Props) => {
  const { toast } = useToast();
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [problems, setProblems] = useState<{ message: string; details: ValidationDetail[] } | null>(null);

  const send = async (label: string, bundle: Record<string, unknown>) => {
    setBusy(label);
    setProblems(null);
    try {
      const r = await importNetwork(bankId, period, bundle, replace);
      toast({ title: "Imported", description: `${r.entities} counterparties, ${r.edges} relationships, ${r.exposures} exposures${r.replaced ? " (replaced the previous network)" : ""}.` });
      onImported();
    } catch (err) {
      setProblems({ message: getErrorMessage(err, "Import failed."), details: validationDetails(err) });
    } finally {
      setBusy(null);
    }
  };

  const onCsv = async (table: Table, file: File | undefined) => {
    if (!file) return;
    const rows = parseCsv(await file.text());
    if (!rows.length) {
      setProblems({ message: `${file.name} has no data rows.`, details: [] });
      return;
    }
    await send(table, { [table]: rows });
  };

  const onJson = async (file: File | undefined) => {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      await send("json", data);
    } catch (err) {
      setProblems({ message: `Could not read ${file.name}: ${getErrorMessage(err, "invalid JSON")}`, details: [] });
    }
  };

  const doExport = async () => {
    setBusy("export");
    try {
      const data = await exportNetwork(bankId, period);
      downloadText(`network-${bankId}-${period}.json`, JSON.stringify(data, null, 2), "application/json");
    } catch (err) {
      toast({ title: "Export failed", description: getErrorMessage(err), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="p-4 sm:p-5">
      <SectionHeading
        title="Import and export"
        description={`Load counterparties, relationships and ${period} exposures from CSV or a JSON file. Everything is validated first; nothing is saved if any row is invalid.`}
        actions={
          <Button variant="outline" size="sm" onClick={doExport} disabled={!!busy}>
            {busy === "export" ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Download className="h-4 w-4 mr-1.5" />}
            Export JSON
          </Button>
        }
      />
      <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3 mb-4">
        <div>
          <Label htmlFor="replace">Replace existing network</Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Off: rows are added or updated. On: all counterparties and relationships, and this period's exposures, are deleted first.
          </p>
        </div>
        <Switch id="replace" checked={replace} onCheckedChange={setReplace} />
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {(Object.keys(TEMPLATES) as Table[]).map((t) => (
          <div key={t} className="rounded-lg border border-border p-3 flex flex-col">
            <p className="font-medium text-sm">{human(t === "edges" ? "relationships" : t === "entities" ? "counterparties" : t)}</p>
            <p className="text-xs text-muted-foreground mt-1 flex-1">{TEMPLATES[t].help}</p>
            <div className="flex flex-wrap gap-2 mt-3">
              <Button variant="outline" size="sm" onClick={() => downloadText(`${t}-template.csv`, toCsv(TEMPLATES[t].header, TEMPLATES[t].example))}>
                <Download className="h-3.5 w-3.5 mr-1" /> Template
              </Button>
              <Button size="sm" asChild disabled={!!busy}>
                <label className="cursor-pointer">
                  {busy === t ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Upload className="h-3.5 w-3.5 mr-1" />}
                  Upload CSV
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    className="sr-only"
                    onChange={(e) => {
                      onCsv(t, e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
              </Button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3">
        <Button variant="outline" size="sm" asChild disabled={!!busy}>
          <label className="cursor-pointer">
            {busy === "json" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <FileJson className="h-3.5 w-3.5 mr-1" />}
            Import JSON (entities, edges, exposures, capital, profile)
            <input
              type="file"
              accept=".json,application/json"
              className="sr-only"
              onChange={(e) => {
                onJson(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
        </Button>
      </div>

      {problems && (
        <div role="alert" className="mt-4 rounded-md border border-destructive/30 bg-red-50 p-3 text-sm">
          <p>{problems.message}</p>
          {problems.details.length > 0 && (
            <ul className="list-disc pl-4 mt-1 text-xs text-muted-foreground max-h-48 overflow-y-auto">
              {problems.details.map((d, i) => (
                <li key={i}>
                  {d.table ? `${d.table}` : ""}
                  {d.row ? ` row ${d.row}` : ""}
                  {d.field ? ` · ${d.field}` : ""}: {d.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
};
