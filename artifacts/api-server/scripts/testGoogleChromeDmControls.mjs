import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { transform } from "esbuild";

const source = await fs.readFile(new URL("../src/instagram/googleChromeDmControls.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { findGoogleChromeDmControl: find } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

class Node {
  constructor(kind, label = "", children = []) {
    this.kind = kind;
    this.label = label;
    this.children = children;
    this.style = { visibility: "visible", display: "block" };
    for (const child of children) child.parentElement = this;
  }
  getBoundingClientRect() { return { width: 20, height: 20 }; }
  getAttribute(name) {
    if (name === "aria-label") return this.label;
    if (name === "aria-disabled") return this.ariaDisabled ? "true" : null;
    return null;
  }
  querySelectorAll(selector) {
    const matches = [];
    for (const node of this.children) {
      if (selector.includes("contenteditable") ? node.kind === "editor" : node.kind === "button") matches.push(node);
      matches.push(...node.querySelectorAll(selector));
    }
    return matches;
  }
}
globalThis.getComputedStyle = node => node.style;

for (const label of ["Send", "Press Enter to send", "Send message", "Send (Enter)"]) {
  const editor = new Node("editor");
  const send = new Node("button", label);
  const close = new Node("button", "Close chat");
  const panel = new Node("container", "", [close, new Node("container", "", [editor, send])]);
  assert.equal(find(editor, "send"), send, label);
  assert.equal(find(editor, "close"), close);
  send.ariaDisabled = true;
  assert.equal(find(editor, "send"), null, "disabled Send is rejected");
  send.ariaDisabled = false;
  send.style.visibility = "hidden";
  assert.equal(find(editor, "send"), null, "hidden Send is rejected");
}
{
  const editor = new Node("editor");
  new Node("container", "", [editor, new Node("button", "Send"), new Node("button", "Press Enter to send")]);
  assert.equal(find(editor, "send"), null, "ambiguous Send is rejected");
}
{
  const editor = new Node("editor");
  const ownPanel = new Node("container", "", [editor]);
  const otherEditor = new Node("editor");
  const otherPanel = new Node("container", "", [
    otherEditor, new Node("button", "Send"), new Node("button", "Close chat"),
  ]);
  new Node("container", "", [ownPanel, otherPanel, new Node("button", "Close")]);
  assert.equal(find(editor, "send"), null, "never borrows another chat's Send");
  assert.equal(find(editor, "close"), null, "never borrows another chat's Close");
}
{
  const editor = new Node("editor");
  new Node("container", "", [editor, new Node("button", "Send a photo"), new Node("button", "Close")]);
  assert.equal(find(editor, "send"), null, "attachment send is not message Send");
  assert.equal(find(editor, "close"), null, "generic page Close is rejected");
}
console.log("PASS: Facebook Send-label variants, matching chat Close, disabled/hidden controls, ambiguity and cross-chat isolation.");

// Execute the production dispatcher with browser-boundary stubs. No real account,
// network request or message is used by this regression.
const browserSource = await fs.readFile(new URL("../src/instagram/browserSession.ts", import.meta.url), "utf8");
const start = browserSource.indexOf("export async function runGoogleChromeDm(");
const end = browserSource.indexOf("// ── Send a DM through the live browser session", start);
assert(start >= 0 && end > start);
const events = [];
const editor = new Node("editor");
editor.isConnected = true;
editor.innerText = "";
editor.click = async () => events.push("composer");
editor.type = async text => { editor.innerText = text; };
const send = new Node("button", "Press Enter to send");
send.click = async () => { events.push("send"); editor.innerText = ""; };
const close = new Node("button", "Close chat");
close.click = async () => { events.push("close"); editor.isConnected = false; };
new Node("container", "", [close, new Node("container", "", [editor, send])]);
const wrap = value => ({
  asElement: () => value && typeof value === "object" ? {
    ...value,
    click: () => value.click(),
    type: text => value.type(text),
    evaluate: fn => fn(value),
    evaluateHandle: async (fn, ...args) => wrap(fn(value, ...args)),
  } : null,
  jsonValue: async () => value,
  dispose: async () => {},
});
const message = { click: async () => events.push("message") };
let waits = 0;
let location = "";
const page = {
  goto: async url => { location = url; events.push("navigate"); },
  url: () => location,
  evaluate: async () => [{ url: "https://www.facebook.com/profile.php?id=123", name: "Test Recipient" }],
  evaluateHandle: async () => wrap(message),
  waitForFunction: async (fn, _options, ...args) => {
    waits++;
    if (waits <= 2) return wrap(true); // Followers loaded, then verified profile.
    if (waits === 3) return wrap(editor); // Recipient-specific composer loaded.
    if (waits === 4) return wrap(fn(editor, "send"));
    if (waits === 5) return wrap(editor.innerText === ""); // Sent-text confirmation.
    if (waits === 6) return wrap(fn(editor)); // Close confirmation.
    throw new Error("Unexpected browser wait");
  },
};
globalThis.__chromeDmFixture = { page, find: (_handle, action) => find(editor, action) };
const prelude = `
const GOOGLE_CHROME_BROWSER_PROFILE_ID = 10000000;
const activeGoogleChromeDmRuns = new Map();
const sessions = new Map([[10000000, {page: globalThis.__chromeDmFixture.page}]]);
const findGoogleChromeDmControl = globalThis.__chromeDmFixture.find;
const wsWrite = () => {};
const log = () => {};
`;
const flow = await transform(prelude + browserSource.slice(start, end), { loader: "ts", format: "esm" });
const { runGoogleChromeDm } = await import(`data:text/javascript;base64,${Buffer.from(flow.code).toString("base64")}`);
const result = await runGoogleChromeDm(10_000_000, {
  url: "https://www.facebook.com/profile.php?id=999&sk=followers",
  message: "Local fixture only", amount: 1,
});
assert.equal(result.sent, 1);
assert.equal(result.failed, 0);
assert.deepEqual(events, ["navigate", "navigate", "message", "composer", "send", "close"]);
assert.equal(editor.isConnected, false);
delete globalThis.__chromeDmFixture;
console.log("PASS: production Send DMs dispatcher sends once, confirms, then closes the matching chat once.");
