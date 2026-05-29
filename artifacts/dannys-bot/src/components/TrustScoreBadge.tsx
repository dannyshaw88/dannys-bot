import { useState, useRef, useEffect } from "react";
import {
  Smile, Flame, Timer, Minus, Clock, Moon, Shield, ShieldCheck,
  Eye, Activity, TrendingUp, Skull, Star, Rocket, Crown, Zap,
  Diamond, Swords, Sparkles
} from "lucide-react";

export const TRUST_LEVELS = [
  { id: "noob",        label: "NOOB",        icon: Smile,       bg: "#f3f4f6", text: "#6b7280", border: "#d1d5db" },
  { id: "warmup",      label: "WARMUP",       icon: Flame,       bg: "#fefce8", text: "#ca8a04", border: "#fde68a" },
  { id: "snail",       label: "SNAIL",        icon: Timer,       bg: "#f0fdf4", text: "#16a34a", border: "#bbf7d0" },
  { id: "slug",        label: "SLUG",         icon: Minus,       bg: "#f8fafc", text: "#64748b", border: "#e2e8f0" },
  { id: "slow",        label: "SLOW",         icon: Clock,       bg: "#fafaf9", text: "#78716c", border: "#e7e5e4" },
  { id: "sloth",       label: "SLOTH",        icon: Moon,        bg: "#fffbeb", text: "#d97706", border: "#fde68a" },
  { id: "tortoise",    label: "TORTOISE",     icon: Shield,      bg: "#f7fee7", text: "#65a30d", border: "#d9f99d" },
  { id: "turtle",      label: "TURTLE",       icon: ShieldCheck, bg: "#f0fdfa", text: "#0d9488", border: "#99f6e4" },
  { id: "reptile",     label: "REPTILE",      icon: Eye,         bg: "#ecfdf5", text: "#059669", border: "#a7f3d0" },
  { id: "moderate",    label: "MODERATE",     icon: Activity,    bg: "#eff6ff", text: "#3b82f6", border: "#bfdbfe" },
  { id: "high",        label: "HIGH",         icon: TrendingUp,  bg: "#f0f9ff", text: "#0ea5e9", border: "#bae6fd" },
  { id: "monster",     label: "MONSTER",      icon: Skull,       bg: "#fff7ed", text: "#ea580c", border: "#fed7aa" },
  { id: "class",       label: "CLASS",        icon: Star,        bg: "#fefce8", text: "#ca8a04", border: "#fde047" },
  { id: "super",       label: "SUPER",        icon: Rocket,      bg: "#faf5ff", text: "#9333ea", border: "#e9d5ff" },
  { id: "outstanding", label: "OUTSTANDING",  icon: Crown,       bg: "#fffbeb", text: "#f59e0b", border: "#fcd34d" },
  { id: "ridiculous",  label: "RIDICULOUS",   icon: Zap,         bg: "#fef2f2", text: "#dc2626", border: "#fecaca" },
  { id: "impossible",  label: "IMPOSSIBLE",   icon: Diamond,     bg: "#ecfeff", text: "#0891b2", border: "#a5f3fc" },
  { id: "overpowered", label: "OVERPOWERED",  icon: Swords,      bg: "#f5f3ff", text: "#7c3aed", border: "#ddd6fe" },
  { id: "god_level",   label: "GOD LEVEL",    icon: Sparkles,    bg: "#fffbeb", text: "#f59e0b", border: "#fbbf24" },
] as const;

export type TrustLevelId = typeof TRUST_LEVELS[number]["id"];

const lsKey = (profileId: number) => `trustscore_${profileId}`;

export function getTrustScore(profileId: number): TrustLevelId | null {
  return (localStorage.getItem(lsKey(profileId)) as TrustLevelId | null) ?? null;
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

  return (
    <div ref={ref} className="relative inline-block shrink-0" onMouseDown={e => e.stopPropagation()}>
      <button
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        style={{
          width: 250,
          height: 25,
          background: current?.bg ?? "#f9fafb",
          border: `1px solid ${current?.border ?? "#e5e7eb"}`,
          color: current?.text ?? "#9ca3af",
          borderRadius: 4,
          display: "flex",
          alignItems: "center",
          gap: 6,
          paddingLeft: 8,
          paddingRight: 8,
          cursor: "pointer",
          flexShrink: 0,
        }}
        title="Click to set Trust Score"
      >
        {current ? (
          <>
            <current.icon size={12} color={current.text} strokeWidth={2} />
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.07em", flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: current.text }}>
              {current.label}
            </span>
          </>
        ) : (
          <span style={{ fontSize: 9, fontWeight: 600, color: "#9ca3af", flex: 1, textAlign: "center", letterSpacing: "0.05em" }}>— SET TRUST SCORE —</span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: "fixed",
            zIndex: 99999,
            background: "var(--background, white)",
            border: "1px solid var(--border, #e5e7eb)",
            borderRadius: 8,
            boxShadow: "0 8px 32px rgba(0,0,0,0.14)",
            width: 260,
            padding: "4px 0",
            maxHeight: 360,
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
                  background: isActive ? lvl.bg : "transparent",
                  border: "none",
                  borderLeft: isActive ? `3px solid ${lvl.border}` : "3px solid transparent",
                  cursor: "pointer",
                  textAlign: "left",
                  outline: "none",
                }}
              >
                <Icon size={13} color={lvl.text} strokeWidth={2} />
                <span style={{ fontSize: 11, fontWeight: 600, color: lvl.text, letterSpacing: "0.05em" }}>{lvl.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
