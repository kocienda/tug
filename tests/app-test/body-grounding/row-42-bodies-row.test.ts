/**
 * row-42-bodies-row.test.ts — the Layout card says what the deck holds of
 * its bodies and the machine's last word on memory, and its Release row is
 * the door to `evictAfterMs`.
 *
 * A Layout card stands beside a Session card. Its Bodies row reads the
 * census the shell publishes (`deck.bodies`): both cards shown. Its Pressure
 * row reads none since launch, then the level the host last heard as the
 * host's stand-in for the dispatch source raises a warning and clears it.
 * Readings only: a warning that takes nothing (every body is shown) moves
 * the line and nothing else, and the warm spare stands through it — a
 * warning keeps the spare, which is what keeps the next arrival warm, and
 * critical alone takes it. The Release row stands at its default, fifteen
 * minutes, and a press on another delay is what it then shows.
 *
 * @foreground activation
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/components/layout/layout-card.tsx
 * @covers tugdeck/src/lib/body-census.ts
 * @covers tugdeck/src/lib/body-shell.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "../_harness";
import { pollFor } from "./_bodies";
import { kindDeck, standUpKind } from "./_kind-bodies";
import { cardKind } from "./_kinds";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const L = "r42-layout";
const A = "r42-a";
const text = (testId: string): string =>
  `(document.querySelector('[data-testid="${testId}"]') || { textContent: null }).textContent`;
const ACTIVE_EVICT = `(document.querySelector('[data-testid="layout-card-evict"] [data-choice-value][data-state="active"]') || { getAttribute: function () { return null; } }).getAttribute("data-choice-value")`;
const hasSpare = async (app: App): Promise<boolean> => (await app.bodies()).some((b) => b.cardId === null);

describe.skipIf(!SHOULD_RUN)("body-grounding row 42: the Layout card's Bodies row", () => {
  test(
    "the Bodies and Pressure rows read the deck's bodies and the host's last pressure event, a warning keeps the spare, and Release sets evictAfterMs",
    async () => {
      const app = await launchTugApp({ testName: "body-grounding-row-42-bodies-row", foreground: true });
      try {
        const kind = cardKind("layout");
        await app.seedDeckState({ state: kindDeck(kind, L, { sessions: [A] }), focusCardId: L });
        const layout = await standUpKind(app, kind, L);

        const bodies = await pollFor(() => layout.evalJS<string | null>(text("layout-card-bodies")), (t) => t === "2 shown", 10_000);
        expect(bodies, "both cards read shown").toBe("2 shown");
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
        expect(await layout.evalJS<string | null>(text("layout-card-bodies")), "a warning with nothing hidden takes nothing").toBe("2 shown");
        expect(await hasSpare(app), "the spare stands after the warning clears").toBe(true);

        expect(await layout.evalJS<string | null>(ACTIVE_EVICT), "Release stands at fifteen minutes").toBe("900000");
        await layout.click('[data-testid="layout-card-evict"] [data-choice-value="300000"]');
        const chosen = await pollFor(() => layout.evalJS<string | null>(ACTIVE_EVICT), (v) => v === "300000", 5_000);
        expect(chosen, "a press on 5m is what Release then shows").toBe("300000");
        note(`bodies "${bodies}"; pressure "${warned}" then "${cleared}"; the spare stood through the warning`);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
