/**
 * row-42-bodies-row.test.ts — the Layout card says what the deck holds of
 * its bodies and the machine's last word on memory, and its Release row is
 * the door to `evictAfterMs`.
 *
 * The app launches on two workspaces: a Session card's, shown first, and a
 * Layout card's, shown next, which parks the Session card's and leaves its
 * body hidden. The Layout card's Bodies row reads the census the shell
 * publishes (`deck.bodies`): one card shown, one hidden. Its Pressure row
 * reads none since launch, then the level the host last heard as the host's
 * stand-in for the dispatch source raises a warning and clears it. The
 * warning has a hidden body to take, and takes it — the Bodies row reads it
 * evicted — while the warm spare stands through it: a warning keeps the
 * spare, which is what keeps the next arrival warm, and critical alone takes
 * it. The Release row stands at its default, fifteen minutes, and a press on
 * another delay is what it then shows.
 *
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/components/layout/layout-card.tsx
 * @covers tugdeck/src/lib/body-census.ts
 * @covers tugdeck/src/lib/body-shell.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "../_harness";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "../_harness/tugbank-helpers";
import { bodyOf, pollFor, sessionPane } from "./_bodies";
import { standUpKind } from "./_kind-bodies";
import { cardKind, kindPane, kindSidebars } from "./_kinds";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const L = "r42-layout";
const A = "r42-a";
const SESSION_SPACE = "r42-session";
const LAYOUT_SPACE = "r42-layout-space";
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";
const text = (testId: string): string =>
  `(document.querySelector('[data-testid="${testId}"]') || { textContent: null }).textContent`;
const ACTIVE_EVICT = `(document.querySelector('[data-testid="layout-card-evict"] [data-choice-value][data-state="active"]') || { getAttribute: function () { return null; } }).getAttribute("data-choice-value")`;
const hasSpare = async (app: App): Promise<boolean> => (await app.bodies()).some((b) => b.cardId === null);

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

describe.skipIf(!SHOULD_RUN)("body-grounding row 42: the Layout card's Bodies row", () => {
  test(
    "the Bodies and Pressure rows read the deck's bodies and the host's last pressure event, a warning takes a hidden body and keeps the spare, and Release sets evictAfterMs",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(LAYOUT));
      const app = await launchTugApp({
        testName: "body-grounding-row-42-bodies-row",
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        // ---- The Session card's body stands, then the Layout workspace parks it ----
        await pollFor(() => bodyOf(app, A), (b) => b?.state === "ready" && b.visible, 30_000);
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(LAYOUT_SPACE)} }), null)`);
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id === LAYOUT_SPACE, 5_000);
        const layout = await standUpKind(app, cardKind("layout"), L);
        await pollFor(() => bodyOf(app, A), (b) => b?.shown === false, 5_000);

        const bodies = await pollFor(() => layout.evalJS<string | null>(text("layout-card-bodies")), (t) => t === "1 shown · 1 hidden", 10_000);
        expect(bodies, "the Layout card shown, the parked Session card hidden").toBe("1 shown · 1 hidden");
        expect(await layout.evalJS<string | null>(text("layout-card-pressure")), "no pressure since launch").toBe("none since launch");

        const spareBefore = await pollFor(() => hasSpare(app), (s) => s, 10_000);
        expect(spareBefore, "the spare stands before the warning").toBe(true);
        await app.simulateMemoryPressure("warning");
        const warned = await pollFor(() => layout.evalJS<string | null>(text("layout-card-pressure")), (t) => t?.startsWith("warning at ") === true, 5_000);
        expect(warned, "the warning the host heard, with its time").toMatch(/^warning at /);
        expect(await hasSpare(app), "a warning keeps the spare").toBe(true);
        await app.simulateMemoryPressure("normal");
        const cleared = await pollFor(() => layout.evalJS<string | null>(text("layout-card-pressure")), (t) => t?.startsWith("normal at ") === true, 5_000);
        expect(cleared, "the level back to normal, with its time").toMatch(/^normal at /);
        const taken = await pollFor(() => layout.evalJS<string | null>(text("layout-card-bodies")), (t) => t === "1 shown · 1 evicted", 10_000);
        expect(taken, "the warning took the hidden body, and only it").toBe("1 shown · 1 evicted");
        expect(await hasSpare(app), "the spare stands after the warning clears").toBe(true);

        expect(await layout.evalJS<string | null>(ACTIVE_EVICT), "Release stands at fifteen minutes").toBe("900000");
        await layout.click('[data-testid="layout-card-evict"] [data-choice-value="300000"]');
        const chosen = await pollFor(() => layout.evalJS<string | null>(ACTIVE_EVICT), (v) => v === "300000", 5_000);
        expect(chosen, "a press on 5m is what Release then shows").toBe("300000");
        note(`bodies "${bodies}" then "${taken}"; pressure "${warned}" then "${cleared}"; the spare stood through the warning`);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
