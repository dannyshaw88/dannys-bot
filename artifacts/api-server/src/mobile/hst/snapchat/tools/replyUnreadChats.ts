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
const isMyAiChat = (name: string) => normalizedText(name) === "my ai";
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

function findChatComposer(nodes: UiNode[], screenHeight: number): UiNode | undefined {
  const editFields = nodes.filter(node => /edittext/i.test(node.className));
  const byResourceId = editFields.find(node =>
    /chat_input_text_field|chat.*composer|message.*input/i.test(node.resourceId),
  );
  if (byResourceId) return byResourceId;

  const byPlaceholder = editFields.find(node =>
    /send a chat|send chat|type a message|message/i.test(`${node.text} ${node.desc}`),
  );
  if (byPlaceholder) return byPlaceholder;

  // Snapchat has changed the composer ID between app versions. When its
  // accessibility tree omits the placeholder, the single lower-screen
  // EditText is the focused chat composer; do not mistake a top search field
  // or keyboard key for it.
  const lowerFields = editFields
    .filter(node => node.bounds[1] >= screenHeight * 0.55)
    .sort((a, b) => b.bounds[1] - a.bounds[1]);
  return lowerFields.length === 1 ? lowerFields[0] : undefined;
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
  if (peerName && leadingLabel.toLocaleLowerCase() === peerName.trim().toLocaleLowerCase()) {
    return "Contact";
  }
  return undefined;
}

function visibleConversation(nodes: UiNode[], composerTop: number, peerName: string): string[] {
  const excluded = /^(send|chat|call|video|audio|camera|back|more|typing|delivered|opened|seen|unread|new snap|today|yesterday|message)$/i;
  const seen = new Set<string>();
  return nodes
    .filter(node => node.bounds[1] >= 220 && node.bounds[1] < composerTop && !/edittext/i.test(node.className))
    .sort((a, b) => a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0])
    .map(node => {
      const text = node.text.trim();
      const description = node.desc.trim();
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
      if (!key || excluded.test(text) || seen.has(key)) return false;
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

async function tapUnreadChatNameArea(
  context: SnapchatContext,
  row: ReturnType<typeof unreadChatRows>[number],
  screenWidth: number,
): Promise<boolean> {
  if (context.isAborted()) return false;
  if (isMyAiChat(row.displayName)) {
    context.onLog("Reply to Unread Chats: refusing to open Snapchat's My AI chat.");
    return false;
  }
  if (row.chatActionNode) {
    const { x, y } = center(row.chatActionNode);
    context.onLog(`Reply to Unread Chats: "${row.displayName}" has mixed media and chat activity; tapping its live chat-only icon bounds=[${row.chatActionNode.bounds.join(",")}] at (${x},${y}).`);
    await android.tap(context.serial, x, y, "bot", `Snapchat: open chat-only action for ${row.displayName}`, "automation", { exact: true });
    await context.sleep(700);
    return !context.isAborted();
  }
  const [rowLeft, rowTop, rowRight, rowBottom] = row.marker.bounds;
  const rowWidth = rowRight - rowLeft;
  const x = Math.round(rowWidth >= screenWidth * 0.6 ? rowLeft + rowWidth / 2 : screenWidth / 2);
  const nameCenter = center(row.nameNode);
  const y = Math.max(rowTop + 1, Math.min(rowBottom - 1, nameCenter.y));
  context.onLog(`Reply to Unread Chats: tapping the live central row for "${row.displayName}" at (${x},${y}); row=[${row.marker.bounds.join(",")}], name=[${row.nameNode.bounds.join(",")}].`);
  await android.tap(context.serial, x, y, "bot", `Snapchat: open unread chat for ${row.displayName}`, "automation", { exact: true });
  await context.sleep(700);
  return !context.isAborted();
}

function unreadChatRows(
  nodes: UiNode[],
  onSkippedRow?: (
    displayName: string,
    reason: "Delivered" | "empty" | "media-only" | "My AI",
    preview: string[],
  ) => void,
) {
  return nodes.flatMap(marker => {
    const markerLabel = `${marker.text} ${marker.desc}`.trim();
    if (!/ff_item/i.test(shortResourceId(marker))) return [];
    const rowHeight = marker.bounds[3] - marker.bounds[1];
    const rowNodes = nodes.filter(node =>
      node.bounds[0] >= marker.bounds[0] &&
      node.bounds[1] >= marker.bounds[1] &&
      node.bounds[2] <= marker.bounds[2] &&
      node.bounds[3] <= marker.bounds[3],
    );
    const rowLabel = [markerLabel, ...rowNodes.map(nodeLabel)].join(" ");
    const hasMedia = /\b(snaps?|photos?|videos?)\b/i.test(rowLabel);
    const hasChats = /\bchats?\b/i.test(rowLabel);
    const chatActionNode = rowNodes.find(node =>
      /feed_chat_button/i.test(`${node.text} ${node.desc} ${node.resourceId}`) &&
      node.bounds[0] >= marker.bounds[0] + rowHeight * 0.65,
    );
    const names = nodes.filter(node =>
      node.text.trim() &&
      node.bounds[1] >= marker.bounds[1] &&
      node.bounds[3] <= marker.bounds[3] &&
      node.bounds[1] < marker.bounds[1] + rowHeight * 0.48 &&
      !/^(unread|received|sent|opened|new|camera|chat)$/i.test(node.text.trim()),
    ).sort((a, b) => a.bounds[1] - b.bounds[1]);
    const nameNode = names[0];
    const displayName = nameNode?.text.trim();
    const nameBottom = nameNode?.bounds[3];
    const previewValues = rowNodes
      .filter(node =>
        nameBottom !== undefined &&
        node !== nameNode &&
        !node.clickable &&
        node.bounds[1] >= nameBottom,
      )
      .map(node => node.text.trim())
      .filter(Boolean);
    if (displayName && isMyAiChat(displayName)) {
      onSkippedRow?.(displayName, "My AI", previewValues);
      return [];
    }
    if (hasMedia && !(hasChats && chatActionNode)) {
      if (displayName) onSkippedRow?.(displayName, "media-only", previewValues);
      return [];
    }
    if (displayName && /\bdelivered\b/i.test(rowLabel)) {
      onSkippedRow?.(displayName, "Delivered", previewValues);
      return [];
    }
    const emptyPreview = /\b(?:you are now friends|double[\s-]+tap to snap|tap to chat|start a chat|say hi|no messages yet)\b/i;
    const nonMessagePreview = /^(?:new\s+chats?|unread|received|sent|opened|delivered|camera|chat|call|video|audio|more|today|yesterday|\d+\s*(?:s|sec(?:onds)?|m|min(?:utes)?|h|hr(?:ours)?|d|days?))\b/i;
    const hasMessagePreview = previewValues.some(value =>
      !emptyPreview.test(value) &&
      !nonMessagePreview.test(value) &&
      !/\b\d+\s*(?:s|m|h|d)\b/i.test(value),
    );
    if (
      displayName &&
      (emptyPreview.test(rowLabel) || !hasMessagePreview)
    ) {
      onSkippedRow?.(displayName, "empty", previewValues);
      return [];
    }
    return nameNode && displayName
      ? [{ marker, nameNode, displayName, chatActionNode: hasMedia ? chatActionNode : undefined, preview: previewValues }]
      : [];
  });
}

async function openUnreadChatFromLiveList(
  context: SnapchatContext,
  displayName: string,
  screenWidth: number,
  screenHeight: number,
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

      const liveRow = unreadChatRows(state.nodes).find(row =>
        normalizedText(row.displayName) === normalizedText(displayName),
      );
      if (!liveRow) {
        return { state, tapped, stillOnChatList: true, targetStillVisible: false };
      }

      if (attempt > 1) {
        context.onLog(`Reply to Unread Chats: "${displayName}" is still in the live Unread list after the first tap; retrying once with refreshed row bounds.`);
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

      const targetStillVisible = unreadChatRows(state.nodes).some(row =>
        normalizedText(row.displayName) === normalizedText(displayName),
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
  const { enabled, replyGoal } = context.tools.replyUnreadChats;
  const requested = randomCount(context.tools.replyUnreadChats.min, context.tools.replyUnreadChats.max);
  if (!enabled || requested === 0) return;
  logAction(context, `Reply to up to ${requested} unread chats`);
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
  let activeContact: { displayName: string; stage: string; capturedMessages: string[] } | null = null;
  const recordNotReplied = (
    displayName: string,
    stage: string,
    reason: string,
    capturedMessages: string[] = [],
  ) => {
    if (activeContact && normalizedText(activeContact.displayName) === normalizedText(displayName)) {
      activeContact = null;
    }
    const identity = `${normalizedText(displayName)}:${stage}:${reason}`;
    if (recordedSkips.has(identity)) return;
    recordedSkips.add(identity);
    context.onLog(`Reply to Unread Chats: not replying to "${displayName}" — ${reason}`);
    try {
      appendSnapchatConversationFailure({
        slotId,
        serial: context.serial,
        accountUsername: context.targetUsername?.trim() || undefined,
        contactName: displayName,
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
  let list = await waitForUnreadTab(context);
  if (!list) {
    logAction(context, "0 replies sent; the Unread list did not open");
    return;
  }
  if (!exactClickable(list.nodes, ["Chat"]) ||
      list.nodes.some(node => /edittext/i.test(node.className) && /chat_input_text_field/i.test(node.resourceId))) {
    context.onLog("Reply to Unread Chats stopped: the Unread chat list was not confirmed after tapping its tab.");
    logAction(context, "0 replies sent; the Unread list could not be confirmed");
    return;
  }
  const { w: screenWidth, h: screenHeight } = await android.getScreenSizeAsync(context.serial);

  let replied = 0;
  let noMoreEligible = false;
  const visited = new Set<string>();
  const readUnreadRows = (nodes: UiNode[]) => unreadChatRows(nodes, (displayName, reason, preview) => {
    // Delivered rows are ordinary outgoing conversations, not missed incoming
    // chats. Keep excluding them from processing, but don't write a skipped
    // contact audit after the corresponding sent-reply record.
    if (reason === "Delivered") return;
    const explanations: Record<typeof reason, string> = {
      empty: "the row has no readable incoming message preview.",
      "media-only": "the row contains only Snap/photo/video activity, not a text chat.",
      "My AI": "it is Snapchat's My AI conversation, which is intentionally excluded.",
    };
    recordNotReplied(displayName, "unread-list", explanations[reason], preview);
  });
  try {
  while (replied < requested && !context.isAborted()) {
    let rows = readUnreadRows(list.nodes);
    for (let retry = 0; rows.length === 0 && retry < 4 && !context.isAborted(); retry++) {
      await context.sleep(500, "exact");
      list = await dump(context.serial);
      rows = readUnreadRows(list.nodes);
    }
    context.onLog(`Reply to Unread Chats: found ${rows.length} eligible text-chat row(s) in the Unread list.`);
    const row = rows.find(item => !visited.has(normalizedText(item.displayName)));
    if (!row) {
      noMoreEligible = true;
      context.onLog("Reply to Unread Chats: no eligible text-chat row remains in Snapchat's Unread list.");
      break;
    }
    const identity = normalizedText(row.displayName);
    if (visited.has(identity)) break;
    visited.add(identity);
    activeContact = {
      displayName: row.displayName,
      stage: "opening-chat",
      capturedMessages: row.preview,
    };
    context.onLog(`Reply to Unread Chats: noted unread contact name "${row.displayName}" from the list.`);
    const openResult = await openUnreadChatFromLiveList(
      context,
      row.displayName,
      screenWidth,
      screenHeight,
    );
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
    const contactKey = row.displayName;
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
    const composer = composerResult.composer;
    const screenTranscript = visibleConversation(thread.nodes, composer.bounds[1], row.displayName);
    const { messages: transcript, ignoredCount } = filterPromptIgnoredTranscript(screenTranscript, replyGoal);
    if (ignoredCount) {
      context.onLog(`Reply to Unread Chats: omitted ${ignoredCount} transcript item(s) matching this slot's prompt ignore list.`);
    }
    const transcriptCapturedAt = new Date().toISOString();
    activeContact = {
      displayName: row.displayName,
      stage: "reading-conversation",
      capturedMessages: transcript,
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
    const history = getSnapchatReplyHistory(context.slotId, contactKey);
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
      `Luna live context [slot=${slotId}; promptChars=${replyGoal.length}; nextReply=${history.previousReplyCount + 1}]: newest contact message=${JSON.stringify(modelContext.latestIncomingMessage)}; transcript=${JSON.stringify(modelContext.transcript.slice(-12))}; prior Luna replies=${JSON.stringify(history.sentReplies.map(entry => entry.sentText))}`,
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
    context.onLog(`Luna draft (not sent yet): ${reply.replace(/[\r\n]+/g, " ")}`);
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
    const initialComposerText = verifiedComposer.text.trim();
    if (!isEmptyComposerValue(initialComposerText)) {
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
    try {
      const typed = await android.typeViaSavedCalibrationMap(
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
        },
      );
      if (!typed.available) {
        recordNotReplied(
          row.displayName,
          "typing-reply",
          `the device has no saved keyboard calibration map${typed.missing.length ? `; missing keys: ${typed.missing.join(", ")}` : ""}.`,
          transcript,
        );
        await exitSnapchatConversation(context).catch(() => false);
        break;
      }
      if (typed.fatal) {
        recordNotReplied(
          row.displayName,
          "typing-reply",
          typed.missing.includes("abc")
            ? "the device's ABC key is not calibrated; the partial draft was not sent."
            : "the calibrated keyboard could not return to letters; the partial draft was not sent.",
          transcript,
        );
        await exitSnapchatConversation(context).catch(() => false);
        break;
      }
      if (typed.missing.length) {
        context.onLog(
          `Reply to Unread Chats: skipped unmapped key(s) ${[...new Set(typed.missing)].join(", ")}; continuing with the remaining calibrated keys.`,
        );
      }
      sendState = await dump(context.serial);
      const composerAfterTyping = findChatComposer(sendState.nodes, screenHeight);
      enteredReply = composerAfterTyping?.text.trim() ?? "";
      if (isEmptyComposerValue(enteredReply) || enteredReply === initialComposerText) {
        recordNotReplied(
          row.displayName,
          "typing-reply",
          "no new reply text appeared in the composer after typing.",
          transcript,
        );
        await exitSnapchatConversation(context).catch(() => false);
        break;
      }
    } catch (error) {
      recordNotReplied(
        row.displayName,
        "typing-reply",
        `calibrated keyboard typing failed; the reply was not sent${error instanceof Error ? ` (${error.message})` : ""}.`,
        transcript,
      );
      await exitSnapchatConversation(context).catch(() => false);
      break;
    }
    if (activeContact) activeContact.stage = "sending-reply";
    context.onLog("Reply to Unread Chats: draft verified in the composer; sending.");
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
      break;
    }
    const sentState = await dump(context.serial);
    const afterConversation = visibleConversation(sentState.nodes, composer.bounds[1], row.displayName)
      .map(normalizedText).join(" ");
    const beforeConversation = transcript.map(normalizedText).join(" ");
    const composerAfterSend = findChatComposer(sentState.nodes, screenHeight);
    const sentTextConfirmed =
      afterConversation.includes(normalizedText(enteredReply)) &&
      !beforeConversation.includes(normalizedText(enteredReply)) &&
      isEmptyComposerValue(composerAfterSend?.text ?? "");
    if (!sentTextConfirmed) {
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
        accountUsername: context.targetUsername?.trim() || slotId,
        username: contactKey,
        displayName: row.displayName,
        capturedMessages: transcript,
        capturedAt: transcriptCapturedAt,
        sentText: enteredReply,
        sentAt: new Date().toISOString(),
      });
      context.onLog(`Reply log saved for ${row.displayName}; confirmed sent reply #${record.replyNumber}.`);
    } catch (error) {
      context.onLog(`Reply to Unread Chats warning: the message was sent, but the local log could not be saved (${error instanceof Error ? error.message : "write failed"}).`);
    }
    replied++;
    context.onMetric?.("snapchat_replies");
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
    if (visited.has(normalizedText(row.displayName))) continue;
    recordNotReplied(row.displayName, "run-ended", remainingReason, row.preview);
  }
  context.onLog(`Reply to Unread Chats: confirmed ${replied}/${requested} GPT-6 Luna replies.`);
  logAction(context, replied === requested
    ? `${replied} replies sent`
    : `${replied} of ${requested} replies sent; ${
      noMoreEligible ? "no more eligible unread chats" : context.isAborted() ? "cycle stopped" : "tool stopped early"
    }`);
}
