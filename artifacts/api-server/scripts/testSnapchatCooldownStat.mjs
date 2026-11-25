import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, transform } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cooldown-stat-"));
try {
  // Exercise the actual route callback without starting a server or writing
  // fabricated statistics to the user's database.
  const route = await fs.readFile(path.join(root, "src/routes/mobile.ts"), "utf8");
  const callback = route.slice(route.indexOf("onFriendRequestCooldown: async"));
  const expression = callback.slice(callback.indexOf("async"), callback.indexOf("onAccountNotFound:")).trim().replace(/,$/, "");
  const { code } = await transform(`const callback = ${expression};`, { loader: "ts", target: "es2022" });
  const writes = [];
  const storage = {
    setGlobalSetting: async () => {},
    incrementStat: async (...args) => writes.push(args),
    createSessionAction: async () => {},
  };
  const onCooldown = new Function("storage", "resolvedSlotUsername", "slotId", "serial",
    "incomingSlotIdx", "mobileProfileId", "formatCooldownTime", "logger", "tLog",
    `${code}; return callback;`)(
    storage, "example_account", "stable-slot", "TEST_ONLY", 0, 0,
    () => "later", { warn() {} }, () => {},
  );
  const outfile = path.join(directory, "handler.mjs");
  await build({
    entryPoints: [path.join(root, "src/mobile/hst/snapchat/navigation/handleFriendRequestCooldown.ts")],
    outfile, bundle: true, platform: "node", format: "esm",
    plugins: [{
      name: "isolated-device",
      setup(builder) {
        builder.onResolve({ filter: /androidManager$/ }, () => ({ path: "android", namespace: "mock" }));
        builder.onResolve({ filter: /\/runtime$/ }, () => ({ path: "runtime", namespace: "mock" }));
        builder.onLoad({ filter: /.*/, namespace: "mock" }, args => ({
          contents: args.path === "android" ? "export async function keyevent() {}" :
            `export async function dump(){return {nodes:[]};}
             export const nodeLabel=n=>n.text||n.desc;
             export const shortResourceId=n=>n.resourceId;
             export async function tapNode(){return true;}`,
          loader: "js",
        }));
      },
    }],
  });
  const { handleFriendRequestLimit, FRIEND_REQUEST_COOLDOWN_MS } = await import(pathToFileURL(outfile).href);
  const context = {
    serial: "TEST_ONLY", onLog() {}, sleep: async () => {},
    onFriendRequestCooldown: async (until, tool) => {
      assert(Math.abs(until - Date.now() - FRIEND_REQUEST_COOLDOWN_MS) < 1000);
      await onCooldown(until, tool);
    },
  };
  const node = (text, resourceId = "") => ({ text, desc: "", resourceId, clickable: true });
  assert.equal(await handleFriendRequestLimit(context, "Add Friends", []), false);
  assert.equal(writes.length, 0, "Ordinary scans must not count cooldowns.");
  const popup = [node("Slow down!"), node("You reached your limit of friend requests"), node("OK", "composer_alert_confirm")];
  assert.equal(await handleFriendRequestLimit(context, "Add Friends", popup), "friend-request-cooldown");
  assert.deepEqual(writes, [[0, "mob:snapchat__example_account:snapchat_cooldown"]]);
  await handleFriendRequestLimit(context, "Add Friends", popup.slice(0, 2));
  assert.equal(writes.length, 2, "A newly imposed cooldown counts even when popup dismissal is blocked.");
  const ui = await fs.readFile(path.resolve(root, "../dannys-bot/src/pages/StatsPage.tsx"), "utf8");
  assert.match(ui, /key: "snapchat_accept_friends"[^\n]+\n\s*\{ key: "snapchat_cooldown", label: "Cooldown"/);
  console.log("PASS: real popup handler and route callback count each cooldown for the current Snapchat account; column follows Accept Friends.");
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
