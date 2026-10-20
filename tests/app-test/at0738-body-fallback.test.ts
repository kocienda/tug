/**
 * at0738-body-fallback.test.ts — a body that never says it is ready is made
 * again, and a card whose body fails twice stands as a placard with a Reload.
 *
 * Part of the gate for the body path, split from `at0738-session-body` one
 * leg per file (see `at0738-body-placement` for the list). Shared helpers
 * live in `session-body-fixture.ts`.
 *
 * Every card is a body, so the shell has no document of its own to fall back
 * to. A body that never says it is ready (`TUG_BODY_FORCE_STALL=<n>`, the
 * first `n` bodies) fails at the deadline (`TUG_BODY_READY_DEADLINE_MS`,
 * shortened), and the shell asks the host for the card's body once more.
 *
 * **Made again.** A Session card whose first body stalls comes up in a second
 * body, bound to the one session its spawn made: the shell asks with a
 * `restore` once it holds the binding, never with the `new` again.
 *
 * **Placard.** A card whose second body stalls too stands as a placard in
 * the shell, saying so, with a Reload and a Close; the Reload asks once
 * more, and the card comes up in its body. The Close closes the card: the
 * placard is its only face, with no page to draw its title bar.
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
import { BODY_READY_MS, PROMPT_INPUT, column, pollFor, spawnStub } from "./session-body-fixture";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "./streaming-stub-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;
const STALLED = "at0738-stalled";

/** The card's body, ready and placed visible. */
async function readyBody(app: App): Promise<boolean> {
  const body = await pollFor(
    async () => (await app.bodies()).find((b) => b.cardId === STALLED) ?? null,
    (b) => b !== null && b.state === "ready" && b.visible,
    BODY_READY_MS,
  );
  return body !== null && body.state === "ready" && body.visible;
}

/** The shell's dev-log messages from the body hand-off. */
async function bodyLog(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `window.tugDevLog.getSnapshot().entries.filter(function (e) { return e.source === "body"; }).map(function (e) { return e.message; })`,
  );
}

const placard = `document.querySelector('[data-body-placeholder][data-card-id="${STALLED}"] [data-body-failed]')`;

describe.skipIf(!SHOULD_RUN)("at0738: a body that never says it is ready", () => {
  test(
    "is made again, bound to the one session its card's spawn made",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({
        testName: "at0738-body-fallback-again",
        env: {
          TUG_BODY_FORCE_STALL: "1",
          TUG_BODY_READY_DEADLINE_MS: "1500",
          [STUB_TRANSCRIPT_DIR_ENV]: stubDir,
        },
      });
      try {
        await app.seedDeckState({ state: column([STALLED]), focusCardId: STALLED });
        const spawned = await spawnStub(app, STALLED, stubDir);

        expect(await readyBody(app), "the card comes up in a body").toBe(true);
        const log = await bodyLog(app);
        note(`body log: ${JSON.stringify(log)}`);
        expect(log, "the shell asked for the failed body again").toContain("a body failed; asking for it again");

        const body = app.body(STALLED);
        const composer = await pollFor(
          () => body.evalJS<boolean>(`document.querySelector(${JSON.stringify(PROMPT_INPUT)}) !== null`),
          (v) => v,
          BODY_READY_MS,
        );
        expect(composer, "the card's session view is mounted in its new body").toBe(true);
        // The binding the shell holds is the one the bodies' acks broadcast: a
        // re-run `new` would have rebound the card to a second session.
        const bound = await app.evalJS<string>(`window.__tug.cardLineFacts(${JSON.stringify(STALLED)}).tugSessionId`);
        note(`spawned ${spawned}; the card is bound to ${bound}`);
        expect(bound, "the card holds the session the spawn made, not a second one").toBe(spawned);
        expect(await app.evalJS<boolean>(`${placard} !== null`), "no placard stands for a card that came up").toBe(false);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "twice stands as a placard with a Reload, and the Reload brings the card up",
    async () => {
      const app = await launchTugApp({
        testName: "at0738-body-fallback-placard",
        env: {
          TUG_BODY_FORCE_STALL: "2",
          TUG_BODY_READY_DEADLINE_MS: "1500",
        },
      });
      try {
        await app.seedDeckState({ state: column([STALLED]), focusCardId: STALLED });

        const standing = await pollFor(() => app.evalJS<boolean>(`${placard} !== null`), (v) => v, BODY_READY_MS);
        expect(standing, "the card stands as a placard once its second body fails").toBe(true);
        expect((await app.bodies()).some((b) => b.cardId === STALLED), "no body is left for the card").toBe(false);
        const text = await app.evalJS<string>(`${placard}.textContent`);
        note(`placard: ${text}`);
        expect(text, "the placard says the card did not load").toContain("didn’t load");

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
        env: {
          TUG_BODY_FORCE_STALL: "2",
          TUG_BODY_READY_DEADLINE_MS: "1500",
        },
      });
      try {
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
