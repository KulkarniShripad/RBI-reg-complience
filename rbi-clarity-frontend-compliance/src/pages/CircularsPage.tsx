import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, FileText, Loader2, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SourceViewer, type SourceTarget } from "@/components/SourceViewer";
import {
  getDocumentClauses,
  getTopics,
  pdfUrl,
  type DocumentClause,
  type TopicData,
  type TopicDocument,
} from "@/lib/api";

const shortTitle = (t?: string | null) => (t ?? "").replace(/^Reserve Bank of India\s*/i, "").trim();

/** Clause list of one document, searchable; each clause opens in the source viewer. */
const DocumentBrowser = ({ doc, onClose, onOpenClause }: {
  doc: TopicDocument | null;
  onClose: () => void;
  onOpenClause: (c: DocumentClause) => void;
}) => {
  const [clauses, setClauses] = useState<DocumentClause[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!doc) return;
    setLoading(true);
    setFilter("");
    getDocumentClauses(doc.doc_id)
      .then(setClauses)
      .catch(() => setClauses([]))
      .finally(() => setLoading(false));
  }, [doc]);

  const shown = clauses.filter(
    (c) => c.clause_role !== "deleted" && (!filter.trim() || c.clause_text.toLowerCase().includes(filter.toLowerCase())),
  );

  return (
    <Dialog open={!!doc} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-base leading-snug pr-6">{doc?.title}</DialogTitle>
          <DialogDescription className="text-xs">
            {doc?.rbi_ref}
            {doc?.date ? ` · ${doc.date}` : ""} · {doc?.clause_count} provisions · {doc?.rule_count} numeric requirements
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2 items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search within this document…" className="pl-10" />
          </div>
          {doc && (
            <Button variant="outline" size="sm" asChild>
              <a href={pdfUrl(doc.doc_id)} target="_blank" rel="noreferrer">
                PDF <ExternalLink className="h-3 w-3 ml-1" />
              </a>
            </Button>
          )}
        </div>
        <div className="overflow-y-auto -mx-6 px-6 space-y-2 mt-2">
          {loading ? (
            <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : shown.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No provisions match.</p>
          ) : (
            shown.map((c) => (
              <button
                key={c.clause_uri}
                type="button"
                onClick={() => onOpenClause(c)}
                className="w-full text-left rounded-lg border border-border hover:bg-accent/40 p-3"
              >
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                  <span className="font-medium text-foreground">
                    {String(c.paragraph_number).startsWith("Annex") || c.paragraph_number === "preamble" ? c.paragraph_number : `Para ${c.paragraph_number}`}
                  </span>
                  {c.page_number ? <span>p.{c.page_number}</span> : null}
                  {c.clause_role && c.clause_role !== "information" ? <Badge variant="outline" className="text-[10px] font-normal">{c.clause_role}</Badge> : null}
                </div>
                {c.heading_path && <p className="text-[11px] text-muted-foreground mb-1 line-clamp-1">{c.heading_path}</p>}
                <p className="text-sm text-foreground line-clamp-3">{c.clause_text}</p>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

const TopicCard = ({ t, onOpenDoc }: { t: TopicData; onOpenDoc: (d: TopicDocument) => void }) => {
  const [open, setOpen] = useState(false);
  const docs = t.documents ?? [];
  return (
    <Card className="p-5 hover:shadow-md transition-shadow flex flex-col">
      <div className="flex items-start justify-between mb-3 gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold text-foreground">{t.label}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">{t.kind === "subject" ? "Subject area" : "Institution type"}</p>
        </div>
        <div className="h-3 w-3 rounded-full shrink-0 mt-1" style={{ backgroundColor: t.visualization_meta?.cluster_color || "#888" }} />
      </div>
      <div className="flex flex-wrap gap-2 mb-3">
        <Badge variant="secondary" className="text-xs">{t.document_count ?? docs.length} directions</Badge>
        <Badge variant="outline" className="text-xs">{t.rule_count} numeric rules</Badge>
        {t.clause_count ? <Badge variant="outline" className="text-xs">{t.clause_count} provisions</Badge> : null}
      </div>
      {t.subtopics?.length > 0 && (
        <div className="mb-3">
          <p className="text-xs font-medium text-muted-foreground mb-1">{t.kind === "subject" ? "Topics" : "Subjects covered"}</p>
          <div className="flex flex-wrap gap-1">
            {t.subtopics.slice(0, open ? undefined : 6).map((st) => (
              <Badge key={st} variant="outline" className="text-xs font-normal">{st}</Badge>
            ))}
            {!open && t.subtopics.length > 6 && <span className="text-xs text-muted-foreground">+{t.subtopics.length - 6} more</span>}
          </div>
        </div>
      )}
      <Button variant="ghost" size="sm" className="mt-auto self-start px-2 h-8" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronUp className="h-4 w-4 mr-1" /> : <ChevronDown className="h-4 w-4 mr-1" />}
        {open ? "Hide directions" : "Show directions"}
      </Button>
      {open && (
        <ul className="mt-2 space-y-1 max-h-72 overflow-y-auto">
          {docs.map((d) => (
            <li key={d.doc_id}>
              <button type="button" onClick={() => onOpenDoc(d)} className="w-full text-left flex items-start gap-1.5 text-xs text-foreground hover:text-primary py-1">
                <FileText className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
                <span>
                  {t.kind === "subject" ? shortTitle(d.title) : d.topic || shortTitle(d.title)}
                  {d.rbi_ref ? <span className="text-muted-foreground"> · {d.rbi_ref}</span> : null}
                  {d.uploaded ? <Badge variant="secondary" className="ml-1 text-[10px] px-1 py-0">uploaded</Badge> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
};

const CircularsPage = () => {
  const [institutions, setInstitutions] = useState<TopicData[]>([]);
  const [subjects, setSubjects] = useState<TopicData[]>([]);
  const [view, setView] = useState<"institution" | "subject">("institution");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doc, setDoc] = useState<TopicDocument | null>(null);
  const [viewing, setViewing] = useState<SourceTarget | null>(null);

  useEffect(() => {
    setLoading(true);
    getTopics()
      .then((data) => {
        setInstitutions(data.topics ?? []);
        setSubjects(data.families ?? []);
      })
      .catch(() => setError("Could not load topics from the backend."))
      .finally(() => setLoading(false));
  }, []);

  const list = view === "institution" ? institutions : subjects;
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return list;
    return list.filter(
      (t) =>
        t.label.toLowerCase().includes(s) ||
        t.subtopics?.some((st) => st.toLowerCase().includes(s)) ||
        t.documents?.some((d) => d.title.toLowerCase().includes(s) || (d.rbi_ref ?? "").toLowerCase().includes(s)),
    );
  }, [list, search]);

  return (
    <div className="p-6 md:p-10 w-full">
      <h1 className="font-display text-2xl font-bold text-foreground mb-2">Browse Circulars & Topics</h1>
      <p className="text-muted-foreground mb-6">
        Topics are built from the directions in the knowledge base, so newly uploaded circulars appear here automatically.
      </p>

      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <Tabs value={view} onValueChange={(v) => setView(v as "institution" | "subject")}>
          <TabsList>
            <TabsTrigger value="institution">By institution type ({institutions.length})</TabsTrigger>
            <TabsTrigger value="subject">By subject ({subjects.length})</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search topics or directions..." className="pl-10" />
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : error ? (
        <p className="text-center py-20 text-destructive">{error}</p>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          <FileText className="h-10 w-10 mx-auto mb-3 opacity-40" />
          <p>No topics found. Upload circulars to populate the database.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 items-start">
          {filtered.map((t) => <TopicCard key={`${view}-${t.topic_id}`} t={t} onOpenDoc={setDoc} />)}
        </div>
      )}

      <DocumentBrowser
        doc={doc}
        onClose={() => setDoc(null)}
        onOpenClause={(c) => setViewing({ clauseUri: c.clause_uri, preview: { clause_text: c.clause_text, doc_title: doc?.title, rbi_ref: doc?.rbi_ref, paragraph: c.paragraph_number, page: c.page_number, doc_id: doc?.doc_id } })}
      />
      <SourceViewer target={viewing} onClose={() => setViewing(null)} />
    </div>
  );
};

export default CircularsPage;
