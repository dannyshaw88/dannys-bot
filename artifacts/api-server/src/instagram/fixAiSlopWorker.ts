import { readFile, writeFile } from "node:fs/promises";

const inputPath = process.argv[2];
const outputPath = process.argv[3];

try {
  if (!inputPath || !outputPath) throw new Error("worker requires input and output paths");
  const sharp = (await import("sharp")).default;
  sharp.concurrency(1);
  sharp.cache(false);
  const input = await readFile(inputPath);
  const output = await sharp(input, {
    limitInputPixels: 100_000_000,
    sequentialRead: true,
    failOn: "error",
  })
    .withMetadata(false)
    .jpeg({ quality: Number(process.env.FIX_AI_SLOP_QUALITY ?? 90), chromaSubsampling: "4:2:0", force: true })
    .toBuffer();
  await writeFile(outputPath, output);
  process.exit(0);
} catch (error) {
  console.error(`[fixAiSlopWorker] failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
}