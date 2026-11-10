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
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <label className="text-sm text-muted-foreground">Conversation goal and purpose</label>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto min-h-0 p-0 text-xs"
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
              variant="link"
              size="sm"
              className="h-auto min-h-0 p-0 text-xs"
              disabled={loading}
              onClick={async () => {
                const response = await fetch("/api/mobile/snapchat/reply-history");
                if (!response.ok) {
                  window.alert("Could not download all Snapchat reply history.");
                  return;
                }
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = "snapchat-reply-history-all.txt";
                link.click();
                URL.revokeObjectURL(url);
              }}
            >
              Download All
            </Button>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto min-h-0 p-0 text-xs"
              disabled={loading || !phoneSerial}
              onClick={async () => {
                if (!phoneSerial || !window.confirm("Clear the saved reply history and skipped-contact records for this Snapchat slot?")) return;
                const response = await fetch(
                  `/api/mobile/devices/${encodeURIComponent(phoneSerial)}/slots/${slotIdx}/snapchat/reply-history`,
                  { method: "DELETE" },
                );
                window.alert(response.ok
                  ? "Saved reply and skipped-contact history cleared for this slot."
                  : "Could not clear this slot's history.");
              }}
            >
              Clear reply and skip history
            </Button>
          </div>
        </div>
        <textarea
          value={value.replyGoal}
          rows={5}
          onChange={event => onUpdate({ replyGoal: event.target.value })}
          disabled={loading || !value.enabled}
          className="w-full min-h-20 rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-50"
        />
      </div>
      )}
    />
  );
}
