import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { UploadSnapSettings } from "@/pages/snapchatSettings/uploadSnap";
import { ToolSettingFrame } from "./ToolSettingFrame";

type UploadSnapSettingProps = {
  value: UploadSnapSettings;
  loading: boolean;
  phoneSerial?: string;
  slotIdx?: number;
  onUpdate: (patch: Partial<UploadSnapSettings>) => void;
};

export function UploadSnapSetting({ value, loading, phoneSerial, slotIdx, onUpdate }: UploadSnapSettingProps) {
  return (
    <ToolSettingFrame
      title="Upload a Snap"
      countLabel="Amount"
      countFloor={0}
      value={value}
      loading={loading}
      onUpdate={onUpdate}
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
                  `/api/mobile/devices/${encodeURIComponent(phoneSerial)}/slots/${slotIdx}/snap-upload-folder-path`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path: selected.folder }),
                  },
                );
                const result = await response.json().catch(() => null);
                if (!response.ok || !result?.ok) {
                  throw new Error(result?.error ?? "Could not save the Snapchat directory.");
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
      </div>
    </ToolSettingFrame>
  );
}
