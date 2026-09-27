import { useCallback, useEffect, useState } from "react";
import { BookOpen, ChevronLeft, ChevronRight, FileText, Loader2, Search, Tag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SourceViewer, type SourceTarget } from "@/components/SourceViewer";
import { getRules, getTopics, type RuleDetail, type TopicData } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

const KINDS = [
  { id: "requirement", label: "Requirements (limits a bank must meet)" },
  { id: "condition", label: "Conditions / thresholds that define scope" },
  { id: "all", label: "All numeric thresholds" },
];

const RulesPage = () => {
  const [rules, setRules] = useState<RuleDetail[]>([]);
  const [loading, setLoading] = useState(false);
  const [institutions, setInstitutions] = useState<TopicData[]>([]);
  const [subjects, setSubjects] = useState<TopicData[]>([]);
  const [selectedTopic, setSelectedTopic] = useState<string>("all");
  const [kind, setKind] = useState<string>("requirement");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [selectedRule, setSelectedRule] = useState<RuleDetail | null>(null);
  const [viewing, setViewing] = useState<SourceTarget | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    getTopics()
      .then((data) => {
        setInstitutions(data.topics || []);
        setSubjects(data.families || []);
      })
      .catch(() => {});
  }, []);

  const fetchRules = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = { page, per_page: 20, kind };
      if (selectedTopic !== "all") params.topic = selectedTopic;
      if (search.trim()) params.search = search.trim();
      const data = await getRules(params);
      setRules(data.rules);
      setTotalPages(data.pages);
      setTotal(data.total);
    } catch {
      toast({ title: "Error", description: "Failed to fetch rules.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [page, selectedTopic, kind, search, toast]);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  useEffect(() => {
    setPage(1);
  }, [selectedTopic, kind, search]);

  const openSource = (rule: RuleDetail) => {
    if (!rule.clause_uri) return;
    setViewing({
      clauseUri: rule.clause_uri,
      preview: { clause_text: rule.clause_text, doc_title: rule.document_title, rbi_ref: rule.source_circular_id, paragraph: rule.section_number, page: rule.page, doc_id: rule.doc_id },
      highlight: rule.plain_language_summary,
      label: `Rule ${rule.rule_id}`,
    });
  };

  return (
    <div className="p-6 md:p-10 max-w-5xl mx-auto">
      <h1 className="font-display text-2xl font-bold text-foreground mb-2">Compliance Rules</h1>
      <p className="text-muted-foreground mb-6">
        Numeric thresholds extracted from the directions. Each rule links to the paragraph it was read from; rules marked
        “needs review” were extracted with lower confidence.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        <Select value={selectedTopic} onValueChange={setSelectedTopic}>
          <SelectTrigger aria-label="Topic"><SelectValue placeholder="All topics" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All institution types & subjects</SelectItem>
            {institutions.length > 0 && (
              <SelectGroup>
                <SelectLabel>Institution type</SelectLabel>
                {institutions.map((t) => <SelectItem key={t.topic_id} value={t.topic_id}>{t.label}</SelectItem>)}
              </SelectGroup>
            )}
            {subjects.length > 0 && (
              <SelectGroup>
                <SelectLabel>Subject</SelectLabel>
                {subjects.map((t) => <SelectItem key={`f-${t.topic_id}`} value={t.topic_id}>{t.label}</SelectItem>)}
              </SelectGroup>
            )}
          </SelectContent>
        </Select>

        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger aria-label="Rule kind"><SelectValue /></SelectTrigger>
          <SelectContent>
            {KINDS.map((k) => <SelectItem key={k.id} value={k.id}>{k.label}</SelectItem>)}
          </SelectContent>
        </Select>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search rules..." className="pl-10" />
        </div>
      </div>

      <p className="text-sm text-muted-foreground mb-4">{total} rules found</p>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : rules.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          <BookOpen className="h-10 w-10 mx-auto mb-3 opacity-40" />
          <p>No rules found. Try adjusting your filters.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rules.map((rule) => (
            <Card key={rule.rule_id} className="p-4 hover:shadow-md transition-shadow cursor-pointer" onClick={() => setSelectedRule(rule)}>
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2 mb-2">
                <h3 className="font-semibold text-foreground text-sm">{rule.title}</h3>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant="secondary" className="text-xs">{rule.topic_label || rule.topic}</Badge>
                  {rule.confidence === "low" && <Badge variant="outline" className="text-xs bg-yellow-100 text-yellow-800 border-yellow-300">needs review</Badge>}
                </div>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed line-clamp-2">{rule.plain_language_summary}</p>
              <p className="text-xs text-muted-foreground mt-2">
                {rule.source_circular_id}{rule.section_number ? ` · Para ${rule.section_number}` : ""}{rule.page ? ` · p.${rule.page}` : ""}
              </p>
            </Card>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-4 mt-6">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft className="h-4 w-4 mr-1" /> Previous
          </Button>
          <span className="text-sm text-muted-foreground">Page {page} of {totalPages}</span>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            Next <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </div>
      )}

      <Dialog open={!!selectedRule} onOpenChange={(open) => !open && setSelectedRule(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          {selectedRule && (
            <>
              <DialogHeader>
                <DialogTitle className="text-lg leading-tight pr-6">{selectedRule.title}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 mt-2">
                <div className="flex flex-wrap gap-2">
                  <Badge>{selectedRule.topic_label || selectedRule.topic}</Badge>
                  <Badge variant="outline">{selectedRule.atom_kind === "condition" ? "Condition / scope threshold" : "Requirement"}</Badge>
                  <Badge variant="outline">{selectedRule.confidence === "high" ? "High extraction confidence" : "Needs review"}</Badge>
                </div>
                <div>
                  <h4 className="text-sm font-medium text-foreground mb-1">Sentence it was extracted from</h4>
                  <p className="text-sm text-muted-foreground leading-relaxed">{selectedRule.plain_language_summary}</p>
                </div>
                {selectedRule.requirements?.map((req, i) => (
                  <div key={i} className="text-sm bg-muted rounded-lg px-3 py-2">{req.description}</div>
                ))}
                <div className="flex items-center gap-2 text-sm">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <span className="text-foreground">{selectedRule.document_title}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {selectedRule.source_circular_id}{selectedRule.section_number ? ` · Para ${selectedRule.section_number}` : ""}{selectedRule.page ? ` · page ${selectedRule.page}` : ""}
                </p>
                {selectedRule.clause_uri && (
                  <Button variant="outline" size="sm" onClick={() => openSource(selectedRule)}>
                    <BookOpen className="h-4 w-4 mr-1.5" /> Read the full paragraph
                  </Button>
                )}
                {selectedRule.tags?.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-foreground mb-2 flex items-center gap-1"><Tag className="h-4 w-4" /> Tags</h4>
                    <div className="flex flex-wrap gap-1">
                      {selectedRule.tags.map((tag) => <Badge key={tag} variant="outline" className="text-xs">{tag}</Badge>)}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      <SourceViewer target={viewing} onClose={() => setViewing(null)} />
    </div>
  );
};

export default RulesPage;
