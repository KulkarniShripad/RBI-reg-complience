import { useState, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Search, BookOpen, Loader2, ChevronLeft, ChevronRight, Link2, FileText, Tag } from "lucide-react";
import { getRules, getTopics, type RuleDetail, type TopicData, FOLDER_SUBTOPICS } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

const formatLabel = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const RulesPage = () => {
  const [rules, setRules] = useState<RuleDetail[]>([]);
  const [loading, setLoading] = useState(false);
  const [topics, setTopics] = useState<TopicData[]>([]);
  const [selectedTopic, setSelectedTopic] = useState<string>("all");
  const [selectedSubtopic, setSelectedSubtopic] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [selectedRule, setSelectedRule] = useState<RuleDetail | null>(null);
  const { toast } = useToast();

  // Fetch topics on mount
  useEffect(() => {
    getTopics()
      .then((data) => setTopics(data.topics || []))
      .catch(() => {});
  }, []);

  const subtopics = selectedTopic !== "all"
    ? (topics.find((t) => t.topic_id === selectedTopic)?.subtopics ||
       FOLDER_SUBTOPICS[selectedTopic] || [])
    : [];

  const fetchRules = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, any> = { page, per_page: 20 };
      if (selectedTopic !== "all") params.topic = selectedTopic;
      if (selectedSubtopic !== "all") params.subtopic = selectedSubtopic;
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
  }, [page, selectedTopic, selectedSubtopic, search, toast]);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [selectedTopic, selectedSubtopic, search]);
  useEffect(() => { setSelectedSubtopic("all"); }, [selectedTopic]);

  return (
    <div className="p-6 md:p-10 max-w-5xl mx-auto">
      <h1 className="font-display text-2xl font-bold text-foreground mb-2">Compliance Rules</h1>
      <p className="text-muted-foreground mb-6">Browse and search all extracted regulatory rules.</p>

      {/* Filters */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        <Select value={selectedTopic} onValueChange={setSelectedTopic}>
          <SelectTrigger><SelectValue placeholder="All Topics" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Topics</SelectItem>
            {(topics.length > 0 ? topics.map((t) => t.topic_id) : Object.keys(FOLDER_SUBTOPICS)).map((t) => (
              <SelectItem key={t} value={t}>{formatLabel(t)}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={selectedSubtopic} onValueChange={setSelectedSubtopic} disabled={!subtopics.length}>
          <SelectTrigger><SelectValue placeholder="All Subtopics" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Subtopics</SelectItem>
            {subtopics.map((s) => (
              <SelectItem key={s} value={s}>{formatLabel(s)}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search rules..."
            className="pl-10"
          />
        </div>
      </div>

      {/* Results count */}
      <p className="text-sm text-muted-foreground mb-4">{total} rules found</p>

      {/* Rules list */}
      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : rules.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          <BookOpen className="h-10 w-10 mx-auto mb-3 opacity-40" />
          <p>No rules found. Try adjusting your filters.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rules.map((rule) => (
            <Card
              key={rule.rule_id}
              className="p-4 hover:shadow-md transition-shadow cursor-pointer"
              onClick={() => setSelectedRule(rule)}
            >
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2 mb-2">
                <h3 className="font-semibold text-foreground text-sm">{rule.title}</h3>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant="secondary" className="text-xs">{formatLabel(rule.topic)}</Badge>
                  <Badge variant="outline" className="text-xs">{formatLabel(rule.subtopic)}</Badge>
                </div>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed line-clamp-2">{rule.plain_language_summary}</p>
              {rule.tags?.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {rule.tags.slice(0, 5).map((tag) => (
                    <Badge key={tag} variant="outline" className="text-xs font-normal">{tag}</Badge>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Pagination */}
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

      {/* Rule Detail Dialog */}
      <Dialog open={!!selectedRule} onOpenChange={(open) => !open && setSelectedRule(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          {selectedRule && (
            <>
              <DialogHeader>
                <DialogTitle className="text-lg leading-tight">{selectedRule.title}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 mt-4">
                {/* Topic & Subtopic */}
                <div className="flex flex-wrap gap-2">
                  <Badge>{formatLabel(selectedRule.topic)}</Badge>
                  <Badge variant="outline">{formatLabel(selectedRule.subtopic)}</Badge>
                  {selectedRule.is_active ? (
                    <Badge variant="secondary" className="bg-green-100 text-green-800">Active</Badge>
                  ) : (
                    <Badge variant="secondary" className="bg-red-100 text-red-800">Inactive</Badge>
                  )}
                </div>

                {/* Summary */}
                <div>
                  <h4 className="text-sm font-medium text-foreground mb-1">Plain Language Summary</h4>
                  <p className="text-sm text-muted-foreground leading-relaxed">{selectedRule.plain_language_summary}</p>
                </div>

                {/* Source Circular */}
                {selectedRule.source_circular_id && (
                  <div className="flex items-center gap-2 text-sm">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">Source Circular:</span>
                    <span className="font-medium text-foreground">{selectedRule.source_circular_id}</span>
                  </div>
                )}

                {/* Effective Date */}
                {selectedRule.effective_date && (
                  <div className="text-sm text-muted-foreground">
                    Effective: {selectedRule.effective_date}
                  </div>
                )}

                {/* Requirements */}
                {selectedRule.requirements?.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-foreground mb-2">Requirements</h4>
                    <div className="space-y-1">
                      {selectedRule.requirements.map((req, i) => (
                        <div key={i} className="text-sm bg-muted rounded-lg px-3 py-2">
                          <span className="font-medium">{req.type}:</span> {req.description}
                          {req.value && <span className="ml-1">(Limit: {req.currency === "INR" ? "₹" : ""}{req.value.toLocaleString()})</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Related Rules */}
                {selectedRule.related_rule_ids?.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-foreground mb-2 flex items-center gap-1">
                      <Link2 className="h-4 w-4" /> Related Rules
                    </h4>
                    <div className="flex flex-wrap gap-1">
                      {selectedRule.related_rule_ids.map((id) => (
                        <Badge key={id} variant="outline" className="text-xs">{id}</Badge>
                      ))}
                    </div>
                  </div>
                )}

                {/* Tags */}
                {selectedRule.tags?.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-foreground mb-2 flex items-center gap-1">
                      <Tag className="h-4 w-4" /> Tags
                    </h4>
                    <div className="flex flex-wrap gap-1">
                      {selectedRule.tags.map((tag) => (
                        <Badge key={tag} variant="outline" className="text-xs">{tag}</Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default RulesPage;
