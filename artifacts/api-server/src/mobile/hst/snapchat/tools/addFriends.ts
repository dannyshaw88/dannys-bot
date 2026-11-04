import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode } from "../context";
import { hasSnapchatChatComposer, openAddFriendsForSuggestions } from "../navigation/openAddFriends";
import { scrollAddFriendsListOneSlot } from "../navigation/scrollAddFriendsListOneSlot";
import { center, dump, nodeLabel, randomCount, shortResourceId, tapNode, waitBetweenActions } from "../runtime";

export async function runAddFriends(context: SnapchatContext): Promise<boolean> {
  const requested = randomCount(context.tools.addFriends.min, context.tools.addFriends.max);
  if (!context.tools.addFriends.enabled || requested === 0) return false;
  if (!await openAddFriendsForSuggestions(context)) return false;
  const { h: screenHeight } = await android.getScreenSizeAsync(context.serial);
  let added = 0;
  const attemptedFriends = new Set<string>();
  const recoveryAttempts = new Map<string, number>();
  const findAddCandidates = (nodes: UiNode[]) => {
    const addButtons = nodes.filter(node =>
      shortResourceId(node) === "scu_search_action_button" &&
      [node.text, node.desc].some(value => /^add$/i.test(value.trim())) &&
      node.bounds[2] > node.bounds[0] && node.bounds[3] > node.bounds[1] &&
      node.bounds[3] <= screenHeight * 0.85,
    );
    const candidates = addButtons.flatMap(candidate => {
      const candidateY = center(candidate).y;
      const row = nodes.find(node =>
        shortResourceId(node) === "scu_search_friend_cell" &&
        candidateY >= node.bounds[1] && candidateY <= node.bounds[3],
      );
      if (!row) return [];
      const username = nodes.find(node =>
        shortResourceId(node) === "result-title" &&
        node.bounds[1] >= row.bounds[1] && node.bounds[3] <= row.bounds[3],
      );
      const friendName = username ? nodeLabel(username) : "";
      const friendKey = friendName.toLowerCase().replace(/\s+/g, " ").trim();
      return friendName ? [{ candidate, friendName, friendKey, row }] : [];
    });
    return { addButtons, candidates };
  };

  while (added < requested && !context.isAborted()) {
    let state = await dump(context.serial);
    let { addButtons, candidates } = findAddCandidates(state.nodes);
    let selected = candidates.find(({ friendKey }) => !attemptedFriends.has(friendKey));
    const candidate = selected?.candidate;
    if (!selected || !candidate) {
      context.onLog(addButtons.length
        ? "Add Friends: no unattempted friend-row Add controls remain; continuing to the next tool."
        : "Add Friends: no friend-row Add controls are currently exposed; continuing to the next tool.");
      break;
    }
    if (added > 0) {
      await waitBetweenActions(
        context,
        context.tools.addFriends.delayMinSeconds,
        context.tools.addFriends.delayMaxSeconds,
        "Add Friends",
      );
      if (context.isAborted()) break;
      state = await dump(context.serial);
      ({ addButtons, candidates } = findAddCandidates(state.nodes));
      selected = candidates.find(({ friendKey }) => !attemptedFriends.has(friendKey));
      if (!selected) continue;
    }
    const currentCandidate = selected.candidate;
    const { friendName, friendKey } = selected;
    if (context.isAborted()) break;
    if (!await tapNode(context, currentCandidate, `tap Add for ${friendName} under Find Friends`, 0, true)) break;

    const afterTap = await dump(context.serial);
    if (hasSnapchatChatComposer(afterTap.nodes)) {
      const recoveries = (recoveryAttempts.get(friendKey) ?? 0) + 1;
      recoveryAttempts.set(friendKey, recoveries);
      context.onLog(`Add Friends: tapping the live Add control opened a chat for ${friendName}; leaving it and retrying the friend row (${recoveries}/3).`);
      if (!await openAddFriendsForSuggestions(context)) {
        context.onLog("Add Friends: could not recover from the chat; ending this tool.");
        break;
      }
      if (recoveries >= 3) {
        attemptedFriends.add(friendKey);
        context.onLog(`Add Friends: skipping ${friendName} after three interrupted attempts and continuing with other available friends.`);
      }
      continue;
    }
    attemptedFriends.add(friendKey);
    recoveryAttempts.delete(friendKey);
    added++;
    context.onMetric?.("snapchat_add_friends");
    context.onLog(`Add Friends: tapped Add for ${friendName}; continuing without waiting for Snapchat's confirmation.`);
    if (!await scrollAddFriendsListOneSlot(context, afterTap.nodes, selected.row, screenHeight, friendName)) {
      context.onLog("Add Friends: could not scroll after this Add; continuing with currently visible candidates.");
    }
  }
  context.onLog(`Add Friends: processed ${added}/${requested} live friend-row Add tap(s).`);
  return true;
}
