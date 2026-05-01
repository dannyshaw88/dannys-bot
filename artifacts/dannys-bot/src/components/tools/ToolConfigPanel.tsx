import { useState, useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useUpdateTool } from "@/hooks/use-tools";
import { useSources, useCreateSource, useDeleteSource, useImportSources, parseJarveeHashtagFile } from "@/hooks/use-sources";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Plus, Trash2, Hash, Users, ChevronRight, ArrowLeft, Copy, Check, X, Upload, Download, ListFilter, UserPlus, Clock, ExternalLink, Activity, Heart, PlaySquare, BookOpen, Star, UserCheck, Ban, SkipForward, AlertCircle, MessageSquare, Bell, User, RefreshCw, Settings, Repeat2, Image, AtSign } from "lucide-react";
import { useRef } from "react";
import { type Tool, type Profile, type FollowedUser, type SessionAction, type RepostedPost } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { useBrowserWindows } from "@/contexts/BrowserWindowsContext";
interface ToolConfigPanelProps {
  tool: Tool;
  profile: Profile;
  hideHumanSession?: boolean;
}


export function ToolConfigPanel({ tool, profile, hideHumanSession }: ToolConfigPanelProps) {
  const { toast } = useToast();
  const { navigateTo } = useBrowserWindows();
  const updateToolMutation = useUpdateTool();
  const { data: sources, isLoading: sourcesLoading } = useSources(tool.id);
  const createSourceMutation = useCreateSource();
  const deleteSourceMutation = useDeleteSource();
  const importSourcesMutation = useImportSources();
  const importFileRef = useRef<HTMLInputElement>(null);

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const rows = await parseJarveeHashtagFile(file);
      if (!rows.length) { toast({ title: "No hashtags found in file", variant: "destructive" }); return; }
      await importSourcesMutation.mutateAsync({
        toolId: tool.id,
        rows: rows.map(r => ({ type: 'hashtag', value: r.value, rank: r.rank, nrPosts: r.nrPosts })),
      });
      toast({ title: `Imported ${rows.length} hashtag${rows.length !== 1 ? 's' : ''}` });
    } catch {
      toast({ title: "Failed to import file", description: "Make sure it's a valid Jarvee hashtag export.", variant: "destructive" });
    } finally {
      if (importFileRef.current) importFileRef.current.value = '';
    }
  };

  const handleExport = () => {
    if (!sources?.length) { toast({ title: "No sources to export" }); return; }
    const header = 'Keyword\tNrPosts\tRank';
    const rows = sources.map(s => `${s.value}\t${s.nrPosts ?? ''}\t${s.rank ?? ''}`);
    const tsv = [header, ...rows].join('\r\n');
    // Encode as UTF-16LE with BOM for Jarvee compatibility
    const buf = new ArrayBuffer(2 + tsv.length * 2);
    const view = new DataView(buf);
    view.setUint8(0, 0xff); view.setUint8(1, 0xfe); // BOM
    for (let i = 0; i < tsv.length; i++) {
      view.setUint16(2 + i * 2, tsv.charCodeAt(i), true);
    }
    const blob = new Blob([buf], { type: 'text/plain;charset=utf-16le' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `sources_tool_${tool.id}.txt`; a.click();
    URL.revokeObjectURL(url);
  };

  // Local state for settings form
  const [settings, setSettings] = useState(() => {
    const def = { 
      delayMin: 1, 
      delayMax: 2, 
      maxPerDayMin: 150,
      maxPerDayMax: 200,
      maxPerHourMin: 5,
      maxPerHourMax: 15,
      processMin: 5,
      processMax: 15,
      abortScrapeAfterMin: 10,
      abortScrapeAfterMax: 50,
      likeChanceMin: 1,
      likeChanceMax: 5,
      viewReelsChanceMin: 1,
      viewReelsChanceMax: 5,
      viewStoriesChanceMin: 1,
      viewStoriesChanceMax: 5,
      viewHighlightsChanceMin: 1,
      viewHighlightsChanceMax: 5,
      likeProcessMin: 1,
      likeProcessMax: 1,
      viewReelsProcessMin: 1,
      viewReelsProcessMax: 2,
      viewStoriesProcessMin: 1,
      viewStoriesProcessMax: 3,
      viewHighlightsProcessMin: 1,
      viewHighlightsProcessMax: 2,
      likeMaxPerDayMin: 30,
      likeMaxPerDayMax: 50,
      viewReelsMaxPerDayMin: 30,
      viewReelsMaxPerDayMax: 50,
      viewStoriesMaxPerDayMin: 30,
      viewStoriesMaxPerDayMax: 50,
      viewHighlightsMaxPerDayMin: 30,
      viewHighlightsMaxPerDayMax: 50,
      likeBeforeMin: 0,
      likeBeforeMax: 0,
      viewReelsBeforeMin: 0,
      viewReelsBeforeMax: 0,
      viewStoriesBeforeMin: 0,
      viewStoriesBeforeMax: 0,
      viewHighlightsBeforeMin: 0,
      viewHighlightsBeforeMax: 0,
      delayAfterFollowMin: 5,
      delayAfterFollowMax: 15,
      likeDelayMin: 2,
      likeDelayMax: 6,
      viewReelsDelayMin: 2,
      viewReelsDelayMax: 6,
      viewStoriesDelayMin: 2,
      viewStoriesDelayMax: 6,
      viewHighlightsDelayMin: 2,
      viewHighlightsDelayMax: 6,
      likeMaxPerHourMin: 2,
      likeMaxPerHourMax: 5,
      viewReelsMaxPerHourMin: 2,
      viewReelsMaxPerHourMax: 5,
      viewStoriesMaxPerHourMin: 2,
      viewStoriesMaxPerHourMax: 5,
      viewHighlightsMaxPerHourMin: 2,
      viewHighlightsMaxPerHourMax: 5,
      autoReplyEnabled: false,
      autoReplyTrigger: "",
      autoReplyMessage: "",
      dmMessages: "",
      minFollowAgeDays: 3,
      delayAfterUnfollowMin: 5,
      delayAfterUnfollowMax: 15,
      skipIndianUsers: false,
      executionOrderMin: 5,
      executionOrderMax: 10,
      viewTimelineFeedMin: 3,
      viewTimelineFeedMax: 8,
      viewTimelineFeedOrderMin: 5,
      viewTimelineFeedOrderMax: 10,
      humanToolsDelayMin: 30,
      humanToolsDelayMax: 60,
      humanSessionOrderMin: 0,
      humanSessionOrderMax: 0,
      humanSessionNotUsedMin: 0,
      humanSessionNotUsedMax: 0,
      humanToolsEnabled: true,
      sessionActionVariationEnabled: true,
      viewTimelineFeedEnabled: true,
      viewTimelineFeedNotUsedMin: 0,
      viewTimelineFeedNotUsedMax: 0,
      humanSessionEnabled: true,
      checkTimelineReelsEnabled: true,
      checkTimelineStoriesEnabled: true,
      checkDmEnabled: true,
      checkTimelineReelsMin: 3,
      checkTimelineReelsMax: 8,
      checkTimelineReelsOrderMin: 0,
      checkTimelineReelsOrderMax: 0,
      checkTimelineReelsNotUsedMin: 0,
      checkTimelineReelsNotUsedMax: 0,
      checkTimelineStoriesMin: 3,
      checkTimelineStoriesMax: 8,
      checkTimelineStoriesOrderMin: 0,
      checkTimelineStoriesOrderMax: 0,
      checkTimelineStoriesNotUsedMin: 0,
      checkTimelineStoriesNotUsedMax: 0,
      checkDmMin: 5,
      checkDmMax: 15,
      checkDmOrderMin: 0,
      checkDmOrderMax: 0,
      checkDmNotUsedMin: 0,
      checkDmNotUsedMax: 0,
      contextualActionsEnabled: false,
      contextualActionsMin: 5,
      contextualActionsMax: 5,
      contextualActionsDelayMin: 0,
      contextualActionsDelayMax: 1,
      discoverPagePercentageMin: 100,
      discoverPagePercentageMax: 100,
      repostEnabled: false,
      repostSourceUsername: "",
      repostOrderMin: 0,
      repostOrderMax: 0,
      repostNotUsedMin: 0,
      repostNotUsedMax: 0,
      repostDisableAtPostCount: 0,
      repostDisableWhenExhausted: true,
    };
    return { ...def, ...(tool.settings as object || {}) };
  });

  const [newSourceType, setNewSourceType] = useState<'hashtag' | 'target_followers'>('hashtag');
  const [newSourceValue, setNewSourceValue] = useState("");
  const [showSources, setShowSources] = useState(false);
  const [showFollowedUsers, setShowFollowedUsers] = useState(false);
  const [showSessionLog, setShowSessionLog] = useState(false);
  const [showRepostedPosts, setShowRepostedPosts] = useState(false);

  const { data: followedUsersList, isLoading: followedUsersLoading } = useQuery<FollowedUser[]>({
    queryKey: [`/api/profiles/${tool.profileId}/followed-users`],
    refetchInterval: 10000,
    enabled: showFollowedUsers,
  });

  const { data: sessionActionsList, isLoading: sessionActionsLoading } = useQuery<SessionAction[]>({
    queryKey: [`/api/profiles/${tool.profileId}/session-actions`],
    refetchInterval: 5000,
    enabled: showSessionLog,
  });

  const { data: repostedPostsList, isLoading: repostedPostsLoading } = useQuery<RepostedPost[]>({
    queryKey: [`/api/profiles/${tool.profileId}/reposted-posts`],
    refetchInterval: 15000,
  });
  const [showCopyModal, setShowCopyModal] = useState(false);
  const [selectedProfileIds, setSelectedProfileIds] = useState<Set<number>>(new Set());
  const [copying, setCopying] = useState(false);

  const { data: allProfiles = [] } = useQuery<Profile[]>({
    queryKey: ['/api/profiles'],
    enabled: showCopyModal,
  });
  const otherProfiles = allProfiles.filter(p => p.id !== tool.profileId);

  const toggleProfile = (id: number) => {
    setSelectedProfileIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleCopyConfig = async () => {
    if (selectedProfileIds.size === 0) return;
    setCopying(true);
    let successCount = 0;
    let failCount = 0;
    for (const profileId of selectedProfileIds) {
      try {
        const res = await fetch(`/api/profiles/${profileId}/tools`, { credentials: "include" });
        const profileTools: Tool[] = await res.json();
        const match = profileTools.find(t => t.type === tool.type);
        if (match) {
          const upd = await fetch(`/api/tools/${match.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ settings }),
            credentials: "include",
          });
          upd.ok ? successCount++ : failCount++;
        } else {
          failCount++;
        }
      } catch {
        failCount++;
      }
    }
    setCopying(false);
    setShowCopyModal(false);
    setSelectedProfileIds(new Set());
    toast({
      title: `Configuration Copied`,
      description: `Copied to ${successCount} profile${successCount !== 1 ? "s" : ""}${failCount ? `, ${failCount} failed` : ""}.`,
    });
  };

  const handleToggleEnable = (enabled: boolean) => {
    updateToolMutation.mutate({ id: tool.id, profileId: tool.profileId, enabled });
  };

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

  const handleAddSource = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSourceValue.trim()) return;
    
    createSourceMutation.mutate({
      toolId: tool.id,
      type: newSourceType,
      value: newSourceValue.trim()
    }, {
      onSuccess: () => {
        setNewSourceValue("");
        toast({ title: "Source Added" });
      }
    });
  };

  const NumInput = ({ valueKey, min = 0, max, unit, onChange }: { valueKey: string; min?: number; max?: number; unit?: string; onChange?: (v: number) => void }) => (
    <div className="relative w-full">
      <Input type="number" className={`w-full h-6 text-xs px-2 ${unit ? 'pr-4' : ''}`} min={min} max={max}
        value={(settings as any)[valueKey]}
        onChange={(e) => {
          const v = max !== undefined ? Math.min(max, Number(e.target.value)) : Number(e.target.value);
          setSettings({ ...settings, [valueKey]: v });
          onChange?.(v);
        }}
      />
      {unit && <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground pointer-events-none">{unit}</span>}
    </div>
  );

  const ActionVariationRow = ({ label, chanceMinKey, chanceMaxKey, maxPerDayMinKey, maxPerDayMaxKey, beforeMinKey, beforeMaxKey, delayMinKey, delayMaxKey, processMinKey, processMaxKey }: { label: string; chanceMinKey: string; chanceMaxKey: string; maxPerDayMinKey: string; maxPerDayMaxKey: string; beforeMinKey: string; beforeMaxKey: string; delayMinKey: string; delayMaxKey: string; processMinKey: string; processMaxKey: string }) => (
    <div className="contents">
      <span className="text-xs font-semibold text-foreground">{label}</span>
      <NumInput valueKey={processMinKey} min={1} />
      <span className="text-[10px] text-muted-foreground text-center">–</span>
      <NumInput valueKey={processMaxKey} min={1} />
      <NumInput valueKey={delayMinKey} min={0} unit="s" />
      <span className="text-[10px] text-muted-foreground text-center">–</span>
      <NumInput valueKey={delayMaxKey} min={0} unit="s" />
      <NumInput valueKey={chanceMinKey} min={0} max={100} unit="%" />
      <span className="text-[10px] text-muted-foreground text-center">–</span>
      <NumInput valueKey={chanceMaxKey} min={0} max={100} unit="%" />
      <NumInput valueKey={beforeMinKey} min={0} max={100} unit="%" />
      <span className="text-[10px] text-muted-foreground text-center">–</span>
      <NumInput valueKey={beforeMaxKey} min={0} max={100} unit="%" />
      <NumInput valueKey={maxPerDayMinKey} min={0} />
      <span className="text-[10px] text-muted-foreground text-center">–</span>
      <NumInput valueKey={maxPerDayMaxKey} min={0} />
    </div>
  );

  const SettingSlider = ({ label, value, onChange, min = 0, max = 100, step = 1, unit = "%" }: any) => {
    const [localValue, setLocalValue] = useState(value);
    
    // Use an effect to sync local value if the prop changes from outside (e.g. tool change)
    useEffect(() => {
      setLocalValue(value);
    }, [value]);

    return (
      <div className="space-y-2">
        <div className="flex justify-between">
          <Label className="text-xs font-medium">{label}</Label>
          <span className="text-xs text-muted-foreground font-mono">{localValue}{unit}</span>
        </div>
        <input 
          type="range" 
          min={min} 
          max={max} 
          step={step}
          value={localValue} 
          onChange={(e) => {
            const val = Number(e.target.value);
            setLocalValue(val);
          }}
          onMouseUp={() => onChange(localValue)}
          onTouchEnd={() => onChange(localValue)}
          className="w-full h-1.5 bg-accent rounded-lg appearance-none cursor-pointer accent-primary"
        />
      </div>
    );
  };

  // Sources sub-page for Follow tool
  if (tool.type === 'follow' && showSources) {
    return (
      <div className="animate-in fade-in slide-in-from-right-4 duration-300">
        <div className="flex items-center gap-3 mb-6">
          <Button variant="ghost" size="sm" onClick={() => setShowSources(false)}
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground -ml-2">
            <ArrowLeft className="w-4 h-4" /> Back to Create a Session Tool
          </Button>
        </div>
        <div className="desktop-card p-6">
          <div className="flex gap-3 mb-6 flex-wrap">
            <form onSubmit={handleAddSource} className="flex gap-3 flex-1 min-w-0">
              <select className="h-10 rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 shrink-0"
                value={newSourceType} onChange={(e) => setNewSourceType(e.target.value as any)}>
                <option value="hashtag">Hashtag</option>
                <option value="target_followers">Followers of Account</option>
              </select>
              <Input placeholder={newSourceType === 'hashtag' ? "e.g. #photography" : "e.g. @natgeo"}
                value={newSourceValue} onChange={(e) => setNewSourceValue(e.target.value)} className="flex-1" />
              <Button type="submit" disabled={createSourceMutation.isPending || !newSourceValue.trim()}>
                <Plus className="w-4 h-4 mr-2" /> Add
              </Button>
            </form>
            <input ref={importFileRef} type="file" accept=".txt,.tsv,.csv" className="hidden" onChange={handleImportFile} />
            <Button type="button" variant="outline" disabled={importSourcesMutation.isPending} onClick={() => importFileRef.current?.click()}>
              <Upload className="w-4 h-4 mr-2" />{importSourcesMutation.isPending ? 'Importing…' : 'Import'}
            </Button>
            <Button type="button" variant="outline" onClick={handleExport}>
              <Download className="w-4 h-4 mr-2" /> Export
            </Button>
          </div>
          <div className="space-y-2">
            {sourcesLoading ? (
              <div className="text-center py-10 text-muted-foreground text-sm">Loading sources...</div>
            ) : sources?.length === 0 ? (
              <div className="text-center py-14 bg-accent/50 rounded-xl border border-border/50 border-dashed">
                <Users className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
                <p className="text-muted-foreground text-sm font-medium">No sources added yet</p>
                <p className="text-xs text-muted-foreground mt-1">Add a hashtag or account above to start targeting followers.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {sources?.map(source => (
                  <div key={source.id} className="flex items-center justify-between p-3 rounded-lg border border-border bg-background hover:bg-accent/30 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
                        {source.type === 'hashtag' ? <Hash className="w-4 h-4" /> : <Users className="w-4 h-4" />}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate max-w-[150px]">#{source.value}</p>
                        <div className="flex items-center gap-2 flex-wrap">
                          {source.rank != null && (
                            <span className="text-[10px] font-semibold text-primary bg-primary/10 px-1.5 py-0.5 rounded">Rank {source.rank}/1000</span>
                          )}
                          {source.nrPosts != null && (
                            <span className="text-[10px] text-muted-foreground">
                              {source.nrPosts >= 1_000_000 ? `${(source.nrPosts/1_000_000).toFixed(1)}M`
                                : source.nrPosts >= 1_000 ? `${(source.nrPosts/1_000).toFixed(0)}K`
                                : source.nrPosts} posts
                            </span>
                          )}
                          {source.rank == null && source.nrPosts == null && (
                            <span className="text-xs text-muted-foreground capitalize">{source.type.replace('_', ' ')}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0"
                      onClick={() => deleteSourceMutation.mutate({ id: source.id, toolId: tool.id })} disabled={deleteSourceMutation.isPending}>
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }


  // ── Followed Users sub-page ──────────────────────────────────────────────────
  if (tool.type === 'follow' && showFollowedUsers) {
    return (
      <div className="animate-in fade-in slide-in-from-right-4 duration-300 space-y-5">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setShowFollowedUsers(false)}
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground -ml-2">
            <ArrowLeft className="w-4 h-4" /> Back to Create a Session Tool
          </Button>
        </div>

        <div className="desktop-card overflow-hidden">
          <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              <UserPlus className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold">Followed Users</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                All users followed by this account · sorted by most recent · {followedUsersList?.length ?? 0} total
              </p>
            </div>
          </div>
          <div className="overflow-x-auto max-h-[60vh]">
            <table className="w-full text-sm text-left">
              <thead className="text-xs uppercase bg-muted/30 text-muted-foreground font-bold border-b border-border/50 sticky top-0 z-10">
                <tr>
                  <th className="px-5 py-3 font-bold bg-muted/30 whitespace-nowrap">Date / Time</th>
                  <th className="px-5 py-3 font-bold bg-muted/30 whitespace-nowrap">Username</th>
                  <th className="px-5 py-3 font-bold bg-muted/30 whitespace-nowrap">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {followedUsersLoading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      <td colSpan={3} className="px-5 py-3.5 bg-muted/10 h-11" />
                    </tr>
                  ))
                ) : !followedUsersList || followedUsersList.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-5 py-20 text-center text-muted-foreground">
                      <UserPlus className="w-8 h-8 mx-auto mb-3 text-muted-foreground/30" />
                      <p className="text-sm font-medium">No followed users yet</p>
                      <p className="text-xs mt-1">Users will appear here once the follow tool runs.</p>
                    </td>
                  </tr>
                ) : (
                  followedUsersList.map(fu => (
                    <tr key={fu.id} className="hover:bg-accent/5 transition-colors">
                      <td className="px-5 py-3 whitespace-nowrap text-muted-foreground text-xs font-mono">
                        <span className="flex items-center gap-1.5">
                          <Clock className="w-3 h-3 shrink-0" />
                          {format(new Date(fu.followedAt), "MMM d, yyyy HH:mm")}
                        </span>
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap font-medium text-foreground">
                        <button
                          data-testid={`link-followed-user-${fu.id}`}
                          onClick={() => navigateTo(profile.id, profile.username, profile.userAgentEmbedded || "", `https://www.instagram.com/${fu.instagramUsername}/`)}
                          className="flex items-center gap-1.5 text-primary hover:text-primary/70 hover:underline transition-colors group"
                          title={`Open @${fu.instagramUsername} in browser`}
                        >
                          @{fu.instagramUsername}
                          <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </button>
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap">
                        {fu.sourceValue ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-primary/10 text-primary text-[11px] font-medium">
                            {fu.sourceType === 'hashtag' ? <Hash className="w-3 h-3" /> : <Users className="w-3 h-3" />}
                            {fu.sourceValue}
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  // ── Session Log sub-page ─────────────────────────────────────────────────
  const ACTION_META: Record<string, { label: string; icon: any; color: string }> = {
    follow:           { label: "Followed",         icon: UserCheck,    color: "text-green-600 bg-green-50 border-green-200" },
    follow_blocked:   { label: "Follow Blocked",   icon: Ban,          color: "text-red-600 bg-red-50 border-red-200" },
    follow_skipped:   { label: "Follow Skipped",   icon: SkipForward,  color: "text-orange-500 bg-orange-50 border-orange-200" },
    dedup_skip:       { label: "Already Followed", icon: SkipForward,  color: "text-slate-500 bg-slate-50 border-slate-200" },
    like:             { label: "Liked Post",        icon: Heart,        color: "text-pink-600 bg-pink-50 border-pink-200" },
    view_stories:     { label: "Viewed Stories",   icon: BookOpen,     color: "text-blue-600 bg-blue-50 border-blue-200" },
    view_reels:       { label: "Viewed Reels",     icon: PlaySquare,   color: "text-violet-600 bg-violet-50 border-violet-200" },
    view_highlights:  { label: "Viewed Highlights",icon: Star,         color: "text-amber-600 bg-amber-50 border-amber-200" },
    visit_notifications:    { label: "Notifications",     icon: Bell,      color: "text-orange-600 bg-orange-50 border-orange-200" },
    visit_own_profile:      { label: "Own Profile",       icon: User,      color: "text-indigo-600 bg-indigo-50 border-indigo-200" },
    refresh_own_profile:    { label: "Refreshed Profile", icon: RefreshCw, color: "text-cyan-600 bg-cyan-50 border-cyan-200" },
    visit_settings_activity:{ label: "Settings & Activity",icon: Settings, color: "text-gray-600 bg-gray-50 border-gray-200" },
    check_timeline_reels:   { label: "Timeline Reels",   icon: PlaySquare,color: "text-rose-600 bg-rose-50 border-rose-200" },
    check_timeline_stories: { label: "Timeline Stories", icon: BookOpen,  color: "text-sky-600 bg-sky-50 border-sky-200" },
    check_dm:         { label: "Checked DMs",      icon: MessageSquare,color: "text-teal-600 bg-teal-50 border-teal-200" },
  };

  if (tool.type === 'follow' && showRepostedPosts) {
    return (
      <div className="animate-in fade-in slide-in-from-right-4 duration-300 space-y-5">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setShowRepostedPosts(false)}
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground -ml-2">
            <ArrowLeft className="w-4 h-4" /> Back to Create a Session Tool
          </Button>
        </div>

        <div className="desktop-card overflow-hidden">
          <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              <Repeat2 className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold">Reposted Posts</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Posts that have been reposted · {repostedPostsList?.length ?? 0} entries · refreshes every 10s
              </p>
            </div>
          </div>
          <div className="overflow-x-auto max-h-[60vh]">
            <table className="w-full text-sm text-left">
              <thead className="text-xs uppercase bg-muted/30 text-muted-foreground font-bold border-b border-border/50 sticky top-0 z-10">
                <tr>
                  <th className="px-5 py-3 font-bold bg-muted/30 whitespace-nowrap">Date / Time</th>
                  <th className="px-5 py-3 font-bold bg-muted/30 whitespace-nowrap">Source Account</th>
                  <th className="px-5 py-3 font-bold bg-muted/30 whitespace-nowrap">Post ID / Code</th>
                  <th className="px-5 py-3 font-bold bg-muted/30 w-full">Caption (preview)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {repostedPostsLoading ? (
                  Array.from({ length: 6 }).map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      <td colSpan={4} className="px-5 py-3.5 bg-muted/10 h-11" />
                    </tr>
                  ))
                ) : !repostedPostsList || repostedPostsList.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-5 py-20 text-center text-muted-foreground">
                      <Repeat2 className="w-8 h-8 mx-auto mb-3 text-muted-foreground/30" />
                      <p className="text-sm font-medium">No posts reposted yet</p>
                      <p className="text-xs mt-1">Reposted posts will appear here to prevent duplicates.</p>
                    </td>
                  </tr>
                ) : (
                  repostedPostsList.map(rp => (
                    <tr key={rp.id} className="hover:bg-accent/5 transition-colors">
                      <td className="px-5 py-3 whitespace-nowrap text-muted-foreground text-xs font-mono">
                        <span className="flex items-center gap-1.5">
                          <Clock className="w-3 h-3 shrink-0" />
                          {format(new Date(rp.repostedAt), "MMM d, HH:mm:ss")}
                        </span>
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap font-medium text-foreground">
                        <button
                          onClick={() => navigateTo(profile.id, profile.username, profile.userAgentEmbedded || "", `https://www.instagram.com/${rp.sourceUsername}/`)}
                          className="flex items-center gap-1.5 text-primary hover:text-primary/70 hover:underline transition-colors group"
                        >
                          <AtSign className="w-3 h-3" />
                          {rp.sourceUsername}
                          <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </button>
                      </td>
                      <td className="px-5 py-3 whitespace-nowrap text-xs text-muted-foreground font-mono">
                        {rp.shortcode ? (
                          <button
                            onClick={() => navigateTo(profile.id, profile.username, profile.userAgentEmbedded || "", `https://www.instagram.com/p/${rp.shortcode}/`)}
                            className="flex items-center gap-1 text-primary hover:underline group"
                          >
                            <Image className="w-3 h-3" />
                            {rp.shortcode}
                            <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                          </button>
                        ) : (
                          <span className="truncate max-w-[120px] block" title={rp.mediaId}>{rp.mediaId}</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-xs text-muted-foreground leading-relaxed max-w-[320px]">
                        <span className="line-clamp-2">{rp.caption || "—"}</span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  if (tool.type === 'follow' && showSessionLog) {
    return (
      <div className="animate-in fade-in slide-in-from-right-4 duration-300 space-y-5">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setShowSessionLog(false)}
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground -ml-2">
            <ArrowLeft className="w-4 h-4" /> Back to Create a Session Tool
          </Button>
        </div>

        <div className="desktop-card overflow-hidden">
          <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              <Activity className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold">Session Action Log</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                All automation actions performed · sorted by most recent · {sessionActionsList?.length ?? 0} entries · refreshes every 5s
              </p>
            </div>
          </div>
          <div className="overflow-x-auto max-h-[60vh]">
            <table className="w-full text-sm text-left">
              <thead className="text-xs uppercase bg-muted/30 text-muted-foreground font-bold border-b border-border/50 sticky top-0 z-10">
                <tr>
                  <th className="px-5 py-3 font-bold bg-muted/30 whitespace-nowrap">Date / Time</th>
                  <th className="px-5 py-3 font-bold bg-muted/30 whitespace-nowrap">Action</th>
                  <th className="px-5 py-3 font-bold bg-muted/30 whitespace-nowrap">Username</th>
                  <th className="px-5 py-3 font-bold bg-muted/30 whitespace-nowrap">Source</th>
                  <th className="px-5 py-3 font-bold bg-muted/30 w-full">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {sessionActionsLoading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      <td colSpan={5} className="px-5 py-3.5 bg-muted/10 h-11" />
                    </tr>
                  ))
                ) : !sessionActionsList || sessionActionsList.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-20 text-center text-muted-foreground">
                      <Activity className="w-8 h-8 mx-auto mb-3 text-muted-foreground/30" />
                      <p className="text-sm font-medium">No actions logged yet</p>
                      <p className="text-xs mt-1">Actions will appear here once the session tool runs.</p>
                    </td>
                  </tr>
                ) : (
                  sessionActionsList.map(sa => {
                    const meta = ACTION_META[sa.action] ?? { label: sa.action, icon: AlertCircle, color: "text-muted-foreground bg-muted/30 border-border" };
                    const Icon = meta.icon;
                    const isError = sa.result === "error";
                    return (
                      <tr key={sa.id} className={`hover:bg-accent/5 transition-colors ${isError ? "bg-red-50/40" : ""}`}>
                        <td className="px-5 py-3 whitespace-nowrap text-muted-foreground text-xs font-mono">
                          <span className="flex items-center gap-1.5">
                            <Clock className="w-3 h-3 shrink-0" />
                            {format(new Date(sa.timestamp), "MMM d, HH:mm:ss")}
                          </span>
                        </td>
                        <td className="px-5 py-3 whitespace-nowrap">
                          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] font-semibold ${meta.color}`}>
                            <Icon className="w-3 h-3" />
                            {meta.label}
                            {isError && <AlertCircle className="w-3 h-3 text-red-500" />}
                          </span>
                        </td>
                        <td className="px-5 py-3 whitespace-nowrap font-medium text-foreground">
                          <button
                            onClick={() => navigateTo(profile.id, profile.username, profile.userAgentEmbedded || "", `https://www.instagram.com/${sa.targetUsername}/`)}
                            className="flex items-center gap-1.5 text-primary hover:text-primary/70 hover:underline transition-colors group"
                            title={`Open @${sa.targetUsername} in browser`}
                          >
                            @{sa.targetUsername}
                            <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                          </button>
                        </td>
                        <td className="px-5 py-3 whitespace-nowrap">
                          {sa.sourceValue ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-primary/10 text-primary text-[11px] font-medium">
                              {sa.sourceType === 'hashtag' ? <Hash className="w-3 h-3" /> : <Users className="w-3 h-3" />}
                              {sa.sourceValue}
                            </span>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </td>
                        <td className="px-5 py-3 text-xs text-muted-foreground leading-relaxed">
                          {sa.detail || "—"}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">

      {/* Target Sources + Followed Users + Session Log — compact tab strip */}
      {tool.type === 'follow' && (
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setShowSources(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-background hover:bg-accent/50 hover:border-primary/40 transition-colors text-xs font-medium text-foreground"
          >
            <Users className="w-3.5 h-3.5 text-primary" />
            Target Sources
            <span className="ml-0.5 text-[10px] text-muted-foreground">
              ({sourcesLoading ? '…' : sources?.length ?? 0})
            </span>
          </button>
          <button
            onClick={() => setShowFollowedUsers(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-background hover:bg-accent/50 hover:border-primary/40 transition-colors text-xs font-medium text-foreground"
          >
            <UserPlus className="w-3.5 h-3.5 text-primary" />
            Followed Users
          </button>
          <button
            onClick={() => setShowSessionLog(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-background hover:bg-accent/50 hover:border-primary/40 transition-colors text-xs font-medium text-foreground"
          >
            <Activity className="w-3.5 h-3.5 text-primary" />
            Session Log
          </button>
          <button
            onClick={() => setShowRepostedPosts(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-background hover:bg-accent/50 hover:border-primary/40 transition-colors text-xs font-medium text-foreground"
          >
            <Repeat2 className="w-3.5 h-3.5 text-primary" />
            Reposted
            <span className="ml-0.5 text-[10px] text-muted-foreground">
              ({repostedPostsList?.length ?? '…'})
            </span>
          </button>
        </div>
      )}

      {/* Header & Master Switch — hidden for follow tools (title/desc shown inside the settings wrapper instead) */}
      {tool.type !== 'follow' && (
      <div className="desktop-card p-6">
        <h2 className="text-xl font-bold">Create a Human Session</h2>
        {tool.type !== 'follow' && (
          <div className="flex items-center gap-3 mt-2">
            <Switch
              checked={tool.enabled}
              onCheckedChange={handleToggleEnable}
              disabled={updateToolMutation.isPending}
            />
            <span className={`text-sm font-medium ${tool.enabled ? 'text-primary' : 'text-muted-foreground'}`}>
              {tool.enabled ? 'ACTIVE' : 'STOPPED'}
            </span>
          </div>
        )}
        <p className="text-sm text-muted-foreground mt-2">Configure limits and target sources for this tool.</p>
        {tool.type !== 'follow' && (
          <div className="flex items-center gap-4 mt-3">
            <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Run Timer (min)</span>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <Label htmlFor="globalDelayMin" className="text-xs whitespace-nowrap text-muted-foreground">Min</Label>
                <Input id="globalDelayMin" type="number" min="0" max="10000" className="w-20 h-7 text-xs"
                  value={settings.delayMin}
                  onChange={(e) => setSettings({...settings, delayMin: Math.min(10000, Number(e.target.value))})}
                />
              </div>
              <div className="flex items-center gap-1.5">
                <Label htmlFor="globalDelayMax" className="text-xs whitespace-nowrap text-muted-foreground">Max</Label>
                <Input id="globalDelayMax" type="number" min="0" max="10000" className="w-20 h-7 text-xs"
                  value={settings.delayMax}
                  onChange={(e) => setSettings({...settings, delayMax: Math.min(10000, Number(e.target.value))})}
                />
              </div>
            </div>
          </div>
        )}
      </div>
      )}

      <div className={`grid grid-cols-1 ${tool.type !== 'follow' ? 'lg:grid-cols-3' : ''} gap-3`}>
        
        {/* Settings Column */}
        <div className={`${tool.type === 'follow' ? 'col-span-1' : 'lg:col-span-1'} space-y-6`}>
          <div className="desktop-card p-6">
            <div className="border border-black dark:border-white rounded-xl p-4 space-y-4">
            {tool.type === 'follow' && (
              <div className="flex items-center gap-3 mb-4">
                <Switch
                  checked={tool.enabled}
                  onCheckedChange={handleToggleEnable}
                  disabled={updateToolMutation.isPending}
                />
                <span className={`text-sm font-medium ${tool.enabled ? 'text-primary' : 'text-muted-foreground'}`}>
                  {tool.enabled ? 'ACTIVE' : 'STOPPED'}
                </span>
              </div>
            )}
            <div className="border-b border-border pb-3 mb-4">
              <h3 className="font-semibold text-lg">Follow Tool Settings</h3>
            </div>
            <div className="space-y-6">
              <div className="space-y-5">
                {/* Top row: Wait Until Next Session / Users Per Session / Delay After Follow */}
                <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
                  {tool.type === 'follow' && (
                    <>
                      <div className="space-y-2">
                        <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Wait Until Next Session (min)</h4>
                        <div className="flex items-center gap-2">
                          <div className="flex items-center gap-1.5">
                            <Label htmlFor="sessionWaitMin" className="text-xs whitespace-nowrap text-muted-foreground">Min</Label>
                            <Input id="sessionWaitMin" type="number" min="0" className="w-16 h-8 text-xs"
                              value={settings.delayMin}
                              onChange={(e) => setSettings({...settings, delayMin: Number(e.target.value)})}
                            />
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Label htmlFor="sessionWaitMax" className="text-xs whitespace-nowrap text-muted-foreground">Max</Label>
                            <Input id="sessionWaitMax" type="number" min="0" className="w-16 h-8 text-xs"
                              value={settings.delayMax}
                              onChange={(e) => setSettings({...settings, delayMax: Number(e.target.value)})}
                            />
                          </div>
                        </div>
                      </div>
                      <div className="w-px self-stretch bg-border/50 hidden sm:block" />
                    </>
                  )}

                  <div className="space-y-2">
                    <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Users Per Session</h4>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="processMin" className="text-xs whitespace-nowrap text-muted-foreground">Min</Label>
                        <Input id="processMin" type="number" className="w-16 h-8 text-xs"
                          value={settings.processMin}
                          onChange={(e) => setSettings({...settings, processMin: Number(e.target.value)})}
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="processMax" className="text-xs whitespace-nowrap text-muted-foreground">Max</Label>
                        <Input id="processMax" type="number" className="w-16 h-8 text-xs"
                          value={settings.processMax}
                          onChange={(e) => setSettings({...settings, processMax: Number(e.target.value)})}
                        />
                      </div>
                    </div>
                  </div>

                  {tool.type === 'follow' && (
                    <>
                      <div className="w-px self-stretch bg-border/50 hidden sm:block" />
                      <div className="space-y-2">
                        <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Delay After Follow (sec)</h4>
                        <div className="flex items-center gap-2">
                          <div className="flex items-center gap-1.5">
                            <Label htmlFor="delayAfterFollowMin" className="text-xs whitespace-nowrap text-muted-foreground">Min</Label>
                            <Input id="delayAfterFollowMin" type="number" min="0" className="w-16 h-8 text-xs"
                              value={settings.delayAfterFollowMin}
                              onChange={(e) => setSettings({...settings, delayAfterFollowMin: Number(e.target.value)})}
                            />
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Label htmlFor="delayAfterFollowMax" className="text-xs whitespace-nowrap text-muted-foreground">Max</Label>
                            <Input id="delayAfterFollowMax" type="number" min="0" className="w-16 h-8 text-xs"
                              value={settings.delayAfterFollowMax}
                              onChange={(e) => setSettings({...settings, delayAfterFollowMax: Number(e.target.value)})}
                            />
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </div>

                <div className="flex flex-wrap items-start gap-x-6 gap-y-4 pt-2 border-t border-border/50">
                  <div className="space-y-2">
                    <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Max Actions Per Day <span className="normal-case font-normal">(0 = ∞)</span></h4>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="maxPerDayMin" className="text-xs whitespace-nowrap text-muted-foreground">Min</Label>
                        <Input id="maxPerDayMin" type="number" className="w-16 h-8 text-xs"
                          value={settings.maxPerDayMin}
                          onChange={(e) => setSettings({...settings, maxPerDayMin: Number(e.target.value)})}
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="maxPerDayMax" className="text-xs whitespace-nowrap text-muted-foreground">Max</Label>
                        <Input id="maxPerDayMax" type="number" className="w-16 h-8 text-xs"
                          value={settings.maxPerDayMax}
                          onChange={(e) => setSettings({...settings, maxPerDayMax: Number(e.target.value)})}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="w-px self-stretch bg-border/50 hidden sm:block" />

                  <div className="space-y-2">
                    <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Scraper Control</h4>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="abortMin" className="text-xs whitespace-nowrap text-muted-foreground">Abort Min</Label>
                        <Input id="abortMin" type="number" className="w-16 h-8 text-xs"
                          value={settings.abortScrapeAfterMin}
                          onChange={(e) => setSettings({...settings, abortScrapeAfterMin: Number(e.target.value)})}
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="abortMax" className="text-xs whitespace-nowrap text-muted-foreground">Abort Max</Label>
                        <Input id="abortMax" type="number" className="w-16 h-8 text-xs"
                          value={settings.abortScrapeAfterMax}
                          onChange={(e) => setSettings({...settings, abortScrapeAfterMax: Number(e.target.value)})}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {tool.type === 'follow' && (
                <div className="pt-4 border-t border-border space-y-3">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="contextualActionsEnabled"
                      checked={!!(settings as any).contextualActionsEnabled}
                      onChange={(e) => setSettings({ ...settings, contextualActionsEnabled: e.target.checked } as any)}
                      className="w-3.5 h-3.5 accent-primary cursor-pointer"
                    />
                    <label htmlFor="contextualActionsEnabled" className="text-xs font-bold text-muted-foreground uppercase tracking-wider cursor-pointer select-none">
                      Follow via Contextual Actions
                    </label>
                  </div>
                  <div className={`space-y-3 transition-opacity ${!(settings as any).contextualActionsEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                      <div className="space-y-1.5">
                        <h4 className="text-xs text-muted-foreground">Follow</h4>
                        <div className="flex items-center gap-1.5">
                          <Input type="number" min="0" className="w-14 h-7 text-xs"
                            value={(settings as any).contextualActionsMin ?? 5}
                            onChange={(e) => setSettings({ ...settings, contextualActionsMin: Number(e.target.value) } as any)}
                          />
                          <span className="text-[10px] text-muted-foreground">–</span>
                          <Input type="number" min="0" className="w-14 h-7 text-xs"
                            value={(settings as any).contextualActionsMax ?? 5}
                            onChange={(e) => setSettings({ ...settings, contextualActionsMax: Number(e.target.value) } as any)}
                          />
                        </div>
                      </div>
                      <div className="w-px self-stretch bg-border/50 hidden sm:block" />
                      <div className="space-y-1.5">
                        <h4 className="text-xs text-muted-foreground">Delay between actions (sec)</h4>
                        <div className="flex items-center gap-1.5">
                          <Input type="number" min="0" className="w-14 h-7 text-xs"
                            value={(settings as any).contextualActionsDelayMin ?? 0}
                            onChange={(e) => setSettings({ ...settings, contextualActionsDelayMin: Number(e.target.value) } as any)}
                          />
                          <span className="text-[10px] text-muted-foreground">–</span>
                          <Input type="number" min="0" className="w-14 h-7 text-xs"
                            value={(settings as any).contextualActionsDelayMax ?? 1}
                            onChange={(e) => setSettings({ ...settings, contextualActionsDelayMax: Number(e.target.value) } as any)}
                          />
                        </div>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <h4 className="text-xs text-muted-foreground">Follow from discover page <span className="text-muted-foreground/60">(own suggested users)</span> percentage</h4>
                      <div className="flex items-center gap-1.5">
                        <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                          value={(settings as any).discoverPagePercentageMin ?? 100}
                          onChange={(e) => setSettings({ ...settings, discoverPagePercentageMin: Number(e.target.value) } as any)}
                        />
                        <span className="text-[10px] text-muted-foreground">–</span>
                        <Input type="number" min="0" max="100" className="w-14 h-7 text-xs"
                          value={(settings as any).discoverPagePercentageMax ?? 100}
                          onChange={(e) => setSettings({ ...settings, discoverPagePercentageMax: Number(e.target.value) } as any)}
                        />
                        <span className="text-[10px] text-muted-foreground">%</span>
                      </div>
                    </div>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      After every follow, also follow users from your discover page. The percentage controls how often this contextual follow is triggered.
                    </p>
                  </div>
                </div>
              )}

              {tool.type === 'unfollow' && (
                <div className="space-y-4 pt-4 border-t border-border">
                  <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Unfollow Settings</h4>
                  <div className="flex flex-wrap gap-x-6 gap-y-4">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Min Follow Age (days)</Label>
                      <Input type="number" className="w-24 h-8 text-xs"
                        value={(settings as any).minFollowAgeDays ?? 3}
                        onChange={(e) => setSettings({ ...settings, minFollowAgeDays: Number(e.target.value) } as any)}
                      />
                      <p className="text-[10px] text-muted-foreground">Only unfollow accounts followed at least this many days ago.</p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Delay after Unfollow (s)</Label>
                      <div className="flex items-center gap-1.5">
                        <Input type="number" className="w-16 h-8 text-xs"
                          value={(settings as any).delayAfterUnfollowMin ?? 5}
                          onChange={(e) => setSettings({ ...settings, delayAfterUnfollowMin: Number(e.target.value) } as any)}
                        />
                        <span className="text-[10px] text-muted-foreground">–</span>
                        <Input type="number" className="w-16 h-8 text-xs"
                          value={(settings as any).delayAfterUnfollowMax ?? 15}
                          onChange={(e) => setSettings({ ...settings, delayAfterUnfollowMax: Number(e.target.value) } as any)}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {tool.type === 'dm' && (
                <div className="space-y-4 pt-4 border-t border-border">
                  <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Outbound DM Messages</h4>
                  <div className="space-y-2">
                    <p className="text-[11px] text-muted-foreground">One message per line. Supports spintax: <code className="bg-muted px-1 rounded">{"{Hi|Hey} [FIRSTNAME]"}</code>. The engine picks one at random for each send.</p>
                    <textarea
                      className="flex min-h-[90px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      placeholder={"{Hi|Hey} there! Loved your content 🔥\n{Hello|Hey} [FIRSTNAME], check out our page!"}
                      value={(settings as any).dmMessages ?? ""}
                      onChange={(e) => setSettings({ ...settings, dmMessages: e.target.value } as any)}
                    />
                  </div>
                </div>
              )}

              {tool.type === 'dm' && (
                <div className="space-y-4 pt-4 border-t border-border">
                  <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Auto Reply Feature</h4>
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="autoReplyEnabled" className="text-xs font-medium">Enable Auto Reply</Label>
                      <Switch 
                        id="autoReplyEnabled" 
                        checked={settings.autoReplyEnabled} 
                        onCheckedChange={(val) => setSettings({...settings, autoReplyEnabled: val})}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="autoReplyTrigger" className="text-xs">Trigger Word (on reply)</Label>
                      <Input 
                        id="autoReplyTrigger" 
                        placeholder="e.g. price, info"
                        value={settings.autoReplyTrigger}
                        onChange={(e) => setSettings({...settings, autoReplyTrigger: e.target.value})}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="autoReplyMessage" className="text-xs">Reply Message</Label>
                      <div className="text-[10px] text-muted-foreground mb-1">
                        Supports spin tax: <code className="bg-muted px-1 rounded">{`{Hi|Hello}`}</code> and <code className="bg-muted px-1 rounded">[FIRSTNAME]</code>
                      </div>
                      <textarea 
                        id="autoReplyMessage" 
                        className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                        placeholder="e.g. {Hi|Hello} [FIRSTNAME], thanks for reaching out!"
                        value={settings.autoReplyMessage}
                        onChange={(e) => setSettings({...settings, autoReplyMessage: e.target.value})}
                      />
                    </div>
                  </div>
                </div>
              )}

              {tool.type === 'follow' && (
                <div className="pt-4 border-t border-border space-y-2">
                  <div className="flex items-center gap-2 mb-2">
                    <input
                      type="checkbox"
                      id="sessionActionVariationEnabled"
                      checked={!!(settings as any).sessionActionVariationEnabled}
                      onChange={(e) => setSettings({ ...settings, sessionActionVariationEnabled: e.target.checked } as any)}
                      className="w-3.5 h-3.5 accent-primary cursor-pointer"
                    />
                    <label htmlFor="sessionActionVariationEnabled" className="text-xs font-bold text-muted-foreground uppercase tracking-wider cursor-pointer select-none">
                      Session Action Variation
                    </label>
                  </div>
                  {/* 16-column grid: [label] [min–max] [min–max] [min–max] [min–max] [min–max] */}
                  <div
                    className={`grid items-center gap-x-1.5 gap-y-1.5 transition-opacity ${!(settings as any).sessionActionVariationEnabled ? 'opacity-40 pointer-events-none' : ''}`}
                    style={{ gridTemplateColumns: '5.5rem 1fr max-content 1fr 1fr max-content 1fr 1fr max-content 1fr 1fr max-content 1fr 1fr max-content 1fr' }}
                  >
                    {/* Header row */}
                    <span />
                    <span className="text-[10px] text-muted-foreground text-center col-span-3">Process</span>
                    <span className="text-[10px] text-muted-foreground text-center col-span-3">Delay (s)</span>
                    <span className="text-[10px] text-muted-foreground text-center col-span-3">Chance %</span>
                    <span className="text-[10px] text-muted-foreground text-center col-span-3">Before %</span>
                    <span className="text-[10px] text-muted-foreground text-center col-span-3">/day (0=∞)</span>
                    {/* Divider */}
                    <div className="border-b border-border/40 h-px" style={{ gridColumn: '1 / -1' }} />
                    {/* Data rows */}
                    <ActionVariationRow
                      label="Like Posts"
                      chanceMinKey="likeChanceMin" chanceMaxKey="likeChanceMax"
                      maxPerDayMinKey="likeMaxPerDayMin" maxPerDayMaxKey="likeMaxPerDayMax"
                      beforeMinKey="likeBeforeMin" beforeMaxKey="likeBeforeMax"
                      delayMinKey="likeDelayMin" delayMaxKey="likeDelayMax"
                      processMinKey="likeProcessMin" processMaxKey="likeProcessMax"
                    />
                    <ActionVariationRow
                      label="View Reels"
                      chanceMinKey="viewReelsChanceMin" chanceMaxKey="viewReelsChanceMax"
                      maxPerDayMinKey="viewReelsMaxPerDayMin" maxPerDayMaxKey="viewReelsMaxPerDayMax"
                      beforeMinKey="viewReelsBeforeMin" beforeMaxKey="viewReelsBeforeMax"
                      delayMinKey="viewReelsDelayMin" delayMaxKey="viewReelsDelayMax"
                      processMinKey="viewReelsProcessMin" processMaxKey="viewReelsProcessMax"
                    />
                    <ActionVariationRow
                      label="View Stories"
                      chanceMinKey="viewStoriesChanceMin" chanceMaxKey="viewStoriesChanceMax"
                      maxPerDayMinKey="viewStoriesMaxPerDayMin" maxPerDayMaxKey="viewStoriesMaxPerDayMax"
                      beforeMinKey="viewStoriesBeforeMin" beforeMaxKey="viewStoriesBeforeMax"
                      delayMinKey="viewStoriesDelayMin" delayMaxKey="viewStoriesDelayMax"
                      processMinKey="viewStoriesProcessMin" processMaxKey="viewStoriesProcessMax"
                    />
                    <ActionVariationRow
                      label="View Highlights"
                      chanceMinKey="viewHighlightsChanceMin" chanceMaxKey="viewHighlightsChanceMax"
                      maxPerDayMinKey="viewHighlightsMaxPerDayMin" maxPerDayMaxKey="viewHighlightsMaxPerDayMax"
                      beforeMinKey="viewHighlightsBeforeMin" beforeMaxKey="viewHighlightsBeforeMax"
                      delayMinKey="viewHighlightsDelayMin" delayMaxKey="viewHighlightsDelayMax"
                      processMinKey="viewHighlightsProcessMin" processMaxKey="viewHighlightsProcessMax"
                    />
                  </div>
                </div>
              )}

              {/* ── Filters ─────────────────────────────────────────── */}
              {tool.type === 'follow' && (
                <div className="mt-4 border border-border rounded-xl p-4 space-y-3">
                  <h4 className="text-sm font-bold flex items-center gap-2">
                    <ListFilter className="w-4 h-4 text-primary" /> Filters
                  </h4>
                  <p className="text-[11px] text-muted-foreground">
                    Users who match an enabled filter are skipped and added to the global skip list.
                  </p>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">Skip Indian Users</p>
                      <p className="text-[11px] text-muted-foreground">Fetches the user's name and bio and skips if any Indic script characters are found in either (Devanagari, Bengali, Tamil, Telugu, Kannada, Malayalam, etc.).</p>
                    </div>
                    <Switch
                      checked={!!(settings as any).skipIndianUsers}
                      onCheckedChange={(v) => setSettings({ ...settings, skipIndianUsers: v } as any)}
                      className="data-[state=checked]:bg-green-500 ml-4 shrink-0"
                    />
                  </div>
                </div>
              )}
            </div>

              {/* ── Human Session Tools ─────────────────────────────── */}
              {!hideHumanSession && tool.type === 'follow' && (
                <div className="border border-black dark:border-white rounded-xl p-4 space-y-4">
                <div className="flex items-center gap-3 px-1">
                  <Switch
                    checked={!!(settings as any).humanToolsEnabled}
                    onCheckedChange={(v) => setSettings({ ...settings, humanToolsEnabled: v } as any)}
                  />
                  <div>
                    <p className="text-sm font-semibold">Human Session Tools</p>
                    <p className="text-[11px] text-muted-foreground">Enable the timer and tools below to simulate human behaviour.</p>
                  </div>
                </div>

                {/* ── Human Session Tools Timer ───────────────────────── */}
                <div className="border border-border rounded-xl p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="font-semibold text-sm">Human Session Tools Timer</h4>
                      <p className="text-[11px] text-muted-foreground mt-0.5">How often the tools below run, independent of the follow session timer.</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Every (min)</span>
                      <div className="flex items-center gap-1.5">
                        <Label className="text-xs text-muted-foreground">Min</Label>
                        <Input type="number" min="1" max="10000" className="w-16 h-7 text-xs"
                          value={(settings as any).humanToolsDelayMin ?? 30}
                          onChange={(e) => setSettings({ ...settings, humanToolsDelayMin: Math.max(1, Number(e.target.value)) } as any)}
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Label className="text-xs text-muted-foreground">Max</Label>
                        <Input type="number" min="1" max="10000" className="w-16 h-7 text-xs"
                          value={(settings as any).humanToolsDelayMax ?? 60}
                          onChange={(e) => setSettings({ ...settings, humanToolsDelayMax: Math.max(1, Number(e.target.value)) } as any)}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* ── View Timeline Feed ──────────────────────────────── */}
                <div className="border border-border rounded-xl p-4 space-y-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2 pt-0.5">
                      <input type="checkbox" id="viewTimelineFeedEnabled"
                        checked={!!(settings as any).viewTimelineFeedEnabled}
                        onChange={(e) => setSettings({ ...settings, viewTimelineFeedEnabled: e.target.checked } as any)}
                        className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                      />
                      <label htmlFor="viewTimelineFeedEnabled" className="font-semibold text-sm cursor-pointer select-none">View Timeline Feed</label>
                    </div>
                    <div className={`flex flex-col items-end gap-1.5 transition-opacity ${!(settings as any).viewTimelineFeedEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Execution Order</span>
                        <div className="flex items-center gap-1.5">
                          <Label className="text-xs text-muted-foreground">Min</Label>
                          <div className="relative">
                            <Input type="number" min="0" max="100" className="w-14 h-7 text-xs pr-5"
                              value={(settings as any).viewTimelineFeedOrderMin ?? 5}
                              onChange={(e) => setSettings({ ...settings, viewTimelineFeedOrderMin: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                            />
                            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Label className="text-xs text-muted-foreground">Max</Label>
                          <div className="relative">
                            <Input type="number" min="0" max="100" className="w-14 h-7 text-xs pr-5"
                              value={(settings as any).viewTimelineFeedOrderMax ?? 10}
                              onChange={(e) => setSettings({ ...settings, viewTimelineFeedOrderMax: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                            />
                            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Not Used</span>
                        <div className="flex items-center gap-1.5">
                          <Label className="text-xs text-muted-foreground">Min</Label>
                          <div className="relative">
                            <Input type="number" min="0" max="100" className="w-14 h-7 text-xs pr-5"
                              value={(settings as any).viewTimelineFeedNotUsedMin ?? 0}
                              onChange={(e) => setSettings({ ...settings, viewTimelineFeedNotUsedMin: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                            />
                            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Label className="text-xs text-muted-foreground">Max</Label>
                          <div className="relative">
                            <Input type="number" min="0" max="100" className="w-14 h-7 text-xs pr-5"
                              value={(settings as any).viewTimelineFeedNotUsedMax ?? 0}
                              onChange={(e) => setSettings({ ...settings, viewTimelineFeedNotUsedMax: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                            />
                            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className={`flex items-center gap-4 transition-opacity ${!(settings as any).viewTimelineFeedEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Posts to View</span>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5">
                        <Label className="text-xs text-muted-foreground">Min</Label>
                        <Input type="number" min="1" max="100" className="w-16 h-7 text-xs"
                          value={(settings as any).viewTimelineFeedMin ?? 3}
                          onChange={(e) => setSettings({ ...settings, viewTimelineFeedMin: Math.max(1, Number(e.target.value)) } as any)}
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Label className="text-xs text-muted-foreground">Max</Label>
                        <Input type="number" min="1" max="100" className="w-16 h-7 text-xs"
                          value={(settings as any).viewTimelineFeedMax ?? 8}
                          onChange={(e) => setSettings({ ...settings, viewTimelineFeedMax: Math.max(1, Number(e.target.value)) } as any)}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* ── Reusable execution-order-only row ───────────────── */}
                {/* Visit Notifications */}
                {(() => {
                const pctInputs = (minKey: string, maxKey: string) => (
                  <>
                    <div className="flex items-center gap-1.5">
                      <Label className="text-xs text-muted-foreground">Min</Label>
                      <div className="relative">
                        <Input type="number" min="0" max="100" className="w-14 h-7 text-xs pr-5"
                          value={(settings as any)[minKey] ?? 0}
                          onChange={(e) => setSettings({ ...settings, [minKey]: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                        />
                        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Label className="text-xs text-muted-foreground">Max</Label>
                      <div className="relative">
                        <Input type="number" min="0" max="100" className="w-14 h-7 text-xs pr-5"
                          value={(settings as any)[maxKey] ?? 0}
                          onChange={(e) => setSettings({ ...settings, [maxKey]: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                        />
                        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                      </div>
                    </div>
                  </>
                );
                return (
                  <div className="border border-border rounded-xl p-4 space-y-3">
                    <div className="flex items-start justify-between">
                      <div className="flex flex-col gap-2 pt-0.5">
                        <div className="flex items-center gap-2">
                          <input type="checkbox" id="humanSessionEnabled"
                            checked={!!(settings as any).humanSessionEnabled}
                            onChange={(e) => setSettings({ ...settings, humanSessionEnabled: e.target.checked } as any)}
                            className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                          />
                          <label htmlFor="humanSessionEnabled" className="font-semibold text-sm flex items-center gap-2 cursor-pointer select-none">
                            <User className="w-4 h-4 text-violet-500" />
                            Human Session
                          </label>
                        </div>
                        <div className={`flex items-center gap-1.5 flex-wrap transition-opacity ${!(settings as any).humanSessionEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                          <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-orange-50 border border-orange-200 text-orange-600 font-medium"><Bell className="w-3 h-3" />Notifications</span>
                          <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-indigo-50 border border-indigo-200 text-indigo-600 font-medium"><User className="w-3 h-3" />Own Profile</span>
                          <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-cyan-50 border border-cyan-200 text-cyan-600 font-medium"><RefreshCw className="w-3 h-3" />Refresh Profile</span>
                          <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-gray-50 border border-gray-200 text-gray-600 font-medium"><Settings className="w-3 h-3" />Settings & Activity</span>
                        </div>
                      </div>
                      <div className={`flex flex-col items-end gap-1.5 transition-opacity ${!(settings as any).humanSessionEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Execution Order</span>
                          {pctInputs("humanSessionOrderMin", "humanSessionOrderMax")}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Not Used</span>
                          {pctInputs("humanSessionNotUsedMin", "humanSessionNotUsedMax")}
                        </div>
                      </div>
                    </div>
                    <p className={`text-[11px] text-muted-foreground transition-opacity ${!(settings as any).humanSessionEnabled ? 'opacity-40' : ''}`}>
                      Runs all four sub-actions in a random order each session: visits the notification inbox, browses the account's own profile, pull-to-refreshes it, and opens Settings &amp; Activity. Set execution order &gt; 0% to enable.
                    </p>
                  </div>
                );
              })()}

                {/* ── Check Reels from Timeline ───────────────────────── */}
                <div className="border border-border rounded-xl p-4 space-y-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2 pt-0.5">
                      <input type="checkbox" id="checkTimelineReelsEnabled"
                        checked={!!(settings as any).checkTimelineReelsEnabled}
                        onChange={(e) => setSettings({ ...settings, checkTimelineReelsEnabled: e.target.checked } as any)}
                        className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                      />
                      <label htmlFor="checkTimelineReelsEnabled" className="font-semibold text-sm flex items-center gap-2 cursor-pointer select-none">
                        <PlaySquare className="w-4 h-4 text-rose-500" />
                        Check Reels from Timeline
                      </label>
                    </div>
                    <div className={`flex flex-col items-end gap-1.5 transition-opacity ${!(settings as any).checkTimelineReelsEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Execution Order</span>
                        <div className="flex items-center gap-1.5">
                          <Label className="text-xs text-muted-foreground">Min</Label>
                          <div className="relative">
                            <Input type="number" min="0" max="100" className="w-14 h-7 text-xs pr-5"
                              value={(settings as any).checkTimelineReelsOrderMin ?? 0}
                              onChange={(e) => setSettings({ ...settings, checkTimelineReelsOrderMin: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                            />
                            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Label className="text-xs text-muted-foreground">Max</Label>
                          <div className="relative">
                            <Input type="number" min="0" max="100" className="w-14 h-7 text-xs pr-5"
                              value={(settings as any).checkTimelineReelsOrderMax ?? 0}
                              onChange={(e) => setSettings({ ...settings, checkTimelineReelsOrderMax: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                            />
                            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Not Used</span>
                        <div className="flex items-center gap-1.5">
                          <Label className="text-xs text-muted-foreground">Min</Label>
                          <div className="relative">
                            <Input type="number" min="0" max="100" className="w-14 h-7 text-xs pr-5"
                              value={(settings as any).checkTimelineReelsNotUsedMin ?? 0}
                              onChange={(e) => setSettings({ ...settings, checkTimelineReelsNotUsedMin: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                            />
                            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Label className="text-xs text-muted-foreground">Max</Label>
                          <div className="relative">
                            <Input type="number" min="0" max="100" className="w-14 h-7 text-xs pr-5"
                              value={(settings as any).checkTimelineReelsNotUsedMax ?? 0}
                              onChange={(e) => setSettings({ ...settings, checkTimelineReelsNotUsedMax: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                            />
                            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <p className={`text-[11px] text-muted-foreground transition-opacity ${!(settings as any).checkTimelineReelsEnabled ? 'opacity-40' : ''}`}>
                    Scrolls through the Reels tab feed and marks reels as watched. Set execution order &gt; 0% to enable.
                  </p>
                  <div className={`flex items-center gap-4 transition-opacity ${!(settings as any).checkTimelineReelsEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Reels to Watch</span>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5">
                        <Label className="text-xs text-muted-foreground">Min</Label>
                        <Input
                          type="number" min="1" max="50" className="w-16 h-7 text-xs"
                          value={(settings as any).checkTimelineReelsMin ?? 3}
                          onChange={(e) => setSettings({ ...settings, checkTimelineReelsMin: Math.max(1, Number(e.target.value)) } as any)}
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Label className="text-xs text-muted-foreground">Max</Label>
                        <Input
                          type="number" min="1" max="50" className="w-16 h-7 text-xs"
                          value={(settings as any).checkTimelineReelsMax ?? 8}
                          onChange={(e) => setSettings({ ...settings, checkTimelineReelsMax: Math.max(1, Number(e.target.value)) } as any)}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* ── Check Stories from Timeline ─────────────────────── */}
                <div className="border border-border rounded-xl p-4 space-y-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2 pt-0.5">
                      <input type="checkbox" id="checkTimelineStoriesEnabled"
                        checked={!!(settings as any).checkTimelineStoriesEnabled}
                        onChange={(e) => setSettings({ ...settings, checkTimelineStoriesEnabled: e.target.checked } as any)}
                        className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                      />
                      <label htmlFor="checkTimelineStoriesEnabled" className="font-semibold text-sm flex items-center gap-2 cursor-pointer select-none">
                        <BookOpen className="w-4 h-4 text-sky-500" />
                        Check Stories from Timeline
                      </label>
                    </div>
                    <div className={`flex flex-col items-end gap-1.5 transition-opacity ${!(settings as any).checkTimelineStoriesEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Execution Order</span>
                        <div className="flex items-center gap-1.5">
                          <Label className="text-xs text-muted-foreground">Min</Label>
                          <div className="relative">
                            <Input type="number" min="0" max="100" className="w-14 h-7 text-xs pr-5"
                              value={(settings as any).checkTimelineStoriesOrderMin ?? 0}
                              onChange={(e) => setSettings({ ...settings, checkTimelineStoriesOrderMin: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                            />
                            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Label className="text-xs text-muted-foreground">Max</Label>
                          <div className="relative">
                            <Input type="number" min="0" max="100" className="w-14 h-7 text-xs pr-5"
                              value={(settings as any).checkTimelineStoriesOrderMax ?? 0}
                              onChange={(e) => setSettings({ ...settings, checkTimelineStoriesOrderMax: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                            />
                            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Not Used</span>
                        <div className="flex items-center gap-1.5">
                          <Label className="text-xs text-muted-foreground">Min</Label>
                          <div className="relative">
                            <Input type="number" min="0" max="100" className="w-14 h-7 text-xs pr-5"
                              value={(settings as any).checkTimelineStoriesNotUsedMin ?? 0}
                              onChange={(e) => setSettings({ ...settings, checkTimelineStoriesNotUsedMin: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                            />
                            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Label className="text-xs text-muted-foreground">Max</Label>
                          <div className="relative">
                            <Input type="number" min="0" max="100" className="w-14 h-7 text-xs pr-5"
                              value={(settings as any).checkTimelineStoriesNotUsedMax ?? 0}
                              onChange={(e) => setSettings({ ...settings, checkTimelineStoriesNotUsedMax: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                            />
                            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <p className={`text-[11px] text-muted-foreground transition-opacity ${!(settings as any).checkTimelineStoriesEnabled ? 'opacity-40' : ''}`}>
                    Watches stories from the top of Instagram's home feed tray. Set execution order &gt; 0% to enable.
                  </p>
                  <div className={`flex items-center gap-4 transition-opacity ${!(settings as any).checkTimelineStoriesEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Stories to Watch</span>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5">
                        <Label className="text-xs text-muted-foreground">Min</Label>
                        <Input
                          type="number" min="1" max="50" className="w-16 h-7 text-xs"
                          value={(settings as any).checkTimelineStoriesMin ?? 3}
                          onChange={(e) => setSettings({ ...settings, checkTimelineStoriesMin: Math.max(1, Number(e.target.value)) } as any)}
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Label className="text-xs text-muted-foreground">Max</Label>
                        <Input
                          type="number" min="1" max="50" className="w-16 h-7 text-xs"
                          value={(settings as any).checkTimelineStoriesMax ?? 8}
                          onChange={(e) => setSettings({ ...settings, checkTimelineStoriesMax: Math.max(1, Number(e.target.value)) } as any)}
                        />
                      </div>
                    </div>
                  </div>
                </div>
                {/* ── Check Direct Messages ───────────────────────────── */}
                <div className="border border-border rounded-xl p-4 space-y-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2 pt-0.5">
                      <input type="checkbox" id="checkDmEnabled"
                        checked={!!(settings as any).checkDmEnabled}
                        onChange={(e) => setSettings({ ...settings, checkDmEnabled: e.target.checked } as any)}
                        className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                      />
                      <label htmlFor="checkDmEnabled" className="font-semibold text-sm flex items-center gap-2 cursor-pointer select-none">
                        <MessageSquare className="w-4 h-4 text-teal-500" />
                        Check Direct Messages
                      </label>
                    </div>
                    <div className={`flex flex-col items-end gap-1.5 transition-opacity ${!(settings as any).checkDmEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Execution Order</span>
                        <div className="flex items-center gap-1.5">
                          <Label className="text-xs text-muted-foreground">Min</Label>
                          <div className="relative">
                            <Input type="number" min="0" max="100" className="w-14 h-7 text-xs pr-5"
                              value={(settings as any).checkDmOrderMin ?? 0}
                              onChange={(e) => setSettings({ ...settings, checkDmOrderMin: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                            />
                            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Label className="text-xs text-muted-foreground">Max</Label>
                          <div className="relative">
                            <Input type="number" min="0" max="100" className="w-14 h-7 text-xs pr-5"
                              value={(settings as any).checkDmOrderMax ?? 0}
                              onChange={(e) => setSettings({ ...settings, checkDmOrderMax: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                            />
                            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Not Used</span>
                        <div className="flex items-center gap-1.5">
                          <Label className="text-xs text-muted-foreground">Min</Label>
                          <div className="relative">
                            <Input type="number" min="0" max="100" className="w-14 h-7 text-xs pr-5"
                              value={(settings as any).checkDmNotUsedMin ?? 0}
                              onChange={(e) => setSettings({ ...settings, checkDmNotUsedMin: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                            />
                            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Label className="text-xs text-muted-foreground">Max</Label>
                          <div className="relative">
                            <Input type="number" min="0" max="100" className="w-14 h-7 text-xs pr-5"
                              value={(settings as any).checkDmNotUsedMax ?? 0}
                              onChange={(e) => setSettings({ ...settings, checkDmNotUsedMax: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                            />
                            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <p className={`text-[11px] text-muted-foreground transition-opacity ${!(settings as any).checkDmEnabled ? 'opacity-40' : ''}`}>
                    Calls <code className="bg-muted px-1 rounded text-[10px]">getDirectMessagesInternal</code> to simulate checking the inbox. Set execution order &gt; 0% to enable.
                  </p>
                  <div className={`flex items-center gap-4 transition-opacity ${!(settings as any).checkDmEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">DMs to Check</span>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5">
                        <Label className="text-xs text-muted-foreground">Min</Label>
                        <Input
                          type="number" min="1" max="100" className="w-16 h-7 text-xs"
                          value={(settings as any).checkDmMin ?? 5}
                          onChange={(e) => setSettings({ ...settings, checkDmMin: Math.max(1, Number(e.target.value)) } as any)}
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Label className="text-xs text-muted-foreground">Max</Label>
                        <Input
                          type="number" min="1" max="100" className="w-16 h-7 text-xs"
                          value={(settings as any).checkDmMax ?? 15}
                          onChange={(e) => setSettings({ ...settings, checkDmMax: Math.max(1, Number(e.target.value)) } as any)}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* ── Repost Feature ──────────────────────────────────── */}
                <div className="border border-border rounded-xl p-4 space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-center gap-2 pt-0.5">
                      <input type="checkbox" id="repostEnabled"
                        checked={!!(settings as any).repostEnabled}
                        onChange={(e) => setSettings({ ...settings, repostEnabled: e.target.checked } as any)}
                        className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                      />
                      <label htmlFor="repostEnabled" className="font-semibold text-sm flex items-center gap-2 cursor-pointer select-none">
                        <Repeat2 className="w-4 h-4 text-green-500" />
                        Repost
                      </label>
                    </div>
                    <div className={`flex flex-col items-end gap-1.5 transition-opacity ${!(settings as any).repostEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Execution Order</span>
                        <div className="flex items-center gap-1.5">
                          <Label className="text-xs text-muted-foreground">Min</Label>
                          <div className="relative">
                            <Input type="number" min="0" max="100" className="w-14 h-7 text-xs pr-5"
                              value={(settings as any).repostOrderMin ?? 0}
                              onChange={(e) => setSettings({ ...settings, repostOrderMin: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                            />
                            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Label className="text-xs text-muted-foreground">Max</Label>
                          <div className="relative">
                            <Input type="number" min="0" max="100" className="w-14 h-7 text-xs pr-5"
                              value={(settings as any).repostOrderMax ?? 0}
                              onChange={(e) => setSettings({ ...settings, repostOrderMax: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                            />
                            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Run Chance</span>
                        <div className="flex items-center gap-1.5">
                          <Label className="text-xs text-muted-foreground">Min</Label>
                          <div className="relative">
                            <Input type="number" min="0" max="100" className="w-14 h-7 text-xs pr-5"
                              value={(settings as any).repostNotUsedMin ?? 0}
                              onChange={(e) => setSettings({ ...settings, repostNotUsedMin: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                            />
                            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Label className="text-xs text-muted-foreground">Max</Label>
                          <div className="relative">
                            <Input type="number" min="0" max="100" className="w-14 h-7 text-xs pr-5"
                              value={(settings as any).repostNotUsedMax ?? 0}
                              onChange={(e) => setSettings({ ...settings, repostNotUsedMax: Math.min(100, Math.max(0, Number(e.target.value))) } as any)}
                            />
                            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className={`space-y-3 transition-opacity ${!(settings as any).repostEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                    {/* Source username */}
                    <div className="flex flex-wrap items-end gap-4">
                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">Repost from account <span className="text-muted-foreground/60">(without @)</span></Label>
                        <div className="relative max-w-[220px]">
                          <AtSign className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                          <Input
                            type="text"
                            placeholder="username"
                            className="h-8 text-xs pl-7"
                            value={(settings as any).repostSourceUsername ?? ""}
                            onChange={(e) => setSettings({ ...settings, repostSourceUsername: e.target.value.replace(/^@/, '') } as any)}
                          />
                        </div>
                      </div>

                      {/* Disable at post count */}
                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">Disable when my posts reach <span className="text-muted-foreground/60">(0 = off)</span></Label>
                        <Input
                          type="number" min="0" className="w-20 h-8 text-xs"
                          value={(settings as any).repostDisableAtPostCount ?? 0}
                          onChange={(e) => setSettings({ ...settings, repostDisableAtPostCount: Math.max(0, Number(e.target.value)) } as any)}
                        />
                      </div>
                    </div>

                    {/* Auto-disable when exhausted */}
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id="repostDisableWhenExhausted"
                        checked={!!(settings as any).repostDisableWhenExhausted}
                        onChange={(e) => setSettings({ ...settings, repostDisableWhenExhausted: e.target.checked } as any)}
                        className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                      />
                      <label htmlFor="repostDisableWhenExhausted" className="text-xs text-muted-foreground cursor-pointer select-none">
                        Auto-disable when no more unique posts are found from the source account
                      </label>
                    </div>

                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      During each session, picks the latest unreposted post from the source account and reposts it with the original caption.
                      <br />
                      <strong>Disable at post count</strong> reads the post count from this profile's Instagram bio to stop reposting once the goal is reached.
                      Reposted history is tracked in the <strong>Reposted</strong> tab to prevent duplicates.
                    </p>
                  </div>
                </div>

                </div>
              )}

              <Button
                variant="outline"
                className="w-full mt-4 gap-2"
                onClick={() => setShowCopyModal(true)}
              >
                <Copy className="w-3.5 h-3.5" /> Copy Configuration
              </Button>
          </div>
        </div>

        {/* Sources Column — hidden for follow tool (sources are above the toggle) */}
        {tool.type !== 'follow' && (
        <div className="lg:col-span-2 space-y-6">
          <div className="desktop-card p-6">
            <h3 className="font-semibold text-lg border-b border-border pb-3 mb-4">Target Sources</h3>
            
            <div className="flex gap-3 mb-6 flex-wrap">
              <form onSubmit={handleAddSource} className="flex gap-3 flex-1 min-w-0">
                <select 
                  className="h-10 rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 shrink-0"
                  value={newSourceType}
                  onChange={(e) => setNewSourceType(e.target.value as any)}
                >
                  <option value="hashtag">Hashtag</option>
                  <option value="target_followers">Followers of Account</option>
                </select>
                <Input 
                  placeholder={newSourceType === 'hashtag' ? "e.g. #photography" : "e.g. @natgeo"} 
                  value={newSourceValue}
                  onChange={(e) => setNewSourceValue(e.target.value)}
                  className="flex-1"
                />
                <Button type="submit" disabled={createSourceMutation.isPending || !newSourceValue.trim()}>
                  <Plus className="w-4 h-4 mr-2" /> Add
                </Button>
              </form>
              <Button
                type="button"
                variant="outline"
                disabled={importSourcesMutation.isPending}
                onClick={() => importFileRef.current?.click()}
              >
                <Upload className="w-4 h-4 mr-2" />
                {importSourcesMutation.isPending ? 'Importing…' : 'Import'}
              </Button>
              <Button type="button" variant="outline" onClick={handleExport}>
                <Download className="w-4 h-4 mr-2" /> Export
              </Button>
            </div>

            <div className="space-y-2">
              {sourcesLoading ? (
                <div className="text-center py-8 text-muted-foreground text-sm">Loading sources...</div>
              ) : sources?.length === 0 ? (
                <div className="text-center py-12 bg-accent/50 rounded-lg border border-border/50 border-dashed">
                  <p className="text-muted-foreground text-sm">No sources added yet.</p>
                  <p className="text-xs text-muted-foreground mt-1">Add targets above to start automating.</p>
                </div>
              ) : (
                sources?.map(source => (
                  <div key={source.id} className="flex items-center justify-between p-3 rounded-lg border border-border bg-background hover:bg-accent/30 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded bg-primary/10 flex items-center justify-center text-primary shrink-0">
                        {source.type === 'hashtag' ? <Hash className="w-4 h-4" /> : <Users className="w-4 h-4" />}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{source.type === 'hashtag' ? `#${source.value}` : source.value}</p>
                        <div className="flex items-center gap-2 flex-wrap">
                          {source.rank != null && (
                            <span className="text-[10px] font-semibold text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                              Rank {source.rank}/1000
                            </span>
                          )}
                          {source.nrPosts != null && (
                            <span className="text-[10px] text-muted-foreground">
                              {source.nrPosts >= 1_000_000
                                ? `${(source.nrPosts / 1_000_000).toFixed(1)}M`
                                : source.nrPosts >= 1_000
                                ? `${(source.nrPosts / 1_000).toFixed(0)}K`
                                : source.nrPosts} posts
                            </span>
                          )}
                          {source.rank == null && source.nrPosts == null && (
                            <span className="text-xs text-muted-foreground capitalize">{source.type.replace('_', ' ')}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      onClick={() => deleteSourceMutation.mutate({ id: source.id, toolId: tool.id })}
                      disabled={deleteSourceMutation.isPending}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
        )}

      </div>

      {showCopyModal && (
        <div className="fixed inset-0 z-[500] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowCopyModal(false)} />
          <div className="relative bg-background border border-border rounded-xl shadow-2xl w-full max-w-md flex flex-col" style={{ maxHeight: "80vh" }}>
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div>
                <h2 className="font-semibold text-base">Copy Configuration</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Select profiles to copy these settings to</p>
              </div>
              <button onClick={() => setShowCopyModal(false)} className="text-muted-foreground hover:text-foreground p-1 rounded">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Select All / None */}
            <div className="flex items-center gap-3 px-5 py-2 border-b border-border/50 bg-muted/10">
              <button
                className="text-xs text-primary hover:underline font-medium"
                onClick={() => setSelectedProfileIds(new Set(otherProfiles.map(p => p.id)))}
              >Select All</button>
              <span className="text-muted-foreground text-xs">·</span>
              <button
                className="text-xs text-muted-foreground hover:underline"
                onClick={() => setSelectedProfileIds(new Set())}
              >Select None</button>
              <span className="ml-auto text-xs text-muted-foreground">{selectedProfileIds.size} selected</span>
            </div>

            {/* Profile list */}
            <div className="overflow-y-auto flex-1 px-2 py-2">
              {otherProfiles.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No other profiles found.</p>
              ) : (
                otherProfiles.map(profile => (
                  <label
                    key={profile.id}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-accent/40 cursor-pointer transition-colors"
                  >
                    <input
                      type="checkbox"
                      className="w-4 h-4 accent-primary"
                      checked={selectedProfileIds.has(profile.id)}
                      onChange={() => toggleProfile(profile.id)}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{profile.username}</p>
                      {profile.tags && <p className="text-xs text-muted-foreground truncate">{profile.tags}</p>}
                    </div>
                    {selectedProfileIds.has(profile.id) && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
                  </label>
                ))
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center gap-3 px-5 py-4 border-t border-border">
              <Button variant="outline" className="flex-1" onClick={() => setShowCopyModal(false)}>
                Cancel
              </Button>
              <Button
                className="flex-1 gap-2"
                disabled={selectedProfileIds.size === 0 || copying}
                onClick={handleCopyConfig}
              >
                {copying ? "Copying..." : <><Copy className="w-3.5 h-3.5" /> Copy to {selectedProfileIds.size} Profile{selectedProfileIds.size !== 1 ? "s" : ""}</>}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  </div>
  );
}
