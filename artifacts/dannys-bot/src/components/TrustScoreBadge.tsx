import { useState, useRef, useEffect } from "react";
import {
  Snail, Hourglass, Coffee, Anchor, Turtle,
  Scan, Activity, TrendingUp, Ghost, Diamond, Rocket, Crown, Zap,
  Gem, Swords, Sparkles
} from "lucide-react";

function ConfusedFaceIcon({ size = 12, color = "currentColor", ..._ }: { size?: number; color?: string; [k: string]: any }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="10" stroke={color} strokeWidth="2" />
      <circle cx="8.5" cy="11" r="1.2" fill={color} />
      <circle cx="15.5" cy="9.5" r="1.2" fill={color} />
      <path d="M6.5 8 Q8.5 7.2 10.5 8" stroke={color} strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <path d="M13.5 6 Q15.5 5 17.5 6.5" stroke={color} strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <path d="M8 16 Q9.5 14.5 11.5 16 Q13.5 17.5 16 16" stroke={color} strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <path d="M19.5 8 L19 5.5 L18.5 8" stroke={color} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function StretchingManIcon({ size = 12, color = "currentColor", ..._ }: { size?: number; color?: string; [k: string]: any }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="3.5" r="2" stroke={color} strokeWidth="1.8" />
      <line x1="12" y1="5.5" x2="12" y2="15" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <line x1="12" y1="9" x2="5.5" y2="4" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <line x1="12" y1="9" x2="18.5" y2="4" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <line x1="12" y1="15" x2="8" y2="21.5" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <line x1="12" y1="15" x2="16" y2="21.5" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function SlugIcon({ size = 12, color = "currentColor", ..._ }: { size?: number; color?: string; [k: string]: any }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="8" y1="4" x2="8" y2="8" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <line x1="13" y1="3" x2="13" y2="8" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <circle cx="8" cy="3.5" r="1.5" fill={color} />
      <circle cx="13" cy="2.5" r="1.5" fill={color} />
      <path d="M4 14 Q4 9 9 9 L16 9 Q22 9 22 14 Q22 19 16 19 L6 19 Q4 19 4 17 Q4 15 6 15 L18 15" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

const GREEN_BG     = "#1AD2F2";
const GREEN_TEXT   = "#ffffff";
const GREEN_BORDER = "#0eb8d4";

export interface TrustLevelEntry {
  id: string;
  label: string;
  icon: React.ComponentType<{ size?: number; color?: string; fill?: string; strokeWidth?: number; [k: string]: any }>;
  bg: string;
  text: string;
  border: string;
}

const BASE_TRUST_LEVELS: TrustLevelEntry[] = [
  { id: "noob",        label: "NOOB",        icon: ConfusedFaceIcon,  bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "warmup",      label: "WARMUP",       icon: StretchingManIcon, bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "snail",       label: "SNAIL",        icon: Snail,             bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "slug",        label: "SLUG",         icon: SlugIcon,          bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "slow",        label: "SLOW",         icon: Hourglass,         bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "sloth",       label: "SLOTH",        icon: Coffee,            bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "tortoise",    label: "TORTOISE",     icon: Anchor,            bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "turtle",      label: "TURTLE",       icon: Turtle,            bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "reptile",     label: "REPTILE",      icon: Scan,              bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "moderate",    label: "MODERATE",     icon: Activity,          bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "high",        label: "HIGH",         icon: TrendingUp,        bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "monster",     label: "MONSTER",      icon: Ghost,             bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "class",       label: "CLASS",        icon: Diamond,           bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "super",       label: "SUPER",        icon: Rocket,            bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "outstanding", label: "OUTSTANDING",  icon: Crown,             bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "ridiculous",  label: "RIDICULOUS",   icon: Zap,               bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "impossible",  label: "IMPOSSIBLE",   icon: Gem,               bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "overpowered", label: "OVERPOWERED",  icon: Swords,            bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "god_level",   label: "GOD LEVEL",    icon: Sparkles,          bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
];

export const TRUST_LEVELS: readonly TrustLevelEntry[] = BASE_TRUST_LEVELS;

export type TrustLevelId = string;

// ── Dynamic trust level storage ────────────────────────────────────────────────

const TRUSTLEVELS_LS_KEY = "trustlevels_v1";

interface TrustLevelsStorage {
  order: string[];
  deleted: string[];
  custom: Array<{ id: string; label: string }>;
}

function getTrustLevelsStorage(): TrustLevelsStorage {
  try {
    const raw = localStorage.getItem(TRUSTLEVELS_LS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { order: BASE_TRUST_LEVELS.map(l => l.id), deleted: [], custom: [] };
}

function saveTrustLevelsStorage(s: TrustLevelsStorage) {
  localStorage.setItem(TRUSTLEVELS_LS_KEY, JSON.stringify(s));
}

export function getTrustLevels(): TrustLevelEntry[] {
  const s = getTrustLevelsStorage();
  const byId = new Map<string, TrustLevelEntry>();
  for (const l of BASE_TRUST_LEVELS) byId.set(l.id, l);
  for (const c of s.custom) {
    if (!byId.has(c.id)) {
      byId.set(c.id, { id: c.id, label: c.label, icon: Sparkles, bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER });
    }
  }
  return s.order.filter(id => !s.deleted.includes(id) && byId.has(id)).map(id => byId.get(id)!);
}

export function reorderTrustLevels(newOrder: string[]) {
  const s = getTrustLevelsStorage();
  s.order = newOrder;
  saveTrustLevelsStorage(s);
}

export function deleteTrustLevel(id: string) {
  const s = getTrustLevelsStorage();
  s.deleted = [...s.deleted.filter(d => d !== id), id];
  s.order = s.order.filter(o => o !== id);
  s.custom = s.custom.filter(c => c.id !== id);
  saveTrustLevelsStorage(s);
}

export function addCustomTrustLevel(label: string): string {
  const id = `custom_${Date.now()}`;
  const s = getTrustLevelsStorage();
  s.custom.push({ id, label: label.toUpperCase().trim() });
  s.order.push(id);
  saveTrustLevelsStorage(s);
  return id;
}

export function getAllProfilesWithTrustScore(tsId: string): number[] {
  const results: number[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith("trustscore_v2_")) continue;
    const val = localStorage.getItem(key);
    if (val === tsId) {
      const profileId = parseInt(key.replace("trustscore_v2_", ""), 10);
      if (!isNaN(profileId)) results.push(profileId);
    }
  }
  return results;
}

// ── Per-profile trust score ────────────────────────────────────────────────────

const lsKey = (profileId: number) => `trustscore_v2_${profileId}`;

export function getTrustScore(profileId: number): string | null {
  const val = localStorage.getItem(lsKey(profileId));
  if (!val) return null;
  return getTrustLevels().some(l => l.id === val) ? val : null;
}

export function setTrustScore(profileId: number, id: string | null) {
  if (id === null) localStorage.removeItem(lsKey(profileId));
  else localStorage.setItem(lsKey(profileId), id);
}

// ── Badge component ────────────────────────────────────────────────────────────

interface TrustScoreBadgeProps {
  profileId: number;
}

export function TrustScoreBadge({ profileId }: TrustScoreBadgeProps) {
  const [score, setScore] = useState<string | null>(() => getTrustScore(profileId));
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setScore(getTrustScore(profileId));
  }, [profileId]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const levels = getTrustLevels();
  const current = levels.find(l => l.id === score);

  const handleSelect = (id: string) => {
    setTrustScore(profileId, id);
    setScore(id);
    setOpen(false);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    setTrustScore(profileId, null);
    setScore(null);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative inline-block shrink-0" onMouseDown={e => e.stopPropagation()}>
      <button
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        className="flex h-5 items-center gap-1 rounded-full px-2 transition-opacity hover:opacity-75"
        style={{
          background: current ? GREEN_BG : "transparent",
          border: current ? "none" : "1px dashed #94a3b8",
          cursor: "pointer",
          flexShrink: 0,
          minWidth: 60,
        }}
        title="Click to set Trust Score"
      >
        {current ? (
          <>
            <current.icon size={10} color={GREEN_TEXT} fill={GREEN_TEXT} strokeWidth={2} />
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", color: GREEN_TEXT, whiteSpace: "nowrap" }}>
              {current.label}
            </span>
          </>
        ) : (
          <span style={{ fontSize: 9, fontWeight: 500, color: "#94a3b8", whiteSpace: "nowrap", letterSpacing: "0.04em" }}>Score</span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: "fixed",
            zIndex: 99999,
            background: "#ffffff",
            border: "1px solid var(--border, #e5e7eb)",
            borderRadius: 8,
            boxShadow: "0 8px 32px rgba(0,0,0,0.14)",
            width: 200,
            padding: "4px 0",
            maxHeight: 380,
            overflowY: "auto",
          }}
          ref={el => {
            if (!el) return;
            const btn = ref.current?.querySelector("button");
            if (!btn) return;
            const rect = btn.getBoundingClientRect();
            el.style.top = `${rect.bottom + 4}px`;
            el.style.left = `${rect.left}px`;
          }}
        >
          {levels.map(lvl => {
            const Icon = lvl.icon;
            const isActive = score === lvl.id;
            const itemIconColor = isActive ? GREEN_TEXT : "#111827";
            const itemTextColor = isActive ? GREEN_TEXT : "#111827";
            return (
              <button
                key={lvl.id}
                onClick={e => { e.stopPropagation(); handleSelect(lvl.id); }}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "5px 12px",
                  background: isActive ? GREEN_BG : "transparent",
                  border: "none",
                  borderLeft: isActive ? `3px solid ${GREEN_BORDER}` : "3px solid transparent",
                  cursor: "pointer",
                  textAlign: "left",
                  outline: "none",
                }}
              >
                <Icon size={12} color={itemIconColor} fill={isActive ? GREEN_TEXT : "none"} strokeWidth={2} />
                <span style={{ fontSize: 11, fontWeight: 600, color: itemTextColor, letterSpacing: "0.05em" }}>{lvl.label}</span>
              </button>
            );
          })}
          {score && (
            <button
              onClick={handleClear}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "5px 12px",
                background: "transparent",
                border: "none",
                borderTop: "1px solid #e5e7eb",
                borderLeft: "3px solid transparent",
                cursor: "pointer",
                textAlign: "left",
                outline: "none",
                marginTop: 2,
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 500, color: "#6b7280", letterSpacing: "0.05em" }}>Clear score</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
