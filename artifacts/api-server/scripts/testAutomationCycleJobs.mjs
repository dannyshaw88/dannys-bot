import assert from "node:assert/strict";
import { build } from "esbuild";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cycle-jobs-"));
try {
  for (const [name, entry] of [
    ["jobs", "artifacts/api-server/src/mobile/automationCycleJobs.ts"],
    ["client", "artifacts/dannys-bot/src/lib/automationCycleRequest.ts"],
  ]) await build({ entryPoints: [entry], outfile: path.join(dir, `${name}.mjs`), bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const { AutomationCycleJobs } = await import(pathToFileURL(path.join(dir, "jobs.mjs")).href);
  const jobs = new AutomationCycleJobs();
  let release, cleanup, executions = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const cleanupGate = new Promise(resolve => { cleanup = resolve; });
  const handler = async (_req, res) => {
    executions++;
    await gate;
    res.json({ ok: true, likes: 3 });
    await cleanupGate; // Completion must wait for device lease release.
  };
  for (let i = 0; i < 100; i++) assert(jobs.start(`device${i}`, "cycle", {}, handler));
  assert.equal(executions, 100, "No staggering or global execution queue.");
  assert(jobs.start("device0", "cycle", {}, handler));
  assert.equal(executions, 100, "Retry is idempotent.");
  assert.equal(jobs.start("device0", "other", {}, handler), false);
  jobs.abort("device0", "stale");
  assert.equal(jobs.isAborted("device0", "cycle"), false);
  jobs.abort("device0", "cycle");
  assert(jobs.isAborted("device0", "cycle"));
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(jobs.get("device0", "cycle").state, "running");
  cleanup();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(jobs.get("device0", "cycle"), { state: "finished", status: 200, body: { ok: true, likes: 3 } });
  assert.equal(jobs.get("device1", "missing"), null);
  jobs.start("bad", "cycle", {}, async () => { throw Error("test failure"); });
  jobs.start("refused", "cycle", {}, async (_req, res) => res.status(409).json({ outsideScheduleWindow: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(jobs.get("bad", "cycle").status, 500);
  assert.equal(jobs.get("refused", "cycle").status, 409);
  console.log("PASS: 100 concurrent jobs, duplicate/busy handling, targeted abort, cleanup ordering and errors.");

  const { automationCycleRequest } = await import(pathToFileURL(path.join(dir, "client.mjs")).href);
  const originalFetch = globalThis.fetch, originalTimeout = globalThis.setTimeout;
  try {
    globalThis.setTimeout = (fn, _ms) => originalTimeout(fn, 0);
    let calls = [];
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
    globalThis.fetch = async (url, init) => {
      calls.push([url, init]);
      if (calls.length === 1) return json({ background: true, cycleId: "same-id" }, 202);
      return calls.length === 2
        ? json({ state: "running" })
        : json({ state: "finished", status: 503, body: { deviceUnavailable: true } });
    };
    const result = await automationCycleRequest("/cycle", { method: "POST" });
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { deviceUnavailable: true });
    assert.equal(calls[1][0], "/cycle/jobs/same-id");
    assert.equal(calls[1][1].cache, "no-store");
    globalThis.fetch = async () => json({ ok: true });
    assert.equal((await automationCycleRequest("/legacy", {})).status, 200);
    const abort = new AbortController();
    globalThis.fetch = async () => json({ background: true, cycleId: "aborted" }, 202);
    abort.abort();
    await assert.rejects(automationCycleRequest("/cycle", { signal: abort.signal }), { name: "AbortError" });
    console.log("PASS: short client polling, original result/status parity, legacy response and cancellation.");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalTimeout;
  }
  const route = await fs.readFile("artifacts/api-server/src/routes/mobile.ts", "utf8");
  const ui = await fs.readFile("artifacts/dannys-bot/src/pages/MobilePage.tsx", "utf8");
  assert(route.includes("await executeAutomationCycle(req, res)"));
  assert(route.includes("cycleJobs.abort(serial, cycleId)"));
  assert(route.includes("cycleJobs.isAborted(serial, incomingCycleId)"));
  assert(ui.includes('await automationCycleRequest(`/api/mobile/devices/'));
  assert(ui.includes("background: true,"));
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
