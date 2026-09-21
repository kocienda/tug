/**
 * at0239-session-history-view.test.ts — the History shade (⌃⌘H →
 * `toggle-history-view`) renders the bound card's real recent commits over the
 * live GIT_LOG wire path, each as a collapsible `BlockChrome`.
 *
 * Driven against a real repo — this worktree itself, which tugcast registers as
 * its bootstrap `--source-tree` (the same rationale as at0238: a synthetic temp
 * repo hangs the app's boot). A session card is bound to it and the shade is
 * asserted to render that repo's real recent commits.
 *
 * Scenario:
 *   1. Bind a card to the repo, open the History shade.
 *   2. Each commit row leads with the commit atom — the read-only skin,
 *      labelled `commit:<8-char sha>` (the lifecycle dot is gone) — and NO row
 *      carries the old full-40-char hash.
 *   3. Expand the top commit → the committer's identity (name + email), the
 *      message body, and the commit's changed files (a `TugChangesList`, served
 *      by the new GIT_COMMIT_FILES path) render, each row leading with the
 *      shared `TugStatusMark` in the house N/M/D vocabulary ([D118]).
 *
 * @covers tugdeck/src/lib/git-log-store.ts
 * @covers tugdeck/src/lib/shade-view-controller.ts
 * @covers tugdeck/src/components/tugways/blocks/block-chrome.tsx
 * @covers tugrust/crates/tugcast/src/feeds/git.rs
 * @covers tugdeck/src/components/tugways/cards/session-history/session-history-view.tsx
 * @covers tugdeck/src/components/tugways/tug-changes-list.tsx
 * @covers tugdeck/src/components/tugways/tug-history-list.tsx
 * @covers tugdeck/src/components/tugways/commit-presentation.tsx
 * @covers tugdeck/src/lib/commit-format.ts
 * @covers tugdeck/src/components/tugways/commit-sha-text.tsx
 * @covers tugdeck/src/components/tugways/commit-sha-text.css
 * @covers tugdeck/src/components/tugways/entity-tips.tsx
 * @covers tugdeck/src/components/tugways/entity-tips.css
 * @covers tugdeck/src/components/tugways/tug-status-mark.tsx
 * @covers tugdeck/src/components/tugways/tug-status-mark.css
 * @covers tugdeck/src/components/tugways/tug-changes-list.css
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.css
 * @covers tugdeck/src/components/tugways/tug-filter-field.tsx
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { launchTugApp, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

/** The worktree root — the real repo tugcast serves as its bootstrap tree. */
const REPO = resolve(import.meta.dir, "..", "..");

const VIEW = `[data-slot="session-history-view"]`;
const ROW = `${VIEW} [data-testid="session-history-commit"]`;

function gitOut(args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", REPO, ...args]);
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  }
  return r.stdout.toString().trim();
}

describe.skipIf(!SHOULD_RUN)(
  "at0239 — History shade renders the bound project's commits, sha-left, expandable",
  () => {
    test(
      "short-sha leads each row (no dot, no duplicate full hash) → expand shows message + files",
      async () => {
        const headFull = gitOut(["rev-parse", "HEAD"]);
        const head8 = headFull.slice(0, 8);
        const committerEmail = gitOut(["show", "-s", "--format=%ce", "HEAD"]);
        // A recent commit that actually changed files, for the expand assertion.
        const headFile = gitOut([
          "show",
          "--name-only",
          "--format=",
          "HEAD",
        ])
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)[0];

        const tugbankPath = mkTempTugbank();
        try {
          seedTugbankForLaunch(tugbankPath, { sourceTreePath: REPO });
          const app = await launchTugApp({
            testName: "at0239-session-history-view",
            env: { TUGBANK_PATH: tugbankPath },
            persistInTestMode: true,
          });
          try {
            await app.waitForCondition<boolean>(
              `typeof window.__tug !== "undefined"`,
              { timeoutMs: 5_000 },
            );

            await app.seedDeckState({
              state: {
                cards: [
                  { id: "D", componentId: "session", title: "Session", closable: true },
                ],
                panes: [
                  {
                    id: "pD",
                    position: { x: 40, y: 40 },
                    size: { width: 720, height: 560 },
                    cardIds: ["D"],
                    activeCardId: "D",
                    title: "",
                    acceptsFamilies: ["maker"],
                  },
                ],
                activePaneId: "pD",
                hasFocus: true,
              },
              focusCardId: "D",
            });
            await app.waitForCondition<boolean>(
              `window.__tug.assertHostRootRegistered("D")`,
              { timeoutMs: 5_000 },
            );

            await app.bindSession("D", { projectDir: REPO });

            // Open the History shade and wait for the commit rows to render.
            await app.dispatchControlAction("toggle-history-view");
            await app.waitForCondition<boolean>(
              `document.querySelectorAll(${JSON.stringify(ROW)}).length > 0`,
              { timeoutMs: 6_000 },
            );

            // History is a plain sheet: it carries its own Done button in the
            // lower right (the shade's seeded default), and the old header X is
            // gone.
            const doneLabel = await app.evalJS<string>(
              `(function(){
                var b = document.querySelector('[data-testid="session-history-done"]');
                return b ? b.textContent.trim() : "";
              })()`,
            );
            expect(doneLabel).toBe("Done");
            const hasCloseX = await app.evalJS<boolean>(
              `document.querySelector('[data-testid="session-history-header"] [aria-label="Close"]') !== null`,
            );
            expect(hasCloseX).toBe(false);

            // Done wears the shade's one ring, and wears it as the shade's key
            // view — not as a persistent default beneath a key view elsewhere.
            // The commit list used to hold the key view and the engine stamped
            // `data-default-ring` on Done underneath it, which painted two
            // rings at once; the list left the walk and Done is now both marks
            // in one ([#shade-focus], at0399).
            const ring = await app.evalJS<{ keyView: boolean; outline: boolean }>(
              `(function(){
                var b = document.querySelector('[data-testid="session-history-done"]');
                if (!b) return { keyView: false, outline: false };
                var cs = getComputedStyle(b);
                var w = parseFloat(cs.outlineWidth) || 0;
                return {
                  keyView: b.hasAttribute("data-key-view-kbd"),
                  outline: cs.outlineStyle !== "none" && w > 0,
                };
              })()`,
            );
            expect(ring.keyView).toBe(true);
            expect(ring.outline).toBe(true);

            // ...and Done is the ONLY default button on screen. The shade's
            // modal carve-out keeps the prompt entry live beneath its bottom
            // edge, so a click into the composer restores the entry shell's
            // `data-entry-keyboard` — which used to light the Z5 submit as a
            // second filled + ringed default right below Done. The card's
            // `data-shade-open="history"` stands that promotion down: THIS
            // shade owns the default while it is open ([P17]). Named, not a
            // bare boolean — Changes has no Done and keeps the composer's
            // default, so the stand-down is History's alone.
            await app.nativeClickAtElement(
              '[data-card-id="D"] .tug-prompt-entry .cm-content',
            );
            await app.waitForCondition<boolean>(
              `(function(){
                var s = document.querySelector('[data-card-id="D"] .tug-entry-shell');
                return s !== null && s.hasAttribute("data-entry-keyboard");
              })()`,
              { timeoutMs: 3_000 },
            );
            const standDown = await app.evalJS<{
              shadeOpen: boolean;
              submitOutline: boolean;
              doneRing: boolean;
            }>(
              `(function(){
                var card = document.querySelector('[data-card-id="D"] .session-card');
                var submit = document.querySelector('[data-card-id="D"] .tug-prompt-entry-submit-button');
                var done = document.querySelector('[data-testid="session-history-done"]');
                var cs = submit ? getComputedStyle(submit) : null;
                var w = cs ? (parseFloat(cs.outlineWidth) || 0) : 0;
                return {
                  shadeOpen: card !== null && card.getAttribute("data-shade-open") === "history",
                  submitOutline: cs !== null && cs.outlineStyle !== "none" && w > 0,
                  doneRing:
                    done !== null &&
                    (function(){
                      var dcs = getComputedStyle(done);
                      return dcs.outlineStyle !== "none" && (parseFloat(dcs.outlineWidth) || 0) > 0;
                    })(),
                };
              })()`,
            );
            expect(standDown.shadeOpen).toBe(true);
            // The caret is in the composer, yet its submit wears no ring.
            expect(standDown.submitOutline).toBe(false);
            // Done still holds the one ring on screen.
            expect(standDown.doneRing).toBe(true);

            // The plain-sheet History has no resize grabber.
            const hasGrabber = await app.evalJS<boolean>(
              `document.querySelector('[data-card-id="D"] .tug-sheet-shade-grabber') !== null`,
            );
            expect(hasGrabber).toBe(false);

            // The top row leads with the commit atom: the read-only skin,
            // labelled `commit:<8-char sha>` (the lifecycle dot is gone; the
            // leading slot is collapsed away). The word is part of the label
            // because an atom stands with no sentence around it — and it is
            // the same string right-click → Copy writes, so what the eye reads
            // and what the clipboard gets cannot disagree.
            const topShaText = await app.evalJS<string>(
              `(function(){
                var row = document.querySelector(${JSON.stringify(ROW)});
                var sha = row.querySelector('.commit-sha-text');
                return sha ? sha.textContent.trim() : "";
              })()`,
            );
            expect(topShaText).toBe(`commit:${head8}`);

            // The old duplicated full-40-char hash <pre> is gone: no row's
            // collapsed content shows the full sha.
            const hasFullHashPre = await app.evalJS<boolean>(
              `(function(){
                return document.body.textContent.indexOf(${JSON.stringify(headFull)}) >= 0;
              })()`,
            );
            expect(hasFullHashPre).toBe(false);

            // Expand the top commit via the real fold cue.
            await app.evalJS<void>(
              `document.querySelector(${JSON.stringify(
                `${ROW} [data-slot="tug-history-list-fold"]`,
              )}).click()`,
            );

            // The expanded area names the committer (identity + email).
            await app.waitForCondition<boolean>(
              `(function(){
                var meta = document.querySelector(${JSON.stringify(
                  `${ROW} .tug-history-list-commit-meta`,
                )});
                return meta !== null && meta.textContent.indexOf(${JSON.stringify(committerEmail)}) >= 0;
              })()`,
              { timeoutMs: 6_000 },
            );

            // The commit's changed files render as a TugChangesList — wait for
            // the new GIT_COMMIT_FILES response to land.
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(
                `${ROW} [data-slot="tug-commit-changes-list"] [data-testid="tug-changes-list-file-block"]`,
              )}) !== null`,
              { timeoutMs: 6_000 },
            );
            const filePaths = await app.evalJS<string[]>(
              `(function(){
                var blocks = document.querySelectorAll(${JSON.stringify(
                  `${ROW} [data-testid="tug-changes-list-file-block"]`,
                )});
                return Array.prototype.map.call(blocks, function(b){
                  return b.getAttribute("data-path");
                });
              })()`,
            );
            expect(filePaths).toContain(headFile);

            // Every row's status letter is the SHARED mark — one element, the
            // house N/M/D vocabulary ([D118]), the same one the commit hover's
            // roster renders. The hover used to paint its own A/M/D/R in its
            // own tones two inches from these rows; this is the assertion that
            // there is only one alphabet left to drift.
            const marks = await app.evalJS<string[]>(
              `(function(){
                var els = document.querySelectorAll(${JSON.stringify(
                  `${ROW} [data-slot="tug-commit-changes-list"] .tug-status-mark`,
                )});
                return Array.prototype.map.call(els, function(el){
                  return el.getAttribute("data-mark") + ":" + (el.textContent || "").trim();
                });
              })()`,
            );
            expect(marks.length, "each changed file leads with a mark").toBe(
              filePaths.length,
            );
            for (const mark of marks) {
              // The attribute and the glyph are the same letter — the letter IS
              // the rendering, so a mismatch would mean two sources of truth.
              expect(mark).toMatch(/^([NMD]):\1$/);
            }

            const shot = await app.screenshot();
            console.log(`SCREENSHOT: ${shot.path}`);

            // Return keeps Done's promise from BOTH of the shade's keyboard
            // seats. `TugFilterField` used to swallow Enter unconditionally and
            // hand it to a `filterFieldDidSubmit` no consumer declares, so a
            // Return in the filter went nowhere while Done sat there ringed.
            // With no submit of its own the field now defers to the surface's
            // pane-scoped default button, the same contract `TugTextEditor`
            // keeps.
            await app.nativeClickAtElement(
              '[data-card-id="D"] [data-testid="session-history-filter"] input',
            );
            await app.waitForCondition<boolean>(
              `document.activeElement !== null && document.activeElement.tagName === "INPUT"`,
              { timeoutMs: 3_000 },
            );
            await app.nativeKey("Return");
            await app.waitForCondition<boolean>(
              `document.querySelector('[data-testid="session-history-done"]') === null`,
              { timeoutMs: 4_000 },
            );

            // ...and from the commit list, the shade's seeded key view. Reopen
            // and press Return without touching the filter.
            await app.dispatchControlAction("toggle-history-view");
            await app.waitForCondition<boolean>(
              `document.querySelectorAll(${JSON.stringify(ROW)}).length > 0`,
              { timeoutMs: 6_000 },
            );
            await app.nativeKey("Return");
            await app.waitForCondition<boolean>(
              `document.querySelector('[data-testid="session-history-done"]') === null`,
              { timeoutMs: 4_000 },
            );
          } finally {
            await app.close();
          }
        } finally {
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
