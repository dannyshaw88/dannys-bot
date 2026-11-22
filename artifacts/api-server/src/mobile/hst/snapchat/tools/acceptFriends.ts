import fs from "node:fs";
import path from "node:path";
import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode } from "../context";
import { openAddFriendsForAccepts } from "../navigation/openAcceptFriends";
import { handleAcceptFriendRequestLimit } from "../navigation/acceptFriendsCooldown";
import { scrollAcceptFriendsListOneSlot } from "../navigation/scrollAcceptFriendsListOneSlot";
import { sqlite } from "../../../../storage";
import { center, dump, findOccludingBanner, logAction, nodeLabel, randomCount, shortResourceId, tapNode, waitBetweenActions } from "../runtime";

const ADDED_FRIENDS_FILE = path.join(
  process.env.EQUINOX_DATA_DIR || path.dirname(sqlite.name),
  "snapchat-added-friends.txt",
);
const ADDED_FRIENDS_HEADER = "# ISO timestamp | Tool | Display name\n";
type AddedFriendRecord = {
  displayName: string;
  source: "Add Friends" | "Accept Friends";
  addedAt: string;
};
let legacyHistoryMigrated = false;

function normalizeFriendDisplayName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200d\u2060\ufeff\ufe0e\ufe0f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function ensureAddedFriendsFile(): void {
  fs.mkdirSync(path.dirname(ADDED_FRIENDS_FILE), { recursive: true });
  try {
    fs.writeFileSync(ADDED_FRIENDS_FILE, ADDED_FRIENDS_HEADER, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function appendAcceptedHistoryLine(record: AddedFriendRecord): void {
  ensureAddedFriendsFile();
  const safeName = record.displayName.replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
  fs.appendFileSync(ADDED_FRIENDS_FILE, `${record.addedAt} | ${record.source} | ${safeName}\n`, "utf8");
}

function migrateLegacyDatabaseHistory(): void {
  ensureAddedFriendsFile();
  if (legacyHistoryMigrated) return;
  const existing = new Set(fs.readFileSync(ADDED_FRIENDS_FILE, "utf8").split(/\r?\n/).flatMap(line => {
    const first = line.indexOf(" | ");
    const second = first < 0 ? -1 : line.indexOf(" | ", first + 3);
    if (first < 0 || second < 0) return [];
    const addedAt = line.slice(0, first).trim();
    const source = line.slice(first + 3, second).trim();
    const displayName = line.slice(second + 3).trim();
    if (!Number.isFinite(Date.parse(addedAt)) || !displayName) return [];
    return [`${normalizeFriendDisplayName(displayName)}\u0000${source}\u0000${Date.parse(addedAt)}`];
  }));
  try {
    const entries = sqlite.prepare(`
      SELECT display_name AS displayName, source, added_at AS addedAt
      FROM snapchat_added_friend_history
      WHERE status = 'added'
    `).all() as Array<{ displayName: string; source: AddedFriendRecord["source"]; addedAt: number }>;
    for (const entry of entries) {
      if (
        typeof entry.displayName !== "string" ||
        (entry.source !== "Add Friends" && entry.source !== "Accept Friends") ||
        !Number.isFinite(Number(entry.addedAt))
      ) continue;
      const record: AddedFriendRecord = {
        displayName: entry.displayName,
        source: entry.source,
        addedAt: new Date(entry.addedAt).toISOString(),
      };
      const key = `${normalizeFriendDisplayName(record.displayName)}\u0000${record.source}\u0000${Date.parse(record.addedAt)}`;
      if (existing.has(key)) continue;
      appendAcceptedHistoryLine(record);
      existing.add(key);
    }
  } catch (error) {
    if (!(error instanceof Error) || !/no such table: snapchat_added_friend_history/i.test(error.message)) {
      throw error;
    }
  }
  legacyHistoryMigrated = true;
}

function recordAcceptedFriendName(displayName: string): boolean {
  const cleanDisplayName = displayName.replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalizeFriendDisplayName(cleanDisplayName)) return false;
  migrateLegacyDatabaseHistory();
  appendAcceptedHistoryLine({
    displayName: cleanDisplayName,
    source: "Accept Friends",
    addedAt: new Date().toISOString(),
  });
  return true;
}

const hasAcceptFriendChatComposer = (nodes: UiNode[]) => nodes.some(node =>
  /edittext/i.test(node.className) && /chat_input_text_field/i.test(node.resourceId),
);

export async function runAcceptFriends(context: SnapchatContext): Promise<boolean | "friend-request-cooldown" | "friend-request-cooldown-blocked"> {
  const requested = randomCount(context.tools.acceptFriends.min, context.tools.acceptFriends.max);
  if (!context.tools.acceptFriends.enabled || requested === 0) return false;
  const getScrollPathPixels = () => {
    const value = context.getAcceptFriendsScrollPath?.() ?? 125;
    return Number.isInteger(value) && value >= 1 && value <= 999 ? value : 125;
  };
  logAction(context, `Accept up to ${requested} friend requests`);
  if (!await openAddFriendsForAccepts(context)) {
    logAction(context, "0 friend requests accepted; could not open the request list");
    return false;
  }
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
        const displayName = name?.text.trim() || name?.desc.trim() || "";
        return row && displayName ? [{ button, name: displayName, row }] : [];
      });
  const acceptanceKey = normalizeFriendDisplayName;

  let state = await dump(context.serial);
  const initialCooldownResult = await handleAcceptFriendRequestLimit(context, state.nodes);
  if (initialCooldownResult) {
    logAction(context, `0 of ${requested} friend requests accepted; paused by Snapchat's friend-request limit`);
    return initialCooldownResult;
  }

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
      const cooldownWhileExpanding = await handleAcceptFriendRequestLimit(context, state.nodes);
      if (cooldownWhileExpanding) {
        logAction(context, `0 of ${requested} friend requests accepted; paused by Snapchat's friend-request limit`);
        return cooldownWhileExpanding;
      }
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
  let noMoreAvailable = false;
  let pendingAcceptance: { name: string; row: UiNode } | null = null;
  const attemptedAcceptances = new Set<string>();
  while (accepted < requested && !context.isAborted()) {
    if (pendingAcceptance) {
      const currentAcceptance = pendingAcceptance;
      await waitBetweenActions(
        context,
        context.tools.acceptFriends.delayMinSeconds,
        context.tools.acceptFriends.delayMaxSeconds,
        "Accept Friends",
      );
      if (context.isAborted()) break;
      state = await dump(context.serial);
      if (hasAcceptFriendChatComposer(state.nodes)) {
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
          getScrollPathPixels(),
        );
        if (!scrolled) {
          context.onLog("Accept Friends: could not scroll after that request; continuing with currently visible requests.");
        }
        continue;
      }
      accepted++;
      context.onMetric?.("snapchat_accept_friends");
      try {
        if (recordAcceptedFriendName(currentAcceptance.name)) {
          context.onLog(`Accept Friends: accepted ${currentAcceptance.name}; saved the display name to the farm-wide list.`);
        } else {
          context.onLog("Accept Friends: accepted a request, but its display name was empty and could not be saved.");
        }
      } catch {
        context.onLog(`Accept Friends: ${currentAcceptance.name} was accepted, but could not be saved to the farm-wide name list.`);
      }
      pendingAcceptance = null;
      const scrolled = await scrollAcceptFriendsListOneSlot(
        context,
        state.nodes,
        currentAcceptance.row,
        screenHeight,
        currentAcceptance.name,
        getScrollPathPixels(),
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
      noMoreAvailable = true;
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
    state = await dump(context.serial);
    const cooldownAfterTap = await handleAcceptFriendRequestLimit(context, state.nodes);
    if (cooldownAfterTap) {
      logAction(context, `${accepted} of ${requested} friend requests accepted; paused by Snapchat's friend-request limit`);
      return cooldownAfterTap;
    }
    pendingAcceptance = { name: candidate.name, row: candidate.row };
  }
  context.onLog(`Accept Friends: accepted ${accepted}/${requested} visible incoming requests.`);
  const result = accepted === requested
    ? `${accepted} friend request${accepted === 1 ? "" : "s"} accepted`
    : `${accepted} friend request${accepted === 1 ? "" : "s"} accepted; ${
      noMoreAvailable ? "no more available" : context.isAborted() ? "cycle stopped" : `stopped before the target of ${requested}`
    }`;
  logAction(context, result);
  return true;
}
