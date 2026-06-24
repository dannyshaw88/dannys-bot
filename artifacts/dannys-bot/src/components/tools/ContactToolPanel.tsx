import { useState } from "react";
import { type Tool, type Profile } from "@shared/schema";

import { ContactNewFollowersPanel } from "./ContactNewFollowersPanel";
import { ContactUsersPanel } from "./ContactUsersPanel";
import { AutoReplyPanel } from "./AutoReplyPanel";
import { CopySettingsDialog, type CopyOptionGroup } from "@/components/tools/CopySettingsDialog";
import { copyToolSettingsToProfiles } from "@/lib/copyToolSettings";
import { useProfiles } from "@/hooks/use-profiles";
import { useToast } from "@/hooks/use-toast";

interface Props {
  tool: Tool;
  profile: Profile;
  copyOpen?: boolean;
  onCopyOpenChange?: (v: boolean) => void;
  embedded?: boolean;
  overrideProfiles?: Profile[];
}

const RANDOMISE_DESC = "Spread each account's session start times across the wait window so they don't all fire simultaneously";

const CONTACT_COPY_GROUPS: CopyOptionGroup[] = [
  { label: "Contact New Followers", options: [
    { key: "ct_newFollowers", label: "Contact New Followers", description: "Auto-messaging settings for new followers", subOptions: [
      { key: "ct_newFollowersStartStop", label: "Start / Stop",                          settingKeys: ["contactNewFollowersEnabled"] },
      { key: "ct_newFollowersRandomise", label: "Randomise timing",                      description: RANDOMISE_DESC, settingKeys: ["__randomiseTiming__"] },
      { key: "ct_onlyApp",               label: "Only app-followed users",               settingKeys: ["contactOnlyAppFollowed"] },
      { key: "ct_message",               label: "Message template",                      settingKeys: ["contactMessage"] },
      { key: "ct_interval",              label: "Check interval",       settingKeys: ["contactCheckIntervalMin","contactCheckIntervalMax"] },
      { key: "ct_perCheck",              label: "Users per check",           settingKeys: ["contactUsersPerCheckMin","contactUsersPerCheckMax"] },
      { key: "ct_apiSource",             label: "API source",                            settingKeys: ["contactApiSource"] },
    ]},
  ]},
  { label: "Contact Users", options: [
    { key: "ct_users", label: "Contact Users", description: "Settings for the manual user contact list", subOptions: [
      { key: "ct_usersStartStop",      label: "Start / Stop",                              settingKeys: ["contactUsersEnabled"] },
      { key: "ct_usersRandomise",      label: "Randomise timing",                          description: RANDOMISE_DESC, settingKeys: ["__randomiseTiming__"] },
      { key: "ct_usersWait",           label: "Wait between sessions",    settingKeys: ["contactUsersWaitMin","contactUsersWaitMax"] },
      { key: "ct_usersSendCount",      label: "Send count per session",        settingKeys: ["contactUsersSendCountMin","contactUsersSendCountMax"] },
      { key: "ct_usersDelay",          label: "Delay between messages",   settingKeys: ["contactUsersDelayBetweenMin","contactUsersDelayBetweenMax"] },
      { key: "ct_usersPickRandom",     label: "Pick users randomly",                       settingKeys: ["contactUsersPickRandom"] },
      { key: "ct_usersUnsend",         label: "Unsend settings",                           settingKeys: ["contactUsersUnsendEnabled","contactUsersUnsendMin","contactUsersUnsendMax"] },
    ]},
  ]},
  { label: "Auto Reply", options: [
    { key: "ct_autoReply", label: "Auto Reply", description: "Auto-respond to incoming messages", subOptions: [
      { key: "ct_arEnabled", label: "Start / Stop", settingKeys: ["autoReplyEnabled"] },
      { key: "ct_arRules",   label: "Reply rules",  settingKeys: ["autoReplies"] },
    ]},
  ]},
  { label: "Stop if Blocked", options: [
    { key: "ct_stopOnBlock", label: "Stop if Blocked", description: "Pause the tool for a set time when Instagram blocks a contact action", subOptions: [
      { key: "ct_stopOnBlockEnabled", label: "Enabled",              settingKeys: ["stopOnBlockEnabled"] },
      { key: "ct_stopOnBlockMinutes", label: "Stop duration", settingKeys: ["stopOnBlockMinutes"] },
    ]},
  ]},
];

export function ContactToolPanel({ tool, profile, copyOpen: copyOpenProp, onCopyOpenChange, embedded, overrideProfiles }: Props) {
  const [copyOpen, _setCopyOpen] = useState(false);
  const _copyOpen = copyOpenProp ?? copyOpen;
  const _setCopyOpenFn = onCopyOpenChange ?? _setCopyOpen;
  const { data: allProfiles = [] } = useProfiles();
  const { toast } = useToast();
  const otherProfiles = overrideProfiles ?? allProfiles.filter(p => p.id !== tool.profileId && !p.locked && !p.isTemplate);

  const START_STOP_KEYS = ["contactNewFollowersEnabled", "contactUsersEnabled", "autoReplyEnabled"];

  const handleContactCopy = async (targetIds: number[], expandedKeys: string[]) => {
    const src = (tool.settings as Record<string, unknown>) ?? {};
    const willRandomise = expandedKeys.includes("__randomiseTiming__");
    const realKeys = expandedKeys.filter(k => k !== "__randomiseTiming__");
    let staggerOffsets: number[] | undefined;
    if (willRandomise && targetIds.length > 1) {
      const delayMax = (src as any).contactUsersDelayMax ?? (src as any).delayMax ?? 60;
      staggerOffsets = targetIds.map((_, i) =>
        Math.round((i * delayMax) / Math.max(1, targetIds.length - 1))
      );
    }
    await copyToolSettingsToProfiles(src, tool.type, targetIds, realKeys, undefined, staggerOffsets);
    const hasStartStop = realKeys.some(k => START_STOP_KEYS.includes(k));
    if (hasStartStop) {
      await Promise.all(targetIds.map(async (targetProfileId) => {
        try {
          const res = await fetch(`/api/profiles/${targetProfileId}/tools`, { credentials: "include" });
          if (!res.ok) return;
          const tools: Array<{ id: number; type: string; enabled: boolean }> = await res.json();
          const targetTool = tools.find(t => t.type === tool.type);
          if (!targetTool) return;
          await fetch(`/api/tools/${targetTool.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: targetTool.enabled, cold: true }),
            credentials: "include",
          });
        } catch { /* best-effort restart */ }
      }));
    }
    toast({ title: "Settings copied", description: `Copied to ${targetIds.length} profile${targetIds.length !== 1 ? "s" : ""}.` });
  };

  return (
    <div className="space-y-0">
      <ContactNewFollowersPanel tool={tool} profile={profile} embedded={embedded} />
      <div className="border-t border-border/60 my-2" />
      <AutoReplyPanel tool={tool} profile={profile} embedded={embedded} />
      <div className="border-t border-border/60 my-2" />
      <ContactUsersPanel tool={tool} profile={profile} embedded={embedded} />

      <CopySettingsDialog
        key={_copyOpen ? "open" : "closed"}
        open={_copyOpen}
        onOpenChange={_setCopyOpenFn}
        title="Copy Contact Tool Settings"
        profiles={otherProfiles}
        optionGroups={CONTACT_COPY_GROUPS}
        onCopy={handleContactCopy}
      />
    </div>
  );
}
