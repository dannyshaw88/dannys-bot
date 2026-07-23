import { useParams, useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useProfile, useProfiles } from "@/hooks/use-profiles";
import { useTools } from "@/hooks/use-tools";
import { ToolConfigPanel } from "@/components/tools/ToolConfigPanel";
import { UnfollowToolPanel } from "@/components/tools/UnfollowToolPanel";
import { ContactToolPanel } from "@/components/tools/ContactToolPanel";
import { HumanSessionPanel } from "@/components/tools/HumanSessionPanel";
import * as Tabs from "@radix-ui/react-tabs";
import { getTrustLevels } from "@/components/TrustScoreBadge";
import { Loader2, ChevronLeft } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";

interface TrustScoreTemplate {
  trustScoreId: string;
  profileId: number | null;
}

export function TrustScoreDetailPage() {
  const { trustScoreId } = useParams<{ trustScoreId: string }>();
  const search = useSearch();
  const [, navigate] = useLocation();
  const requestedTab = new URLSearchParams(search).get("tab");
  const activeTab = requestedTab === "settings" || !requestedTab ? "human-session" : requestedTab;

  const level = getTrustLevels().find(l => l.id === trustScoreId);

  const { data: templates, isLoading: templatesLoading } = useQuery<TrustScoreTemplate[]>({
    queryKey: ["/api/trust-score-templates"],
    queryFn: async () => {
      const res = await fetch("/api/trust-score-templates", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch trust score templates");
      return res.json();
    },
  });

  const profileId = templates?.find(t => t.trustScoreId === trustScoreId)?.profileId ?? 0;

  const { data: profile } = useProfile(profileId || 0);
  const { data: tools } = useTools(profileId || 0);
  const { data: allProfiles = [] } = useProfiles();
  const otherTrustProfiles = templates
    ? allProfiles.filter(p => templates.some(t => t.profileId === p.id && t.trustScoreId !== trustScoreId))
    : [];

  const getTool = (type: string) => tools?.find(t => t.type === type);

  if (templatesLoading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-48">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      </AppLayout>
    );
  }

  if (!level || !profileId) {
    return (
      <AppLayout>
        <div className="p-6 text-muted-foreground">Trust score tier not found.</div>
      </AppLayout>
    );
  }

  const Icon = level.icon;

  return (
    <AppLayout>
    <Tabs.Root
      value={activeTab}
      onValueChange={tab => navigate(`/trust-scores/${trustScoreId}?tab=${tab}`)}
    >
      {/* Sticky header */}
      <div className="sticky top-0 z-20 bg-background border-b border-border">
        <div className="flex items-center gap-3 px-4 pt-3 pb-0">
          <button
            onClick={() => navigate("/trust-scores")}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronLeft className="w-3.5 h-3.5" /> TrustScores
          </button>
          <div
            className="flex items-center gap-1.5 rounded-full px-3 py-1"
            style={{ background: level.bg, border: `1px solid ${level.border}` }}
          >
            <Icon size={12} color={level.text} fill={level.text} strokeWidth={2} />
            <span style={{ fontSize: 11, fontWeight: 700, color: level.text, letterSpacing: "0.05em" }}>
              {level.label}
            </span>
          </div>
        </div>

        <Tabs.List className="flex px-4 mt-2 gap-0">
          {[
            { value: "follow",        label: "Follow Tool"    },
            { value: "unfollow",      label: "Unfollow Tool"  },
            { value: "contact",       label: "Contact Tool"   },
            { value: "human-session", label: "Human Session"  },
          ].map(tab => (
            <Tabs.Trigger
              key={tab.value}
              value={tab.value}
              className="px-3 py-2 text-[11px] font-semibold text-muted-foreground border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-foreground transition-colors hover:text-foreground outline-none whitespace-nowrap"
            >
              {tab.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      </div>

      {/* Follow Tool */}
      <Tabs.Content value="follow" className="outline-none animate-in fade-in duration-300">
        {profile && getTool("follow")
          ? <ToolConfigPanel tool={getTool("follow")!} profile={profile} overrideProfiles={otherTrustProfiles} />
          : <div className="flex items-center gap-2 text-muted-foreground p-6"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
        }
      </Tabs.Content>

      {/* Unfollow Tool */}
      <Tabs.Content value="unfollow" className="outline-none animate-in fade-in duration-300">
        {profile && getTool("unfollow")
          ? <UnfollowToolPanel tool={getTool("unfollow")!} profile={profile} overrideProfiles={otherTrustProfiles} />
          : <div className="flex items-center gap-2 text-muted-foreground p-6"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
        }
      </Tabs.Content>

      {/* Contact Tool */}
      <Tabs.Content value="contact" className="outline-none animate-in fade-in duration-300">
        {profile && getTool("contact")
          ? <ContactToolPanel tool={getTool("contact")!} profile={profile} overrideProfiles={otherTrustProfiles} />
          : <div className="flex items-center gap-2 text-muted-foreground p-6"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
        }
      </Tabs.Content>

      {/* Human Session */}
      <Tabs.Content value="human-session" className="outline-none animate-in fade-in duration-300">
        {profile && getTool("human_sessions")
          ? <HumanSessionPanel tool={getTool("human_sessions")!} profile={profile} overrideProfiles={otherTrustProfiles} />
          : <div className="flex items-center gap-2 text-muted-foreground p-6"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
        }
      </Tabs.Content>
    </Tabs.Root>
    </AppLayout>
  );
}
