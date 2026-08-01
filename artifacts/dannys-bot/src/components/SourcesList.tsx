import { useState } from "react";
import { Plus, Trash2, Hash, Loader2, Users } from "lucide-react";
import { useSources, useCreateSource, useDeleteSource, useUpdateSource } from "@/hooks/use-sources";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { type Source } from "@shared/schema";

function computePercentages(sources: Source[]): Record<number, number> {
  const enabled = sources.filter(s => s.enabled !== false);
  if (enabled.length === 0) return {};
  const hasRanks = enabled.some(s => s.rank != null && s.rank > 0);
  if (!hasRanks) {
    const base = Math.floor(100 / enabled.length);
    const result: Record<number, number> = {};
    let rem = 100 - base * enabled.length;
    enabled.forEach((s, i) => { result[s.id] = base + (i === 0 ? rem : 0); });
    return result;
  }
  const total = enabled.reduce((sum, s) => sum + (s.rank ?? 0), 0);
  if (total === 0) {
    const base = Math.floor(100 / enabled.length);
    const result: Record<number, number> = {};
    let rem = 100 - base * enabled.length;
    enabled.forEach((s, i) => { result[s.id] = base + (i === 0 ? rem : 0); });
    return result;
  }
  const result: Record<number, number> = {};
  let allocated = 0;
  enabled.forEach((s, i) => {
    if (i === enabled.length - 1) {
      result[s.id] = 100 - allocated;
    } else {
      const pct = Math.round((s.rank ?? 0) / total * 100);
      result[s.id] = pct;
      allocated += pct;
    }
  });
  return result;
}

export function SourcesList({ toolId }: { toolId: number }) {
  const { data: sources, isLoading } = useSources(toolId);
  const createSource = useCreateSource();
  const deleteSource = useDeleteSource();
  const updateSource = useUpdateSource();

  const [type, setType] = useState<string>("hashtag");
  const [value, setValue] = useState("");
  const [localPcts, setLocalPcts] = useState<Record<number, string>>({});

  const handleAdd = () => {
    if (!value.trim()) return;
    createSource.mutate({ toolId, type, value: value.trim() }, {
      onSuccess: () => setValue(""),
    });
  };

  const handlePctChange = (id: number, raw: string) => {
    setLocalPcts(p => ({ ...p, [id]: raw }));
  };

  const handlePctBlur = (sourceId: number) => {
    if (!sources) return;
    const raw = localPcts[sourceId];
    if (raw === undefined) return;

    const newPct = Math.max(0, Math.min(100, parseInt(raw, 10) || 0));
    const enabled = sources.filter(s => s.enabled !== false);
    const others = enabled.filter(s => s.id !== sourceId);

    const newRanks: Record<number, number> = { [sourceId]: newPct };
    const remaining = 100 - newPct;
    if (others.length > 0) {
      const base = Math.floor(remaining / others.length);
      let rem = remaining - base * others.length;
      others.forEach((s, i) => {
        newRanks[s.id] = base + (i === 0 ? rem : 0);
      });
    }

    setLocalPcts(p => {
      const next = { ...p };
      delete next[sourceId];
      return next;
    });

    enabled.forEach(s => {
      if (newRanks[s.id] !== undefined) {
        updateSource.mutate({ id: s.id, toolId, rank: newRanks[s.id], enabled: true });
      }
    });
  };

  const handleToggle = (source: Source, newEnabled: boolean) => {
    if (!sources) return;
    updateSource.mutate({ id: source.id, toolId, enabled: newEnabled, rank: source.rank });

    const nextPool = sources
      .map(s => s.id === source.id ? { ...s, enabled: newEnabled } : s)
      .filter(s => s.enabled !== false);

    if (nextPool.length > 0) {
      const base = Math.floor(100 / nextPool.length);
      let rem = 100 - base * nextPool.length;
      nextPool.forEach((s, i) => {
        const newRank = base + (i === 0 ? rem : 0);
        if (s.id !== source.id) {
          updateSource.mutate({ id: s.id, toolId, rank: newRank, enabled: true });
        }
      });
    }
  };

  if (isLoading) {
    return <div className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  const computed = sources ? computePercentages(sources) : {};

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
        <h3 className="text-lg font-semibold mb-4 text-foreground">Add New Source</h3>
        <div className="flex flex-col sm:flex-row gap-4">
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="w-full sm:w-[200px] h-11 bg-slate-50 border-slate-200 focus:ring-primary/20">
              <SelectValue placeholder="Source Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="hashtag">Hashtag</SelectItem>
              <SelectItem value="target_followers">Target Followers</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex-1 flex gap-2">
            <Input
              placeholder={type === 'hashtag' ? "e.g. #nature" : "e.g. @natgeo"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="h-11 bg-slate-50 border-slate-200 focus:ring-primary/20"
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            />
            <Button
              onClick={handleAdd}
              disabled={!value.trim() || createSource.isPending}
              className="h-11 px-6 shadow-md shadow-primary/10 hover-elevate"
            >
              {createSource.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
              Add
            </Button>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Active Sources</h3>
          <span className="text-xs text-muted-foreground italic">% = chance of being picked per scrape cycle · total 100% across enabled sources</span>
        </div>
        <div className="divide-y divide-slate-100">
          {!sources?.length ? (
            <div className="p-8 text-center text-muted-foreground">
              <Users className="h-8 w-8 mx-auto mb-3 opacity-20" />
              <p>No sources added yet. Add some above to start automation.</p>
            </div>
          ) : (
            sources.map((source) => {
              const isEnabled = source.enabled !== false;
              const displayPct = localPcts[source.id] !== undefined
                ? localPcts[source.id]
                : String(computed[source.id] ?? 0);
              return (
                <div
                  key={source.id}
                  className={`flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors group ${!isEnabled ? 'opacity-50' : ''}`}
                >
                  <Switch
                    checked={isEnabled}
                    onCheckedChange={(v) => handleToggle(source, v)}
                    className="shrink-0"
                  />
                  <div className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 ${isEnabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                    {source.type === 'hashtag' ? <Hash className="h-4 w-4" /> : <Users className="h-4 w-4" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-foreground text-sm truncate">{source.value}</p>
                    <Badge variant="secondary" className="mt-0.5 font-normal text-xs bg-slate-100 text-slate-600">
                      {source.type.replace('_', ' ')}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      value={displayPct}
                      disabled={!isEnabled}
                      onChange={(e) => handlePctChange(source.id, e.target.value)}
                      onBlur={() => handlePctBlur(source.id)}
                      className="w-16 h-7 text-xs text-center px-1"
                    />
                    <span className="text-xs text-muted-foreground">%</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-all h-8 w-8 shrink-0"
                    onClick={() => deleteSource.mutate({ id: source.id, toolId })}
                    disabled={deleteSource.isPending}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
