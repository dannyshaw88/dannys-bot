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

type ConversationMessage = {
  sender: "Contact" | "Luna" | "FAILED";
  text: string;
  timestamp: string;
  timestampKind: "observed" | "sent" | "failed";
  sequence: number;
  replyNumber?: number;
  reason?: string;
};

type SnapchatConversation = {
  slotId: string;
  serial: string;
  accountUsername?: string;
  username: string;
  displayName: string;
  aliases: string[];
  messages: ConversationMessage[];
  lastSnapshot: string[];
  updatedAt: string;
  nextSequence: number;
};

type SnapshotMessage = {
  sender: "Contact" | "Luna";
  text: string;
};

type LegacyEvent =
  | { kind: "reply"; timestamp: string; entry: SnapchatReplyHistoryEntry }
  | { kind: "failure"; timestamp: string; entry: SnapchatUnansweredAuditEntry };

const LEGACY_NON_CONVERSATION_STAGES = new Set(["unread-list", "run-ended"]);

function storePath(): string {
  return path.join(path.dirname(sqlite.name), "snapchat-conversations.jsonl");
}

function legacyReplyPath(): string {
  return path.join(path.dirname(sqlite.name), "snapchat-reply-history.jsonl");
}

function legacyFailurePath(): string {
  return path.join(path.dirname(sqlite.name), "snapchat-unanswered-audit.jsonl");
}

function readJsonLines<T>(filePath: string): T[] {
  try {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/).flatMap(line => {
      try { return [JSON.parse(line) as T]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function normalizeContact(value: string): string {
  return value.replace(/^@/, "").trim().toLowerCase();
}

export function isSnapchatConversationUiArtifact(value: string): boolean {
  const normalized = value
    .trim()
    .replace(/^(?:contact|received|you|me|from [^:]+):\s*/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  return /^(?:snap envelop(?:e)?|tap to view|tap to open|story sent|new chats?(?:\s+\d+\s*(?:s|sec(?:onds)?|m|min(?:utes)?|h|hr(?:ours)?|d|days?))?|\d+\s+new chats?(?:\s+\d+\s*(?:s|sec(?:onds)?|m|min(?:utes)?|h|hr(?:ours)?|d|days?))?)$/i.test(normalized);
}

function parseTime(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function isOutgoingDeliveredAudit(entry: SnapchatUnansweredAuditEntry): boolean {
  return entry.stage === "unread-list" &&
    /^Snapchat marks the row Delivered\b/i.test(entry.reason);
}

function isConversationFailure(entry: SnapchatUnansweredAuditEntry): boolean {
  return Boolean(entry.contactName?.trim()) &&
    !LEGACY_NON_CONVERSATION_STAGES.has(entry.stage) &&
    !isOutgoingDeliveredAudit(entry);
}

function cleanSnapshot(
  capturedMessages: string[],
  conversation: SnapchatConversation,
): SnapshotMessage[] {
  const lines = capturedMessages.map(line => line.trim()).filter(Boolean);
  const hasSafetyPrompt = lines.some(line =>
    /^you and .+ don.t have many mutual friends/i.test(line),
  );
  const sentTexts = new Set(
    conversation.messages
      .filter(message => message.sender === "Luna")
      .map(message => normalizeContact(message.text)),
  );
  const aliases = new Set(conversation.aliases.map(normalizeContact));

  return lines.flatMap(rawLine => {
    let text = rawLine;
    let sender: SnapshotMessage["sender"] = "Contact";

    const directedLine = text.match(/^(?:you|me)\s*(?:sent|said)?\s*:\s*(.+)$/i);
    if (directedLine) {
      sender = "Luna";
      text = directedLine[1].trim();
    } else {
      const receivedLine = text.match(/^(?:received|from [^:]+|contact)\s*:\s*(.+)$/i);
      if (receivedLine) text = receivedLine[1].trim();
    }

    const normalized = normalizeContact(text);
    if (
      !normalized ||
      isSnapchatConversationUiArtifact(text) ||
      aliases.has(normalized) ||
      sentTexts.has(normalized) ||
      /^draft intended:/i.test(text) ||
      /^don.t miss chats from .+enable notifications!?$/i.test(text) ||
      /^you and .+ don.t have many mutual friends/i.test(text) ||
      /^@?.+ has not added you as a friend yet/i.test(text) ||
      /^you are now friends\b/i.test(text) ||
      /^double[\s-]+tap to snap$/i.test(text) ||
      /^(?:new chat|unread|received|opened|delivered|sent)(?:\s+\d+\s*(?:s|sec|m|min|h|hr|d|day)s?)?$/i.test(text) ||
      /^(?:report or block|report or block|camera|stickers|memories|games|start an audio call|start a video call|send a chat|send chat|map|stories|spotlight|search|notification|add friends?)$/i.test(text) ||
      /^boundlus\.com$/i.test(text) ||
      /\|\s*boundlus$/i.test(text) ||
      (hasSafetyPrompt && /^(?:ok|okay)$/i.test(text))
    ) {
      return [];
    }
    if (sender === "Luna") return [];
    return [{ sender, text }];
  });
}

function snapshotKey(message: SnapshotMessage): string {
  return `${message.sender}\u0000${normalizeContact(message.text)}`;
}

function getNewSnapshotMessages(previous: string[], current: SnapshotMessage[]): SnapshotMessage[] {
  if (!previous.length) return current;
  const currentKeys = current.map(snapshotKey);
  const lengths = Array.from({ length: previous.length + 1 }, () =>
    Array<number>(currentKeys.length + 1).fill(0),
  );
  for (let i = previous.length - 1; i >= 0; i--) {
    for (let j = currentKeys.length - 1; j >= 0; j--) {
      lengths[i][j] = previous[i] === currentKeys[j]
        ? lengths[i + 1][j + 1] + 1
        : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const additions: SnapshotMessage[] = [];
  let i = 0;
  let j = 0;
  while (i < previous.length && j < currentKeys.length) {
    if (previous[i] === currentKeys[j]) {
      i++;
      j++;
    } else if (lengths[i][j + 1] >= lengths[i + 1][j]) {
      additions.push(current[j]);
      j++;
    } else {
      i++;
    }
  }
  while (j < current.length) additions.push(current[j++]);
  return additions;
}

function appendSnapshot(
  conversation: SnapchatConversation,
  capturedMessages: string[],
  observedAt: string,
): SnapshotMessage[] {
  const snapshot = cleanSnapshot(capturedMessages, conversation);
  const fresh = getNewSnapshotMessages(conversation.lastSnapshot, snapshot);
  for (const message of fresh) {
    conversation.messages.push({
      sender: "Contact",
      text: message.text,
      timestamp: observedAt,
      timestampKind: "observed",
      sequence: conversation.nextSequence++,
    });
  }
  if (snapshot.length) conversation.lastSnapshot = snapshot.map(snapshotKey);
  return snapshot;
}

function findOrCreateConversation(
  conversations: SnapchatConversation[],
  identity: {
    slotId: string;
    serial: string;
    accountUsername?: string;
    username: string;
    displayName: string;
  },
): SnapchatConversation {
  const aliases = [...new Set([identity.username, identity.displayName]
    .map(normalizeContact)
    .filter(Boolean))];
  let conversation = conversations.find(existing =>
    existing.slotId === identity.slotId &&
    existing.serial === identity.serial &&
    aliases.some(alias => existing.aliases.includes(alias)),
  );
  if (!conversation) {
    conversation = {
      slotId: identity.slotId,
      serial: identity.serial,
      accountUsername: identity.accountUsername,
      username: identity.username || identity.displayName || "Unknown",
      displayName: identity.displayName || identity.username || "Unknown",
      aliases,
      messages: [],
      lastSnapshot: [],
      updatedAt: "",
      nextSequence: 1,
    };
    conversations.push(conversation);
  } else {
    for (const alias of aliases) {
      if (!conversation.aliases.includes(alias)) conversation.aliases.push(alias);
    }
    if (
      identity.username &&
      (!conversation.username ||
        normalizeContact(identity.username) !== normalizeContact(identity.displayName))
    ) {
      conversation.username = identity.username;
    }
    conversation.displayName ||= identity.displayName;
    if (identity.accountUsername) conversation.accountUsername = identity.accountUsername;
  }
  return conversation;
}

function addReply(
  conversations: SnapchatConversation[],
  entry: Omit<SnapchatReplyHistoryEntry, "replyNumber"> & { replyNumber?: number; capturedAt?: string },
): SnapchatReplyHistoryEntry {
  const aliases = new Set([entry.username, entry.displayName].map(normalizeContact).filter(Boolean));
  const highestReplyNumber = conversations
    .filter(conversation =>
      conversation.slotId === entry.slotId &&
      [...aliases].some(alias => conversation.aliases.includes(alias)),
    )
    .flatMap(conversation => conversation.messages)
    .reduce((max, message) =>
      Math.max(max, message.sender === "Luna" ? message.replyNumber ?? 0 : 0),
    0);
  const conversation = findOrCreateConversation(conversations, {
    slotId: entry.slotId,
    serial: entry.serial,
    accountUsername: entry.accountUsername,
    username: entry.username,
    displayName: entry.displayName,
  });
  appendSnapshot(
    conversation,
    entry.capturedMessages,
    entry.capturedAt || entry.sentAt,
  );
  const replyNumber = entry.replyNumber ?? highestReplyNumber + 1;
  conversation.messages.push({
    sender: "Luna",
    text: entry.sentText,
    timestamp: entry.sentAt,
    timestampKind: "sent",
    sequence: conversation.nextSequence++,
    replyNumber,
  });
  conversation.updatedAt = entry.sentAt;
  return { ...entry, replyNumber };
}

function addFailure(
  conversations: SnapchatConversation[],
  entry: SnapchatUnansweredAuditEntry,
): void {
  if (!isConversationFailure(entry)) return;
  const conversation = findOrCreateConversation(conversations, {
    slotId: entry.slotId,
    serial: entry.serial,
    accountUsername: entry.accountUsername,
    username: entry.contactName,
    displayName: entry.contactName,
  });
  appendSnapshot(conversation, entry.capturedMessages, entry.recordedAt);
  const duplicate = conversation.messages.some(message =>
    message.sender === "FAILED" &&
    message.timestamp === entry.recordedAt &&
    message.reason === entry.reason,
  );
  if (duplicate) return;
  conversation.messages.push({
    sender: "FAILED",
    text: "FAILED",
    timestamp: entry.recordedAt,
    timestampKind: "failed",
    sequence: conversation.nextSequence++,
    reason: entry.reason,
  });
  conversation.updatedAt = entry.recordedAt;
}

function sortConversations(conversations: SnapchatConversation[]): SnapchatConversation[] {
  return conversations
    .map(conversation => ({
      ...conversation,
      messages: [...conversation.messages].sort((a, b) =>
        parseTime(b.timestamp) - parseTime(a.timestamp) || b.sequence - a.sequence,
      ),
    }))
    .sort((a, b) => parseTime(b.updatedAt) - parseTime(a.updatedAt));
}

function writeConversations(conversations: SnapchatConversation[]): void {
  const filePath = storePath();
  const tempPath = `${filePath}.tmp`;
  const ordered = sortConversations(conversations);
  fs.writeFileSync(
    tempPath,
    ordered.map(conversation => JSON.stringify(conversation)).join("\n") + (ordered.length ? "\n" : ""),
    "utf8",
  );
  fs.renameSync(tempPath, filePath);
}

function archiveLegacyFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const backupPath = `${filePath}.migrated-backup`;
  if (fs.existsSync(backupPath)) return;
  try { fs.renameSync(filePath, backupPath); } catch { /* Keep the original as a backup if it cannot be moved. */ }
}

function readConversations(): SnapchatConversation[] {
  const filePath = storePath();
  if (fs.existsSync(filePath)) {
    return readJsonLines<SnapchatConversation>(filePath);
  }

  const replies = readJsonLines<SnapchatReplyHistoryEntry>(legacyReplyPath());
  const failures = readJsonLines<SnapchatUnansweredAuditEntry>(legacyFailurePath())
    .filter(isConversationFailure);
  const events: LegacyEvent[] = [
    ...replies.map(entry => ({ kind: "reply" as const, timestamp: entry.sentAt, entry })),
    ...failures.map(entry => ({ kind: "failure" as const, timestamp: entry.recordedAt, entry })),
  ].sort((a, b) => parseTime(a.timestamp) - parseTime(b.timestamp));
  const conversations: SnapchatConversation[] = [];
  for (const event of events) {
    if (event.kind === "reply") {
      addReply(conversations, event.entry);
    } else {
      addFailure(conversations, event.entry);
    }
  }

  // Keep legacy source files as backups, but make the bundled conversation store canonical.
  writeConversations(conversations);
  archiveLegacyFile(legacyReplyPath());
  archiveLegacyFile(legacyFailurePath());
  return sortConversations(conversations);
}

function formatHistoryTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "TIME UNKNOWN";
  const twoDigits = (part: number) => String(part).padStart(2, "0");
  return `${twoDigits(date.getUTCHours())}:${twoDigits(date.getUTCMinutes())}-${twoDigits(date.getUTCDate())}/${twoDigits(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
}

function formatConversation(conversation: SnapchatConversation): string {
  const messages = [...conversation.messages].sort((a, b) =>
    parseTime(a.timestamp) - parseTime(b.timestamp) || a.sequence - b.sequence,
  );
  const hasAccountUsername = conversation.accountUsername &&
    conversation.accountUsername !== conversation.slotId;
  const accountSlot = hasAccountUsername
    ? conversation.accountUsername.startsWith("@")
      ? conversation.accountUsername
      : `@${conversation.accountUsername}`
    : conversation.slotId || "Unknown";
  const messageLines = messages.flatMap(message => {
    const timestamp = formatHistoryTimestamp(message.timestamp);
    if (message.sender === "Luna") {
      return [
        `MESSAGE ${message.replyNumber ?? "?"} | ${timestamp} | Luna`,
        message.text,
      ];
    }
    if (message.sender === "FAILED") {
      return [`FAILED | ${timestamp} | ${message.reason || "Reply was not sent."}`];
    }
    return [`SEEN ${timestamp} | ${conversation.displayName}: ${message.text}`];
  });
  return [
    `Username: ${conversation.username || conversation.displayName || "Unknown"}`,
    `Device ID: ${conversation.serial || "Unknown"}`,
    `Account slot: ${accountSlot}`,
    ...messageLines,
    "",
    "------------------------------------------------------------",
    "",
  ].join("\n");
}

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

export function getSnapchatReplyHistory(slotId: string, contactKey: string): {
  previousReplyCount: number;
  sentReplies: Array<{ replyNumber: number; capturedMessages: string[]; sentText: string }>;
} {
  const expected = normalizeContact(contactKey);
  const conversations = readConversations().filter(entry =>
    entry.slotId === slotId &&
    entry.aliases.includes(expected),
  );
  const replies = conversations.flatMap(conversation =>
    conversation.messages
      .filter(message => message.sender === "Luna" && message.timestampKind === "sent")
      .map(message => ({ conversation, message })),
  ).sort((a, b) =>
    (a.message.replyNumber ?? 0) - (b.message.replyNumber ?? 0) ||
    parseTime(a.message.timestamp) - parseTime(b.message.timestamp),
  );
  return {
    previousReplyCount: replies.reduce((max, item) => Math.max(max, item.message.replyNumber ?? 0), 0),
    sentReplies: replies.slice(-10).map(({ conversation, message }) => ({
      replyNumber: message.replyNumber ?? 0,
      capturedMessages: conversation.messages
        .filter(prior =>
          prior.sender === "Contact" && prior.sequence < message.sequence,
        )
        .map(prior => prior.text)
        .filter(text => !isSnapchatConversationUiArtifact(text)),
      sentText: message.text,
    })),
  };
}

export function exportSnapchatReplyHistory(slotId: string): string {
  const conversations = readConversations().filter(conversation => conversation.slotId === slotId);
  return conversations.length
    ? conversations.map(formatConversation).join("")
    : "No Snapchat conversations recorded for this account slot.\n";
}

export function exportAllSnapchatReplyHistory(): string {
  const conversations = readConversations();
  return conversations.length
    ? conversations.map(formatConversation).join("")
    : "No Snapchat conversations recorded.\n";
}

export function clearSnapchatReplyHistory(slotId: string): void {
  writeConversations(readConversations().filter(conversation => conversation.slotId !== slotId));
  for (const filePath of [legacyReplyPath(), legacyFailurePath()]) {
    const backupPath = `${filePath}.migrated-backup`;
    if (!fs.existsSync(backupPath)) continue;
    const remaining = readJsonLines<{ slotId?: string }>(backupPath)
      .filter(entry => entry.slotId !== slotId);
    const tempPath = `${backupPath}.tmp`;
    fs.writeFileSync(
      tempPath,
      remaining.map(entry => JSON.stringify(entry)).join("\n") + (remaining.length ? "\n" : ""),
      "utf8",
    );
    fs.renameSync(tempPath, backupPath);
  }
}

export function appendSnapchatReplyHistory(
  entry: Omit<SnapchatReplyHistoryEntry, "replyNumber"> & { capturedAt?: string },
): SnapchatReplyHistoryEntry {
  const conversations = readConversations();
  const record = addReply(conversations, entry);
  writeConversations(conversations);
  return record;
}

export function appendSnapchatConversationFailure(entry: SnapchatUnansweredAuditEntry): void {
  if (!isConversationFailure(entry)) return;
  const conversations = readConversations();
  addFailure(conversations, entry);
  writeConversations(conversations);
}
