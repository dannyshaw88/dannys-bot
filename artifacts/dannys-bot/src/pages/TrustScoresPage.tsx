import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getTrustLevels, TrustLevelEntry, reorderTrustLevels,
  deleteTrustLevel, addCustomTrustLevel, getAllProfilesWithTrustScore, setTrustScore,
} from "@/components/TrustScoreBadge";
import { AppLayout } from "@/components/layout/AppLayout";
import { X, Plus, GripVertical } from "lucide-react";

const PROFILES_QUERY_KEY = "/api/profiles";

export function TrustScoresPage() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const [levels, setLevels] = useState<TrustLevelEntry[]>(() => getTrustLevels());
  const [deleteTarget, setDeleteTarget] = useState<TrustLevelEntry | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [deleting, setDeleting] = useState(false);

  const dragIdxRef = useRef<number | null>(null);
  const dragOverIdxRef = useRef<number | null>(null);

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
      queryClient.invalidateQueries({ queryKey: [PROFILES_QUERY_KEY] });
    }

    deleteTrustLevel(id);
    setLevels(getTrustLevels());
    setDeleteTarget(null);
    setDeleting(false);
  };

  const handleAdd = () => {
    const trimmed = newLabel.trim();
    if (!trimmed) return;
    addCustomTrustLevel(trimmed);
    setLevels(getTrustLevels());
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

  const rows: TrustLevelEntry[][] = [];
  for (let i = 0; i < levels.length; i += 5) {
    rows.push(levels.slice(i, i + 5));
  }

  return (
    <AppLayout>
      <div className="p-6 space-y-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">TrustScores</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configure API limits and tool defaults for each trust score tier. Drag to reorder.
          </p>
        </div>

        <div className="space-y-1">
          {rows.map((row, rowIdx) => (
            <div key={rowIdx} className="flex gap-2 items-center">
              {row.map((level, colIdx) => {
                const globalIdx = rowIdx * 5 + colIdx;
                const Icon = level.icon;
                return (
                  <div
                    key={level.id}
                    draggable
                    onDragStart={e => onDragStart(e, globalIdx)}
                    onDragOver={e => onDragOver(e, globalIdx)}
                    onDragEnd={onDragEnd}
                    className="group relative flex items-center gap-2 px-2 py-2 rounded-lg border border-transparent hover:border-border hover:bg-accent transition-colors cursor-grab active:cursor-grabbing select-none"
                    style={{ width: 220 }}
                  >
                    <GripVertical className="w-3 h-3 text-muted-foreground/40 shrink-0 group-hover:text-muted-foreground transition-colors" />
                    <span className="w-5 text-[11px] font-bold text-muted-foreground shrink-0 text-right">
                      {globalIdx + 1}
                    </span>
                    <button
                      onClick={() => setLocation(`/trust-scores/${level.id}`)}
                      className="flex items-center gap-1.5 rounded-full px-3 py-1 shrink-0 hover:opacity-80 transition-opacity"
                      style={{ background: "#1AD2F2" }}
                      onMouseDown={e => e.stopPropagation()}
                    >
                      <Icon size={12} color="#ffffff" fill="#ffffff" strokeWidth={2} />
                      <span style={{ fontSize: 11, fontWeight: 700, color: "#ffffff", letterSpacing: "0.05em" }}>
                        {level.label}
                      </span>
                    </button>
                    <button
                      onClick={e => handleDeleteClick(e, level)}
                      onMouseDown={e => e.stopPropagation()}
                      className="ml-auto p-0.5 rounded text-muted-foreground hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors opacity-0 group-hover:opacity-100"
                      title="Delete this trust score"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
              {rowIdx === rows.length - 1 && (
                <button
                  onClick={() => setShowAdd(true)}
                  className="flex items-center justify-center rounded-lg border border-dashed border-border hover:border-primary hover:text-primary text-muted-foreground transition-colors shrink-0"
                  style={{ width: 44, height: 38 }}
                  title="Add trust score"
                >
                  <Plus className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}

          {levels.length === 0 && (
            <div className="flex gap-2 items-center">
              <button
                onClick={() => setShowAdd(true)}
                className="flex items-center justify-center rounded-lg border border-dashed border-border hover:border-primary hover:text-primary text-muted-foreground transition-colors"
                style={{ width: 44, height: 38 }}
                title="Add trust score"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        {/* ── Delete warning dialog ─────────────────────────────────── */}
        {deleteTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="bg-background rounded-xl border border-border shadow-2xl p-6 max-w-sm w-full mx-4">
              <h2 className="text-base font-bold text-red-600 mb-2">⚠ WARNING</h2>
              <p className="text-sm text-foreground mb-1">
                This will stop all accounts assigned to{" "}
                <span
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold"
                  style={{ background: "#1AD2F2", color: "#fff" }}
                >
                  {(() => { const Icon = deleteTarget.icon; return <Icon size={10} color="#fff" fill="#fff" strokeWidth={2} />; })()}
                  {deleteTarget.label}
                </span>
                .
              </p>
              <p className="text-xs text-muted-foreground mt-2 mb-5">
                Their trust score will be cleared and they will be set to <span className="font-semibold">Stopped</span>. This cannot be undone automatically.
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setDeleteTarget(null)}
                  disabled={deleting}
                  className="px-4 py-1.5 text-sm rounded-lg border border-border hover:bg-accent transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDeleteConfirm}
                  disabled={deleting}
                  className="px-4 py-1.5 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors font-semibold disabled:opacity-50"
                >
                  {deleting ? "Stopping…" : "Delete & Stop Accounts"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Add trust score dialog ────────────────────────────────── */}
        {showAdd && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="bg-background rounded-xl border border-border shadow-2xl p-6 max-w-sm w-full mx-4">
              <h2 className="text-base font-bold mb-4">Add Trust Score</h2>
              <input
                type="text"
                autoFocus
                placeholder="e.g. BEAST MODE"
                value={newLabel}
                onChange={e => setNewLabel(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") handleAdd();
                  if (e.key === "Escape") { setShowAdd(false); setNewLabel(""); }
                }}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary mb-4"
                maxLength={20}
              />
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => { setShowAdd(false); setNewLabel(""); }}
                  className="px-4 py-1.5 text-sm rounded-lg border border-border hover:bg-accent transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAdd}
                  disabled={!newLabel.trim()}
                  className="px-4 py-1.5 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-semibold disabled:opacity-50"
                >
                  Add
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
