import { useId, useState } from "react";
import { ChevronDown, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { UploadVideoSettings } from "@/pages/snapchatSettings/uploadVideo";
import { ToolSettingFrame } from "./ToolSettingFrame";

type UploadVideoSettingProps = {
  value: UploadVideoSettings;
  loading: boolean;
  phoneSerial?: string;
  slotIdx?: number;
  onUpdate: (patch: Partial<UploadVideoSettings>) => void;
};

export function UploadVideoSetting({
  value,
  loading,
  phoneSerial,
  slotIdx,
  onUpdate,
}: UploadVideoSettingProps) {
  const captionFieldId = `upload-video-caption-${slotIdx ?? 0}`;
  const advancedOptionsId = useId();
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);
  return (
    <ToolSettingFrame
      title="Upload a Video"
      countLabel="Amount"
      countFloor={1}
      value={value}
      loading={loading}
      onUpdate={onUpdate}
      childrenBelow={
        <div id={advancedOptionsId} hidden={!showAdvancedOptions} className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pl-1">
            <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={value.addLink}
                onChange={event => onUpdate({ addLink: event.target.checked })}
                disabled={loading || !value.enabled}
                className="h-4 w-4 accent-primary"
              />
              Add a link
            </label>
            <Input
              type="url"
              value={value.linkUrl}
              onChange={event => onUpdate({ linkUrl: event.target.value })}
              placeholder="https://example.com"
              maxLength={2048}
              className="h-8 min-w-[220px] max-w-[420px] flex-1 text-xs"
              disabled={loading || !value.enabled || !value.addLink}
              aria-label="Link to add to the video Snap"
            />
          </div>
          <div className="grid w-full gap-1">
            <label htmlFor={captionFieldId} className="text-xs text-muted-foreground">
              Caption
            </label>
            <Textarea
              id={captionFieldId}
              value={value.caption}
              onChange={event => onUpdate({ caption: event.target.value })}
              placeholder="Leave blank for no caption"
              rows={2}
              className="min-h-[56px] resize-y text-xs"
              disabled={loading || !value.enabled}
            />
          </div>
        </div>
      }
    >
      <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading || !(window as any).electronAPI?.openFolderDialog}
          onClick={async () => {
            const api = (window as any).electronAPI;
            if (!api?.openFolderDialog) return;
            try {
              const selected = await api.openFolderDialog(value.directoryPath || undefined);
              if (selected?.canceled || !selected?.folder) return;
              onUpdate({ directoryPath: selected.folder });
              if (phoneSerial && slotIdx !== undefined) {
                const response = await fetch(
                  `/api/mobile/devices/${encodeURIComponent(phoneSerial)}/slots/${slotIdx}/snap-video-upload-folder-path`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path: selected.folder }),
                  },
                );
                const result = await response.json().catch(() => null);
                if (!response.ok || !result?.ok) {
                  throw new Error(result?.error ?? "Could not save the video directory.");
                }
              }
            } catch (error) {
              window.alert(error instanceof Error ? error.message : "Could not open the folder picker.");
            }
          }}
        >
          <FolderOpen className="mr-2 h-4 w-4" />
          Directory
        </Button>
        <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={value.selectAtRandom}
            onChange={event => onUpdate({ selectAtRandom: event.target.checked })}
            disabled={loading || !value.enabled}
            className="h-4 w-4 accent-primary"
          />
          Select at random
        </label>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground"
          aria-label={showAdvancedOptions ? "Collapse video link and caption options" : "Expand video link and caption options"}
          aria-expanded={showAdvancedOptions}
          aria-controls={advancedOptionsId}
          onClick={() => setShowAdvancedOptions(open => !open)}
        >
          <ChevronDown className={`h-4 w-4 transition-transform ${showAdvancedOptions ? "rotate-180" : ""}`} />
        </Button>
      </div>
    </ToolSettingFrame>
  );
}
