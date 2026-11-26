import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { transform } from "esbuild";

const source = await fs.readFile(new URL("../../dannys-bot/src/lib/browserAddressHistory.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { readVisitedAddresses, addVisitedAddress } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
);
let addresses = [];
addresses = addVisitedAddress(addresses, "https://example.test/first");
addresses = addVisitedAddress(addresses, "https://example.test/second?q=hello#section");
assert.deepEqual(addresses, ["https://example.test/second?q=hello#section", "https://example.test/first"]);
addresses = addVisitedAddress(addresses, "https://example.test/first");
assert.deepEqual(addresses, ["https://example.test/first", "https://example.test/second?q=hello#section"]);
assert.equal(addVisitedAddress(addresses, "https://example.test/first"), addresses, "duplicate current URL causes no state update");
for (const invalid of ["about:blank", "", "javascript:alert(1)", "file:///tmp/private", "data:text/html,hi",
  "https://user:password@example.test", null, {}, 123]) {
  assert.equal(addVisitedAddress(addresses, invalid), addresses);
}
assert.deepEqual(readVisitedAddresses(JSON.parse(JSON.stringify(addresses))), addresses, "saved history reloads");
assert.deepEqual(readVisitedAddresses({}), []);
assert.deepEqual(readVisitedAddresses(["https://EXAMPLE.test", "https://example.test/", null, "about:blank"]), ["https://example.test/"]);
for (let index = 0; index < 110; index++) addresses = addVisitedAddress(addresses, `https://example.test/${index}`);
assert.equal(addresses.length, 100);
assert.equal(addresses[0], "https://example.test/109");
assert.equal(addresses[99], "https://example.test/10");

const panel = await fs.readFile(new URL("../../dannys-bot/src/components/BrowserPanel.tsx", import.meta.url), "utf8");
assert.match(panel, /case "urlChange":\s*recordVisitedAddress\(msg\.url\)/);
assert.match(panel, /useBrowserAddressHistory\(genericBrowser === true\)/);
assert.match(panel, /onSelect=\{url => \{\s*setAddressBar\(url\);\s*setIsLoading\(true\);\s*send\(\{ type: "navigate", url \}\)/);
console.log("PASS: recent-first history, deduplication, persistence reload, invalid/credential URL exclusion, bounded storage and Chrome-only navigation wiring.");
