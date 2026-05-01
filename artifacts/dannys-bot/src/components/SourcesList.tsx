import { useState } from "react";
import { Plus, Trash2, Hash, Target, Loader2 } from "lucide-react";
import { useSources, useCreateSource, useDeleteSource } from "@/hooks/use-sources";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

export function SourcesList({ toolId }: { toolId: number }) {
  const { data: sources, isLoading } = useSources(toolId);
  const createSource = useCreateSource();
  const deleteSource = useDeleteSource();

  const [type, setType] = useState<string>("hashtag");
  const [value, setValue] = useState("");

  const handleAdd = () => {
    if (!value.trim()) return;
    createSource.mutate({ toolId, type, value: value.trim() }, {
      onSuccess: () => setValue("")
    });
  };

  if (isLoading) {
    return <div className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

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
        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Active Sources</h3>
        </div>
        <div className="divide-y divide-slate-100">
          {sources?.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              <Target className="h-8 w-8 mx-auto mb-3 opacity-20" />
              <p>No sources added yet. Add some above to start automation.</p>
            </div>
          ) : (
            sources?.map((source) => (
              <div key={source.id} className="flex items-center justify-between p-4 hover:bg-slate-50 transition-colors group">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                    {source.type === 'hashtag' ? <Hash className="h-5 w-5" /> : <Target className="h-5 w-5" />}
                  </div>
                  <div>
                    <p className="font-medium text-foreground">{source.value}</p>
                    <Badge variant="secondary" className="mt-1 font-normal text-xs bg-slate-100 text-slate-600">
                      {source.type.replace('_', ' ')}
                    </Badge>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-all"
                  onClick={() => deleteSource.mutate({ id: source.id, toolId })}
                  disabled={deleteSource.isPending}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
