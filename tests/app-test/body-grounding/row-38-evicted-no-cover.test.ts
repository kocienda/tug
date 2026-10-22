/**
 * row-38-evicted-no-cover.test.ts — a card evicted without a cover comes back
 * under its stand-in, never the canvas.
 *
 * A Session card is hidden by parking its workspace, and critical memory
 * pressure evicts it: critical takes no snapshot, so the card keeps no
 * cover, as one whose snapshot failed or did not answer by its deadline
 * keeps none (that deadline is `AnswerOrDeadline`'s, a Swift unit test with
 * a hand-run clock). Shown again, the card has no last frame to stand under, so the host
 * says nothing of a cover and the shell does not show the card from its
 * hand-off: its stand-in stands until the new page paints, as for any
 * arrival. Every composited frame from the reveal on is read by row 44's
 * judge (`_row-44.ts`'s `readSwitch`): the pane's box shows no more of the
 * canvas than it does settled, its title band holds the settled title, the
 * host's hand-over at the switch landed, and no face stands once the page
 * has painted.
 *
 * @family row-38
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/lib/body-cards-store.ts
 * @covers tugdeck/src/lib/card-placement.ts
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { bodyOf, pollFor, settleFor, sessionPane } from "./_bodies";
import { readSwitch } from "./_row-44";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const A = "r38n-a";
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: A, componentId: "session", title: "A", closable: true }],
    panes: [sessionPane(A, 0)],
    activePaneId: `${A}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The shell's placeholder for `cardId`, in viewport points, or null while it has no box. */
const placeholderRect = (app: App, cardId: string): Promise<Rect | null> =>
  // card-dom: shell — the placeholder is the shell's.
  app.evalJS<Rect | null>(
    `(function () {
      var el = document.querySelector('[data-body-placeholder][data-card-id="${cardId}"]');
      if (el === null) return null;
      var r = el.getBoundingClientRect();
      return r.width > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    })()`,
  );

describe.skipIf(!SHOULD_RUN)("body-grounding row 38: an eviction with no cover", () => {
  test(
    "a card evicted with no cover comes back under its stand-in, never the canvas",
    async () => {
      const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-r38n-project-")));
      onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
      const app = await launchTugApp({ testName: "body-grounding-row-38-evicted-no-cover" });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        await pollFor(() => bodyOf(app, A), (b) => b?.state === "ready" && b.visible, 30_000);
        await app.spawnSessionNew(A, { tugSessionId: randomUUID(), projectDir });
        const rect = await settleFor(() => placeholderRect(app, A), (r) => r !== null, 5_000);
        expect(rect, "the pane's placeholder has a box").not.toBeNull();

        // ---- Parked; critical pressure evicts it, keeping no cover ----
        const home = await app.evalJS<string>(ACTIVE_SPACE);
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("new-space"), null)`);
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id !== home, 5_000);
        await pollFor(() => bodyOf(app, A), (b) => b?.shown === false, 5_000);
        await app.simulateMemoryPressure("critical");
        const gone = await settleFor(() => app.bodies(), (all) => !all.some((b) => b.cardId === A), 6_000);
        expect(gone.some((b) => b.cardId === A), "critical pressure evicted the hidden card").toBe(false);
        await app.simulateMemoryPressure("normal");

        // ---- Shown again: no cover, so the stand-in stands until the page paints ----
        // The host's word on the body, as fast as it answers, from the switch
        // until the page has painted: it is never shown before.
        let watching = true;
        let shownBeforePaint = false;
        const watch = (async () => {
          while (watching) {
            const b = await bodyOf(app, A);
            if (b?.visible === true && !b.painted) shownBeforePaint = true;
            if (b?.visible === true && b.painted) return;
          }
        })();
        const bad = await readSwitch(app, home, [A], "row-38-evicted-no-cover");
        watching = false;
        await watch;
        const back = await bodyOf(app, A);
        expect(back?.wasCovered, "the host kept no last frame, so the new body stood under no cover").toBe(false);
        expect(shownBeforePaint, "the host showed the new body only once it had painted").toBe(false);
        expect(back, "the card's new body is ready, painted and shown").toMatchObject({ state: "ready", painted: true, visible: true, covered: false });
        expect(bad, "no frame from the reveal shows more canvas than the settled pane or loses its title, and the hand-over landed").toEqual([]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
