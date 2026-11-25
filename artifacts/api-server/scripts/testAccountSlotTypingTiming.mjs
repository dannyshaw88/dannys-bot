import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, transform } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "account-typing-timing-"));
try {
  const outfile = path.join(directory, "timing.mjs");
  await build({
    entryPoints: [path.join(root, "src/diagnostics/accountSlotTyping.ts")],
    outfile, bundle: true, platform: "node", format: "esm",
  });
  const { accountSlotTypingTiming } = await import(pathToFileURL(outfile).href);
  assert.equal(accountSlotTypingTiming(
    "[account-slot-typing] sent 3 calibrated key tap(s) in 1500ms (ADB 1200ms, queued 100ms, configured pauses 200ms)"
  ), "batch taps=3 totalMs=1500 adbMs=1200 queueMs=100 configuredPausesMs=200");
  assert.equal(accountSlotTypingTiming(
    '[account-slot-typing] per-tap ADB timings (3/3 captured, 10ms resolution): ["p":120ms, "\\\"":300ms, "s":210ms]'
  ), "per-tap captured=3/3 resolutionMs=10 [tap1=120ms, tap2=300ms, tap3=210ms]");
  assert.equal(accountSlotTypingTiming('[cal-keyboard] typing password=secret'), null);
  const route = await fs.readFile(path.join(root, "src/routes/mobile.ts"), "utf8");
  const section = route.split('app.post("/api/mobile/devices/:serial/input/type-calibrated"')[1].split("// Account phone-number entry")[0];
  assert.match(section, /measureTapTimings: true/);
  assert.match(section, /batchTaps: true/);
  assert.match(section, /compactLogs: true/);
  assert.match(section, /accountSlotTypingTiming\(message\)/);
  const handlerText = section.slice(section.indexOf("async"), section.lastIndexOf("});") + 1);
  const { code } = await transform(`const handler = ${handlerText};`, { loader: "ts" });
  const logs = [];
  let response;
  const handler = new Function("inputTextSchema", "p", "android", "effectiveTypingProfile",
    "accountSlotTypingTiming", `${code}; return handler;`)(
    { parse: value => value }, () => "TEST_ONLY",
    { typeViaSavedCalibrationMap: async (serial, text, profile, onLog, options) => {
      assert.equal(serial, "TEST_ONLY");
      assert.equal(text, "dummy-secret");
      assert.equal(options.measureTapTimings, true);
      assert.equal(options.batchTaps, true);
      onLog('[account-slot-typing] per-tap ADB timings (1/1 captured, 10ms resolution): ["d":120ms]');
      return { ok: true, available: true, missing: [] };
    } },
    () => ({}), accountSlotTypingTiming,
  );
  await handler({ body: { text: "dummy-secret" }, log: { info: message => logs.push(message) } },
    { json: value => { response = value; }, status: () => { throw new Error("Unexpected failed response"); } });
  assert.deepEqual(response, { ok: true, calibrated: true });
  assert(logs.some(line => line.includes("tap1=120ms")));
  assert(logs.every(line => !line.includes("dummy-secret") && !line.includes('"d"')));
  console.log("PASS: account-slot typing enables per-tap diagnostics and retains timing data without logging typed keys.");
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
