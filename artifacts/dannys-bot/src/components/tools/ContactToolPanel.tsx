import { useState } from "react";
import { Users, UserPlus, MessageSquare } from "lucide-react";
import { type Tool, type Profile } from "@shared/schema";
import { ContactNewFollowersPanel } from "./ContactNewFollowersPanel";
import { ContactUsersPanel } from "./ContactUsersPanel";
import { AutoReplyPanel } from "./AutoReplyPanel";
import { CopySettingsDialog, type CopyOptionGroup } from "@/components/tools/CopySettingsDialog";
import { copyToolSettingsToProfiles } from "@/lib/copyToolSettings";
import { useProfiles } from "@/hooks/use-profiles";
import { useToast } from "@/hooks/use-toast";
import { useUpdateTool } from "@/hooks/use-tools";

interface Props {
  tool: Tool;
  profile: Profile;
}

type SubTab = "new-followers" | "contact-users" | "auto-reply";

const CONTACT_COPY_GROUPS: CopyOptionGroup[] = [
  { label: "General", options: [
    { key: "startStop", label: "Start / Stop", description: "Copy the enabled/disabled state of this tool" },
  ]},
  { label: "Contact New Followers", options: [
    { key: "ct_newFollowers", label: "Contact New Followers", description: "Auto-messaging settings for new followers", subOptions: [
      { key: "ct_onlyApp",       label: "Only app-followed users",                 settingKeys: ["contactOnlyAppFollowed"] },
      { key: "ct_message",       label: "Message template",                        settingKeys: ["contactMessage"] },
      { key: "ct_interval",      label: "Check interval (min / max mins)",         settingKeys: ["contactCheckIntervalMin","contactCheckIntervalMax"] },
      { key: "ct_perCheck",      label: "Users per check (min / max)",             settingKeys: ["contactUsersPerCheckMin","contactUsersPerCheckMax"] },
      { key: "ct_apiSource",     label: "API source",                              settingKeys: ["contactApiSource"] },
    ]},
  ]},
  { label: "Contact Users", options: [
    { key: "ct_users", label: "Contact Users", description: "Settings for the manual user contact list", subOptions: [
      { key: "ct_usersWait",       label: "Wait between sessions (min / max mins)",     settingKeys: ["contactUsersWaitMin","contactUsersWaitMax"] },
      { key: "ct_usersSendCount",  label: "Send count per session (min / max)",         settingKeys: ["contactUsersSendCountMin","contactUsersSendCountMax"] },
      { key: "ct_usersDelay",      label: "Delay between messages (min / max secs)",    settingKeys: ["contactUsersDelayBetweenMin","contactUsersDelayBetweenMax"] },
      { key: "ct_usersPickRandom", label: "Pick users randomly",                        settingKeys: ["contactUsersPickRandom"] },
      { key: "ct_usersUnsend",     label: "Unsend settings",                            settingKeys: ["contactUsersUnsendEnabled","contactUsersUnsendMin","contactUsersUnsendMax"] },
    ]},
  ]},
  { label: "Auto Reply", options: [
    { key: "ct_autoReply", label: "Auto Reply", description: "Auto-respond to incoming messages", subOptions: [
      { key: "ct_arEnabled", label: "Enabled",     settingKeys: ["autoReplyEnabled"] },
      { key: "ct_arRules",   label: "Reply rules", settingKeys: ["autoReplies"] },
    ]},
  ]},
];

export function ContactToolPanel({ tool, profile }: Props) {
  const [activeTab, setActiveTab] = useState<SubTab>("new-followers");
  const [copyOpen, setCopyOpen] = useState(false);
  const { data: allProfiles = [] } = useProfiles();
  const { toast } = useToast();
  const updateToolMutation = useUpdateTool();
  const otherProfiles = allProfiles.filter(p => p.id !== tool.profileId);

  const handleContactCopy = async (targetIds: number[], expandedKeys: string[]) => {
    const copyEnabled = expandedKeys.includes("startStop");
    const keysToSend  = expandedKeys.filter(k => k !== "startStop");
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
      {/* Sub-tab bar */}
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
        <button
          className="ml-auto pr-2 text-xs text-muted-foreground hover:text-foreground hover:underline underline-offset-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          disabled={otherProfiles.length === 0}
          onClick={() => setCopyOpen(true)}
        >
          Copy Settings
        </button>
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
