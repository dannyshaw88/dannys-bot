/**
 * Refresh the bundled name facts from Jörg Michael's nam_dict.txt.
 * The derived data remains GFDL-1.2-or-later; no upstream program code is used.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const commit = "820d86f9f652ef064e784998b516a8aa2abefe3c";
const sourceUrl = `https://raw.githubusercontent.com/lead-ratings/gender-guesser/${commit}/gender_guesser/data/nam_dict.txt`;
const licenseUrl = "https://raw.githubusercontent.com/spdx/license-list-data/main/text/GFDL-1.2-or-later.txt";
const directory = fileURLToPath(new URL("../src/instagram/data/internationalGivenNames/", import.meta.url));
async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error(`Name data download failed: ${response.status} ${url}`);
  return response.text();
}
const [source, license] = await Promise.all([fetchText(sourceUrl), fetchText(licenseUrl)]);
if (!source.includes("Jörg MICHAEL") || !license.includes("GNU Free Documentation License")) {
  throw new Error("The upstream data or license format changed; review before importing.");
}
const labelsByName = new Map();
const normalize = value => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
for (const line of source.split(/\r?\n/)) {
  if (!line || line.startsWith("#")) continue;
  const [label, rawName] = line.trim().split(/\s+/);
  if (!["F", "1F", "?F", "M", "1M", "?M", "?"].includes(label) || !rawName) continue;
  // '+' explicitly permits a joined spelling in the source format. Do not
  // split compound entries and assign their label to unrelated name fragments.
  const name = normalize(rawName.replace(/\+/g, ""));
  if (!/^\p{L}+$/u.test(name)) continue;
  const labels = labelsByName.get(name) ?? new Set();
  labels.add(label);
  labelsByName.set(name, labels);
}
const female = [];
const maleOrAmbiguous = [];
for (const [name, labels] of labelsByName) {
  const blocked = ["M", "1M", "?M", "?"].some(label => labels.has(label));
  if (blocked) maleOrAmbiguous.push(name);
  else if (labels.has("F") || labels.has("1F")) female.push(name);
}
female.sort();
maleOrAmbiguous.sort();
if (female.length < 15_000 || maleOrAmbiguous.length < 20_000 ||
    !female.includes("sarita") || !maleOrAmbiguous.includes("sebastian")) {
  throw new Error("Unexpected name coverage; refusing to replace the bundled data.");
}
const data = {
  title: "International Given Names — Filtered Edition",
  copyright: "Copyright (c) 2007–2008 Jörg Michael",
  license: "GFDL-1.2-or-later",
  sourceUrl,
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  female,
  maleOrAmbiguous,
};
await fs.mkdir(directory, { recursive: true });
await Promise.all([
  fs.writeFile(path.join(directory, "names.json"), JSON.stringify(data, null, 2) + "\n"),
  fs.writeFile(path.join(directory, "LICENSE.txt"), license),
  // Preserve the original copyright, permissions and warranty notice.
  fs.writeFile(path.join(directory, "SOURCE-NOTICE.txt"),
    source.slice(0, source.indexOf("##################################################################################"))),
]);
console.log(`Imported ${female.length} female-labelled names and ${maleOrAmbiguous.length} male/ambiguous exclusions.`);
