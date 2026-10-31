import { Button } from "@/components/ui/button";
import type { ReplyUnreadChatsSettings } from "@/pages/snapchatSettings/replyUnreadChats";
import { ToolSettingFrame } from "./ToolSettingFrame";

type ReplyUnreadChatsSettingProps = {
  value: ReplyUnreadChatsSettings;
  loading: boolean;
  phoneSerial?: string;
  slotIdx?: number;
  onUpdate: (patch: Partial<ReplyUnreadChatsSettings>) => void;
};

export function ReplyUnreadChatsSetting({
  value,
  loading,
  phoneSerial,
  slotIdx,
  onUpdate,
}: ReplyUnreadChatsSettingProps) {
  return (
    <ToolSettingFrame
      title="Reply to Unread Chats"
      countLabel="Count"
      countFloor={0}
      value={value}
      loading={loading}
      onUpdate={onUpdate}
      childrenBelow={(
      <div className="space-y-1">
        <label className="text-sm text-muted-foreground">Conversation goal and purpose</label>
        <textarea
          maxLength={5000}
          value={value.replyGoal}
          onChange={event => onUpdate({ replyGoal: event.target.value })}
          disabled={loading || !value.enabled}
          className="w-full min-h-20 rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-50"
        />
        <p className="text-xs text-muted-foreground text-right">
          {value.replyGoal.length.toLocaleString()} / 5,000 characters
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading || !phoneSerial}
            onClick={async () => {
              if (!phoneSerial) return;
              const response = await fetch(
                `/api/mobile/devices/${encodeURIComponent(phoneSerial)}/slots/${slotIdx}/snapchat/reply-history`,
              );
              if (!response.ok) {
                window.alert("Could not download this slot's Snapchat reply history.");
                return;
              }
              const blob = await response.blob();
              const url = URL.createObjectURL(blob);
              const link = document.createElement("a");
              link.href = url;
              link.download = "snapchat-reply-history.txt";
              link.click();
              URL.revokeObjectURL(url);
            }}
          >
            Download reply history
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading || !phoneSerial}
            onClick={async () => {
              if (!phoneSerial || !window.confirm("Clear the saved reply history for this Snapchat slot?")) return;
              const response = await fetch(
                `/api/mobile/devices/${encodeURIComponent(phoneSerial)}/slots/${slotIdx}/snapchat/reply-history`,
                { method: "DELETE" },
              );
              window.alert(response.ok
                ? "Saved reply history cleared for this slot."
                : "Could not clear this slot's reply history.");
            }}
          >
            Clear reply history
          </Button>
        </div>
      </div>
      )}
    />
  );
}
