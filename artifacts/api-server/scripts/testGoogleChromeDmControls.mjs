import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { transform } from "esbuild";

const source = await fs.readFile(new URL("../src/instagram/googleChromeDmControls.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { findGoogleChromeDmControl: find } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const delaySource = await fs.readFile(new URL("../src/instagram/googleChromeDmDelay.ts", import.meta.url), "utf8");
const delayCode = await transform(delaySource, { loader: "ts", format: "esm" });
const { waitForGoogleChromeDmDelay } = await import(`data:text/javascript;base64,${Buffer.from(delayCode.code).toString("base64")}`);
const eligibilitySource = await fs.readFile(new URL("../src/instagram/googleChromeDmEligibility.ts", import.meta.url), "utf8");
const eligibilityCode = await transform(eligibilitySource, { loader: "ts", format: "esm" });
const { googleChromeGirlsOnlyRejection: reject } = await import(`data:text/javascript;base64,${Buffer.from(eligibilityCode.code).toString("base64")}`);
const photoUrl = "https://images.example.test/personal-picture.jpg";
for (const name of ["Haven rose", "Alice", "María García", "Anne-Marie Smith", "عائشة حسن", "Анна Иванова"]) {
  // The Arabic surname حسن is also a known male name and must fail the user's
  // any-name-token rule, even when it can legitimately be someone's surname.
  if (name === "عائشة حسن") { assert(reject({ name, photoUrl })); continue; }
  assert.equal(reject({ name, photoUrl }), null, name);
}
for (const name of [
  "Sebastián", "SEBASTIAN", "Sébastien", "Pretty Girls Around The World",
  "Sonorense sierreño", "Nibabi Mo’s", "Mécanique", "Maria John",
  "Maria Unknown Third", "Alice123", "Alice 💗", "Unknownname Smith",
  "محمد", "Иван", "Andrea Rossi", "Jean Martin",
]) assert(reject({ name, photoUrl }), name);
for (const picture of [undefined, "", "https://example.test/default-avatar.png",
  "https://www.facebook.com/rsrc.php/default.jpg", "data:image/png;base64,AAA"]) {
  assert(reject({ name: "Haven rose", photoUrl: picture }), `missing/default picture: ${picture}`);
}
console.log("PASS: strict positive-name match, one/two name parts, male/ambiguous and unknown-name rejection, multilingual names and required non-placeholder photo.");

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
const collectStart = browserSource.indexOf("const collectEligibleProfiles = async () => session.page.evaluate");
const collectEnd = browserSource.indexOf("\n    let candidates = await collectEligibleProfiles();", collectStart);
assert(collectStart > 0 && collectEnd > collectStart);
const visibleNode = {
  style: { visibility: "visible", display: "block" },
  getBoundingClientRect: () => ({ width: 50, height: 50 }),
};
const picture = {
  ...visibleNode, tagName: "IMG", complete: true, naturalWidth: 50, currentSrc: photoUrl,
  getAttribute: () => null,
};
const svgPicture = {
  ...visibleNode, tagName: "image",
  getAttribute: name => name === "xlink:href" ? "https://images.example.test/sebastian.jpg" : null,
};
const anchor = (id, name, images = []) => ({
  ...visibleNode, href: `https://www.facebook.com/profile.php?id=${id}`, innerText: name,
  getAttribute: () => null, querySelectorAll: () => images,
});
const anchors = [
  anchor("123", "Haven rose"), anchor("123", "", [picture]),
  anchor("456", "Sebastián", [svgPicture]), anchor("789", "Alice Smith"),
];
const section = { querySelectorAll: () => anchors };
const heading = { innerText: "Followers", parentElement: section, querySelectorAll: () => [] };
globalThis.document = {
  location: { href: "https://www.facebook.com/test/followers" },
  querySelector: () => ({ querySelectorAll: () => [heading] }),
};
const collectorCode = await transform(
  "const session = { page: { evaluate: fn => fn() } }; export " + browserSource.slice(collectStart, collectEnd),
  { loader: "ts", format: "esm" },
);
const { collectEligibleProfiles } = await import(`data:text/javascript;base64,${Buffer.from(collectorCode.code).toString("base64")}`);
const collected = await collectEligibleProfiles();
assert.equal(collected.find(candidate => candidate.name === "Haven rose").photoUrl, photoUrl);
assert.equal(collected.find(candidate => candidate.name === "Sebastián").photoUrl, "https://images.example.test/sebastian.jpg");
assert.equal(collected.find(candidate => candidate.name === "Alice Smith").photoUrl, undefined);
picture.complete = false;
assert.equal((await collectEligibleProfiles()).find(candidate => candidate.name === "Haven rose").photoUrl, undefined);
delete globalThis.document;
console.log("PASS: production follower collector pairs HTML/SVG photos by exact profile ID, never borrows a neighbour's image, and excludes unloaded pictures.");
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
const message = { click: async () => { events.push("message"); editor.isConnected = true; } };
let waits = 0;
let location = "";
let fixtureCandidates = [
  { url: "https://www.facebook.com/profile.php?id=123", name: "Test Recipient" },
  { url: "https://www.facebook.com/profile.php?id=456", name: "Second Recipient" },
];
const page = {
  goto: async url => { location = url; events.push("navigate"); },
  url: () => location,
  evaluate: async fn => {
    const text = fn.toString();
    if (text.includes("scrollHeight")) return 1000;
    if (text.includes("scrollTo")) return;
    return fixtureCandidates;
  },
  evaluateHandle: async () => wrap(message),
  waitForFunction: async (fn, _options, ...args) => {
    waits++;
    if (waits === 1) return wrap(true); // Followers loaded.
    const step = (waits - 2) % 5;
    if (step === 0) return wrap(true); // Verified profile.
    if (step === 1) return wrap(editor); // Recipient-specific composer.
    if (step === 2) return wrap(fn(editor, "send"));
    if (step === 3) return wrap(editor.innerText === ""); // Sent-text confirmation.
    if (step === 4) return wrap(fn(editor)); // Close confirmation.
    throw new Error("Unexpected browser wait");
  },
};
const gaps = [];
globalThis.__chromeDmFixture = {
  page, find: (_handle, action) => find(editor, action),
  reject,
  wait: async (seconds, stopped) => {
    const started = Date.now();
    await waitForGoogleChromeDmDelay(seconds, stopped);
    gaps.push({ seconds, elapsed: Date.now() - started });
    events.push("delay");
  },
};
const prelude = `
const GOOGLE_CHROME_BROWSER_PROFILE_ID = 10000000;
const activeGoogleChromeDmRuns = new Map();
const sessions = new Map([[10000000, {page: globalThis.__chromeDmFixture.page}]]);
const findGoogleChromeDmControl = globalThis.__chromeDmFixture.find;
const waitForGoogleChromeDmDelay = globalThis.__chromeDmFixture.wait;
const googleChromeGirlsOnlyRejection = globalThis.__chromeDmFixture.reject;
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
assert.equal(gaps.length, 0, "no delay before first or after last recipient");
events.length = 0;
waits = 0;
const two = await runGoogleChromeDm(10_000_000, {
  url: "https://www.facebook.com/profile.php?id=999&sk=followers",
  message: "Local fixture only", amount: 2, delayMinSeconds: 0.03, delayMaxSeconds: 0.05,
});
assert.equal(two.sent, 2);
assert.equal(gaps.length, 1, "one random gap between two successful messages");
assert(gaps[0].seconds >= 0.03 && gaps[0].seconds <= 0.05);
assert(gaps[0].elapsed >= 29);
assert.deepEqual(events, [
  "navigate", "navigate", "message", "composer", "send", "close",
  "delay", "navigate", "message", "composer", "send", "close",
]);
fixtureCandidates = [
  { url: "https://www.facebook.com/profile.php?id=123", name: "Haven rose", photoUrl },
  { url: "https://www.facebook.com/profile.php?id=456", name: "Sebastián", photoUrl },
  { url: "https://www.facebook.com/profile.php?id=789", name: "Pretty Girls Around The World", photoUrl },
  { url: "https://www.facebook.com/profile.php?id=890", name: "Sonorense sierreño", photoUrl },
  { url: "https://www.facebook.com/profile.php?id=901", name: "Mécanique", photoUrl },
  { url: "https://www.facebook.com/profile.php?id=912", name: "Nibabi Mo’s", photoUrl },
  { url: "https://www.facebook.com/profile.php?id=923", name: "Alice Smith" },
];
for (const mode of [{ girlsOnly: true }, { excludedNameTokens: ["sebastian"] }]) {
  events.length = 0; waits = 0;
  const strict = await runGoogleChromeDm(10_000_000, {
    url: "https://www.facebook.com/profile.php?id=999&sk=followers",
    message: "Local fixture only", amount: 10, ...mode,
  });
  assert.equal(strict.sent, 1);
  assert.equal(strict.totalEligible, 1);
  assert.equal(strict.skipped, 6);
  assert.deepEqual(strict.sentUrls, ["https://www.facebook.com/profile.php?id=123"]);
  assert.equal(events.filter(event => event === "send").length, 1);
}
console.log("PASS: real dispatcher with Girls Only (new and legacy clients) sends solely to Haven rose; excludes all other screenshot examples and a female-name profile without a photo.");
fixtureCandidates = fixtureCandidates.slice(1);
events.length = 0; waits = 0;
const none = await runGoogleChromeDm(10_000_000, {
  url: "https://www.facebook.com/profile.php?id=999&sk=followers",
  message: "Local fixture only", amount: 10, girlsOnly: true,
});
assert.equal(none.sent, 0);
assert.deepEqual(events, ["navigate"], "no Message/Send click when no profile qualifies");
events.length = 0; waits = 0;
const disabled = await runGoogleChromeDm(10_000_000, {
  url: "https://www.facebook.com/profile.php?id=999&sk=followers",
  message: "Local fixture only", amount: 1, girlsOnly: false,
});
assert.equal(disabled.sent, 1, "unchecked Girls Only preserves ordinary targeting");
assert.deepEqual(disabled.sentUrls, ["https://www.facebook.com/profile.php?id=456"]);
await assert.rejects(() => runGoogleChromeDm(10_000_000, {
  url: "https://www.facebook.com/", message: "Fixture", delayMinSeconds: 4, delayMaxSeconds: 1,
}), /valid minimum and maximum/);
const stoppedAt = Date.now();
await waitForGoogleChromeDmDelay(60, () => true);
assert(Date.now() - stoppedAt < 100, "already stopped wait exits immediately");
let stopped = false;
const timer = setTimeout(() => { stopped = true; }, 10);
const duringWait = Date.now();
await waitForGoogleChromeDmDelay(60, () => stopped);
clearTimeout(timer);
assert(Date.now() - duringWait < 1000, "Stop interrupts an active gap");
delete globalThis.__chromeDmFixture;
console.log("PASS: production send/close flow, one random inter-message gap, invalid range and responsive Stop.");
