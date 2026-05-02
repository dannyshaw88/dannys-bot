import { useState } from "react";
import { Copy, CheckCircle2, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import type { Profile } from "@shared/schema";

export interface CopyOption {
  key: string;
  label: string;
  description?: string;
}

export interface CopyOptionGroup {
  label: string;
  options: CopyOption[];
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  profiles: Profile[];
  optionGroups: CopyOptionGroup[];
  onCopy: (targetIds: number[], selectedKeys: Set<string>) => Promise<void>;
}

export function CopySettingsDialog({ open, onOpenChange, title, profiles, optionGroups, onCopy }: Props) {
  const [targets, setTargets]     = useState<Set<number>>(new Set());
  const [search, setSearch]       = useState("");
  const [selected, setSelected]   = useState<Set<string>>(() => {
    const all = new Set<string>();
    optionGroups.forEach(g => g.options.forEach(o => all.add(o.key)));
    return all;
  });
  const [status, setStatus] = useState<"idle" | "copying" | "done">("idle");

  const filteredProfiles = profiles.filter(p =>
    p.username.toLowerCase().includes(search.toLowerCase())
  );

  const toggleTarget = (id: number) => setTargets(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const toggleOption = (key: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const allFilteredSelected = filteredProfiles.length > 0 && filteredProfiles.every(p => targets.has(p.id));

  const totalOptions = optionGroups.reduce((n, g) => n + g.options.length, 0);

  const handleCopy = async () => {
    if (!targets.size || !selected.size) return;
    setStatus("copying");
    try {
      await onCopy([...targets], selected);
      setStatus("done");
      setTimeout(() => { setStatus("idle"); onOpenChange(false); }, 1200);
    } catch {
      setStatus("idle");
    }
  };

  const canCopy = targets.size > 0 && selected.size > 0 && status === "idle";

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) setStatus("idle"); onOpenChange(v); }}>
      <DialogContent className="max-w-2xl p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-4 border-b border-border">
          <DialogTitle className="flex items-center gap-2">
            <Copy className="w-4 h-4 text-primary" /> {title}
          </DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0" style={{ maxHeight: "calc(90vh - 140px)" }}>
          {/* LEFT — Profile list */}
          <div className="w-56 shrink-0 border-r border-border flex flex-col">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/30">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Copy To</span>
              {filteredProfiles.length > 1 && (
                <button
                  className="text-[11px] text-primary hover:underline font-medium"
                  onClick={() => {
                    if (allFilteredSelected) {
                      setTargets(prev => {
                        const next = new Set(prev);
                        filteredProfiles.forEach(p => next.delete(p.id));
                        return next;
                      });
                    } else {
                      setTargets(prev => {
                        const next = new Set(prev);
                        filteredProfiles.forEach(p => next.add(p.id));
                        return next;
                      });
                    }
                  }}
                >
                  {allFilteredSelected ? "None" : "All"}
                </button>
              )}
            </div>
            {/* Search */}
            <div className="px-3 py-2 border-b border-border">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  placeholder="Filter profiles…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="w-full pl-7 pr-2.5 py-1.5 text-xs rounded-md border border-input bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            </div>
            <div className="overflow-y-auto flex-1 divide-y divide-border/40">
              {filteredProfiles.length === 0 && (
                <p className="px-4 py-3 text-xs text-muted-foreground text-center">No profiles match.</p>
              )}
              {filteredProfiles.map(p => (
                <label
                  key={p.id}
                  className="flex items-center gap-2.5 px-4 py-2.5 cursor-pointer select-none hover:bg-muted/30 transition-colors"
                >
                  <Checkbox
                    checked={targets.has(p.id)}
                    onCheckedChange={() => toggleTarget(p.id)}
                  />
                  <span className="text-sm font-mono truncate">@{p.username}</span>
                </label>
              ))}
            </div>
            {targets.size > 0 && (
              <div className="px-4 py-2 border-t border-border bg-muted/20">
                <p className="text-[11px] text-muted-foreground">{targets.size} profile{targets.size > 1 ? "s" : ""} selected</p>
              </div>
            )}
          </div>

          {/* RIGHT — Settings to copy */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            <div className="flex items-center justify-between mb-1">
              <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Settings to Copy</Label>
              <button
                className="text-[11px] text-primary hover:underline font-medium"
                onClick={() => {
                  if (selected.size === totalOptions) {
                    setSelected(new Set());
                  } else {
                    const all = new Set<string>();
                    optionGroups.forEach(g => g.options.forEach(o => all.add(o.key)));
                    setSelected(all);
                  }
                }}
              >
                {selected.size === totalOptions ? "Deselect all" : "Select all"}
              </button>
            </div>

            {optionGroups.map(group => (
              <div key={group.label} className="rounded-lg border border-border overflow-hidden">
                <div className="px-4 py-2 bg-muted/30 border-b border-border">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{group.label}</span>
                </div>
                <div className="divide-y divide-border/40">
                  {group.options.map(opt => (
                    <label key={opt.key} className="flex items-start gap-3 px-4 py-2.5 cursor-pointer select-none hover:bg-muted/20 transition-colors">
                      <Checkbox
                        checked={selected.has(opt.key)}
                        onCheckedChange={() => toggleOption(opt.key)}
                        className="mt-0.5 shrink-0"
                      />
                      <div>
                        <p className="text-sm font-medium leading-none">{opt.label}</p>
                        {opt.description && (
                          <p className="text-xs text-muted-foreground mt-0.5">{opt.description}</p>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter className="px-6 py-4 border-t border-border gap-2">
          <DialogClose asChild>
            <Button variant="outline" size="sm">Cancel</Button>
          </DialogClose>
          <Button size="sm" disabled={!canCopy} onClick={handleCopy} className="min-w-[120px] gap-1.5">
            {status === "copying" && <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Copying…</>}
            {status === "done"    && <><CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> Copied!</>}
            {status === "idle"    && <><Copy className="w-3.5 h-3.5" /> Copy Settings</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
