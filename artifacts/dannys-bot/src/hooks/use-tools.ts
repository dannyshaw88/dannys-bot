import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, buildUrl, type InsertTool } from "@shared/routes";

export function useTools(profileId: number) {
  return useQuery({
    queryKey: [api.tools.listByProfile.path, profileId],
    queryFn: async () => {
      if (!profileId) return [];
      const url = buildUrl(api.tools.listByProfile.path, { profileId });
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch tools");
      return api.tools.listByProfile.responses[200].parse(await res.json());
    },
    enabled: !!profileId,
  });
}

export function useUpdateTool() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, profileId, ...data }: Partial<InsertTool> & { id: number, profileId: number }) => {
      const url = buildUrl(api.tools.update.path, { id });
      const res = await fetch(url, {
        method: api.tools.update.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to update tool");
      return api.tools.update.responses[200].parse(await res.json());
    },
    onSuccess: (_, variables) => {
      // Invalidate tools list for this specific profile
      queryClient.invalidateQueries({ queryKey: [api.tools.listByProfile.path, variables.profileId] });
    },
  });
}
