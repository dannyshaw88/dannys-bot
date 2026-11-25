import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "snapchat-owner-test-"));
try {
  const outfile = path.join(directory, "store.mjs");
  await build({
    entryPoints: ["src/mobile/snapchatConversationStore.ts"],
    outfile, bundle: true, platform: "node", format: "esm",
    plugins: [{ name: "isolated-db", setup(builder) {
      builder.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: "db", namespace: "test" }));
      builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({
        contents: `export const sqlite = { name: ${JSON.stringify(path.join(directory, "isolated.db"))} };`,
      }));
    } }],
  });
  const store = await import(pathToFileURL(outfile).href);
  const append = (accountUsername, slotId = "slot-one", serial = "device-one", username = "contact.one", sentText = "hello") =>
    store.appendSnapchatReplyHistory({
      accountUsername, slotId, serial, username, displayName: "Shared Name",
      capturedMessages: ["Contact: hi"], sentText, sentAt: new Date().toISOString(),
    });
  append("original.account", undefined, undefined, undefined, "https://boundlus.com/example");
  assert.equal(store.getSnapchatReplyHistory("replacement.account", "contact.one").previousReplyCount, 0);
  append("replacement.account");
  assert.equal(store.getSnapchatReplyHistory("replacement.account", "contact.one").previousReplyCount, 1);
  assert.equal(store.getSnapchatReplyHistory("original.account", "contact.one").sentReplies[0].sentText, "https://boundlus.com/example");
  append("@ORIGINAL.ACCOUNT", "other-slot", "other-device");
  assert.equal(store.getSnapchatReplyHistory("original.account", "contact.one").previousReplyCount, 2);
  assert.equal(store.getSnapchatReplyHistory("@Original.Account", "contact.one").sentReplies.length, 2);
  append("original.account", "other-slot", "other-device", "other.contact");
  assert.equal(store.getSnapchatReplyHistory("original.account", "other.contact").previousReplyCount, 1);
  append(undefined);
  assert.equal(store.getSnapchatReplyHistory("brand.new.account", "contact.one").previousReplyCount, 0);
  assert.equal(store.getSnapchatReplyHistory("", "contact.one").previousReplyCount, 0);
  const rows = (await fs.readFile(path.join(directory, "snapchat-conversations.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(rows.filter(row => row.accountUsername?.replace(/^@/, "").toLowerCase() === "original.account" && row.username === "contact.one").length, 1);
  console.log("PASS: replacement accounts cannot inherit prior-account history, counts, or links in the same slot/device.");
  console.log("PASS: same account retains history across slots/devices; contact usernames, ownerless records, and case normalization remain isolated.");
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
