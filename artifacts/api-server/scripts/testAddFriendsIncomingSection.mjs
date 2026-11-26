import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "incoming-section-"));
try {
  const outfile = path.join(dir, "subject.mjs");
  await build({
    entryPoints: ["artifacts/api-server/src/mobile/hst/snapchat/navigation/scrollAddFriendsListOneSlot.ts"],
    outfile, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    plugins: [{
      name: "device-boundary",
      setup(b) {
        b.onResolve({ filter: /(?:androidManager|\/runtime)$/ }, args => ({ path: args.path, namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, args => ({
          contents: args.path.endsWith("runtime")
            ? `export const shortResourceId=n=>n.resourceId; export const center=n=>({x:(n.bounds[0]+n.bounds[2])/2,y:(n.bounds[1]+n.bounds[3])/2}); export const dump=()=>{throw Error("real device read")};`
            : `export const captureScreenPixels=()=>null; export const swipe=()=>{throw Error("real device input")};`,
        }));
      },
    }],
  });
  const { findFriendsRows, revealAddFriendsSuggestions } = await import(pathToFileURL(outfile).href);
  for (const resolutionScale of [1, 1.5]) {
   for (const movementScale of [0.55, 1, 1.5]) {
    const node = (id, text, top, bottom) => ({
      resourceId: id, text, desc: "", className: "",
      bounds: [20, top * resolutionScale, 700 * resolutionScale, bottom * resolutionScale],
    });
    let nodes = [
      node("section-title", "Added Me", 200, 240),
      node("scu_search_friend_cell", "", 240, 400),
      node("result-title", "Incoming person", 260, 300),
      node("scu_search_action_button", "Add", 270, 310),
      node("section-title", "Find friends", 500, 540),
      node("scu_search_friend_cell", "", 540, 680),
      node("result-title", "Recommendation", 560, 600),
      node("scu_search_action_button", "Add", 570, 610),
    ];
    assert.equal(findFriendsRows(nodes).length, 1, "Incoming rows must never be suggestion candidates.");
    assert.equal(findFriendsRows(nodes)[0].bounds[1], 540 * resolutionScale);
    const swipes = [];
    const result = await revealAddFriendsSuggestions({
      serial: `FAKE-${resolutionScale}-${movementScale}`, isAborted: () => false, onLog() {}, sleep: async () => {},
    }, nodes, 720 * resolutionScale, 1280 * resolutionScale, {
      dump: async () => ({ nodes }),
      swipe: async (_serial, _x1, y1, _x2, y2) => {
        assert(y2 < y1, "Only upward scrolling past requests.");
        const fingerTravel = y1 - y2;
        const contentTravel = fingerTravel * movementScale;
        swipes.push({ fingerTravel, contentTravel });
        nodes = nodes.map(n => ({
          ...n,
          bounds: [
            n.bounds[0],
            n.bounds[1] - contentTravel,
            n.bounds[2],
            n.bounds[3] - contentTravel,
          ],
        }));
      },
    });
    assert(swipes.length >= 1 && swipes.length <= 4, "Positioning must use bounded measured swipes.");
    const targetTop = 240 * resolutionScale;
    const firstContact = findFriendsRows(result)[0];
    assert(firstContact, "First recommendation remains identifiable after positioning.");
    assert(
      Math.abs(firstContact.bounds[1] - targetTop) <= Math.max(18, Math.round(1280 * resolutionScale * 0.012)),
      `First recommendation should align at the measured target; got ${firstContact.bounds[1]}, expected ${targetTop}.`,
    );
    assert.equal(findFriendsRows(result).length, 1);
   }
  }
  console.log("PASS: first Find friends contact positioned within tolerance at two screen resolutions and three movement ratios.");
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
