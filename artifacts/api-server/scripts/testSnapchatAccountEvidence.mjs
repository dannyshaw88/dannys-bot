import fs from "node:fs";
import assert from "node:assert/strict";

const routes = fs.readFileSync(new URL("../src/routes/mobile.ts", import.meta.url), "utf8");
const androidSource = fs.readFileSync(new URL("../src/mobile/androidManager.ts", import.meta.url), "utf8");
const runner = fs.readFileSync(new URL("../src/mobile/hst/snapchat/runner.ts", import.meta.url), "utf8");
const accountSelector = fs.readFileSync(new URL("../src/mobile/hst/snapchat/navigation/selectSnapchatAccount.ts", import.meta.url), "utf8");
const { transformSync } = await import("esbuild");
const exported = [];
const logger = { info: (...args) => exported.push(args.at(-1)) };
const tLogStart = routes.indexOf("const tLog = (msg: string) =>");
const tLogEnd = routes.indexOf("\n    // Screen state", tLogStart);
assert(tLogStart >= 0 && tLogEnd > tLogStart);
const tLogJs = transformSync(routes.slice(tLogStart, tLogEnd), { loader: "ts" }).code;
const tLog = new Function(
  "logger", "configuredSlot", "cycleStart", "serial", "incomingSlotIdx", "incomingCycleId",
  "sendVideoLog", "pushDebugLogLine", "queueDebugScreenshot", "notebookStarted",
  "appendSlotCycleNotebook", "slotId", `${tLogJs}; return tLog;`,
)(logger, { platform: "snapchat" }, Date.now(), "test-phone", 1, "test-cycle",
  () => {}, () => {}, () => { throw new Error("Unexpected screenshot"); }, false, () => {}, "test-slot");
for (const message of [
  "Snapchat account check: slot expects @target; current profile is @other.",
  "Snapchat account switch: logout was confirmed; enabling Airplane mode.",
  "Snapchat tools not started: could not confirm the active Snapchat profile.",
  "Snapchat account verification result: not-confirmed; target=@target.",
  "Snapchat tool dispatcher skipped because the configured slot account was not confirmed.",
]) tLog(message);
assert.equal(exported.length, 5);
assert(exported.every(line => line.includes("serial=test-phone slotIdx=1 cycleId=test-cycle")));
tLog("Snapchat: typing a reply"); // No conversation text or per-key noise in export.
assert.equal(exported.length, 5);

const probeStart = routes.indexOf("const logScreenState = async");
const probeEnd = routes.indexOf("\n    let notebookStarted", probeStart);
const probeJs = transformSync(routes.slice(probeStart, probeEnd), { loader: "ts" }).code;
const calls = [];
const android = {
  isScreenOn: async () => { calls.push("screen"); return true; },
  getForegroundPackage: async () => { calls.push("foreground"); return "com.snapchat.android"; },
  listDevices: async () => { calls.push("devices"); return [{ serial: "test-phone", state: "device" }]; },
};
const probe = new Function(
  "logger", "android", "serial", "slotId", "incomingSlotIdx", "incomingCycleId", "cycleStart", "tLog",
  `${probeJs}; return logScreenState;`,
)(logger, android, "test-phone", "test-slot", 1, "test-cycle", Date.now(), () => {});
await probe("post-unlock-300ms");
assert.deepEqual(calls, ["screen", "foreground", "devices"], "Only the existing probe calls are allowed");
const evidence = exported.at(-1);
assert(evidence.includes('"screenOn":true') && evidence.includes('"foreground":"com.snapchat.android"'));
assert(evidence.includes('"phase":"post-unlock-300ms"'));
assert(androidSource.includes("keyguardBefore=${JSON.stringify(keyguardBefore)} keyguardAfter=${JSON.stringify(keyguardAfter)}"));
assert.equal((runner.match(/ensureSnapchatAccount\(context, startupPopupResult === "tapped"\)/g) ?? []).length, 1);
assert(runner.includes('if (!accountConfirmed) {'));
assert(accountSelector.includes('node.clickable && exactLabel(node, "Switch Account")'));
assert(accountSelector.includes('if (!targetAlreadyVisible && switchAccountControl)'));
assert(accountSelector.includes('"open saved Snapchat account list", 500, true'));
assert(accountSelector.includes("const newAccountRows = [...visibleAccountUsernames(openedState)]"));
assert(accountSelector.includes("stopping before any carousel swipe"));
console.log("PASS: message-only export retains account failures, screen and keyguard results; no extra device calls or verification calls");
