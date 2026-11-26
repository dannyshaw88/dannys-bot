import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const panel = await fs.readFile(new URL("../../dannys-bot/src/components/BrowserPanel.tsx", import.meta.url), "utf8");
const cleanupStart = panel.indexOf("useEffect(() => () => {", panel.indexOf("ws.onclose ="));
const cleanupEnd = panel.indexOf("}, []);", cleanupStart);
const oncloseStart = panel.indexOf("ws.onclose = () => {");
const oncloseEnd = panel.indexOf("\n    ws.onerror", oncloseStart);
assert(cleanupStart > 0 && cleanupEnd > cleanupStart && oncloseStart > 0);
const state = {
  wsGenRef: { current: 1 }, myGen: 1,
  reconnectTimerRef: { current: null }, firstFrameFallbackRef: { current: 123 },
  esRef: { current: null }, rafIdRef: { current: null }, pendingBitmapRef: { current: null },
  statusRef: { current: "connected" },
  calls: [], ws: {}, setIsLoading() {}, setStatusSafe() {},
  clearTimeout() {}, cancelAnimationFrame() {},
  connect() { state.calls.push("connect"); },
  setTimeout() { state.calls.push("reconnect-timer"); },
};
vm.createContext(state);
vm.runInContext(panel.slice(oncloseStart, oncloseEnd), state);
const oldClose = state.ws.onclose;
state.esRef.current = { close() { state.calls.push("close"); } };
vm.runInContext(panel.slice(cleanupStart + "useEffect(() => () => {".length, cleanupEnd), state);
oldClose(); // Browser close arrives AFTER React unmount cleanup.
assert.deepEqual(state.calls, ["close"], "unmounted panel must not start a reconnect");
assert.equal(state.firstFrameFallbackRef.current, null);
assert.equal(state.esRef.current, null);
for (const marker of ["ws.onopen = () => {", "ws.onmessage = (evt) => {"]) {
  const body = panel.slice(panel.indexOf(marker) + marker.length).trimStart();
  assert(body.startsWith("if (wsGenRef.current !== myGen) return;"), "stale socket event guard");
}

const route = await fs.readFile(new URL("../src/routes/instagram.ts", import.meta.url), "utf8");
const routeStart = route.indexOf("// A view may unmount while Chromium is starting.");
const routeEnd = route.indexOf("attachWS(profileId, ws);", routeStart) + "attachWS(profileId, ws);".length;
assert(routeStart > 0 && routeEnd > routeStart);
function check(id, readyState, active) {
  const calls = [];
  const sandbox = {
    profileId: id, GOOGLE_CHROME_BROWSER_PROFILE_ID: 10_000_000,
    hasActiveWS: () => active,
    ws: { readyState, send: () => calls.push("reject"), close: () => calls.push("close") },
    attachWS: () => calls.push("attach"), console: { log() {} },
  };
  vm.runInNewContext(`(() => { ${route.slice(routeStart, routeEnd)} })()`, sandbox);
  return calls;
}
assert.deepEqual(check(10_000_000, 1, true), ["attach"], "returning Chrome view takes over one browser stream");
assert.deepEqual(check(10_000_000, 3, true), [], "closed launch socket never displaces returning view");
assert.deepEqual(check(1_234_567, 1, true), ["reject", "close"], "other device duplicate guard preserved");
assert.deepEqual(check(10_000_000, 1, false), ["attach"], "first Chrome connection still attaches");
console.log("PASS: unmount/late-close has no phantom reconnect; stale callbacks, returning Chrome takeover, closed launch and other-device guards.");
