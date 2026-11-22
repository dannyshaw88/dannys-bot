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
        </>
      }
      childrenBelow={
        <div>
          <div className="flex w-full flex-nowrap items-center gap-1 overflow-x-auto whitespace-nowrap">
            <label className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={value.skipAdded}
                onChange={event => onUpdate({ skipAdded: event.target.checked })}
                disabled={loading || !value.enabled}
                className="h-4 w-4 accent-primary"
                data-testid="checkbox-skip-added"
              />
              Skip Added
            </label>
            <label
              className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground cursor-pointer select-none"
              title="Dismiss if the name or username contains letters outside A–Z. Symbols and emoji alone are ignored."
            >
              <input
                type="checkbox"
                checked={value.dismissNonEnglish}
                onChange={event => onUpdate({ dismissNonEnglish: event.target.checked })}
                disabled={loading || !value.enabled}
                className="h-4 w-4 accent-primary"
                data-testid="checkbox-dismiss-non-english"
              />
              Dismiss Non-English
            </label>
            <label className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground cursor-pointer select-none">
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
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-border px-1.5 text-[9px] text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {fileName ? <FileText className="h-3 w-3" /> : <Upload className="h-3 w-3" />}
              {fileName || "Upload text file"}
            </button>
            {fileName && (
              <span className="max-w-[90px] shrink-0 truncate text-[9px] text-muted-foreground" title={fileName}>
                {termCount.toLocaleString()} words
              </span>
            )}
          </div>
          {fileError && <span role="alert" className="mt-1 block text-xs text-destructive">{fileError}</span>}
        </div>
      }
    />
  );
}
