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
    for (const incomingCount of [1, 2, 3]) {
      for (const movementScale of [0.55, 1, 1.5]) {
        const node = (id, text, top, bottom) => ({
          resourceId: id, text, desc: "", className: "",
          bounds: [20, top * resolutionScale, 700 * resolutionScale, bottom * resolutionScale],
        });
        const findFriendsHeadingTop = 500 + (incomingCount - 1) * 160;
        const recommendationTop = findFriendsHeadingTop + 40;
        const incomingRows = Array.from({ length: incomingCount }, (_, index) => {
          const top = 240 + index * 160;
          return [
            node("scu_search_friend_cell", "", top, top + 160),
            node("result-title", `Incoming person ${index + 1}`, top + 20, top + 60),
            node("scu_search_action_button", "Add", top + 30, top + 70),
          ];
        }).flat();
        let nodes = [
          node("section-title", "Added Me", 200, 240),
          ...incomingRows,
          node("section-title", "Find friends", findFriendsHeadingTop, findFriendsHeadingTop + 40),
          node("scu_search_friend_cell", "", recommendationTop, recommendationTop + 140),
          node("result-title", "Recommendation", recommendationTop + 20, recommendationTop + 60),
          node("scu_search_action_button", "Add", recommendationTop + 30, recommendationTop + 70),
        ];
        assert.equal(findFriendsRows(nodes).length, 1, "Incoming rows must never be suggestion candidates.");
        assert.equal(findFriendsRows(nodes)[0].bounds[1], recommendationTop * resolutionScale);
        const swipes = [];
        const result = await revealAddFriendsSuggestions({
          serial: `FAKE-${resolutionScale}-${incomingCount}-${movementScale}`, isAborted: () => false, onLog() {}, sleep: async () => {},
        }, nodes, 720 * resolutionScale, 1280 * resolutionScale, {
          dump: async () => ({ nodes }),
          swipe: async (_serial, _x1, y1, _x2, y2, durationMs = 300) => {
            assert(y2 < y1, "Only upward scrolling past requests.");
            const fingerTravel = y1 - y2;
            // Larger gestures fling farther at the old fixed 300ms duration.
            // Scaling duration from the first measured swipe keeps the tested
            // gesture speed stable while preserving each device's travel factor.
            const speed = fingerTravel / durationMs;
            const flingMultiplier = 1 + Math.max(0, speed - 0.25) * 2;
            const contentTravel = Math.round(fingerTravel * movementScale * flingMultiplier);
            swipes.push({ fingerTravel, contentTravel, durationMs });
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
        assert(firstContact, `First recommendation remains identifiable after positioning (resolution=${resolutionScale}, Added Me rows=${incomingCount}, movement=${movementScale}).`);
        assert(
          Math.abs(firstContact.bounds[1] - targetTop) <= Math.max(24, Math.round(1280 * resolutionScale * 0.012)),
          `First recommendation should align at the measured target; got ${firstContact.bounds[1]}, expected ${targetTop}.`,
        );
        assert.equal(findFriendsRows(result).length, 1);
      }
    }
  }
  console.log("PASS: first Find friends contact aligned across one-to-three Added Me rows, two resolutions, and three swipe-response ratios.");
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
