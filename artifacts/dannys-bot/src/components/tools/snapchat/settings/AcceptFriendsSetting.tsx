import type { AcceptFriendsSettings } from "@/pages/snapchatSettings/acceptFriends";
import { ActionDelayRange } from "./ActionDelayRange";
import { ToolSettingFrame } from "./ToolSettingFrame";

type AcceptFriendsSettingProps = {
  value: AcceptFriendsSettings;
  loading: boolean;
  onUpdate: (patch: Partial<AcceptFriendsSettings>) => void;
};

export function AcceptFriendsSetting({ value, loading, onUpdate }: AcceptFriendsSettingProps) {
  return (
    <ToolSettingFrame
      title="Accept Friends"
      countLabel="Count"
      countFloor={0}
      value={value}
      loading={loading}
      onUpdate={onUpdate}
      childrenBelow={
        <ActionDelayRange
          minSeconds={value.delayMinSeconds}
          maxSeconds={value.delayMaxSeconds}
          disabled={loading || !value.enabled}
          onChange={onUpdate}
        />
      }
    />
  );
}
