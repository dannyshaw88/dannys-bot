import fs from "node:fs";
import path from "node:path";
import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode } from "../context";
import { hasSnapchatChatComposer, openAddFriendsForSuggestions } from "../navigation/openAddFriends";
import { handleFriendRequestLimit } from "../navigation/handleFriendRequestCooldown";
import { scrollAddFriendsListOneSlot } from "../navigation/scrollAddFriendsListOneSlot";
import { sqlite } from "../../../../storage";
import { center, dump, logAction, randomCount, shortResourceId, tapNode, waitBetweenActions } from "../runtime";

const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;
const STALE_RESERVATION_MS = 30 * 60 * 1000;
// Packaged Electron sets EQUINOX_DATA_DIR to app.getPath("userData"), under %APPDATA%\Aura Farming.
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
const pendingNameReservations = new Map<string, number>();

function normalizeFriendDisplayName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200d\u2060\ufeff\ufe0e\ufe0f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function ensureAddedFriendsDirectory(): void {
  fs.mkdirSync(path.dirname(ADDED_FRIENDS_FILE), { recursive: true });
}

function ensureAddedFriendsFile(): void {
  ensureAddedFriendsDirectory();
  try {
    fs.writeFileSync(ADDED_FRIENDS_FILE, ADDED_FRIENDS_HEADER, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function cleanDisplayNameForFile(value: string): string {
  return value.replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
}

function appendHistoryRecord(record: AddedFriendRecord): void {
  ensureAddedFriendsFile();
  fs.appendFileSync(
    ADDED_FRIENDS_FILE,
    `${record.addedAt} | ${record.source} | ${cleanDisplayNameForFile(record.displayName)}\n`,
    "utf8",
  );
}

function readAddedFriendsFile(): AddedFriendRecord[] {
  ensureAddedFriendsFile();
  const contents = fs.readFileSync(ADDED_FRIENDS_FILE, "utf8");
  return contents.split(/\r?\n/).flatMap(line => {
    const timestampSeparator = line.indexOf(" | ");
    const sourceSeparator = timestampSeparator < 0 ? -1 : line.indexOf(" | ", timestampSeparator + 3);
    if (timestampSeparator < 0 || sourceSeparator < 0) return [];
    const addedAt = line.slice(0, timestampSeparator).trim();
    const source = line.slice(timestampSeparator + 3, sourceSeparator).trim();
    const displayName = line.slice(sourceSeparator + 3).trim();
    if (
      !Number.isFinite(Date.parse(addedAt)) ||
      (source !== "Add Friends" && source !== "Accept Friends") ||
      !displayName
    ) return [];
    return [{ displayName, source, addedAt }];
  });
}

function historyRecordKey(record: AddedFriendRecord): string {
  return `${normalizeFriendDisplayName(record.displayName)}\u0000${record.source}\u0000${Date.parse(record.addedAt)}`;
}

function migrateLegacyDatabaseHistory(): void {
  ensureAddedFriendsFile();
  if (legacyHistoryMigrated) return;
  const entries = readAddedFriendsFile();
  const existing = new Set(entries.map(historyRecordKey));
  try {
    const legacyEntries = sqlite.prepare(`
      SELECT display_name AS displayName, source, added_at AS addedAt
      FROM snapchat_added_friend_history
      WHERE status = 'added'
    `).all() as Array<{ displayName: string; source: AddedFriendRecord["source"]; addedAt: number }>;
    for (const row of legacyEntries) {
      if (
        typeof row.displayName !== "string" ||
        (row.source !== "Add Friends" && row.source !== "Accept Friends") ||
        !Number.isFinite(Number(row.addedAt))
      ) continue;
      const record: AddedFriendRecord = {
        displayName: row.displayName,
        source: row.source,
        addedAt: new Date(row.addedAt).toISOString(),
      };
      const key = historyRecordKey(record);
      if (existing.has(key)) continue;
      appendHistoryRecord(record);
      existing.add(key);
    }
  } catch (error) {
    if (!(error instanceof Error) || !/no such table: snapchat_added_friend_history/i.test(error.message)) {
      throw error;
    }
  }
  legacyHistoryMigrated = true;
}

function appendAddedFriendName(displayName: string, source: AddedFriendRecord["source"]): boolean {
  const cleanDisplayName = displayName.trim();
  if (!normalizeFriendDisplayName(cleanDisplayName)) return false;
  migrateLegacyDatabaseHistory();
  const record: AddedFriendRecord = {
    displayName: cleanDisplayName,
    source,
    addedAt: new Date().toISOString(),
  };
  appendHistoryRecord(record);
  return true;
}

function wasRecentlyAddedToFarm(displayName: string): boolean {
  const normalizedName = normalizeFriendDisplayName(displayName);
  if (!normalizedName) return false;
  const now = Date.now();
  const reservationAt = pendingNameReservations.get(normalizedName);
  if (reservationAt !== undefined && now - reservationAt < STALE_RESERVATION_MS) return true;
  if (reservationAt !== undefined) pendingNameReservations.delete(normalizedName);
  migrateLegacyDatabaseHistory();
  return readAddedFriendsFile().some(record =>
    normalizeFriendDisplayName(record.displayName) === normalizedName &&
    now - Date.parse(record.addedAt) <= FIVE_DAYS_MS,
  );
}

function reserveFriendName(displayName: string): string | null {
  const normalizedName = normalizeFriendDisplayName(displayName);
  if (!normalizedName || wasRecentlyAddedToFarm(displayName)) return null;
  pendingNameReservations.set(normalizedName, Date.now());
  return normalizedName;
}

function finishFriendReservation(reservationKey: string, displayName: string): void {
  appendAddedFriendName(displayName, "Add Friends");
  pendingNameReservations.delete(reservationKey);
}

function releaseFriendReservation(reservationKey: string): void {
  pendingNameReservations.delete(reservationKey);
}

function normalizeAvoidMatch(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200d\u2060\ufeff\ufe0e\ufe0f]/g, "")
    .toLocaleLowerCase("en-US");
}

function recordAddedFriendName(displayName: string): void {
  appendAddedFriendName(displayName, "Add Friends");
}

export async function runAddFriends(context: SnapchatContext): Promise<boolean | "friend-request-cooldown" | "friend-request-cooldown-blocked"> {
  const requested = randomCount(context.tools.addFriends.min, context.tools.addFriends.max);
  if (!context.tools.addFriends.enabled || requested === 0) return false;
  logAction(context, `Add ${requested} friends`);
  if (!await openAddFriendsForSuggestions(context)) {
    logAction(context, "0 friends added; could not open the friend list");
    return false;
  }
  const { h: screenHeight } = await android.getScreenSizeAsync(context.serial);
  let added = 0;
  let noMoreAvailable = false;
  let delaySatisfiedSinceLastAdd = false;
  const attemptedFriends = new Set<string>();
  const recoveryAttempts = new Map<string, number>();
  const skipAdded = context.tools.addFriends.skipAdded === true;
  const avoidUsersContaining = context.tools.addFriends.avoidUsersContainingEnabled === true;
  const avoidWordsText = typeof context.tools.addFriends.avoidUsersContainingWords === "string"
    ? context.tools.addFriends.avoidUsersContainingWords
    : "";
  const avoidTerms = avoidUsersContaining
    ? avoidWordsText
      .split(",")
      .map(term => normalizeAvoidMatch(term.trim()))
      .filter(Boolean)
    : [];
  if (avoidUsersContaining && avoidTerms.length === 0) {
    context.onLog("Add Friends: Avoid Users Containing is enabled, but no comma-separated words are loaded.");
  }
  const wasRecentlyAdded = (friendName: string): boolean | null => {
    if (!skipAdded) return false;
    try {
      return wasRecentlyAddedToFarm(friendName);
    } catch {
      context.onLog("Add Friends stopped: the farm-wide Skip Added list could not be read; no more friend requests will be sent.");
      return null;
    }
  };
  const skipAndScroll = async (
    state: { nodes: UiNode[] },
    selectedFriend: { friendName: string; friendKey: string; row: UiNode },
  ) => {
    const { friendName, friendKey, row } = selectedFriend;
    attemptedFriends.add(friendKey);
    context.onLog(`Add Friends: skipping ${friendName}; it is already on the farm list or is currently being added.`);
    if (!await scrollAddFriendsListOneSlot(
      context,
      state.nodes,
      row,
      screenHeight,
      friendName,
      "skipping a recently added name",
    )) {
      context.onLog("Add Friends: could not scroll past that name; continuing with currently visible candidates.");
    }
  };
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
      const friendName = username?.text.trim() || username?.desc.trim() || "";
      const friendKey = normalizeFriendDisplayName(friendName);
      const identityText = nodes
        .filter(node =>
          node.bounds[0] >= row.bounds[0] &&
          node.bounds[1] >= row.bounds[1] &&
          node.bounds[2] <= row.bounds[2] &&
          node.bounds[3] <= row.bounds[3] &&
          !["scu_search_action_button", "friend-cell-dismiss"].includes(shortResourceId(node)),
        )
        .flatMap(node => [node.text, node.desc])
        .filter(value => value.trim())
        .map(normalizeAvoidMatch);
      return friendName ? [{ candidate, friendName, friendKey, row, identityText }] : [];
    });
    return { addButtons, candidates };
  };
  const getAvoidedTerm = (selectedFriend: { identityText: string[] }): string | undefined =>
    avoidTerms.find(term => selectedFriend.identityText.some(value => value.includes(term)));
  const dismissAvoidedSuggestion = async (
    state: { nodes: UiNode[] },
    selectedFriend: { friendName: string; friendKey: string; row: UiNode },
    matchedTerm: string,
  ): Promise<boolean> => {
    const { friendName, row } = selectedFriend;
    attemptedFriends.add(selectedFriend.friendKey);
    const rowBounds = row.bounds;
    const dismiss = state.nodes.find(node =>
      shortResourceId(node) === "friend-cell-dismiss" &&
      /^(hide|dismiss)$/i.test(node.desc.trim() || node.text.trim()) &&
      node.bounds[0] >= rowBounds[0] &&
      node.bounds[1] >= rowBounds[1] &&
      node.bounds[2] <= rowBounds[2] &&
      node.bounds[3] <= rowBounds[3],
    );
    if (!dismiss) {
      context.onLog(`Add Friends: ${friendName} matched the avoid list (“${matchedTerm}”), but its row Hide control was not exposed; it will not be added.`);
      if (!await scrollAddFriendsListOneSlot(context, state.nodes, row, screenHeight, friendName, "skipping an avoided suggestion")) {
        context.onLog("Add Friends: could not scroll past the avoided suggestion; continuing with currently visible candidates.");
      }
      return !context.isAborted();
    }
    context.onLog(`Add Friends: ${friendName} matched the avoid list (“${matchedTerm}”); dismissing it with the row Hide control.`);
    if (!await tapNode(context, dismiss, `dismiss avoided suggestion ${friendName} with its row Hide control`, 350, true)) {
      return false;
    }
    context.onLog(`Add Friends: dismissed ${friendName}; using Snapchat's refreshed list position without an extra scroll.`);
    return !context.isAborted();
  };

  while (added < requested && !context.isAborted()) {
    let state = await dump(context.serial);
    const cooldownResult = await handleFriendRequestLimit(context, "Add Friends", state.nodes);
    if (cooldownResult) {
      logAction(context, `${added} of ${requested} friends added; paused by Snapchat's friend-request limit`);
      return cooldownResult;
    }
    let { addButtons, candidates } = findAddCandidates(state.nodes);
    let selected = candidates.find(({ friendKey }) => !attemptedFriends.has(friendKey));
    const candidate = selected?.candidate;
    if (!selected || !candidate) {
      noMoreAvailable = true;
      context.onLog(addButtons.length
        ? "Add Friends: no unattempted friend-row Add controls remain; continuing to the next tool."
        : "Add Friends: no friend-row Add controls are currently exposed; continuing to the next tool.");
      break;
    }
    const avoidedBeforeWait = getAvoidedTerm(selected);
    if (avoidedBeforeWait) {
      if (!await dismissAvoidedSuggestion(state, selected, avoidedBeforeWait)) break;
      continue;
    }
    const alreadyAddedBeforeWait = wasRecentlyAdded(selected.friendName);
    if (alreadyAddedBeforeWait === null) {
      logAction(context, `${added} friends added; stopped because the Skip Added list could not be read`);
      return false;
    }
    if (alreadyAddedBeforeWait) {
      await skipAndScroll(state, selected);
      continue;
    }
    if (added > 0 && !delaySatisfiedSinceLastAdd) {
      await waitBetweenActions(
        context,
        context.tools.addFriends.delayMinSeconds,
        context.tools.addFriends.delayMaxSeconds,
        "Add Friends",
      );
      if (context.isAborted()) break;
      delaySatisfiedSinceLastAdd = true;
      state = await dump(context.serial);
      const cooldownAfterWait = await handleFriendRequestLimit(context, "Add Friends", state.nodes);
      if (cooldownAfterWait) {
        logAction(context, `${added} of ${requested} friends added; paused by Snapchat's friend-request limit`);
        return cooldownAfterWait;
      }
      ({ addButtons, candidates } = findAddCandidates(state.nodes));
      selected = candidates.find(({ friendKey }) => !attemptedFriends.has(friendKey));
      if (!selected) continue;
      const avoidedAfterWait = getAvoidedTerm(selected);
      if (avoidedAfterWait) {
        if (!await dismissAvoidedSuggestion(state, selected, avoidedAfterWait)) break;
        continue;
      }
      const alreadyAddedAfterWait = wasRecentlyAdded(selected.friendName);
      if (alreadyAddedAfterWait === null) {
        logAction(context, `${added} friends added; stopped because the Skip Added list could not be read`);
        return false;
      }
      if (alreadyAddedAfterWait) {
        await skipAndScroll(state, selected);
        continue;
      }
    }
    const currentCandidate = selected.candidate;
    const { friendName, friendKey } = selected;
    if (context.isAborted()) break;
    let reservationKey: string | null = null;
    if (skipAdded) {
      try {
        reservationKey = reserveFriendName(friendName);
      } catch {
        context.onLog("Add Friends stopped: the farm-wide Skip Added list could not be updated; no more friend requests will be sent.");
        logAction(context, `${added} friends added; stopped because the Skip Added list could not be updated`);
        return false;
      }
      if (reservationKey === null) {
        await skipAndScroll(state, selected);
        continue;
      }
    }
    if (!await tapNode(context, currentCandidate, `tap Add for ${friendName} under Find Friends`, 0, true)) {
      if (reservationKey !== null) releaseFriendReservation(reservationKey);
      break;
    }

    const afterTap = await dump(context.serial);
    const cooldownAfterTap = await handleFriendRequestLimit(context, "Add Friends", afterTap.nodes);
    if (cooldownAfterTap) {
      if (reservationKey !== null) releaseFriendReservation(reservationKey);
      logAction(context, `${added} of ${requested} friends added; paused by Snapchat's friend-request limit`);
      return cooldownAfterTap;
    }
    if (hasSnapchatChatComposer(afterTap.nodes)) {
      if (reservationKey !== null) releaseFriendReservation(reservationKey);
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
    delaySatisfiedSinceLastAdd = false;
    context.onMetric?.("snapchat_add_friends");
    try {
      if (reservationKey !== null) {
        finishFriendReservation(reservationKey, friendName);
      } else {
        recordAddedFriendName(friendName);
      }
    } catch {
      context.onLog(`Add Friends: ${friendName} was added, but could not be saved to the farm-wide name list.`);
    }
    context.onLog(`Add Friends: added ${friendName}; saved the display name to the farm-wide list.`);
    if (!await scrollAddFriendsListOneSlot(context, afterTap.nodes, selected.row, screenHeight, friendName)) {
      context.onLog("Add Friends: could not scroll after this Add; continuing with currently visible candidates.");
    }
  }
  context.onLog(`Add Friends: processed ${added}/${requested} live friend-row Add tap(s).`);
  const result = added === requested
    ? `${added} ${added === 1 ? "friend" : "friends"} added`
    : `${added} ${added === 1 ? "friend" : "friends"} added; ${
      noMoreAvailable ? "no more available" : context.isAborted() ? "cycle stopped" : `stopped before the target of ${requested}`
    }`;
  logAction(context, result);
  return true;
}
