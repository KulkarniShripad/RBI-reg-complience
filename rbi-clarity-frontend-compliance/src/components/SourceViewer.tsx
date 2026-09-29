import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, FileText, Link2, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { getClause, pdfUrl, simplifyClause, type ChatSource, type ClauseDetail, type ClauseSimplification } from "@/lib/api";

const OPS: Record<string, string> = { "<=": "≤", ">=": "≥", "<": "<", ">": ">", within_days: "within" };

const unit = (u?: string | null) => (!u ? "" : u === "%" ? "%" : ` ${u.replace(/_/g, " ")}`);

/** Split text around the snippet the answer was matched on, so it can be highlighted. */
const highlightParts = (text: string, snippet?: string | null) => {
  if (!snippet) return [{ text, hit: false }];
  const probe = snippet.replace(/\s+/g, " ").trim().slice(0, 120);
  const flat = text.replace(/\s+/g, " ");
  const idx = probe.length > 20 ? flat.indexOf(probe) : -1;
  if (idx < 0) return [{ text, hit: false }];
  const end = Math.min(flat.length, idx + snippet.replace(/\s+/g, " ").trim().length);
  return [
    { text: flat.slice(0, idx), hit: false },
    { text: flat.slice(idx, end), hit: true },
    { text: flat.slice(end), hit: false },
  ];
};

export interface SourceTarget {
  clauseUri: string;
  /** Data already known from the chat response (shown instantly while details load). */
  preview?: Partial<ChatSource>;
  highlight?: string | null;
  label?: string;
}

interface Props {
  target: SourceTarget | null;
  onClose: () => void;
}

/**
 * Side panel showing the exact provision an answer (or rule) comes from:
 * full paragraph text, document and RBI reference, page, extracted numeric
 * requirements, cross-references, footnotes, neighbouring paragraphs, and a
 * link that opens the original PDF at that page.
 */
export const SourceViewer = ({ target, onClose }: Props) => {
  const [history, setHistory] = useState<SourceTarget[]>([]);
  const [current, setCurrent] = useState<SourceTarget | null>(target);
  const [detail, setDetail] = useState<ClauseDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plain, setPlain] = useState<ClauseSimplification | null>(null);
  const [plainLoading, setPlainLoading] = useState(false);

  useEffect(() => {
    setCurrent(target);
    setHistory([]);
  }, [target]);

  useEffect(() => {
    if (!current) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setDetail(null);
    setPlain(null);
    getClause(current.clauseUri)
      .then((d) => alive && setDetail(d))
      .catch(() => alive && setError("Could not load the full provision from the server."))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [current]);

  const go = (uri: string) => {
    if (current) setHistory((h) => [...h, current]);
    setCurrent({ clauseUri: uri });
  };
  const togglePlain = () => {
    if (plain) return setPlain(null);
    if (!current) return;
    setPlainLoading(true);
    simplifyClause(current.clauseUri)
      .then(setPlain)
      .catch(() => setError("Could not simplify this provision."))
      .finally(() => setPlainLoading(false));
  };
  const back = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setCurrent(prev);
  };

  const p = current?.preview;
  const text = detail?.clause_text ?? p?.clause_text ?? "";
  const docTitle = detail?.document?.title ?? p?.doc_title ?? "";
  const rbiRef = detail?.document?.rbi_ref ?? p?.rbi_ref;
  const page = detail?.page_number ?? p?.page ?? null;
  const pageEnd = detail?.page_end ?? p?.page_end ?? null;
  const paragraph = detail?.paragraph_number ?? p?.paragraph;
  const heading = detail?.heading_path ?? p?.heading_path;
  const cats = detail?.document?.categories ?? p?.categories?.map((c) => ({ id: c.id ?? c.category ?? "", label: c.label })) ?? [];
  const docId = detail?.doc_id ?? p?.doc_id;
  const atoms = (detail?.rule_atoms ?? p?.rule_atoms ?? []).filter((a) => a.atom_kind !== "condition");
  const parts = useMemo(() => highlightParts(text, current?.highlight ?? p?.snippet), [text, current, p]);

  return (
    <Sheet open={!!target} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader className="text-left pr-6">
          <SheetTitle className="text-base leading-snug">
            {paragraph ? (String(paragraph).startsWith("Annex") || paragraph === "preamble" ? String(paragraph) : `Paragraph ${paragraph}`) : "Source"}
            {current?.label ? <span className="text-muted-foreground font-normal"> · {current.label}</span> : null}
          </SheetTitle>
          <SheetDescription className="text-xs leading-relaxed">
            {docTitle}
            {rbiRef ? ` · ${rbiRef}` : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {cats.map((c) => (
              <Badge key={c.id || c.label} variant="secondary" className="text-xs font-normal">{c.label}</Badge>
            ))}
            {page ? (
              <Badge variant="outline" className="text-xs font-normal">
                Page {page}
                {pageEnd && pageEnd !== page ? `–${pageEnd}` : ""}
              </Badge>
            ) : null}
            {history.length > 0 && (
              <Button variant="ghost" size="sm" className="h-7 px-2 ml-auto" onClick={back}>
                <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back
              </Button>
            )}
          </div>

          {heading && <p className="text-xs text-muted-foreground">{heading}</p>}

          <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm leading-relaxed whitespace-pre-wrap break-words">
            {text ? (
              parts.map((part, i) =>
                part.hit ? (
                  <mark key={i} className="bg-yellow-200/70 dark:bg-yellow-500/30 rounded px-0.5">{part.text}</mark>
                ) : (
                  <span key={i}>{part.text}</span>
                ),
              )
            ) : loading ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <span className="text-muted-foreground">No text available.</span>
            )}
          </div>

          {text && current && (
            <div className="space-y-2">
              <Button variant="outline" size="sm" className="h-7" onClick={togglePlain} disabled={plainLoading}>
                {plainLoading && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                {plain ? "Hide plain language" : "Plain language"}
              </Button>
              {plain && (
                <div className="rounded-lg border border-border p-3 text-sm leading-relaxed">
                  <p>{plain.simplified}</p>
                  {plain.fkgl_original !== null && plain.fkgl_simplified !== null && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Reading grade {plain.fkgl_original} → {plain.fkgl_simplified}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {docId && (
            <a
              href={pdfUrl(docId, page)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              <FileText className="h-4 w-4" /> Open the original PDF{page ? ` at page ${page}` : ""}
              <ExternalLink className="h-3 w-3" />
            </a>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}

          {atoms.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-foreground mb-1.5">Numeric requirements extracted from this paragraph</h4>
              <ul className="space-y-1">
                {atoms.slice(0, 8).map((a) => (
                  <li key={a.rule_id} className="text-xs rounded-md bg-muted px-2 py-1.5">
                    <span className="font-medium">{a.variable_text || "Value"}</span>{" "}
                    {OPS[a.operator] ?? a.operator} {a.threshold_value}
                    {unit(a.threshold_unit)}
                    {a.threshold_base ? ` of ${a.threshold_base}` : ""}
                    {a.confidence === "low" && <span className="text-muted-foreground"> (needs review)</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {detail?.cross_references?.length ? (
            <div>
              <h4 className="text-xs font-medium text-foreground mb-1.5 flex items-center gap-1">
                <Link2 className="h-3.5 w-3.5" /> Referenced provisions
              </h4>
              <ul className="space-y-1">
                {detail.cross_references.slice(0, 10).map((x, i) => (
                  <li key={i} className="text-xs">
                    {x.resolved_target_clause_uri ? (
                      <button className="text-primary hover:underline text-left" onClick={() => go(x.resolved_target_clause_uri!)}>
                        {x.ref_type === "annex" ? `Annex ${x.target_annex}` : `Paragraph ${x.target_paragraph}`}
                        {x.target_clause_text ? ` — ${x.target_clause_text.slice(0, 90)}…` : ""}
                      </button>
                    ) : (
                      <span className="text-muted-foreground">
                        {x.ref_type === "document" ? x.target_doc_title || x.target_text : x.ref_type === "annex" ? `Annex ${x.target_annex}` : `Paragraph ${x.target_paragraph}`}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {detail?.footnotes?.length ? (
            <div>
              <h4 className="text-xs font-medium text-foreground mb-1.5">Footnotes on these pages</h4>
              <ul className="space-y-1">
                {detail.footnotes.slice(0, 6).map((f, i) => (
                  <li key={i} className="text-xs text-muted-foreground">p.{f.page_number}: {f.footnote_text}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {(detail?.previous || detail?.next) && (
            <div className="flex justify-between gap-2 pt-2 border-t border-border">
              {detail?.previous ? (
                <Button variant="outline" size="sm" onClick={() => go(detail.previous!.clause_uri)}>
                  <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Para {detail.previous.paragraph_number}
                </Button>
              ) : <span />}
              {detail?.next ? (
                <Button variant="outline" size="sm" onClick={() => go(detail.next!.clause_uri)}>
                  Para {detail.next.paragraph_number} <ArrowRight className="h-3.5 w-3.5 ml-1" />
                </Button>
              ) : <span />}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
};
