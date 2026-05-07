import { useEffect } from "react";
import { useParams } from "wouter";
import { useProfile } from "@/hooks/use-profiles";
import { BrowserPanel } from "@/components/BrowserPanel";

export function StandaloneBrowserPage() {
  const params = useParams<{ id: string }>();
  const profileId = Number(params.id);
  const { data: profile, isLoading } = useProfile(profileId);

  useEffect(() => {
    if (profile?.username) {
      document.title = `@${profile.username}`;
    }
  }, [profile?.username]);

  if (isLoading) {
    return (
      <div className="w-full h-screen flex items-center justify-center bg-background text-muted-foreground text-sm">
        Loading…
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="w-full h-screen flex items-center justify-center bg-background text-destructive text-sm">
        Profile not found.
      </div>
    );
  }

  return (
    <div className="w-full h-screen bg-background overflow-hidden">
      <BrowserPanel
        profileId={profileId}
        username={profile.username ?? ""}
        userAgent={profile.userAgentEmbedded ?? ""}
      />
    </div>
  );
}
