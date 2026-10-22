/**
 * at0738-body-fallback.test.ts — a body that misses its ready deadline is
 * made again, and a card whose body fails twice stands as a placard with a
 * Reload.
 *
 * Part of the gate for the body path, split from `at0738-session-body` one
 * leg per file (see `at0738-body-placement` for the list). Shared helpers
 * live in `session-body-fixture.ts`.
 *
 * Every card is a body, so the shell has no document of its own to fall back
 * to. The host's ready deadline is shortened below any real page's load
 * (`bodyDelays`), so the card's body misses it and fails, and the shell asks
 * the host for the card's body once more, which misses it too. What the shell
 * asks the second body to do — a `restore` once it holds a binding, never a
 * second `new` — is the unit test's (`intentToAskAgain`, `body-handoff.test.ts`).
 *
 * **Placard.** A card whose second body fails too stands as a placard in
 * the shell, saying so, with a Reload and a Close; with the deadline put
 * back, the Reload asks once more, and the card comes up in its body. The
 * Close closes the card: the placard is its only face, with no page to draw
 * its title bar.
 *
 * @family at0738-body
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/lib/body-handoff.ts
 * @covers tugdeck/src/lib/body-cards-store.ts
 * @covers tugdeck/src/body/body-intent.ts
 * @covers tugdeck/src/components/chrome/card-host.tsx
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/BodyGeometry.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { BODY_READY_MS, column, pollFor } from "./session-body-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;
const STALLED = "at0738-stalled";
/** The host's ready deadline while the card's bodies are made: no real page loads this fast. */
const MISSED_DEADLINE_MS = 50;

/** The card's body, ready and placed visible. */
async function readyBody(app: App): Promise<boolean> {
  const body = await pollFor(
    async () => (await app.bodies()).find((b) => b.cardId === STALLED) ?? null,
    (b) => b !== null && b.state === "ready" && b.visible,
    BODY_READY_MS,
  );
  return body !== null && body.state === "ready" && body.visible;
}

const placard = `document.querySelector('[data-body-placeholder][data-card-id="${STALLED}"] [data-body-failed]')`;

describe.skipIf(!SHOULD_RUN)("at0738: a body that misses its ready deadline", () => {
  test(
    "twice stands as a placard with a Reload, and the Reload brings the card up",
    async () => {
      const app = await launchTugApp({
        testName: "at0738-body-fallback-placard",
      });
      try {
        await app.bodyDelays({ readyDeadlineMs: MISSED_DEADLINE_MS });
        await app.seedDeckState({ state: column([STALLED]), focusCardId: STALLED });

        const standing = await pollFor(() => app.evalJS<boolean>(`${placard} !== null`), (v) => v, BODY_READY_MS);
        expect(standing, "the card stands as a placard once its second body fails").toBe(true);
        await app.bodyDelays({ readyDeadlineMs: null });
        expect((await app.bodies()).some((b) => b.cardId === STALLED), "no body is left for the card").toBe(false);
        const text = await app.evalJS<string>(`${placard}.textContent`);
        note(`placard: ${text}`);
        expect(text, "the placard says the card needs reloading").toContain("This card needs reloading.");

        await app.evalJS<null>(`(${placard}.querySelector("button").click(), null)`);
        expect(await readyBody(app), "the Reload brings the card up in a body").toBe(true);
        const gone = await pollFor(() => app.evalJS<boolean>(`${placard} === null`), (v) => v, 3_000);
        expect(gone, "the placard is gone once the body is asked for").toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "twice stands as a placard whose Close closes the card",
    async () => {
      const app = await launchTugApp({
        testName: "at0738-body-fallback-close",
      });
      try {
        await app.bodyDelays({ readyDeadlineMs: MISSED_DEADLINE_MS });
        await app.seedDeckState({ state: column([STALLED]), focusCardId: STALLED });

        const standing = await pollFor(() => app.evalJS<boolean>(`${placard} !== null`), (v) => v, BODY_READY_MS);
        expect(standing, "the card stands as a placard once its second body fails").toBe(true);
        await app.evalJS<null>(
          `(Array.prototype.find.call(${placard}.querySelectorAll("button"), function (b) { return b.textContent.trim() === "Close"; }).click(), null)`,
        );
        const closed = await pollFor(
          () => app.evalJS<boolean>(`!window.tugdeck.diag.getDeckState().cards.some(function (c) { return c.id === ${JSON.stringify(STALLED)}; })`),
          (v) => v,
          3_000,
        );
        expect(closed, "the Close closes the card, asking nothing of a card no page stands for").toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
