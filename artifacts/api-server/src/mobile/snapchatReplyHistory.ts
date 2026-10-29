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

function containsBoundlusTarget(text: string): boolean {
  let decoded = text;
  for (let pass = 0; pass < 2; pass++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return /(?:^|[^a-z0-9.-])(?:www\.)?boundlus\.com(?:$|[/?#\s.)\]},!?;:])/i.test(decoded);
}

function historyPath() {
  return path.join(path.dirname(sqlite.name), "snapchat-reply-history.jsonl");
}

function readEntries(): SnapchatReplyHistoryEntry[] {
  try {
    return fs.readFileSync(historyPath(), "utf8").split(/\r?\n/).flatMap(line => {
      try { return [JSON.parse(line) as SnapchatReplyHistoryEntry]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

export function hasSentSnapchatBoundlusLink(slotId: string, username: string): boolean {
  const normalizedUsername = username.replace(/^@/, "").toLowerCase();
  return readEntries().some(entry =>
    entry.slotId === slotId &&
    entry.username.replace(/^@/, "").toLowerCase() === normalizedUsername &&
    containsBoundlusTarget(entry.sentText),
  );
}

export function exportSnapchatReplyHistory(slotId: string): string {
  const entries = readEntries().filter(entry => entry.slotId === slotId);
  if (!entries.length) return "No Snapchat reply history recorded for this account slot.\n";
  return entries.map(entry => [
    `Contact: @${entry.username} (${entry.displayName})`,
    `Reply number: ${entry.replyNumber}`,
    `Boundlus link sent: ${containsBoundlusTarget(entry.sentText) ? "Yes" : "No"}`,
    `Sent at: ${entry.sentAt}`,
    "Captured conversation:",
    ...entry.capturedMessages.map(message => `  ${message}`),
    "GPT-6 Luna sent:",
    `  ${entry.sentText}`,
    "",
    "------------------------------------------------------------",
    "",
  ].join("\n")).join("\n");
}

export function clearSnapchatReplyHistory(slotId: string): void {
  const remaining = readEntries().filter(entry => entry.slotId !== slotId);
  const filePath = historyPath();
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, remaining.map(entry => JSON.stringify(entry)).join("\n") + (remaining.length ? "\n" : ""), "utf8");
  fs.renameSync(tempPath, filePath);
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
