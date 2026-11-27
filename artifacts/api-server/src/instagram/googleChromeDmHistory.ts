import fs from "node:fs";
import path from "node:path";

/** Compare Facebook user IDs, not tracking parameters or profile URL spelling. */
export function googleChromeDmRecipientKey(value: string): string | null {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || !/(^|\.)facebook\.com$/i.test(url.hostname)) return null;
    const id = /^\/profile\.php\/?$/i.test(url.pathname)
      ? url.searchParams.get("id")
      : url.pathname.match(/^\/people\/[^/]+\/(\d+)\/?$/i)?.[1];
    return id && /^\d+$/.test(id) ? `id:${id}` : null;
  } catch { return null; }
}

type History = { version: 1; accounts: Record<string, Record<string, string>> };
function read(file: string): History {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.version !== 1 || !data.accounts || typeof data.accounts !== "object" ||
        Array.isArray(data.accounts) || Object.values(data.accounts).some(account =>
          !account || typeof account !== "object" || Array.isArray(account) ||
          Object.entries(account).some(([key, at]) => !/^id:\d+$/.test(key) || typeof at !== "string"))) {
      throw new Error("Invalid contact history format");
    }
    return data;
  } catch (error: any) {
    if (error.code === "ENOENT") return { version: 1, accounts: {} };
    throw new Error("Saved message history could not be read; sending was stopped to avoid duplicates.");
  }
}

export function readGoogleChromeDmContacts(file: string, account: string): Set<string> {
  return new Set(Object.keys(read(file).accounts[account] ?? {}));
}

/** Record before clicking Send, including attempts whose final outcome is unknown. */
export function recordGoogleChromeDmContacts(file: string, account: string, urls: string[]): void {
  if (!/^\d+$/.test(account)) throw new Error("Cannot save contact history without a verified Facebook account.");
  const data = read(file);
  const contacts = data.accounts[account] ??= {};
  let changed = false;
  for (const url of urls) {
    const key = googleChromeDmRecipientKey(url);
    if (!key) throw new Error("Cannot record an unverified Facebook recipient.");
    if (!contacts[key]) { contacts[key] = new Date().toISOString(); changed = true; }
  }
  if (!changed) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/**
 * Browser-side only. Inspect the verified composer's chat, never a sibling chat.
 * False means "still unknown"; waitForFunction must time out rather than send.
 */
export function inspectGoogleChromeDmHistory(element: any): "existing" | "empty" | false {
  const visible = (node: any) => {
    const rect = node.getBoundingClientRect();
    const style = (globalThis as any).getComputedStyle(node);
    return !!rect.width && !!rect.height && style.display !== "none" && style.visibility !== "hidden";
  };
  let chatPanel: any = null;
  let container = element.parentElement;
  for (let depth = 0; container && depth < 12; depth++, container = container.parentElement) {
    const editors = Array.from(container.querySelectorAll("[contenteditable='true'][role='textbox'],textarea"))
      .filter(visible);
    if (editors.length !== 1 || editors[0] !== element) continue;
    const closeButtons = Array.from(container.querySelectorAll("button,[role='button']"))
      .filter((button: any) => visible(button) && [
        button.getAttribute("aria-label"), button.getAttribute("title"), button.innerText,
      ].some(label => /^close (?:chat|conversation)(?: with .+)?$/i.test(String(label ?? "").trim())));
    if (closeButtons.length === 1) {
      chatPanel = container;
      break;
    }
  }
  if (!chatPanel) return false;

  // Facebook exposes message rows inside this chat's message log/grid.
  // Inspect only the nearest panel uniquely owning this composer and close
  // control; generic "Messages" regions elsewhere on the page can contain
  // unrelated inbox text and must not mark this conversation as existing.
  const rows = Array.from(chatPanel.querySelectorAll(
    "[role='row'],[data-message-id],[data-messageid],[data-testid='message-container']",
  ));
  if (rows.some((row: any) => {
    if (row.contains(element)) return false;
    const text = String(row.innerText || row.textContent || "").replace(/\s+/g, " ").trim();
    if (/when you send a message,?\s+.+?\s+(?:will|can) see your public info/i.test(text)) return false;
    return text || row.querySelector("img,image,video,audio,[role='img']");
  })) return "existing";
  if (Array.from(chatPanel.querySelectorAll("[aria-busy='true'],[role='progressbar']"))
    .some(visible)) { delete element.__auraDmEmptySince; return false; }

  // Do not infer an empty thread merely from an empty textbox or missing rows.
  // Require Facebook's explicit new-conversation notice, settled across polls.
  const text = String(chatPanel.innerText || chatPanel.textContent || "").replace(/\s+/g, " ");
  const notice = text.match(/when you send a message,?\s+.+?\s+(?:will|can) see your public info/i);
  if (notice) {
    // The notice may remain above older messages; those are checked in this
    // chat's rows above. Ignore text from broad page-level message regions and
    // use the notice only after the selected panel has settled.
    element.__auraDmEmptySince ??= Date.now();
    return Date.now() - element.__auraDmEmptySince >= 2000 ? "empty" : false;
  }
  delete element.__auraDmEmptySince;
  return false;
}
