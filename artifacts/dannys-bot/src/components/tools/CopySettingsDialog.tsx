import { useState, useEffect, useRef, useMemo } from "react";
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

function titleSlug(title: string) {
  return title.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}
function storageTargetsKey(title: string) { return `copyDialog:${titleSlug(title)}:targets`; }
function storageSettingsKey(title: string) { return `copyDialog:${titleSlug(title)}:settings`; }

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

export function CopySettingsDialog({ open, onOpenChange, title, profiles, optionGroups, onCopy }: Props) {
  const [targets, setTargets]    = useState<Set<number>>(new Set());
  const [search, setSearch]      = useState("");
  const [settingsSearch, setSettingsSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sortBy, setSortBy]      = useState<SortBy>("name");
  const [sortDir, setSortDir]    = useState<SortDir>("asc");
  const [selected, setSelected]       = useState<Set<string>>(() => buildInitialSelected(optionGroups));
  const [expandedOptions, setExpandedOptions] = useState<Set<string>>(new Set());
  const [status, setStatus]           = useState<"idle" | "copying" | "done">("idle");

  // Drag-to-select refs — same pattern as the main accounts list
  const isDragSelecting = useRef(false);
  const dragAddMode     = useRef(true);

  // Refs that mirror state — used to capture current values on dialog close
  // without needing to re-register the save effect on every state change.
  const targetsRef  = useRef<Set<number>>(targets);
  const selectedRef = useRef<Set<string>>(selected);
  useEffect(() => { targetsRef.current  = targets;  }, [targets]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  // Stop drag on mouseup anywhere (including outside the list)
  useEffect(() => {
    const onMouseUp = () => { isDragSelecting.current = false; };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, []);

  // ── Persistence ────────────────────────────────────────────────────────────
  // Save on CLOSE (open → false): write the refs (current state) to localStorage.
  // Restore on OPEN (false → true): read from localStorage and set state.
  //
  // We NEVER save on every state change — that fires on component mount with an
  // empty Set and immediately wipes any previously stored selection.

  // Keep targets in sync with the profiles list — remove stale IDs for deleted accounts
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
      // Restore target accounts
      try {
        const raw = localStorage.getItem(storageTargetsKey(title));
        if (raw) {
          const ids: number[] = JSON.parse(raw);
          const validIds = new Set(profiles.map(p => p.id));
          setTargets(new Set(ids.filter(id => validIds.has(id))));
        }
      } catch {}

      // Restore settings selection + derive which parent options should be expanded
      try {
        const raw = localStorage.getItem(storageSettingsKey(title));
        if (raw) {
          const keys: string[] = JSON.parse(raw);
          const restoredSel = new Set(keys);
          setSelected(restoredSel);
          // Expand any parent whose sub-options have at least one restored selection
          const exp = new Set<string>();
          for (const g of optionGroups) {
            for (const o of g.options) {
              if (o.subOptions?.length && o.subOptions.some(s => restoredSel.has(s.key))) {
                exp.add(o.key);
              }
            }
          }
          setExpandedOptions(exp);
        } else {
          setExpandedOptions(new Set());
        }
      } catch { setExpandedOptions(new Set()); }

      setSearch("");
      setSettingsSearch("");
      setStatusFilter("");
      setSortBy("name");
      setSortDir("asc");
      setStatus("idle");
    } else {
      // Save to localStorage when dialog closes — refs hold the final state
      try {
        localStorage.setItem(storageTargetsKey(title), JSON.stringify([...targetsRef.current]));
        localStorage.setItem(storageSettingsKey(title), JSON.stringify([...selectedRef.current]));
      } catch {}
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
      const key = (p.tags ?? "").trim() || "Ungrouped";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return map;
  }, [profiles]);

  // Multi-term search: split on "||" and match any term against username,
  // label, status, group, OR TrustScore badge name (e.g. "warmup", "snail")
  const filteredProfiles = useMemo(() => {
    const levels = getTrustLevels();
    const terms = search.split("||").map(t => t.trim().toLowerCase()).filter(Boolean);
    const afterSearch = terms.length === 0 ? profiles : profiles.filter(p => {
      const tsId    = getTrustScore(p.id);
      const tsLevel = tsId ? levels.find(l => l.id === tsId) : null;
      const tsLabel = (tsLevel?.label ?? "").toLowerCase();
      const tsIdStr = (tsId ?? "").toLowerCase().replace(/_/g, " ");
      return terms.some(q =>
        p.username.toLowerCase().includes(q) ||
        (p.accountLabel ?? "").toLowerCase().includes(q) ||
        ((p as any).accountStatus ?? "").toLowerCase().replace(/_/g, " ").includes(q) ||
        (p.tags ?? "").toLowerCase().includes(q) ||
        tsLabel.includes(q) ||
        tsIdStr.includes(q)
      );
    });
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
  }, [profiles, search, sortBy, sortDir, statusFilter]);

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
    const subKeys  = opt.subOptions.map(s => s.key);
    const isExpanded = expandedOptions.has(opt.key);
    if (isExpanded) {
      // Collapse + deselect all sub-options
      setExpandedOptions(prev => { const n = new Set(prev); n.delete(opt.key); return n; });
      setSelected(prev => { const n = new Set(prev); subKeys.forEach(k => n.delete(k)); return n; });
    } else {
      // Expand + select all sub-options
      setExpandedOptions(prev => { const n = new Set(prev); n.add(opt.key); return n; });
      setSelected(prev => { const n = new Set(prev); subKeys.forEach(k => n.add(k)); return n; });
    }
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
    if (allSelected) {
      setSelected(new Set());
      setExpandedOptions(new Set());
    } else {
      setSelected(buildAllSelected(optionGroups));
      const exp = new Set<string>();
      optionGroups.forEach(g => g.options.forEach(o => { if (o.subOptions?.length) exp.add(o.key); }));
      setExpandedOptions(exp);
    }
  };

  const handleSelectAllFiltered = () => {
    setTargets(new Set(filteredProfiles.map(p => p.id)));
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

  // Filter option groups/options based on settingsSearch
  const filteredOptionGroups = useMemo(() => {
    const q = settingsSearch.trim().toLowerCase();
    if (!q) return optionGroups;
    return optionGroups
      .map(group => {
        const matchGroup = group.label.toLowerCase().includes(q);
        const filteredOptions = group.options.filter(opt => {
          if (matchGroup) return true;
          if (opt.label.toLowerCase().includes(q)) return true;
          if (opt.description?.toLowerCase().includes(q)) return true;
          if (opt.subOptions?.some(s =>
            s.label.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q)
          )) return true;
          return false;
        });
        return { ...group, options: filteredOptions };
      })
      .filter(g => g.options.length > 0);
  }, [optionGroups, settingsSearch]);

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) setStatus("idle"); onOpenChange(v); }}>
      <DialogContent className="max-w-[1160px] p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-4 border-b border-border">
          <DialogTitle className="flex items-center gap-2">
            <Copy className="w-4 h-4 text-primary" /> {title}
          </DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0" style={{ maxHeight: "calc(81vh - 140px)" }}>
          {/* LEFT profile list */}
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

            {/* Search — supports username, group, status, and TrustScore badge name */}
            <div className="px-3 py-2 border-b border-border flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search by name, group, status, badge…"
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

            {/* Account rows — drag-to-select: hold and drag down/up to select multiple */}
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
                const isChecked = targets.has(p.id);
                return (
                  <div
                    key={p.id}
                    className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none hover:bg-muted/30 transition-colors"
                    onMouseDown={e => {
                      if (e.button !== 0) return;
                      e.preventDefault();
                      dragAddMode.current = !isChecked;
                      isDragSelecting.current = true;
                      toggleTarget(p.id);
                    }}
                    onMouseEnter={() => {
                      if (!isDragSelecting.current) return;
                      if (dragAddMode.current !== isChecked) toggleTarget(p.id);
                    }}
                  >
                    <Checkbox
                      checked={isChecked}
                      onCheckedChange={() => toggleTarget(p.id)}
                      onClick={e => e.stopPropagation()}
                      className="shrink-0 w-4 h-4 pointer-events-none"
                    />
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
                          className="flex items-center gap-0.5 rounded-full px-1.5"
                          style={{
                            background: tsLevel.bg,
                            border: `1px solid ${tsLevel.border}`,
                            height: 20,
                            width: 72,
                            minWidth: 72,
                            maxWidth: 72,
                            overflow: "hidden",
                            flexShrink: 0,
                          }}
                        >
                          <tsLevel.icon size={10} color={tsLevel.text} fill={tsLevel.text} strokeWidth={2} style={{ flexShrink: 0 }} />
                          <span style={{ fontSize: 10, fontWeight: 700, color: tsLevel.text, letterSpacing: "0.06em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "clip", flex: 1, minWidth: 0 }}>
                            {tsLevel.label}
                          </span>
                        </span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground/40">—</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

          </div>

          {/* RIGHT settings */}
          <div className="flex-1 flex flex-col min-h-0">
            {/* Settings search + select all/none */}
            <div className="px-5 pt-4 pb-2 border-b border-border space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Settings to Copy</Label>
                <div className="flex items-center gap-2">
                  <button className="text-[11px] text-primary hover:underline font-bold uppercase tracking-wide" onClick={() => {
                    setSelected(buildAllSelected(optionGroups));
                    const exp = new Set<string>();
                    optionGroups.forEach(g => g.options.forEach(o => { if (o.subOptions?.length) exp.add(o.key); }));
                    setExpandedOptions(exp);
                  }}>
                    Select All
                  </button>
                  <button className="text-[11px] text-muted-foreground hover:text-foreground hover:underline font-bold uppercase tracking-wide" onClick={() => { setSelected(new Set()); setExpandedOptions(new Set()); }}>
                    Select None
                  </button>
                </div>
              </div>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search settings…"
                  value={settingsSearch}
                  onChange={e => setSettingsSearch(e.target.value)}
                  className="w-full pl-7 pr-2.5 py-1.5 text-xs rounded-md border border-input bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            {filteredOptionGroups.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-6">No settings match.</p>
            )}
            {filteredOptionGroups.map(group => (
              <div key={group.label} className="rounded-lg border border-border overflow-hidden">
                <div className="px-4 py-2 bg-muted/30 border-b border-border">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{group.label}</span>
                </div>
                <div className="divide-y divide-border/40">
                  {group.options.map(opt => {
                    const hasSubs    = !!opt.subOptions?.length;
                    const isExpanded = hasSubs && expandedOptions.has(opt.key);

                    let checked       = false;
                    let indeterminate = false;
                    if (hasSubs) {
                      if (isExpanded) {
                        const subKeys  = opt.subOptions!.map(s => s.key);
                        const selCount = subKeys.filter(k => selected.has(k)).length;
                        checked       = selCount === subKeys.length;
                        indeterminate = selCount > 0 && selCount < subKeys.length;
                      }
                      // collapsed → unchecked, no indeterminate
                    } else {
                      checked = selected.has(opt.key);
                    }

                    return (
                      <div key={opt.key}>
                        <div className="flex items-center gap-3 px-4 py-2.5 bg-muted/10 cursor-pointer select-none hover:bg-muted/20 transition-colors" onClick={() => toggleOptionGroup(opt)}>
                          <Checkbox
                            checked={indeterminate ? "indeterminate" : checked}
                            onCheckedChange={() => toggleOptionGroup(opt)}
                            onClick={e => e.stopPropagation()}
                            className="shrink-0"
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold leading-none">{opt.label}</p>
                            {opt.description && (
                              <p className="text-xs text-muted-foreground mt-0.5">{opt.description}</p>
                            )}
                          </div>
                          {hasSubs && (
                            <span className="text-[10px] text-muted-foreground shrink-0 select-none">
                              {isExpanded ? "▲" : "▼"}
                            </span>
                          )}
                        </div>

                        {hasSubs && isExpanded && (
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
