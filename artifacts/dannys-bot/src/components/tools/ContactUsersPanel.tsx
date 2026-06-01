import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useUpdateTool } from "@/hooks/use-tools";
import { useProfileEngineStatus } from "@/hooks/use-engine-status";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Clock, Send, Timer, Shuffle, Undo2, Trash2, RefreshCw, Users, CheckCircle2, Zap,
} from "lucide-react";
import { format } from "date-fns";
import { type Tool, type Profile, type ContactPendingMessage } from "@shared/schema";

interface Props {
  tool: Tool;
  profile: Profile;
  embedded?: boolean;
}

const TYPE_LABELS: Record<string, string> = {
  new_follower: "New Follower",
  auto_reply: "Auto Reply",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "text-amber-600 bg-amber-50 border-amber-200",
  sent: "text-green-600 bg-green-50 border-green-200",
  failed: "text-red-600 bg-red-50 border-red-200",
  unsent: "text-gray-500 bg-gray-50 border-gray-200",
};

export function ContactUsersPanel({ tool, profile, embedded }: Props) {
  const updateToolMutation = useUpdateTool();
  const queryClient = useQueryClient();
  const engineStatus = useProfileEngineStatus(tool.profileId);

  const { data: allMessages, isLoading } = useQuery<ContactPendingMessage[]>({
    queryKey: [`/api/profiles/${profile.id}/contact-pending-messages`],
    refetchInterval: 10000,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/contact-pending-messages/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [`/api/profiles/${profile.id}/contact-pending-messages`] }),
  });

  const sendNowMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/profiles/${profile.id}/tools/contact/send-now`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to trigger send");
    },
    onSuccess: () => {
      setTimeout(() => queryClient.invalidateQueries({ queryKey: [`/api/profiles/${profile.id}/contact-pending-messages`] }), 3000);
    },
  });

  const clearPendingMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/profiles/${profile.id}/contact-pending-messages/clear`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to clear pending messages");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [`/api/profiles/${profile.id}/contact-pending-messages`] }),
  });

  const clearAllPendingMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/contact-pending-messages/clear-all`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to clear all pending messages");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [`/api/profiles/${profile.id}/contact-pending-messages`] }),
  });

  const pending = [...(allMessages?.filter(m => m.status === "pending") ?? [])]
    .sort((a, b) => new Date(b.queuedAt).getTime() - new Date(a.queuedAt).getTime());
  const sent = [...(allMessages?.filter(m => m.status !== "pending") ?? [])]
    .sort((a, b) => new Date(b.sentAt ?? b.queuedAt).getTime() - new Date(a.sentAt ?? a.queuedAt).getTime());

  const [settings, setSettings] = useState(() => {
    const def: Record<string, any> = {
      contactUsersEnabled: true,
      contactUsersWaitMin: 30,
      contactUsersWaitMax: 60,
      contactUsersSendCountMin: 1,
      contactUsersSendCountMax: 5,
      contactUsersDelayBetweenMin: 5,
      contactUsersDelayBetweenMax: 15,
      contactUsersPickRandom: false,
      contactUsersUnsendEnabled: false,
      contactUsersUnsendMin: 30,
      contactUsersUnsendMax: 60,
      stopOnBlockEnabled: false,
      stopOnBlockMinutes: 60,
    };
    return { ...def, ...(tool.settings as object || {}) };
  });

  const isMounted = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isMounted.current) { isMounted.current = true; return; }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      updateToolMutation.mutate({ id: tool.id, profileId: tool.profileId, settings });
    }, 600);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [settings]);

  const numInput = (key: string, min: number, max: number, width = "w-14") => (
    <Input
      type="number"
      min={min}
      max={max}
      className={`${width} h-7 text-xs`}
      value={settings[key] ?? min}
      onChange={(e) => setSettings({ ...settings, [key]: Math.max(min, Math.min(max, Number(e.target.value))) })}
    />
  );

  const checkRow = (id: string, key: string, label: string, description?: string) => (
    <div className="flex items-start gap-3">
      <input
        type="checkbox"
        id={id}
        checked={!!settings[key]}
        onChange={(e) => setSettings({ ...settings, [key]: e.target.checked })}
        className="w-3.5 h-3.5 mt-0.5 accent-primary cursor-pointer shrink-0"
      />
      <div>
        <label htmlFor={id} className="text-sm font-medium cursor-pointer select-none">{label}</label>
        {description && <p className="text-[11px] text-muted-foreground mt-0.5">{description}</p>}
      </div>
    </div>
  );

  return (
    <div className="space-y-4 animate-in fade-in duration-300">

      {/* Master Enable */}
      <div className="flex items-center gap-3 px-1">
        <input
          type="checkbox"
          id="contactUsersEnabled"
          checked={!!settings.contactUsersEnabled}
          onChange={(e) => setSettings({ ...settings, contactUsersEnabled: e.target.checked })}
          className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
        />
        <div>
          <label htmlFor="contactUsersEnabled" className="text-sm font-semibold cursor-pointer select-none">Contact Users Sending</label>
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[11px] text-muted-foreground">Automatically send DMs from the Pending Messages queue.</p>
            {!embedded && (() => {
              if (!settings.contactUsersEnabled) return null;
              const nextAt = engineStatus?.nextContactAt ?? 0;
              if (!nextAt) return null;
              const executing = nextAt <= Date.now();
              const label = executing ? null : format(new Date(nextAt), "d MMM, HH:mm:ss");
              return (
                <span className="flex items-center gap-1 text-[11px] font-bold" style={{ color: executing ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))" }}>
                  <Clock className="w-3 h-3 shrink-0" />
                  {executing
                    ? <span>Executing</span>
                    : <span>Scheduled for: <span className="text-foreground">{label}</span></span>}
                </span>
              );
            })()}
            {settings.contactUsersEnabled && (() => {
              const avgWait = ((settings.contactUsersWaitMin ?? 30) + (settings.contactUsersWaitMax ?? 60)) / 2;
              const avgSend = ((settings.contactUsersSendCountMin ?? 1) + (settings.contactUsersSendCountMax ?? 5)) / 2;
              const perHour = avgWait > 0 ? Math.round((avgSend / avgWait) * 60) : 0;
              const perDay = perHour * 24;
              return perHour > 0 ? (
                <span className="flex items-center gap-1 text-[11px] font-bold text-muted-foreground">
                  {perHour}/hr · {perDay}/day
                </span>
              ) : null;
            })()}
          </div>
        </div>
      </div>

      {/* ── Send Settings ────────────────────────────────────── */}
      <div className="border border-border rounded-xl p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Send className="w-4 h-4 text-blue-500" />
          <h4 className="font-semibold text-sm">Send Settings</h4>
        </div>

        {/* Wait between batches · Messages per batch · Delay between messages — all on one row */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Wait Between Batches (min)</span>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Min</Label>
              {numInput("contactUsersWaitMin", 1, 10000)}
            </div>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Max</Label>
              {numInput("contactUsersWaitMax", 1, 10000)}
            </div>
          </div>
          <div className="w-px self-stretch bg-border/50 hidden sm:block" />
          <div className="flex items-center gap-2">
            <Users className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Per Batch</span>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Min</Label>
              {numInput("contactUsersSendCountMin", 1, 500)}
            </div>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Max</Label>
              {numInput("contactUsersSendCountMax", 1, 500)}
            </div>
          </div>
          <div className="w-px self-stretch bg-border/50 hidden sm:block" />
          <div className="flex items-center gap-2">
            <Timer className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Delay Between (s)</span>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Min</Label>
              {numInput("contactUsersDelayBetweenMin", 1, 3600)}
            </div>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Max</Label>
              {numInput("contactUsersDelayBetweenMax", 1, 3600)}
            </div>
          </div>
        </div>

        {/* Pick random */}
        {checkRow(
          "contactUsersPickRandom",
          "contactUsersPickRandom",
          "Pick a random message rather than in order",
          "When enabled, messages are picked randomly from the pending queue instead of FIFO."
        )}

        {/* Unsend */}
        {checkRow(
          "contactUsersUnsendEnabled",
          "contactUsersUnsendEnabled",
          "Unsend message after a delay",
          undefined
        )}

        {settings.contactUsersUnsendEnabled && (
          <div className="flex items-center gap-2 flex-wrap pl-6">
            <Undo2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Unsend After (min)</span>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Min</Label>
              {numInput("contactUsersUnsendMin", 1, 10000)}
            </div>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">Max</Label>
              {numInput("contactUsersUnsendMax", 1, 10000)}
            </div>
          </div>
        )}

        {/* Stop on block */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-2 border-t border-border/50">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="contactStopOnBlockEnabled"
              checked={!!settings.stopOnBlockEnabled}
              onChange={(e) => setSettings({ ...settings, stopOnBlockEnabled: e.target.checked })}
              className="w-3.5 h-3.5 accent-primary cursor-pointer"
            />
            <label htmlFor="contactStopOnBlockEnabled" className="text-xs font-bold text-muted-foreground uppercase tracking-wider cursor-pointer select-none whitespace-nowrap">
              Stop tool if blocked for
            </label>
          </div>
          <div className={`flex items-center gap-1.5 transition-opacity ${!settings.stopOnBlockEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
            <Input
              type="number"
              min="1"
              max="1440"
              className="w-16 h-7 text-xs"
              value={settings.stopOnBlockMinutes ?? 60}
              onChange={(e) => setSettings({ ...settings, stopOnBlockMinutes: Math.max(1, Number(e.target.value)) })}
            />
            <span className="text-xs text-muted-foreground">minutes</span>
          </div>
        </div>
      </div>

      {/* ── Pending Messages ──────────────────────────────────── */}
      <div className="border border-border rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-amber-500" />
            <span className="text-sm font-semibold">Pending Messages</span>
            <span className="text-xs text-muted-foreground">({pending.length})</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs px-2.5"
              disabled={sendNowMutation.isPending || !pending.length}
              onClick={() => sendNowMutation.mutate()}
              title="Trigger an immediate send session now"
            >
              <Zap className="w-3 h-3" />
              {sendNowMutation.isPending ? "Sending…" : "Send Now"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs px-2.5 text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/30"
              disabled={clearPendingMutation.isPending || !pending.length}
              onClick={() => clearPendingMutation.mutate()}
              title="Clear all pending messages for this account"
            >
              <Trash2 className="w-3 h-3" />
              {clearPendingMutation.isPending ? "Clearing…" : "Clear Pending"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs px-2.5 text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/30"
              disabled={clearAllPendingMutation.isPending}
              onClick={() => clearAllPendingMutation.mutate()}
              title="Clear pending messages on ALL accounts"
            >
              <Users className="w-3 h-3" />
              {clearAllPendingMutation.isPending ? "Clearing…" : "Clear All Accounts"}
            </Button>
            <button
              onClick={() => queryClient.invalidateQueries({ queryKey: [`/api/profiles/${profile.id}/contact-pending-messages`] })}
              className="p-1.5 rounded-lg hover:bg-accent/50 transition-colors text-muted-foreground"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
        <div className="overflow-x-auto max-h-72">
          {isLoading ? (
            <p className="text-sm text-muted-foreground px-4 py-6 text-center">Loading…</p>
          ) : !pending.length ? (
            <p className="text-sm text-muted-foreground px-4 py-6 text-center">No pending messages.</p>
          ) : (
            <table className="w-full text-sm text-left">
              <thead className="text-xs uppercase bg-muted/30 text-muted-foreground font-bold border-b border-border/50 sticky top-0 z-10">
                <tr>
                  <th className="px-4 py-2 bg-muted/30">User</th>
                  <th className="px-4 py-2 bg-muted/30">Type</th>
                  <th className="px-4 py-2 bg-muted/30">Message Preview</th>
                  <th className="px-4 py-2 bg-muted/30 whitespace-nowrap">Queued At</th>
                  <th className="px-4 py-2 bg-muted/30"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {pending.map((msg) => (
                  <tr key={msg.id} className="hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-2 font-medium text-primary">
                      <a
                        href={`https://instagram.com/${msg.instagramUsername}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline"
                      >
                        @{msg.instagramUsername}
                      </a>
                    </td>
                    <td className="px-4 py-2">
                      <span className="text-xs border rounded px-1.5 py-0.5 text-muted-foreground">
                        {TYPE_LABELS[msg.messageType] ?? msg.messageType}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground text-xs max-w-xs truncate">{msg.messageText}</td>
                    <td className="px-4 py-2 text-muted-foreground text-xs whitespace-nowrap">
                      {format(new Date(msg.queuedAt), "MMM d, HH:mm")}
                    </td>
                    <td className="px-4 py-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => deleteMutation.mutate(msg.id)}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ── Sent Messages ────────────────────────────────────── */}
      <div className="border border-border rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-green-500" />
            <span className="text-sm font-semibold">Sent Messages</span>
            <span className="text-xs text-muted-foreground">({sent.length})</span>
          </div>
        </div>
        <div className="overflow-x-auto max-h-72">
          {isLoading ? (
            <p className="text-sm text-muted-foreground px-4 py-6 text-center">Loading…</p>
          ) : !sent.length ? (
            <p className="text-sm text-muted-foreground px-4 py-6 text-center">No messages sent yet.</p>
          ) : (
            <table className="w-full text-sm text-left">
              <thead className="text-xs uppercase bg-muted/30 text-muted-foreground font-bold border-b border-border/50 sticky top-0 z-10">
                <tr>
                  <th className="px-4 py-2 bg-muted/30">User</th>
                  <th className="px-4 py-2 bg-muted/30">Type</th>
                  <th className="px-4 py-2 bg-muted/30">Status</th>
                  <th className="px-4 py-2 bg-muted/30">Message Preview</th>
                  <th className="px-4 py-2 bg-muted/30 whitespace-nowrap">Sent At</th>
                  <th className="px-4 py-2 bg-muted/30"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {sent.map((msg) => (
                  <tr key={msg.id} className="hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-2 font-medium text-primary">
                      <a
                        href={`https://instagram.com/${msg.instagramUsername}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline"
                      >
                        @{msg.instagramUsername}
                      </a>
                    </td>
                    <td className="px-4 py-2">
                      <span className="text-xs border rounded px-1.5 py-0.5 text-muted-foreground">
                        {TYPE_LABELS[msg.messageType] ?? msg.messageType}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <span className={`text-xs border rounded px-1.5 py-0.5 ${STATUS_COLORS[msg.status] ?? ""}`}>
                        {msg.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground text-xs max-w-xs truncate">{msg.messageText}</td>
                    <td className="px-4 py-2 text-muted-foreground text-xs whitespace-nowrap">
                      {msg.sentAt ? format(new Date(msg.sentAt), "MMM d, HH:mm") : " "}
                    </td>
                    <td className="px-4 py-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => deleteMutation.mutate(msg.id)}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
