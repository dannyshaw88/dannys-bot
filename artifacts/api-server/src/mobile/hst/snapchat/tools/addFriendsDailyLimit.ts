import fs from "node:fs";
import path from "node:path";
import { sqlite } from "../../../../storage";
import type { SnapchatContext } from "../context";

type DayState = { date: string; count: number; limit: number | null };
type LimitContext = Pick<SnapchatContext, "slotId" | "slotIdx" | "serial" | "targetUsername" | "tools">;

export function localDay(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function ledgerPath(): string {
  return path.join(process.env.EQUINOX_DATA_DIR || path.dirname(sqlite.name), "snapchat-add-friends-daily.json");
}

export function dailyAddFriendsState(context: LimitContext, increment = false, now = new Date()): DayState {
  const filename = ledgerPath();
  let ledger: Record<string, DayState> = {};
  try { ledger = JSON.parse(fs.readFileSync(filename, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const username = (context.targetUsername ?? "").trim().replace(/^@/, "").toLowerCase();
  const key = JSON.stringify([context.slotId || `${context.serial}:${context.slotIdx ?? 0}`, username]);
  const date = localDay(now);
  let state = ledger[key];
  if (!state || state.date !== date) state = { date, count: 0, limit: null };
  // Statistics seed existing activity when this setting is first enabled.
  // The direct counter also covers unflushed metrics within the current cycle.
  if (username) {
    const rows = sqlite.prepare("SELECT count FROM stats WHERE type = ? AND date = ?")
      .all(`mob:${username}:snapchat_add_friends`, date) as Array<{ count: number }>;
    state.count = Math.max(state.count, ...rows.map(row => Number(row.count) || 0));
  }
  const settings = context.tools.addFriends;
  if (settings.maxFollowsEnabled && state.limit === null) {
    const a = Math.max(0, Math.trunc(settings.maxFollowsMin ?? 50));
    const b = Math.max(0, Math.trunc(settings.maxFollowsMax ?? 100));
    const min = Math.min(a, b), max = Math.max(a, b);
    state.limit = min + Math.floor(Math.random() * (max - min + 1));
  }
  if (increment) state.count++;
  ledger[key] = state;
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(ledger));
  fs.renameSync(temporary, filename);
  return state;
}
