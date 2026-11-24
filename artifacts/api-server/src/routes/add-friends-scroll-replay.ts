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
const MAX_XML_BYTES = 2 * 1024 * 1024;

router.post("/debug/add-friends-scroll-replay", async (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(404).json({ error: "Not found" });
  }

  const body = req.body as {
    uiXml?: unknown;
    screenWidth?: unknown;
    screenHeight?: unknown;
    friendName?: unknown;
    action?: unknown;
  };
  if (typeof body.uiXml !== "string" || typeof body.friendName !== "string" || typeof body.action !== "string") {
    return res.status(400).json({ error: "Import a Find Friends Inspect dump and choose a contact and action." });
  }
  if (!["add", "skip", "dismiss"].includes(body.action)) {
    return res.status(400).json({ error: "Choose Add, Skip, or Dismiss." });
  }
  if (Buffer.byteLength(body.uiXml, "utf8") > MAX_XML_BYTES) {
    return res.status(413).json({ error: "The UI dump must be under 2 MB." });
  }
  if (!body.friendName.trim()) {
    return res.status(400).json({ error: "Select a contact before running the action." });
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

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "add-friends-scroll-replay-"));
  try {
    const xmlPath = path.join(tempDir, "screen.xml");
    await fs.writeFile(xmlPath, body.uiXml);
    const args = [
      replayScript,
      `--xml=${xmlPath}`,
      `--screen=${screenWidth},${screenHeight}`,
      `--friend=${body.friendName.trim().slice(0, 160)}`,
      `--action=${body.action}`,
      "--align-before-action",
      "--return-screen",
    ];
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
