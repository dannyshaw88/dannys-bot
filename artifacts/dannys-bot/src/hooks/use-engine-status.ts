import { useQuery } from "@tanstack/react-query";

interface EngineStatusEntry {
  profileId: number;
  loggedIn: boolean;
  dailyCount: number;
  hourlyCount: number;
  nextHumanSessionAt: number;
}

export function useEngineStatus() {
  return useQuery<EngineStatusEntry[]>({
    queryKey: ["/api/engine/status"],
    queryFn: async () => {
      const res = await fetch("/api/engine/status", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch engine status");
      return res.json();
    },
    refetchInterval: 10000,
  });
}

export function useProfileEngineStatus(profileId: number) {
  const { data } = useEngineStatus();
  return data?.find(e => e.profileId === profileId);
}
