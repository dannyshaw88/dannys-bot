import fs from "node:fs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { transformSync } from "esbuild";

const source = fs.readFileSync(new URL("../src/mobile/androidManager.ts", import.meta.url), "utf8");
const start = source.indexOf("export async function captureOneTap(");
const end = source.indexOf("\n/**\n * Type text using a pre-calibrated key map", start);
assert(start >= 0 && end > start);
const js = transformSync(source.slice(start, end).replace("export async function", "async function"), {
  loader: "ts", format: "cjs",
}).code;
const original = { device: "/dev/input/event4", minX: 0, maxX: 1080, minY: 0, maxY: 2340 };

async function scenario({ active = [3], selectedWorks = false, validBounds = true } = {}) {
  const cache = new Map([["phone", original]]);
  const children = [];
  const logs = [];
  let recover = false;
  const spawn = (_adb, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    children.push(child);
    setTimeout(() => {
      if (args.at(-1) === "-l") {
        child.stdout.emit("data", Buffer.from(active.map(id =>
          `/dev/input/event${id}: EV_ABS ABS_MT_POSITION_X 000001f4\n` +
          `/dev/input/event${id}: EV_ABS ABS_MT_POSITION_Y 000003e8\n` +
          `/dev/input/event${id}: EV_SYN SYN_REPORT 00000000\n`,
        ).join("")));
      } else if (selectedWorks || (recover && args.at(-1) === "/dev/input/event3")) {
        child.stdout.emit("data", Buffer.from(
          "EV_ABS ABS_MT_POSITION_X 000001f4\nEV_ABS ABS_MT_POSITION_Y 000003e8\nEV_SYN SYN_REPORT 00000000\n",
        ));
      }
    }, 1);
    return child;
  };
  const fn = new Function(
    "detectToolset", "requireTool", "getScreenSize", "_calDeviceInfoCache",
    "_getTouchDeviceInfo", "spawn", "runAdb", `${js}; return captureOneTap;`,
  )(
    () => ({ adb: "adb" }), x => x, () => ({ w: 1080, h: 2340 }), cache,
    () => { throw new Error("Unexpected discovery"); }, spawn,
    async () => active.map(id =>
      `add device ${id}: /dev/input/event${id}\n name: "fts_ts"\n` +
      ` ABS_MT_POSITION_X : min 0 max ${validBounds ? 1000 : 0}\n ABS_MT_POSITION_Y : min 0 max 2000\n`,
    ).join(""),
  );
  const first = await fn("phone", 30, line => logs.push(line), true);
  if (!selectedWorks && active.length === 1 && validBounds) {
    assert.deepEqual(first, { x: 540, y: 1170 }, "Live alternate touch must complete the same capture");
    assert.equal(cache.get("phone").device, "/dev/input/event3");
    recover = true;
    const second = await fn("phone", 30, line => logs.push(line), true);
    assert.deepEqual(second, { x: 540, y: 1170 }, "Replacement must use its own axis ranges");
  } else {
    assert.equal(cache.get("phone"), original, "Working, ambiguous, or invalid sources must stay unchanged");
  }
  assert(children.every(child => child.killed), "All capture readers must be stopped");
}
await scenario();
await scenario({ selectedWorks: true });
await scenario({ active: [3, 6] });
await scenario({ validBounds: false });
await scenario({ active: [] });
console.log("PASS: silent-input recovery, own-axis mapping, working-device preservation, ambiguity rejection, invalid bounds, and cleanup");
