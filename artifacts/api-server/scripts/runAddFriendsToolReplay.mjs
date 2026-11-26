import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { AddFriendsReplayDevice } from "./addFriendsReplayDevice.mjs";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.resolve(apiRoot, "../dannys-bot");
const input = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "real-add-friends-replay-"));
const emit = event => process.stdout.write(JSON.stringify(event) + "\n");
const androidExports = ["dumpUi", "tap", "swipe", "getScreenSizeAsync", "captureScreenPixels",
  "isKeyboardShown", "keyevent", "withInputTransaction", "loadNavigationCalibrationMap", "tapCalibratedNavigationControlAtY"];
try {
  // All tool file writes and historical lookups stay inside this subprocess's
  // disposable sandbox. The real database module is never bundled or imported.
  process.env.EQUINOX_DATA_DIR = sandbox;
  const outfile = path.join(sandbox, "tool.mjs");
  const compiled = await build({
    stdin: {
      contents: `
        import { createElement } from "react";
        import { renderToStaticMarkup } from "react-dom/server";
        import { AddFriendsReplayPhone } from "./src/components/tools/AddFriendsReplayPhone";
        import * as model from "./src/components/tools/addFriendsReplayScene";
        export * from "./src/components/tools/addFriendsReplayScene";
        export { runAddFriends } from ${JSON.stringify(path.join(apiRoot, "src/mobile/hst/snapchat/tools/addFriends.ts"))};
        export { withSnapchatContext } from ${JSON.stringify(path.join(apiRoot, "src/mobile/hst/snapchat/runtime.ts"))};
        export { setDevice } from "replay-android";
        export function renderPhone(scene) {
          return renderToStaticMarkup(createElement(AddFriendsReplayPhone, {
            scene, contacts: model.contactsFrom(scene.nodes), selected: "", running: true,
            onSelect() {}, onAction() {}
          })).replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" width="' + scene.width + '" height="' + scene.height + '" ');
        }`,
      resolveDir: webRoot, loader: "tsx",
    },
    outfile, bundle: true, platform: "node", format: "esm", jsx: "automatic",
    banner: { js: 'import { createRequire as replayCreateRequire } from "node:module"; const require = replayCreateRequire(import.meta.url);' },
    define: { "process.env.NODE_ENV": '"production"' },
    metafile: true, logLevel: "silent",
    plugins: [{
      name: "isolated-replay-boundaries",
      setup(builder) {
        builder.onResolve({ filter: /(?:^replay-android$|(?:^|\/)androidManager(?:\.ts)?$)/ }, () =>
          ({ path: "android", namespace: "replay-boundary" }));
        builder.onResolve({ filter: /(?:^|\/)storage(?:\.ts)?$/ }, args => {
          if (!/\/snapchat\/tools\/(?:addFriends|addFriendsDailyLimit)\.ts$/.test(args.importer)) throw new Error("Unexpected storage dependency in replay.");
          return { path: "storage", namespace: "replay-boundary" };
        });
        builder.onLoad({ filter: /.*/, namespace: "replay-boundary" }, ({ path: name }) => ({
          contents: name === "storage"
            ? `export const sqlite = { name: ${JSON.stringify(path.join(sandbox, "replay.sqlite"))}, prepare: () => ({ all: () => [] }) };`
            : `let device; export const setDevice = value => { device = value; }; ${androidExports.map(name =>
              `export const ${name} = (...args) => device.${name}(...args);`).join("\n")}`,
          loader: "js",
        }));
      },
    }],
  });
  const inputFiles = Object.keys(compiled.metafile.inputs);
  if (inputFiles.some(file => /(?:^|\/)(androidManager|storage)\.ts$/.test(file))) {
    throw new Error("Replay isolation failed: a real device/storage module was bundled.");
  }
  const sourceFiles = inputFiles.filter(file => /snapchat\/(?:tools\/addFriends|runtime|navigation\/.*)\.ts$/.test(file));
  const hash = createHash("sha256");
  for (const filename of sourceFiles.sort()) hash.update(await fs.readFile(path.resolve(filename)));
  emit({ type: "start", engine: "runAddFriends", sourceHash: hash.digest("hex").slice(0, 12), sourceFiles,
    message: "Compiled the current Add Friends tool, runtime, and navigation code for this run." });
  const model = await import(pathToFileURL(outfile).href);
  const nodes = model.parseInspectNodes(input.uiXml);
  const device = new AddFriendsReplayDevice({
    model, nodes, width: input.screenWidth, height: input.screenHeight, emit,
    movementScale: input.movementScale ?? 1,
    omitDismissFor: input.action === "skip" ? input.friendName : undefined,
    moveSectionHeadings: input.moveSectionHeadings === true,
  });
  model.setDevice(device);
  let completedStep = null;
  const completedSteps = [];
  const stopAfterSteps = Math.max(1, Number(input.stopAfterSteps) || 1);
  const stop = new Error("REPLAY_STEP_COMPLETE");
  const logs = [];
  const context = {
    serial: "REPLAY_ONLY_NO_PHYSICAL_DEVICE",
    tools: { addFriends: {
      enabled: true, min: input.requestedCount ?? 1, max: input.requestedCount ?? 1,
      delayMinSeconds: input.delaySeconds ?? 0, delayMaxSeconds: input.delaySeconds ?? 0,
      skipAdded: false, dismissNonEnglish: false,
      maxFollowsEnabled: input.maxFollowsEnabled === true,
      maxFollowsMin: input.maxFollowsMin ?? 50,
      maxFollowsMax: input.maxFollowsMax ?? 100,
      avoidUsersContainingEnabled: input.action === "dismiss" || input.action === "skip",
      avoidUsersContainingWords: input.action === "add" ? "" : input.friendName,
    } },
    path: {}, pickLocalFolderImage: async () => null, pickLocalFolderVideo: async () => null,
    onLog: message => { logs.push(message); emit({ type: "log", message }); },
    onProgress() {}, onMetric: key => emit({ type: "metric", key }),
    isAborted: () => false, effectiveTypingProfile: () => ({}),
    // Preserve the real post-action settling period in the visible replay.
    sleep: async ms => new Promise(resolve => setTimeout(resolve, ms === 3000 ? ms : Math.min(ms, 220))),
    onAddFriendsStepComplete: async step => {
      completedStep = step;
      completedSteps.push(step);
      if (completedSteps.length >= stopAfterSteps) throw stop;
    },
  };
  let result;
  try { result = await model.withSnapchatContext(context, () => model.runAddFriends(context)); }
  catch (error) { if (error !== stop) throw error; }
  const named = model.contactsFrom(device.nodes).find(card => !card.dismissed && card.top >= model.listTopFor(device.scene()) - 1);
  emit({ type: "done", engine: "runAddFriends", completedStep, returned: result ?? null,
    completedSteps, nodes: device.nodes, actions: device.actions, swipes: device.swipes, logs,
    nextVisibleContact: named?.name ?? null,
    message: completedStep ? `Real tool finished its ${completedStep.action} step for ${completedStep.friendName}.`
      : "The live tool returned without completing a contact action. Inspect its actual logs." });
} catch (error) {
  emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await fs.rm(sandbox, { recursive: true, force: true });
}
