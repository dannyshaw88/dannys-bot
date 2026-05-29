import { useState, useRef, useEffect } from "react";
import {
  Sprout, Flame, Snail, Droplet, Hourglass, Coffee, Anchor, Turtle,
  Scan, Activity, TrendingUp, Ghost, Star, Rocket, Crown, Zap,
  Diamond, Swords, Sparkles
} from "lucide-react";

const GREEN_BG     = "#1AD2F2";
const GREEN_TEXT   = "#ffffff";
const GREEN_BORDER = "#0eb8d4";

export const TRUST_LEVELS = [
  { id: "noob",        label: "NOOB",        icon: Sprout,     bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "warmup",      label: "WARMUP",       icon: Flame,      bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "snail",       label: "SNAIL",        icon: Snail,      bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "slug",        label: "SLUG",         icon: Droplet,    bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "slow",        label: "SLOW",         icon: Hourglass,  bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "sloth",       label: "SLOTH",        icon: Coffee,     bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "tortoise",    label: "TORTOISE",     icon: Anchor,     bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "turtle",      label: "TURTLE",       icon: Turtle,     bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "reptile",     label: "REPTILE",      icon: Scan,       bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "moderate",    label: "MODERATE",     icon: Activity,   bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "high",        label: "HIGH",         icon: TrendingUp, bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "monster",     label: "MONSTER",      icon: Ghost,      bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "class",       label: "CLASS",        icon: Star,       bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "super",       label: "SUPER",        icon: Rocket,     bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "outstanding", label: "OUTSTANDING",  icon: Crown,      bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "ridiculous",  label: "RIDICULOUS",   icon: Zap,        bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "impossible",  label: "IMPOSSIBLE",   icon: Diamond,    bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "overpowered", label: "OVERPOWERED",  icon: Swords,     bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
  { id: "god_level",   label: "GOD LEVEL",    icon: Sparkles,   bg: GREEN_BG, text: GREEN_TEXT, border: GREEN_BORDER },
] as const;

export type TrustLevelId = typeof TRUST_LEVELS[number]["id"];

const lsKey = (profileId: number) => `trustscore_v2_${profileId}`;

export function getTrustScore(profileId: number): TrustLevelId | null {
  const val = localStorage.getItem(lsKey(profileId));
  if (!val) return null;
  return TRUST_LEVELS.some(l => l.id === val) ? (val as TrustLevelId) : null;
}

export function setTrustScore(profileId: number, id: TrustLevelId | null) {
  if (id === null) localStorage.removeItem(lsKey(profileId));
  else localStorage.setItem(lsKey(profileId), id);
}

interface TrustScoreBadgeProps {
  profileId: number;
}

export function TrustScoreBadge({ profileId }: TrustScoreBadgeProps) {
  const [score, setScore] = useState<TrustLevelId | null>(() => getTrustScore(profileId));
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

  const current = TRUST_LEVELS.find(l => l.id === score);

  const handleSelect = (id: TrustLevelId) => {
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
          {TRUST_LEVELS.map(lvl => {
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
        </div>
      )}
    </div>
  );
}
