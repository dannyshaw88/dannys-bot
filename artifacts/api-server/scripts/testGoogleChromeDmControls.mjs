import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { build, transform } from "esbuild";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const source = await fs.readFile(new URL("../src/instagram/googleChromeDmControls.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { findGoogleChromeDmControl: find, findGoogleChromeDmMessageButton: findMessageButton } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const delaySource = await fs.readFile(new URL("../src/instagram/googleChromeDmDelay.ts", import.meta.url), "utf8");
const delayCode = await transform(delaySource, { loader: "ts", format: "esm" });
const { waitForGoogleChromeDmDelay } = await import(`data:text/javascript;base64,${Buffer.from(delayCode.code).toString("base64")}`);
const eligibilityBuild = await build({
  entryPoints: [fileURLToPath(new URL("../src/instagram/googleChromeDmEligibility.ts", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "esm", logLevel: "silent",
});
const { googleChromeGirlsOnlyRejection: reject } = await import(`data:text/javascript;base64,${Buffer.from(eligibilityBuild.outputFiles[0].text).toString("base64")}`);
const historyBuild = await build({
  entryPoints: [fileURLToPath(new URL("../src/instagram/googleChromeDmHistory.ts", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "esm", logLevel: "silent",
});
const historyModule = await import(`data:text/javascript;base64,${Buffer.from(historyBuild.outputFiles[0].text).toString("base64")}`);
const readContactsFromHistory = historyModule.readGoogleChromeDmContacts;
const readPendingContacts = historyModule.readGoogleChromeDmPendingContacts;
const sentBuild = await build({
  entryPoints: [fileURLToPath(new URL("../src/instagram/googleChromeDmSent.ts", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "esm", logLevel: "silent",
});
const { inspectGoogleChromeDmSentMessage: inspectSent } = await import(
  `data:text/javascript;base64,${Buffer.from(sentBuild.outputFiles[0].text).toString("base64")}`,
);
const personalizationSource = await fs.readFile(
  new URL("../src/instagram/googleChromeDmPersonalization.ts", import.meta.url), "utf8",
);
const personalizationCode = await transform(personalizationSource, { loader: "ts", format: "esm" });
const personalizationModule = await import(
  `data:text/javascript;base64,${Buffer.from(personalizationCode.code).toString("base64")}`,
);
const composerBuild = await build({
  entryPoints: [fileURLToPath(new URL("../src/instagram/googleChromeDmComposer.ts", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "esm", logLevel: "silent",
});
const composerModule = await import(`data:text/javascript;base64,${Buffer.from(composerBuild.outputFiles[0].text).toString("base64")}`);
const diagnoseComposer = composerModule.diagnoseGoogleChromeDmComposer;
const historyDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-dm-history-"));
const followersCode = await transform(await fs.readFile(
  new URL("../src/instagram/googleChromeDmFollowers.ts", import.meta.url), "utf8",
), { loader: "ts", format: "esm" });
const { waitForGoogleChromeDmFollowers: waitFollowers } = await import(`data:text/javascript;base64,${Buffer.from(followersCode.code).toString("base64")}`);
{
  let reads = 0;
  const rows = await waitFollowers(async () => ++reads < 4 ? [] : [{ name: "Loaded user" }],
    () => false, 1000, async () => {});
  assert.equal(reads, 4, "keep polling the actual collector through delayed follower rendering");
  assert.equal(rows.length, 1);
  await assert.rejects(() => waitFollowers(async () => [], () => false, 0), /no readable user rows/);
  assert.deepEqual(await waitFollowers(async () => { throw new Error("must not read after Stop"); }, () => true), []);
  console.log("PASS: actual follower-row readiness retries, bounded empty-page failure and responsive Stop.");
}
{
  const { googleChromeDmRecipientKey: key, readGoogleChromeDmContacts: readContacts,
    readGoogleChromeDmPendingContacts: readPending, recordGoogleChromeDmContacts: recordContacts,
    recordGoogleChromeDmPendingContacts: recordPending, inspectGoogleChromeDmHistory: inspect } = historyModule;
  assert.equal(key("https://www.facebook.com/profile.php?id=600&sk=about#x"), "id:600");
  assert.equal(key("https://m.facebook.com/people/Someone/600/"), "id:600");
  assert.equal(key("https://facebook.com.evil.test/profile.php?id=600"), null);
  const file = path.join(historyDirectory, "ledger-test.json");
  recordContacts(file, "1", ["https://facebook.com/profile.php?id=600"]);
  assert(readContacts(file, "1").has("id:600"), "reload persisted contacts from disk");
  recordPending(file, "1", ["https://facebook.com/profile.php?id=601"]);
  assert(readPending(file, "1").has("id:601"), "an uncertain send is reserved separately");
  assert(!readContacts(file, "1").has("id:601"), "pending attempts are not misreported as sent");
  recordContacts(file, "1", ["https://facebook.com/profile.php?id=601"]);
  assert(!readPending(file, "1").has("id:601"), "confirmed sends clear their pending marker");
  assert(readContacts(file, "1").has("id:601"), "confirmed sends become durable history");
  assert.equal(readContacts(file, "2").size, 0, "sender accounts have independent histories");
  await fs.writeFile(file, "{broken");
  assert.throws(() => readContacts(file, "1"), /could not be read/);
  assert.throws(() => recordContacts(file, "1", ["https://facebook.com/profile.php?id=601"]), /could not be read/);
  const close = {
    getBoundingClientRect: () => ({ width: 10, height: 10 }),
    style: { display: "block", visibility: "visible" },
    getAttribute: attr => attr === "aria-label" ? "Close chat" : null,
  };
  const composer = {
    style: { visibility: "visible", display: "block" },
    getBoundingClientRect: () => ({ width: 10, height: 10 }),
    getAttribute: () => null,
  };
  let rows = [], busy = [], otherEditors = [];
  const panel = {
    innerText: "",
    querySelectorAll: selector => selector.includes("contenteditable") ? [composer, ...otherEditors]
      : selector.includes("button") ? [close]
      : selector.includes("data-message-id") ? rows : busy,
  };
  composer.parentElement = panel;
  const row = (text, media = false) => ({
    innerText: text, contains: () => false, querySelector: () => media ? {} : null,
  });
  const oldStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = node => node.style;
  rows = [row("You sent: Hi, do you sell content?")];
  assert.equal(inspect(composer, "Haven rose"), "existing", "detect old outgoing message before typing");
  rows = [row("I'm only just working with onlyfans")];
  assert.equal(inspect(composer, "Haven rose"), "existing", "detect existing incoming reply");
  rows = [row("", true)];
  assert.equal(inspect(composer, "Haven rose"), "existing", "media-only history is not a new conversation");
  rows = [];
  assert.equal(inspect(composer, "Haven rose"), false, "missing rows do not prove a new thread");
  panel.innerText = "When you send a message, Haven rose will see your public info.";
  assert.equal(inspect(composer, "Haven rose"), false, "new-thread notice must settle");
  composer.__auraDmEmptySince = Date.now() - 2500;
  assert.equal(inspect(composer, "Haven rose"), "empty");
  panel.innerText += " Previous message without row attributes";
  assert.equal(inspect(composer, "Haven rose"), false, "unclassified text beside a new-thread notice stays unknown, not empty");
  panel.innerText = "When you send a message, Haven rose will see your public info.";
  busy = [close];
  assert.equal(inspect(composer, "Haven rose"), false, "loading history must never pass as empty");
  busy = [];
  otherEditors = [close];
  assert.equal(inspect(composer, "Haven rose"), false, "never inspect a shared multi-chat ancestor");
  globalThis.getComputedStyle = oldStyle;
  console.log("PASS: canonical IDs, account-scoped disk history, corrupt-history fail-closed handling, old text/media and unknown/loading chat guards.");
}
{
  const oldStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = node => node.style;
  const rect = { left: 20, top: 20, right: 320, bottom: 80, width: 300, height: 60 };
  const style = { visibility: "visible", display: "block" };
  const close = {
    innerText: "", style, getBoundingClientRect: () => rect,
    getAttribute: name => name === "aria-label" ? "Close chat" : null,
  };
  const editor = {
    isConnected: true, innerText: "Hello there!", textContent: "", value: "",
    style, getBoundingClientRect: () => rect,
  };
  let rows = [];
  const panel = {
    querySelectorAll: selector => selector.includes("contenteditable") ? [editor]
      : selector === "button,[role='button']" ? [close]
      : selector.includes("[role='row']") ? rows : [],
  };
  editor.parentElement = panel;
  globalThis.document = { documentElement: { clientWidth: 800, clientHeight: 600 } };
  const row = text => ({
    innerText: text, textContent: text, style, getBoundingClientRect: () => rect,
    contains: () => false,
  });
  assert.equal(inspectSent(editor, "Hello there!"), false, "a matching draft alone is not a sent message");
  editor.innerText = "";
  assert.equal(inspectSent(editor, "Hello there!"), false, "an empty composer alone is not delivery proof");
  rows = [row("You sent: Hello there!")];
  assert.equal(inspectSent(editor, "Hello there!"), true, "require the exact text in a visible row of this chat");
  rows = [row("You sent: Something else")];
  assert.equal(inspectSent(editor, "Hello there!"), false, "a different message is not delivery proof");
  rows = [row("You sent: Hello there!")];
  const offscreen = { ...rect, top: 900, bottom: 960 };
  rows[0].getBoundingClientRect = () => offscreen;
  assert.equal(inspectSent(editor, "Hello there!"), false, "offscreen content is not visibly rendered");
  globalThis.document = undefined;
  globalThis.getComputedStyle = oldStyle;
  console.log("PASS: sent confirmation requires a cleared composer and exact message text in a visible row of that same conversation.");
}
const photoUrl = "https://images.example.test/personal-picture.jpg";
const internationalNames = JSON.parse(await fs.readFile(
  new URL("../src/instagram/data/internationalGivenNames/names.json", import.meta.url), "utf8",
));
assert(internationalNames.female.length >= 16_000);
assert(internationalNames.maleOrAmbiguous.length >= 26_000);
for (const name of [
  "Sarita", "Sarita Bb", "Saritabb", "Eulália", "Agnieszka", "Ayşe",
  "Zofia", "Saoirse", "Siobhán", "Graciela", "Eunice", "Francine",
  "Soraya", "Ainhoa", "Özlem", "Özge", "Isidora", "Nadine", "Fleur", "Belén",
]) {
  assert.equal(reject({ name, photoUrl }), null, `international name: ${name}`);
  assert(reject({ name }), `international name still needs a photo: ${name}`);
}
for (const name of ["Kazimierz", "Toshihiro", "Abdulrahman", "Bartosz", "Svetozar",
  "LinaToshihiro", "SaritaShop", "Saritabb12", "Unknownusername", "banana"]) {
  assert(reject({ name, photoUrl }), `broader data must not weaken guards: ${name}`);
}
console.log(`PASS: ${internationalNames.female.length} international female-labelled entries and ${internationalNames.maleOrAmbiguous.length} male/ambiguous entries; Sarita and cross-language regressions passed.`);
for (const name of ["Haven rose", "Alice", "Luna Zamorano", "Luna", "Bambi", "Anya Sweete", "María García", "Anne-Marie Smith", "عائشة حسن", "Анна Иванова"]) {
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
for (const name of [
  "KELLIHATYOFF", "kellinyattof", "LinaVale", "linavale", "Bellapetricia",
  "Anaispiesdecanela", "lovelyemily", "Gabriella", "Christina", "Eva", "Lina.Vale",
]) {
  assert.equal(reject({ name, photoUrl }), null, `allowed name/username: ${name}`);
  assert(reject({ name }), `username still needs a picture: ${name}`);
}
for (const name of [
  "L1NAVAL3", "KE11I", "Kelli123", "Lina_Vale", "Kelli💗",
  "banana", "Unknownusername", "LinaSebastian", "SebastianLina",
  "Mariano", "Julien", "MariaOfficial", "KelliShop", "Bellaboutique", "Modellero",
  "Unknown Lina", "Unknown Kelli", "Kellihat Yoff", "Lina Vale Extra",
]) assert(reject({ name, photoUrl }), `rejected username: ${name}`);
console.log("PASS: joined names and letters-only female-name usernames; digits, symbols, business fragments, known male names and missing photos remain blocked.");
for (const name of [
  "Lívia Monteiro", "Nicole Misfit", "Alkaline Atropos", "Laura.Flores",
  "miss belcalis", "MISS BELCALIS", "Miss. Belcalis", "Miss Laura Flores",
]) {
  assert.equal(reject({ name, photoUrl }), null, `user-confirmed profile format: ${name}`);
  assert(reject({ name }), `confirmed profile still requires a photo: ${name}`);
}
for (const name of [
  "Miss", "Miss John", "Miss Sebastián", "Miss Belcalis123", "Miss Beauty Studio",
  "Miss Belcalis Shop", "Miss Laura Flores Extra", "Laura..Flores", ".Laura",
  "Laura.", "Laura.Flores.Extra", "Laura.John", "L4ura.Flores", "Atech.Dev",
]) assert(reject({ name, photoUrl }), `title/dot handling must not bypass guards: ${name}`);
console.log("PASS: all five accepted screenshot targets, Miss titles and dotted names; photo, male-name, numeric, business and name-count guards preserved.");
for (const name of [
  "Luna Zamorano", "Bambi", "Anya Sweete", "Freya", "Poppy", "Elsie", "Bonnie",
  "Alessandra", "Chiara", "Vittoria", "Alejandra", "Ximena", "Rocío",
  "Luana", "Fernanda", "Darya", "Ksenia", "Amira", "Zainab", "Priya",
  "Deepika", "Anushka", "Chioma", "Wanjiku", "Aiko", "Keiko",
]) {
  // Amira was not covered by the original small list either.
  assert.equal(reject({ name, photoUrl }), null, `broader female-name coverage: ${name}`);
  assert(reject({ name }), `broader names still require a picture: ${name}`);
}
for (const name of ["Luna Beauty Studio", "BambiShop", "Bambi123", "Florin", "Florian", "Sebastián"]) {
  assert(reject({ name, photoUrl }), `coverage must not weaken exclusions: ${name}`);
}
console.log("PASS: Luna, Bambi and Anya plus broader international female-name coverage; picture and male/business exclusions preserved.");
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
    if (name === "title") return this.title ?? null;
    if (name === "aria-disabled") return this.ariaDisabled ? "true" : null;
    return null;
  }
  querySelectorAll(selector) {
    const matches = [];
    for (const node of this.children) {
      if (selector.includes("contenteditable") ? node.kind === "editor"
        : selector.includes("h1,") ? node.kind === "heading" || node.kind === "button"
        : selector.includes("button") ? node.kind === "button"
        : false) matches.push(node);
      matches.push(...node.querySelectorAll(selector));
    }
    return matches;
  }
}
globalThis.getComputedStyle = node => node.style;
{
  const { findGoogleChromeDmComposer: findComposer } = composerModule;
  const editor = new Node("editor");
  editor.label = "Aa";
  const close = new Node("button", "Close chat");
  const heading = new Node("heading", "Haven rose");
  const chat = new Node("container", "Haven rose\nYou sent: Hello\nAa", [heading, close, editor]);
  globalThis.document = { querySelectorAll: selector => chat.querySelectorAll(selector) };
  assert.equal(findComposer("Haven rose"), editor,
    "find recipient chat by heading even when composer has no Write to label");
  assert.equal(findComposer("Someone else"), false, "never reuse a different recipient's composer");
  const secondEditor = new Node("editor");
  const otherHeading = new Node("heading", "Haven rose");
  const otherChat = new Node("container", "Haven rose", [otherHeading, new Node("button", "Close chat"), secondEditor]);
  const root = new Node("container", "", [chat, otherChat]);
  globalThis.document = { querySelectorAll: selector => root.querySelectorAll(selector) };
  assert.equal(findComposer("Haven rose"), false, "two matching chats are ambiguous");
  const oldDocument = globalThis.document;
  globalThis.document = oldDocument;
  console.log("PASS: composer matched by exact conversation header when Facebook omits the recipient-specific input label; wrong and ambiguous chats rejected.");
}
{
  const oldDocument = globalThis.document;
  const editor = {
    tagName: "DIV", style: { visibility: "visible", display: "block" },
    getBoundingClientRect: () => ({ width: 20, height: 20 }),
    getAttribute: name => name === "role" ? "textbox"
      : name === "aria-label" ? "Write to Haven rose" : null,
    matches: selector => selector.includes("[contenteditable='true'][role='textbox']"),
  };
  const close = {
    innerText: "", style: { visibility: "visible", display: "block" },
    getBoundingClientRect: () => ({ width: 20, height: 20 }),
    getAttribute: name => name === "aria-label" ? "Close chat" : null,
  };
  const heading = {
    innerText: "Haven rose", textContent: "Haven rose",
    style: { visibility: "visible", display: "block" },
    getBoundingClientRect: () => ({ width: 20, height: 20 }),
    getAttribute: () => null,
  };
  globalThis.document = {
    location: { pathname: "/profile.php" },
    querySelectorAll: selector => selector.startsWith("[contenteditable")
      ? [editor] : selector === "button,[role='button']" ? [close] : [heading],
  };
  assert.deepEqual(diagnoseComposer("Haven rose"), {
    path: "/profile.php", visibleEditors: 1, supportedEditors: 1,
    recipientLabelEditors: 1, visibleCloseControls: 1, recipientHeaderMatched: true,
  }, "diagnostics expose readiness signals without returning profile or message text");
  globalThis.document = oldDocument;
  console.log("PASS: composer diagnostics report only selector counts and recipient-match booleans.");
}
{
  const oldDocument = globalThis.document;
  const button = {
    innerText: "Message",
    style: { visibility: "visible", display: "block" },
    getBoundingClientRect: () => ({ width: 60, height: 24 }),
    getAttribute: () => null,
  };
  const main = {
    innerText: "LinaVale 9 followers 10 following Digital creator",
    querySelectorAll: () => [button],
  };
  globalThis.document = { querySelector: () => main };
  assert.equal(findMessageButton("LinaVale"), button);
  assert.equal(findMessageButton("Different profile"), false, "do not reuse a button after profile identity changes");
  globalThis.document = oldDocument;
  console.log("PASS: resolve the unique visible Message button from the currently rendered matching profile.");
}

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
const collectEnd = browserSource.indexOf("\n    let candidates = await waitForGoogleChromeDmFollowers(", collectStart);
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
const heading = { ...visibleNode, innerText: "Followers", parentElement: section, querySelectorAll: () => [] };
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
globalThis.document.querySelector = () => ({ querySelectorAll: selector => selector === "span" ? [heading] : [] });
assert.equal((await collectEligibleProfiles()).length, 3, "a span-based Followers label remains scoped to the same follower list");
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
let messageRendered = true;
let renderMessageOnSend = true;
const send = new Node("button", "Press Enter to send");
send.click = async () => {
  events.push("send");
  editor.innerText = "";
  messageRendered = renderMessageOnSend;
};
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
let detachNextMessageClick = false;
let notClickableNextMessageClick = false;
let delayedMessageButtonWaits = 0;
let messageButtonAvailableAfterTimeouts = 0;
const message = { click: async () => {
  if (notClickableNextMessageClick) {
    notClickableNextMessageClick = false;
    events.push("message-not-clickable");
    throw new Error("Node is either not clickable or not an Element");
  }
  if (detachNextMessageClick) {
    detachNextMessageClick = false;
    events.push("message-detached");
    throw new Error("Node is detached from document");
  }
  events.push("message");
  editor.isConnected = true;
} };
let waits = 0;
let location = "";
let historyVerdict = "empty";
let senderId = "42";
let collectFixture = null;
let fixtureCandidates = [
  { url: "https://www.facebook.com/profile.php?id=123", name: "Test Recipient" },
  { url: "https://www.facebook.com/profile.php?id=456", name: "Second Recipient" },
];
const page = {
  cookies: async () => [{ name: "c_user", value: senderId }],
  goto: async url => { location = url; events.push("navigate"); },
  url: () => location,
  evaluate: async fn => {
    const text = fn.toString();
    if (text.includes("visibleEditors") && text.includes("recipientHeaderMatched")) {
      return {
        path: "/profile.php", visibleEditors: 0, supportedEditors: 0,
        recipientLabelEditors: 0, visibleCloseControls: 1, recipientHeaderMatched: true,
      };
    }
    if (text.includes("domContentLoadedEventEnd") && text.includes("readyState")) {
      return { readyState: "interactive", domContentLoadedMs: 100, loadEventMs: null };
    }
    if (text.includes("scrollHeight")) return 1000;
    if (text.includes("scrollTo")) return;
    if (collectFixture) return collectFixture();
    return fixtureCandidates;
  },
  evaluateHandle: async () => wrap(message),
  waitForFunction: async (fn, _options, ...args) => {
    if (fn === findMessageButton) {
      if (delayedMessageButtonWaits < messageButtonAvailableAfterTimeouts) {
        delayedMessageButtonWaits++;
        const error = new Error("Waiting failed: timeout exceeded");
        error.name = "TimeoutError";
        throw error;
      }
      return wrap(message);
    }
    if (globalThis.__chromeDmFixture.composerUnavailable &&
        fn === globalThis.__chromeDmFixture.composerModule.findGoogleChromeDmComposer) {
      throw new Error("Composer fixture did not render");
    }
    if (fn === globalThis.__chromeDmFixture.composerModule.findGoogleChromeDmComposer) return wrap(editor);
    if (fn === inspectSent) {
      events.push("render");
      return wrap(messageRendered && editor.innerText === "");
    }
    if (fn === historyModule.inspectGoogleChromeDmHistory) {
      const verdict = typeof historyVerdict === "function" ? historyVerdict(location) : historyVerdict;
      if (!verdict) throw new Error("History loading timeout");
      return wrap(verdict);
    }
    if (fn === globalThis.__chromeDmFixture.find) return wrap(fn(editor, args[1]));
    if (fn.toString().includes("const focused = doc.activeElement")) return wrap(true);
    if (fn.toString().includes("const actual = String(element.innerText")) {
      return wrap(editor.innerText === args[1]);
    }
    if (fn.toString().includes("=> !element.isConnected")) {
      waits += 3; // Skip the normal send/confirmation steps when closing a skipped chat.
      return wrap(!editor.isConnected);
    }
    if (fn.toString().includes("if (!element.isConnected) return true")) {
      return wrap(!editor.isConnected);
    }
    return wrap(true); // Verified profile identity.
  },
};
const gaps = [];
globalThis.__chromeDmFixture = {
  waitFollowers,
  historyModule, historyDirectory, path,
  composerModule,
  sentModule: { inspectGoogleChromeDmSentMessage: inspectSent },
  personalizationModule,
  page, find: (_handle, action) => find(editor, action),
  findMessageButton, findGoogleChromeDmMessageButton: findMessageButton,
  composerUnavailable: false, browserLogs: [],
  reject,
  wait: async (seconds, stopped) => {
    const started = Date.now();
    await waitForGoogleChromeDmDelay(seconds, stopped);
    gaps.push({ seconds, elapsed: Date.now() - started });
    events.push("delay");
  },
};
const prelude = `
const waitForGoogleChromeDmFollowers = (read, stopped) => globalThis.__chromeDmFixture.waitFollowers(read, stopped, 1000, async () => {});
const setTimeout = callback => globalThis.setTimeout(callback, 0);
const { googleChromeDmRecipientKey, readGoogleChromeDmContacts, readGoogleChromeDmPendingContacts, recordGoogleChromeDmContacts, recordGoogleChromeDmPendingContacts, clearGoogleChromeDmPendingContacts, inspectGoogleChromeDmHistory } = globalThis.__chromeDmFixture.historyModule;
const { findGoogleChromeDmComposer, diagnoseGoogleChromeDmComposer } = globalThis.__chromeDmFixture.composerModule;
const { inspectGoogleChromeDmSentMessage } = globalThis.__chromeDmFixture.sentModule;
const { personalizeGoogleChromeDmMessage } = globalThis.__chromeDmFixture.personalizationModule;
const { findGoogleChromeDmMessageButton } = globalThis.__chromeDmFixture;
const scrollGoogleChromeDmFollowers = () => ({ scrolled: false });
const COOKIES_DIR = globalThis.__chromeDmFixture.historyDirectory;
const path = globalThis.__chromeDmFixture.path;
const GOOGLE_CHROME_BROWSER_PROFILE_ID = 10000000;
const activeGoogleChromeDmRuns = new Map();
const sessions = new Map([[10000000, {page: globalThis.__chromeDmFixture.page}]]);
const findGoogleChromeDmControl = globalThis.__chromeDmFixture.find;
const waitForGoogleChromeDmDelay = globalThis.__chromeDmFixture.wait;
const googleChromeGirlsOnlyRejection = globalThis.__chromeDmFixture.reject;
const wsWrite = () => {};
const log = message => globalThis.__chromeDmFixture.browserLogs.push(message);
`;
const flow = await transform(prelude + browserSource.slice(start, end), { loader: "ts", format: "esm" });
const { runGoogleChromeDm } = await import(`data:text/javascript;base64,${Buffer.from(flow.code).toString("base64")}`);
const result = await runGoogleChromeDm(10_000_000, {
  url: "https://www.facebook.com/profile.php?id=999&sk=followers",
  message: "Local fixture only", amount: 1,
});
assert.equal(result.sent, 1, JSON.stringify({ result, events, logs: globalThis.__chromeDmFixture.browserLogs }));
assert.equal(result.failed, 0);
assert.deepEqual(events, ["navigate", "navigate", "message", "composer", "send", "render", "close"]);
assert.equal(editor.isConnected, false);
assert.equal(gaps.length, 0, "no delay before first or after last recipient");
{
  fixtureCandidates = [{ url: "https://www.facebook.com/profile.php?id=777", name: "Unrendered Recipient" }];
  renderMessageOnSend = false;
  events.length = 0; waits = 0;
  const unrendered = await runGoogleChromeDm(10_000_000, {
    url: "https://www.facebook.com/profile.php?id=999&sk=followers",
    message: "Local fixture only", amount: 2,
  });
  assert.equal(unrendered.sent, 0, "an emptied composer without a rendered message is not counted as sent");
  assert.equal(unrendered.failed, 1);
  assert.equal(unrendered.attempted, 1, "stop after the first unconfirmed Send click");
  assert.deepEqual(events, ["navigate", "navigate", "message", "composer", "send", "render"]);
  assert.equal(readPendingContacts(path.join(historyDirectory, "google-chrome-dm-history.json"), senderId).has("id:777"), true,
    "keep an uncertain attempt pending for conversation reconciliation");
  assert.equal(readContactsFromHistory(path.join(historyDirectory, "google-chrome-dm-history.json"), senderId).has("id:777"), false,
    "do not report an unrendered attempt as a sent contact");

  renderMessageOnSend = true;
  historyVerdict = "empty";
  events.length = 0; waits = 0;
  const retry = await runGoogleChromeDm(10_000_000, {
    url: "https://www.facebook.com/profile.php?id=999&sk=followers",
    message: "Local fixture only", amount: 1, skipAlreadyMessaged: true,
  });
  assert.equal(retry.sent, 1, "an empty conversation safely clears the pending marker and retries");
  assert.equal(readPendingContacts(path.join(historyDirectory, "google-chrome-dm-history.json"), senderId).has("id:777"), false);
  assert.equal(readContactsFromHistory(path.join(historyDirectory, "google-chrome-dm-history.json"), senderId).has("id:777"), true);
  fixtureCandidates = [
    { url: "https://www.facebook.com/profile.php?id=123", name: "Test Recipient" },
    { url: "https://www.facebook.com/profile.php?id=456", name: "Second Recipient" },
  ];
  console.log("PASS: a cleared composer without a visible outgoing message stays unconfirmed, keeps its chat open and reconciles safely on retry.");
}
{
  events.length = 0; waits = 0;
  detachNextMessageClick = true;
  const retried = await runGoogleChromeDm(10_000_000, {
    url: "https://www.facebook.com/profile.php?id=999&sk=followers",
    message: "Local fixture only", amount: 1,
  });
  assert.equal(retried.sent, 1, "re-resolve a detached Message button and use one fresh native click");
  assert.deepEqual(events, [
    "navigate", "navigate", "message-detached", "message", "composer", "send", "render", "close",
  ]);
}
{
  events.length = 0; waits = 0;
  notClickableNextMessageClick = true;
  const retried = await runGoogleChromeDm(10_000_000, {
    url: "https://www.facebook.com/profile.php?id=999&sk=followers",
    message: "Local fixture only", amount: 1,
  });
  assert.equal(retried.sent, 1, "re-resolve and retry a Message control with no clickable point");
  assert.deepEqual(events, [
    "navigate", "navigate", "message-not-clickable", "message", "composer", "send", "render", "close",
  ]);
}
{
  events.length = 0; waits = 0; delayedMessageButtonWaits = 0;
  messageButtonAvailableAfterTimeouts = 4;
  const delayed = await runGoogleChromeDm(10_000_000, {
    url: "https://www.facebook.com/profile.php?id=999&sk=followers",
    message: "Local fixture only", amount: 1,
  });
  assert.equal(delayed.sent, 1, "continue looking for the profile Message control after repeated timeouts");
  assert.equal(delayedMessageButtonWaits, 4);
  assert.deepEqual(events, ["navigate", "navigate", "message", "composer", "send", "render", "close"]);
  messageButtonAvailableAfterTimeouts = 0;
}
{
  globalThis.__chromeDmFixture.composerUnavailable = true;
  globalThis.__chromeDmFixture.browserLogs.length = 0;
  events.length = 0; waits = 0;
  const noComposer = await runGoogleChromeDm(10_000_000, {
    url: "https://www.facebook.com/profile.php?id=999&sk=followers",
    message: "Local fixture only", amount: 2,
  });
  assert.equal(noComposer.attempted, 1, "stop after the first composer timeout instead of opening the remaining chats");
  assert.equal(noComposer.failed, 1);
  assert.deepEqual(events, ["navigate", "navigate", "message"]);
  assert(globalThis.__chromeDmFixture.browserLogs.some(line =>
    line.includes("Stopping to avoid opening more chats") &&
    line.includes("visibleEditors=0") && line.includes("visibleCloseControls=1")),
  "record actionable composer diagnostics without exposing message text or recipient names");
  globalThis.__chromeDmFixture.composerUnavailable = false;
}
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
  "navigate", "navigate", "message", "composer", "send", "render", "close",
  "delay", "navigate", "message", "composer", "send", "render", "close",
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
fixtureCandidates = [
  { url: "https://www.facebook.com/profile.php?id=101", name: "KELLIHATYOFF", photoUrl },
  { url: "https://www.facebook.com/profile.php?id=102", name: "LinaVale", photoUrl },
  { url: "https://www.facebook.com/profile.php?id=103", name: "L1NAVAL3", photoUrl },
  { url: "https://www.facebook.com/profile.php?id=104", name: "KE11I", photoUrl },
  { url: "https://www.facebook.com/profile.php?id=105", name: "Kellinyattof" },
  { url: "https://www.facebook.com/profile.php?id=106", name: "KelliShop", photoUrl },
];
events.length = 0; waits = 0;
const usernames = await runGoogleChromeDm(10_000_000, {
  url: "https://www.facebook.com/profile.php?id=999&sk=followers",
  message: "Local fixture only", amount: 10, girlsOnly: true,
  delayMinSeconds: 0, delayMaxSeconds: 0,
});
assert.equal(usernames.sent, 2);
assert.equal(usernames.skipped, 4);
assert.deepEqual(usernames.sentUrls, [
  "https://www.facebook.com/profile.php?id=101", "https://www.facebook.com/profile.php?id=102",
]);
console.log("PASS: real Girls Only dispatcher accepts the two letters-only username examples and never targets their numeric, missing-picture or shop variants.");
fixtureCandidates = [
  { url: "https://www.facebook.com/profile.php?id=201", name: "Luna Zamorano", photoUrl },
  { url: "https://www.facebook.com/profile.php?id=202", name: "Bambi", photoUrl },
  { url: "https://www.facebook.com/profile.php?id=203", name: "Anya Sweete", photoUrl },
  { url: "https://www.facebook.com/profile.php?id=204", name: "Anna the swedish girl", photoUrl },
  { url: "https://www.facebook.com/profile.php?id=205", name: "breadboy667", photoUrl },
  { url: "https://www.facebook.com/profile.php?id=206", name: "Kristal Beauty Studio", photoUrl },
  { url: "https://www.facebook.com/profile.php?id=207", name: "Rpro gaming", photoUrl },
];
events.length = 0; waits = 0;
const correctedNames = await runGoogleChromeDm(10_000_000, {
  url: "https://www.facebook.com/profile.php?id=999&sk=followers",
  message: "Local fixture only", amount: 10, girlsOnly: true,
  delayMinSeconds: 0, delayMaxSeconds: 0,
});
assert.equal(correctedNames.sent, 3);
assert.equal(correctedNames.skipped, 4);
assert.deepEqual(correctedNames.sentUrls, [201, 202, 203].map(id => `https://www.facebook.com/profile.php?id=${id}`));
console.log("PASS: production dispatcher selects Luna, Bambi and Anya while preserving the screenshot's word-count, numeric and business exclusions.");
fixtureCandidates = [
  { url: "https://www.facebook.com/profile.php?id=301", name: "Sarita Bb", photoUrl },
  { url: "https://www.facebook.com/profile.php?id=302", name: "Agnieszka", photoUrl },
  { url: "https://www.facebook.com/profile.php?id=303", name: "Toshihiro", photoUrl },
  { url: "https://www.facebook.com/profile.php?id=304", name: "Sarita" },
];
events.length = 0; waits = 0;
const international = await runGoogleChromeDm(10_000_000, {
  url: "https://www.facebook.com/profile.php?id=999&sk=followers",
  message: "Local fixture only", amount: 10, girlsOnly: true,
  delayMinSeconds: 0, delayMaxSeconds: 0,
});
assert.equal(international.sent, 2);
assert.equal(international.skipped, 2);
assert.deepEqual(international.sentUrls, [301, 302].map(id => `https://www.facebook.com/profile.php?id=${id}`));
fixtureCandidates = [
  "Lívia Monteiro", "Nicole Misfit", "Alkaline Atropos", "Laura.Flores", "miss belcalis",
  "Andrea Patricia Borja", "Miss John", "Miss Beauty Studio",
].map((name, index) => ({ name, photoUrl, url: `https://www.facebook.com/profile.php?id=${401 + index}` }));
events.length = 0; waits = 0;
const approvedFormats = await runGoogleChromeDm(10_000_000, {
  url: "https://www.facebook.com/profile.php?id=999&sk=followers",
  message: "Local fixture only", amount: 10, girlsOnly: true,
  delayMinSeconds: 0, delayMaxSeconds: 0,
});
assert.equal(approvedFormats.sent, 5);
assert.equal(approvedFormats.skipped, 3);
assert.deepEqual(approvedFormats.sentUrls, [401, 402, 403, 404, 405].map(id => `https://www.facebook.com/profile.php?id=${id}`));
console.log("PASS: production dispatcher targets all five user-confirmed profiles and excludes three-part, male-name and business variants.");
{
  const options = {
    url: "https://www.facebook.com/profile.php?id=999&sk=followers",
    message: "Fixture only", amount: 10, skipAlreadyMessaged: true,
    delayMinSeconds: 0, delayMaxSeconds: 0,
  };
  const runWith = async (id, verdict) => {
    fixtureCandidates = [{ url: `https://www.facebook.com/profile.php?id=${id}`, name: "Haven rose", photoUrl }];
    historyVerdict = verdict;
    events.length = 0; waits = 0;
    return runGoogleChromeDm(10_000_000, options);
  };
  const oldThread = await runWith(600, "existing");
  assert.equal(oldThread.sent, 0);
  assert.equal(oldThread.skipped, 1);
  assert.deepEqual(events, ["navigate", "navigate", "message", "close"], "existing conversation is closed without typing or sending");
  const persisted = await runWith(600, "empty");
  assert.equal(persisted.sent, 0);
  assert(!events.includes("message"), "later run skips disk-recorded recipient before opening chat");
  fixtureCandidates = [{ url: "https://m.facebook.com/people/Haven/600/?ref=followers", name: "Haven rose", photoUrl }];
  events.length = 0; waits = 0;
  assert.equal((await runGoogleChromeDm(10_000_000, options)).sent, 0);
  assert(!events.includes("message"), "different profile URL for the same ID is still skipped");
  const unknown = await runWith(601, false);
  assert.equal(unknown.sent, 0);
  assert.equal(unknown.failed, 1);
  assert(!events.includes("composer") && !events.includes("send"), "unknown history never types or sends");
  const newThread = await runWith(602, "empty");
  assert.equal(newThread.sent, 1);
  const nextRun = await runWith(602, "empty");
  assert.equal(nextRun.sent, 0, "successful contact survives a new run");
  senderId = "43";
  const otherSender = await runWith(602, "empty");
  assert.equal(otherSender.sent, 1, "different sender is not incorrectly blocked by another account's record");
  senderId = "";
  await assert.rejects(() => runWith(603, "empty"), /account could not be verified/);
  senderId = "42";
  const imported = await runGoogleChromeDm(10_000_000, {
    ...options, alreadyMessagedUrls: ["https://facebook.com/people/Someone/603/?tracking=old"],
  });
  assert.equal(imported.sent, 0, "legacy frontend history is imported and ID-normalised");
  // Keep a pending attempt after a click exception; inspect the live conversation
  // before deciding whether a retry would duplicate an already accepted message.
  const originalSend = send.click;
  send.click = async () => { events.push("send"); throw new Error("Browser disconnected during Send"); };
  const uncertain = await runWith(604, "empty");
  assert.equal(uncertain.sent, 0);
  assert.equal(uncertain.failed, 1);
  send.click = originalSend;
  const retry = await runWith(604, "existing");
  assert.equal(retry.sent, 0);
  assert.equal(retry.skipped, 1, "pending attempt with a rendered history becomes confirmed without resending");
  assert(!events.includes("send"), "an interrupted send with existing chat history is not repeated");
  fixtureCandidates = [605, 606].map(id => ({
    url: `https://facebook.com/profile.php?id=${id}`, name: "Haven rose", photoUrl,
  }));
  historyVerdict = url => url.includes("id=605") ? "existing" : "empty";
  events.length = 0; waits = 0;
  const skipThenSend = await runGoogleChromeDm(10_000_000, { ...options, amount: 1 });
  assert.equal(skipThenSend.sent, 1, "a skipped existing conversation does not consume the requested amount");
  assert.deepEqual(skipThenSend.sentUrls, ["https://facebook.com/profile.php?id=606"]);
  historyVerdict = "empty";
  console.log("PASS: production skip flow handles existing replies, repeated runs, URL aliases, unknown history, imported history, account isolation and interrupted sends.");
}
{
  const options = {
    url: "https://www.facebook.com/profile.php?id=999&sk=followers",
    message: "Fixture only", amount: 1, skipAlreadyMessaged: true,
    delayMinSeconds: 0, delayMaxSeconds: 0,
  };
  let reads = 0;
  collectFixture = () => ++reads < 4 ? [] : [{
    url: "https://www.facebook.com/profile.php?id=702", name: "Luna", photoUrl,
  }];
  events.length = 0; waits = 0;
  const delayed = await runGoogleChromeDm(10_000_000, options);
  assert.equal(delayed.sent, 1, "late-rendered followers proceed to messaging rather than a silent empty scan");
  assert(reads >= 4, "continue collecting after the first late-rendered row while checking for replacement recipients");
  reads = 0;
  collectFixture = () => [{
    url: `https://www.facebook.com/profile.php?id=${++reads === 1 ? 702 : 703}`, name: "Luna", photoUrl,
  }];
  events.length = 0; waits = 0;
  const moreRows = await runGoogleChromeDm(10_000_000, options);
  assert.equal(moreRows.sent, 1, "all-known first rows do not prevent scanning the next loaded rows");
  assert.deepEqual(moreRows.sentUrls, ["https://www.facebook.com/profile.php?id=703"]);
  collectFixture = null;
  fixtureCandidates = [{ url: "https://www.facebook.com/profile.php?id=704", name: "Sebastián", photoUrl }];
  events.length = 0; waits = 0;
  const excluded = await runGoogleChromeDm(10_000_000, { ...options, girlsOnly: true });
  assert.equal(excluded.sent, 0);
  assert.match(excluded.notice, /Send target not reached/);
  assert(!events.includes("message"));
  console.log("PASS: production dispatcher resumes after delayed rows, continues past known recipients and explains an entirely filtered list.");
}
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
await fs.rm(historyDirectory, { recursive: true, force: true });
console.log("PASS: production send/close flow, one random inter-message gap, invalid range and responsive Stop.");
