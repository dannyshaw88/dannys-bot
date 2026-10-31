import * as android from "../../../androidManager";
import { storage } from "../../../../storage";
import {
  appendSnapchatReplyHistory,
  containsSnapchatBoundlusLink,
  getSnapchatReplyHistory,
  isBoundlusClarificationQuestion,
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
  nodeLabel,
  randomCount,
  shortResourceId,
  tapExact,
} from "../runtime";

const normalizedText = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
const isMyAiChat = (name: string) => normalizedText(name) === "my ai";

function visibleConversation(nodes: UiNode[], composerTop: number): string[] {
  const excluded = /^(send|chat|call|video|audio|camera|back|more|typing|delivered|opened|seen|unread|new snap|today|yesterday|message)$/i;
  const seen = new Set<string>();
  return nodes
    .filter(node => node.bounds[1] >= 220 && node.bounds[1] < composerTop && !/edittext/i.test(node.className))
    .sort((a, b) => a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0])
    .map(node => {
      const text = node.text.trim();
      const description = node.desc.trim();
      if (text && description && description.toLowerCase() !== text.toLowerCase() &&
          /\b(sent|received|from|you|message|snap)\b/i.test(description)) {
        return `${description}: ${text}`;
      }
      return text || description;
    })
    .filter(text => {
      const key = text.toLowerCase().replace(/\s+/g, " ");
      if (!key || excluded.test(text) || key.length > 700 || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(-25);
}

function findPostLinkMessage(
  transcript: string[],
  linkReply: { capturedMessages: string[] },
): string {
  const beforeLink = new Set(linkReply.capturedMessages.map(normalizedText));
  return transcript
    .filter(message =>
      !beforeLink.has(normalizedText(message)) &&
      !containsSnapchatBoundlusLink(message)
    )
    .at(-1) ?? "";
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
    context.onLog(`Reply to Unread Chats: "${row.displayName}" has mixed media and chat activity; tapping its chat-only right-side icon at (${x},${y}).`);
    await android.tap(context.serial, x, y, "bot", `Snapchat: open chat-only action for ${row.displayName}`, "automation");
    await context.sleep(700);
    return !context.isAborted();
  }
  const [rowLeft, rowTop, rowRight, rowBottom] = row.marker.bounds;
  const rowWidth = rowRight - rowLeft;
  const x = Math.round(rowWidth >= screenWidth * 0.6 ? rowLeft + rowWidth / 2 : screenWidth / 2);
  const nameCenter = center(row.nameNode);
  const y = Math.max(rowTop + 1, Math.min(rowBottom - 1, nameCenter.y));
  context.onLog(`Reply to Unread Chats: tapping the central name area for "${row.displayName}" at (${x},${y}), between the avatar and right-side icon.`);
  await android.tap(context.serial, x, y, "bot", `Snapchat: open unread chat for ${row.displayName}`, "automation");
  await context.sleep(700);
  return !context.isAborted();
}

function unreadChatRows(nodes: UiNode[]) {
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
    if (hasMedia && !(hasChats && chatActionNode)) return [];
    const names = nodes.filter(node =>
      node.text.trim() &&
      node.bounds[1] >= marker.bounds[1] &&
      node.bounds[3] <= marker.bounds[3] &&
      node.bounds[1] < marker.bounds[1] + rowHeight * 0.48 &&
      !/^(unread|received|sent|opened|new|camera|chat)$/i.test(node.text.trim()),
    ).sort((a, b) => a.bounds[1] - b.bounds[1]);
    const nameNode = names[0];
    const displayName = nameNode?.text.trim();
    if (displayName && isMyAiChat(displayName)) return [];
    return nameNode && displayName
      ? [{ marker, nameNode, displayName, chatActionNode: hasMedia ? chatActionNode : undefined }]
      : [];
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
): Promise<string> {
  const settings = await storage.getGlobalSettings();
  const apiKey = String((settings as any).openaiApiKey ?? "").trim() || (process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) throw new Error("Add an OpenAI API key in Settings → Security.");
  return generateSnapchatLunaReply(apiKey, goal, peer, transcript, history);
}

export async function runReplyUnreadChats(context: SnapchatContext): Promise<void> {
  const { enabled, replyGoal } = context.tools.replyUnreadChats;
  const requested = randomCount(context.tools.replyUnreadChats.min, context.tools.replyUnreadChats.max);
  if (!enabled || requested === 0) return;
  context.onLog(`Reply to Unread Chats: target ${requested} unread contact(s), one reply per contact.`);
  if (!context.slotId) {
    context.onLog("Reply to Unread Chats stopped: this Snapchat slot has no stable saved ID for private history.");
    return;
  }
  if (!replyGoal.trim()) {
    context.onLog("Reply to Unread Chats skipped: add a conversation goal in Snapchat Step 2 first.");
    return;
  }
  if (!await tapExact(context, ["Chat"], "open the chat list")) {
    context.onLog("Reply to Unread Chats skipped: Chat tab was not found.");
    return;
  }
  let list = await waitForUnreadTab(context);
  if (!list) return;
  if (!exactClickable(list.nodes, ["Chat"]) ||
      list.nodes.some(node => /edittext/i.test(node.className) && /chat_input_text_field/i.test(node.resourceId))) {
    context.onLog("Reply to Unread Chats stopped: the Unread chat list was not confirmed after tapping its tab.");
    return;
  }
  const { w: screenWidth } = await android.getScreenSizeAsync(context.serial);

  let replied = 0;
  const visited = new Set<string>();
  while (replied < requested && !context.isAborted()) {
    let rows = unreadChatRows(list.nodes);
    for (let retry = 0; rows.length === 0 && retry < 4 && !context.isAborted(); retry++) {
      await context.sleep(500, "exact");
      list = await dump(context.serial);
      rows = unreadChatRows(list.nodes);
    }
    context.onLog(`Reply to Unread Chats: found ${rows.length} eligible text-chat row(s) in the Unread list.`);
    const row = rows.find(item => !visited.has(normalizedText(item.displayName)));
    if (!row) {
      context.onLog("Reply to Unread Chats: no eligible text-chat row remains in Snapchat's Unread list.");
      break;
    }
    const identity = normalizedText(row.displayName);
    if (visited.has(identity)) break;
    visited.add(identity);
    context.onLog(`Reply to Unread Chats: noted unread contact name "${row.displayName}" from the list.`);
    if (!await tapUnreadChatNameArea(context, row, screenWidth)) break;
    const openedThread = await dump(context.serial);
    const snapRecovery = await recoverFromUnreadSnapViewer(context, row.displayName, openedThread);
    if (snapRecovery.detected) {
      if (!snapRecovery.list) break;
      list = snapRecovery.list;
      continue;
    }
    const openedNotice = await handleNotAddedFriendNotice(context, row.displayName, openedThread);
    if (openedNotice === "exited") {
      list = await dump(context.serial);
      continue;
    }
    if (openedNotice === "exit-failed") break;
    const contactKey = row.displayName;
    const thread = await dump(context.serial);
    const threadNotice = await handleNotAddedFriendNotice(context, row.displayName, thread);
    if (threadNotice === "exited") {
      list = await dump(context.serial);
      continue;
    }
    if (threadNotice === "exit-failed") break;
    const composer = thread.nodes.find(node =>
      /edittext/i.test(node.className) && /chat_input_text_field/i.test(node.resourceId),
    );
    if (!composer) {
      context.onLog("Reply to Unread Chats stopped: the chat composer was not available after opening the noted unread contact.");
      await exitSnapchatConversation(context).catch(() => false);
      break;
    }
    const transcript = visibleConversation(thread.nodes, composer.bounds[1]);
    if (transcript.length === 0) {
      context.onLog("Reply to Unread Chats skipped: no readable conversation context was found.");
      await exitSnapchatConversation(context).catch(() => false);
      break;
    }
    let reply: string;
    const history = getSnapchatReplyHistory(context.slotId, contactKey);
    const linkReplyIndex = history.sentReplies.findIndex(entry =>
      containsSnapchatBoundlusLink(entry.sentText),
    );
    if (linkReplyIndex >= 0) {
      const alreadyAnswered = history.sentReplies.slice(linkReplyIndex + 1).length > 0;
      const postLinkMessage = findPostLinkMessage(transcript, history.sentReplies[linkReplyIndex]);
      if (alreadyAnswered || !isBoundlusClarificationQuestion(postLinkMessage)) {
        context.onLog(
          alreadyAnswered
            ? `Reply to Unread Chats skipped for ${row.displayName}: the one post-link clarification was already used.`
            : `Reply to Unread Chats skipped for ${row.displayName}: the Boundlus link was already sent and the latest message is not a Boundlus question.`,
        );
        await exitSnapchatConversation(context).catch(() => false);
        list = await dump(context.serial);
        continue;
      }
      context.onLog(`Reply to Unread Chats: ${row.displayName} asked what Boundlus is; allowing the one post-link clarification.`);
    } else if (history.previousReplyCount >= 3) {
      context.onLog(`Reply to Unread Chats skipped for ${row.displayName}: the three ordinary replies have already been used.`);
      await exitSnapchatConversation(context).catch(() => false);
      list = await dump(context.serial);
      continue;
    }
    try {
      reply = await generateContextualReply(replyGoal, contactKey, transcript, history);
    } catch (error) {
      context.onLog(`Reply to Unread Chats skipped: ${error instanceof Error ? error.message : "GPT-6 Luna could not draft a reply."}`);
      await exitSnapchatConversation(context).catch(() => false);
      break;
    }
    if (!reply) {
      context.onLog(`Reply to Unread Chats: GPT-6 Luna deferred the reply for ${row.displayName}.`);
      await exitSnapchatConversation(context).catch(() => false);
      list = await dump(context.serial);
      continue;
    }
    context.onLog(`Luna draft (not sent yet): ${reply.replace(/[\r\n]+/g, " ")}`);
    const verifiedThread = await dump(context.serial);
    const lateNotice = await handleNotAddedFriendNotice(context, row.displayName, verifiedThread);
    if (lateNotice === "exited") {
      list = await dump(context.serial);
      continue;
    }
    if (lateNotice === "exit-failed") break;
    const verifiedComposer = verifiedThread.nodes.find(node =>
      /edittext/i.test(node.className) && /message|chat|send/i.test(`${node.resourceId} ${node.desc}`),
    );
    if (!verifiedComposer) {
      context.onLog("Reply to Unread Chats stopped: the chat composer was no longer available after ChatGPT finished drafting.");
      await exitSnapchatConversation(context).catch(() => false);
      break;
    }
    let sendState: UiState | undefined;
    let enteredReply = "";
    const initialComposerText = verifiedComposer.text.trim();
    if (initialComposerText && !/^send chat$/i.test(initialComposerText)) {
      context.onLog("Reply to Unread Chats stopped: the reply field already contains a draft.");
      await exitSnapchatConversation(context).catch(() => false);
      break;
    }
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
        context.onLog(
          `Reply to Unread Chats stopped: this device has no saved keyboard calibration map` +
          `${typed.missing.length ? `; missing keys: ${typed.missing.join(", ")}` : ""}.`,
        );
        await exitSnapchatConversation(context).catch(() => false);
        break;
      }
      if (typed.fatal) {
        context.onLog(
          typed.missing.includes("abc")
            ? "Reply to Unread Chats stopped: this device's ABC key is not calibrated; the partial draft was not sent."
            : "Reply to Unread Chats stopped: the calibrated keyboard could not return to letters; the partial draft was not sent.",
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
      const composerAfterTyping = sendState.nodes.find(node =>
        /edittext/i.test(node.className) && /chat_input_text_field/i.test(node.resourceId),
      );
      enteredReply = composerAfterTyping?.text.trim() ?? "";
      if (!enteredReply || /^send chat$/i.test(enteredReply) || enteredReply === initialComposerText) {
        context.onLog("Reply to Unread Chats stopped: no new reply text appeared in the composer.");
        await exitSnapchatConversation(context).catch(() => false);
        break;
      }
    } catch {
      context.onLog("Reply to Unread Chats stopped: calibrated keyboard typing failed; the reply was not sent.");
      await exitSnapchatConversation(context).catch(() => false);
      break;
    }
    context.onLog("Reply to Unread Chats: draft verified in the composer; sending.");
    try {
      await android.keyevent(context.serial, 66);
    } catch {
      context.onLog("Reply to Unread Chats stopped: Android Enter could not be sent; the reply was not confirmed sent.");
      await exitSnapchatConversation(context).catch(() => false);
      break;
    }
    const sentState = await dump(context.serial);
    const afterConversation = visibleConversation(sentState.nodes, composer.bounds[1])
      .map(normalizedText).join(" ");
    const beforeConversation = transcript.map(normalizedText).join(" ");
    const composerAfterSend = sentState.nodes.find(node =>
      /edittext/i.test(node.className) && /chat_input_text_field/i.test(node.resourceId),
    );
    const sentTextConfirmed =
      afterConversation.includes(normalizedText(enteredReply)) &&
      !beforeConversation.includes(normalizedText(enteredReply)) &&
      (!composerAfterSend?.text.trim() || normalizedText(composerAfterSend.text) === "send chat");
    if (!sentTextConfirmed) {
      context.onLog(`Reply to Unread Chats: send could not be confirmed for ${row.displayName}; it was not added to the sent count.`);
      await exitSnapchatConversation(context).catch(() => false);
      list = await dump(context.serial);
      continue;
    }
    try {
      const record = appendSnapchatReplyHistory({
        slotId: context.slotId,
        serial: context.serial,
        username: contactKey,
        displayName: row.displayName,
        capturedMessages: transcript,
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
      !list.nodes.some(node =>
        /edittext/i.test(node.className) && /chat_input_text_field/i.test(node.resourceId),
      );
    if (!chatListStillOpen) {
      context.onLog("Reply to Unread Chats stopped: Snapchat did not return to the chat list after exiting the conversation.");
      break;
    }
    if (replied < requested) {
      context.onLog("Reply to Unread Chats: continuing in the existing Unread list without tapping Chat or Unread again.");
    }
  }
  context.onLog(`Reply to Unread Chats: confirmed ${replied}/${requested} GPT-6 Luna replies.`);
}
