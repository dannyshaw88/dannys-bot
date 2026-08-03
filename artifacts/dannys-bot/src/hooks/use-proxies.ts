import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, buildUrl, type InsertProxy } from "@shared/routes";

export function useUpdateProxy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<InsertProxy> }) => {
      const url = buildUrl(api.proxies.update.path, { id });
      const res = await fetch(url, {
        method: api.proxies.update.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to update proxy");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.proxies.list.path] });
    },
  });
}

export function useProxies() {
  return useQuery({
    queryKey: [api.proxies.list.path],
    queryFn: async () => {
      const res = await fetch(api.proxies.list.path, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch proxies");
      return api.proxies.list.responses[200].parse(await res.json());
    },
  });
}

export function useCreateProxy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: InsertProxy) => {
      const res = await fetch(api.proxies.create.path, {
        method: api.proxies.create.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });
      if (!res.ok) {
        if (res.status === 400) {
          const error = api.proxies.create.responses[400].parse(await res.json());
          throw new Error(error.message);
        }
        throw new Error("Failed to create proxy");
      }
      return api.proxies.create.responses[201].parse(await res.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.proxies.list.path] });
    },
  });
}

export function useDeleteProxy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const url = buildUrl(api.proxies.delete.path, { id });
      const res = await fetch(url, { method: api.proxies.delete.method, credentials: "include" });
      if (!res.ok) throw new Error("Failed to delete proxy");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.proxies.list.path] });
    },
  });
}
