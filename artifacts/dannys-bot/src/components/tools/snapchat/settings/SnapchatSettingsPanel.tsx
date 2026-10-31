import type { SnapchatToolSettings } from "@/pages/snapchatSettings";
import { AcceptFriendsSetting } from "./AcceptFriendsSetting";
import { AddFriendsSetting } from "./AddFriendsSetting";
import { MassSnapSetting } from "./MassSnapSetting";
import { ReplyUnreadChatsSetting } from "./ReplyUnreadChatsSetting";
import { ShuffleToolOrderSetting } from "./ShuffleToolOrderSetting";
import { UploadSnapSetting } from "./UploadSnapSetting";
import { ViewSnapsSetting } from "./ViewSnapsSetting";
import { ViewSpotlightsSetting } from "./ViewSpotlightsSetting";

export type SnapchatToolKey = Exclude<keyof SnapchatToolSettings, "shuffleToolOrder">;

type SnapchatSettingsPanelProps = {
  settings: SnapchatToolSettings;
  loading: boolean;
  phoneSerial?: string;
  slotIdx?: number;
  onShuffleChange: (value: boolean) => void;
  onToolUpdate: (tool: SnapchatToolKey, patch: Record<string, unknown>) => void;
};

export function SnapchatSettingsPanel({
  settings,
  loading,
  phoneSerial,
  slotIdx,
  onShuffleChange,
  onToolUpdate,
}: SnapchatSettingsPanelProps) {
  return (
    <div className="bg-card border border-border rounded-xl p-5 space-y-5">
      <div>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">(STEP2)</p>
          <ShuffleToolOrderSetting
            value={settings.shuffleToolOrder}
            disabled={loading}
            id={`snapchat-shuffle-tool-order-${slotIdx ?? 0}`}
            onChange={onShuffleChange}
          />
        </div>
      </div>
      <UploadSnapSetting
        value={settings.uploadSnap}
        loading={loading}
        phoneSerial={phoneSerial}
        slotIdx={slotIdx}
        onUpdate={patch => onToolUpdate("uploadSnap", patch as Record<string, unknown>)}
      />
      <AddFriendsSetting
        value={settings.addFriends}
        loading={loading}
        onUpdate={patch => onToolUpdate("addFriends", patch as Record<string, unknown>)}
      />
      <AcceptFriendsSetting
        value={settings.acceptFriends}
        loading={loading}
        onUpdate={patch => onToolUpdate("acceptFriends", patch as Record<string, unknown>)}
      />
      <ViewSpotlightsSetting
        value={settings.viewStories}
        loading={loading}
        onUpdate={patch => onToolUpdate("viewStories", patch as Record<string, unknown>)}
      />
      <ViewSnapsSetting
        value={settings.viewSnaps}
        loading={loading}
        onUpdate={patch => onToolUpdate("viewSnaps", patch as Record<string, unknown>)}
      />
      <MassSnapSetting
        value={settings.massSnap}
        loading={loading}
        onUpdate={patch => onToolUpdate("massSnap", patch as Record<string, unknown>)}
      />
      <ReplyUnreadChatsSetting
        value={settings.replyUnreadChats}
        loading={loading}
        phoneSerial={phoneSerial}
        slotIdx={slotIdx}
        onUpdate={patch => onToolUpdate("replyUnreadChats", patch as Record<string, unknown>)}
      />
    </div>
  );
}
