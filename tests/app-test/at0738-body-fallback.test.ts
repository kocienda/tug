/**
 * at0738-body-fallback.test.ts — a body that never says it is ready falls
 * back to the shell's document, bound once.
 *
 * Part of the gate for the body path, split from `at0738-session-body` one
 * leg per file (see `at0738-body-placement` for the list). The app launches
 * with bodies on; shared helpers live in `session-body-fixture.ts`.
 *
 * **Fallback.** A body that never says it is ready (`TUG_BODY_FORCE_STALL`)
 * fails at the deadline (`TUG_BODY_READY_DEADLINE_MS`, shortened), and its
 * card mounts in the shell's own document on the binding the body's spawn
 * already made — bound once, never spawned a second time.
 *
 * @family at0738-body
 * @covers tugdeck/src/lib/body-placement.ts
 * @covers tugdeck/src/lib/body-facts-store.ts
 * @covers tugdeck/src/lib/body-command-route.ts
 * @covers tugdeck/src/lib/pointer-claim.ts
 * @covers tugdeck/src/components/chrome/body-placement-beacon.tsx
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/lib/body-handoff.ts
 * @covers tugdeck/src/lib/body-cards-store.ts
 * @covers tugdeck/src/body/body-intent.ts
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/BodyGeometry.swift
 * @covers tugapp/Sources/MainWindow.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import { BODY_READY_MS, PROMPT_INPUT, column, pollFor, spawnStub } from "./session-body-fixture";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "./streaming-stub-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

describe.skipIf(!SHOULD_RUN)("at0738: a Session card's body", () => {
  test(
    "falls back to the shell's document when a body never says it is ready, bound once",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({
        testName: "at0738-body-fallback",
        bodies: true,
        env: {
          TUG_BODY_FORCE_STALL: "1",
          TUG_BODY_READY_DEADLINE_MS: "1500",
          [STUB_TRANSCRIPT_DIR_ENV]: stubDir,
        },
      });
      const STALLED = "at0738-stalled";
      try {
        await app.seedDeckState({ state: column([STALLED]), focusCardId: STALLED });
        await spawnStub(app, STALLED, stubDir);

        const composerInShell = `document.querySelector('.tug-pane[data-pane-id="${STALLED}-pane"] ${PROMPT_INPUT}') !== null`;
        const inShell = async () => ({
          body: (await app.bodies()).find((b) => b.cardId === STALLED) ?? null,
          placeholder: await app.evalJS<boolean>(`document.querySelector('[data-body-placeholder][data-card-id="${STALLED}"]') !== null`),
          composer: await app.evalJS<boolean>(composerInShell),
        });
        const mounted = await pollFor(inShell, (s) => s.body === null && !s.placeholder && s.composer, BODY_READY_MS);
        note(`after the deadline: ${JSON.stringify(mounted)}`);
        expect(mounted.body, "the stalled body is gone").toBeNull();
        expect(mounted.placeholder, "the shell no longer stands a placeholder for the card").toBe(false);
        expect(mounted.composer, "the card mounts in the shell's own document").toBe(true);

        // A re-run of the `new` intent would have bound the card a second time.
        await Bun.sleep(1_000);
        const acks = await app.evalJS<number>(
          `window.__deckTrace.dump().filter(function (e) {
            return e.kind === "session-lifecycle" && e.event === "spawn.ack" && e.fields && e.fields.card_id === ${JSON.stringify(STALLED)};
          }).length`,
        );
        note(`spawn_session_ok for the card: ${acks}`);
        expect(acks, "the card was bound by exactly one spawn").toBe(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
