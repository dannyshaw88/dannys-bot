import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "daily-follows-test-"));
const previous = process.env.EQUINOX_DATA_DIR;
try {
  process.env.EQUINOX_DATA_DIR = directory;
  const outfile = path.join(directory, "daily.mjs");
  await build({
    entryPoints: ["src/mobile/hst/snapchat/tools/addFriendsDailyLimit.ts"],
    bundle: true, platform: "node", format: "esm", outfile,
    plugins: [{ name: "isolated-stats", setup(builder) {
      builder.onResolve({ filter: /\/storage$/ }, () => ({ path: "stats", namespace: "test" }));
      builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({
        contents: `export const sqlite = { name: ${JSON.stringify(path.join(directory, "test.db"))}, prepare: sql => {
          if (!sql.includes("WHERE type = ? AND date = ?")) throw Error("wrong stats column");
          return { all: (type,date) => globalThis.dailyStats?.[type+date] ?? [] };
        }};`,
      }));
    } }],
  });
  const { dailyAddFriendsState: state, localDay } = await import(pathToFileURL(outfile).href);
  const today = new Date(2026, 10, 25, 12);
  const tomorrow = new Date(2026, 10, 26, 0, 1);
  const context = { serial: "phone", slotId: "stable-slot", targetUsername: "account.one",
    tools: { addFriends: { maxFollowsEnabled: true, maxFollowsMin: 50, maxFollowsMax: 100 } } };
  const drawn = state(context, false, today).limit;
  assert(drawn >= 50 && drawn <= 100);
  for (let i = 0; i < 5; i++) assert.equal(state(context, false, today).limit, drawn);
  state(context, true, today);
  const reloaded = await import(`${pathToFileURL(outfile).href}?reload=1`);
  assert.equal(reloaded.dailyAddFriendsState(context, false, today).count, 1);
  assert.equal(reloaded.dailyAddFriendsState(context, false, today).limit, drawn);
  assert.equal(state(context, false, tomorrow).count, 0);
  assert.equal(localDay(tomorrow), "2026-11-26");
  const other = { ...context, targetUsername: "replacement.account" };
  assert.equal(state(other, false, today).count, 0);
  globalThis.dailyStats = { ["mob:seeded:snapchat_add_friends" + localDay(today)]: [{ count: 9 }] };
  const seeded = { ...context, targetUsername: "seeded",
    tools: { addFriends: { maxFollowsEnabled: true, maxFollowsMin: 10, maxFollowsMax: 10 } } };
  assert.equal(state(seeded, false, today).count, 9);
  assert.equal(state(seeded, true, today).count, 10);
  assert.equal(state(seeded, false, today).count, 10);
  const disabled = { ...context, slotId: "disabled", tools: { addFriends: { maxFollowsEnabled: false } } };
  assert.equal(state(disabled, true, today).limit, null);
  disabled.tools.addFriends = { maxFollowsEnabled: true, maxFollowsMin: 0, maxFollowsMax: 0 };
  assert.deepEqual(state(disabled, false, today), { date: "2026-11-25", count: 1, limit: 0 });
  console.log("PASS: one persisted daily random limit, restart persistence, midnight reset, replacement-account isolation, statistics seed, exact ongoing counts, and disabled/zero handling.");
} finally {
  if (previous === undefined) delete process.env.EQUINOX_DATA_DIR;
  else process.env.EQUINOX_DATA_DIR = previous;
  delete globalThis.dailyStats;
  await fs.rm(directory, { recursive: true, force: true });
}
