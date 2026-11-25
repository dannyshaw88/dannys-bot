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
  for (const scale of [1, 1.5]) {
    const node = (id, text, top, bottom) => ({
      resourceId: id, text, desc: "", className: "", bounds: [20, top * scale, 700 * scale, bottom * scale],
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
    assert.equal(findFriendsRows(nodes)[0].bounds[1], 540 * scale);
    const swipes = [];
    const result = await revealAddFriendsSuggestions({
      serial: "FAKE", isAborted: () => false, onLog() {}, sleep: async () => {},
    }, nodes, 720 * scale, 1280 * scale, {
      dump: async () => ({ nodes }),
      swipe: async (_serial, _x1, y1, _x2, y2) => {
        assert(y2 < y1, "Only upward scrolling past requests.");
        swipes.push(y1 - y2);
        // Simulate under-travel to exercise fresh-position corrections.
        nodes = nodes.map(n => ({ ...n, bounds: [n.bounds[0], n.bounds[1] - (y1 - y2) * .8, n.bounds[2], n.bounds[3] - (y1 - y2) * .8] }));
      },
    });
    assert(swipes.length > 1);
    assert(result.find(n => n.text === "Find friends").bounds[1] <= 200 * scale + 12);
    assert.equal(findFriendsRows(result).length, 1);
  }
  console.log("PASS: incoming requests excluded; live Find friends heading positioned with under-travel at two resolutions.");
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
