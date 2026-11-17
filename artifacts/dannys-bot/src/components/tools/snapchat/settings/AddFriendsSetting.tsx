import type { AddFriendsSettings } from "@/pages/snapchatSettings/addFriends";
import { ActionDelayRange } from "./ActionDelayRange";
import { ToolSettingFrame } from "./ToolSettingFrame";

type AddFriendsSettingProps = {
  value: AddFriendsSettings;
  loading: boolean;
  onUpdate: (patch: Partial<AddFriendsSettings>) => void;
};

export function AddFriendsSetting({ value, loading, onUpdate }: AddFriendsSettingProps) {
  return (
    <ToolSettingFrame
      title="Add Friends"
      countLabel="Count"
      countFloor={0}
      value={value}
      loading={loading}
      onUpdate={onUpdate}
      children={
        <>
          <ActionDelayRange
            minSeconds={value.delayMinSeconds}
            maxSeconds={value.delayMaxSeconds}
            disabled={loading || !value.enabled}
            onChange={onUpdate}
          />
          <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={value.skipAdded}
              onChange={event => onUpdate({ skipAdded: event.target.checked })}
              disabled={loading || !value.enabled}
              className="h-4 w-4 accent-primary"
            />
            Skip Added
          </label>
        </>
      }
    />
  );
}
