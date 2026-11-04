import fs from "node:fs";
import path from "node:path";
import { sqlite } from "@workspace/db";

export type SnapchatReplyHistoryEntry = {
  slotId: string;
  serial: string;
  accountUsername?: string;
  username: string;
  displayName: string;
  capturedMessages: string[];
  sentText: string;
  sentAt: string;
  replyNumber: number;
};

export type SnapchatUnansweredAuditEntry = {
  slotId: string;
  serial: string;
  accountUsername?: string;
  contactName: string;
  stage: string;
  reason: string;
  capturedMessages: string[];
  recordedAt: string;
};

export function containsSnapchatBoundlusLink(text: string): boolean {
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

function unansweredAuditPath() {
  return path.join(path.dirname(sqlite.name), "snapchat-unanswered-audit.jsonl");
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

function readUnansweredAuditEntries(): SnapchatUnansweredAuditEntry[] {
  try {
    return fs.readFileSync(unansweredAuditPath(), "utf8").split(/\r?\n/).flatMap(line => {
      try { return [JSON.parse(line) as SnapchatUnansweredAuditEntry]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function normalizeContactKey(value: string): string {
  return value.replace(/^@/, "").trim().toLowerCase();
}

function matchesContact(entry: SnapchatReplyHistoryEntry, contactKey: string): boolean {
  const expected = normalizeContactKey(contactKey);
  return normalizeContactKey(entry.username) === expected ||
    normalizeContactKey(entry.displayName) === expected;
}

export function getSnapchatReplyHistory(slotId: string, contactKey: string): {
  previousReplyCount: number;
  sentReplies: Array<{ replyNumber: number; capturedMessages: string[]; sentText: string }>;
} {
  const entries = readEntries()
    .filter(entry =>
      entry.slotId === slotId &&
      matchesContact(entry, contactKey),
    )
    .sort((a, b) => a.replyNumber - b.replyNumber);
  return {
    previousReplyCount: entries.reduce((count, entry) => Math.max(count, entry.replyNumber), 0),
    sentReplies: entries.slice(-10).map(({ replyNumber, capturedMessages, sentText }) => ({
      replyNumber,
      capturedMessages,
      sentText,
    })),
  };
}

export function exportSnapchatReplyHistory(slotId: string): string {
  const entries = readEntries().filter(entry => entry.slotId === slotId);
  const unanswered = readUnansweredAuditEntries().filter(entry => entry.slotId === slotId);
  if (!entries.length && !unanswered.length) {
    return "No Snapchat reply history or skipped-contact audit recorded for this account slot.\n";
  }
  const sections = entries.map(entry => [
    `Contact: ${normalizeContactKey(entry.username) === normalizeContactKey(entry.displayName)
      ? entry.displayName
      : `@${entry.username} (${entry.displayName})`}`,
    `Reply number: ${entry.replyNumber}`,
    `Boundlus link sent: ${containsSnapchatBoundlusLink(entry.sentText) ? "Yes" : "No"}`,
    `Sent at: ${entry.sentAt}`,
    "Captured conversation:",
    ...entry.capturedMessages.map(message => `  ${message}`),
    "GPT-6 Luna sent:",
    `  ${entry.sentText}`,
    "",
    "------------------------------------------------------------",
    "",
  ].join("\n"));
  if (unanswered.length) {
    sections.push(formatUnansweredAudit(unanswered));
  }
  return sections.join("\n");
}

export function exportAllSnapchatReplyHistory(): string {
  const entries = readEntries();
  const unanswered = readUnansweredAuditEntries();
  if (!entries.length && !unanswered.length) {
    return "No Snapchat reply history or skipped-contact audit has been recorded.\n";
  }

  const groups = new Map<string, { replies: SnapchatReplyHistoryEntry[]; unanswered: SnapchatUnansweredAuditEntry[] }>();
  for (const entry of entries) {
    const key = `${entry.serial}\u0000${entry.slotId}`;
    const group = groups.get(key) ?? { replies: [], unanswered: [] };
    group.replies.push(entry);
    groups.set(key, group);
  }
  for (const entry of unanswered) {
    const key = `${entry.serial}\u0000${entry.slotId}`;
    const group = groups.get(key) ?? { replies: [], unanswered: [] };
    group.unanswered.push(entry);
    groups.set(key, group);
  }

  return [...groups.values()].map(group => {
    const firstReply = group.replies[0];
    const firstAudit = group.unanswered[0];
    const accountUsername = firstReply?.accountUsername ?? firstAudit?.accountUsername;
    const accountHeading = accountUsername
      ? `Account slot: ${formatAccountUsername(accountUsername)}`
      : `Account slot ID: ${firstReply?.slotId ?? firstAudit?.slotId ?? "Unknown"}`;
    return [
      `Device: ${firstReply?.serial ?? firstAudit?.serial ?? "Unknown"}`,
      accountHeading,
      "",
      exportEntries(group.replies),
      group.unanswered.length ? formatUnansweredAudit(group.unanswered) : "",
    ].join("\n");
  }).join("\n\n");
}

function exportEntries(entries: SnapchatReplyHistoryEntry[]): string {
  return entries.map(entry => [
    `Contact: ${normalizeContactKey(entry.username) === normalizeContactKey(entry.displayName)
      ? entry.displayName
      : `@${entry.username} (${entry.displayName})`}`,
    `Reply number: ${entry.replyNumber}`,
    `Boundlus link sent: ${containsSnapchatBoundlusLink(entry.sentText) ? "Yes" : "No"}`,
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

function formatAccountUsername(username: string): string {
  return username.startsWith("@") ? username : `@${username}`;
}

function formatUnansweredAudit(entries: SnapchatUnansweredAuditEntry[]): string {
  return [
    "UNANSWERED / SKIPPED CONTACT AUDIT",
    "",
    ...entries.map(entry => [
      `Contact: ${entry.contactName}`,
      `Not replied at: ${entry.recordedAt}`,
      `Stage: ${entry.stage}`,
      `Reason: ${entry.reason}`,
      "Captured conversation:",
      ...entry.capturedMessages.map(message => `  ${message}`),
      "",
      "------------------------------------------------------------",
      "",
    ].join("\n")),
  ].join("\n");
}

export function clearSnapchatReplyHistory(slotId: string): void {
  const remaining = readEntries().filter(entry => entry.slotId !== slotId);
  const filePath = historyPath();
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, remaining.map(entry => JSON.stringify(entry)).join("\n") + (remaining.length ? "\n" : ""), "utf8");
  fs.renameSync(tempPath, filePath);
  const remainingAudit = readUnansweredAuditEntries().filter(entry => entry.slotId !== slotId);
  const auditPath = unansweredAuditPath();
  const auditTempPath = `${auditPath}.tmp`;
  fs.writeFileSync(
    auditTempPath,
    remainingAudit.map(entry => JSON.stringify(entry)).join("\n") + (remainingAudit.length ? "\n" : ""),
    "utf8",
  );
  fs.renameSync(auditTempPath, auditPath);
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
        if (
          prior.slotId === entry.slotId &&
          (normalizeContactKey(prior.username ?? "") === normalizeContactKey(entry.username) ||
            normalizeContactKey(prior.displayName ?? "") === normalizeContactKey(entry.username))
        ) {
          replyNumber = Math.max(replyNumber, Number(prior.replyNumber || 0) + 1);
        }
      } catch { /* Ignore an incomplete final line and continue counting valid entries. */ }
    }
  } catch { /* First reply creates the history file. */ }

  const record = { ...entry, replyNumber };
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
  return record;
}

export function appendSnapchatUnansweredAudit(entry: SnapchatUnansweredAuditEntry): void {
  const filePath = unansweredAuditPath();
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", flag: "a" });
}
