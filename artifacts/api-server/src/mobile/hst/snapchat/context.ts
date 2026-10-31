import type { SnapchatToolSettings } from "../settings/snapchat";

export type DeviceSwipeGesture = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  durationMinMs: number;
  durationMaxMs: number;
  jitterX: number;
  jitterY: number;
  startJitterMinY?: number;
  startJitterMaxY?: number;
  pauseMinMs?: number;
  pauseMaxMs?: number;
  settleMinMs?: number;
  settleMaxMs?: number;
};

export type UiNode = {
  text: string;
  desc: string;
  resourceId: string;
  className: string;
  packageName: string;
  clickable: boolean;
  focusable: boolean;
  focused: boolean;
  selected: boolean;
  bounds: [number, number, number, number];
};

export type UiState = { xml: string; nodes: UiNode[] };

export type SnapchatContext = {
  serial: string;
  slotId?: string;
  slotIdx?: number;
  path: any;
  pickLocalFolderImage: (
    serial: string,
    opts: {
      folderPath: string;
      random: boolean;
      noRepeat: boolean;
      slotIdx?: number;
      onLog?: (message: string) => void;
    },
  ) => Promise<string | null>;
  tools: SnapchatToolSettings;
  onLog: (message: string) => void;
  onProgress: () => void;
  onMetric?: (
    key: "snapchat_add_friends" | "snapchat_accept_friends" | "snapchat_replies" | "snapchat_spotlights" | "snapchat_snaps",
    count?: number,
  ) => void;
  isAborted: () => boolean;
  effectiveTypingProfile: (serial: string) => any;
  sleep: (milliseconds: number, timingMode?: "static" | "exact") => Promise<void>;
  swipeGesture?: DeviceSwipeGesture;
};
