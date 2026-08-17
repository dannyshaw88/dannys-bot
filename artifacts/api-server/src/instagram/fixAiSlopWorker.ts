import { readFile, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const inputPath = process.argv[2];
const outputPath = process.argv[3];

function log(stage: string, details = "") {
  const line = `[${new Date().toISOString()}] pid=${process.pid} operation=fixAiSlopWorker stage=${stage}${details ? ` ${details}` : ""}\n`;
  try {
    if (process.env.LOG_FILE) appendFileSync(process.env.LOG_FILE, line);
    appendFileSync(join(tmpdir(), "equinox-last-native-operation.log"), line);
  } catch {}
}

try {
  log("start", `input=${inputPath ?? "missing"} output=${outputPath ?? "missing"}`);
  if (!inputPath || !outputPath) throw new Error("worker requires input and output paths");
  log("sharp-import");
  const sharp = (await import("sharp")).default;
  sharp.concurrency(1);
  sharp.cache(false);
  log("sharp-import-complete");
  const input = await readFile(inputPath);
  log("sharp-pipeline", `inputBytes=${input.length}`);
  const output = await sharp(input, {
    limitInputPixels: 100_000_000,
    sequentialRead: true,
    failOn: "error",
  })
    .withMetadata(false)
    .jpeg({ quality: Number(process.env.FIX_AI_SLOP_QUALITY ?? 90), chromaSubsampling: "4:2:0", force: true })
    .toBuffer();
  await writeFile(outputPath, output);
  log("complete", `outputBytes=${output.length}`);
  process.exit(0);
} catch (error) {
  log("failed", error instanceof Error ? error.message : String(error));
  console.error(`[fixAiSlopWorker] failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
}