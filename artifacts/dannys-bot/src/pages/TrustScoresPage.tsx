import { useLocation } from "wouter";
import { TRUST_LEVELS } from "@/components/TrustScoreBadge";
import { AppLayout } from "@/components/layout/AppLayout";
import { ChevronRight } from "lucide-react";

const LEFT  = TRUST_LEVELS.slice(0, 10);
const RIGHT = TRUST_LEVELS.slice(10);

function TierButton({ level, idx, globalIdx, onClick }: {
  level: typeof TRUST_LEVELS[number];
  idx: number;
  globalIdx: number;
  onClick: () => void;
}) {
  const Icon = level.icon;
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-accent transition-colors border border-transparent hover:border-border text-left group"
    >
      <span className="w-6 text-[11px] font-bold text-muted-foreground shrink-0 text-right">
        {globalIdx + 1}
      </span>
      <div
        className="flex items-center gap-1.5 rounded-full px-3 py-1 shrink-0"
        style={{ background: "#1AD2F2" }}
      >
        <Icon size={12} color="#ffffff" fill="#ffffff" strokeWidth={2} />
        <span style={{ fontSize: 11, fontWeight: 700, color: "#ffffff", letterSpacing: "0.05em" }}>
          {level.label}
        </span>
      </div>
      <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
    </button>
  );
}

export function TrustScoresPage() {
  const [, setLocation] = useLocation();

  return (
    <AppLayout>
      <div className="p-6 space-y-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">TrustScores</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configure API limits and tool defaults for each trust score tier.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-x-6 max-w-2xl">
          {/* Left column — tiers 1–10 */}
          <div className="space-y-0.5">
            {LEFT.map((level, idx) => (
              <TierButton
                key={level.id}
                level={level}
                idx={idx}
                globalIdx={idx}
                onClick={() => setLocation(`/trust-scores/${level.id}`)}
              />
            ))}
          </div>

          {/* Right column — tiers 11–19 */}
          <div className="space-y-0.5">
            {RIGHT.map((level, idx) => (
              <TierButton
                key={level.id}
                level={level}
                idx={idx}
                globalIdx={10 + idx}
                onClick={() => setLocation(`/trust-scores/${level.id}`)}
              />
            ))}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
