import type { AddFriendsSettings } from "@/pages/snapchatSettings/addFriends";
import { ActionDelayRange } from "./ActionDelayRange";
import { ToolSettingFrame } from "./ToolSettingFrame";
import { useRef, useState } from "react";
import { FileText, Upload } from "lucide-react";

type AddFriendsSettingProps = {
  value: AddFriendsSettings;
  loading: boolean;
  onUpdate: (patch: Partial<AddFriendsSettings>) => void;
};

export function AddFriendsSetting({ value, loading, onUpdate }: AddFriendsSettingProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState("");
  const avoidWords = typeof value.avoidUsersContainingWords === "string" ? value.avoidUsersContainingWords : "";
  const fileName = typeof value.avoidUsersContainingFileName === "string" ? value.avoidUsersContainingFileName : "";
  const termCount = avoidWords
    .split(",")
    .filter(term => term.trim()).length;

  const loadAvoidWordsFile = async (file?: File) => {
    if (!file) return;
    setFileError("");
    if (!file.name.toLowerCase().endsWith(".txt") && file.type !== "text/plain") {
      setFileError("Choose a .txt file.");
      return;
    }
    if (file.size > 1_000_000) {
      setFileError("The text file must be 1 MB or smaller.");
      return;
    }
    try {
      const text = await file.text();
      if (!text.trim()) {
        setFileError("The selected text file is empty.");
        return;
      }
      onUpdate({
        avoidUsersContainingWords: text,
        avoidUsersContainingFileName: file.name.slice(0, 255),
      });
    } catch {
      setFileError("Could not read the selected text file.");
    }
  };

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
      childrenBelow={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={value.avoidUsersContainingEnabled}
              onChange={event => onUpdate({ avoidUsersContainingEnabled: event.target.checked })}
              disabled={loading || !value.enabled}
              className="h-4 w-4 accent-primary"
            />
            Avoid Users Containing:
          </label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,text/plain"
            className="hidden"
            disabled={loading || !value.enabled}
            onChange={event => {
              void loadAvoidWordsFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={loading || !value.enabled}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {fileName ? <FileText className="h-3.5 w-3.5" /> : <Upload className="h-3.5 w-3.5" />}
            {fileName || "Upload text file"}
          </button>
          {fileName && (
            <span className="text-xs text-muted-foreground">
              {termCount.toLocaleString()} words
            </span>
          )}
          {fileError && <span role="alert" className="text-xs text-destructive">{fileError}</span>}
        </div>
      }
    />
  );
}
