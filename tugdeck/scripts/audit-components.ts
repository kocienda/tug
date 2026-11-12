/**
 * audit-components — hold `tugdeck/src` to the component rules.
 *
 * Walks every `.ts`/`.tsx` file under `tugdeck/src`, applies the checks of
 * `component-conformance.ts`, and compares the result against
 * `component-conformance-allowlist.json` both ways: a violation the allowlist
 * does not name fails, and so does an allowlist entry that no longer
 * violates. The allowlist can therefore only shrink — a change that fixes a
 * violation deletes its entry in the same commit.
 *
 * Prints one line per problem and exits 1, or a `PASS` line with the count of
 * allowlisted violations.
 *
 * Usage: bun run scripts/audit-components.ts
 */

import fs from "fs";
import path from "path";

import { type Allowlist, checkTree, ratchet } from "./component-conformance";

const TUGDECK = path.resolve(import.meta.dir, "..");
const REPO = path.dirname(TUGDECK);
const SRC = path.join(TUGDECK, "src");
const ALLOWLIST = path.join(import.meta.dir, "component-conformance-allowlist.json");

function walk(dir: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const allowlist = JSON.parse(fs.readFileSync(ALLOWLIST, "utf8")) as Allowlist;
const violations = checkTree(
  walk(SRC, []).map((full) => ({
    path: path.relative(REPO, full).split(path.sep).join("/"),
    source: fs.readFileSync(full, "utf8"),
  })),
);
const problems = ratchet(violations, allowlist);

if (problems.length > 0) {
  for (const line of problems) console.log(line);
  console.log(`audit-components: ${problems.length} problem(s)`);
  process.exit(1);
}
const files = new Set(violations.map((v) => `${v.rule} ${v.path}`)).size;
console.log(`audit-components: PASS (${files} allowlisted file-rule pair(s), ${violations.length} violation(s))`);
