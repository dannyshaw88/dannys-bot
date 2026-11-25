import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode, UiState } from "../context";
import { center, dump, shortResourceId } from "../runtime";

const GENERIC_CONTACT_LABEL =
  /^(?:avatar[_\s-]*container|profile[_\s-]*(?:image|picture|avatar)|user[_\s-]*(?:image|picture|avatar)|feed[_\s-].*|camera reply|chat|camera|call|video|audio|back|more|unread|new chat|search)$/i;
const USERNAME_PATTERN = /^@?([a-z0-9._-]{3,15})$/i;

export function isGenericContactLabel(value: string, node?: UiNode): boolean {
  const normalized = value.trim();
  if (!normalized || GENERIC_CONTACT_LABEL.test(normalized)) return true;
  const resource = node ? shortResourceId(node) : "";
  return Boolean(resource && normalized.toLowerCase() === resource.toLowerCase() &&
    /avatar|container|image|picture|profile|username|user_name|button|icon/i.test(resource));
}

export function contactNameFromNode(node: UiNode): string | undefined {
  for (const raw of [node.text, node.desc]) {
    const value = raw.trim();
    if (!value || isGenericContactLabel(value, node)) continue;
    if (/^(?:\d+\s+)?new chats?$/i.test(value)) continue;
    if (/^(?:\d+\s+)?snaps?\s+and\s+chats?$/i.test(value)) continue;
    if (/^\d+\s*(?:s|sec|m|min|h|hr|d|day)s?$/i.test(value)) continue;
    return value;
  }
  return undefined;
}

export function findChatComposer(nodes: UiNode[], screenHeight: number): UiNode | undefined {
  const editFields = nodes.filter(node => /edittext/i.test(node.className));
  const byResourceId = editFields.find(node =>
    /chat_input_text_field|chat.*composer|message.*input/i.test(node.resourceId),
  );
  if (byResourceId) return byResourceId;

  const byPlaceholder = editFields.find(node =>
    /send a chat|send chat|type a message|message/i.test(`${node.text} ${node.desc}`),
  );
  if (byPlaceholder) return byPlaceholder;

  const lowerFields = editFields
    .filter(node => node.bounds[1] >= screenHeight * 0.55)
    .sort((a, b) => b.bounds[1] - a.bounds[1]);
  return lowerFields.length === 1 ? lowerFields[0] : undefined;
}

/** Read the opened conversation, not the possibly stale Unread-list name. */
export function openChatHeader(nodes: UiNode[], screenHeight: number): UiNode | undefined {
  return nodes.filter(node =>
    node.bounds[3] > node.bounds[1] &&
    node.bounds[1] < screenHeight * 0.2 &&
    !/button|edittext/i.test(node.className) &&
    !/back|call|camera|video|audio|search|icon|button/i.test(shortResourceId(node)) &&
    Boolean(contactNameFromNode(node)),
  ).sort((a, b) => {
    const rank = (node: UiNode) =>
      /(?:chat|conversation|header).*(?:name|title)|(?:name|title).*(?:header|chat)/i.test(shortResourceId(node)) ? 0 :
      /textview/i.test(node.className) ? 1 : 2;
    return rank(a) - rank(b) || a.bounds[1] - b.bounds[1] ||
      (a.bounds[2] - a.bounds[0]) - (b.bounds[2] - b.bounds[0]);
  })[0];
}

function profileUsername(
  state: UiState,
  screenHeight: number,
): string | undefined {
  const matches = new Set<string>();
  for (const node of state.nodes) {
    if (node.bounds[1] > screenHeight * 0.55) continue;
    const resource = shortResourceId(node);
    const explicitUsername = /(?:^|[_-])(?:profile[_-]?)?username(?:$|[_-])|user_name/i.test(resource);
    for (const value of [node.text, node.desc]) {
      const candidate = value.trim().replace(/^username\s*:\s*/i, "").replace(/^@/, "");
      const match = candidate.match(USERNAME_PATTERN);
      if (!match) continue;
      if (!explicitUsername && !value.trim().startsWith("@") && !/^username\s*:/i.test(value.trim())) continue;
      matches.add(match[1].toLowerCase());
    }
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}

function hasContactProfileSurface(state: UiState): boolean {
  return state.nodes.some(node =>
    /profile|snapcode|friend_profile|user_profile/i.test(node.resourceId) ||
    /\b(?:snap score|add friend|my friends|friend profile)\b/i.test(`${node.text} ${node.desc}`),
  );
}

export type VerifiedUnreadConversation = {
  username: string;
  displayName: string;
  state: UiState;
  headerNode: UiNode;
  headerBottom: number;
  composer: UiNode;
};

export type VerifyUnreadConversationResult =
  | { ok: true; value: VerifiedUnreadConversation }
  | { ok: false; reason: string; state: UiState };

export async function verifyUnreadConversationIdentity(
  context: SnapchatContext,
  expectedDisplayName: string,
  screenHeight: number,
): Promise<VerifyUnreadConversationResult> {
  return android.withInputTransaction(context.serial, async () => {
    let state = await dump(context.serial);
    const header = openChatHeader(state.nodes, screenHeight);
    if (!header) {
      return {
        ok: false,
        reason: "the opened chat's name at the top was not exposed",
        state,
      };
    }
    const displayName = contactNameFromNode(header) || expectedDisplayName;

    const { x, y } = center(header);
    await android.tap(
      context.serial,
      x,
      y,
      "bot",
      `Snapchat: open profile from the chat header for ${displayName}`,
      "automation",
      { exact: true },
    );

    let username: string | undefined;
    for (let attempt = 0; attempt < 9 && !context.isAborted(); attempt++) {
      await context.sleep(350, "exact");
      state = await dump(context.serial);
      username = profileUsername(state, screenHeight);
      if (username) break;
      if (attempt < 8) continue;
    }

    const composerStillVisible = Boolean(findChatComposer(state.nodes, screenHeight));
    const profileOpened =
      !composerStillVisible ||
      (Boolean(username) && hasContactProfileSurface(state));
    if (profileOpened) {
      await android.keyevent(context.serial, 4).catch(() => undefined);
      for (let attempt = 0; attempt < 9 && !context.isAborted(); attempt++) {
        state = await dump(context.serial);
        if (findChatComposer(state.nodes, screenHeight)) break;
        await context.sleep(350, "exact");
      }
    } else {
      username = undefined;
    }

    const restoredHeader = openChatHeader(state.nodes, screenHeight) ?? header;
    const composer = findChatComposer(state.nodes, screenHeight);
    if (!composer) {
      return {
        ok: false,
        reason: "the chat composer has not returned after leaving the profile",
        state,
      };
    }
    if (!username) {
      return {
        ok: false,
        reason: "Snapchat did not expose one unambiguous username on the selected contact's profile",
        state,
      };
    }
    context.onLog(`Reply to Unread Chats: profile username=@${username}; loading this user's conversation history.`);
    return {
      ok: true,
      value: {
        username,
        displayName,
        state,
        headerNode: restoredHeader,
        headerBottom: restoredHeader.bounds[3],
        composer,
      },
    };
  });
}
