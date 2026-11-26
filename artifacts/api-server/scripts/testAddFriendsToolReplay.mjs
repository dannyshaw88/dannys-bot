import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { build } from "esbuild";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "test-real-add-friends-"));
try {
  const modelPath = path.join(directory, "model.mjs");
  await build({
    entryPoints: [path.resolve(apiRoot, "../dannys-bot/src/components/tools/addFriendsReplayScene.ts")],
    outfile: modelPath, bundle: true, platform: "node", format: "esm", logLevel: "silent",
  });
  const model = await import(pathToFileURL(modelPath).href);
  const contacts = model.prepareScene(await fs.readFile(path.resolve(apiRoot,
    "../../attached_assets/equinox-inspect-dump-1795563594602_1795563612145.txt"), "utf8"));
  const mixed = model.prepareScene(await fs.readFile(path.resolve(apiRoot,
    "../../attached_assets/equinox-inspect-dump-1795563512708_1795563527991.txt"), "utf8"));
  let run = 0;
  async function execute(scene, friendName, action, extra = {}) {
    const input = path.join(directory, `input-${run++}.json`);
    await fs.writeFile(input, JSON.stringify({
      uiXml: model.serializeNodes(scene.nodes), screenWidth: scene.width,
      screenHeight: scene.height, friendName, action, ...extra,
    }));
    const startedAt = Date.now();
    const { stdout } = await promisify(execFile)(process.execPath, [
      path.join(apiRoot, "scripts/runAddFriendsToolReplay.mjs"), input,
    ], { cwd: apiRoot, maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });
    const events = stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events.some(event => event.type === "error"), false);
    const start = events.find(event => event.type === "start");
    const done = events.find(event => event.type === "done");
    assert(start.sourceFiles.includes("src/mobile/hst/snapchat/tools/addFriends.ts"));
    assert(start.sourceFiles.includes("src/mobile/hst/snapchat/runtime.ts"));
    assert(start.sourceFiles.includes("src/mobile/hst/snapchat/navigation/scrollAddFriendsListOneSlot.ts"));
    const hash = createHash("sha256");
    for (const filename of [...start.sourceFiles].sort()) hash.update(await fs.readFile(path.resolve(apiRoot, filename)));
    assert.equal(start.sourceHash, hash.digest("hex").slice(0, 12), "The runner must compile/hash today's source, not a cached tool copy.");
    assert(done);
    if (done.completedStep) {
      assert(Date.now() - startedAt >= 3000, "The visible replay must preserve the three-second post-action settle.");
    }
    return { events, done };
  }
  for (const action of ["add", "dismiss", "skip"]) {
    const { events, done } = await execute(contacts, "Entourage Mike Hunt", action, {
      requestedCount: 2, delaySeconds: 25,
    });
    assert.deepEqual(done.completedStep, { action, friendName: "Entourage Mike Hunt" });
    assert.equal(done.nextVisibleContact, "Yes 119");
    assert.equal(done.actions.length, action === "skip" ? 0 : 1);
    assert(done.swipes.length >= 1);
    const frames = events.filter(event => event.type === "frame");
    if (action === "dismiss") {
      const feedback = model.contactsFrom(frames[0].nodes)[0];
      assert(feedback.dismissed);
      assert.equal(feedback.height, 151);
      assert.equal(done.swipes[0].contentMovement, -151);
    }
    assert.equal(model.contactsFrom(done.nodes).find(card => card.name === "Yes 119").top, 506);
    assert(done.logs.some(line => line.includes(action === "skip" ? "Skip because" : `is ${action === "add" ? "Add" : "Dismiss"}`)));
    const waits = done.logs.filter(line => line.includes("waiting 25s between actions"));
    assert.equal(waits.length, action === "add" ? 1 : 0,
      "Only a completed Add may consume the configured delay, before the next contact is considered.");
    console.log(`PASS: actual runAddFriends ${action} path, streamed inputs and final device position.`);
  }
  const slow = await execute(mixed, "azou", "add", { movementScale: 0.55 });
  assert.equal(slow.done.completedStep.friendName, "azou");
  assert(slow.done.swipes.length > 1, "Under-travel must invoke real correction gestures.");
  assert(slow.done.logs.some(line => /correction/.test(line)));
  assert(
    slow.done.swipes.every(swipe => swipe.y2 < swipe.y1),
    "Add Friends under-travel corrections must keep moving forward, never swipe backward.",
  );
  assert(slow.events.filter(event => event.type === "frame" && event.kind === "swipe").length === slow.done.swipes.length);
  console.log("PASS: reduced content travel triggers forward-only corrections, not reverse swipes.");
  const unavailable = { ...contacts, nodes: contacts.nodes.map(node =>
    node.resourceId === "scu_search_action_button" ? { ...node, text: "Requested", desc: "Requested" } : node) };
  const empty = await execute(unavailable, "Entourage Mike Hunt", "add");
  assert.equal(empty.done.completedStep, null);
  assert.equal(empty.done.actions.length, 0);
  assert.equal(empty.done.swipes.length, 0);
  console.log("PASS: no eligible Add rows produced the real no-action result, not a fabricated pass.");
  const capped = await execute(contacts, "Entourage Mike Hunt", "add", {
    maxFollowsEnabled: true, maxFollowsMin: 0, maxFollowsMax: 0,
  });
  assert.equal(capped.done.completedStep, null);
  assert.equal(capped.done.actions.length, 0);
  assert.equal(capped.done.swipes.length, 0);
  assert(capped.done.logs.some(line => line.includes("daily Max Follows reached")));
  console.log("PASS: daily cap skips the actual tool before any device input.");
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
