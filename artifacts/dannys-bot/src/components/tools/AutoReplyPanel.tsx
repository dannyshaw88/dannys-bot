import { useState, useEffect, useRef } from "react";
import { useUpdateTool } from "@/hooks/use-tools";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { MessageSquare, Plus, Trash2, Shuffle, Info, UserCheck, Heart, Clock } from "lucide-react";
import { format } from "date-fns";
import { type Tool, type Profile } from "@shared/schema";
import { useProfileEngineStatus } from "@/hooks/use-engine-status";

interface AutoReplyRule {
  word: string;
  reply: string;
}

interface Props {
  tool: Tool;
  profile: Profile;
  embedded?: boolean;
}

function applySpintax(text: string): string {
  return text.replace(/\{([^}]+)\}/g, (_, group) => {
    const parts = group.split("|");
    return parts[Math.floor(Math.random() * parts.length)];
  });
}

export function AutoReplyPanel({ tool, profile, embedded }: Props) {
  const updateToolMutation = useUpdateTool();
  const engineStatus = useProfileEngineStatus(tool.profileId);

  const [settings, setSettings] = useState(() => {
    const def: Record<string, any> = {
      autoReplyEnabled: false,
      autoReplies: [] as AutoReplyRule[],
      autoReplyOnlyAppFollowed: false,
      autoReplyLikeDm: false,
    };
    return { ...def, ...(tool.settings as object || {}) };
  });

  const [newWord, setNewWord]   = useState("");
  const [newReply, setNewReply] = useState("");
  const [preview, setPreview]   = useState("");

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

  const rules: AutoReplyRule[] = Array.isArray(settings.autoReplies) ? settings.autoReplies : [];

  const addRule = () => {
    const word  = newWord.trim().toLowerCase();
    const reply = newReply.trim();
    if (!word || !reply) return;
    const updated = [...rules, { word, reply }];
    setSettings({ ...settings, autoReplies: updated });
    setNewWord("");
    setNewReply("");
    setPreview("");
  };

  const removeRule = (index: number) => {
    const updated = rules.filter((_, i) => i !== index);
    setSettings({ ...settings, autoReplies: updated });
  };

  return (
    <div className="space-y-4 animate-in fade-in duration-300">

      {/* Master Enable */}
      <div className="flex items-center gap-3 px-1">
        <input
          type="checkbox"
          id="autoReplyEnabled"
          checked={!!settings.autoReplyEnabled}
          onChange={(e) => setSettings({ ...settings, autoReplyEnabled: e.target.checked })}
          className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
        />
        <div>
          <label htmlFor="autoReplyEnabled" className="text-sm font-semibold cursor-pointer select-none">Auto Reply</label>
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[11px] text-muted-foreground">Automatically reply to DMs containing specific trigger words.</p>
            {!embedded && (() => {
              if (!settings.autoReplyEnabled) return null;
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
          </div>
        </div>
      </div>

      {/* Info note */}
      <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2.5 text-[11px] text-blue-700">
        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <span>
          Auto Reply scans your DMs each time the <strong>Check DMs</strong> action fires in the Human Session Tools tab.
          Adjust the check frequency there.
        </span>
      </div>

      {/* Filters & behaviour */}
      <div className="border border-border rounded-xl p-4 space-y-3">
        <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Behaviour</p>

        {/* Only app-followed users */}
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="autoReplyOnlyAppFollowed"
            checked={!!settings.autoReplyOnlyAppFollowed}
            onChange={(e) => setSettings({ ...settings, autoReplyOnlyAppFollowed: e.target.checked })}
            className="w-3.5 h-3.5 mt-0.5 accent-primary cursor-pointer shrink-0"
          />
          <div>
            <label htmlFor="autoReplyOnlyAppFollowed" className="text-sm font-medium cursor-pointer select-none flex items-center gap-1.5">
              <UserCheck className="w-3.5 h-3.5 text-green-600" />
              Only reply to app-followed users
            </label>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Only send auto-replies to DMs from users who appear in the Follow Tool's Followed Users list for this profile.
            </p>
          </div>
        </div>

        {/* Like the DM */}
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            id="autoReplyLikeDm"
            checked={!!settings.autoReplyLikeDm}
            onChange={(e) => setSettings({ ...settings, autoReplyLikeDm: e.target.checked })}
            className="w-3.5 h-3.5 mt-0.5 accent-primary cursor-pointer shrink-0"
          />
          <div>
            <label htmlFor="autoReplyLikeDm" className="text-sm font-medium cursor-pointer select-none flex items-center gap-1.5">
              <Heart className="w-3.5 h-3.5 text-red-500" />
              Like the incoming DM when replying
            </label>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Reacts to the triggering message with a ❤️ before queuing the auto-reply. Feels more natural to the sender.
            </p>
          </div>
        </div>
      </div>

      {/* Add trigger rule */}
      <div className="border border-border rounded-xl p-4 space-y-4">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-blue-500" />
          <h4 className="font-semibold text-sm">Add Reply Based on a Trigger Word</h4>
        </div>

        <div className="space-y-2">
          <div>
            <Label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Trigger Word</Label>
            <Input
              className="mt-1 h-8 text-sm"
              placeholder="e.g. price, collab, info"
              value={newWord}
              onChange={(e) => setNewWord(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && newWord && newReply) addRule(); }}
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              If any incoming message contains this word (case-insensitive), the reply below is queued.
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between mt-2">
              <Label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Reply Message</Label>
              <button
                onClick={() => setPreview(applySpintax(newReply))}
                className="flex items-center gap-1 text-[11px] text-primary hover:text-primary/80 font-medium transition-colors"
              >
                <Shuffle className="w-3 h-3" />
                Preview spin
              </button>
            </div>
            <textarea
              rows={3}
              className="w-full mt-1 text-sm border border-border rounded-lg p-3 bg-background resize-none focus:outline-none focus:ring-1 focus:ring-primary font-mono"
              placeholder={`{Thanks|Cheers} for reaching out! Here's the info: ...`}
              value={newReply}
              onChange={(e) => { setNewReply(e.target.value); setPreview(""); }}
            />
            <p className="text-[11px] text-muted-foreground">
              Use <code className="bg-muted px-1 rounded">{"{Hi|Hello}"}</code> spintax to randomise the reply.
              Use <code className="bg-muted px-1 rounded">[FIRSTNAME]</code> to insert the recipient's first name (e.g. <span className="italic">Hey [FIRSTNAME]!</span>).
            </p>
            {preview && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-sm text-blue-800 mt-1">
                <span className="font-semibold text-[11px] text-blue-500 uppercase tracking-wider block mb-0.5">Preview</span>
                {preview}
              </div>
            )}
          </div>

          <Button
            size="sm"
            className="mt-1 gap-1.5"
            disabled={!newWord.trim() || !newReply.trim()}
            onClick={addRule}
          >
            <Plus className="w-3.5 h-3.5" />
            Add Trigger
          </Button>
        </div>
      </div>

      {/* Trigger list */}
      <div className="border border-border rounded-xl overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-muted/30">
          <MessageSquare className="w-4 h-4 text-blue-500" />
          <span className="text-sm font-semibold">Active Triggers</span>
          <span className="text-xs text-muted-foreground">({rules.length})</span>
        </div>

        {!rules.length ? (
          <p className="text-sm text-muted-foreground px-4 py-6 text-center">
            No triggers added yet. Add one above.
          </p>
        ) : (
          <div className="divide-y divide-border/40">
            {rules.map((rule, i) => (
              <div key={i} className="flex items-start gap-3 px-4 py-3 hover:bg-muted/20 transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Trigger</span>
                    <span className="text-sm font-semibold text-primary">
                      "{rule.word}"
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground font-mono truncate">{rule.reply}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive shrink-0 mt-0.5"
                  onClick={() => removeRule(i)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
