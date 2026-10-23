/**
 * Grep-contract tests — Step 15.
 *
 * The selection-persistence refactor has natural bright lines that a
 * text-level grep can enforce cheaply and without interpretation.
 * These tests read the repository on disk and fail if new callers of
 * retired or owner-restricted APIs sneak back in. They complement the
 * behavioural tests rather than replacing them — a callsite leaking
 * past a grep contract means a design deviation, not just a missed
 * edit.
 *
 * ## What we check
 *
 *   1. `selectionGuard.saveSelection(` / `selectionGuard.restoreSelection(`
 *      have **zero production callers**. The methods still exist inside
 *      `selection-guard.ts` for internal use and are exercised by
 *      legacy test files until Step 16 of the plan retires them
 *      outright. No code under `tugdeck/src/` outside `__tests__/` may
 *      call them. [D09]
 *
 *   2. `setBaseAndExtent(` appears in `selection-guard.ts` (drag-clip +
 *      `restoreCardDomSelection`), `text-selection-adapter.ts`
 *      (word-at-point click), `selection-extension.ts` (shift extent) and
 *      `atom-decoration.ts` (re-seating WebKit's caret on the selection it
 *      already reports). Any other production callsite is an independent
 *      programmatic selection path that bypasses selection-guard — a
 *      design regression.
 *
 *   3. `setSelectionRange(` appears in `card-host.tsx`
 *      (`applyFormControlSnapshot`), `use-text-input-responder.tsx`
 *      (context-menu selection restore — existing, unchanged), and
 *      `text-selection-adapter.ts` (word-at-point click). Any other
 *      production callsite is an independent form-control selection
 *      path that bypasses the card-host walk — a design regression.
 *
 * `.focus()` is deliberately NOT grep-contracted. Legitimate
 * component-internal focus claims (session-card activation, tug-sheet
 * close-restore, tug-prompt-* handoff, engine-internal) are too
 * numerous for a grep to judge. The focus-restore *purpose* is pinned
 * by the Step 11 behaviour tests, not by grep.
 */

import { describe, it, expect } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

// ---------------------------------------------------------------------------
// Repo walk helper
// ---------------------------------------------------------------------------

const SRC_ROOT = join(import.meta.dir, "..");
const PRODUCTION_GLOB = "**/*.{ts,tsx}";
const TEST_DIR = "__tests__";

function* productionFiles(): Iterable<string> {
  const glob = new Glob(PRODUCTION_GLOB);
  for (const path of glob.scanSync(SRC_ROOT)) {
    // Skip test files — they are allowed to call the legacy / owned
    // APIs for coverage during the migration window.
    if (path.includes(`${TEST_DIR}/`) || path.includes(`/${TEST_DIR}/`)) continue;
    yield join(SRC_ROOT, path);
  }
}

interface Hit {
  relPath: string;
  line: number;
  text: string;
}

function scanFor(needle: string, allowlist: ReadonlySet<string>): Hit[] {
  const hits: Hit[] = [];
  for (const absPath of productionFiles()) {
    const relPath = relative(SRC_ROOT, absPath);
    if (allowlist.has(relPath)) continue;
    const source = readFileSync(absPath, "utf8");
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip lines that are entirely inside a block/line comment. A
      // naive "does the line contain // before the needle" test
      // catches almost everything; block comments are uncommon in
      // the files we scan and a residual false positive would
      // surface as an intentional comment that should still be
      // flagged — harmless.
      const commentStart = line.indexOf("//");
      const needlePos = line.indexOf(needle);
      if (needlePos === -1) continue;
      if (commentStart !== -1 && commentStart < needlePos) continue;
      hits.push({ relPath, line: i + 1, text: line.trim() });
    }
  }
  return hits;
}

function fmtHits(hits: Hit[]): string {
  return hits
    .map((h) => `  ${h.relPath}:${h.line}  ${h.text}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

describe("selection-persistence grep contracts (Step 15)", () => {
  it("selectionGuard.saveSelection has zero production callers", () => {
    // Only the definition inside `selection-guard.ts` is permitted.
    const allowlist = new Set<string>([
      "components/tugways/selection-guard.ts",
    ]);
    const hits = scanFor("selectionGuard.saveSelection(", allowlist);
    if (hits.length > 0) {
      throw new Error(
        `selectionGuard.saveSelection has unexpected production caller(s):\n${fmtHits(hits)}`,
      );
    }
    expect(hits.length).toBe(0);
  });

  it("selectionGuard.restoreSelection has zero production callers", () => {
    const allowlist = new Set<string>([
      "components/tugways/selection-guard.ts",
    ]);
    const hits = scanFor("selectionGuard.restoreSelection(", allowlist);
    if (hits.length > 0) {
      throw new Error(
        `selectionGuard.restoreSelection has unexpected production caller(s):\n${fmtHits(hits)}`,
      );
    }
    expect(hits.length).toBe(0);
  });

  it("setBaseAndExtent( appears only in selection-guard.ts, text-selection-adapter.ts, selection-extension.ts, and atom-decoration.ts", () => {
    // selection-guard: drag-clip focus pin + `restoreCardDomSelection`
    //   paint path + `updatePaint` native-selection sync.
    // text-selection-adapter: word-at-point click place-caret.
    // selection-extension: shift-click / shift-drag extent placement, the
    //   one path that must express base-before-extent ordering directly.
    // atom-decoration: `regenCaretResync` collapses the DOM selection onto
    //   the very anchor and focus it reports, after an atom regeneration,
    //   so WebKit's caret is re-seated; it moves no selection.
    const allowlist = new Set<string>([
      "components/tugways/selection-guard.ts",
      "components/tugways/text-selection-adapter.ts",
      "components/tugways/selection-extension.ts",
      "components/tugways/tug-text-editor/atom-decoration.ts",
    ]);
    const hits = scanFor("setBaseAndExtent(", allowlist);
    if (hits.length > 0) {
      throw new Error(
        `setBaseAndExtent has unexpected production caller(s):\n${fmtHits(hits)}`,
      );
    }
    expect(hits.length).toBe(0);
  });

  it("setSelectionRange( appears only in card-host.tsx, use-text-input-responder.tsx, and text-selection-adapter.ts", () => {
    // card-host: `applyFormControlSnapshot`.
    // use-text-input-responder: pre-right-click selection restore + word-at-point.
    // text-selection-adapter: word-at-point click restore.
    const allowlist = new Set<string>([
      "components/chrome/card-host.tsx",
      "components/tugways/use-text-input-responder.tsx",
      "components/tugways/text-selection-adapter.ts",
    ]);
    const hits = scanFor("setSelectionRange(", allowlist);
    if (hits.length > 0) {
      throw new Error(
        `setSelectionRange has unexpected production caller(s):\n${fmtHits(hits)}`,
      );
    }
    expect(hits.length).toBe(0);
  });
});
