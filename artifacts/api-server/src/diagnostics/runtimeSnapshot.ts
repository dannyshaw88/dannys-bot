import { monitorEventLoopDelay } from "node:perf_hooks";
import { performance } from "node:perf_hooks";
import { startupPhases, recentStartupPhases } from "./startupTiming";

const histogram = monitorEventLoopDelay({ resolution: 20 });
histogram.enable();
const samples: Array<Record<string, number>> = [];
let lastTick = performance.now();

setInterval(() => {
  const now = performance.now();
  const timerDelayMs = Math.max(0, Math.round(now - lastTick - 1000));
  lastTick = now;
  if (timerDelayMs >= 250 || histogram.max / 1e6 >= 250) {
    console.warn(`[STARTUP-DIAG] ${JSON.stringify({
      event: "api-stall", at: new Date().toISOString(), pid: process.pid,
      timerDelayMs, eventLoopMaxMs: Math.round(histogram.max / 1e6),
      activePhases: startupPhases(),
      recentPhases: recentStartupPhases(),
    })}`);
  }
  const memory = process.memoryUsage();
  samples.push({
    at: Date.now(),
    eventLoopP50Ms: histogram.percentile(50) / 1e6,
    eventLoopP99Ms: histogram.percentile(99) / 1e6,
    eventLoopMaxMs: histogram.max / 1e6,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
  });
  if (samples.length > 300) samples.shift();
  histogram.reset();
}, 1000).unref();

export function getRuntimeSnapshot() {
  const memory = process.memoryUsage();
  return {
    generatedAt: new Date().toISOString(),
    windowSeconds: 300,
    runtime: {
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal, externalBytes: memory.external },
    },
    activeStartupPhases: startupPhases(),
    samples: samples.slice(),
  };
}