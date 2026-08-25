/**
 * tuglaws-index-coverage.test.ts — every law is reachable from the index.
 *
 * `tuglaws/INDEX.md` is the entry point to the curated doc surface, so a document
 * it does not link is a document nobody finds. The check reads the real directory
 * and the real index: every `*.md` under `tuglaws/` other than `INDEX.md` itself
 * must appear as a markdown link target. It proves coverage, not quality — whether
 * an entry is accurate or well-placed is a judgment no grep can hold.
 *
 * This is a pure-logic test (no app launch); it lives beside the other repository
 * checks in this directory and is invisible to `testFiles()`, which only scans the
 * corpus root and `harness-smoke/`.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const APP_TEST_DIR = resolve(dirname(import.meta.dir));
const REPO_ROOT = resolve(APP_TEST_DIR, "..", "..");
const TUGLAWS_DIR = join(REPO_ROOT, "tuglaws");
const INDEX_NAME = "INDEX.md";

describe("every tuglaw is linked from the index", () => {
    test("INDEX.md links every sibling document", () => {
        const documents = readdirSync(TUGLAWS_DIR)
            .filter((name) => name.endsWith(".md") && name !== INDEX_NAME)
            .sort();
        expect(documents.length).toBeGreaterThan(0);

        const index = readFileSync(join(TUGLAWS_DIR, INDEX_NAME), "utf8");
        const missing = documents.filter((name) => !index.includes(`](${name})`));

        expect(
            missing,
            missing.length === 0
                ? ""
                : `unindexed in tuglaws/INDEX.md: ${missing.join(", ")} — ` +
                  "add an entry in the section its subject belongs to, or delete the document",
        ).toEqual([]);
    });
});
