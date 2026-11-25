import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "unread-profile-test-"));
try {
  const outfile = path.join(directory, "identity.mjs");
  await build({
    entryPoints: ["src/mobile/hst/snapchat/tools/replyUnreadChatIdentity.ts"],
    bundle: true, platform: "node", format: "esm", outfile,
    plugins: [{
      name: "isolated-phone",
      setup(builder) {
        builder.onResolve({ filter: /androidManager$|\/runtime$/ }, args => ({
          path: /androidManager$/.test(args.path) ? "android" : "runtime",
          namespace: "phone-test",
        }));
        builder.onLoad({ filter: /.*/, namespace: "phone-test" }, args => ({
          contents: args.path === "android" ? `
            export const withInputTransaction = async (_serial, fn) => fn();
            export const tap = async (...args) => { globalThis.phoneTest.taps.push(args); };
            export const keyevent = async (_serial, key) => { globalThis.phoneTest.keys.push(key); };
          ` : `
            export const dump = async () => {
              const test = globalThis.phoneTest;
              return test.states.length > 1 ? test.states.shift() : test.states[0];
            };
            export const shortResourceId = node => node.resourceId.split("/").pop();
            export const center = node => ({ x: (node.bounds[0]+node.bounds[2])/2, y: (node.bounds[1]+node.bounds[3])/2 });
          `,
        }));
      },
    }],
  });
  const identity = await import(pathToFileURL(outfile).href);
  const node = (text, resourceId, bounds, className = "android.widget.TextView") =>
    ({ text, desc: "", resourceId, bounds, className });
  for (const height of [1640, 2460]) {
    const header = node("Dane Devlin", "chat_header_title", [100, height * .05, 400, height * .09]);
    const composer = node("", "chat_input_text_field", [0, height * .75, 500, height * .8], "android.widget.EditText");
    const chat = { nodes: [header, composer] };
    const profile = { nodes: [
      node("Dane Devlin", "profile_display_name", [50, 200, 400, 250]),
      node("dane.real", "profile_username", [50, 260, 400, 300]),
    ] };
    globalThis.phoneTest = { states: [chat, { nodes: [] }, profile, chat], taps: [], keys: [] };
    const logs = [];
    const result = await identity.verifyUnreadConversationIdentity({
      serial: "isolated", isAborted: () => false, sleep: async () => {}, onLog: message => logs.push(message),
    }, "feed_chat_button", height);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.value.username, "dane.real");
    assert.equal(result.value.displayName, "Dane Devlin");
    assert.equal(globalThis.phoneTest.taps.length, 1, "Visit the profile exactly once.");
    assert.deepEqual(globalThis.phoneTest.keys, [4], "Return to the conversation once.");
    assert(logs.some(message => message.includes("@dane.real")));
  }
  for (const text of ["feed_chat_button", "feed_cross_button", "Camera Reply", "avatar_container"]) {
    assert.equal(identity.contactNameFromNode(node(text, text, [0, 0, 50, 50])), undefined);
  }
  const source = await fs.readFile("src/mobile/hst/snapchat/tools/replyUnreadChats.ts", "utf8");
  assert.equal((source.match(/await verifyUnreadConversationIdentity\(/g) ?? []).length, 1);
  assert(!source.includes("conversationHeaderMatches("));
  assert(source.includes("const contactKey = verifiedIdentity.username"));
  assert(source.includes("username: contactKey"));
  console.log("PASS: actual header → one profile visit → username → return, with delayed rendering, stale list names, and two screen sizes.");
  console.log("PASS: interface labels excluded; one username lookup; history writes retain the profile username.");
} finally {
  delete globalThis.phoneTest;
  await fs.rm(directory, { recursive: true, force: true });
}
