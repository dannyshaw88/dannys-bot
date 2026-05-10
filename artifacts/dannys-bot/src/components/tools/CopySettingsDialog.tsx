import { useState, useEffect, useMemo } from "react";
import { Copy, CheckCircle2, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import type { Profile } from "@shared/schema";

export interface CopySubOption {
  key: string;
  label: string;
  description?: string;
  settingKeys: string[];
}

export interface CopyOption {
  key: string;
  label: string;
  description?: string;
  subOptions?: CopySubOption[];
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
  onCopy: (targetIds: number[], expandedKeys: string[]) => Promise<void>;
}

function buildInitialSelected(groups: CopyOptionGroup[]): Set<string> {
  const all = new Set<string>();
  groups.forEach(g =>
    g.options.forEach(o => {
      if (o.subOptions?.length) {
        o.subOptions.forEach(s => all.add(s.key));
      } else {
        all.add(o.key);
      }
    })
  );
  return all;
}

function expandToSettingKeys(groups: CopyOptionGroup[], selected: Set<string>): string[] {
  const result: string[] = [];
  for (const g of groups) {
    for (const o of g.options) {
      if (!o.subOptions?.length) {
        if (selected.has(o.key)) result.push(o.key);
      } else {
        for (const sub of o.subOptions) {
          if (selected.has(sub.key)) result.push(...sub.settingKeys);
        }
      }
    }
  }
  return result;
}

export function CopySettingsDialog({ open, onOpenChange, title, profiles, optionGroups, onCopy }: Props) {
  const [targets, setTargets]   = useState<Set<number>>(new Set());
  const [search, setSearch]     = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => buildInitialSelected(optionGroups));
  const [status, setStatus]     = useState<"idle" | "copying" | "done">("idle");

  useEffect(() => {
    if (open) {
      setTargets(new Set());
      setSearch("");
      setStatus("idle");
      setSelected(buildInitialSelected(optionGroups));
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const profileGroups = useMemo(() => {
    const map = new Map<string, Profile[]>();
    for (const p of profiles) {
      const key = (p.tags ?? "").trim();
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return map;
  }, [profiles]);

  // Multi-term search: split on "||" and match any term against label or username
  const filteredProfiles = useMemo(() => {
    const terms = search.split("||").map(t => t.trim().toLowerCase()).filter(Boolean);
    if (terms.length === 0) return profiles;
    return profiles.filter(p =>
      terms.some(q =>
        p.username.toLowerCase().includes(q) ||
        (p.accountLabel ?? "").toLowerCase().includes(q)
      )
    );
  }, [profiles, search]);

  const toggleTarget = (id: number) => setTargets(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const toggleOptionGroup = (opt: CopyOption) => {
    if (!opt.subOptions?.length) {
      setSelected(prev => {
        const next = new Set(prev);
        if (next.has(opt.key)) next.delete(opt.key); else next.add(opt.key);
        return next;
      });
      return;
    }
    const subKeys = opt.subOptions.map(s => s.key);
    const allSel  = subKeys.every(k => selected.has(k));
    setSelected(prev => {
      const next = new Set(prev);
      if (allSel) subKeys.forEach(k => next.delete(k));
      else        subKeys.forEach(k => next.add(k));
      return next;
    });
  };

  const toggleSubOption = (key: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const totalItems = optionGroups.reduce((n, g) =>
    n + g.options.reduce((m, o) => m + (o.subOptions?.length ? o.subOptions.length : 1), 0), 0
  );
  const allSelected = selected.size === totalItems;

  const handleSelectAll = () => {
    if (allSelected) setSelected(new Set());
    else             setSelected(buildInitialSelected(optionGroups));
  };

  const allFilteredSelected = filteredProfiles.length > 0 && filteredProfiles.every(p => targets.has(p.id));

  const handleToggleAllFiltered = () => {
    if (allFilteredSelected) {
      setTargets(prev => { const n = new Set(prev); filteredProfiles.forEach(p => n.delete(p.id)); return n; });
    } else {
      setTargets(prev => { const n = new Set(prev); filteredProfiles.forEach(p => n.add(p.id)); return n; });
    }
  };

  const handleCopy = async () => {
    if (!targets.size || !selected.size) return;
    setStatus("copying");
    try {
      await onCopy([...targets], expandToSettingKeys(optionGroups, selected));
      setStatus("done");
      setTimeout(() => { setStatus("idle"); onOpenChange(false); }, 1200);
    } catch {
      setStatus("idle");
    }
  };

  const canCopy = targets.size > 0 && selected.size > 0 && status === "idle";

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) setStatus("idle"); onOpenChange(v); }}>
      <DialogContent className="max-w-[1008px] p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-4 border-b border-border">
          <DialogTitle className="flex items-center gap-2">
            <Copy className="w-4 h-4 text-primary" /> {title}
          </DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0" style={{ maxHeight: "calc(81vh - 140px)" }}>
          {/* LEFT profile list */}
          <div className="w-72 shrink-0 border-r border-border flex flex-col">
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-muted/30">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Copy To</span>
              {filteredProfiles.length > 1 && (
                <button
                  className="text-[11px] text-primary hover:underline font-medium"
                  onClick={handleToggleAllFiltered}
                >
                  {allFilteredSelected ? "None" : "All"}
                </button>
              )}
            </div>
            {profileGroups.size > 0 && (
              <div className="px-3 py-2 border-b border-border bg-muted/10">
                <select
                  className="w-full text-xs rounded-md border border-input bg-background text-foreground px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer"
                  value=""
                  onChange={e => {
                    const groupName = e.target.value;
                    if (!groupName) return;
                    const groupProfiles = profileGroups.get(groupName) ?? [];
                    setTargets(prev => {
                      const next = new Set(prev);
                      groupProfiles.forEach(p => next.add(p.id));
                      return next;
                    });
                  }}
                >
                  <option value="">Select by group…</option>
                  {Array.from(profileGroups.entries()).map(([groupName, groupProfiles]) => (
                    <option key={groupName} value={groupName}>
                      {groupName} ({groupProfiles.length})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="px-3 py-2 border-b border-border">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  placeholder="Filter… or A||B for multiple"
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
                  <Checkbox checked={targets.has(p.id)} onCheckedChange={() => toggleTarget(p.id)} />
                  <span className="text-sm font-medium tracking-tight truncate">
                    {p.accountLabel || p.username}
                  </span>
                </label>
              ))}
            </div>
            {targets.size > 0 && (
              <div className="px-4 py-2 border-t border-border bg-muted/20">
                <p className="text-[11px] text-muted-foreground">{targets.size} profile{targets.size > 1 ? "s" : ""} selected</p>
              </div>
            )}
          </div>

          {/* RIGHT settings */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            <div className="flex items-center justify-between mb-1">
              <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Settings to Copy</Label>
              <button className="text-[11px] text-primary hover:underline font-medium" onClick={handleSelectAll}>
                {allSelected ? "Deselect all" : "Select all"}
              </button>
            </div>

            {optionGroups.map(group => (
              <div key={group.label} className="rounded-lg border border-border overflow-hidden">
                <div className="px-4 py-2 bg-muted/30 border-b border-border">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{group.label}</span>
                </div>
                <div className="divide-y divide-border/40">
                  {group.options.map(opt => {
                    const hasSubs = !!opt.subOptions?.length;

                    let checked       = false;
                    let indeterminate = false;
                    if (hasSubs) {
                      const subKeys = opt.subOptions!.map(s => s.key);
                      const selCount = subKeys.filter(k => selected.has(k)).length;
                      checked       = selCount === subKeys.length;
                      indeterminate = selCount > 0 && selCount < subKeys.length;
                    } else {
                      checked = selected.has(opt.key);
                    }

                    return (
                      <div key={opt.key}>
                        <div className="flex items-center gap-3 px-4 py-2.5 bg-muted/10">
                          <Checkbox
                            checked={indeterminate ? "indeterminate" : checked}
                            onCheckedChange={() => toggleOptionGroup(opt)}
                            className="shrink-0"
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold leading-none">{opt.label}</p>
                            {opt.description && (
                              <p className="text-xs text-muted-foreground mt-0.5">{opt.description}</p>
                            )}
                          </div>
                        </div>

                        {hasSubs && (
                          <div className="border-t border-border/60 bg-muted/5 divide-y divide-border/30">
                            {opt.subOptions!.map(sub => (
                              <label
                                key={sub.key}
                                className="flex items-center gap-3 pl-10 pr-4 py-2 cursor-pointer select-none hover:bg-muted/20 transition-colors"
                              >
                                <Checkbox
                                  checked={selected.has(sub.key)}
                                  onCheckedChange={() => toggleSubOption(sub.key)}
                                  className="shrink-0"
                                />
                                <div className="min-w-0">
                                  <span className="text-xs text-foreground">{sub.label}</span>
                                  {sub.description && (
                                    <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{sub.description}</p>
                                  )}
                                </div>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
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
