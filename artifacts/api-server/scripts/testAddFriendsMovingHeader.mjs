import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "add-friends-header-"));
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
            ? `export const shortResourceId=n=>n.resourceId; export const center=n=>({x:(n.bounds[0]+n.bounds[2])/2,y:(n.bounds[1]+n.bounds[3])/2}); export const dump=()=>{throw Error("unexpected real dump")};`
            : `export const swipe=()=>{throw Error("unexpected real input")};`,
        }));
      },
    }],
  });
  const { scrollAddFriendsListOneSlot } = await import(pathToFileURL(outfile).href);
  for (const actionLabel of ["adding", "dismissing"]) {
  for (const scale of [1, 1.5]) {
    const node = (id, text, top, bottom) => ({
      resourceId: id, text, desc: "", className: "", bounds: [20 * scale, top * scale, 700 * scale, bottom * scale],
    });
    let nodes = [
      node("section-title", "Find friends", 420, 460),
      node("scu_search_friend_cell", "", 607, 789),
      node("result-title", "Daniel", 630, 670),
      node("scu_search_friend_cell", "", 792, 974),
      node("result-title", "Jake Fallon", 820, 860),
    ];
    let swipes = 0;
    const logs = [];
    const completed = await scrollAddFriendsListOneSlot({
      serial: `MOVING-HEADER-${actionLabel}-${scale}`, isAborted: () => false,
      onLog: line => logs.push(line), sleep: async () => {},
    }, nodes, 720 * scale, 1640 * scale, "Daniel", actionLabel, {
      dump: async () => ({ nodes }),
      swipe: async (_serial, _x1, y1, _x2, y2) => {
        swipes++;
        nodes = nodes.map(n => {
          const delta = n.resourceId === "section-title"
            ? (swipes === 1 ? -144 * scale : 0)
            : y2 - y1;
          return { ...n, bounds: [n.bounds[0], n.bounds[1] + delta, n.bounds[2], n.bounds[3] + delta] };
        });
      },
    }, "Jake Fallon", 607 * scale, 460 * scale);
    assert.equal(completed, true);
    assert.equal(swipes, 2, "The old target must not be accepted after the header moves.");
    const row = nodes.find(n => n.resourceId === "scu_search_friend_cell" && n.bounds[1] > 400 * scale);
    assert(Math.abs(row.bounds[1] - 463 * scale) <= 1, "Jake must align to the updated live header position.");
    assert(logs.some(line => line.includes("header moved")));
  }
  }
  console.log("PASS: Add and Dismiss follow the live header target at two resolutions.");
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
