import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getTrustLevels, type TrustLevelEntry } from "./TrustScoreBadge";
import {
  loadSlotTrustScore,
  readLocalSlotTrustScore,
  saveSlotTrustScore,
  slotTrustScoreKey,
} from "./slotTrustScoreStorage";

const ROW_HEIGHT = 30;
const MAX_VISIBLE_ROWS = 5;

interface MetricsSlotTrustScoreBadgeProps {
  serial: string;
  slotIdx: number;
}

/**
 * Metrics-only slot badge.
 *
 * This intentionally does not use TrustScoreBadge or DashboardSlotTrustScoreBadge
 * as a component. Metrics needs the device-slot trust score, while the other
 * badge instances must remain isolated from any future Metrics-specific changes.
 */
export function MetricsSlotTrustScoreBadge({ serial, slotIdx }: MetricsSlotTrustScoreBadgeProps) {
  const [scoreId, setScoreId] = useState<string | null>(() => readLocalSlotTrustScore(serial, slotIdx));
  const [open, setOpen] = useState(false);
  const [levels, setLevels] = useState<TrustLevelEntry[]>(() => getTrustLevels());
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    loadSlotTrustScore(serial, slotIdx).then(loadedScore => {
      if (!active) return;
      setScoreId(loadedScore);
    }).catch(() => {
      // Keep the locally cached score on transient errors.
    });

    return () => { active = false; };
  }, [serial, slotIdx]);

  useEffect(() => {
    const storageKey = slotTrustScoreKey(serial, slotIdx);
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey) setScoreId(event.newValue ?? null);
      if (event.key === "trustlevels_v1") setLevels(getTrustLevels());
    };
    const onTrustScoreChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ serial?: string; slotIdx?: number; scoreId?: string | null }>).detail;
      if (detail?.serial === serial && detail.slotIdx === slotIdx) {
        setScoreId(detail.scoreId ?? null);
      }
    };
    const onLevelsChanged = () => setLevels(getTrustLevels());
    window.addEventListener("storage", onStorage);
    window.addEventListener("mobile_trustscore_changed", onTrustScoreChanged);
    window.addEventListener("trustscore_changed", onLevelsChanged);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("mobile_trustscore_changed", onTrustScoreChanged);
      window.removeEventListener("trustscore_changed", onLevelsChanged);
    };
  }, [serial, slotIdx]);

  useEffect(() => {
    if (!open) return;
    const onOutsideClick = (event: MouseEvent) => {
      if (
        buttonRef.current && !buttonRef.current.contains(event.target as Node) &&
        dropdownRef.current && !dropdownRef.current.contains(event.target as Node)
      ) setOpen(false);
    };
    document.addEventListener("mousedown", onOutsideClick);
    return () => document.removeEventListener("mousedown", onOutsideClick);
  }, [open]);

  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
  useEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const maxHeight = Math.min(levels.length + (scoreId ? 1 : 0), MAX_VISIBLE_ROWS) * ROW_HEIGHT + 8;
    const below = window.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    setDropdownStyle({
      position: "fixed",
      zIndex: 99999,
      top: below >= maxHeight || below >= above ? rect.bottom + 4 : rect.top - maxHeight - 4,
      left: rect.left,
      width: 200,
      maxHeight,
      overflowY: "auto",
      background: "hsl(var(--background, 0 0% 100%))",
      border: "1px solid var(--border, #e5e7eb)",
      borderRadius: 8,
      boxShadow: "0 8px 32px rgba(0,0,0,0.24)",
      padding: "4px 0",
    });
  }, [open, levels.length, scoreId]);

  const saveScore = async (nextScoreId: string | null) => {
    setScoreId(nextScoreId);
    setOpen(false);
    try {
      await saveSlotTrustScore(serial, slotIdx, nextScoreId);
    } catch {
      // Keep the optimistic value; the next hydration can retry the server read.
    }
  };

  const current = levels.find(level => level.id === scoreId) ?? null;

  return (
    <div className="flex items-center gap-2 shrink-0" onMouseDown={event => event.stopPropagation()}>
      <div className="relative inline-block shrink-0">
        <button
          ref={buttonRef}
          type="button"
          onClick={event => { event.stopPropagation(); setOpen(value => !value); }}
          onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }}
          className="flex items-center justify-center gap-1 rounded-md px-2 transition-all hover:brightness-95"
          style={{
            background: current ? current.bg : "transparent",
            border: current ? `1px solid ${current.border}` : "1px dashed #94a3b8",
            color: current ? current.text : "#94a3b8",
            cursor: "pointer",
            width: 112,
            minWidth: 112,
            height: 28,
            overflow: "hidden",
          }}
          title={current ? current.label : "Click to set Trust Score"}
        >
          {current ? (
            <>
              <span className="text-[10px] font-bold tracking-wide truncate">{current.label}</span>
              <current.icon size={10} color={current.text} fill={current.text} strokeWidth={2} />
            </>
          ) : (
            <span className="text-[10px] font-medium tracking-wide">Score</span>
          )}
        </button>

        {open && createPortal(
          <div ref={dropdownRef} style={dropdownStyle}>
            {levels.map(level => {
              const Icon = level.icon;
              const isActive = scoreId === level.id;
              return (
                <button
                  key={level.id}
                  type="button"
                  onClick={event => { event.stopPropagation(); void saveScore(level.id); }}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "5px 12px",
                    height: ROW_HEIGHT,
                    background: isActive ? level.bg : "transparent",
                    border: "none",
                    borderLeft: isActive ? `3px solid ${level.border}` : "3px solid transparent",
                    cursor: "pointer",
                    textAlign: "left",
                    outline: "none",
                  }}
                >
                  <Icon size={12} color={isActive ? level.text : "#111827"} fill={isActive ? level.text : "none"} strokeWidth={2} />
                  <span style={{ fontSize: 11, fontWeight: 600, color: isActive ? level.text : "#111827", letterSpacing: "0.05em" }}>
                    {level.label}
                  </span>
                </button>
              );
            })}
            {scoreId && (
              <button
                type="button"
                onClick={event => { event.stopPropagation(); void saveScore(null); }}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  padding: "5px 12px",
                  height: ROW_HEIGHT,
                  background: "transparent",
                  border: "none",
                  borderTop: "1px solid #e5e7eb",
                  cursor: "pointer",
                  textAlign: "left",
                  outline: "none",
                }}
              >
                <span style={{ fontSize: 11, fontWeight: 500, color: "#6b7280", letterSpacing: "0.05em" }}>Clear score</span>
              </button>
            )}
          </div>,
          document.body,
        )}
      </div>

    </div>
  );
}