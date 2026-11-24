import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode, UiState } from "../context";
import { center, dump, shortResourceId } from "../runtime";
import { normalizeSnapchatContactLabel } from "./replyUnreadChatText";

const GENERIC_CONTACT_LABEL =
  /^(?:avatar[_\s-]*container|profile[_\s-]*(?:image|picture|avatar)|user[_\s-]*(?:image|picture|avatar)|chat|camera|call|video|audio|back|more|unread|new chat|search)$/i;
const USERNAME_PATTERN = /^@?([a-z0-9._-]{3,15})$/i;

export function isGenericContactLabel(value: string, node?: UiNode): boolean {
  const normalized = value.trim();
  if (!normalized || GENERIC_CONTACT_LABEL.test(normalized)) return true;
  const resource = node ? shortResourceId(node) : "";
  return Boolean(resource && normalized.toLowerCase() === resource.toLowerCase() &&
    /avatar|container|image|picture|profile|username|user_name/i.test(resource));
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

function exactHeaderNode(
  nodes: UiNode[],
  expectedDisplayName: string,
  screenHeight: number,
): UiNode | undefined {
  const expected = normalizeSnapchatContactLabel(expectedDisplayName);
  const candidates = nodes
    .filter(node =>
      node.bounds[1] <= screenHeight * 0.28 &&
      [node.text, node.desc].some(value =>
        normalizeSnapchatContactLabel(value) === expected &&
        !isGenericContactLabel(value, node),
      ),
    )
    .sort((left, right) => {
      const leftArea = (left.bounds[2] - left.bounds[0]) * (left.bounds[3] - left.bounds[1]);
      const rightArea = (right.bounds[2] - right.bounds[0]) * (right.bounds[3] - right.bounds[1]);
      return leftArea - rightArea || left.bounds[1] - right.bounds[1];
    });
  return candidates[0];
}

export function conversationHeaderMatches(
  nodes: UiNode[],
  expectedDisplayName: string,
  screenHeight: number,
): boolean {
  return Boolean(exactHeaderNode(nodes, expectedDisplayName, screenHeight));
}

function profileUsername(
  state: UiState,
  screenHeight: number,
  expectedDisplayName: string,
): string | undefined {
  const expectedName = normalizeSnapchatContactLabel(expectedDisplayName);
  const matches = new Set<string>();
  for (const node of state.nodes) {
    if (node.bounds[1] > screenHeight * 0.55) continue;
    const resource = shortResourceId(node);
    const explicitUsername = /(?:^|[_-])(?:profile[_-]?)?username(?:$|[_-])|user_name/i.test(resource);
    for (const value of [node.text, node.desc]) {
      const candidate = value.trim().replace(/^@/, "");
      const match = candidate.match(USERNAME_PATTERN);
      if (!match) continue;
      if (
        normalizeSnapchatContactLabel(candidate) === expectedName &&
        !explicitUsername &&
        !value.trim().startsWith("@")
      ) continue;
      if (!explicitUsername && !value.trim().startsWith("@")) continue;
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

function identityFailureReason(
  state: UiState,
  screenHeight: number,
  expectedDisplayName: string,
): string | undefined {
  const header = exactHeaderNode(state.nodes, expectedDisplayName, screenHeight);
  if (!header) return "the open conversation header did not match the selected contact";
  return undefined;
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
  expectedUsername?: string,
): Promise<VerifyUnreadConversationResult> {
  return android.withInputTransaction(context.serial, async () => {
    let state = await dump(context.serial);
    const header = exactHeaderNode(state.nodes, expectedDisplayName, screenHeight);
    if (!header) {
      return {
        ok: false,
        reason: identityFailureReason(state, screenHeight, expectedDisplayName) ??
          "the selected contact name was not exposed in the conversation header",
        state,
      };
    }
    if (findChatComposer(state.nodes, screenHeight) === undefined) {
      return { ok: false, reason: "the selected contact's chat composer is not open", state };
    }

    const { x, y } = center(header);
    await android.tap(
      context.serial,
      x,
      y,
      "bot",
      `Snapchat: open profile for selected chat ${expectedDisplayName}`,
      "automation",
      { exact: true },
    );

    let username: string | undefined;
    for (let attempt = 0; attempt < 9 && !context.isAborted(); attempt++) {
      await context.sleep(350, "exact");
      state = await dump(context.serial);
      username = profileUsername(state, screenHeight, expectedDisplayName);
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

    const restoredHeader = exactHeaderNode(state.nodes, expectedDisplayName, screenHeight);
    const composer = findChatComposer(state.nodes, screenHeight);
    if (!composer || !restoredHeader) {
      return {
        ok: false,
        reason: "the same chat could not be confirmed after checking its profile",
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
    if (expectedUsername && username !== expectedUsername.toLowerCase()) {
      return {
        ok: false,
        reason: `the contact username changed from @${expectedUsername} to @${username}`,
        state,
      };
    }

    return {
      ok: true,
      value: {
        username,
        displayName: expectedDisplayName,
        state,
        headerNode: restoredHeader,
        headerBottom: restoredHeader.bounds[3],
        composer,
      },
    };
  });
}
