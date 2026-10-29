import fs from "node:fs";
import path from "node:path";
import { sqlite } from "@workspace/db";

export type SnapchatReplyHistoryEntry = {
  slotId: string;
  serial: string;
  username: string;
  displayName: string;
  capturedMessages: string[];
  sentText: string;
  sentAt: string;
  replyNumber: number;
};

function historyPath() {
  return path.join(path.dirname(sqlite.name), "snapchat-reply-history.jsonl");
}

export function appendSnapchatReplyHistory(
  entry: Omit<SnapchatReplyHistoryEntry, "replyNumber">,
): SnapchatReplyHistoryEntry {
  const filePath = historyPath();
  let replyNumber = 1;
  try {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      try {
        const prior = JSON.parse(line) as Partial<SnapchatReplyHistoryEntry>;
        if (prior.slotId === entry.slotId && prior.username?.toLowerCase() === entry.username.toLowerCase()) {
          replyNumber = Math.max(replyNumber, Number(prior.replyNumber || 0) + 1);
        }
      } catch { /* Ignore an incomplete final line and continue counting valid entries. */ }
    }
  } catch { /* First reply creates the history file. */ }

  const record = { ...entry, replyNumber };
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
  return record;
}
