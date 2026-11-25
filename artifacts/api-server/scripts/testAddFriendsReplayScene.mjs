import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { build } from "esbuild";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(apiRoot, "../..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "add-friends-scene-test-"));
try {
  const modulePath = path.join(temp, "scene.mjs");
  await build({
    entryPoints: [path.resolve(apiRoot, "../dannys-bot/src/components/tools/addFriendsReplayScene.ts")],
    outfile: modulePath, bundle: true, platform: "node", format: "esm", logLevel: "silent",
  });
  const { prepareScene, contactsFrom, dismissReplayContact, serializeNodes, parseInspectNodes, rowGroups, listTopFor } = await import(pathToFileURL(modulePath).href);
  const read = name => fs.readFile(path.join(root, "attached_assets", name), "utf8");
  const latest = prepareScene(await read("equinox-inspect-dump-1795566367033_1795566446072.txt"));
  const firstEligible = contactsFrom(latest.nodes).find(card =>
    !card.dismissed && card.action === "Add" && card.top >= listTopFor(latest));
  assert.equal(listTopFor(latest), 610);
  assert.equal(firstEligible?.name, "T_KiimsS BlChrD");
  assert.equal(firstEligible?.top, 610, "The first visible card must not be excluded by estimated header padding.");
  const mixed = prepareScene(await read("equinox-inspect-dump-1795563512708_1795563527991.txt"));
  const mixedCards = contactsFrom(mixed.nodes);
  const azou = mixedCards.find(card => card.name === "azou");
  const deejay = mixedCards.find(card => card.name.startsWith("deejay"));
  assert.equal(azou.reason, "");
  assert.equal(azou.top, 405);
  assert.equal(azou.height, 182);
  assert.equal(deejay.reason, "7+ MUTUAL FRIENDS");
  assert.equal(deejay.height, 188);
  assert.equal(deejay.top, 590);
  assert(mixedCards.find(card => card.name === "Fred").bottom < 0, "Cached cards must stay above the visible list.");
  const contactsText = await read("equinox-inspect-dump-1795563594602_1795563612145.txt");
  const contacts = prepareScene(contactsText);
  const contactCards = contactsFrom(contacts.nodes);
  assert.equal(contactCards[0].height, 137);
  assert.equal(contactCards[0].reason, "IN MY CONTACTS");
  assert.equal(contactCards[1].height, 132);
  assert.equal(contactCards[1].top, 643);
  // Every measured card height survives importing, including rows without reasons.
  for (const text of [contactsText, await read("equinox-inspect-dump-1795563512708_1795563527991.txt")]) {
    const original = rowGroups(parseInspectNodes(text)).map(group => group.row.bounds[3] - group.row.bounds[1]);
    assert.deepEqual(contactsFrom(prepareScene(text).nodes).map(card => card.height), original);
  }
  const dismissed = dismissReplayContact(contacts.nodes, contactCards[0].name, contacts.width);
  const dismissedCards = contactsFrom(dismissed);
  const realDismissed = prepareScene(await read("DISMISSED_1795563650788.txt"));
  const feedback = dismissedCards[0];
  assert.equal(feedback.dismissed, true);
  assert.equal(feedback.height, 151);
  assert.equal(dismissedCards[1].top, 657, "Following card must move down by the feedback's 14px growth.");
  assert.equal(feedback.name, contactsFrom(realDismissed.nodes)[0].name);
  assert.equal(feedback.height, contactsFrom(realDismissed.nodes)[0].height);
  for (const id of ["feedback-title", "fisrt-feedback", "second-feedback"]) {
    assert.deepEqual(feedback.children.find(node => node.resourceId === id)?.bounds,
      contactsFrom(realDismissed.nodes)[0].children.find(node => node.resourceId === id)?.bounds);
  }
  const xmlPath = path.join(temp, "screen.xml");
  await fs.writeFile(xmlPath, serializeNodes(contacts.nodes));
  const { stdout } = await promisify(execFile)(process.execPath, [
    path.join(apiRoot, "scripts/replayAddFriendsScroll.mjs"), `--xml=${xmlPath}`, "--screen=720,1640",
    `--friend=${contactCards[0].name}`, "--action=dismiss", "--align-before-action", "--return-screen",
  ], { cwd: apiRoot, maxBuffer: 2 * 1024 * 1024 });
  const replay = JSON.parse(stdout);
  assert.equal(replay.result, "PASS");
  assert.equal(contactsFrom(replay.afterActionNodes)[0].height, 151);
  assert.equal(contactsFrom(replay.afterActionNodes)[0].dismissed, true);
  assert.equal(replay.expectedNext, "Yes 119");
  assert.equal(replay.actualTop, 506);
  assert.equal(contactsFrom(replay.nodes)[0].bottom, 506);
  assert(replay.logs.some(line => /dismissing/.test(line)), "Must use the actual Dismiss alignment path.");
  console.log("PASS: exact imported row heights, blank/mutual/contact subtitles, original viewport, real 151px feedback structure, 14px reflow, after-action snapshot, and real Dismiss scroll helper.");
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
