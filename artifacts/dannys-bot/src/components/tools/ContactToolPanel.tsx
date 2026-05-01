import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useUpdateTool } from "@/hooks/use-tools";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  MessageSquare, UserCheck, Clock, Users, Zap, Trash2, RefreshCw, Shuffle,
} from "lucide-react";
import { format } from "date-fns";
import { type Tool, type Profile, type ContactDmSent } from "@shared/schema";

interface ContactToolPanelProps {
  tool: Tool;
  profile: Profile;
}

function applySpintax(text: string): string {
  return text.replace(/\{([^}]+)\}/g, (_, group) => {
    const parts = group.split("|");
    return parts[Math.floor(Math.random() * parts.length)];
  });
}

export function ContactToolPanel({ tool, profile }: ContactToolPanelProps) {
  const updateToolMutation = useUpdateTool();
  const queryClient = useQueryClient();
  const [previewText, setPreviewText] = useState("");

  const { data: dmSentList, isLoading: dmSentLoading } = useQuery<ContactDmSent[]>({
    queryKey: [`/api/profiles/${profile.id}/contact-dm-sent`],
    refetchInterval: 15000,
  });

  const deleteDmSentMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/contact-dm-sent/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [`/api/profiles/${profile.id}/contact-dm-sent`] }),
  });

  const [settings, setSettings] = useState(() => {
    const def: Record<string, any> = {
      contactOnlyAppFollowed: true,
      contactMessage: "",
      contactCheckIntervalMin: 30,
      contactCheckIntervalMax: 60,
      contactUsersPerCheckMin: 20,
      contactUsersPerCheckMax: 40,
      contactDelayAfterDmMin: 10,
      contactDelayAfterDmMax: 30,
      contactApiSource: "account",
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

  const numInput = (key: string, min: number, max: number, width = "w-20") => (
    <Input
      type="number"
      min={min}
      max={max}
      className={`${width} h-7 text-xs`}
      value={settings[key] ?? min}
      onChange={(e) => setSettings({ ...settings, [key]: Math.max(min, Math.min(max, Number(e.target.value))) })}
    />
  );

  return (
    <div className="space-y-4 animate-in fade-in duration-300">

      {/* Master Enable */}
      <div className="flex items-center gap-3 px-1">
        <Switch
          checked={!!tool.enabled}
          onCheckedChange={(v) => updateToolMutation.mutate({ id: tool.id, profileId: tool.profileId, enabled: v })}
        />
        <div>
          <p className="text-sm font-semibold">Contact Tool</p>
          <p className="text-[11px] text-muted-foreground">Automatically message new followers on a schedule.</p>
        </div>
      </div>

      {/* ── Send Message to New Followers ─────────────────────── */}
      <div className="border border-border rounded-xl p-4 space-y-4">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-blue-500" />
          <h4 className="font-semibold text-sm">Send Message to New Followers</h4>
        </div>

        {/* Option 1: Only app-followed users */}
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="contactOnlyAppFollowed"
            checked={!!settings.contactOnlyAppFollowed}
            onChange={(e) => setSettings({ ...settings, contactOnlyAppFollowed: e.target.checked })}
            className="w-3.5 h-3.5 mt-0.5 accent-primary cursor-pointer shrink-0"
          />
          <div>
            <label htmlFor="contactOnlyAppFollowed" className="text-sm font-medium cursor-pointer select-none flex items-center gap-1.5">
              <UserCheck className="w-3.5 h-3.5 text-green-600" />
              Send message to users followed through the app
            </label>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Only messages followers who also appear in the Follow Tool's Followed Users list for this profile.
            </p>
          </div>
        </div>

        {/* Option 2: Message with SpinTax */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Message</Label>
            <button
              onClick={() => setPreviewText(applySpintax(settings.contactMessage ?? ""))}
              className="flex items-center gap-1 text-[11px] text-primary hover:text-primary/80 font-medium transition-colors"
            >
              <Shuffle className="w-3 h-3" />
              Preview spin
            </button>
          </div>
          <textarea
            rows={4}
            className="w-full text-sm border border-border rounded-lg p-3 bg-background resize-none focus:outline-none focus:ring-1 focus:ring-primary font-mono"
            placeholder={`{Hi|Hello|Hey} {there|friend}! Thanks for following — check out our latest posts 🙌`}
            value={settings.contactMessage ?? ""}
            onChange={(e) => {
              setSettings({ ...settings, contactMessage: e.target.value });
              setPreviewText("");
            }}
          />
          <p className="text-[11px] text-muted-foreground">
            Use <code className="bg-muted px-1 rounded">{"{Hi|Hello|Hey}"}</code> syntax to randomly pick one option per send. Click "Preview spin" to see a sample.
          </p>
          {previewText && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-sm text-blue-800">
              <span className="font-semibold text-[11px] text-blue-500 uppercase tracking-wider block mb-0.5">Preview</span>
              {previewText}
            </div>
          )}
        </div>

        {/* Option 3: Check interval + users per check */}
        <div className="space-y-2">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <Clock className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Check Every (min)</span>
              <div className="flex items-center gap-1.5">
                <Label className="text-xs text-muted-foreground">Min</Label>
                {numInput("contactCheckIntervalMin", 1, 10000)}
              </div>
              <div className="flex items-center gap-1.5">
                <Label className="text-xs text-muted-foreground">Max</Label>
                {numInput("contactCheckIntervalMax", 1, 10000)}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <Users className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Users per Check</span>
              <div className="flex items-center gap-1.5">
                <Label className="text-xs text-muted-foreground">Min</Label>
                {numInput("contactUsersPerCheckMin", 1, 200)}
              </div>
              <div className="flex items-center gap-1.5">
                <Label className="text-xs text-muted-foreground">Max</Label>
                {numInput("contactUsersPerCheckMax", 1, 200)}
              </div>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            One GetFollowers API call returns up to 20 users. Set users per check in multiples of 20 accordingly.
          </p>
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <Clock className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Delay Between DMs (s)</span>
              <div className="flex items-center gap-1.5">
                <Label className="text-xs text-muted-foreground">Min</Label>
                {numInput("contactDelayAfterDmMin", 1, 3600)}
              </div>
              <div className="flex items-center gap-1.5">
                <Label className="text-xs text-muted-foreground">Max</Label>
                {numInput("contactDelayAfterDmMax", 1, 3600)}
              </div>
            </div>
          </div>
        </div>

        {/* Option 4: API Source */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Zap className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">GetFollowers API Source</span>
          </div>
          <div className="flex gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="contactApiSource"
                value="account"
                checked={settings.contactApiSource === "account"}
                onChange={() => setSettings({ ...settings, contactApiSource: "account" })}
                className="accent-primary"
              />
              <span className="text-sm">Account itself</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="contactApiSource"
                value="hiker"
                checked={settings.contactApiSource === "hiker"}
                onChange={() => setSettings({ ...settings, contactApiSource: "hiker" })}
                className="accent-primary"
              />
              <span className="text-sm">HikerAPI</span>
            </label>
          </div>
          <p className="text-[11px] text-muted-foreground">
            HikerAPI requires a valid token in the global Settings page. Uses the account's own session if HikerAPI is not available.
          </p>
        </div>
      </div>

      {/* ── DM Sent Log ───────────────────────────────────────── */}
      <div className="border border-border rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-blue-500" />
            <span className="text-sm font-semibold">New-Follower DMs Sent</span>
            <span className="text-xs text-muted-foreground">({dmSentList?.length ?? 0} total)</span>
          </div>
          <button
            onClick={() => queryClient.invalidateQueries({ queryKey: [`/api/profiles/${profile.id}/contact-dm-sent`] })}
            className="p-1.5 rounded-lg hover:bg-accent/50 transition-colors text-muted-foreground"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="overflow-x-auto max-h-80">
          {dmSentLoading ? (
            <p className="text-sm text-muted-foreground px-4 py-6 text-center">Loading…</p>
          ) : !dmSentList?.length ? (
            <p className="text-sm text-muted-foreground px-4 py-6 text-center">No DMs sent yet.</p>
          ) : (
            <table className="w-full text-sm text-left">
              <thead className="text-xs uppercase bg-muted/30 text-muted-foreground font-bold border-b border-border/50 sticky top-0 z-10">
                <tr>
                  <th className="px-4 py-2 font-bold bg-muted/30">User</th>
                  <th className="px-4 py-2 font-bold bg-muted/30">Message Preview</th>
                  <th className="px-4 py-2 font-bold bg-muted/30 whitespace-nowrap">Sent At</th>
                  <th className="px-4 py-2 font-bold bg-muted/30"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {dmSentList.map((entry) => (
                  <tr key={entry.id} className="hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-2 font-medium text-primary">
                      <a
                        href={`https://instagram.com/${entry.instagramUsername}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline"
                      >
                        @{entry.instagramUsername}
                      </a>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground text-xs max-w-xs truncate">
                      {entry.messagePreview || "—"}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground text-xs whitespace-nowrap">
                      {format(new Date(entry.sentAt), "MMM d, yyyy HH:mm")}
                    </td>
                    <td className="px-4 py-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => deleteDmSentMutation.mutate(entry.id)}
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
