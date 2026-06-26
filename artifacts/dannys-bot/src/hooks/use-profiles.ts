import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, buildUrl, type InsertProfile } from "@shared/routes";

export function useProfiles() {
  return useQuery({
    queryKey: [api.profiles.list.path, "automation"],
    queryFn: async () => {
      const res = await fetch(api.profiles.list.path + "?creatorMode=0", { credentials: "include" });
      if (!res.ok) {
        console.error("[DEBUG useProfiles] fetch failed:", res.status, res.statusText);
        throw new Error("Failed to fetch profiles");
      }
      let raw: unknown;
      try { raw = await res.json(); } catch (e) {
        console.error("[DEBUG useProfiles] JSON parse error:", e);
        throw e;
      }
      console.log("[DEBUG useProfiles] raw response type:", Array.isArray(raw) ? "array" : typeof raw, "length:", Array.isArray(raw) ? (raw as any[]).length : "N/A");
      if (Array.isArray(raw) && (raw as any[]).length > 0) {
        const s = (raw as any[])[0];
        console.log("[DEBUG useProfiles] sample[0] isTemplate:", s.isTemplate, "creatorMode:", s.creatorMode, "accountStatus:", s.accountStatus, "id:", s.id);
      }
      let parsed: any;
      try { parsed = api.profiles.list.responses[200].parse(raw); } catch (e) {
        console.error("[DEBUG useProfiles] Zod parse error:", e);
        throw e;
      }
      console.log("[DEBUG useProfiles] parsed length:", Array.isArray(parsed) ? parsed.length : "N/A");
      return parsed;
    },
    refetchInterval: 5000,
  });
}

export function useCreatorProfiles() {
  return useQuery({
    queryKey: [api.profiles.list.path, "creator"],
    queryFn: async () => {
      const res = await fetch(api.profiles.list.path + "?creatorMode=1", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch creator profiles");
      return api.profiles.list.responses[200].parse(await res.json());
    },
    refetchInterval: 5000,
  });
}

export function useProfile(id: number) {
  return useQuery({
    queryKey: [api.profiles.get.path, id],
    queryFn: async () => {
      if (!id) return null;
      const url = buildUrl(api.profiles.get.path, { id });
      const res = await fetch(url, { credentials: "include" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to fetch profile");
      return api.profiles.get.responses[200].parse(await res.json());
    },
    enabled: !!id,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
}

export function useCreateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: InsertProfile) => {
      const res = await fetch(api.profiles.create.path, {
        method: api.profiles.create.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to create profile");
      return api.profiles.create.responses[201].parse(await res.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.profiles.list.path] });
    },
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...data }: Partial<InsertProfile> & { id: number }) => {
      const url = buildUrl(api.profiles.update.path, { id });
      const res = await fetch(url, {
        method: api.profiles.update.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to update profile");
      return api.profiles.update.responses[200].parse(await res.json());
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [api.profiles.list.path] });
      queryClient.invalidateQueries({ queryKey: [api.profiles.get.path, data.id] });
    },
  });
}

export function useDeleteProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const url = buildUrl(api.profiles.delete.path, { id });
      const res = await fetch(url, { method: api.profiles.delete.method, credentials: "include" });
      if (!res.ok) throw new Error("Failed to delete profile");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.profiles.list.path] });
    },
  });
}

export function useUpdateAccountStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, accountStatus }: { id: number; accountStatus: string }) => {
      const res = await fetch(`/api/profiles/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountStatus }),
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to update account status");
      return res.json();
    },
    onMutate: async ({ id, accountStatus }) => {
      await queryClient.cancelQueries({ queryKey: [api.profiles.list.path] });
      const prevAutomation = queryClient.getQueryData([api.profiles.list.path, "automation"]);
      const prevCreator    = queryClient.getQueryData([api.profiles.list.path, "creator"]);
      const prevItem       = queryClient.getQueryData([api.profiles.get.path, id]);
      const patchList = (old: any) =>
        Array.isArray(old) ? old.map((p: any) => p.id === id ? { ...p, accountStatus } : p) : old;
      queryClient.setQueryData([api.profiles.list.path, "automation"], patchList);
      queryClient.setQueryData([api.profiles.list.path, "creator"],    patchList);
      queryClient.setQueryData([api.profiles.get.path, id], (old: any) =>
        old ? { ...old, accountStatus } : old
      );
      return { prevAutomation, prevCreator, prevItem };
    },
    onError: (_err, { id }, context: any) => {
      if (context?.prevAutomation) queryClient.setQueryData([api.profiles.list.path, "automation"], context.prevAutomation);
      if (context?.prevCreator)    queryClient.setQueryData([api.profiles.list.path, "creator"],    context.prevCreator);
      if (context?.prevItem)       queryClient.setQueryData([api.profiles.get.path, id],             context.prevItem);
    },
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: [api.profiles.list.path] });
      queryClient.invalidateQueries({ queryKey: [api.profiles.get.path, id] });
    },
  });
}

export function useMoveToAccounts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/profiles/${id}/move-to-accounts`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to move profile to accounts");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.profiles.list.path, "automation"] });
      queryClient.invalidateQueries({ queryKey: [api.profiles.list.path, "creator"] });
    },
  });
}

export function useVerifyProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/profiles/${id}/verify`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      return data as { ok: boolean; message: string; accountStatus?: string };
    },
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: [api.profiles.list.path] });
      queryClient.invalidateQueries({ queryKey: [api.profiles.get.path, id] });
    },
  });
}

export function useStartProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const url = buildUrl(api.profiles.start.path, { id });
      const res = await fetch(url, { method: api.profiles.start.method, credentials: "include" });
      if (!res.ok) throw new Error("Failed to start profile");
    },
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: [api.profiles.list.path] });
      queryClient.invalidateQueries({ queryKey: [api.profiles.get.path, id] });
    },
  });
}

export function useStopProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const url = buildUrl(api.profiles.stop.path, { id });
      const res = await fetch(url, { method: api.profiles.stop.method, credentials: "include" });
      if (!res.ok) throw new Error("Failed to stop profile");
    },
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: [api.profiles.list.path] });
      queryClient.invalidateQueries({ queryKey: [api.profiles.get.path, id] });
    },
  });
}

export function useStatusEvents() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const es = new EventSource("/api/events/status");
    es.onmessage = (e) => {
      try {
        const { profileId } = JSON.parse(e.data) as { profileId: number; accountStatus: string };
        queryClient.invalidateQueries({ queryKey: [api.profiles.list.path] });
        if (profileId) {
          queryClient.invalidateQueries({ queryKey: [api.profiles.get.path, profileId] });
        }
      } catch {}
    };
    return () => es.close();
  }, [queryClient]);
}
