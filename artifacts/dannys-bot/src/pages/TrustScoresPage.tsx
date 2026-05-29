import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { TRUST_LEVELS } from "@/components/TrustScoreBadge";
import { Loader2, ChevronRight } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";

interface TrustScoreTemplate {
  trustScoreId: string;
  profileId: number | null;
}

export function TrustScoresPage() {
  const [, setLocation] = useLocation();

  const { data: templates, isLoading } = useQuery<TrustScoreTemplate[]>({
    queryKey: ["/api/trust-score-templates"],
    queryFn: async () => {
      const res = await fetch("/api/trust-score-templates", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch trust score templates");
      return res.json();
    },
  });

  return (
    <AppLayout>
    <div className="p-6 space-y-4 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">TrustScores</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure API limits and tool defaults for each trust score tier.
        </p>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground py-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading tiers…
        </div>
      )}

      {!isLoading && (
        <div className="space-y-1">
          {TRUST_LEVELS.map((level, idx) => {
            const Icon = level.icon;
            return (
              <button
                key={level.id}
                onClick={() => setLocation(`/trust-scores/${level.id}`)}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-accent transition-colors border border-transparent hover:border-border text-left group"
              >
                <span className="w-7 text-[11px] font-bold text-muted-foreground shrink-0 text-right">
                  {idx + 1}
                </span>
                <div className="w-36 flex justify-center shrink-0">
                  <div
                    className="flex items-center gap-1.5 rounded-full px-3 py-1"
                    style={{ background: "#1AD2F2" }}
                  >
                    <Icon size={12} color="#ffffff" fill="#ffffff" strokeWidth={2} />
                    <span style={{ fontSize: 11, fontWeight: 700, color: "#ffffff", letterSpacing: "0.05em" }}>
                      {level.label}
                    </span>
                  </div>
                </div>
                <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors flex-1">
                  API limits, tool settings
                </span>
                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
              </button>
            );
          })}
        </div>
      )}
    </div>
    </AppLayout>
  );
}
