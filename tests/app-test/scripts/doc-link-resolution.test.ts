/**
 * doc-link-resolution.test.ts — a cited document either exists or is recorded debt.
 *
 * A comment or a law that points at a `.md` file which is not there says nothing,
 * and nothing tells anybody the day it stops being true. This check reads the real
 * tree and resolves every document pointer in it.
 *
 * Two extraction rules, each matching what its own syntax means:
 *
 *   1. A markdown link target inside a `*.md` file resolves against the citing
 *      document, because that is what a markdown link means. The tuglaws cite each
 *      other sibling-relative — `[ledger-reliability.md](ledger-reliability.md)` —
 *      and without this rule the check is blind to every one of them.
 *   2. Everything else resolves against the repo root, and only when the token is a
 *      repo-relative pointer: it contains a `/`, contains none of `* < > $ { }`, and
 *      does not begin with `.`, `~`, or `/`. This covers backticked spans everywhere
 *      and markdown links written inside source comments, which rule 1 cannot see
 *      because a `.css` file is not markdown.
 *
 * What is deliberately not a pointer: a bare directory token (`roadmap/`), a bare
 * filename outside a markdown link (`SKILL.md` — a name being discussed, not a path
 * being followed), a glob or interpolation, and a `../` or `~` backticked path, whose
 * base is anybody's guess. The asymmetry with rule 1 is intended: `../` inside a
 * markdown link has a defined base, inside a backtick span it does not.
 *
 * `notes/` is outside the scan set. A note is a historical record and its dead
 * pointers are part of the history it records.
 *
 * The allowlist beside this file records the dangles that existed the day the check
 * landed. It is a to-do with a green build, not an exemption: a pointer that dangles
 * and is not listed fails, and the assertion is two-sided, so an entry whose target
 * has since been created — or whose citing file no longer cites it — fails as well.
 * A stale allowlist is the same disease one layer up.
 *
 * This is a pure-logic test (no app launch); it lives beside the other repository
 * checks in this directory and is invisible to `testFiles()`, which only scans the
 * corpus root and `harness-smoke/`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const APP_TEST_DIR = resolve(dirname(import.meta.dir));
const REPO_ROOT = resolve(APP_TEST_DIR, "..", "..");
const ALLOWLIST_PATH = join(import.meta.dir, "doc-link-allowlist.txt");

// Directories walked whole. Each crate's own `src` under tugrust/crates is
// expanded below.
const SCAN_ROOTS = ["tugdeck/src", "tugdeck/styles", "tugcode/src"];

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "target"]);

/** A citation as extracted: who cited it, and the repo-relative path it names. */
interface Citation {
    citingFile: string;
    citedPath: string;
}

function crateSourceDirs(): string[] {
    const cratesDir = join(REPO_ROOT, "tugrust", "crates");
    if (!existsSync(cratesDir)) return [];
    return readdirSync(cratesDir)
        .map((crate) => join("tugrust", "crates", crate, "src"))
        .filter((dir) => existsSync(join(REPO_ROOT, dir)));
}

function walk(dir: string, into: string[]): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            walk(join(dir, entry.name), into);
        } else if (entry.isFile()) {
            into.push(join(dir, entry.name));
        }
    }
}

function scanFiles(): string[] {
    const files: string[] = [];
    for (const root of [...SCAN_ROOTS, ...crateSourceDirs()]) {
        const abs = join(REPO_ROOT, root);
        if (existsSync(abs) && statSync(abs).isDirectory()) walk(abs, files);
    }
    const tuglawsDir = join(REPO_ROOT, "tuglaws");
    for (const entry of readdirSync(tuglawsDir)) {
        if (entry.endsWith(".md")) files.push(join(tuglawsDir, entry));
    }
    return files.map((f) => relative(REPO_ROOT, f)).sort();
}

/** Strip a trailing `#anchor` and any trailing punctuation a sentence left on. */
function bareTarget(token: string): string {
    const withoutAnchor = token.split("#")[0] ?? "";
    return withoutAnchor.replace(/[),.;:]+$/, "");
}

/** A glob or an interpolation — not a path anybody could follow. */
const NOT_A_PATH = ["*", "<", ">", "$", "{", "}"];

/** Rule 2's test: is this token a repo-relative pointer at all? */
function isRepoRelativePointer(token: string): boolean {
    if (!token.includes("/")) return false;
    if (NOT_A_PATH.some((ch) => token.includes(ch))) return false;
    // Whitespace means the span was prose that happens to contain a path
    // (`[chip] notes/foo.md`), and a leading non-alphanumeric marks something
    // that is not a path at all — `@notes/x.md` is an atom mention being
    // demonstrated, `./` and `~` have no repo-root base, `/` is absolute.
    if (/\s/.test(token)) return false;
    return /^[A-Za-z0-9]/.test(token);
}

const MARKDOWN_LINK = /\]\(([^)\s]+?\.md(?:#[^)\s]*)?)\)/g;
const BACKTICK_SPAN = /`([^`\n]+?)`/g;

function extract(citingFile: string, text: string): Citation[] {
    const isMarkdown = citingFile.endsWith(".md");
    const found = new Map<string, Citation>();
    const add = (citedPath: string): void => {
        if (citedPath === "") return;
        found.set(citedPath, { citingFile, citedPath });
    };

    for (const match of text.matchAll(MARKDOWN_LINK)) {
        const target = bareTarget(match[1] ?? "");
        if (target === "") continue;
        if (isMarkdown) {
            // Rule 1 — resolve against the citing document.
            if (target.startsWith("~") || target.startsWith("/")) continue;
            add(relative(REPO_ROOT, resolve(REPO_ROOT, dirname(citingFile), target)));
        } else if (isRepoRelativePointer(target)) {
            // Rule 2 — a markdown link written inside a source comment.
            add(target);
        }
    }

    for (const match of text.matchAll(BACKTICK_SPAN)) {
        const span = (match[1] ?? "").trim();
        if (!span.endsWith(".md") && !span.includes(".md#")) continue;
        const target = bareTarget(span);
        // Rule 2 everywhere — a backticked path is repo-relative or it is prose.
        if (isRepoRelativePointer(target)) add(target);
    }

    return [...found.values()];
}

function collectCitations(): Citation[] {
    const citations: Citation[] = [];
    for (const file of scanFiles()) {
        const text = readFileSync(join(REPO_ROOT, file), "utf8");
        if (!text.includes(".md")) continue;
        citations.push(...extract(file, text));
    }
    return citations;
}

function key(c: Citation): string {
    return `${c.citingFile} ${c.citedPath}`;
}

function readAllowlist(): Set<string> {
    if (!existsSync(ALLOWLIST_PATH)) return new Set();
    return new Set(
        readFileSync(ALLOWLIST_PATH, "utf8")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "" && !line.startsWith("#")),
    );
}

describe("every cited document path resolves", () => {
    const citations = collectCitations();
    const allowlist = readAllowlist();
    const dangling = citations.filter(
        (c) => !existsSync(join(REPO_ROOT, c.citedPath)),
    );
    const danglingKeys = new Set(dangling.map(key));

    test("no unlisted pointer dangles", () => {
        const unlisted = dangling.filter((c) => !allowlist.has(key(c))).map(key);
        expect(
            unlisted,
            unlisted.length === 0
                ? ""
                : `${unlisted.length} document pointer(s) resolve to nothing:\n` +
                  unlisted.map((k) => `  ${k}`).join("\n") +
                  "\nRepair the pointer, or — if it is an intentional survivor — add the " +
                  `pair to ${relative(REPO_ROOT, ALLOWLIST_PATH)} with a reason.`,
        ).toEqual([]);
    });

    test("every allowlist entry is still a real dangle", () => {
        const repaired = [...allowlist].filter((entry) => !danglingKeys.has(entry));
        expect(
            repaired,
            repaired.length === 0
                ? ""
                : `${repaired.length} allowlist entr(ies) no longer name a dangle — ` +
                  "the target exists now, or the citing file stopped citing it. " +
                  `Delete the line from ${relative(REPO_ROOT, ALLOWLIST_PATH)}:\n` +
                  repaired.map((k) => `  ${k}`).join("\n"),
        ).toEqual([]);
    });
});
