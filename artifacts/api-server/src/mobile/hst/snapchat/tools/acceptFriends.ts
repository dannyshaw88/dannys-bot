import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode } from "../context";
import { isAddFriendsPage, openAddFriends } from "../navigation/openAddFriends";
import { center, dump, findOccludingBanner, nodeLabel, randomCount, randomSeconds, shortResourceId, tapNode } from "../runtime";

export async function runAcceptFriends(context: SnapchatContext): Promise<void> {
  const requested = randomCount(context.tools.acceptFriends.min, context.tools.acceptFriends.max);
  if (!context.tools.acceptFriends.enabled || requested === 0) return;
  if (!await openAddFriends(context)) return;
  const { w: screenWidth, h: screenHeight } = await android.getScreenSizeAsync(context.serial);
  let blockedAcceptance = "";
  let viewMoreBannerWaitLogged = false;

  const getAddedMeSection = (nodes: UiNode[]) => {
    const start = nodes.findIndex(node =>
      shortResourceId(node) === "section-title" &&
      [node.text, node.desc].some(value => /^added me$/i.test(value.trim())),
    );
    if (start < 0) return null;
    const nextSection = nodes.findIndex((node, index) =>
      index > start &&
      shortResourceId(node) === "section-title" &&
      [node.text, node.desc].some(value => /^find friends$/i.test(value.trim())),
    );
    return { start, end: nextSection < 0 ? nodes.length : nextSection };
  };
  const getAcceptRows = (nodes: UiNode[], section: { start: number; end: number }) => {
    const sectionNodes = nodes.slice(section.start + 1, section.end);
    return sectionNodes
      .filter(node =>
        shortResourceId(node) === "scu_search_action_button" &&
        [node.text, node.desc].some(value => /^accept$/i.test(value.trim())) &&
        node.bounds[3] < screenHeight * 0.95,
      )
      .flatMap(button => {
        const y = center(button).y;
        const row = sectionNodes.find(node =>
          shortResourceId(node) === "scu_search_friend_cell" &&
          y >= node.bounds[1] && y <= node.bounds[3],
        );
        const name = row && sectionNodes.find(node =>
          shortResourceId(node) === "result-title" &&
          node.bounds[1] >= row.bounds[1] && node.bounds[3] <= row.bounds[3],
        );
        return row && name ? [{ button, name: nodeLabel(name) }] : [];
      });
  };

  let state = await dump(context.serial);
  if (!isAddFriendsPage(state.xml)) {
    context.onLog("Accept Friends stopped: the live Add Friends screen was not confirmed.");
    return;
  }

  for (let expansion = 0; expansion < 10 && !context.isAborted(); expansion++) {
    const section = getAddedMeSection(state.nodes);
    if (!section) {
      context.onLog("Accept Friends stopped: the Added Me section was not found.");
      return;
    }
    const moreButton = state.nodes.slice(section.start + 1, section.end).find(node =>
      shortResourceId(node) === "add_friends_view_more_cell" &&
      [node.text, node.desc].some(value => /^view\s+\d+\s+more$/i.test(value.trim())),
    );
    if (!moreButton) break;
    const beforeLabel = nodeLabel(moreButton);
    const beforeCount = getAcceptRows(state.nodes, section).length;
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
    if (!await tapNode(context, moreButton, `expand Added Me (${beforeLabel})`)) return;
    const expanded = await dump(context.serial);
    if (!isAddFriendsPage(expanded.xml)) {
      context.onLog("Accept Friends stopped: Snapchat left the Add Friends screen while expanding requests.");
      return;
    }
    const expandedSection = getAddedMeSection(expanded.nodes);
    if (!expandedSection) {
      context.onLog("Accept Friends stopped: Added Me disappeared after tapping View More.");
      return;
    }
    const expandedMore = expanded.nodes.slice(expandedSection.start + 1, expandedSection.end).find(node =>
      shortResourceId(node) === "add_friends_view_more_cell" &&
      [node.text, node.desc].some(value => /^view\s+\d+\s+more$/i.test(value.trim())),
    );
    const afterCount = getAcceptRows(expanded.nodes, expandedSection).length;
    const afterLabel = expandedMore ? nodeLabel(expandedMore) : "";
    if (afterCount <= beforeCount && afterLabel === beforeLabel) {
      context.onLog("Accept Friends stopped: View More did not reveal additional request rows.");
      return;
    }
    state = expanded;
  }

  let accepted = 0;
  let pendingAcceptance: string | null = null;
  while (accepted < requested && !context.isAborted()) {
    if (pendingAcceptance) {
      const seconds = randomSeconds(1, 3);
      context.onLog(`Accept Friends: waiting ${seconds}s between accepts.`);
      await context.sleep(seconds * 1000);
      if (context.isAborted()) break;
      state = await dump(context.serial);
      if (!isAddFriendsPage(state.xml)) {
        context.onLog("Accept Friends stopped: Snapchat left the verified Add Friends screen.");
        break;
      }
      const pendingSection = getAddedMeSection(state.nodes);
      if (!pendingSection) {
        context.onLog("Accept Friends stopped: Added Me could not be confirmed after tapping Accept.");
        break;
      }
      const pendingStillVisible = getAcceptRows(state.nodes, pendingSection)
        .some(row => row.name === pendingAcceptance);
      if (pendingStillVisible) {
        context.onLog(`Accept Friends stopped: Snapchat still shows Accept for ${pendingAcceptance}.`);
        break;
      }
      accepted++;
      context.onMetric?.("snapchat_accept_friends");
      pendingAcceptance = null;
      if (accepted >= requested) break;
    }
    state = await dump(context.serial);
    if (!isAddFriendsPage(state.xml)) {
      context.onLog("Accept Friends stopped: Snapchat left the verified Add Friends screen.");
      break;
    }
    const section = getAddedMeSection(state.nodes);
    if (!section) {
      context.onLog("Accept Friends stopped: the Added Me section is no longer visible.");
      break;
    }
    const candidate = getAcceptRows(state.nodes, section)[0];
    if (!candidate) {
      context.onLog("Accept Friends stopped: no labeled Accept badge was found under Added Me.");
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
    pendingAcceptance = candidate.name;
  }
  context.onLog(`Accept Friends: accepted ${accepted}/${requested} visible incoming requests.`);
}
