/**
 * row-39-evict-after.test.ts — a body hidden past the eviction delay gives up its
 * process by the clock alone, and its card comes back with its draft.
 *
 * A Session card takes a draft, saved to the run's tugbank file. The host's
 * eviction delay, a constant, is shortened through the harness's
 * `bodyDelays`. Its
 * workspace is parked, which hides it; no pressure is raised. The body stands
 * for the delay and is gone soon after it — not before, which would be some
 * other act than the clock — and the spare stands, since the clock takes only
 * a card's hidden page. The new workspace's own cards take the spare as they
 * open, and its successor is made a beat after the last of them is ready, so
 * the row waits for it to stand before the clock falls due: the spare it reads
 * afterwards is one the clock passed over, never one not yet made. Shown
 * again, the card comes back under its last frame, which the clock's eviction
 * kept, and is ready, painted and shown with its draft in its composer: the
 * time trigger rides the same eviction and the same arrival as pressure
 * (row 38).
 *
 * @family row-39
 * @covers tugapp/Sources/BodyLifecycle.swift
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { launchTugApp, note } from "../_harness";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankRead } from "../_harness/tugbank-helpers";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { bodyOf, composerText, focusBody, pollFor, settleFor, sessionPane } from "./_bodies";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const A = "r39-a";
/**
 * The eviction delay, shortened from fifteen minutes for the
 * row: long enough for the spare the new workspace's cards took to be made
 * again before the clock falls due.
 */
const EVICT_AFTER_MS = 4_000;
/**
 * How far past the delay the body may still be listed: the ~110 ms the row
 * has recorded (the clock's firing, the eviction and the reads between),
 * and one display frame.
 */
const EVICT_LATE_MS = 110 + 17;
const DRAFT = "row39 draft before the clock";
const CARDSTATE = "dev.tugapp.deck.cardstate";
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

describe.skipIf(!SHOULD_RUN)("body-grounding row 39: eviction by time hidden", () => {
  test(
    "a body hidden past evictAfterMs is evicted by the clock, and its card comes back with its draft",
    async () => {
      const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-r39-project-")));
      onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const app = await launchTugApp({
        testName: "body-grounding-row-39-evict-after",
        persistInTestMode: true,
        restoreInTestMode: true,
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        await pollFor(() => bodyOf(app, A), (b) => b?.state === "ready" && b.visible, 30_000);
        await app.spawnSessionNew(A, { tugSessionId: randomUUID(), projectDir });

        // ---- A draft, saved ----
        await focusBody(app, A, { composer: true });
        await app.nativeType(DRAFT);
        await pollFor(() => app.body(A).evalJS<string | null>(composerText), (t) => t?.includes(DRAFT) === true, 5_000);
        const saved = await settleFor(
          async () => JSON.stringify(tugbankRead<unknown>(tugbankPath, CARDSTATE, A)?.value ?? null),
          (bag) => bag.includes(DRAFT),
          10_000,
        );
        expect(saved, "the draft is in the card's bag on disk before the clock runs").toContain(DRAFT);

        // ---- The eviction delay, shortened through the harness's seam ----
        await app.bodyDelays({ evictAfterMs: EVICT_AFTER_MS });

        // ---- The workspace parked: hidden, and no pressure raised ----
        const home = await app.evalJS<string>(ACTIVE_SPACE);
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("new-space"), null)`);
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id !== home, 5_000);
        const hidden = await settleFor(() => bodyOf(app, A), (b) => b?.shown === false, 5_000);
        const hiddenAt = Date.now();
        expect(hidden?.shown, "the host has the parked body hidden").toBe(false);

        // ---- The spare stands again before the clock is due ----
        const spare = await settleFor(() => app.bodies(), (all) => all.some((b) => b.cardId === null), EVICT_AFTER_MS);
        const spareAt = Date.now() - hiddenAt;
        note(`the spare stood ${spareAt} ms after the body was hidden`);
        expect(spare.some((b) => b.cardId === null), "a spare stands while the body is hidden").toBe(true);
        expect(spare.some((b) => b.cardId === A), "and the hidden body with it, the clock not yet due").toBe(true);
        const sparePage = spare.find((b) => b.cardId === null)!.page;

        // ---- It stands for the delay, and is gone soon after ----
        let lastSeen = hiddenAt;
        const gone = await settleFor(
          async () => {
            const all = await app.bodies();
            if (all.some((b) => b.cardId === A)) lastSeen = Date.now();
            return all;
          },
          (all) => !all.some((b) => b.cardId === A),
          EVICT_AFTER_MS + 6_000,
        );
        const goneAt = Date.now();
        note(`evicted by the clock: body last seen ${lastSeen - hiddenAt} ms and gone by ${goneAt - hiddenAt} ms after it was hidden, for a delay of ${EVICT_AFTER_MS} ms`);
        expect(gone.some((b) => b.cardId === A), "the hidden body is evicted").toBe(false);
        expect(lastSeen - hiddenAt, "it stood hidden for the delay before it went").toBeGreaterThanOrEqual(EVICT_AFTER_MS - 200);
        // The last reading that still listed it, not the first without it, which adds the poll's own sleep.
        expect(lastSeen - hiddenAt, "and went on the clock, not some later act").toBeLessThanOrEqual(EVICT_AFTER_MS + EVICT_LATE_MS);
        // The same page: a spare the clock took and the lane made again a
        // second later would stand in the list all the same.
        expect(gone.find((b) => b.cardId === null)?.page, "the clock takes a card's hidden page and leaves the spare it passed over").toBe(sparePage);

        // ---- Shown again: the card is back, with its draft ----
        const shownAt = performance.now();
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(home)} }), null)`);
        const back = await settleFor(() => bodyOf(app, A), (b) => b?.state === "ready" && b.painted && b.visible && !b.covered, 10_000);
        const backMs = performance.now() - shownAt;
        expect(back?.wasCovered, "the clock's eviction kept the card's last frame, and the new body stood under it").toBe(true);
        expect(back, "the card's new body is ready, painted and shown, its cover gone").toMatchObject({ state: "ready", painted: true, visible: true, covered: false });
        const draft = await settleFor(() => app.body(A).evalJS<string | null>(composerText), (t) => t?.includes(DRAFT) === true, 5_000);
        expect(draft, "the new body's composer holds the draft").toContain(DRAFT);
        note(`back: shown → painted ${Math.round(backMs)} ms, start ${back?.start ?? "?"}, ready ${back?.readyMs?.toFixed(0) ?? "?"} ms`);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
