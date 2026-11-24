import { Router } from "express";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseNodes } from "../mobile/hst/snapchat/runtime";

const router = Router();
const execFileAsync = promisify(execFile);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = [
  process.cwd(),
  path.resolve(moduleDir, ".."),
  path.resolve(moduleDir, "../.."),
].find(root => existsSync(path.join(root, "scripts/replayAddFriendsScroll.mjs"))) ?? process.cwd();
const replayScript = path.join(apiRoot, "scripts/replayAddFriendsScroll.mjs");
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_XML_BYTES = 2 * 1024 * 1024;

router.post("/debug/add-friends-scroll-replay", async (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(404).json({ error: "Not found" });
  }

  const body = req.body as {
    regressionFixture?: unknown;
    imageBase64?: unknown;
    uiXml?: unknown;
    screenWidth?: unknown;
    screenHeight?: unknown;
    crop?: { left?: unknown; top?: unknown; width?: unknown; height?: unknown } | null;
    friendName?: unknown;
    alignBeforeAction?: unknown;
    previousCenterY?: unknown;
    rowHeight?: unknown;
  };
  if (body.regressionFixture === true) {
    try {
      const { stdout } = await execFileAsync(process.execPath, [
        replayScript,
        "--regression-fixture",
      ], {
        cwd: apiRoot,
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return res.json(JSON.parse(stdout));
    } catch (error) {
      const details = error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "")
        : "";
      const message = details.trim() || (error instanceof Error ? error.message : "Replay failed.");
      return res.status(422).json({ error: message.slice(0, 2000) });
    }
  }
  if (typeof body.imageBase64 !== "string" || typeof body.uiXml !== "string") {
    return res.status(400).json({ error: "Choose a screenshot and provide its matching UIAutomator XML dump." });
  }

  const encodedImage = body.imageBase64.replace(/^data:image\/[^;]+;base64,/i, "");
  if (
    !encodedImage ||
    encodedImage.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedImage)
  ) {
    return res.status(400).json({ error: "The screenshot must be a PNG, JPEG, or WebP under 20 MB." });
  }
  const imageBytes = Buffer.from(encodedImage, "base64");
  if (imageBytes.length > MAX_IMAGE_BYTES) {
    return res.status(413).json({ error: "The screenshot must be under 20 MB." });
  }
  if (Buffer.byteLength(body.uiXml, "utf8") > MAX_XML_BYTES) {
    return res.status(413).json({ error: "The UI dump must be under 2 MB." });
  }

  const nodes = parseNodes(body.uiXml);
  if (nodes.length === 0) {
    return res.status(400).json({ error: "The UI dump did not contain any Android nodes with bounds." });
  }
  const inferredWidth = Math.max(...nodes.map(node => node.bounds[2]));
  const inferredHeight = Math.max(...nodes.map(node => node.bounds[3]));
  const screenWidth = Number(body.screenWidth) || inferredWidth;
  const screenHeight = Number(body.screenHeight) || inferredHeight;
  if (
    !Number.isInteger(screenWidth) || screenWidth < 100 || screenWidth > 5000 ||
    !Number.isInteger(screenHeight) || screenHeight < 100 || screenHeight > 10000
  ) {
    return res.status(400).json({ error: "Could not determine valid screen dimensions from the UI dump." });
  }

  let cropArgs: string[] = [];
  if (body.crop) {
    const { left, top, width, height } = body.crop;
    const cropValues = [left, top, width, height].map(Number);
    if (cropValues.every(Number.isInteger) && cropValues[0] >= 0 && cropValues[1] >= 0 &&
        cropValues[2] > 0 && cropValues[3] > 0) {
      cropArgs = [`--crop=${cropValues.join(",")}`];
    } else {
      return res.status(400).json({ error: "Select a valid phone-screen crop from the screenshot preview." });
    }
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "add-friends-scroll-replay-"));
  try {
    const imagePath = path.join(tempDir, "screen.png");
    const xmlPath = path.join(tempDir, "screen.xml");
    await Promise.all([
      fs.writeFile(imagePath, imageBytes),
      fs.writeFile(xmlPath, body.uiXml),
    ]);
    const args = [
      replayScript,
      `--image=${imagePath}`,
      `--xml=${xmlPath}`,
      `--screen=${screenWidth},${screenHeight}`,
      ...cropArgs,
    ];
    if (typeof body.friendName === "string" && body.friendName.trim()) {
      args.push(`--friend=${body.friendName.trim().slice(0, 160)}`);
    }
    if (body.alignBeforeAction === true) args.push("--align-before-action");
    if (Number.isFinite(Number(body.previousCenterY))) {
      args.push(`--previous-center-y=${Math.round(Number(body.previousCenterY))}`);
    }
    if (Number.isFinite(Number(body.rowHeight)) && Number(body.rowHeight) > 0) {
      args.push(`--row-height=${Math.round(Number(body.rowHeight))}`);
    }
    const { stdout } = await execFileAsync(process.execPath, args, {
      cwd: apiRoot,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return res.json(JSON.parse(stdout));
  } catch (error) {
    const details = error && typeof error === "object" && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "")
      : "";
    const message = details.trim() || (error instanceof Error ? error.message : "Replay failed.");
    return res.status(422).json({ error: message.slice(0, 2000) });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

export default router;
