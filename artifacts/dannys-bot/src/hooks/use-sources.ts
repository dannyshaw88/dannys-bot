import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, buildUrl, type InsertSource } from "@shared/routes";

export function useSources(toolId: number) {
  return useQuery({
    queryKey: [api.sources.listByTool.path, toolId],
    queryFn: async () => {
      if (!toolId) return [];
      const url = buildUrl(api.sources.listByTool.path, { toolId });
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch sources");
      return api.sources.listByTool.responses[200].parse(await res.json());
    },
    enabled: !!toolId,
  });
}

export function useCreateSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ toolId, ...data }: Omit<InsertSource, 'toolId'> & { toolId: number }) => {
      const url = buildUrl(api.sources.create.path, { toolId });
      const res = await fetch(url, {
        method: api.sources.create.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to create source");
      return api.sources.create.responses[201].parse(await res.json());
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: [api.sources.listByTool.path, variables.toolId] });
    },
  });
}

export function useDeleteSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, toolId }: { id: number, toolId: number }) => {
      const url = buildUrl(api.sources.delete.path, { id });
      const res = await fetch(url, { method: api.sources.delete.method, credentials: "include" });
      if (!res.ok) throw new Error("Failed to delete source");
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: [api.sources.listByTool.path, variables.toolId] });
    },
  });
}

export function useUpdateSource() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, toolId, ...data }: { id: number; toolId: number; rank?: number | null; enabled?: boolean }) => {
      const res = await fetch(`/api/sources/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to update source');
      return res.json();
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: [api.sources.listByTool.path, variables.toolId] });
    },
  });
}

export function useImportSources() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ toolId, rows }: {
      toolId: number;
      rows: { type: string; value: string; rank?: number | null; nrPosts?: number | null }[];
    }) => {
      const res = await fetch(`/api/tools/${toolId}/sources/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rows),
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Import failed');
      return res.json();
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: [api.sources.listByTool.path, variables.toolId] });
    },
  });
}

export function useClearSources() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (toolId: number) => {
      const res = await fetch(`/api/tools/${toolId}/sources`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to clear sources');
    },
    onSuccess: (_, toolId) => {
      queryClient.invalidateQueries({ queryKey: [api.sources.listByTool.path, toolId] });
    },
  });
}

export function useClearSourcesByType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ toolId, type }: { toolId: number; type: string }) => {
      const res = await fetch(`/api/tools/${toolId}/sources/type/${encodeURIComponent(type)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to clear sources by type');
    },
    onSuccess: (_, { toolId }) => {
      queryClient.invalidateQueries({ queryKey: [api.sources.listByTool.path, toolId] });
    },
  });
}

/**
 * Parse a hashtag source file for import. Handles:
 *   - Jarvee 3-col TSV (UTF-16LE with BOM): Keyword \t NrPosts \t Rank
 *   - Simple 2-col TSV: Hashtag \t Rank  (latin-1 / windows-1252 or UTF-8)
 *   - Plain list: one hashtag per line, no rank column
 * Encoding: tries the detected encoding first; if decoding fails (e.g. a
 * latin-1 file passed as UTF-8) falls back to windows-1252 automatically.
 */
export async function parseJarveeHashtagFile(file: File): Promise<{ value: string; nrPosts: number | null; rank: number | null }[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const buf = reader.result as ArrayBuffer;
        const bytes = new Uint8Array(buf);
        // Detect BOM
        let encoding = 'utf-8';
        let offset = 0;
        if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; offset = 2; }
        else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; offset = 2; }

        // Decode — fall back to windows-1252 if the primary encoding fails
        let text: string;
        try {
          text = new TextDecoder(encoding, { fatal: true }).decode(buf.slice(offset));
        } catch {
          text = new TextDecoder('windows-1252').decode(buf.slice(offset));
        }

        const lines = text.split(/\r?\n/).filter(l => l.trim());
        // Skip header row
        const rows = lines.slice(1).map(line => {
          const parts = line.split('\t');
          const value = (parts[0] ?? '').trim().replace(/^#/, '');
          if (!value) return null;
          if (parts.length >= 3) {
            // Jarvee 3-col: value, nrPosts, rank
            const nrPosts = parts[1] ? parseInt(parts[1].trim(), 10) : null;
            const rank    = parts[2] ? parseInt(parts[2].trim(), 10) : null;
            return { value, nrPosts: isNaN(nrPosts as any) ? null : nrPosts, rank: isNaN(rank as any) ? null : rank };
          } else if (parts.length === 2) {
            // Simple 2-col: value, rank
            const rank = parts[1] ? parseInt(parts[1].trim(), 10) : null;
            return { value, nrPosts: null, rank: isNaN(rank as any) ? null : rank };
          } else {
            // Plain list — no rank
            return { value, nrPosts: null, rank: null };
          }
        }).filter((r): r is NonNullable<typeof r> => r !== null && r.value !== '');
        resolve(rows);
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}
