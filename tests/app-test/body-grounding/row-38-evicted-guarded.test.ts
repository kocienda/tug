/**
 * row-38-evicted-guarded.test.ts — a card whose kind may veto its close keeps
 * that veto through every eviction: the clock and a warning leave its page
 * alone, and after critical pressure takes it, closing the card still asks.
 *
 * Two Text cards in manual save mode share a pane, each on a real file. The
 * second takes an unsaved edit, then the first tab is chosen. Only the
 * card's own page can answer whether its close should ask, so:
 *
 * - With `evictAfterMs` shortened and the workspace parked, both pages stand
 *   hidden well past the delay, and through a warning: the clock and a
 *   warning never take a page that guards its close.
 * - Back home, critical pressure — which must be able to take every page not
 *   shown — takes the dirty sibling. Its page wrote its edits aside as it
 *   went.
 * - The pane's close then visits the evicted card: the shell kept the page's
 *   word that its guard asks, so the card is fronted, its page comes back,
 *   reads its edits back dirty, and its save sheet asks. Don't Save closes
 *   it, and the file on disk is untouched.
 *
 * @family row-38
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/lib/body-handoff.ts
 * @covers tugdeck/src/body/body-verbs.ts
 * @covers tugdeck/src/lib/text-card-store.ts
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { launchTugApp, note } from "../_harness";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch } from "../_harness/tugbank-helpers";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { bodyOf, pollFor, settleFor } from "./_bodies";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

const A = "r38g-a";
const B = "r38g-b";
/** The reader's delay before eviction, shortened from fifteen minutes for the row. */
const EVICT_AFTER_MS = 1_000;
const ORIGINAL_B = "other\n";
const EDIT = "UNSAVED ";
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";
const CLOSE_BUTTON = `[data-testid="tug-pane-close-button"]`;
const SAVE_LINE = `[data-testid="card-masthead-detail"]`;
const editorOf = (cardId: string): string => `[data-card-id="${cardId}"] [data-slot="tug-text-card-editor"] .cm-content`;

const settle = (ms = 450): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!SHOULD_RUN)("body-grounding row 38: a guarded card through eviction", () => {
  test(
    "the clock and a warning keep a dirty Text card's page, and after critical its close still asks",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tug-r38g-"));
      onTestRunEnd(() => fs.rmSync(dir, { recursive: true, force: true }));
      const fileA = path.join(dir, "a.txt");
      const fileB = path.join(dir, "b.txt");
      fs.writeFileSync(fileA, "alpha\n", "utf8");
      fs.writeFileSync(fileB, ORIGINAL_B, "utf8");
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const app = await launchTugApp({
        testName: "body-grounding-row-38-evicted-guarded",
        persistInTestMode: true,
        restoreInTestMode: true,
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        await app.seedDeckState({
          state: {
            cards: [
              { id: A, componentId: "text", title: "File", closable: true },
              { id: B, componentId: "text", title: "File", closable: true },
            ],
            panes: [
              {
                id: "r38g-pane",
                position: { x: 40, y: 40 },
                size: { width: 760, height: 560 },
                cardIds: [A, B],
                activeCardId: A,
                title: "",
                acceptsFamilies: ["standard"],
              },
            ],
            activePaneId: "r38g-pane",
            imposition: { kind: "one-up", layout: "fit", sidebars: {} },
            hasFocus: true,
          },
          cardStates: {
            [A]: { content: { path: fileA, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
            [B]: { content: { path: fileB, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
          },
          focusCardId: A,
        });
        await pollFor(() => bodyOf(app, A), (b) => b?.state === "ready" && b.visible, 30_000);

        // ---- The second card takes an unsaved edit, then stands behind the first ----
        await app.body(A).click(`[data-testid="tug-tab-${B}"]`);
        await app.body(B).waitForCondition<boolean>(
          `(function(){ var el = document.querySelector('${editorOf(B)}'); return el !== null && el.innerText.indexOf("other") !== -1; })()`,
          { timeoutMs: 15_000 },
        );
        await settle();
        const typed = await app.body(B).evalJS<boolean>(
          `(function(){ var el = document.querySelector('${editorOf(B)}'); if (!el) return false; el.focus(); return document.execCommand("insertText", false, ${JSON.stringify(EDIT)}); })()`,
        );
        expect(typed, "the edit went into the second card's editor").toBe(true);
        await app.body(B).waitForCondition<boolean>(
          `(function(){ var el = document.querySelector('${SAVE_LINE}'); return el !== null && el.innerText.indexOf("Edited") === 0; })()`,
          { timeoutMs: 15_000 },
        );
        await app.body(B).click(`[data-testid="tug-tab-${A}"]`);
        await pollFor(() => bodyOf(app, B), (b) => b !== null && !b.visible, 5_000);

        // ---- Hidden past the clock, and through a warning: both pages stand ----
        await app.bodyDelays({ evictAfterMs: EVICT_AFTER_MS });
        const home = await app.evalJS<string>(ACTIVE_SPACE);
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("new-space"), null)`);
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id !== home, 5_000);
        const hidden = await settleFor(
          async () => [await bodyOf(app, A), await bodyOf(app, B)],
          (bs) => bs.every((b) => b?.shown === false),
          5_000,
        );
        expect(hidden.map((b) => b?.shown), "the parked workspace's pages are hidden").toEqual([false, false]);
        // The clock falls due a delay after the hiding; a clock that took the
        // page would have done so well inside twice that.
        await settle(EVICT_AFTER_MS * 2);
        const afterClock = await app.bodies();
        expect(afterClock.some((b) => b.cardId === A), "the clock passed over the clean Text card's page").toBe(true);
        expect(afterClock.some((b) => b.cardId === B), "the clock passed over the dirty Text card's page").toBe(true);

        await app.simulateMemoryPressure("warning");
        await settle(750);
        const afterWarning = await app.bodies();
        await app.simulateMemoryPressure("normal");
        expect(afterWarning.some((b) => b.cardId === A), "a warning passed over the clean Text card's page").toBe(true);
        expect(afterWarning.some((b) => b.cardId === B), "a warning passed over the dirty Text card's page").toBe(true);

        // ---- Home again; critical takes the dirty sibling ----
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(home)} }), null)`);
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id === home, 5_000);
        await pollFor(() => bodyOf(app, A), (b) => b?.state === "ready" && b.visible, 10_000);
        await app.simulateMemoryPressure("critical");
        const gone = await settleFor(() => app.bodies(), (all) => !all.some((b) => b.cardId === B), 5_000);
        await app.simulateMemoryPressure("normal");
        expect(gone.some((b) => b.cardId === B), "critical pressure took the dirty sibling's page").toBe(false);
        expect((await bodyOf(app, A))?.visible, "the shown card keeps its page").toBe(true);

        // ---- The pane's close visits the evicted card, and its sheet asks ----
        const closedAt = performance.now();
        await app.body(A).nativeClickAtElement(CLOSE_BUTTON);
        const back = await settleFor(() => bodyOf(app, B), (b) => b?.state === "ready" && b.visible, 15_000);
        expect(back, "the evicted card was fronted and its page brought back").toMatchObject({ state: "ready", visible: true });
        await app.body(B).waitForCondition<boolean>(
          `document.querySelector('[data-testid="file-save-sheet-dont-save"]') !== null`,
          { timeoutMs: 15_000 },
        );
        note(`close → the evicted card's save sheet: ${Math.round(performance.now() - closedAt)} ms`);
        expect(
          await app.body(B).evalJS<string>(`document.querySelector('${SAVE_LINE}').innerText`),
          "the card's page read its set-aside edits back dirty",
        ).toStartWith("Edited");
        expect(
          await app.body(B).evalJS<boolean>(`(document.querySelector('${editorOf(B)}') || { innerText: "" }).innerText.indexOf(${JSON.stringify(EDIT.trim())}) !== -1`),
          "the edit is in the editor the sheet asks over",
        ).toBe(true);
        await settle();
        await app.body(B).click(`[data-testid="file-save-sheet-dont-save"]`);
        await pollFor(() => app.bodies(), (all) => !all.some((b) => b.cardId === B), 15_000);
        expect(fs.readFileSync(fileB, "utf8"), "Don't Save left the file as it was").toBe(ORIGINAL_B);
      } finally {
        await app.simulateMemoryPressure("normal").catch(() => undefined);
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
