/**
 * at0432-commit-row-menu.test.ts — a History commit row answers a right-click
 * ANYWHERE on it with the commit's own acts, and a mark that wraps under the
 * subject starts the line the subject starts.
 *
 * ## What this gates
 *
 * A commit row shows a hash, a subject, and a stamp, and the only press that
 * used to mean anything was the one landing on the eight characters of the sha
 * — which opened a single-item Copy of those same eight characters. Every other
 * pixel fell through to the app's "No Actions", and the facts a reader actually
 * wants out of a commit (the FULL hash, the message, the paths it touched) were
 * reachable from no menu at all.
 *
 * So the press under test lands on the row's ground, and what has to come back
 * is the whole commit menu — the fold, the five copies, the roster — with the
 * roster live on a commit that changed files. The hash is then taken all the way
 * to the pasteboard through the real gesture, since a menu that lists a copy and
 * a copy that happens are two different facts. And the sha atom is pressed too:
 * under this host it must answer with the SAME menu rather than its own lone
 * Copy, so a reader is not punished for aiming at the hash.
 *
 * The second test is about alignment. The join badge and the session atom ride
 * the subject's own inline flow, so a long subject wraps them onto the hanging
 * indent — and a left margin is drawn again at the head of that wrapped line,
 * setting the mark in from the very column the subject's own wrapped lines start
 * at. The gap is a space in the flow instead, which a line break drops; the mark
 * therefore begins its line flush with the text above it.
 *
 * Driven against a real repo — this worktree, which tugcast registers as its
 * bootstrap `--source-tree` (at0239's rationale: a synthetic temp repo hangs the
 * app's boot). The pane is deliberately narrow so subjects wrap.
 *
 * @covers tugdeck/src/components/tugways/commit-identity-menu.tsx
 * @covers tugdeck/src/components/tugways/tug-history-list.tsx
 * @covers tugdeck/src/components/tugways/tug-history-list.css
 * @covers tugdeck/src/components/tugways/commit-sha-text.tsx
 * @covers tugdeck/src/components/tugways/commit-presentation.tsx
 * @covers tugdeck/src/components/tugways/action-vocabulary.ts
 * @covers tugdeck/src/components/tugways/tug-editor-context-menu.tsx
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** The worktree root — the real repo tugcast serves as its bootstrap tree. */
const REPO = resolve(import.meta.dir, "..", "..");

const VIEW = `[data-slot="session-history-view"]`;
const ROW = `${VIEW} [data-testid="session-history-commit"]`;
const MENU = '[data-slot="tug-editor-context-menu"]';
/** Distinguishes "the copy wrote this" from "the copy never happened". */
const SENTINEL = "at0432-sentinel-nothing-copied";

function setPasteboard(text: string): void {
  Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(text) });
}

function readPasteboard(): string {
  return Bun.spawnSync(["pbpaste"]).stdout.toString();
}

/** Every row of the open menu, in the order it renders. */
function menuRows(): string {
  return `Array.prototype.map.call(
     document.querySelectorAll(${JSON.stringify(MENU)} + ' [role="menuitem"]'),
     function (item) {
       return {
         action: item.getAttribute("data-item-action") || "",
         label: (item.querySelector(".tug-menu-item-label") || item).textContent || "",
         disabled: item.getAttribute("aria-disabled") === "true",
       };
     })`;
}

/** A narrow pane, so subjects wrap and the marks after them land on a new line. */
function deckShape() {
  return {
    cards: [{ id: "H", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "pH",
        position: { x: 40, y: 40 },
        size: { width: 620, height: 620 },
        cardIds: ["H"],
        activeCardId: "H",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "pH",
    hasFocus: true,
  };
}

/** Bring the shade up on this repo's real log and wait for its rows. */
async function openHistory(app: App): Promise<void> {
  await app.waitForCondition<boolean>(`typeof window.__tug !== "undefined"`, {
    timeoutMs: 15_000,
  });
  await app.seedDeckState({ state: deckShape(), focusCardId: "H" });
  await app.waitForCondition<boolean>(
    `window.__tug.assertHostRootRegistered("H")`,
    { timeoutMs: 10_000 },
  );
  await app.bindSession("H", { projectDir: REPO });
  await app.dispatchControlAction("toggle-history-view");
  await app.waitForCondition<boolean>(
    `document.querySelectorAll(${JSON.stringify(ROW)}).length > 0`,
    { timeoutMs: 15_000 },
  );
}

describe.skipIf(!SHOULD_RUN)("at0432 — the commit row's own menu", () => {
  test(
    "the row's ground and the sha both answer with the commit menu, and the hash reaches the pasteboard",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath, { sourceTreePath: REPO });
        const app = await launchTugApp({
          testName: "at0432-commit-row-menu",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await openHistory(app);

          // The row under test: the newest commit, and the sha it says it is.
          const sha = await app.evalJS<string>(
            `document.querySelector(${JSON.stringify(ROW)}).getAttribute("data-sha")`,
          );
          expect(sha).toMatch(/^[0-9a-f]{40}$/);

          // ---- The row's ground answers. ----------------------------------
          await app.nativeRightClickAtElement(
            `${ROW} .tugx-commit-stamp`,
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(MENU)}) !== null`,
            { timeoutMs: 8_000 },
          );
          // And nothing else answered the same press.
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll('.tug-menu-content').length`,
            ),
          ).toBe(1);

          const rows = await app.evalJS<
            ReadonlyArray<{ action: string; label: string; disabled: boolean }>
          >(menuRows());
          note("at0432 menu", JSON.stringify(rows));
          expect(rows.map((r) => r.action)).toEqual([
            "toggle-commit-detail",
            // A commit's primary act is its own card, so the open group leads
            // the copies. The row still offers NO Open Diff: its diff is the
            // shade beneath it, and every file in its roster carries a
            // pop-out.
            "open-commit",
            "copy-commit-short-hash",
            "copy-commit-hash",
            "copy-commit-header",
            "copy-commit-record",
            "copy-annotation-atom",
          ]);
          // The fold item SAYS which way it goes — the row is collapsed.
          expect(rows[0].label).toBe("Show Detail");
          // Every item is a copy of a fact the record always holds, so every
          // one is live.
          expect(rows.every((r) => !r.disabled)).toBe(true);

          // ---- …and the item carries the full hash to the pasteboard. -----
          setPasteboard(SENTINEL);
          await app.nativeClickAtElement(
            `${MENU} [data-item-action="copy-commit-hash"]`,
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(MENU)}) === null`,
            { timeoutMs: 8_000 },
          );
          // The write lands asynchronously — the handler runs inside the item's
          // mousedown and the clipboard promise settles after it, so the read is
          // polled rather than taken once.
          let pasted = readPasteboard();
          for (let tries = 0; tries < 20 && pasted !== sha; tries += 1) {
            await new Promise((r) => setTimeout(r, 200));
            pasted = readPasteboard();
          }
          expect(pasted).toBe(sha);
          // The row did not fold under its own menu — the press was a right
          // button, and only the primary button is the fold's.
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(ROW)}).hasAttribute("data-expanded")`,
            ),
          ).toBe(false);

          // ---- The sha atom answers with the same menu. -------------------
          //
          // Not its own single-item Copy: under a host that claims the whole
          // commit, the atom stands its menu down and the press rides up.
          await app.nativeRightClickAtElement(`${ROW} .commit-sha-text`);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(MENU)}) !== null`,
            { timeoutMs: 8_000 },
          );
          const onSha = await app.evalJS<
            ReadonlyArray<{ action: string; label: string; disabled: boolean }>
          >(menuRows());
          expect(onSha.map((r) => r.action)).toEqual(rows.map((r) => r.action));

          // ---- Short Hash writes the reference, not the bare characters. --
          //
          // `commit:<8>` is what the atom itself says and what the app writes
          // a commit as everywhere else, so it is what the item hands over.
          setPasteboard(SENTINEL);
          await app.nativeClickAtElement(
            `${MENU} [data-item-action="copy-commit-short-hash"]`,
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(MENU)}) === null`,
            { timeoutMs: 8_000 },
          );
          const shortRef = `commit:${sha.slice(0, 8)}`;
          let shortPaste = readPasteboard();
          for (let tries = 0; tries < 20 && shortPaste !== shortRef; tries += 1) {
            await new Promise((r) => setTimeout(r, 200));
            shortPaste = readPasteboard();
          }
          expect(shortPaste).toBe(shortRef);
        } finally {
          await app.close();
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a session atom wrapped under the subject starts the subject's own column",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath, { sourceTreePath: REPO });
        const app = await launchTugApp({
          testName: "at0432-commit-row-menu-alignment",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await openHistory(app);

          // Every chip that BEGINS a line — one sitting beside text is aligned
          // by the space before it and has nothing to say here. "Begins a line"
          // is measured, not assumed: the range from the identity's start to the
          // chip is asked for its last rect, and the chip starts a line exactly
          // when that rect is on a line above it.
          const wrapped = await app.evalJS<
            ReadonlyArray<{ sha: string; delta: number }>
          >(
            `(function(){
               var out = [];
               var rows = document.querySelectorAll(${JSON.stringify(ROW)});
               for (var i = 0; i < rows.length; i += 1) {
                 var row = rows[i];
                 var identity = row.querySelector('.tugx-commit-identity');
                 var chip = row.querySelector('.tug-history-list-session-chip');
                 if (identity === null || chip === null) continue;
                 var ir = identity.getBoundingClientRect();
                 var cr = chip.getBoundingClientRect();
                 var before = document.createRange();
                 before.setStart(identity, 0);
                 before.setEndBefore(chip);
                 var boxes = before.getClientRects();
                 if (boxes.length === 0) continue;
                 var last = boxes[boxes.length - 1];
                 // Same line ⇒ the chip follows text and is not the case under
                 // test. Centres, because the chip's pill is taller than the
                 // line box it rides.
                 var lastMid = (last.top + last.bottom) / 2;
                 var chipMid = (cr.top + cr.bottom) / 2;
                 if (Math.abs(lastMid - chipMid) < 6) continue;
                 var hang = parseFloat(getComputedStyle(identity).paddingLeft) || 0;
                 out.push({
                   sha: row.getAttribute("data-sha") || "",
                   delta: cr.left - (ir.left + hang),
                 });
               }
               return out;
             })()`,
          );
          note(
            "at0432 line-leading chips",
            `${wrapped.length}: ${JSON.stringify(wrapped.slice(0, 5))}`,
          );
          // The narrow pane guarantees wrapping; a run with none would be
          // measuring nothing and must not read as a pass.
          expect(wrapped.length).toBeGreaterThan(0);
          // The chip's own box starts the hanging-indent column — the same
          // column the subject's wrapped lines start at. A left margin used to
          // put it 8px right of it.
          for (const entry of wrapped) {
            expect(Math.abs(entry.delta)).toBeLessThanOrEqual(1);
          }
        } finally {
          await app.close();
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
