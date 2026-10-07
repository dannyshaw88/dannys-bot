import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Link2, Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";

type ImportReelResult = {
  url: string;
  totalSlots: number;
  addedSlots: number;
  alreadyPresentSlots: number;
};

async function importReelToAllSlots(value: string): Promise<ImportReelResult> {
  const response = await fetch("/api/mobile/share-reel/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ url: value }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok !== true) {
    throw new Error(data?.error ?? "Could not import this Reel.");
  }
  return data as ImportReelResult;
}

export function ImportReelTabContent() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<ImportReelResult | null>(null);

  const mutation = useMutation({
    mutationFn: importReelToAllSlots,
    onSuccess: async (data) => {
      setUrl("");
      setResult(data);
      toast({
        title: "Reel imported",
        description: `Added to ${data.addedSlots} account slot${data.addedSlots === 1 ? "" : "s"}; already present in ${data.alreadyPresentSlots} slot${data.alreadyPresentSlots === 1 ? "" : "s"}. Processed history was preserved.`,
      });
      await queryClient.invalidateQueries({
        predicate: query =>
          query.queryKey.some(
            key => typeof key === "string" &&
              key.includes("/slots/") &&
              key.includes("/automation-settings"),
          ),
      });
    },
    onError: (error: unknown) => {
      toast({
        title: "Reel import failed",
        description: error instanceof Error ? error.message : "Could not import this Reel.",
        variant: "destructive",
      });
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = url.trim();
    if (!value || mutation.isPending) return;
    setResult(null);
    mutation.mutate(value);
  };

  return (
    <div className="desktop-card p-6 space-y-5">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-primary/10 p-2 text-primary">
          <Link2 className="h-4 w-4" aria-hidden="true" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Import Reel</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Add one Instagram Reel URL to the Repost sources for every saved account slot.
          </p>
        </div>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row">
        <div className="min-w-0 flex-1">
          <label className="sr-only" htmlFor="import-reel-url">Instagram Reel URL</label>
          <Input
            id="import-reel-url"
            type="text"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            value={url}
            onChange={event => setUrl(event.target.value)}
            placeholder="https://www.instagram.com/reel/…"
            aria-describedby="import-reel-help"
            disabled={mutation.isPending}
          />
        </div>
        <Button type="submit" disabled={!url.trim() || mutation.isPending}>
          {mutation.isPending ? (
            <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Adding…</>
          ) : (
            "Add to all account slots"
          )}
        </Button>
      </form>

      <p id="import-reel-help" className="text-xs leading-relaxed text-muted-foreground">
        Existing Repost sources stay in place. Each account keeps its own processed-Reel history, so a link already visited by one account remains completed only for that account.
      </p>

      {result && (
        <div role="status" className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-medium">
              Added to {result.addedSlots} of {result.totalSlots} account slots.
            </p>
            {result.alreadyPresentSlots > 0 && (
              <p className="mt-1 text-muted-foreground">
                Already present in {result.alreadyPresentSlots} slot{result.alreadyPresentSlots === 1 ? "" : "s"}.
              </p>
            )}
            <p className="mt-1 break-all text-xs text-muted-foreground">{result.url}</p>
          </div>
        </div>
      )}
    </div>
  );
}
