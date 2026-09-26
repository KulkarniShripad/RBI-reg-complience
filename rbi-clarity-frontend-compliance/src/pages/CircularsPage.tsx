import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Search, FileText, Loader2 } from "lucide-react";
import { getTopics, type TopicData, FOLDER_SUBTOPICS } from "@/lib/api";

const formatLabel = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// We derive circulars from topics data since there's no direct /circulars endpoint listing all
// Topics contain circular_ids, rule_counts, etc.

const CircularsPage = () => {
  const [topics, setTopics] = useState<TopicData[]>([]);
  const [search, setSearch] = useState("");
  const [filterTopic, setFilterTopic] = useState<string>("all");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    getTopics()
      .then((data) => {
        if (data.topics?.length) setTopics(data.topics);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const filtered = topics.filter((t) => {
    if (filterTopic !== "all" && t.topic_id !== filterTopic) return false;
    if (search.trim()) {
      const s = search.toLowerCase();
      return (
        t.topic_id.toLowerCase().includes(s) ||
        t.label.toLowerCase().includes(s) ||
        t.subtopics?.some((st) => st.toLowerCase().includes(s))
      );
    }
    return true;
  });

  return (
    <div className="p-6 md:p-10 w-full">
      <h1 className="font-display text-2xl font-bold text-foreground mb-2">Browse Circulars & Topics</h1>
      <p className="text-muted-foreground mb-6">Explore topics, their circulars, and associated rules.</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        <Select value={filterTopic} onValueChange={setFilterTopic}>
          <SelectTrigger><SelectValue placeholder="All Topics" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Topics</SelectItem>
            {(topics.length > 0 ? topics.map((t) => t.topic_id) : Object.keys(FOLDER_SUBTOPICS)).map((t) => (
              <SelectItem key={t} value={t}>{formatLabel(t)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search topics..."
            className="pl-10"
          />
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          <FileText className="h-10 w-10 mx-auto mb-3 opacity-40" />
          <p>No topics found. Upload circulars to populate the database.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((t) => (
            <Card key={t.topic_id} className="p-5 hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-foreground">{formatLabel(t.topic_id)}</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">{t.label}</p>
                </div>
                <div
                  className="h-3 w-3 rounded-full shrink-0 mt-1"
                  style={{ backgroundColor: t.visualization_meta?.cluster_color || "#888" }}
                />
              </div>

              <div className="flex flex-wrap gap-2 mb-3">
                <Badge variant="secondary" className="text-xs">{t.rule_count} rules</Badge>
                <Badge variant="outline" className="text-xs">{t.circular_ids?.length || 0} circulars</Badge>
              </div>

              {t.subtopics?.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">Subtopics</p>
                  <div className="flex flex-wrap gap-1">
                    {t.subtopics.map((st) => (
                      <Badge key={st} variant="outline" className="text-xs font-normal">{formatLabel(st)}</Badge>
                    ))}
                  </div>
                </div>
              )}

              {t.circular_ids?.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs font-medium text-muted-foreground mb-1">Circulars</p>
                  <div className="space-y-1 max-h-32 overflow-y-auto">
                    {t.circular_ids.map((cid) => (
                      <div key={cid} className="flex items-center gap-1.5 text-xs text-foreground">
                        <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
                        <span className="truncate">{cid}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

export default CircularsPage;
