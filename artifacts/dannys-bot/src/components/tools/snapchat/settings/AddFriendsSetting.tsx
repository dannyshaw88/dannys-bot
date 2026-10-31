import type { AddFriendsSettings } from "@/pages/snapchatSettings/addFriends";
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
    />
  );
}
