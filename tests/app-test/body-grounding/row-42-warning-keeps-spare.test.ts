/**
 * row-42-warning-keeps-spare.test.ts — a memory-pressure warning takes a
 * hidden card's body and keeps the warm spare.
 *
 * The app launches on two workspaces: a Session card's, shown first, and a
 * Layout card's, shown next, which parks the Session card's and leaves its
 * body hidden. The host's stand-in for the dispatch source raises a warning
 * and clears it. The warning has a hidden body to take, and takes it — the
 * Session card's body leaves the host's list — while the warm spare stands
 * through it: a warning keeps the spare, which is what keeps the next arrival
 * warm, and critical alone takes it.
 *
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/body-shell.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "../_harness";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "../_harness/tugbank-helpers";
import { bodyOf, pollFor, settleFor, sessionPane } from "./_bodies";
import { standUpKind } from "./_kind-bodies";
import { cardKind, kindPane, kindSidebars } from "./_kinds";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const L = "r42-layout";
const A = "r42-a";
const SESSION_SPACE = "r42-session";
const LAYOUT_SPACE = "r42-layout-space";
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";
/** The spare's page, or null while there is none. */
const sparePage = async (app: App): Promise<number | null> => (await app.bodies()).find((b) => b.cardId === null)?.page ?? null;

/** The Session card's workspace, shown at launch, and the Layout card's, shown next. */
const LAYOUT = {
  version: 5,
  activeSpaceId: SESSION_SPACE,
  spaces: [
    {
      id: SESSION_SPACE,
      name: "Session",
      deck: {
        cards: [{ id: A, componentId: "session", title: "A", closable: true }],
        panes: [sessionPane(A, 0)],
        activePaneId: `${A}-pane`,
        imposition: { kind: "one-up", layout: "fit", sidebars: {} },
        hasFocus: true,
      },
    },
    {
      id: LAYOUT_SPACE,
      name: "Layout",
      deck: {
        cards: [{ id: L, componentId: "layout", title: "Layout", closable: true }],
        panes: [kindPane("layout", L, 0)],
        activePaneId: `${L}-pane`,
        imposition: { kind: "one-up", layout: "fit", sidebars: kindSidebars(["layout"]) },
        hasFocus: true,
      },
    },
  ],
};

describe.skipIf(!SHOULD_RUN)("body-grounding row 42: a warning keeps the spare", () => {
  test(
    "a warning takes the hidden body and keeps the spare",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(LAYOUT));
      const app = await launchTugApp({
        testName: "body-grounding-row-42-warning-keeps-spare",
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        // ---- The Session card's body stands, then the Layout workspace parks it ----
        await pollFor(() => bodyOf(app, A), (b) => b?.state === "ready" && b.visible, 30_000);
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(LAYOUT_SPACE)} }), null)`);
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id === LAYOUT_SPACE, 5_000);
        await standUpKind(app, cardKind("layout"), L);
        await pollFor(() => bodyOf(app, A), (b) => b?.shown === false, 5_000);

        const spareBefore = await settleFor(() => sparePage(app), (s) => s !== null, 10_000);
        expect(spareBefore, "the spare stands before the warning").not.toBeNull();
        await app.simulateMemoryPressure("warning");
        const taken = await settleFor(() => bodyOf(app, A), (b) => b === null, 10_000);
        expect(taken, "the warning took the hidden body").toBeNull();
        // The same page: a spare the warning took and the lane made again a
        // second later would stand in the list all the same.
        expect(await sparePage(app), "a warning keeps the spare, the same page").toBe(spareBefore);
        expect(await bodyOf(app, L), "and left the shown one").not.toBeNull();
        await app.simulateMemoryPressure("normal");
        expect(await sparePage(app), "the same spare stands after the warning clears").toBe(spareBefore);
        note("the warning took the parked Session card's body; the spare stood through it");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
