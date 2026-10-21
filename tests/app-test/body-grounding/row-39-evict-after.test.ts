/**
 * row-39-evict-after.test.ts — a body hidden past `evictAfterMs` gives up its
 * process by the clock alone, and its card comes back with its draft.
 *
 * A Session card takes a draft, saved to the run's tugbank file. The reader's
 * `evictAfterMs` is shortened in the shell's own tugbank client, as the Layout
 * card's row writes it, which is how the shell learns to tell the host. Its
 * workspace is parked, which hides it; no pressure is raised. The body stands
 * for the delay and is gone soon after it — not before, which would be some
 * other act than the clock — and the spare stands, since the clock takes only
 * a card's hidden page. Shown again, the card is back ready, painted and shown
 * with its draft in its composer: the time trigger rides the same eviction
 * and the same arrival as pressure (row 38).
 *
 * @foreground activation
 * @covers tugdeck/src/lib/evict-after-pref.ts
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
import { bodyOf, composerText, focusBody, pollFor, sessionPane } from "./_bodies";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const A = "r39-a";
/** The reader's delay before eviction, shortened from fifteen minutes for the row. */
const EVICT_AFTER_MS = 1_500;
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
        foreground: true,
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
        const saved = await pollFor(
          async () => JSON.stringify(tugbankRead<unknown>(tugbankPath, CARDSTATE, A)?.value ?? null),
          (bag) => bag.includes(DRAFT),
          10_000,
        );
        expect(saved, "the draft is in the card's bag on disk before the clock runs").toContain(DRAFT);

        // ---- The reader's delay, shortened in the shell, as the Layout card writes it ----
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.body-dormancy", "evictAfterMs", { kind: "i64", value: ${EVICT_AFTER_MS} }), null)`,
        );

        // ---- The workspace parked: hidden, and no pressure raised ----
        const home = await app.evalJS<string>(ACTIVE_SPACE);
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("new-space"), null)`);
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id !== home, 5_000);
        const hidden = await pollFor(() => bodyOf(app, A), (b) => b?.shown === false, 5_000);
        const hiddenAt = Date.now();
        expect(hidden?.shown, "the host has the parked body hidden").toBe(false);

        // ---- It stands for the delay, and is gone soon after ----
        let lastSeen = hiddenAt;
        const gone = await pollFor(
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
        expect(gone.some((b) => b.cardId === null), "the clock takes a card's hidden page and leaves the spare").toBe(true);

        // ---- Shown again: the card is back, with its draft ----
        const shownAt = performance.now();
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(home)} }), null)`);
        const back = await pollFor(() => bodyOf(app, A), (b) => b?.state === "ready" && b.painted && b.visible && !b.covered, 10_000);
        const backMs = performance.now() - shownAt;
        expect(back, "the card's new body is ready, painted and shown, its cover gone").toMatchObject({ state: "ready", painted: true, visible: true, covered: false });
        const draft = await pollFor(() => app.body(A).evalJS<string | null>(composerText), (t) => t?.includes(DRAFT) === true, 5_000);
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
