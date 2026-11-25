import { createHash, randomUUID } from "node:crypto";
import * as android from "../../../androidManager";
import { storage } from "../../../../storage";
import {
  appendSnapchatConversationFailure,
  appendSnapchatReplyHistory,
  containsSnapchatBoundlusLink,
  getSnapchatReplyHistory,
} from "../../../snapchatReplyHistory";
import { generateSnapchatLunaReply } from "../../../snapchatLuna";
import type { SnapchatContext, UiNode, UiState } from "../context";
import { exitSnapchatConversation, hasNotAddedFriendNotice } from "../navigation/exitConversation";
import { dismissAdExperiencePrompt, isAdExperiencePrompt } from "../navigation/dismissAdExperiencePrompt";
import { recoverFromUnreadSnapViewer } from "../navigation/recoverUnreadSnapViewer";
import { waitForUnreadTab } from "../navigation/openUnreadTab";
import {
  center,
  dump,
  exactClickable,
  logAction,
  nodeLabel,
  randomCount,
  shortResourceId,
  tapExact,
} from "../runtime";
import {
  normalizeSnapchatContactLabel,
  stripSnapchatPeerNamePrefix,
} from "./replyUnreadChatText";
import {
  contactNameFromNode,
  findChatComposer,
  isGenericContactLabel,
  verifyUnreadConversationIdentity,
} from "./replyUnreadChatIdentity";

const normalizedText = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
const comparableMessageText = (value: string) => value
  .replace(/^(?:luna|contact|you|me|received|from [^:]+)\s*(?::|sent|said)\s*/i, "")
  .normalize("NFKC")
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .trim();
const isEmptyComposerValue = (value: string) => {
  const normalized = normalizedText(value);
  return !normalized || normalized === "send a chat" || normalized === "send chat";
};
const countLinksInText = (value: string) =>
  value.match(/\b(?:https?:\/\/|www\.)[^\s<>"']+|\b(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,}(?:\/[^\s<>"']*)?/giu)?.length ?? 0;
function normalizePromptPhrase(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function ignoredPromptPhrases(goal: string): string[] {
  const lines = goal.split(/\r?\n/);
  const headingIndex = lines.findIndex(line =>
    normalizePromptPhrase(line.replace(/^[-•*]\s*/, "")) === "ignore the following",
  );
  if (headingIndex < 0) return [];
  const phrases: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (phrases.length) break;
      continue;
    }
    if (!/^[-•*]\s*/.test(trimmed)) break;
    const phrase = normalizePromptPhrase(trimmed.replace(/^[-•*]\s*/, ""));
    if (phrase) phrases.push(phrase);
  }
  return phrases;
}

function filterPromptIgnoredTranscript(
  transcript: string[],
  goal: string,
): { messages: string[]; ignoredCount: number } {
  const phrases = ignoredPromptPhrases(goal);
  if (!phrases.length) return { messages: transcript, ignoredCount: 0 };
  const messages = transcript.filter(line => {
    const normalized = comparableMessageText(line).replace(/[^a-z0-9]+/g, " ").trim();
    return !phrases.some(phrase =>
      normalized === phrase ||
      normalized.includes(phrase) ||
      (normalized.length >= 12 && (phrase.startsWith(normalized) || phrase.endsWith(normalized))),
    );
  });
  return { messages, ignoredCount: transcript.length - messages.length };
}

async function waitForChatComposer(
  context: SnapchatContext,
  initialState: UiState,
  screenHeight: number,
): Promise<{ state: UiState; composer: UiNode } | undefined> {
  let state = initialState;
  for (let attempt = 0; attempt < 6 && !context.isAborted(); attempt++) {
    const composer = findChatComposer(state.nodes, screenHeight);
    if (composer) return { state, composer };
    if (attempt < 5) {
      await context.sleep(350, "exact");
      state = await dump(context.serial);
    }
  }
  return undefined;
}

function senderFromDescription(
  description: string,
  peerName: string,
): "Luna" | "Contact" | undefined {
  const leadingLabel = description.trim().split(/[,\n:|]/, 1)[0].trim();
  if (/^(?:me|you|luna|you sent|sent by you)$/i.test(leadingLabel)) return "Luna";
  if (peerName && normalizeSnapchatContactLabel(leadingLabel) === normalizeSnapchatContactLabel(peerName)) {
    return "Contact";
  }
  return undefined;
}

function visibleConversation(
  nodes: UiNode[],
  composerTop: number,
  peerName: string,
  headerBottom = 0,
): string[] {
  const excluded = /^(send|chat|call|video|audio|camera|back|more|typing|delivered|opened|seen|unread|new snap|today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|message|me|you|you sent|sent by you)$/i;
  const seen = new Set<string>();
  return nodes
    .filter(node =>
      node.bounds[1] >= Math.max(220, headerBottom + 12) &&
      node.bounds[1] < composerTop &&
      !/edittext/i.test(node.className) &&
      (!node.text.trim() || !isGenericContactLabel(node.text, node)) &&
      (!node.desc.trim() || !isGenericContactLabel(node.desc, node)),
    )
    .sort((a, b) => a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0])
    .map(node => {
      const text = node.text.trim();
      const description = node.desc.trim();
      const textPeerMessage = stripSnapchatPeerNamePrefix(node.text, peerName);
      if (textPeerMessage !== undefined) return `Contact: ${textPeerMessage}`;
      const descriptionPeerMessage = stripSnapchatPeerNamePrefix(node.desc, peerName);
      if (descriptionPeerMessage !== undefined) return `Contact: ${descriptionPeerMessage}`;
      const sender = senderFromDescription(description, peerName);
      if (text && sender) return `${sender}: ${text}`;
      if (text && description && description.toLowerCase() !== text.toLowerCase() &&
          /\b(sent|received|from|you|message|snap)\b/i.test(description)) {
        return `${description}: ${text}`;
      }
      return text || description;
    })
    .filter(text => {
      const key = text.toLowerCase().replace(/\s+/g, " ");
      const messageText = text.replace(/^(?:luna|contact)\s*:\s*/i, "").trim();
      if (!key || excluded.test(messageText) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(-25);
}

function labelConversationForLuna(
  transcript: string[],
  sentReplies: Array<{ sentText: string }>,
): { transcript: string[]; latestIncomingMessage: string } {
  const knownLunaMessages = new Set(sentReplies.map(reply => comparableMessageText(reply.sentText)));
  const labelled = transcript.flatMap(line => {
    const text = line.trim();
    if (!text) return [];
    const explicitLuna = text.match(/^(?:luna|you|me)(?:\s+sent|\s+said)?\s*:\s*(.+)$/i);
    const explicitContact = text.match(/^(?:contact|received|from [^:]+)(?:\s+sent|\s+said)?\s*:\s*(.+)$/i);
    const message = explicitLuna?.[1]?.trim() ?? explicitContact?.[1]?.trim() ?? text;
    const fromLuna = Boolean(explicitLuna) || (
      !explicitContact && knownLunaMessages.has(comparableMessageText(message))
    );
    return [{
      sender: fromLuna ? "Luna" as const : "Contact" as const,
      text: message,
      labelled: `${fromLuna ? "Luna" : "Contact"}: ${message}`,
    }];
  });
  const latestIncomingMessage = [...labelled].reverse().find(message => message.sender === "Contact")?.text ?? "";
  return {
    transcript: labelled.map(message => message.labelled),
    latestIncomingMessage,
  };
}

function formatKeyboardFailureDiagnostic(
  failure: Awaited<ReturnType<typeof android.typeViaSavedCalibrationMap>>["failure"],
): string {
  if (!failure) return "keyboard layer transition failed but the typing engine returned no failure details";
  const details = [
    `phase=${failure.phase}`,
    failure.fromLayer ? `from=${failure.fromLayer}` : "",
    failure.targetLayer ? `target=${failure.targetLayer}` : "",
    failure.transitionStep ? `step=${failure.transitionStep}` : "",
    `control=${failure.control}`,
    `cause=${failure.code}`,
    failure.x !== undefined && failure.y !== undefined ? `point=(${failure.x},${failure.y})` : "",
    failure.error ? `error=${failure.error}` : "",
  ].filter(Boolean);
  const failureLabel = failure.phase === "preflight"
    ? "keyboard calibration preflight failed"
    : "keyboard layer transition failed";
  return `${failureLabel} (${details.join("; ")})`;
}

async function tapUnreadChatNameArea(
  context: SnapchatContext,
  row: ReturnType<typeof unreadChatRows>[number],
  screenWidth: number,
): Promise<boolean> {
  if (context.isAborted()) return false;
  if (row.chatActionNode) {
    const { x, y } = center(row.chatActionNode);
    context.onLog(`Reply to Unread Chats: "${row.displayName}" has mixed media and chat activity; tapping its live chat-only icon bounds=[${row.chatActionNode.bounds.join(",")}] at (${x},${y}).`);
    await android.tap(context.serial, x, y, "bot", `Snapchat: open chat-only action for ${row.displayName}`, "automation", { exact: true });
    await context.sleep(700);
    return !context.isAborted();
  }
  const [rowLeft, rowTop, rowRight, rowBottom] = row.marker?.bounds ?? [
    0,
    row.statusNode.bounds[1],
    screenWidth,
    row.statusNode.bounds[3],
  ];
  const rowWidth = rowRight - rowLeft;
  const x = Math.round(rowWidth >= screenWidth * 0.6 ? rowLeft + rowWidth / 2 : screenWidth / 2);
  const tapAnchor = row.nameNode ?? row.statusNode;
  const anchorCenter = center(tapAnchor);
  const y = Math.max(rowTop + 1, Math.min(rowBottom - 1, anchorCenter.y));
  context.onLog(`Reply to Unread Chats: tapping the live row for "${row.displayName}" from unread label "${row.statusLabel}" at (${x},${y}); row=${row.marker ? `[${row.marker.bounds.join(",")}]` : "status-label bounds"}, anchor=[${tapAnchor.bounds.join(",")}].`);
  await android.tap(context.serial, x, y, "bot", `Snapchat: open unread chat for ${row.displayName}`, "automation", { exact: true });
  await context.sleep(700);
  return !context.isAborted();
}

type UnreadChatStatus = "chat" | "mixed" | "story" | "media";

function unreadChatStatus(value: string): UnreadChatStatus | undefined {
  if (/\b(?:(?:\d+)\s+)?new chats?\b/i.test(value)) return "chat";
  if (/\b(?:\d+\s+)?snaps?\s+and\s+chats?\b/i.test(value)) return "mixed";
  if (/\breplied to your chats?\b/i.test(value)) return "chat";
  if (/\breplied to your stor(?:y|ies)\b/i.test(value)) return "story";
  if (/\b(?:new|unread)\b.*\b(?:snaps?|photos?|videos?)\b/i.test(value)) return "media";
  return undefined;
}

function unreadChatRows(
  nodes: UiNode[],
  replyToEverything = false,
) {
  const rowMarkers = nodes.filter(node => /ff_item/i.test(shortResourceId(node)));
  const candidates = new Map<string, {
    marker?: UiNode;
    nameNode?: UiNode;
    statusNode: UiNode;
    statusLabel: string;
    status: UnreadChatStatus;
    displayName: string;
    key: string;
    chatActionNode?: UiNode;
    preview: string[];
  }>();

  for (const statusNode of nodes) {
    const statusLabel = [statusNode.text, statusNode.desc]
      .map(value => value.trim())
      .find(value => unreadChatStatus(value));
    if (!statusLabel) continue;

    const status = unreadChatStatus(statusLabel);
    if (!status || (status === "media" && !replyToEverything)) continue;

    const marker = rowMarkers
      .filter(candidate =>
        candidate.bounds[0] <= statusNode.bounds[0] &&
        candidate.bounds[1] <= statusNode.bounds[1] &&
        candidate.bounds[2] >= statusNode.bounds[2] &&
        candidate.bounds[3] >= statusNode.bounds[3],
      )
      .sort((left, right) =>
        (left.bounds[2] - left.bounds[0]) * (left.bounds[3] - left.bounds[1]) -
        (right.bounds[2] - right.bounds[0]) * (right.bounds[3] - right.bounds[1]),
      )[0];
    const statusY = center(statusNode).y;
    const rowNodes = marker
      ? nodes.filter(node =>
          node.bounds[0] >= marker.bounds[0] &&
          node.bounds[1] >= marker.bounds[1] &&
          node.bounds[2] <= marker.bounds[2] &&
          node.bounds[3] <= marker.bounds[3],
        )
      : nodes.filter(node =>
          Math.abs(center(node).y - statusY) <= 130 &&
          Math.abs(center(node).x - center(statusNode).x) <= 520,
        );
    const nameCandidates = rowNodes
      .map(node => ({ node, displayName: contactNameFromNode(node) }))
      .filter((candidate): candidate is { node: UiNode; displayName: string } => {
        const { node, displayName } = candidate;
        if (!displayName || node === statusNode || unreadChatStatus(displayName)) return false;
        if (/^(unread|received|sent|opened|new|camera|chat)$/i.test(displayName)) return false;
        return true;
      })
      .sort((left, right) => {
        const leftY = center(left.node).y;
        const rightY = center(right.node).y;
        const leftIsAbove = leftY <= statusY;
        const rightIsAbove = rightY <= statusY;
        if (leftIsAbove !== rightIsAbove) return leftIsAbove ? -1 : 1;
        return Math.abs(statusY - leftY) - Math.abs(statusY - rightY);
      });
    const nameCandidate = nameCandidates[0];
    if (!nameCandidate) continue;
    const { node: nameNode, displayName } = nameCandidate;
    const key = `name:${normalizedText(displayName)}:${status}`;
    const rowHeight = marker ? marker.bounds[3] - marker.bounds[1] : 0;
    const chatActionNode = (status === "mixed" || status === "media") && marker
      ? rowNodes.find(node =>
          /feed_chat_button/i.test(`${node.text} ${node.desc} ${node.resourceId}`) &&
          node.bounds[0] >= marker.bounds[0] + rowHeight * 0.65,
        )
      : undefined;
    const nameBottom = nameNode.bounds[3];
    const preview = rowNodes
      .filter(node =>
        node !== nameNode &&
        node !== statusNode &&
        !node.clickable &&
        node.bounds[1] >= nameBottom,
      )
      .map(node => node.text.trim())
      .filter(Boolean);
    const candidateKey = marker
      ? `row:${marker.bounds.join(",")}`
      : key;

    if (!candidates.has(candidateKey)) {
      candidates.set(candidateKey, {
        marker,
        nameNode,
        statusNode,
        statusLabel,
        status,
        displayName,
        key,
        chatActionNode,
        preview,
      });
    }
  }

  return [...candidates.values()];
}

async function openUnreadChatFromLiveList(
  context: SnapchatContext,
  targetRow: ReturnType<typeof unreadChatRows>[number],
  screenWidth: number,
  screenHeight: number,
  replyToEverything: boolean,
): Promise<{
  state: UiState;
  tapped: boolean;
  stillOnChatList: boolean;
  targetStillVisible: boolean;
}> {
  return android.withInputTransaction(context.serial, async () => {
    let state = await dump(context.serial);
    let tapped = false;
    for (let attempt = 1; attempt <= 2 && !context.isAborted(); attempt++) {
      const stillOnChatList =
        Boolean(exactClickable(state.nodes, ["Chat"])) &&
        !findChatComposer(state.nodes, screenHeight);
      if (!stillOnChatList) {
        return { state, tapped, stillOnChatList: false, targetStillVisible: false };
      }

      const liveRows = unreadChatRows(state.nodes, replyToEverything).filter(row =>
        row.status === targetRow.status &&
        normalizedText(row.statusLabel) === normalizedText(targetRow.statusLabel) &&
        normalizedText(row.displayName) === normalizedText(targetRow.displayName),
      );
      if (liveRows.length !== 1) {
        return {
          state,
          tapped,
          stillOnChatList: true,
          targetStillVisible: liveRows.length > 0,
        };
      }
      const liveRow = liveRows[0];

      if (attempt > 1) {
        context.onLog(`Reply to Unread Chats: "${targetRow.displayName}" is still in the live Unread list after the first tap; retrying once with refreshed row bounds.`);
      }
      if (!await tapUnreadChatNameArea(context, liveRow, screenWidth)) {
        return { state, tapped, stillOnChatList: true, targetStillVisible: true };
      }
      tapped = true;
      state = await dump(context.serial);

      const remainsOnList =
        Boolean(exactClickable(state.nodes, ["Chat"])) &&
        !findChatComposer(state.nodes, screenHeight);
      if (!remainsOnList) {
        return { state, tapped, stillOnChatList: false, targetStillVisible: false };
      }

      const targetStillVisible = unreadChatRows(state.nodes, replyToEverything).some(row =>
        row.status === targetRow.status &&
        normalizedText(row.statusLabel) === normalizedText(targetRow.statusLabel) &&
        normalizedText(row.displayName) === normalizedText(targetRow.displayName),
      );
      if (!targetStillVisible || attempt === 2) {
        return { state, tapped, stillOnChatList: true, targetStillVisible };
      }
    }

    return {
      state,
      tapped,
      stillOnChatList:
        Boolean(exactClickable(state.nodes, ["Chat"])) &&
        !findChatComposer(state.nodes, screenHeight),
      targetStillVisible: false,
    };
  });
}

async function handleNotAddedFriendNotice(
  context: SnapchatContext,
  displayName: string,
  state: UiState,
): Promise<"not-present" | "exited" | "exit-failed"> {
  if (!hasNotAddedFriendNotice(state)) return "not-present";
  context.onLog(`Reply to Unread Chats: Snapchat says ${displayName} has not added this account; skipping the reply and exiting with two Android Back presses.`);
  const exited = await exitSnapchatConversation(context).catch(() => false);
  if (!exited) {
    context.onLog(`Reply to Unread Chats stopped: could not exit ${displayName}'s conversation after Snapchat showed the friend notice.`);
    return "exit-failed";
  }
  return "exited";
}

async function generateContextualReply(
  goal: string,
  peer: string,
  transcript: string[],
  history: ReturnType<typeof getSnapchatReplyHistory>,
  latestIncomingMessage: string,
): Promise<string> {
  const settings = await storage.getGlobalSettings();
  const apiKey = String((settings as any).openaiApiKey ?? "").trim() || (process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) throw new Error("Add an OpenAI API key in Settings → Security.");
  return generateSnapchatLunaReply(apiKey, goal, peer, transcript, history, latestIncomingMessage);
}

export async function runReplyUnreadChats(context: SnapchatContext): Promise<void> {
  const requested = randomCount(context.tools.replyUnreadChats.min, context.tools.replyUnreadChats.max);
  return runReplyUnreadChatsAttempt(context, requested, false);
}

async function recoverAdExperiencePromptAfterChatMiss(
  context: SnapchatContext,
  state: UiState,
  retryAlreadyUsed: boolean,
): Promise<{
  action: "continue" | "retry-tool" | "stop";
  state: UiState;
}> {
  if (!isAdExperiencePrompt(state)) return { action: "continue", state };

  const clearedState = await dismissAdExperiencePrompt(
    context,
    state,
    () => dump(context.serial),
  );
  if (isAdExperiencePrompt(clearedState)) return { action: "stop", state: clearedState };
  return {
    action: retryAlreadyUsed ? "continue" : "retry-tool",
    state: clearedState,
  };
}

async function runReplyUnreadChatsAttempt(
  context: SnapchatContext,
  requested: number,
  adPopupRetryUsed: boolean,
): Promise<void> {
  const { enabled, replyGoal, replyToEverything } = context.tools.replyUnreadChats;
  const promptFingerprint = `sha256:${createHash("sha256").update(replyGoal, "utf8").digest("hex").slice(0, 16)}`;
  if (!enabled || requested === 0) return;
  logAction(context, `Reply to up to ${requested} unread chats`);
  if (adPopupRetryUsed) {
    context.onLog("Reply to Unread Chats: restarting once after clearing Snapchat's ad-experience prompt.");
  }
  context.onLog(
    `Reply to Unread Chats: Reply to everything is ${replyToEverything ? "on (media rows open through the conversation icon)" : "off (media-only rows stay excluded)"}.`,
  );
  context.onLog(`Reply to Unread Chats: target ${requested} unread contact(s), one reply per contact.`);
  if (!context.slotId) {
    context.onLog("Reply to Unread Chats stopped: this Snapchat slot has no stable saved ID for private history.");
    logAction(context, "0 replies sent; the slot has no saved history ID");
    return;
  }
  const slotId = context.slotId;
  if (!replyGoal.trim()) {
    context.onLog("Reply to Unread Chats skipped: add a conversation goal in Snapchat Step 2 first.");
    logAction(context, "0 replies sent; no conversation goal is configured");
    return;
  }
  const recordedSkips = new Set<string>();
  let activeContact: {
    displayName: string;
    stage: string;
    capturedMessages: string[];
    attemptId: string;
    verifiedUsername?: string;
  } | null = null;
  const recordNotReplied = (
    displayName: string,
    stage: string,
    reason: string,
    capturedMessages: string[] = [],
    persist = true,
  ) => {
    const matchingActive = activeContact &&
      normalizedText(activeContact.displayName) === normalizedText(displayName)
      ? activeContact
      : null;
    const attemptId = matchingActive?.attemptId;
    if (activeContact && normalizedText(activeContact.displayName) === normalizedText(displayName)) {
      activeContact = null;
    }
    const identity = `${normalizedText(displayName)}:${stage}:${reason}`;
    if (recordedSkips.has(identity)) return;
    recordedSkips.add(identity);
    context.onLog(
      `${attemptId ? `[Reply attempt=${attemptId}] ` : ""}outcome=skip contact=${JSON.stringify(displayName)} stage=${stage} reason=${JSON.stringify(reason)} savedFailure=${persist}`,
    );
    if (!persist) return;
    try {
      appendSnapchatConversationFailure({
        slotId,
        serial: context.serial,
        accountUsername: context.targetUsername?.trim() || undefined,
        contactName: displayName,
        contactUsername: matchingActive?.verifiedUsername,
        stage,
        reason,
        capturedMessages,
        recordedAt: new Date().toISOString(),
      });
    } catch (error) {
      context.onLog(
        `Reply to Unread Chats warning: could not save the skipped-contact record for "${displayName}" (${error instanceof Error ? error.message : "write failed"}).`,
      );
    }
  };
  if (!await tapExact(context, ["Chat"], "open the chat list")) {
    context.onLog("Reply to Unread Chats skipped: Chat tab was not found.");
    logAction(context, "0 replies sent; the Chat tab was unavailable");
    return;
  }
  let unreadWait = await waitForUnreadTab(context, state =>
    recoverAdExperiencePromptAfterChatMiss(context, state, adPopupRetryUsed),
  );
  if (unreadWait.status === "retry-tool") {
    context.onLog("Reply to Unread Chats: the ad-experience prompt was cleared; restarting the tool once.");
    logAction(context, "0 replies sent; the ad-experience prompt was cleared and the tool restarted");
    return runReplyUnreadChatsAttempt(context, requested, true);
  }
  if (
    unreadWait.status === "missing" &&
    isAdExperiencePrompt(unreadWait.state)
  ) {
    const recovery = await recoverAdExperiencePromptAfterChatMiss(
      context,
      unreadWait.state,
      adPopupRetryUsed,
    );
    if (recovery.action === "retry-tool") {
      context.onLog("Reply to Unread Chats: the ad-experience prompt appeared while waiting; restarting the tool once.");
      logAction(context, "0 replies sent; the ad-experience prompt was cleared and the tool restarted");
      return runReplyUnreadChatsAttempt(context, requested, true);
    }
    if (recovery.action === "stop") {
      context.onLog("Reply to Unread Chats stopped: Snapchat's ad-experience prompt could not be cleared.");
      logAction(context, "0 replies sent; the ad-experience prompt remained open");
      return;
    }
    unreadWait = await waitForUnreadTab(context);
  }
  if (unreadWait.status === "stopped") {
    if (isAdExperiencePrompt(unreadWait.state)) {
      context.onLog("Reply to Unread Chats stopped: Snapchat's ad-experience prompt could not be cleared.");
      logAction(context, "0 replies sent; the ad-experience prompt remained open");
      return;
    }
    logAction(context, "0 replies sent; the Unread list could not be opened");
    return;
  }
  if (unreadWait.status !== "ready") {
    logAction(context, "0 replies sent; the Unread list did not open");
    return;
  }
  let list = unreadWait.state;
  const isConfirmedUnreadList = (state: UiState) =>
    Boolean(exactClickable(state.nodes, ["Chat"])) &&
    !state.nodes.some(node => /edittext/i.test(node.className) && /chat_input_text_field/i.test(node.resourceId));
  if (!isConfirmedUnreadList(list) && isAdExperiencePrompt(list)) {
    const recovery = await recoverAdExperiencePromptAfterChatMiss(context, list, adPopupRetryUsed);
    if (recovery.action === "retry-tool") {
      context.onLog("Reply to Unread Chats: the ad-experience prompt was cleared; restarting the tool once.");
      logAction(context, "0 replies sent; the ad-experience prompt was cleared and the tool restarted");
      return runReplyUnreadChatsAttempt(context, requested, true);
    }
    if (recovery.action === "stop") {
      context.onLog("Reply to Unread Chats stopped: Snapchat's ad-experience prompt could not be cleared.");
      logAction(context, "0 replies sent; the ad-experience prompt remained open");
      return;
    }
    list = recovery.state;
  }
  if (!isConfirmedUnreadList(list)) {
    context.onLog("Reply to Unread Chats stopped: the Unread chat list was not confirmed after tapping its tab.");
    logAction(context, "0 replies sent; the Unread list could not be confirmed");
    return;
  }
  const { w: screenWidth, h: screenHeight } = await android.getScreenSizeAsync(context.serial);

  let replied = 0;
  let noMoreEligible = false;
  const visited = new Set<string>();
  const readUnreadRows = (nodes: UiNode[]) => unreadChatRows(nodes, replyToEverything);
  try {
  while (replied < requested && !context.isAborted()) {
    let rows = readUnreadRows(list.nodes);
    for (let retry = 0; rows.length === 0 && retry < 4 && !context.isAborted(); retry++) {
      await context.sleep(500, "exact");
      list = await dump(context.serial);
      rows = readUnreadRows(list.nodes);
    }
    if (rows.length === 0 && isAdExperiencePrompt(list)) {
      const recovery = await recoverAdExperiencePromptAfterChatMiss(context, list, adPopupRetryUsed);
      if (recovery.action === "retry-tool") {
        context.onLog("Reply to Unread Chats: the ad-experience prompt blocked the chat list; restarting the tool once.");
        logAction(context, "0 replies sent; the ad-experience prompt was cleared and the tool restarted");
        return runReplyUnreadChatsAttempt(context, requested, true);
      }
      if (recovery.action === "stop") {
        context.onLog("Reply to Unread Chats stopped: Snapchat's ad-experience prompt could not be cleared.");
        logAction(context, "0 replies sent; the ad-experience prompt remained open");
        return;
      }
      list = recovery.state;
      rows = readUnreadRows(list.nodes);
    }
    context.onLog(`Reply to Unread Chats: found ${rows.length} conversation row(s) from recognized unread labels.`);
    const row = rows.find(item => !visited.has(item.key));
    if (!row) {
      noMoreEligible = true;
      context.onLog("Reply to Unread Chats: no recognized unread-chat label remains in the list.");
      break;
    }
    const identity = row.key;
    if (visited.has(identity)) break;
    visited.add(identity);
    const attemptId = randomUUID().slice(0, 12);
    activeContact = {
      displayName: row.displayName,
      stage: "opening-chat",
      capturedMessages: row.preview,
      attemptId,
    };
    context.onLog(
      `[Reply attempt=${attemptId}] selected contact=${JSON.stringify(row.displayName)} unreadLabel=${JSON.stringify(row.statusLabel)} slotId=${slotId} promptVersion=${promptFingerprint}`,
    );
    const openResult = await openUnreadChatFromLiveList(
      context,
      row,
      screenWidth,
      screenHeight,
      replyToEverything,
    );
    if (isAdExperiencePrompt(openResult.state)) {
      const recovery = await recoverAdExperiencePromptAfterChatMiss(
        context,
        openResult.state,
        adPopupRetryUsed,
      );
      if (recovery.action === "retry-tool") {
        context.onLog("Reply to Unread Chats: Snapchat's ad-experience prompt blocked the chat; restarting the tool once.");
        logAction(context, "0 replies sent; the ad-experience prompt was cleared and the tool restarted");
        return runReplyUnreadChatsAttempt(context, requested, true);
      }
      if (recovery.action === "stop") {
        recordNotReplied(
          row.displayName,
          "opening-chat",
          "Snapchat's ad-experience prompt blocked the conversation and could not be cleared.",
          row.preview,
        );
        logAction(context, `${replied} replies sent; the ad-experience prompt remained open`);
        return;
      }
      activeContact = null;
      visited.delete(identity);
      list = recovery.state;
      continue;
    }
    if (!openResult.tapped) {
      recordNotReplied(
        row.displayName,
        "opening-chat",
        context.isAborted()
          ? "automation was aborted before the live unread row could be tapped."
          : "the contact was no longer visible in a fresh Unread-list scan, so no tap was made.",
        row.preview,
      );
      if (openResult.stillOnChatList && !context.isAborted()) {
        list = openResult.state;
        continue;
      }
      break;
    }
    if (openResult.stillOnChatList) {
      recordNotReplied(
        row.displayName,
        "opening-chat",
        openResult.targetStillVisible
          ? "the contact remained in the Unread list after two exact taps using fresh row bounds; no conversation opened."
          : "the contact left the Unread list, but no conversation composer appeared to confirm it opened.",
        row.preview,
      );
      list = openResult.state;
      continue;
    }
    const openedThread = openResult.state;
    const snapRecovery = await recoverFromUnreadSnapViewer(context, row.displayName, openedThread);
    if (snapRecovery.detected) {
      recordNotReplied(
        row.displayName,
        "opening-chat",
        snapRecovery.list
          ? "a Snap viewer opened instead of the chat, so this contact was skipped."
          : "a Snap viewer opened instead of the chat and the Unread list could not be restored.",
        row.preview,
      );
      if (!snapRecovery.list) break;
      list = snapRecovery.list;
      continue;
    }
    const openedNotice = await handleNotAddedFriendNotice(context, row.displayName, openedThread);
    if (openedNotice === "exited") {
      recordNotReplied(
        row.displayName,
        "friend-status",
        "Snapchat showed that this person has not added the account, so no reply was sent.",
        openedThread.nodes.map(nodeLabel).filter(Boolean).slice(-25),
      );
      list = await dump(context.serial);
      continue;
    }
    if (openedNotice === "exit-failed") {
      recordNotReplied(
        row.displayName,
        "friend-status",
        "Snapchat showed that this person has not added the account, and the conversation could not be exited.",
        openedThread.nodes.map(nodeLabel).filter(Boolean).slice(-25),
      );
      break;
    }
    let thread = await dump(context.serial);
    const threadNotice = await handleNotAddedFriendNotice(context, row.displayName, thread);
    if (threadNotice === "exited") {
      recordNotReplied(
        row.displayName,
        "friend-status",
        "Snapchat showed that this person has not added the account, so no reply was sent.",
        thread.nodes.map(nodeLabel).filter(Boolean).slice(-25),
      );
      list = await dump(context.serial);
      continue;
    }
    if (threadNotice === "exit-failed") {
      recordNotReplied(
        row.displayName,
        "friend-status",
        "Snapchat showed that this person has not added the account, and the conversation could not be exited.",
        thread.nodes.map(nodeLabel).filter(Boolean).slice(-25),
      );
      break;
    }
    const composerResult = await waitForChatComposer(context, thread, screenHeight);
    if (!composerResult) {
      recordNotReplied(
        row.displayName,
        "opening-chat",
        "the chat composer was not available after opening the unread contact.",
        row.preview,
      );
      await exitSnapchatConversation(context).catch(() => false);
      break;
    }
    thread = composerResult.state;
    const identityCheck = await verifyUnreadConversationIdentity(
      context,
      row.displayName,
      screenHeight,
    );
    if (!identityCheck.ok) {
      context.onLog(
        `[Reply attempt=${attemptId}] verified open chat=NO; skipping before history or draft (${identityCheck.reason}).`,
      );
      recordNotReplied(
        row.displayName,
        "verify-contact",
        identityCheck.reason,
        row.preview,
        false,
      );
      await exitSnapchatConversation(context).catch(() => false);
      list = await dump(context.serial);
      continue;
    }
    const verifiedIdentity = identityCheck.value;
    const contactKey = verifiedIdentity.username;
    activeContact.verifiedUsername = verifiedIdentity.username;
    thread = verifiedIdentity.state;
    context.onLog(
      `[Reply attempt=${attemptId}] verified open chat=YES displayName=${JSON.stringify(verifiedIdentity.displayName)} username=@${verifiedIdentity.username} slotId=${slotId}`,
    );
    const composer = verifiedIdentity.composer;
    const screenTranscript = visibleConversation(
      thread.nodes,
      composer.bounds[1],
      verifiedIdentity.displayName,
      verifiedIdentity.headerBottom,
    );
    const { messages: transcript, ignoredCount } = filterPromptIgnoredTranscript(screenTranscript, replyGoal);
    if (ignoredCount) {
      context.onLog(`Reply to Unread Chats: omitted ${ignoredCount} transcript item(s) matching this slot's prompt ignore list.`);
    }
    const transcriptCapturedAt = new Date().toISOString();
    activeContact = {
      displayName: row.displayName,
      stage: "reading-conversation",
      capturedMessages: transcript,
      attemptId,
      verifiedUsername: verifiedIdentity.username,
    };
    if (transcript.length === 0) {
      recordNotReplied(
        row.displayName,
        "reading-conversation",
        "no readable conversation text was available to answer.",
        row.preview,
      );
      const exited = await exitSnapchatConversation(context).catch(() => false);
      if (!exited) {
        context.onLog(`Reply to Unread Chats stopped: could not exit the empty conversation for ${row.displayName}.`);
        break;
      }
      list = await dump(context.serial);
      continue;
    }
    let reply: string;
    const history = getSnapchatReplyHistory(
      context.targetUsername?.trim() || "",
      contactKey,
      verifiedIdentity.displayName,
    );
    context.onLog(
      `[Reply attempt=${attemptId}] history key=account:@${context.targetUsername?.trim() || "unknown"}/contact:@${contactKey}; priorReplies=${history.previousReplyCount}; linkAlreadySent=${history.sentReplies.some(entry => containsSnapchatBoundlusLink(entry.sentText))}; legacyNameOnlyHistory=${history.legacyNameOnlyHistory}`,
    );
    // Legacy name-only records remain separate, but must not block a reply
    // whose contact username was just obtained from the opened profile.
    const modelContext = labelConversationForLuna(transcript, history.sentReplies);
    if (!modelContext.latestIncomingMessage) {
      recordNotReplied(
        row.displayName,
        "reading-conversation",
        "no incoming contact message could be identified in the visible conversation.",
        transcript,
      );
      await exitSnapchatConversation(context).catch(() => false);
      list = await dump(context.serial);
      continue;
    }
    context.onLog(
      `[Reply attempt=${attemptId}] Luna context slotId=${slotId} contact=@${contactKey} newestIncoming=${JSON.stringify(modelContext.latestIncomingMessage)} nextReply=${history.previousReplyCount + 1} promptChars=${replyGoal.length} promptVersion=${promptFingerprint} transcript=${JSON.stringify(modelContext.transcript.slice(-12))} priorReplies=${JSON.stringify(history.sentReplies.map(entry => entry.sentText))}`,
    );
    context.onLog(
      `Reply to Unread Chats: preparing a role-labelled conversation with ${history.sentReplies.length} prior Luna reply record(s); next reply #${history.previousReplyCount + 1}.`,
    );
    const linkReplyIndex = history.sentReplies.findIndex(entry =>
      containsSnapchatBoundlusLink(entry.sentText),
    );
    if (history.previousReplyCount >= 5) {
      recordNotReplied(
        row.displayName,
        "reply-limit",
        "the five-reply conversation limit was already reached.",
        transcript,
      );
      await exitSnapchatConversation(context).catch(() => false);
      list = await dump(context.serial);
      continue;
    }
    if (linkReplyIndex >= 0) {
      const repliesAfterLink = history.sentReplies.length - linkReplyIndex - 1;
      if (repliesAfterLink >= 2) {
        recordNotReplied(
          row.displayName,
          "reply-limit",
          "both post-link supporting replies have already been used.",
          transcript,
        );
        await exitSnapchatConversation(context).catch(() => false);
        list = await dump(context.serial);
        continue;
      }
      context.onLog(
        `Reply to Unread Chats: allowing post-link supporting reply ${repliesAfterLink + 1}/2 for ${row.displayName}.`,
      );
    }
    if (activeContact) activeContact.stage = "drafting-reply";
    try {
      reply = await generateContextualReply(
        replyGoal,
        contactKey,
        modelContext.transcript,
        history,
        modelContext.latestIncomingMessage,
      );
    } catch (error) {
      recordNotReplied(
        row.displayName,
        "drafting-reply",
        error instanceof Error ? error.message : "GPT-6 Luna could not draft a reply.",
        transcript,
      );
      await exitSnapchatConversation(context).catch(() => false);
      break;
    }
    if (!reply) {
      recordNotReplied(
        row.displayName,
        "drafting-reply",
        "GPT-6 Luna returned SKIP or an empty reply.",
        transcript,
      );
      await exitSnapchatConversation(context).catch(() => false);
      list = await dump(context.serial);
      continue;
    }
    context.onLog(
      `[Reply attempt=${attemptId}] Luna draft (not sent yet): ${reply.replace(/[\r\n]+/g, " ")}`,
    );
    const verifiedThread = await dump(context.serial);
    const lateNotice = await handleNotAddedFriendNotice(context, row.displayName, verifiedThread);
    if (lateNotice === "exited") {
      recordNotReplied(
        row.displayName,
        "friend-status",
        "Snapchat showed that this person has not added the account before the reply was sent.",
        transcript,
      );
      list = await dump(context.serial);
      continue;
    }
    if (lateNotice === "exit-failed") {
      recordNotReplied(
        row.displayName,
        "friend-status",
        "Snapchat showed that this person has not added the account, and the conversation could not be exited.",
        transcript,
      );
      break;
    }
    const verifiedComposer = findChatComposer(verifiedThread.nodes, screenHeight);
    if (!verifiedComposer) {
      recordNotReplied(
        row.displayName,
        "before-typing",
        "the chat composer was no longer available after the reply was drafted.",
        transcript,
      );
      await exitSnapchatConversation(context).catch(() => false);
      break;
    }
    let sendState: UiState | undefined;
    let enteredReply = "";
    if (!isEmptyComposerValue(verifiedComposer.text.trim())) {
      recordNotReplied(
        row.displayName,
        "before-typing",
        "the reply field already contained a draft, so the generated reply was not sent.",
        transcript,
      );
      await exitSnapchatConversation(context).catch(() => false);
      break;
    }
    if (activeContact) activeContact.stage = "typing-reply";
    context.onLog("Reply to Unread Chats: typing Luna's draft into the composer focused by opening the chat.");
    let typed: Awaited<ReturnType<typeof android.typeViaSavedCalibrationMap>> | undefined;
    try {
      typed = await android.typeViaSavedCalibrationMap(
        context.serial,
        reply,
        context.effectiveTypingProfile(context.serial),
        message => context.onLog(`Reply to Unread Chats: ${message}`),
        {
          debugLabel: "Snapchat reply",
          disableHumanErrors: true,
          skipMissingKeys: true,
          compactLogs: true,
          onProgress: context.onProgress,
          batchTaps: true,
          measureTapTimings: true,
          bestEffortTyping: true,
        },
      );
      if (!typed.available) {
        context.onLog(
          `Reply to Unread Chats: no saved keyboard calibration map is available` +
          `${typed.missing.length ? `; missing keys: ${typed.missing.join(", ")}` : ""}; continuing to Enter.`,
        );
      }
      if (typed.fatal) {
        const diagnostic = formatKeyboardFailureDiagnostic(typed.failure);
        context.onLog(`Reply to Unread Chats: calibrated typing reported ${diagnostic}; continuing with the current draft.`);
      }
      if (typed.missing.length) {
        context.onLog(
          `Reply to Unread Chats: some calibrated key(s) were unavailable (${[...new Set(typed.missing)].join(", ")}); continuing.`,
        );
      }
    } catch (error) {
      context.onLog(
        `Reply to Unread Chats: calibrated typing errored` +
        `${error instanceof Error ? ` (${error.message})` : ""}; continuing with whatever reached the composer.`,
      );
    }
    sendState = await dump(context.serial);
    const composerAfterTyping = findChatComposer(sendState.nodes, screenHeight);
    enteredReply = composerAfterTyping?.text.trim() ?? "";
    if (isEmptyComposerValue(enteredReply)) {
      context.onLog("Reply to Unread Chats: no readable draft is available; still attempting Enter as requested.");
    }
    const composerBeforeSend = findChatComposer(sendState.nodes, screenHeight);
    if (!composerBeforeSend) {
      context.onLog(
        `[Reply attempt=${attemptId}] outcome=skip-before-send; the verified conversation composer was not restored; no reply was sent or counted.`,
      );
      recordNotReplied(
        row.displayName,
        "verify-before-send",
        "the verified conversation composer was not restored after checking the contact identity.",
        transcript,
        false,
      );
      await exitSnapchatConversation(context).catch(() => false);
      list = await dump(context.serial);
      continue;
    }
    if (!isEmptyComposerValue(composerBeforeSend.text.trim())) {
      enteredReply = composerBeforeSend.text.trim();
    }
    context.onLog(
      `[Reply attempt=${attemptId}] replying to profile username=@${verifiedIdentity.username}; entering send action.`,
    );
    if (activeContact) activeContact.stage = "sending-reply";
    context.onLog(`[Reply attempt=${attemptId}] sending the text currently in the composer.`);
    try {
      await android.keyevent(context.serial, 66);
    } catch (error) {
      recordNotReplied(
        row.displayName,
        "sending-reply",
        `Android Enter could not be sent; the reply was not confirmed sent${error instanceof Error ? ` (${error.message})` : ""}.`,
        transcript,
      );
      await exitSnapchatConversation(context).catch(() => false);
      activeContact = null;
      list = await dump(context.serial);
      continue;
    }
    const sentState = await dump(context.serial);
    const afterConversation = visibleConversation(
      sentState.nodes,
      composer.bounds[1],
      verifiedIdentity.displayName,
      verifiedIdentity.headerBottom,
    )
      .map(normalizedText).join(" ");
    const beforeConversation = transcript.map(normalizedText).join(" ");
    const composerAfterSend = findChatComposer(sentState.nodes, screenHeight);
    const sentTextConfirmed =
      afterConversation.includes(normalizedText(enteredReply)) &&
      !beforeConversation.includes(normalizedText(enteredReply)) &&
      isEmptyComposerValue(composerAfterSend?.text ?? "");
    if (!sentTextConfirmed) {
      context.onLog(
        `[Reply attempt=${attemptId}] outcome=not-confirmed-sent; reply count, link state, and saved reply were not updated.`,
      );
      recordNotReplied(
        row.displayName,
        "sending-reply",
        "Snapchat did not confirm the reply was sent, so it was not counted as replied.",
        [...transcript, `Draft intended: ${enteredReply}`],
      );
      await exitSnapchatConversation(context).catch(() => false);
      list = await dump(context.serial);
      continue;
    }
    activeContact = null;
    try {
      const record = appendSnapchatReplyHistory({
        slotId,
        serial: context.serial,
        accountUsername: context.targetUsername?.trim() || undefined,
        username: contactKey,
        displayName: verifiedIdentity.displayName,
        replyNumber: history.previousReplyCount + 1,
        capturedMessages: transcript,
        capturedAt: transcriptCapturedAt,
        sentText: enteredReply,
        sentAt: new Date().toISOString(),
      });
      context.onLog(
        `[Reply attempt=${attemptId}] outcome=sent-and-saved contact=@${contactKey} replyNumber=${record.replyNumber} slotId=${slotId}.`,
      );
    } catch (error) {
      context.onLog(
        `[Reply attempt=${attemptId}] outcome=sent-but-history-save-failed; the message was sent, but its verified-contact history could not be saved (${error instanceof Error ? error.message : "write failed"}).`,
      );
    }
    replied++;
    context.onMetric?.("snapchat_replies");
    const linksSent = countLinksInText(enteredReply);
    if (linksSent > 0) {
      context.onMetric?.("snapchat_links_sent", linksSent);
      context.onLog(`[Reply attempt=${attemptId}] confirmed ${linksSent} link${linksSent === 1 ? "" : "s"} sent in @${contactKey}'s reply.`);
    }
    const exitedToChatSurface = await exitSnapchatConversation(context).catch(() => false);
    if (!exitedToChatSurface) {
      context.onLog("Reply to Unread Chats stopped: could not return to Snapchat after sending the reply.");
      break;
    }
    list = await dump(context.serial);
    const chatListStillOpen =
      Boolean(exactClickable(list.nodes, ["Chat"])) &&
      !findChatComposer(list.nodes, screenHeight);
    if (!chatListStillOpen) {
      context.onLog("Reply to Unread Chats stopped: Snapchat did not return to the chat list after exiting the conversation.");
      break;
    }
    if (replied < requested) {
      context.onLog("Reply to Unread Chats: continuing in the existing Unread list without tapping Chat or Unread again.");
    }
  }
  } catch (error) {
    if (activeContact) {
      recordNotReplied(
        activeContact.displayName,
        activeContact.stage,
        `an unexpected automation error occurred before a reply was confirmed sent${error instanceof Error ? ` (${error.message})` : ""}.`,
        activeContact.capturedMessages,
      );
    }
    logAction(context, `${replied} of ${requested} replies sent; the tool stopped after an error`);
    throw error;
  }
  const remainingReason = context.isAborted()
    ? "the automation was aborted before this unread contact was reached."
    : replied >= requested
      ? `the selected run target of ${requested} replies was reached before this contact was processed.`
      : "the run stopped before this unread contact could be processed.";
  for (const row of readUnreadRows(list.nodes)) {
    if (visited.has(row.key)) continue;
    recordNotReplied(row.displayName, "run-ended", remainingReason, row.preview);
  }
  context.onLog(`Reply to Unread Chats: confirmed ${replied}/${requested} GPT-6 Luna replies.`);
  logAction(context, replied === requested
    ? `${replied} replies sent`
    : `${replied} of ${requested} replies sent; ${
      noMoreEligible ? "no more eligible unread chats" : context.isAborted() ? "cycle stopped" : "tool stopped early"
    }`);
}
