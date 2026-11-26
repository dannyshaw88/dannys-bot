import fs from "node:fs";
import path from "node:path";
import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode, UiState } from "../context";
import { hasSnapchatChatComposer, openAddFriendsForSuggestions } from "../navigation/openAddFriends";
import { handleFriendRequestLimit } from "../navigation/handleFriendRequestCooldown";
import {
  alignAddFriendsContactToTop,
  alignFirstAddFriendsContactToTop,
  scrollAddFriendsListOneSlot,
  findFriendsRows,
  revealAddFriendsSuggestions,
} from "../navigation/scrollAddFriendsListOneSlot";
import { sqlite } from "../../../../storage";
import { dailyAddFriendsState } from "./addFriendsDailyLimit";
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

function normalizeAvoidText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200d\u2060\ufeff\ufe0e\ufe0f]/g, "")
    .toLocaleLowerCase("en-US");
}

function normalizeAvoidWords(value: string): string[] {
  return normalizeAvoidText(value)
    .split(/\s+/)
    .map(word => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
}

function normalizeAvoidSymbols(value: string): string {
  return normalizeAvoidText(value).replace(/[\p{L}\p{N}\s]/gu, "");
}

function containsExactAvoidEntry(words: string[], entry: string[]): boolean {
  if (!entry.length || entry.length > words.length) return false;
  return words.some((_, start) =>
    entry.every((word, offset) => words[start + offset] === word),
  );
}

function recordAddedFriendName(displayName: string): void {
  appendAddedFriendName(displayName, "Add Friends");
}

export async function runAddFriends(context: SnapchatContext): Promise<boolean | "friend-request-cooldown" | "friend-request-cooldown-blocked"> {
  const requested = randomCount(context.tools.addFriends.min, context.tools.addFriends.max);
  if (!context.tools.addFriends.enabled || requested === 0) return false;
  const dailyLimitReached = () => {
    if (!context.tools.addFriends.maxFollowsEnabled) return false;
    const day = dailyAddFriendsState(context);
    context.onLog(`Add Friends: Max Follows ${day.count}/${day.limit} for ${day.date}.`);
    if (day.limit !== null && day.count >= day.limit) {
      logAction(context, `Add Friends skipped: daily Max Follows reached (${day.count}/${day.limit}); resumes next day.`);
      return true;
    }
    return false;
  };
  if (dailyLimitReached()) return false;
  logAction(context, `Add ${requested} friends`);
  if (!await openAddFriendsForSuggestions(context)) {
    logAction(context, "0 friends added; could not open the friend list");
    return false;
  }
  const { w: screenWidth, h: screenHeight } = await android.getScreenSizeAsync(context.serial);
  let added = 0;
  let noMoreAvailable = false;
  const attemptedFriends = new Set<string>();
  const recoveryAttempts = new Map<string, number>();
  const skipAdded = context.tools.addFriends.skipAdded === true;
  const dismissNonEnglish = context.tools.addFriends.dismissNonEnglish === true;
  const avoidUsersContaining = context.tools.addFriends.avoidUsersContainingEnabled === true;
  const avoidWordsText = typeof context.tools.addFriends.avoidUsersContainingWords === "string"
    ? context.tools.addFriends.avoidUsersContainingWords
    : "";
  const avoidTerms = avoidUsersContaining
    ? avoidWordsText
      .split(",")
      .map(label => ({
        label: label.trim(),
        words: normalizeAvoidWords(label),
        symbols: normalizeAvoidSymbols(label),
      }))
      .filter(term => term.words.length > 0 || term.symbols.length > 0)
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
  const findAddCandidates = (nodes: UiNode[]) => {
    const suggestionRows = findFriendsRows(nodes);
    const addButtons = nodes.filter(node =>
      shortResourceId(node) === "scu_search_action_button" &&
      [node.text, node.desc].some(value => /^add$/i.test(value.trim())) &&
      node.bounds[2] > node.bounds[0] && node.bounds[3] > node.bounds[1] &&
      node.bounds[3] <= screenHeight * 0.85,
    );
    const candidates = addButtons.flatMap(candidate => {
      const candidateY = center(candidate).y;
      const row = suggestionRows.find(node =>
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
          (
            shortResourceId(node) === "result-title" ||
            /(?:^|[_-])(?:username|user-name|display-name|display_name)(?:$|[_-])/i.test(shortResourceId(node))
          ),
        )
        .flatMap(node => [node.text, node.desc])
        .filter(value => value.trim());
      return friendName ? [{ candidate, friendName, friendKey, row, identityText }] : [];
    });
    return { addButtons, candidates };
  };
  const positionFriendForAction = async (
    state: { nodes: UiNode[] },
    selectedFriend: { friendName: string; friendKey: string },
  ): Promise<{
    state: UiState;
    selected: { friendName: string; friendKey: string; row: UiNode; candidate: UiNode; identityText: string[] };
  } | null> => {
    if (!await alignAddFriendsContactToTop(
      context,
      state.nodes,
      screenWidth,
      screenHeight,
      selectedFriend.friendName,
    )) return null;
    const refreshedState = await dump(context.serial);
    const refreshedSelected = findAddCandidates(refreshedState.nodes).candidates.find(candidate =>
      candidate.friendKey === selectedFriend.friendKey,
    );
    return refreshedSelected ? { state: refreshedState, selected: refreshedSelected } : null;
  };
  const getAvoidedTerm = (selectedFriend: { identityText: string[] }): string | undefined => {
    const match = avoidTerms.find(term =>
      selectedFriend.identityText.some(value => {
        const wordMatch = term.words.length === 0 ||
          containsExactAvoidEntry(normalizeAvoidWords(value), term.words);
        const symbolMatch = term.symbols.length === 0 ||
          normalizeAvoidText(value).includes(term.symbols);
        return wordMatch && symbolMatch;
      }),
    );
    return match?.label;
  };
  const getNonEnglishLetter = (selectedFriend: { identityText: string[] }): string | undefined =>
    selectedFriend.identityText
      .flatMap(value => [...value.normalize("NFKC")])
      // Match writing letters outside the English A–Z alphabet; punctuation,
      // symbols, digits, and emoji never qualify on their own.
      .find(character => /\p{L}/u.test(character) && !/^[A-Za-z]$/.test(character));
  const describeNonEnglishLetter = (character: string): string => {
    const codePoint = character.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0") ?? "unknown";
    return `non-English writing letter ${JSON.stringify(character)} (U+${codePoint})`;
  };
  const dismissSuggestion = async (
    state: { nodes: UiNode[] },
    selectedFriend: { friendName: string; friendKey: string; row: UiNode; candidate: UiNode },
    matchDescription: string,
    requireDismissControl = false,
  ): Promise<boolean> => {
    attemptedFriends.add(selectedFriend.friendKey);
    const positioned = await positionFriendForAction(state, selectedFriend);
    if (!positioned) {
      context.onLog(
        `Add Friends: could not bring ${selectedFriend.friendName} to the first contact position before dismissing it; ` +
        `skipping it without an Add tap${requireDismissControl ? " because it is already on the farm-wide list" : ""}; continuing.`,
      );
      // The contact was already marked attempted above. If a known farm-wide
      // contact cannot be safely positioned for Hide, skip that row rather
      // than ending the entire Add Friends tool; every later contact still
      // goes through the same live-row positioning check before any Add tap.
      return true;
    }
    state = positioned.state;
    selectedFriend = positioned.selected;
    const { friendName, row } = selectedFriend;
    const previousCenterY = center(row).y;
    const previousTopY = row.bounds[1];
    const rowBounds = row.bounds;
    const addButtonCenterY = center(selectedFriend.candidate).y;
    const addButtonHeight = selectedFriend.candidate.bounds[3] - selectedFriend.candidate.bounds[1];
    const sameRowTolerance = Math.max(8, Math.round(addButtonHeight * 0.25));
    const dismiss = state.nodes.find(node =>
      shortResourceId(node) === "friend-cell-dismiss" &&
      /^(hide|dismiss)$/i.test(node.desc.trim() || node.text.trim()) &&
      node.bounds[0] >= rowBounds[0] &&
      node.bounds[1] >= rowBounds[1] &&
      node.bounds[2] <= rowBounds[2] &&
      node.bounds[3] <= rowBounds[3] &&
      Math.abs(center(node).y - addButtonCenterY) <= sameRowTolerance,
    );
    if (!dismiss) {
      if (requireDismissControl) {
        context.onLog(
          `Add Friends stopped: ${friendName} is on the farm-wide list, but its live Hide control was not exposed; ` +
          `the contact was not added or scrolled past.`,
        );
        return false;
      }
      context.onLog(
        `Add Friends: action for ${friendName} is Skip because its row Hide control was not exposed; ` +
        `it matched ${matchDescription}.`,
      );
      await context.sleep(3000, "exact");
      if (context.isAborted()) return false;
      const liveState = await dump(context.serial);
      if (context.isAborted()) return false;
      if (liveState.nodes.length === 0) {
        context.onLog(
          `Add Friends: the post-Skip screen dump is empty; retrying the list read and per-contact scroll fallback.`,
        );
      }
      if (!await scrollAddFriendsListOneSlot(
        context,
        liveState.nodes,
        screenWidth,
        screenHeight,
        friendName,
        `skipping a suggestion matched by ${matchDescription}`,
        previousCenterY,
        rowBounds[3] - rowBounds[1],
      )) {
        context.onLog("Add Friends: could not scroll past the matched suggestion; continuing with currently visible candidates.");
      }
      await context.onAddFriendsStepComplete?.({ action: "skip", friendName });
      return !context.isAborted();
    }
    context.onLog(`Add Friends: action for ${friendName} is Dismiss; matched ${matchDescription}.`);
    if (context.isAborted()) return false;
    const liveRowY = center(selectedFriend.candidate).y;
    const calibration = android.loadNavigationCalibrationMap(context.serial);
    const hasDismissXCalibration = !!calibration?.points.snapchatFriendSuggestionDismissX;
    try {
      if (hasDismissXCalibration) {
        await android.tapCalibratedNavigationControlAtY(
          context.serial,
          "snapchatFriendSuggestionDismissX",
          liveRowY,
          message => context.onLog(`Add Friends: ${message}`),
          `Snapchat: dismiss matched suggestion ${friendName} at its live row`,
        );
      } else {
        const liveNodeCenterX = center(dismiss).x;
        context.onLog(
          `Add Friends: no calibrated dismiss X for this device; using live Hide-node center ` +
          `(${liveNodeCenterX},${liveRowY}).`,
        );
        await android.tap(
          context.serial,
          liveNodeCenterX,
          liveRowY,
          "manual",
          `Snapchat: dismiss matched suggestion ${friendName} at its live row`,
          "automation",
        );
      }
    } catch (error) {
      context.onLog(
        `Add Friends stopped: the calibrated dismiss X could not be used safely` +
        `${error instanceof Error ? ` (${error.message})` : ""}.`,
      );
      return false;
    }
    await context.sleep(3000, "exact");
    if (context.isAborted()) return false;
    const afterDismiss = await dump(context.serial);
    if (context.isAborted()) return false;
    if (
      requireDismissControl &&
      findAddCandidates(afterDismiss.nodes).candidates.some(candidate =>
        candidate.friendKey === selectedFriend.friendKey,
      )
    ) {
      context.onLog(
        `Add Friends stopped: Snapchat still exposes ${friendName}'s Add row after tapping Hide; ` +
        `refusing to scroll past or send an Add request.`,
      );
      return false;
    }
    context.onLog(
      `Add Friends: dismissed ${friendName} (${matchDescription}); aligning the first remaining contact ` +
      `to the dismissed contact's former top position.`,
    );
    if (!await alignFirstAddFriendsContactToTop(
      context,
      afterDismiss.nodes,
      screenWidth,
      screenHeight,
      previousTopY,
      `dismissing ${friendName}`,
      rowBounds[3] - rowBounds[1],
    )) {
      context.onLog(
        `Add Friends: could not align the first remaining contact after dismissing ${friendName}; ` +
        `continuing with currently visible candidates.`,
      );
    }
    await context.onAddFriendsStepComplete?.({ action: "dismiss", friendName });
    return !context.isAborted();
  };

  while (added < requested && !context.isAborted()) {
    if (dailyLimitReached()) break;
    let state = await dump(context.serial);
    const cooldownResult = await handleFriendRequestLimit(context, "Add Friends", state.nodes);
    if (cooldownResult) {
      logAction(context, `${added} of ${requested} friends added; paused by Snapchat's friend-request limit`);
      return cooldownResult;
    }
    state = { ...state, nodes: await revealAddFriendsSuggestions(
      context, state.nodes, screenWidth, screenHeight,
    ) };
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
    const nonEnglishLetterBeforeWait = dismissNonEnglish ? getNonEnglishLetter(selected) : undefined;
    if (nonEnglishLetterBeforeWait) {
      if (!await dismissSuggestion(
        state,
        selected,
        describeNonEnglishLetter(nonEnglishLetterBeforeWait),
      )) break;
      continue;
    }
    const avoidedBeforeWait = getAvoidedTerm(selected);
    if (avoidedBeforeWait) {
      if (!await dismissSuggestion(state, selected, `Avoid Users Containing entry “${avoidedBeforeWait}”`)) break;
      continue;
    }
    const alreadyAddedBeforeWait = wasRecentlyAdded(selected.friendName);
    if (alreadyAddedBeforeWait === null) {
      logAction(context, `${added} friends added; stopped because the Skip Added list could not be read`);
      return false;
    }
    if (alreadyAddedBeforeWait) {
      if (!await dismissSuggestion(state, selected, "found on the farm-wide list", true)) break;
      continue;
    }
    const { friendName, friendKey } = selected;
    const positioned = await positionFriendForAction(state, selected);
    if (!positioned) {
      attemptedFriends.add(friendKey);
      context.onLog(
        `Add Friends: could not bring ${friendName} to the first contact position; ` +
        `skipping this row without sending an Add tap.`,
      );
      continue;
    }
    state = positioned.state;
    selected = positioned.selected;
    const currentCandidate = selected.candidate;
    const previousCenterY = center(selected.row).y;
    const previousRowHeight = selected.row.bounds[3] - selected.row.bounds[1];
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
        if (!await dismissSuggestion(
          state,
          selected,
          "found on the farm-wide list or already reserved",
          true,
        )) break;
        continue;
      }
    }
    context.onLog(`Add Friends: action for ${friendName} is Add.`);
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
    dailyAddFriendsState(context, true);
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
    await context.sleep(3000, "exact");
    if (context.isAborted()) break;
    const afterAdd = await dump(context.serial);
    if (!await scrollAddFriendsListOneSlot(
      context,
      afterAdd.nodes,
      screenWidth,
      screenHeight,
      friendName,
      "adding",
      previousCenterY,
      previousRowHeight,
    )) {
      context.onLog("Add Friends: could not scroll after this Add; continuing with currently visible candidates.");
    }
    // Consume this Add's delay here, before examining another contact. Deferring
    // it until the next Add lets intervening dismissals inherit the pending wait.
    if (added < requested && !context.isAborted()) {
      await waitBetweenActions(
        context,
        context.tools.addFriends.delayMinSeconds,
        context.tools.addFriends.delayMaxSeconds,
        "Add Friends",
      );
    }
    await context.onAddFriendsStepComplete?.({ action: "add", friendName });
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
