import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "startup-timing-"));
const originalInfo = console.info;
const originalWarn = console.warn;
const lines = [];
try {
  const outfile = path.join(directory, "diagnostics.mjs");
  await build({
    stdin: {
      contents: `export * from "./src/diagnostics/startupTiming"; export * from "./src/diagnostics/runtimeSnapshot";`,
      resolveDir: root, loader: "ts",
    },
    outfile, bundle: true, platform: "node", format: "esm",
  });
  console.info = console.warn = line => lines.push(line);
  const diagnostics = await import(pathToFileURL(outfile).href);
  const endA = diagnostics.beginStartupPhase("TEST_A", "launch");
  const endB = diagnostics.beginStartupPhase("TEST_B", "unlock");
  assert.equal(diagnostics.startupPhases().length, 2);
  endA(); endA();
  assert.equal(diagnostics.startupPhases().length, 1, "End must be idempotent.");
  endB();
  assert.equal(await diagnostics.timeStartupPhase("TEST_A", "success", async () => 42), 42);
  const expectedError = new Error("test failure");
  await assert.rejects(diagnostics.timeStartupPhase("TEST_A", "failure", async () => { throw expectedError; }), error => error === expectedError);
  assert.equal(diagnostics.startupPhases().length, 0);
  assert(diagnostics.recentStartupPhases().some(item => item.phase === "failure" && item.failed));
  for (let i = 0; i < 40; i++) diagnostics.beginStartupPhase("TEST_A", "bounded")();
  assert.equal(diagnostics.recentStartupPhases().length, 30);
  // Simulate a blocked process, not a real phone operation.
  await new Promise(resolve => setTimeout(resolve, 1100));
  const endBlocked = diagnostics.beginStartupPhase("TEST_A", "synthetic-block");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  endBlocked();
  await new Promise(resolve => setTimeout(resolve, 1100));
  const stall = lines.filter(line => line.includes('"event":"api-stall"'));
  assert(stall.length > 0);
  assert(stall.some(line => line.includes("synthetic-block")), "Stall must retain completed blocking phases.");
  assert(diagnostics.getRuntimeSnapshot().samples.length > 0);
  console.info = originalInfo;
  console.warn = originalWarn;
  console.log("PASS: concurrent phase timings, bounded retention, unchanged return/errors, and synthetic API stall detection.");
} finally {
  console.info = originalInfo;
  console.warn = originalWarn;
  await fs.rm(directory, { recursive: true, force: true });
}
