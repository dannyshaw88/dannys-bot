import { useState, useEffect, useMemo } from "react";
import { Copy, CheckCircle2, Loader2, Search, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import type { Profile } from "@shared/schema";
import { getTrustScore, getTrustLevels } from "@/components/TrustScoreBadge";

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

type SortBy  = "name" | "status" | "group" | "trustscore";
type SortDir = "asc" | "desc";

function statusBadgeClass(status: string) {
  const s = (status ?? "").toLowerCase().replace(/_/g, " ");
  if (s === "valid")                                        return "bg-green-500/15 text-green-700 border-green-500/30";
  if (s === "pending" || s === "verifying")                 return "bg-yellow-500/15 text-yellow-700 border-yellow-500/30";
  if (s === "locked" || s === "account disabled")           return "bg-red-500/15 text-red-700 border-red-500/30";
  if (s === "captcha" || s === "2fa verification" || s === "email confirmation") return "bg-orange-500/15 text-orange-700 border-orange-500/30";
  if (s === "stopped" || s === "disabled" || s === "inactive") return "bg-zinc-500/15 text-zinc-500 border-zinc-500/30";
  if (s === "banned" || s === "restricted" || s === "suspended") return "bg-red-500/15 text-red-700 border-red-500/30";
  return "bg-muted/60 text-muted-foreground border-border";
}

function buildInitialSelected(_groups: CopyOptionGroup[]): Set<string> {
  return new Set<string>();
}

function buildAllSelected(groups: CopyOptionGroup[]): Set<string> {
  const all = new Set<string>();
  groups.forEach(g =>
    g.options.forEach(o => {
      if (o.subOptions?.length) o.subOptions.forEach(s => all.add(s.key));
      else all.add(o.key);
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

const SHARED_TARGETS_KEY = "copyDialog:targets:lastUsed";

export function CopySettingsDialog({ open, onOpenChange, title, profiles, optionGroups, onCopy }: Props) {
  const [targets, setTargets]    = useState<Set<number>>(new Set());
  const [search, setSearch]      = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sortBy, setSortBy]      = useState<SortBy>("name");
  const [sortDir, setSortDir]    = useState<SortDir>("asc");
  const [selected, setSelected]  = useState<Set<string>>(() => buildInitialSelected(optionGroups));
  const [status, setStatus]      = useState<"idle" | "copying" | "done">("idle");

  // Persist targets to localStorage whenever they change — shared across all Copy Settings dialogs
  useEffect(() => {
    try {
      localStorage.setItem(SHARED_TARGETS_KEY, JSON.stringify([...targets]));
    } catch {}
  }, [targets]);

  // Keep targets in sync with the profiles list — remove any stale IDs that no
  // longer correspond to an existing profile (e.g. after an account is deleted).
  useEffect(() => {
    const validIds = new Set(profiles.map(p => p.id));
    setTargets(prev => {
      const filtered = new Set([...prev].filter(id => validIds.has(id)));
      if (filtered.size === prev.size) return prev;
      return filtered;
    });
  }, [profiles]);

  useEffect(() => {
    if (open) {
      setTargets(new Set());
      setSearch("");
      setStatusFilter("");
      setSortBy("name");
      setSortDir("asc");
      setStatus("idle");
      setSelected(buildInitialSelected(optionGroups));
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Unique statuses present in the profiles list, for the status filter dropdown
  const uniqueStatuses = useMemo(() => {
    const seen = new Set<string>();
    for (const p of profiles) {
      const s = ((p as any).accountStatus as string | undefined ?? "").replace(/_/g, " ").trim();
      if (s) seen.add(s);
    }
    return Array.from(seen).sort();
  }, [profiles]);

  const profileGroups = useMemo(() => {
    const map = new Map<string, Profile[]>();
    for (const p of profiles) {
      const key = (p.tags ?? "").trim() || "No Group Assigned";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return map;
  }, [profiles]);

  // Multi-term search: split on "||" and match any term against label, username, status, or group
  const filteredProfiles = useMemo(() => {
    const terms = search.split("||").map(t => t.trim().toLowerCase()).filter(Boolean);
    const afterSearch = terms.length === 0 ? profiles : profiles.filter(p =>
      terms.some(q =>
        p.username.toLowerCase().includes(q) ||
        (p.accountLabel ?? "").toLowerCase().includes(q) ||
        ((p as any).accountStatus ?? "").toLowerCase().replace(/_/g, " ").includes(q) ||
        (p.tags ?? "").toLowerCase().includes(q)
      )
    );
    const base = statusFilter
      ? afterSearch.filter(p =>
          ((p as any).accountStatus ?? "").replace(/_/g, " ").trim().toLowerCase() === statusFilter.toLowerCase()
        )
      : afterSearch;

    const dir = sortDir === "asc" ? 1 : -1;
    return [...base].sort((a, b) => {
      if (sortBy === "status") {
        const sa = ((a as any).accountStatus ?? "").replace(/_/g, " ");
        const sb = ((b as any).accountStatus ?? "").replace(/_/g, " ");
        const sc = sa.localeCompare(sb);
        if (sc !== 0) return sc * dir;
      }
      if (sortBy === "group") {
        const ga = (a.tags ?? "").trim() || "No Group Assigned";
        const gb = (b.tags ?? "").trim() || "No Group Assigned";
        const gc = ga.localeCompare(gb);
        if (gc !== 0) return gc * dir;
      }
      if (sortBy === "trustscore") {
        const tsA = getTrustScore(a.id); const tsB = getTrustScore(b.id);
        const _lvls = getTrustLevels();
        const ra = tsA !== null ? _lvls.findIndex(l => l.id === tsA) : Infinity;
        const rb = tsB !== null ? _lvls.findIndex(l => l.id === tsB) : Infinity;
        const diff = ra === rb ? 0 : ra < rb ? -1 : 1;
        if (diff !== 0) return diff * dir;
      }
      return (a.accountLabel || a.username).localeCompare(b.accountLabel || b.username) * dir;
    });
  }, [profiles, search, sortBy, sortDir]);

  const cycleSort = (key: SortBy) => {
    if (sortBy === key) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortBy(key);
      setSortDir("asc");
    }
  };

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
    else             setSelected(buildAllSelected(optionGroups));
  };

  const handleSelectAllFiltered = () => {
    setTargets(prev => { const n = new Set(prev); filteredProfiles.forEach(p => n.add(p.id)); return n; });
  };

  const handleSelectNoneFiltered = () => {
    setTargets(prev => { const n = new Set(prev); filteredProfiles.forEach(p => n.delete(p.id)); return n; });
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
      <DialogContent className="max-w-[1160px] p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-4 border-b border-border">
          <DialogTitle className="flex items-center gap-2">
            <Copy className="w-4 h-4 text-primary" /> {title}
          </DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0" style={{ maxHeight: "calc(81vh - 140px)" }}>
          {/* LEFT profile list — wider name column */}
          <div className="w-[483px] shrink-0 border-r border-border flex flex-col">

            {/* Header row */}
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-muted/30">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Copy To</span>
              <button
                className="text-[11px] text-primary hover:underline font-bold uppercase tracking-wide"
                onClick={handleSelectAllFiltered}
              >
                ALL
              </button>
              <button
                className="text-[11px] text-muted-foreground hover:text-foreground hover:underline font-bold uppercase tracking-wide"
                onClick={handleSelectNoneFiltered}
              >
                NONE
              </button>
              {targets.size > 0 && (
                <span className="text-[11px] text-primary font-bold">
                  ({targets.size} selected)
                </span>
              )}
            </div>

            {/* Group quick-select */}
            {profileGroups.size > 0 && (
              <div className="px-3 py-2 border-b border-border bg-muted/10">
                <select
                  className="w-1/2 text-xs rounded-md border border-input bg-background text-foreground px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer"
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
                  <option value="">Select Group</option>
                  {Array.from(profileGroups.entries()).map(([groupName, groupProfiles]) => (
                    <option key={groupName} value={groupName}>
                      {groupName} ({groupProfiles.length})
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Search */}
            <div className="px-3 py-2 border-b border-border flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="w-full pl-7 pr-2.5 py-1.5 text-xs rounded-md border border-input bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            </div>

            {/* Column headers */}
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-muted/20 select-none">
              <div className="w-4 shrink-0" />
              {([ ["name", "Name", "flex-1"], ["status", "Status", "w-[72px]"], ["group", "Group", "w-[88px]"] ] as [SortBy, string, string][]).map(([key, label, cls]) => {
                const active = sortBy === key;
                const Icon = active ? (sortDir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
                const isCentered = key === "status";
                return (
                  <button
                    key={key}
                    onClick={() => cycleSort(key)}
                    className={`${cls} flex items-center gap-0.5 text-[10px] font-bold uppercase tracking-wider transition-colors ${isCentered ? "justify-center" : ""} ${
                      active ? "text-primary" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {label}
                    <Icon className={`w-2.5 h-2.5 shrink-0 ${active ? "opacity-100" : "opacity-40"}`} />
                  </button>
                );
              })}
              <button
                onClick={() => cycleSort("trustscore")}
                className={`w-[88px] shrink-0 flex items-center justify-center gap-0.5 text-[10px] font-bold uppercase tracking-wider transition-colors ${
                  sortBy === "trustscore" ? "text-primary" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                TrustScore
                {(() => { const Icon = sortBy === "trustscore" ? (sortDir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown; return <Icon className={`w-2.5 h-2.5 shrink-0 ${sortBy === "trustscore" ? "opacity-100" : "opacity-40"}`} />; })()}
              </button>
            </div>

            {/* Account rows */}
            <div className="overflow-y-auto flex-1 divide-y divide-border/40">
              {filteredProfiles.length === 0 && (
                <p className="px-4 py-3 text-xs text-muted-foreground text-center">No profiles match.</p>
              )}
              {filteredProfiles.map(p => {
                const acctStatus = ((p as any).accountStatus as string | undefined) ?? "";
                const displayStatus = acctStatus.replace(/_/g, " ").trim();
                const groupLabel = (p.tags ?? "").trim() || "No Group Assigned";
                const tsId = getTrustScore(p.id);
                const tsLevel = tsId ? getTrustLevels().find(l => l.id === tsId) : null;
                return (
                  <label
                    key={p.id}
                    className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none hover:bg-muted/30 transition-colors"
                  >
                    <Checkbox checked={targets.has(p.id)} onCheckedChange={() => toggleTarget(p.id)} className="shrink-0 w-4 h-4" />
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-semibold truncate block leading-tight">
                        {p.accountLabel || p.username}
                      </span>
                    </div>
                    <div className="w-[72px] shrink-0 flex items-center justify-center">
                      {displayStatus && (
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border capitalize ${statusBadgeClass(displayStatus)}`}>
                          {displayStatus}
                        </span>
                      )}
                    </div>
                    <div className="w-[88px] shrink-0 truncate text-[10px] text-muted-foreground">
                      {groupLabel}
                    </div>
                    <div className="w-[88px] shrink-0 flex items-center justify-center">
                      {tsLevel ? (
                        <span
                          className="flex items-center gap-0.5 rounded-full px-1.5 py-0.5 w-fit"
                          style={{ background: "#1AD2F2" }}
                        >
                          <tsLevel.icon size={8} color="#fff" fill="#fff" strokeWidth={2} />
                          <span style={{ fontSize: 8, fontWeight: 700, color: "#fff", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>
                            {tsLevel.label}
                          </span>
                        </span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground/40">—</span>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>

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
            {status === "idle"    && <><Copy className="w-3.5 h-3.5" /> COPY SETTINGS</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
