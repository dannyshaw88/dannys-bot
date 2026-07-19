/**
 * DashboardTrustScoreBadge
 *
 * Reads the trust score from the Device → Account Slot → Human Session Tool
 * store (localStorage key `mobile_ts_{serial}_{slotIdx}`), exactly matching
 * what SlotTrustScoreBadge in MobilePage reads.
 *
 * Style overrides (bg / text / border / icon per level) are stored under a
 * SEPARATE key `dashboard_trustlevels_v1` so customising this badge's
 * appearance has no effect on any other TrustScoreBadge instance.
 */

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { getTrustLevels, type TrustLevelEntry } from "./TrustScoreBadge";
import { getIconByKey } from "./trustscore/iconRegistry";
import { CUSTOM_ICONS } from "./TrustScoreBadge";

// ── Dashboard-specific style overrides ───────────────────────────────────────

const DASHBOARD_LS_KEY = "dashboard_trustlevels_v1";

interface DashboardStyleOverride {
  bg?: string;
  text?: string;
  border?: string;
  iconKey?: string;
}

interface DashboardTrustLevelsStorage {
  overrides: Record<string, DashboardStyleOverride>;
}

function getDashboardStorage(): DashboardTrustLevelsStorage {
  try {
    const raw = localStorage.getItem(DASHBOARD_LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!parsed.overrides) parsed.overrides = {};
      return parsed;
    }
  } catch {}
  return { overrides: {} };
}

function saveDashboardStorage(s: DashboardTrustLevelsStorage) {
  localStorage.setItem(DASHBOARD_LS_KEY, JSON.stringify(s));
}

/** Update this badge's per-level style without affecting any other badge. */
export function updateDashboardTrustLevelStyle(id: string, updates: DashboardStyleOverride) {
  const s = getDashboardStorage();
  s.overrides[id] = { ...(s.overrides[id] ?? {}), ...updates };
  saveDashboardStorage(s);
  window.dispatchEvent(new CustomEvent("dashboard_trustlevels_changed"));
}

/** Get trust levels with dashboard-specific style overrides applied on top. */
function getDashboardTrustLevels(): TrustLevelEntry[] {
  // Start from the global level list (labels, order, global overrides).
  const base = getTrustLevels();
  const { overrides } = getDashboardStorage();

  return base.map(lvl => {
    const ov = overrides[lvl.id];
    if (!ov) return lvl;
    const resolvedIcon = ov.iconKey
      ? (CUSTOM_ICONS[ov.iconKey] ?? getIconByKey(ov.iconKey) ?? lvl.icon) as TrustLevelEntry["icon"]
      : lvl.icon;
    return {
      ...lvl,
      bg:     ov.bg     ?? lvl.bg,
      text:   ov.text   ?? lvl.text,
      border: ov.border ?? lvl.border,
      iconKey: ov.iconKey ?? lvl.iconKey,
      icon: resolvedIcon,
    };
  });
}

// ── Score storage (shared with MobilePage SlotTrustScoreBadge) ───────────────

function slotLsKey(serial: string, slotIdx: number) {
  return `mobile_ts_${serial}_${slotIdx}`;
}

function readSlotScore(serial: string, slotIdx: number): string | null {
  try { return localStorage.getItem(slotLsKey(serial, slotIdx)) ?? null; } catch { return null; }
}

function writeSlotScore(serial: string, slotIdx: number, id: string | null) {
  try {
    if (id) localStorage.setItem(slotLsKey(serial, slotIdx), id);
    else     localStorage.removeItem(slotLsKey(serial, slotIdx));
  } catch {}
}

// ── Component ─────────────────────────────────────────────────────────────────

const ROW_H = 30;
const MAX_VISIBLE_ROWS = 5;

interface DashboardSlotTrustScoreBadgeProps {
  serial: string;
  slotIdx: number;
  /** Badge width in px — defaults to 120 to fit the Dashboard table column. */
  width?: number;
  /** Badge height in px — defaults to 25. */
  height?: number;
}

export function DashboardSlotTrustScoreBadge({
  serial,
  slotIdx,
  width = 120,
  height = 25,
}: DashboardSlotTrustScoreBadgeProps) {
  const [scoreId, setScoreId] = useState<string | null>(
    () => readSlotScore(serial, slotIdx),
  );
  const [open, setOpen] = useState(false);
  const [levels, setLevels] = useState<TrustLevelEntry[]>(() => getDashboardTrustLevels());

  const btnRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  // Re-read score when serial/slotIdx changes or storage is updated cross-tab.
  useEffect(() => {
    setScoreId(readSlotScore(serial, slotIdx));
  }, [serial, slotIdx]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === slotLsKey(serial, slotIdx)) {
        setScoreId(e.newValue ?? null);
      }
      if (e.key === DASHBOARD_LS_KEY || e.key === "trustlevels_v1") {
        setLevels(getDashboardTrustLevels());
      }
    };
    const onDashboardChanged = () => setLevels(getDashboardTrustLevels());
    const onGlobalChanged   = () => setLevels(getDashboardTrustLevels());
    window.addEventListener("storage", onStorage);
    window.addEventListener("dashboard_trustlevels_changed", onDashboardChanged);
    window.addEventListener("trustscore_changed", onGlobalChanged);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("dashboard_trustlevels_changed", onDashboardChanged);
      window.removeEventListener("trustscore_changed", onGlobalChanged);
    };
  }, [serial, slotIdx]);

  // Close dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        btnRef.current && !btnRef.current.contains(e.target as Node) &&
        dropRef.current && !dropRef.current.contains(e.target as Node)
      ) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Dropdown position.
  const [dropStyle, setDropStyle] = useState<React.CSSProperties>({});
  useEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const rowCount = levels.length + (scoreId ? 1 : 0);
    const maxH = Math.min(rowCount, MAX_VISIBLE_ROWS) * ROW_H + 8;
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const top = spaceBelow >= maxH || spaceBelow >= spaceAbove
      ? rect.bottom + 4
      : rect.top - maxH - 4;
    setDropStyle({
      position: "fixed",
      zIndex: 99999,
      top,
      left: rect.left,
      width: 200,
      maxHeight: maxH,
      overflowY: "auto",
      background: "hsl(var(--background, 0 0% 100%))",
      border: "1px solid var(--border, #e5e7eb)",
      borderRadius: 8,
      boxShadow: "0 8px 32px rgba(0,0,0,0.24)",
      padding: "4px 0",
    });
  }, [open, levels.length, scoreId]);

  const save = (id: string | null) => {
    writeSlotScore(serial, slotIdx, id);
    setScoreId(id);
    setOpen(false);
  };

  const current = levels.find(l => l.id === scoreId) ?? null;

  return (
    <div className="relative inline-block shrink-0" onMouseDown={e => e.stopPropagation()}>
      <button
        ref={btnRef}
        type="button"
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
        className="flex items-center justify-center gap-1 rounded-md px-2 transition-all hover:brightness-95"
        style={{
          background:  current ? current.bg      : "transparent",
          border:      current ? `1px solid ${current.border}` : "1px dashed #94a3b8",
          cursor:      "pointer",
          flexShrink:  0,
          width,
          minWidth:    width,
          maxWidth:    width,
          overflow:    "hidden",
          height,
        }}
        title={current ? current.label : "Click to set Trust Score"}
      >
        {current ? (
          <>
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: "0.06em",
              color: current.text, whiteSpace: "nowrap", overflow: "hidden",
              textOverflow: "clip", flex: 1, minWidth: 0, textAlign: "center",
            }}>
              {current.label}
            </span>
            <current.icon size={10} color={current.text} fill={current.text} strokeWidth={2} style={{ flexShrink: 0 }} />
          </>
        ) : (
          <span style={{
            fontSize: 9, fontWeight: 500, color: "#94a3b8", whiteSpace: "nowrap",
            overflow: "hidden", textOverflow: "clip", letterSpacing: "0.04em",
            flex: 1, minWidth: 0, textAlign: "center",
          }}>
            Score
          </span>
        )}
      </button>

      {open && createPortal(
        <div ref={dropRef} style={dropStyle}>
          {levels.map(lvl => {
            const Icon = lvl.icon;
            const isActive = scoreId === lvl.id;
            return (
              <button
                key={lvl.id}
                type="button"
                onClick={e => { e.stopPropagation(); save(lvl.id); }}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 8,
                  padding: "5px 12px", height: ROW_H,
                  background: isActive ? lvl.bg : "transparent",
                  border: "none",
                  borderLeft: isActive ? `3px solid ${lvl.border}` : "3px solid transparent",
                  cursor: "pointer", textAlign: "left", outline: "none",
                }}
              >
                <Icon size={12} color={isActive ? lvl.text : "#111827"} fill={isActive ? lvl.text : "none"} strokeWidth={2} />
                <span style={{ fontSize: 11, fontWeight: 600, color: isActive ? lvl.text : "#111827", letterSpacing: "0.05em" }}>
                  {lvl.label}
                </span>
              </button>
            );
          })}
          {scoreId && (
            <button
              type="button"
              onClick={e => { e.stopPropagation(); save(null); }}
              style={{
                width: "100%", display: "flex", alignItems: "center",
                padding: "5px 12px", height: ROW_H,
                background: "transparent", border: "none",
                borderTop: "1px solid #e5e7eb", borderLeft: "3px solid transparent",
                cursor: "pointer", textAlign: "left", outline: "none", marginTop: 2,
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 500, color: "#6b7280", letterSpacing: "0.05em" }}>
                Clear score
              </span>
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
