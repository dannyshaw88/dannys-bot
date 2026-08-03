import { AppLayout } from "@/components/layout/AppLayout";
import { useState, useRef, useCallback, useEffect } from "react";
import { useLocation } from "wouter";
import { useQueryClient, useQuery, useQueries } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Loader2, CheckCircle2, AlertCircle, Trash2, Instagram, Eye, EyeOff,
  ClipboardPaste, Upload, GripVertical, Pencil, X, Plus, RotateCcw, Smartphone,
} from "lucide-react";
import { useCreateProfile } from "@/hooks/use-profiles";
import { userAgents } from "@/shared/userAgents";
import {
  getTrustLevels, type TrustLevelEntry, reorderTrustLevels,
  deleteTrustLevel, addCustomTrustLevel, getAllProfilesWithTrustScore,
  setTrustScore, updateTrustLevelStyle, CUSTOM_ICONS,
} from "@/components/TrustScoreBadge";
import { IconPicker } from "@/components/trustscore/IconPicker";
import { getIconByKey } from "@/components/trustscore/iconRegistry";

// ─── Trust Scores Tab ─────────────────────────────────────────────────────────


function resolveTsIcon(
  base: TrustLevelEntry["icon"],
  iconKey: string
): TrustLevelEntry["icon"] {
  if (!iconKey) return base;
  if (CUSTOM_ICONS[iconKey]) return CUSTOM_ICONS[iconKey];
  const lucide = getIconByKey(iconKey);
  if (lucide) return lucide as TrustLevelEntry["icon"];
  return base;
}

function loadTsNotes(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem("equinox:ts_notes") ?? "{}"); } catch { return {}; }
}
function saveTsNote(id: string, note: string) {
  const all = loadTsNotes();
  all[id] = note;
  localStorage.setItem("equinox:ts_notes", JSON.stringify(all));
}


interface TsEditState {
  level: TrustLevelEntry;
  bg: string;
  text: string;
  border: string;
  iconKey: string;
  showIconPicker: boolean;
}

export function TrustScoresTabContent() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const [levels, setLevels] = useState<TrustLevelEntry[]>(() => getTrustLevels());
  const [notes, setNotes] = useState<Record<string, string>>(() => loadTsNotes());
  const [deleteTarget, setDeleteTarget] = useState<TrustLevelEntry | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [editState, setEditState] = useState<TsEditState | null>(null);
  const [durations, setDurations] = useState<Record<string, number | null>>({});
  const durationTimers = useRef<Record<string, number>>({});

  const dragIdxRef = useRef<number | null>(null);
  const dragOverIdxRef = useRef<number | null>(null);

  const refreshLevels = () => setLevels(getTrustLevels());

  useEffect(() => {
    fetch("/api/trust-scores/durations", { credentials: "include", cache: "no-store" })
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        if (!data?.durations) return;
        const loaded: Record<string, number | null> = {};
        for (const [id, value] of Object.entries(data.durations)) {
          const hours = Number(value);
          if (Number.isInteger(hours) && hours >= 1 && hours <= 999) loaded[id] = hours;
        }
        setDurations(loaded);
      })
      .catch(() => {});
    return () => {
      for (const timer of Object.values(durationTimers.current)) window.clearTimeout(timer);
    };
  }, []);

  const updateDuration = (levelId: string, raw: string, hasNextScore: boolean) => {
    const hours = raw === ""
      ? null
      : Math.min(999, Math.max(1, Number.parseInt(raw.replace(/\D/g, ""), 10) || 1));
    setDurations(current => ({ ...current, [levelId]: hours }));
    const existing = durationTimers.current[levelId];
    if (existing) window.clearTimeout(existing);
    durationTimers.current[levelId] = window.setTimeout(() => {
      void fetch(`/api/trust-scores/${encodeURIComponent(levelId)}/duration`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hours, hasNextScore }),
      });
    }, 400);
  };

  const handleNoteChange = (id: string, val: string) => {
    setNotes(prev => ({ ...prev, [id]: val }));
    saveTsNote(id, val);
  };

  const handleDeleteClick = (e: React.MouseEvent, level: TrustLevelEntry) => {
    e.stopPropagation();
    setDeleteTarget(level);
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const id = deleteTarget.id;
    const profileIds = getAllProfilesWithTrustScore(id);
    for (const profileId of profileIds) {
      setTrustScore(profileId, null);
      try {
        await fetch(`/api/profiles/${profileId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountStatus: "stopped" }),
          credentials: "include",
        });
      } catch {}
    }
    if (profileIds.length > 0) {
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
    }
    deleteTrustLevel(id);
    refreshLevels();
    setDeleteTarget(null);
    setDeleting(false);
  };

  const handleAdd = () => {
    const trimmed = newLabel.trim();
    if (!trimmed) return;
    addCustomTrustLevel(trimmed);
    refreshLevels();
    setNewLabel("");
    setShowAdd(false);
  };

  const onDragStart = (e: React.DragEvent, idx: number) => {
    dragIdxRef.current = idx;
    e.dataTransfer.effectAllowed = "move";
  };

  const onDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const from = dragIdxRef.current;
    if (from === null || from === idx) return;
    if (dragOverIdxRef.current === idx) return;
    dragOverIdxRef.current = idx;
    const newLevels = [...levels];
    const [item] = newLevels.splice(from, 1);
    newLevels.splice(idx, 0, item);
    dragIdxRef.current = idx;
    setLevels(newLevels);
  };

  const onDragEnd = () => {
    reorderTrustLevels(levels.map(l => l.id));
    dragIdxRef.current = null;
    dragOverIdxRef.current = null;
  };

  const openEdit = (e: React.MouseEvent, level: TrustLevelEntry) => {
    e.stopPropagation();
    setEditState({ level, bg: level.bg, text: level.text, border: level.border, iconKey: level.iconKey ?? "", showIconPicker: false });
  };

  const saveEdit = () => {
    if (!editState) return;
    updateTrustLevelStyle(editState.level.id, { bg: editState.bg, text: editState.text, border: editState.border, iconKey: editState.iconKey || undefined });
    refreshLevels();
    setEditState(null);
  };

  const resetEdit = () => {
    if (!editState) return;
    updateTrustLevelStyle(editState.level.id, { bg: undefined, text: undefined, border: undefined, iconKey: undefined });
    refreshLevels();
    setEditState(null);
  };

  return (
    <div className="space-y-3">
        <p className="text-sm text-muted-foreground">Drag to reorder. Click a badge to open its mobile Human Session Tool settings.</p>

      <div className="w-full overflow-x-auto">
        <div className="flex items-center gap-2 px-2 mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          <span className="w-[185px]">TrustScore</span>
          <span className="w-[9rem] text-center">Duration</span>
          <span className="flex-1 text-center">Notes</span>
        </div>
        <div className="space-y-1.5 w-full">
        {levels.map((level, idx) => {
          const Icon = level.icon;
          const note = notes[level.id] ?? "";
          return (
            <div
              key={level.id}
              onDragOver={e => onDragOver(e, idx)}
              onDragEnd={onDragEnd}
              className="group flex items-center gap-2 rounded-lg border border-transparent hover:border-border hover:bg-accent/40 transition-colors select-none px-2 py-1.5"
            >
              <div className="flex items-center gap-2 w-[185px] shrink-0">
                {/* Drag handle — only this area initiates drag */}
                <div
                  draggable
                  onDragStart={e => onDragStart(e, idx)}
                  className="flex items-center gap-1 cursor-grab active:cursor-grabbing shrink-0"
                >
                  <GripVertical className="w-3 h-3 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" />
                  <span className="w-5 text-[11px] font-bold text-muted-foreground text-left">{idx + 1}</span>
                  <button
                    onClick={() => setLocation(`/trust-scores/${level.id}`)}
                    onMouseDown={e => e.stopPropagation()}
                    className="flex items-center justify-center gap-1.5 rounded-full px-3.5 py-1.5 hover:opacity-80 active:scale-95 transition-all"
                    style={{ background: level.bg, border: `1px solid ${level.border}`, width: 130, minWidth: 130, maxWidth: 130, overflow: "hidden" }}
                    title="Open mobile Human Session Tool settings for this trust score"
                  >
                    <span style={{ fontSize: 13, fontWeight: 700, color: level.text, letterSpacing: "0.05em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{level.label}</span>
                    <Icon size={13} color={level.text} fill={level.text} strokeWidth={2} className="shrink-0" />
                  </button>
                </div>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  <button onClick={e => openEdit(e, level)} onMouseDown={e => e.stopPropagation()} className="p-0.5 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors" title="Edit badge style">
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button onClick={e => handleDeleteClick(e, level)} onMouseDown={e => e.stopPropagation()} className="p-0.5 rounded text-muted-foreground hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors" title="Delete this trust score">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              {/* Duration — immediately after the TrustScore badge and before Notes. */}
              <div className="flex w-[9rem] items-center justify-center gap-1.5 shrink-0" onMouseDown={e => e.stopPropagation()}>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={3}
                  aria-label={`Duration for ${level.label} in hours`}
                  value={durations[level.id] ?? ""}
                  onChange={e => updateDuration(level.id, e.target.value, idx < levels.length - 1)}
                  className="w-[4.5rem] h-7 px-2 text-sm text-right border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <span className="text-xs text-muted-foreground">hours</span>
              </div>
              {/* Notes — centered within the remaining Notes column. */}
              <div className="flex flex-1 justify-center">
                <textarea
                  value={note}
                  onChange={e => handleNoteChange(level.id, e.target.value)}
                  onMouseDown={e => e.stopPropagation()}
                  onDragStart={e => e.preventDefault()}
                  placeholder="Add a note…"
                  rows={1}
                  className="px-2 py-1 text-xs bg-background border border-border rounded resize-none focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/40 cursor-text"
                  style={{ minHeight: 28, maxHeight: 72, width: "50ch", maxWidth: "50ch", flexShrink: 0, textAlign: "left", direction: "ltr" }}
                  onInput={e => {
                    const t = e.currentTarget;
                    t.style.height = "auto";
                    t.style.height = Math.min(t.scrollHeight, 72) + "px";
                  }}
                />
              </div>
            </div>
          );
        })}

        {/* Add button */}
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 ml-8 mt-1 text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> Add Trust Score
        </button>
        </div>
      </div>

      {editState && !editState.showIconPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-background rounded-xl border border-border shadow-2xl p-6 w-96 mx-4">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-bold">Edit Badge Style</h2>
              <button onClick={() => setEditState(null)} className="p-1 rounded hover:bg-accent transition-colors"><X className="w-4 h-4 text-muted-foreground" /></button>
            </div>
            <div className="flex items-center justify-center mb-5 py-3 rounded-lg bg-accent/40">
              {(() => {
                const PreviewIcon = resolveTsIcon(editState.level.icon, editState.iconKey);
                return (
                  <span className="inline-flex items-center justify-center gap-1.5 rounded-full px-3 py-1" style={{ background: editState.bg, border: `1px solid ${editState.border}` }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: editState.text, letterSpacing: "0.05em" }}>{editState.level.label}</span>
                    <PreviewIcon size={13} color={editState.text} fill={editState.text} strokeWidth={2} />
                  </span>
                );
              })()}
            </div>
            <div className="space-y-3 mb-5">
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium w-28 shrink-0">Pill Colour</label>
                {editState.bg === "transparent" ? (
                  <div className="w-10 h-8 rounded border border-border cursor-pointer shrink-0 flex items-center justify-center text-[9px] text-muted-foreground font-bold" style={{ background: "repeating-conic-gradient(#ccc 0% 25%, #fff 0% 50%) 0 0 / 8px 8px" }} onClick={() => setEditState(s => s ? { ...s, bg: "#1AD2F2" } : s)} title="Click to pick a colour" />
                ) : (
                  <input type="color" value={editState.bg} onChange={e => setEditState(s => s ? { ...s, bg: e.target.value } : s)} className="w-10 h-8 rounded border border-border cursor-pointer p-0.5 bg-background shrink-0" />
                )}
                <input type="text" value={editState.bg} onChange={e => setEditState(s => s ? { ...s, bg: e.target.value } : s)} className="flex-1 px-2 py-1.5 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-primary font-mono" placeholder="#1AD2F2" />
                <button onClick={() => setEditState(s => s ? { ...s, bg: s.bg === "transparent" ? "#1AD2F2" : "transparent" } : s)} className={`text-[10px] px-2 py-1 rounded border transition-colors whitespace-nowrap shrink-0 ${editState.bg === "transparent" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary hover:text-primary"}`}>None</button>
              </div>
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium w-28 shrink-0">Text Colour</label>
                <input type="color" value={editState.text} onChange={e => setEditState(s => s ? { ...s, text: e.target.value } : s)} className="w-10 h-8 rounded border border-border cursor-pointer p-0.5 bg-background shrink-0" />
                <input type="text" value={editState.text} onChange={e => setEditState(s => s ? { ...s, text: e.target.value } : s)} className="flex-1 px-2 py-1.5 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-primary font-mono" maxLength={7} placeholder="#ffffff" />
              </div>
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium w-28 shrink-0">Border Colour</label>
                {editState.border === "transparent" ? (
                  <div className="w-10 h-8 rounded border border-border cursor-pointer shrink-0" style={{ background: "repeating-conic-gradient(#ccc 0% 25%, #fff 0% 50%) 0 0 / 8px 8px" }} onClick={() => setEditState(s => s ? { ...s, border: "#0eb8d4" } : s)} title="Click to pick a colour" />
                ) : (
                  <input type="color" value={editState.border} onChange={e => setEditState(s => s ? { ...s, border: e.target.value } : s)} className="w-10 h-8 rounded border border-border cursor-pointer p-0.5 bg-background shrink-0" />
                )}
                <input type="text" value={editState.border} onChange={e => setEditState(s => s ? { ...s, border: e.target.value } : s)} className="flex-1 px-2 py-1.5 text-xs border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-primary font-mono" placeholder="#0eb8d4" />
                <button onClick={() => setEditState(s => s ? { ...s, border: s.border === "transparent" ? "#0eb8d4" : "transparent" } : s)} className={`text-[10px] px-2 py-1 rounded border transition-colors whitespace-nowrap shrink-0 ${editState.border === "transparent" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary hover:text-primary"}`}>None</button>
              </div>
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium w-28 shrink-0">Icon</label>
                <button onClick={() => setEditState(s => s ? { ...s, showIconPicker: true } : s)} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-accent transition-colors">
                  <editState.level.icon size={14} />
                  <span className="text-sm">{editState.iconKey || "Default"}</span>
                  <span className="text-xs text-muted-foreground ml-1">Change…</span>
                </button>
              </div>
            </div>
            <div className="flex gap-2 justify-between">
              <button onClick={resetEdit} className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-accent transition-colors text-muted-foreground" title="Reset to default colours and icon">
                <RotateCcw className="w-3.5 h-3.5" />Reset
              </button>
              <div className="flex gap-2">
                <button onClick={() => setEditState(null)} className="px-4 py-1.5 text-sm rounded-lg border border-border hover:bg-accent transition-colors">Cancel</button>
                <button onClick={saveEdit} className="px-4 py-1.5 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-semibold">Save</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editState?.showIconPicker && (
        <IconPicker value={editState.iconKey || null} onChange={key => setEditState(s => s ? { ...s, iconKey: key, showIconPicker: false } : s)} onClose={() => setEditState(s => s ? { ...s, showIconPicker: false } : s)} />
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-background rounded-xl border border-border shadow-2xl p-6 max-w-sm w-full mx-4">
            <h2 className="text-base font-bold text-red-600 mb-2">⚠ WARNING</h2>
            <p className="text-sm text-foreground mb-1">
              This will stop all accounts assigned to{" "}
              <span className="inline-flex items-center justify-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: deleteTarget.bg, color: deleteTarget.text, border: `1px solid ${deleteTarget.border}` }}>
                {deleteTarget.label}
                {(() => { const Icon = deleteTarget.icon; return <Icon size={10} color={deleteTarget.text} fill={deleteTarget.text} strokeWidth={2} />; })()}
              </span>.
            </p>
            <p className="text-xs text-muted-foreground mt-2 mb-5">Their trust score will be cleared and they will be set to <span className="font-semibold">Stopped</span>. This cannot be undone automatically.</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleteTarget(null)} disabled={deleting} className="px-4 py-1.5 text-sm rounded-lg border border-border hover:bg-accent transition-colors disabled:opacity-50">Cancel</button>
              <button onClick={handleDeleteConfirm} disabled={deleting} className="px-4 py-1.5 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors font-semibold disabled:opacity-50">{deleting ? "Stopping…" : "Delete & Stop Accounts"}</button>
            </div>
          </div>
        </div>
      )}

      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-background rounded-xl border border-border shadow-2xl p-6 max-w-sm w-full mx-4">
            <h2 className="text-base font-bold mb-4">Add Trust Score</h2>
            <input type="text" autoFocus placeholder="e.g. BEAST MODE" value={newLabel} onChange={e => setNewLabel(e.target.value)} onKeyDown={e => { if (e.key === "Enter") handleAdd(); if (e.key === "Escape") { setShowAdd(false); setNewLabel(""); } }} className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary mb-4" maxLength={20} />
            <div className="flex gap-2 justify-end">
              <button onClick={() => { setShowAdd(false); setNewLabel(""); }} className="px-4 py-1.5 text-sm rounded-lg border border-border hover:bg-accent transition-colors">Cancel</button>
              <button onClick={handleAdd} disabled={!newLabel.trim()} className="px-4 py-1.5 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-semibold disabled:opacity-50">Add</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Bulk Import Tab ──────────────────────────────────────────────────────────

type ImportRowStatus = "pending" | "adding" | "added" | "error";
type ImportParsedRow = {
  id: string;
  username: string;
  password: string;
  twoFASecret: string;
  email: string;
  emailPassword: string;
  status: ImportRowStatus;
  errorMsg?: string;
};

function parseImportRaw(raw: string): ImportParsedRow[] {
  return raw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith("#"))
    .map((line, i) => {
      const parts = line.split(":");
      const username = parts[0]?.trim() ?? "";
      const password = parts[1]?.trim() ?? "";
      const twoFASecret = parts[2]?.trim() ?? "";
      let email = "";
      let emailPassword = "";
      if (parts.length >= 5) {
        email = parts[3]?.trim() ?? "";
        emailPassword = parts.slice(4).join(":").trim();
      } else if (parts.length === 4) {
        const p3 = parts[3]?.trim() ?? "";
        if (p3.includes("@")) { email = p3; } else { emailPassword = p3; }
      }
      return { id: `${i}-${username}-${Date.now()}`, username, password, twoFASecret, email, emailPassword, status: "pending" as ImportRowStatus };
    })
    .filter(r => r.username.length > 0);
}

function ImportStatusBadge({ row }: { row: ImportParsedRow }) {
  if (row.status === "adding") return <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-blue-600"><Loader2 className="w-3 h-3 animate-spin" /> Adding…</span>;
  if (row.status === "added") return <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-green-600"><CheckCircle2 className="w-3 h-3" /> Added</span>;
  if (row.status === "error") return <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-red-600" title={row.errorMsg}><AlertCircle className="w-3 h-3" /> Error</span>;
  return <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-muted-foreground">Pending</span>;
}

function ImportMaskedCell({ value, placeholder }: { value: string; placeholder?: string }) {
  const [show, setShow] = useState(false);
  if (!value) return <span className="text-muted-foreground/40 text-xs italic">{placeholder ?? "—"}</span>;
  return (
    <span className="inline-flex items-center gap-1 min-w-0">
      <span className="text-xs font-mono truncate max-w-[120px]">{show ? value : "•".repeat(Math.min(value.length, 12))}</span>
      <button onClick={() => setShow(v => !v)} className="text-muted-foreground hover:text-foreground shrink-0" title={show ? "Hide" : "Show"}>
        {show ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
      </button>
    </span>
  );
}

export function BulkImportTabContent() {
  const { toast } = useToast();
  const [rawText, setRawText] = useState("");
  const [rows, setRows] = useState<ImportParsedRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [selectedSerial, setSelectedSerial] = useState<string>("");
  const createProfileMutation = useCreateProfile();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { data: phonesData } = useQuery<{ phones: Array<{ serial: string; manufacturer?: string; model?: string; marketName?: string }> }>({
    queryKey: ["/api/mobile/usb-phones"],
    queryFn: () => fetch("/api/mobile/usb-phones").then(r => r.json()),
    refetchInterval: 15_000,
  });

  // Farm-device slot order — kept in sync every 30 s (same as Phone Farm page).
  const { data: farmData } = useQuery<{ devices: Array<{ slotIndex: number; serial: string }> }>({
    queryKey: ["/api/mobile/farm-devices"],
    queryFn: () => fetch("/api/mobile/farm-devices").then(r => r.json()),
    refetchInterval: 30_000,
    staleTime: 20_000,
  });
  const slotBySerial: Record<string, number> = Object.fromEntries(
    (farmData?.devices ?? []).map(d => [d.serial, Number(d.slotIndex)])
  );

  // Phone Farm layout order is physical slot order, not the USB enumeration
  // order and not the device-name/alphabetical order:
  //
  //   row 1: Slot 1 | Slot 2 | Slot 3
  //   row 2: Slot 4 | Slot 5 | Slot 6
  //
  // The registry's slotIndex is 1-based and already represents those cells,
  // so ascending slotIndex is the canonical order for this selector too.
  // Keep unregistered connected phones after the farm devices, preserving
  // their USB response order rather than inventing a second ordering rule.
  const phones = [...(phonesData?.phones ?? [])]
    .map((phone, responseIndex) => ({ phone, responseIndex }))
    .sort((a, b) => {
      const slotA = Number.isFinite(slotBySerial[a.phone.serial])
        ? slotBySerial[a.phone.serial]
        : Number.POSITIVE_INFINITY;
      const slotB = Number.isFinite(slotBySerial[b.phone.serial])
        ? slotBySerial[b.phone.serial]
        : Number.POSITIVE_INFINITY;
      return slotA - slotB || a.responseIndex - b.responseIndex;
    })
    .map(({ phone }) => phone);

  // Slot counts per device — one query per connected phone, refreshed every 15 s.
  const slotCountResults = useQueries({
    queries: phones.map(p => ({
      queryKey: ["/api/mobile/devices", p.serial, "account"],
      queryFn: () => fetch(`/api/mobile/devices/${encodeURIComponent(p.serial)}/account`).then(r => r.ok ? r.json() : { slots: [] }),
      refetchInterval: 15_000,
      staleTime: 10_000,
    })),
  });
  const slotCountBySerial: Record<string, number | null> = Object.fromEntries(
    phones.map((p, i) => {
      const data = slotCountResults[i]?.data as { slots?: unknown[] } | undefined;
      return [p.serial, Array.isArray(data?.slots) ? data.slots.length : null];
    })
  );

  const pendingRows = rows.filter(r => r.status === "pending");
  const allPendingSelected = pendingRows.length > 0 && pendingRows.every(r => selectedIds.has(r.id));
  const toggleAll = () => {
    if (allPendingSelected) { setSelectedIds(prev => { const n = new Set(prev); pendingRows.forEach(r => n.delete(r.id)); return n; }); }
    else { setSelectedIds(prev => { const n = new Set(prev); pendingRows.forEach(r => n.add(r.id)); return n; }); }
  };
  const toggleRow = (id: string) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const addRowsToDevice = useCallback(async (
    idsToAdd: string[],
    serial: string,
    sourceRows: ImportParsedRow[] = rows,
  ) => {
    // Load current slots, merge new ones in (skip duplicates by username), save back
    let existingSlots: Array<{ username: string; password: string; totpSecret?: string; emailAddress?: string; emailPassword?: string; phoneNumber?: string }> = [];
    try {
      const r = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/account`);
      if (r.ok) {
        const d = await r.json();
        existingSlots = Array.isArray(d?.slots) ? d.slots : [];
      }
    } catch { /* start fresh if fetch fails */ }

    const existingUsernames = new Set(existingSlots.map(s => s.username.toLowerCase()));
    const toAdd = idsToAdd.map(id => sourceRows.find(r => r.id === id)).filter(Boolean) as ImportParsedRow[];

    // Mark all as "adding" first
    setRows(prev => prev.map(r => idsToAdd.includes(r.id) && r.status === "pending" ? { ...r, status: "adding" } : r));

    const newSlots = toAdd
      .filter(row => row.status === "pending" || row.status === "adding")
      .filter(row => !existingUsernames.has(row.username.toLowerCase()))
      .map(row => ({
        username: row.username,
        password: row.password,
        totpSecret: row.twoFASecret || "",
        emailAddress: row.email || "",
        emailPassword: row.emailPassword || "",
        phoneNumber: "",
      }));

    const merged = [...existingSlots, ...newSlots];

    try {
      const r = await fetch(`/api/mobile/devices/${encodeURIComponent(serial)}/account`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slots: merged }),
      });
      if (!r.ok) throw new Error(await r.text());
      // Mark added/error based on whether each username made it in
      const savedUsernames = new Set(newSlots.map(s => s.username.toLowerCase()));
      const duplicates = new Set(toAdd.filter(row => existingUsernames.has(row.username.toLowerCase())).map(r => r.id));
      setRows(prev => prev.map(r => {
        if (!idsToAdd.includes(r.id)) return r;
        if (duplicates.has(r.id)) return { ...r, status: "error", errorMsg: "Already exists on this device" };
        if (savedUsernames.has(r.username.toLowerCase())) return { ...r, status: "added" };
        return r;
      }));
      setSelectedIds(prev => { const n = new Set(prev); idsToAdd.forEach(id => n.delete(id)); return n; });
      const ok = newSlots.length;
      const dup = duplicates.size;
      if (ok > 0 && dup === 0) toast({ title: `${ok} account${ok !== 1 ? "s" : ""} added to device slots` });
      else if (ok > 0) toast({ title: `${ok} added, ${dup} skipped (duplicate)`, variant: "destructive" });
      else toast({ title: "All duplicates — nothing added", description: "These usernames already exist on this device.", variant: "destructive" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Save failed";
      setRows(prev => prev.map(r => idsToAdd.includes(r.id) ? { ...r, status: "error", errorMsg: msg } : r));
      toast({ title: "Failed to save to device", description: msg, variant: "destructive" });
    }
  }, [rows, toast]);

  const addRows = useCallback(async (idsToAdd: string[]) => {
    if (idsToAdd.length === 0) return;
    if (selectedSerial) {
      setAdding(true);
      await addRowsToDevice(idsToAdd, selectedSerial);
      setAdding(false);
      return;
    }
    // No device selected — fall back to profile creation
    setAdding(true);
    let ok = 0, fail = 0;
    for (const id of idsToAdd) {
      const row = rows.find(r => r.id === id);
      if (!row || row.status !== "pending") continue;
      setRows(prev => prev.map(r => r.id === id ? { ...r, status: "adding" } : r));
      try {
        const ua = userAgents[Math.floor(Math.random() * userAgents.length)];
        await createProfileMutation.mutateAsync({
          username: row.username, password: row.password, accountLabel: row.username,
          twoFASecretKey: row.twoFASecret || null,
          emailValidationUsername: row.email || null,
          emailValidationPassword: row.emailPassword || null,
          proxyHost: "", proxyPort: null, proxyUsername: "", proxyPassword: "",
          userAgentApi: ua.api, userAgentEmbedded: ua.embedded,
        });
        setRows(prev => prev.map(r => r.id === id ? { ...r, status: "added" } : r));
        setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n; });
        ok++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to create";
        setRows(prev => prev.map(r => r.id === id ? { ...r, status: "error", errorMsg: msg } : r));
        fail++;
      }
    }
    setAdding(false);
    if (ok > 0 && fail === 0) toast({ title: `${ok} account${ok !== 1 ? "s" : ""} added`, description: "Now visible on the Accounts page." });
    else if (ok > 0) toast({ title: `${ok} added, ${fail} failed`, variant: "destructive" });
    else toast({ title: "All failed", description: "Check error rows for details.", variant: "destructive" });
  }, [rows, selectedSerial, addRowsToDevice, createProfileMutation, toast]);

  const handleSortAndAdd = useCallback(async () => {
    if (!rawText.trim()) {
      toast({ title: "Nothing to sort", description: "Paste account data first.", variant: "destructive" });
      return;
    }
    if (!selectedSerial) {
      toast({ title: "Select a target device", description: "Choose a device before sorting accounts.", variant: "destructive" });
      return;
    }
    const parsed = parseImportRaw(rawText);
    if (parsed.length === 0) {
      toast({ title: "No accounts found", description: "Check the pasted account data.", variant: "destructive" });
      return;
    }

    const ids = parsed.map(row => row.id);
    setRows(parsed);
    setSelectedIds(new Set(ids));
    setAdding(true);
    try {
      await addRowsToDevice(ids, selectedSerial, parsed);
    } finally {
      setAdding(false);
    }
  }, [rawText, selectedSerial, addRowsToDevice, toast]);

  const removeRow = (id: string) => { setRows(prev => prev.filter(r => r.id !== id)); setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n; }); };
  const handleClear = () => { setRawText(""); setRows([]); setSelectedIds(new Set()); };
  const selectedPendingCount = [...selectedIds].filter(id => rows.find(r => r.id === id)?.status === "pending").length;

  const selectedPhone = phones.find(p => p.serial === selectedSerial);
  const deviceLabel = selectedPhone
    ? (selectedPhone.marketName ?? (selectedPhone.manufacturer ? `${selectedPhone.manufacturer} ${selectedPhone.model ?? selectedPhone.serial}` : selectedPhone.serial))
    : null;

  return (
    <div className="w-full pb-8">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-lg font-bold">Bulk Account Import</h2>
          <p className="text-sm text-muted-foreground mt-0.5">Paste credentials, select a device, and add accounts as slots.</p>
        </div>
        {rows.length > 0 && <Button variant="ghost" size="sm" onClick={handleClear} className="text-muted-foreground">Clear all</Button>}
      </div>

      {/* Device selector */}
      <div className="rounded-lg border border-border bg-card p-4 mb-4 flex items-center gap-3">
        <Smartphone className="w-4 h-4 text-muted-foreground shrink-0" />
        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground whitespace-nowrap">Target Device</span>
        {phones.length === 0 ? (
          <span className="text-xs text-muted-foreground italic">No devices connected — accounts will be added to Profiles instead</span>
        ) : (
          <select
            value={selectedSerial}
            onChange={e => setSelectedSerial(e.target.value)}
            className="flex-1 text-sm bg-background border border-border rounded-md px-3 py-1.5 outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">— No device (add to Profiles) —</option>
            {phones.map(p => {
              const name = p.marketName ?? (p.manufacturer ? `${p.manufacturer} ${p.model ?? p.serial}` : p.serial);
              const slots = slotCountBySerial[p.serial];
              const slotSuffix = slots != null && slots > 0 ? ` · ${slots} slot${slots !== 1 ? 's' : ''}` : '';
              const slotIdx = slotBySerial[p.serial];
              const slotPrefix = slotIdx != null ? `Slot ${slotIdx} — ` : '';
              return (
                <option key={p.serial} value={p.serial}>{slotPrefix}{name}{slotSuffix}</option>
              );
            })}
          </select>
        )}
        {selectedSerial && (
          <span className="text-xs text-primary font-semibold whitespace-nowrap">→ Account Slots</span>
        )}
      </div>

      <div className="rounded-lg border border-border bg-card p-4 mb-4">
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Raw Account Data</label>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          </div>
        </div>
        <textarea
          ref={textareaRef}
          value={rawText}
          onChange={e => setRawText(e.target.value)}
          placeholder="Paste one account per line"
          rows={6}
          className="w-full font-mono text-xs bg-background border border-border rounded-md px-3 py-2 resize-y outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/40"
          spellCheck={false}
        />
        <div className="flex items-center justify-between mt-3">
          <p className="text-[11px] text-muted-foreground">One account per line. Fields auto-detected by field count.</p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={async () => {
              try { const text = await navigator.clipboard.readText(); setRawText(text); }
              catch { toast({ title: "Clipboard unavailable", description: "Paste manually into the text box.", variant: "destructive" }); }
            }} className="h-8 text-xs gap-1.5">
              <ClipboardPaste className="w-3.5 h-3.5" /> Paste
            </Button>
            <Button size="sm" onClick={handleSortAndAdd} disabled={!rawText.trim() || !selectedSerial || adding} className="h-8 text-xs gap-1.5">
              {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
              Sort Accounts
            </Button>
          </div>
        </div>
      </div>

      {rows.length > 0 && (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/30">
            <div className="flex items-center gap-3">
              <Checkbox checked={allPendingSelected} onCheckedChange={toggleAll} disabled={pendingRows.length === 0} />
              <span className="text-xs text-muted-foreground">
                {rows.length} account{rows.length !== 1 ? "s" : ""} parsed
                {selectedPendingCount > 0 && ` · ${selectedPendingCount} selected`}
              </span>
            </div>
          </div>
          <div className="grid grid-cols-[20px_180px_140px_180px_200px_130px_90px_60px] gap-x-3 px-4 py-2 border-b border-border bg-muted/20 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            <div /><div>Username</div><div>Password</div><div>2FA Secret</div><div>Email</div><div>Email Pass</div><div>Status</div><div />
          </div>
          <div className="divide-y divide-border/30 max-h-[520px] overflow-y-auto">
            {rows.map((row, idx) => {
              const isSelected = selectedIds.has(row.id);
              const isPending = row.status === "pending";
              return (
                <div key={row.id} className={`grid grid-cols-[20px_180px_140px_180px_200px_130px_90px_60px] gap-x-3 px-4 py-1.5 items-center transition-colors ${isSelected && isPending ? "bg-primary/8" : row.status === "added" ? "opacity-50" : idx % 2 === 1 ? "bg-slate-50/60" : "bg-white"}`}>
                  <div><Checkbox checked={isSelected && isPending} disabled={!isPending} onCheckedChange={() => isPending && toggleRow(row.id)} /></div>
                  <div className="min-w-0"><span className="inline-flex items-center gap-1 text-xs font-semibold truncate"><Instagram className="w-3 h-3 text-muted-foreground shrink-0" />{row.username || <span className="text-red-500 italic">missing</span>}</span></div>
                  <div className="min-w-0"><ImportMaskedCell value={row.password} placeholder="no password" /></div>
                  <div className="min-w-0"><ImportMaskedCell value={row.twoFASecret} placeholder="no 2FA" /></div>
                  <div className="min-w-0">{row.email ? <span className="text-xs truncate block max-w-[190px]">{row.email}</span> : <span className="text-muted-foreground/40 text-xs italic">no email</span>}</div>
                  <div className="min-w-0"><ImportMaskedCell value={row.emailPassword} placeholder="no email pass" /></div>
                  <div><ImportStatusBadge row={row} /></div>
                  <div className="flex items-center gap-2 justify-end">
                    {isPending && <button onClick={() => addRows([row.id])} disabled={adding} className="text-[10px] font-semibold text-blue-600 hover:text-blue-800 disabled:opacity-40 transition-colors whitespace-nowrap">Add</button>}
                    {isPending && <button onClick={() => removeRow(row.id)} className="text-muted-foreground hover:text-destructive transition-colors"><Trash2 className="w-3.5 h-3.5" /></button>}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="px-4 py-2 border-t border-border bg-muted/20 flex items-center gap-4 text-[11px] text-muted-foreground">
            {(() => { const a = rows.filter(r => r.status === "added").length; const e = rows.filter(r => r.status === "error").length; const p = rows.filter(r => r.status === "pending").length; return <>{p > 0 && <span>{p} pending</span>}{a > 0 && <span className="text-green-600 font-medium">{a} added</span>}{e > 0 && <span className="text-red-600 font-medium">{e} error{e !== 1 ? "s" : ""}</span>}</>; })()}
          </div>
        </div>
      )}

    </div>
  );
}

// ─── Tools Page ───────────────────────────────────────────────────────────────

const TOOLS_TABS = ["Trust Scores", "Import"] as const;
type ToolsTab = typeof TOOLS_TABS[number];

export function ToolsPageContent() {
  const [activeTab, setActiveTab] = useState<ToolsTab>("Trust Scores");

  return (
    <div>
      <div className="flex items-center gap-0 mb-6 border-b border-border/60">
        {TOOLS_TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-5 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${
              activeTab === tab
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "Trust Scores" && (
        <div className="desktop-card p-6">
          <TrustScoresTabContent />
        </div>
      )}

      {activeTab === "Import" && <BulkImportTabContent />}
    </div>
  );
}

export function ToolsPage() {
  return (
    <AppLayout>
      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Tools</h1>
        <p className="text-muted-foreground mt-1">Trust score configuration and bulk import.</p>
      </div>
      <ToolsPageContent />
    </AppLayout>
  );
}
