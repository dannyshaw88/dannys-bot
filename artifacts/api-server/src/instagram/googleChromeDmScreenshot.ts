import { spawn } from "node:child_process";

export type GoogleChromeDmScreenshotHistory = "existing" | "empty" | "unknown";

/** Run local OCR against a screenshot held only in memory. */
export async function recognizeGoogleChromeDmScreenshot(
  image: Uint8Array,
  timeoutMs = 8_000,
  upscale = 1,
): Promise<string> {
  if (!image?.byteLength || image.byteLength > 12 * 1024 * 1024) {
    throw new Error("The browser screenshot was empty or too large to inspect.");
  }
  if (!Number.isFinite(upscale) || upscale < 1 || upscale > 4) {
    throw new Error("Screenshot OCR upscale must be between 1× and 4×.");
  }
  let ocrImage: Uint8Array = Buffer.from(image);
  if (upscale > 1) {
    const sharp = (await import("sharp")).default;
    const pipeline = sharp(ocrImage);
    const metadata = await pipeline.metadata();
    if (!metadata.width || !metadata.height ||
        metadata.width * metadata.height * upscale * upscale > 24_000_000) {
      throw new Error("The conversation screenshot is too large to upscale safely for OCR.");
    }
    ocrImage = await pipeline
      .resize({
        width: Math.round(metadata.width * upscale),
        height: Math.round(metadata.height * upscale),
        kernel: "lanczos3",
      })
      .grayscale()
      .normalize()
      .sharpen()
      .png()
      .toBuffer();
  }
  const process = spawn("tesseract", ["stdin", "stdout", "-l", "eng", "--psm", "6"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  let outputBytes = 0;
  const timer = setTimeout(() => process.kill("SIGKILL"), timeoutMs);
  try {
    const completed = new Promise<string>((resolve, reject) => {
      process.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes <= 64 * 1024) output.push(chunk);
        else process.kill("SIGKILL");
      });
      process.stderr.on("data", (chunk: Buffer) => {
        if (errors.reduce((size, part) => size + part.byteLength, 0) < 8 * 1024) errors.push(chunk);
      });
      process.once("error", reject);
      process.once("close", (code: number | null) => {
        if (code === 0) resolve(Buffer.concat(output).toString("utf8"));
        else reject(new Error(
          `Screenshot OCR failed${errors.length ? `: ${Buffer.concat(errors).toString("utf8").trim().slice(0, 240)}` : ""}`,
        ));
      });
    });
    process.stdin.end(ocrImage);
    return await completed;
  } finally {
    clearTimeout(timer);
    if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
  }
}

function readableText(value: string): string {
  return String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

export function googleChromeDmScreenshotContainsText(screenshotText: string, expectedText: string): boolean {
  const screenshot = readableText(screenshotText).replace(/\s/g, "");
  const expected = readableText(expectedText).replace(/\s/g, "");
  return !!expected && screenshot.includes(expected);
}

/** Compare visible chat text with one of the configured, already-split DM choices. */
export function googleChromeDmScreenshotContainsConfiguredMessage(
  screenshotText: string,
  expectedName: string,
  messages: string[],
): boolean {
  const firstName = expectedName.trim().split(/\s+/u)[0] ?? "";
  if (!firstName) return false;
  return messages.some(message => {
    const expected = message.trim().replace(/\[FIRSTNAME\]/gi, firstName);
    return !!expected && googleChromeDmScreenshotContainsText(screenshotText, expected);
  });
}

/** Only call an inbox empty when the screenshot clearly shows Facebook's new-thread notice. */
export function classifyGoogleChromeDmHistoryScreenshot(
  screenshotText: string,
  expectedName: string,
): GoogleChromeDmScreenshotHistory {
  const text = readableText(screenshotText);
  const name = readableText(expectedName);
  if (!text || !name || !text.replace(/\s/g, "").includes(name.replace(/\s/g, ""))) return "unknown";

  const notice = /when you send a message.{0,100}public info/;
  const noticeMatch = text.match(notice);
  // In a fresh Messenger thread, OCR often invents words from the tiny compose
  // toolbar below Facebook's new-conversation notice. Only text above that
  // notice can be conversation history; text below it belongs to the compose UI.
  const conversationText = noticeMatch
    ? text.slice(0, noticeMatch.index)
    : text;
  const withoutNotice = conversationText.replace(notice, " ");
  const withoutName = withoutNotice.split(name).join(" ");
  const withoutProfileSummary = withoutName
    .replace(/\b\d+(?:[.,]\d+)?\s*[kmb]?\s+people follow this\b/gi, " ")
    .replace(/\bmodel\b/gi, " ");
  const knownChromeLabels = new Set([
    "messenger", "active", "now", "available", "close", "chat", "conversation", "more",
    "options", "minimize", "video", "audio", "call", "search", "profile", "view",
    "information", "details", "aa", "message", "messages", "send", "enter", "a",
    "write", "your", "reply", "here", "like", "sticker", "gif", "photo", "file",
    "emoji", "thumbs", "up", "public", "info", "when", "you", "will", "can", "see",
    "the", "to", "contact", "business", "account", "tap", "for", "more", "actions",
  ]);
  const unrecognizedWords = withoutProfileSummary.split(" ").filter(word =>
    word.length > 1 && !knownChromeLabels.has(word) && !/^\d{1,4}$/.test(word),
  );
  if (unrecognizedWords.length) return "existing";
  return noticeMatch ? "empty" : "unknown";
}

/** Browser-evaluable helper: return a fully visible chat panel rectangle. */
export function getGoogleChromeDmChatScreenshotBounds(element: any):
  { x: number; y: number; width: number; height: number } | false {
  const doc = (globalThis as any).document;
  const getStyle = (globalThis as any).getComputedStyle;
  if (!doc || !element?.isConnected) return false;
  const visible = (node: any) => {
    const rect = node.getBoundingClientRect();
    const style = getStyle(node);
    return rect.width > 0 && rect.height > 0 &&
      style.display !== "none" && style.visibility !== "hidden";
  };
  const editorSelector = "[contenteditable='true'][role='textbox'],textarea";
  const closePattern = /^close (?:chat|conversation)(?: with .+)?$/i;
  let panel: any = null;
  for (let container = element.parentElement, depth = 0; container && depth < 12;
    depth++, container = container.parentElement) {
    const editors = (Array.from(container.querySelectorAll(editorSelector)) as any[]).filter(visible);
    if (editors.length !== 1 || editors[0] !== element) continue;
    const closeButtons = (Array.from(container.querySelectorAll("button,[role='button']")) as any[])
      .filter(button => visible(button) && [
        button.getAttribute("aria-label"), button.getAttribute("title"), button.innerText,
      ].some(label => closePattern.test(String(label ?? "").replace(/\s+/g, " ").trim())));
    if (closeButtons.length === 1) { panel = container; break; }
  }
  if (!panel) return false;
  const rect = panel.getBoundingClientRect();
  const width = doc.documentElement?.clientWidth ?? (globalThis as any).innerWidth ?? 0;
  const height = doc.documentElement?.clientHeight ?? (globalThis as any).innerHeight ?? 0;
  if (rect.left < 0 || rect.top < 0 || rect.right > width || rect.bottom > height) return false;
  return { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
}
