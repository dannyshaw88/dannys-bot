import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "unread-exit-"));
try {
  const outfile = path.join(directory, "exit.mjs");
  await build({
    entryPoints: [path.join(root, "src/mobile/hst/snapchat/navigation/exitConversation.ts")],
    outfile, bundle: true, platform: "node", format: "esm",
    plugins: [{
      name: "isolated-android",
      setup(builder) {
        builder.onResolve({ filter: /androidManager$/ }, () => ({ path: "android", namespace: "test" }));
        builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({
          contents: "export async function keyevent(serial, code) { globalThis.exitEvents.push(['back', serial, code]); }",
          loader: "js",
        }));
      },
    }],
  });
  const { exitSnapchatConversation } = await import(pathToFileURL(outfile).href);
  globalThis.exitEvents = [];
  assert.equal(await exitSnapchatConversation({
    serial: "TEST_ONLY",
    isAborted: () => false,
    onLog() {},
    sleep: async (...args) => globalThis.exitEvents.push(["sleep", ...args]),
  }), true);
  assert.deepEqual(globalThis.exitEvents, [
    ["back", "TEST_ONLY", 4],
    ["sleep", 500, "exact"],
    ["back", "TEST_ONLY", 4],
  ]);
  console.log("PASS: exactly two Back presses separated by one 500ms wait; no screen reads.");
} finally {
  delete globalThis.exitEvents;
  await fs.rm(directory, { recursive: true, force: true });
}
