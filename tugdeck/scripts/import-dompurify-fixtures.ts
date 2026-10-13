/**
 * import-dompurify-fixtures.ts — vendor DOMPurify's own test payloads as
 * hostile cases for both sanitizers.
 *
 * DOMPurify's repository keeps its regression corpus in
 * `test/fixtures/expect.mjs`; the npm package does not ship it. This script
 * reads a copy of that file at the tag matching the pinned `dompurify`
 * version and writes the payloads (titles and inputs, not DOMPurify's
 * expected outputs, which assume its default config rather than ours) to
 * `crates/tugmark/corpus/dompurify/payloads.json`. tugcast's invariant test
 * and the page's both read that file.
 *
 *   curl -sfL https://raw.githubusercontent.com/cure53/DOMPurify/<version>/test/fixtures/expect.mjs -o /tmp/expect.mjs
 *   bun scripts/import-dompurify-fixtures.ts /tmp/expect.mjs
 *
 * The payloads are DOMPurify's, under its license (MPL-2.0 OR Apache-2.0),
 * and the file says so.
 */

import { readFileSync, writeFileSync } from "fs";
import path from "path";

const TUGDECK = path.resolve(import.meta.dir, "..");
const OUT = path.join(TUGDECK, "crates/tugmark/corpus/dompurify/payloads.json");

const source = process.argv[2];
if (!source) {
  console.error("usage: bun scripts/import-dompurify-fixtures.ts <path to expect.mjs>");
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(path.join(TUGDECK, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};
const version = pkg.dependencies.dompurify;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`dompurify must be pinned exactly in package.json; found "${version}"`);
  process.exit(2);
}

const cases = (await import(path.resolve(source))).default as { title?: string; payload: string }[];
const out = {
  source: `https://github.com/cure53/DOMPurify/blob/${version}/test/fixtures/expect.mjs`,
  version,
  license: "MPL-2.0 OR Apache-2.0 (DOMPurify, Copyright Dr.-Ing. Mario Heiderich, Cure53)",
  // Most of the html5sec cases carry no title upstream; they are named by position.
  cases: cases.map(({ title, payload }, i) => ({ title: title ?? `expect.mjs #${i}`, payload })),
};
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${out.cases.length} payloads from DOMPurify ${version} to ${path.relative(TUGDECK, OUT)}`);
