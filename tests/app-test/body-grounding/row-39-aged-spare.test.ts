/**
 * row-39-aged-spare.test.ts — a spare older than the eviction delay is not
 * evicted when a card takes it.
 *
 * A new card is placed hidden until its page paints (`bodyVisible` wants
 * `painted`), so between ready and its first paint it is a hidden card's body
 * and the clock arms for it. The clock counts from when the body was last
 * named hidden — and the spare a new card takes has been named hidden by
 * every placement since it was made. Carried over, that `since` made a spare
 * older than the delay fall due at the card's ready: the warm page evicted
 * before it could paint, the card reloaded cold, and a Run in New Session's
 * opening command, already drained into the evicted page, lost with it. On
 * the user's deck, with the fifteen-minute delay, that was every Run in New
 * Session made more than fifteen minutes after the last card opened.
 *
 * Here the delay is shortened, the spare stands, a placement lands over it
 * (a fold and an unfold of the card beside it) and the spare is left to age
 * past the delay. A new card then takes it: it is ready, painted and shown on
 * the very page the spare was, warm, never torn down and made again.
 *
 * @family row-39
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/BodyLifecycle.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "../_harness";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch } from "../_harness/tugbank-helpers";
import { bodyOf, pollFor, settleFor, sessionPane } from "./_bodies";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const A = "r39s-a";
/** The eviction delay, shortened from two hours. */
const EVICT_AFTER_MS = 2_000;
/** How far past the delay the spare is left to age before a card takes it. */
const AGE_PAST_MS = 1_000;

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: A, componentId: "session", title: "A", closable: true }],
    panes: [sessionPane(A, 0)],
    activePaneId: `${A}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

function fold(cardId: string, folded: boolean): string {
  return `(window.tugdeck.lab.dispatch("set-card-folded", { cardId: ${JSON.stringify(cardId)}, folded: ${folded} }), null)`;
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 39: an aged spare", () => {
  test(
    "a card that takes a spare older than evictAfterMs keeps its warm page",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const app = await launchTugApp({
        testName: "body-grounding-row-39-aged-spare",
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        await pollFor(() => bodyOf(app, A), (b) => b?.state === "ready" && b.visible, 30_000);
        await app.bodyDelays({ evictAfterMs: EVICT_AFTER_MS });

        // ---- The spare stands, and a placement names it hidden ----
        const standing = await settleFor(
          () => app.bodies(),
          (all) => all.some((b) => b.cardId === null && b.state === "connected"),
          10_000,
        );
        const sparePage = standing.find((b) => b.cardId === null && b.state === "connected")?.page;
        expect(sparePage, "a warm spare stands").toBeDefined();
        await app.evalJS<null>(fold(A, true));
        await app.evalJS<null>(fold(A, false));
        await pollFor(() => bodyOf(app, A), (b) => b?.state === "ready" && b.visible, 5_000);

        // ---- It ages past the delay ----
        await Bun.sleep(EVICT_AFTER_MS + AGE_PAST_MS);
        const aged = await app.bodies();
        note(`before the take: ${aged.map((b) => `${b.cardId ?? "spare"}:${b.page}:${b.state}:shown=${b.shown}:due=${b.evictDue}`).join(" ")}`);
        expect(aged.find((b) => b.cardId === null)?.page, "the same spare is still standing").toBe(sparePage);

        // ---- A new card takes it, and keeps it ----
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("show-card", { component: "session" }), null)`);
        const pages = new Set<number>();
        const timeline: string[] = [];
        const t0 = performance.now();
        const shown = await settleFor(
          async () => {
            const all = await app.bodies();
            const fresh = all.find((b) => b.cardId !== null && b.cardId !== A) ?? null;
            if (fresh !== null) pages.add(fresh.page);
            const row = all
              .map((b) => `${b.cardId === null ? "spare" : b.cardId === A ? "A" : "new"}:${b.page}:${b.state}${b.painted ? "+p" : ""}${b.visible ? "+v" : ""}${b.evictDue ? "+due" : ""}`)
              .join(" ");
            if (timeline[timeline.length - 1]?.endsWith(row) !== true) timeline.push(`${Math.round(performance.now() - t0)}ms ${row}`);
            return fresh;
          },
          (b) => b?.state === "ready" && b.painted && b.visible,
          10_000,
        );
        note(`the take:\n${timeline.join("\n")}`);
        note(`new card ${shown?.cardId ?? "?"}: pages ${[...pages].join(", ")}, start ${shown?.start ?? "?"}, ready ${shown?.readyMs?.toFixed(0) ?? "?"} ms`);
        expect(shown, "the new card is ready, painted and shown").toMatchObject({ state: "ready", painted: true, visible: true });
        expect(shown?.page, "on the page the spare was, not one made again after an eviction").toBe(sparePage);
        expect(shown?.start, "and it began warm").toBe("warm");
        expect([...pages], "no other page ever held the card").toEqual([sparePage!]);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
