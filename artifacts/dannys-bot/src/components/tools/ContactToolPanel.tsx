import { useState } from "react";
import { Users, UserPlus, MessageSquare, Copy, Clock } from "lucide-react";
import { format } from "date-fns";
import { type Tool, type Profile } from "@shared/schema";
import { useProfileEngineStatus } from "@/hooks/use-engine-status";
import { ContactNewFollowersPanel } from "./ContactNewFollowersPanel";
import { ContactUsersPanel } from "./ContactUsersPanel";
import { AutoReplyPanel } from "./AutoReplyPanel";
import { Button } from "@/components/ui/button";
import { CopySettingsDialog, type CopyOptionGroup } from "@/components/tools/CopySettingsDialog";
import { copyToolSettingsToProfiles } from "@/lib/copyToolSettings";
import { useProfiles } from "@/hooks/use-profiles";
import { useToast } from "@/hooks/use-toast";

interface Props {
  tool: Tool;
  profile: Profile;
}

type SubTab = "new-followers" | "contact-users" | "auto-reply";

const CONTACT_KEY_MAP: Record<string, string[]> = {
  // Contact New Followers
  contactOnlyAppFollowed:   ["contactOnlyAppFollowed"],
  contactMessage:           ["contactMessage"],
  contactCheckInterval:     ["contactCheckIntervalMin","contactCheckIntervalMax"],
  contactPerCheck:          ["contactUsersPerCheckMin","contactUsersPerCheckMax"],
  contactApiSource:         ["contactApiSource"],
  // Contact Users
  contactUsersWait:         ["contactUsersWaitMin","contactUsersWaitMax"],
  contactUsersSendCount:    ["contactUsersSendCountMin","contactUsersSendCountMax"],
  contactUsersDelay:        ["contactUsersDelayBetweenMin","contactUsersDelayBetweenMax"],
  contactUsersPickRandom:   ["contactUsersPickRandom"],
  contactUsersUnsend:       ["contactUsersUnsendEnabled","contactUsersUnsendMin","contactUsersUnsendMax"],
  // Auto Reply
  autoReplyEnabled:         ["autoReplyEnabled"],
  autoReplies:              ["autoReplies"],
  // startStop is special — handled in handler
};

const CONTACT_COPY_GROUPS: CopyOptionGroup[] = [
  { label: "General", options: [
    { key: "startStop", label: "Start / Stop", description: "Copy the enabled/disabled state of this tool" },
  ]},
  { label: "Contact New Followers", options: [
    { key: "contactOnlyAppFollowed", label: "Only App Followed",   description: "Restrict to users followed by this app" },
    { key: "contactMessage",         label: "Message Template",    description: "The message sent to new followers" },
    { key: "contactCheckInterval",   label: "Check Interval",      description: "Min/max minutes between follower checks" },
    { key: "contactPerCheck",        label: "Users Per Check",     description: "How many users to contact each check" },
    { key: "contactApiSource",       label: "API Source",          description: "Which API endpoint to use for detection" },
  ]},
  { label: "Contact Users", options: [
    { key: "contactUsersWait",       label: "Wait Between Sessions", description: "Min/max minutes between contact sessions" },
    { key: "contactUsersSendCount",  label: "Send Count",            description: "Min/max messages to send per session" },
    { key: "contactUsersDelay",      label: "Delay Between",         description: "Seconds between individual messages" },
    { key: "contactUsersPickRandom", label: "Pick Random",           description: "Pick users randomly from the list" },
    { key: "contactUsersUnsend",     label: "Unsend Settings",       description: "Auto-unsend after a time window" },
  ]},
  { label: "Auto Reply", options: [
    { key: "autoReplyEnabled", label: "Auto Reply Enabled", description: "Toggle the auto reply feature on/off" },
    { key: "autoReplies",      label: "Auto Reply Rules",   description: "Trigger words and reply message pairs" },
  ]},
];

export function ContactToolPanel({ tool, profile }: Props) {
  const [activeTab, setActiveTab] = useState<SubTab>("new-followers");
  const [copyOpen, setCopyOpen] = useState(false);
  const { data: allProfiles = [] } = useProfiles();
  const { toast } = useToast();
  const otherProfiles = allProfiles.filter(p => p.id !== tool.profileId);
  const engineStatus = useProfileEngineStatus(tool.profileId);
  const contactRunStatus: { label: string; executing: boolean } | null = (() => {
    if (!tool.enabled) return null;
    if (!engineStatus) return null;
    const nextAt = engineStatus.nextContactAt ?? 0;
    if (!nextAt || nextAt <= Date.now()) return { label: "Executing", executing: true };
    return { label: format(new Date(nextAt), "HH:mm:ss"), executing: false };
  })();

  const handleContactCopy = async (targetIds: number[], selectedKeys: Set<string>) => {
    const copyEnabled = selectedKeys.has("startStop");
    const keysToSend = [...selectedKeys].filter(k => k !== "startStop").flatMap(k => CONTACT_KEY_MAP[k] ?? []);
    await copyToolSettingsToProfiles(
      (tool.settings as Record<string, unknown>) ?? {},
      tool.type,
      targetIds,
      keysToSend,
      copyEnabled ? tool.enabled : undefined,
    );
    toast({ title: "Settings copied", description: `Copied to ${targetIds.length} profile${targetIds.length !== 1 ? "s" : ""}.` });
  };

  const triggerClass = (tab: SubTab) =>
    `flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-all whitespace-nowrap cursor-pointer ${
      activeTab === tab
        ? "text-primary border-primary"
        : "text-muted-foreground border-transparent hover:text-foreground hover:border-muted-foreground/40"
    }`;

  return (
    <div className="space-y-4">
      {/* Status badge */}
      {contactRunStatus && (
        <div className="flex items-center gap-1.5 text-[11px]" style={{ color: contactRunStatus.executing ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))" }}>
          <Clock className="w-3 h-3 shrink-0" />
          {contactRunStatus.executing
            ? <span className="font-medium">Executing</span>
            : <><span>Scheduled:</span>&nbsp;<span className="font-mono font-medium text-foreground">{contactRunStatus.label}</span></>
          }
        </div>
      )}
      {/* Sub-tab bar + Copy button */}
      <div className="flex items-center border-b border-border -mx-1">
        <button className={triggerClass("new-followers")} onClick={() => setActiveTab("new-followers")}>
          <UserPlus className="w-3.5 h-3.5" />
          Contact New Followers
        </button>
        <button className={triggerClass("auto-reply")} onClick={() => setActiveTab("auto-reply")}>
          <MessageSquare className="w-3.5 h-3.5" />
          Auto Reply
        </button>
        <button className={triggerClass("contact-users")} onClick={() => setActiveTab("contact-users")}>
          <Users className="w-3.5 h-3.5" />
          Contact Users
        </button>
        <div className="ml-auto pr-1" />
      </div>

      {/* Panel content */}
      {activeTab === "new-followers" && (
        <ContactNewFollowersPanel tool={tool} profile={profile} />
      )}
      {activeTab === "contact-users" && (
        <ContactUsersPanel tool={tool} profile={profile} />
      )}
      {activeTab === "auto-reply" && (
        <AutoReplyPanel tool={tool} profile={profile} />
      )}

      <div className="mt-6">
        <Button
          variant="outline"
          className="w-full gap-2"
          disabled={otherProfiles.length === 0}
          onClick={() => setCopyOpen(true)}
        >
          <Copy className="w-4 h-4" /> Copy Contact Tool Settings to Other Profiles
        </Button>
        {otherProfiles.length === 0 && (
          <p className="text-xs text-center text-muted-foreground mt-2">Add more profiles to enable copying settings.</p>
        )}
      </div>

      <CopySettingsDialog
        key={copyOpen ? "open" : "closed"}
        open={copyOpen}
        onOpenChange={setCopyOpen}
        title="Copy Contact Tool Settings"
        profiles={otherProfiles}
        optionGroups={CONTACT_COPY_GROUPS}
        onCopy={handleContactCopy}
      />
    </div>
  );
}
