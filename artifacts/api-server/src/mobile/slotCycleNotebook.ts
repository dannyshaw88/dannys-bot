import fs from "fs";
import path from "path";

const MAX_CYCLES = 10;
const dataDir = process.env.EQUINOX_DATA_DIR
  ? path.join(process.env.EQUINOX_DATA_DIR, "mobile-cycle-notebooks")
  : path.join(path.dirname(path.resolve(process.argv[1] ?? ".")), "..", "mobile-cycle-notebooks");

type NotebookCycle = {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "complete" | "aborted" | "failed";
  slotId: string;
  username: string;
  lines: string[];
};

type NotebookFile = { version: 1; cycles: NotebookCycle[] };

const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
const filePath = (serial: string, slotId: string) =>
  path.join(dataDir, `${safe(serial)}__${safe(slotId)}.json`);

function readFile(serial: string, slotId: string): NotebookFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(serial, slotId), "utf8"));
    if (parsed?.version === 1 && Array.isArray(parsed.cycles)) return parsed;
  } catch {}
  return { version: 1, cycles: [] };
}

function writeFile(serial: string, slotId: string, value: NotebookFile): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const target = filePath(serial, slotId);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temp, target);
}

export function startSlotCycleNotebook(args: {
  serial: string; slotId: string; username: string; cycleId: string;
}): void {
  const data = readFile(args.serial, args.slotId);
  data.cycles.push({
    id: args.cycleId,
    startedAt: new Date().toISOString(),
    status: "running",
    slotId: args.slotId,
    username: args.username,
    lines: [`=== Cycle ${args.cycleId} — ${args.username || "unassigned"} — started ===`],
  });
  writeFile(args.serial, args.slotId, { version: 1, cycles: data.cycles.slice(-MAX_CYCLES) });
}

export function appendSlotCycleNotebook(serial: string, slotId: string, cycleId: string, line: string): void {
  const data = readFile(serial, slotId);
  const cycle = data.cycles.find(item => item.id === cycleId);
  if (!cycle) return;
  cycle.lines.push(line);
  writeFile(serial, slotId, data);
}

export function finishSlotCycleNotebook(args: {
  serial: string; slotId: string; cycleId: string;
  status: "complete" | "aborted" | "failed"; summary: string;
}): void {
  const data = readFile(args.serial, args.slotId);
  const cycle = data.cycles.find(item => item.id === args.cycleId);
  if (!cycle) return;
  cycle.status = args.status;
  cycle.finishedAt = new Date().toISOString();
  cycle.lines.push(`${args.status === "complete" ? "✓" : "✗"} ${args.summary}`);
  cycle.lines.push(`=== Cycle ${cycle.id} — ${args.status} ===`);
  writeFile(args.serial, args.slotId, { version: 1, cycles: data.cycles.slice(-MAX_CYCLES) });
}

export function getSlotCycleNotebook(serial: string, slotId: string) {
  const data = readFile(serial, slotId);
  const text = data.cycles.map(c => c.lines.join("\n")).join("\n\n");
  return { ok: true, slotId, cycles: data.cycles.map(({ lines, ...meta }) => meta), text };
}