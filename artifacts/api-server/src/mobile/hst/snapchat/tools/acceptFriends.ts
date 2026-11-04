import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode } from "../context";
import { hasSnapchatChatComposer, openAddFriendsForAccepts } from "../navigation/openAddFriends";
import { scrollAcceptFriendsListOneSlot } from "../navigation/scrollAcceptFriendsListOneSlot";
import { center, dump, findOccludingBanner, nodeLabel, randomCount, randomSeconds, shortResourceId, tapNode } from "../runtime";

export async function runAcceptFriends(context: SnapchatContext): Promise<boolean> {
  const requested = randomCount(context.tools.acceptFriends.min, context.tools.acceptFriends.max);
  if (!context.tools.acceptFriends.enabled || requested === 0) return false;
  if (!await openAddFriendsForAccepts(context)) return false;
  const { w: screenWidth, h: screenHeight } = await android.getScreenSizeAsync(context.serial);
  let blockedAcceptance = "";
  let viewMoreBannerWaitLogged = false;

  const getAcceptRows = (nodes: UiNode[]) =>
    nodes.filter(node =>
      shortResourceId(node) === "scu_search_action_button" &&
      [node.text, node.desc].some(value => /^accept$/i.test(value.trim())) &&
      node.bounds[3] < screenHeight * 0.95,
    )
      .flatMap(button => {
        const y = center(button).y;
        const row = nodes.find(node =>
          shortResourceId(node) === "scu_search_friend_cell" &&
          y >= node.bounds[1] && y <= node.bounds[3],
        );
        const name = row && nodes.find(node =>
          shortResourceId(node) === "result-title" &&
          node.bounds[1] >= row.bounds[1] && node.bounds[3] <= row.bounds[3],
        );
        return row && name ? [{ button, name: nodeLabel(name), row }] : [];
      });
  const acceptanceKey = (name: string) => name.toLowerCase().replace(/\s+/g, " ").trim();

  let state = await dump(context.serial);

  for (let expansion = 0; expansion < 10 && !context.isAborted(); expansion++) {
    const moreButton = state.nodes.find(node =>
      shortResourceId(node) === "add_friends_view_more_cell" &&
      [node.text, node.desc].some(value => /^view\s+\d+\s+more$/i.test(value.trim())),
    );
    if (!moreButton) break;
    const beforeLabel = nodeLabel(moreButton);
    const beforeCount = getAcceptRows(state.nodes).length;
    if (findOccludingBanner(state.nodes, moreButton, screenWidth, screenHeight)) {
      if (!viewMoreBannerWaitLogged) {
        context.onLog("Accept Friends: waiting for the banner to clear View More.");
        viewMoreBannerWaitLogged = true;
      }
      await context.sleep(120, "exact");
      state = await dump(context.serial);
      expansion--;
      continue;
    }
    viewMoreBannerWaitLogged = false;
    if (!await tapNode(context, moreButton, `expand Added Me (${beforeLabel})`)) return true;
    await context.sleep(700, "exact");
    const expanded = await dump(context.serial);
    const expandedMore = expanded.nodes.find(node =>
      shortResourceId(node) === "add_friends_view_more_cell" &&
      [node.text, node.desc].some(value => /^view\s+\d+\s+more$/i.test(value.trim())),
    );
    const afterCount = getAcceptRows(expanded.nodes).length;
    const afterLabel = expandedMore ? nodeLabel(expandedMore) : "";
    if (afterCount <= beforeCount && afterLabel === beforeLabel) {
      context.onLog("Accept Friends: View More did not expose additional Accept controls; continuing with the visible requests.");
      state = expanded;
      break;
    }
    state = expanded;
  }

  let accepted = 0;
  let pendingAcceptance: { name: string; row: UiNode } | null = null;
  const attemptedAcceptances = new Set<string>();
  while (accepted < requested && !context.isAborted()) {
    if (pendingAcceptance) {
      const currentAcceptance = pendingAcceptance;
      const seconds = randomSeconds(
        context.tools.acceptFriends.delayMinSeconds,
        context.tools.acceptFriends.delayMaxSeconds,
      );
      context.onLog(`Accept Friends: waiting ${seconds}s between accepts.`);
      await context.sleep(seconds * 1000);
      if (context.isAborted()) break;
      state = await dump(context.serial);
      if (hasSnapchatChatComposer(state.nodes)) {
        attemptedAcceptances.add(acceptanceKey(currentAcceptance.name));
        pendingAcceptance = null;
        context.onLog(`Accept Friends: a chat opened after tapping Accept for ${currentAcceptance.name}; leaving it and continuing.`);
        await android.keyevent(context.serial, 4);
        await context.sleep(400, "exact");
        continue;
      }
      const stillPending = getAcceptRows(state.nodes)
        .find(row => acceptanceKey(row.name) === acceptanceKey(currentAcceptance.name));
      if (stillPending) {
        attemptedAcceptances.add(acceptanceKey(currentAcceptance.name));
        pendingAcceptance = null;
        context.onLog(`Accept Friends: Snapchat still shows Accept for ${currentAcceptance.name}; skipping that request and continuing with other requests.`);
        const scrolled = await scrollAcceptFriendsListOneSlot(
          context,
          state.nodes,
          stillPending.row,
          screenHeight,
          currentAcceptance.name,
        );
        if (!scrolled) {
          context.onLog("Accept Friends: could not scroll after that request; continuing with currently visible requests.");
        }
        continue;
      }
      accepted++;
      context.onMetric?.("snapchat_accept_friends");
      pendingAcceptance = null;
      const scrolled = await scrollAcceptFriendsListOneSlot(
        context,
        state.nodes,
        currentAcceptance.row,
        screenHeight,
        currentAcceptance.name,
      );
      if (!scrolled && accepted < requested) {
        context.onLog("Accept Friends: could not scroll after accepting; continuing with currently visible requests.");
      }
      if (accepted >= requested) break;
    }
    state = await dump(context.serial);
    const candidate = getAcceptRows(state.nodes)
      .find(row => !attemptedAcceptances.has(acceptanceKey(row.name)));
    if (!candidate) {
      context.onLog("Accept Friends: no unattempted Accept requests remain; continuing to the next tool.");
      break;
    }
    if (findOccludingBanner(state.nodes, candidate.button, screenWidth, screenHeight)) {
      if (blockedAcceptance !== candidate.name) {
        blockedAcceptance = candidate.name;
        context.onLog(`Accept Friends: waiting for the banner to clear Accept for ${candidate.name}.`);
      }
      await context.sleep(120, "exact");
      continue;
    }
    blockedAcceptance = "";
    if (!await tapNode(context, candidate.button, `accept ${candidate.name} under Added Me`, 250)) break;
    pendingAcceptance = { name: candidate.name, row: candidate.row };
  }
  context.onLog(`Accept Friends: accepted ${accepted}/${requested} visible incoming requests.`);
  return true;
}
