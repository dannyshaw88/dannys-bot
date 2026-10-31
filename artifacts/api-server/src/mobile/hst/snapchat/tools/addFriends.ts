import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode } from "../context";
import { openAddFriends, isAddFriendsPage, hasSnapchatChatComposer } from "../navigation/openAddFriends";
import { scrollAddFriendsListOneSlot } from "../navigation/scrollAddFriendsListOneSlot";
import { center, dump, nodeLabel, randomCount, shortResourceId, tapNode } from "../runtime";

export async function runAddFriends(context: SnapchatContext): Promise<void> {
  const requested = randomCount(context.tools.addFriends.min, context.tools.addFriends.max);
  if (!context.tools.addFriends.enabled || requested === 0) return;
  if (!await openAddFriends(context)) return;
  const { h: screenHeight } = await android.getScreenSizeAsync(context.serial);
  let added = 0;
  const attemptedFriends = new Set<string>();
  const recoveryAttempts = new Map<string, number>();
  const findAddCandidates = (nodes: UiNode[]) => {
    const findFriendsStart = nodes.findIndex(node =>
      shortResourceId(node) === "section-title" &&
      [node.text, node.desc].some(value => /^find friends$/i.test(value.trim())),
    );
    if (findFriendsStart < 0) {
      return {
        findFriendsStart,
        addButtons: [] as UiNode[],
        candidates: [] as Array<{ candidate: UiNode; friendName: string; friendKey: string; row: UiNode }>,
      };
    }
    const findFriendsTitle = nodes[findFriendsStart];
    const acceptFriendsStart = nodes.findIndex((node, index) =>
      index > findFriendsStart &&
      shortResourceId(node) === "section-title" &&
      [node.text, node.desc].some(value => /^accept friends$/i.test(value.trim())),
    );
    const sectionEnd = acceptFriendsStart < 0 ? nodes.length : acceptFriendsStart;
    const addButtons = nodes.slice(findFriendsStart + 1, sectionEnd).filter(node =>
      shortResourceId(node) === "scu_search_action_button" &&
      [node.text, node.desc].some(value => /^add$/i.test(value.trim())) &&
      node.bounds[2] > node.bounds[0] && node.bounds[3] > node.bounds[1] &&
      node.bounds[1] >= findFriendsTitle.bounds[3] &&
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
    return { findFriendsStart, addButtons, candidates };
  };

  while (added < requested && !context.isAborted()) {
    const { xml, nodes } = await dump(context.serial);
    if (!isAddFriendsPage(xml)) {
      context.onLog("Add Friends: Snapchat left the friend list; restoring it before continuing.");
      if (!await openAddFriends(context)) {
        context.onLog("Add Friends: could not restore the friend list; ending this tool without running another action on the wrong screen.");
        break;
      }
      continue;
    }
    const { findFriendsStart, addButtons, candidates } = findAddCandidates(nodes);
    if (findFriendsStart < 0) {
      context.onLog("Add Friends stopped: the Find Friends section title was not found.");
      break;
    }
    const selected = candidates.find(({ friendKey }) => !attemptedFriends.has(friendKey));
    const candidate = selected?.candidate;
    if (!selected || !candidate) {
      context.onLog(addButtons.length
        ? "Add Friends: no unattempted Add rows remain; continuing to the next tool."
        : "Add Friends: no Add button remains under Find Friends; continuing to the next tool.");
      break;
    }
    const { friendName, friendKey } = selected;
    if (context.isAborted()) break;
    if (!await tapNode(context, candidate, `tap Add for ${friendName} under Find Friends`, 0, true)) break;

    const afterTap = await dump(context.serial);
    if (hasSnapchatChatComposer(afterTap.nodes) || !isAddFriendsPage(afterTap.xml)) {
      const recoveries = (recoveryAttempts.get(friendKey) ?? 0) + 1;
      recoveryAttempts.set(friendKey, recoveries);
      context.onLog(`Add Friends: Snapchat opened another screen while processing ${friendName}; leaving it, restoring Add Friends, and retrying (${recoveries}/3).`);
      if (!await openAddFriends(context)) {
        context.onLog("Add Friends: could not recover to the friend list; ending this tool without running another action on the wrong screen.");
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
      context.onLog("Add Friends: stopping before another Add tap because a one-row scroll could not be placed safely.");
      break;
    }
  }
  context.onLog(`Add Friends: processed ${added}/${requested} Add tap(s) from the Find Friends section.`);
}
