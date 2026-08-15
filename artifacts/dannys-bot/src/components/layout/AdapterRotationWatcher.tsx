/**
 * AdapterRotationWatcher
 *
 * Mounts once inside AppLayout (every page). Polls the proxy list every 3 s
 * globally so the Sidebar's Proxy Manager icon can show a spinner when any
 * adapter is rotating — no matter which page the user is on.
 *
 * Uses the same query key as useProxies() so the cache is shared — no extra
 * network requests when the Proxies page is also open.
 *
 * Renders nothing itself. Visual indication is handled by Sidebar.tsx reading
 * the same cached query.
 */
import { useQuery } from "@tanstack/react-query";

export function AdapterRotationWatcher() {
  useQuery({
    queryKey: ["/api/proxies"],
    queryFn: async () => {
      const res = await fetch("/api/proxies", { credentials: "include" });
      if (!res.ok) throw new Error("proxy list fetch failed");
      return res.json();
    },
    refetchInterval: 3000,
    refetchIntervalInBackground: false,
    staleTime: 2000,
  });

  return null;
}
