/**
 * at0469-arc-entry-points-replay-in-shade.test.ts — a replay that moves
 * nothing reports in the shade it was pressed in.
 *
 * One of the at0469-arc-entry-points split, a test to a file so each launch
 * fits its own budget. Why a surface that shows an arc lets you act on one,
 * the scratch repository this file builds for itself, and the shared helpers
 * are `arc-entry-points-fixture.ts`.
 *
 * In the original file this test ran third, in a scratch repository where the
 * earlier tests had bound `at0469-held` and then `at0469-behind` to the
 * session and replayed `at0469-behind` onto the moved base. Nothing here
 * reads any of that — this test binds `at0469-clash` itself, and every
 * assertion is about that arc's row, its shade notice and the corner lane —
 * so the fresh scratch this file builds needs no extra step.
 *
 * @covers tugdeck/src/components/arcs/arcs-card.tsx
 * @covers tugdeck/src/components/arcs/arcs-card.css
 * @covers tugdeck/src/components/tugways/cards/session-changes/arc-row-menu.tsx
 * @covers tugdeck/src/components/tugways/cards/arc-replay-notice-controller.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-notice.tsx
 * @covers tugdeck/src/lib/arc-replay-outcome-store.ts
 * @covers tugdeck/src/lib/changeset-verb-store.ts
 * @covers tugdeck/src/lib/action-vocabulary.ts
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor/control/changeset.rs
 * @family at0469-arc-entry-points
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  pressArcRowMenuItem,
  readArcRowMenu,
} from "./arc-row-menu-fixture";
import { bindArc } from "./arc-fixture";
import {
  CHECKOUT,
  CLASH,
  CORNER_TEXTS,
  PROMPT_INPUT,
  SHADE_NOTICE,
  SHARED_FILE,
  SHEET,
  SHOULD_RUN,
  SID,
  TEST_TIMEOUT_MS,
  projectDir,
  rmArcEntryPointsScratch,
  scratch,
  seedArcEntryPointsScratch,
  settle,
} from "./arc-entry-points-fixture";

beforeAll(seedArcEntryPointsScratch);
afterAll(rmArcEntryPointsScratch);

describe.skipIf(!SHOULD_RUN)("AT0469: acting on an arc from a surface that shows one", () => {
  test(
    "a replay that moves nothing reports in the shade it was pressed in",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0469-replay-outcome-speaks",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });
        // Driven from the SHADE rather than the rail, deliberately, and that is
        // now two facts rather than one: the shade's press carries its own card's
        // session id with no dependence on which card the rail is following, and
        // it is stamped with the shade's entry key, which is what routes the
        // answer into the shade's band instead of the corner lane.
        await app.body("A").nativeClickAtElement(PROMPT_INPUT);
        await app.nativeType("/commit");
        await settle();
        await app.nativeKey("Escape");
        await settle();
        await app.nativeKey("Return", ["cmd"]);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 15000 },
        );
        // Bound, because the notice is the card's: the controller reports for
        // the session this card holds. Bound only once the shade is up, in
        // commit mode: a bound arc with work to join is revealed by the card
        // on its own (the passive reveal enters join mode at a quiet moment),
        // and bound before the `/commit` submit, that reveal could win the
        // race and turn the ⌘Return into a press of an empty Join — whose
        // refusal then held the notice slot this case reads. With a landing
        // already up, the reveal defers.
        bindArc(projectDir(), CLASH, SID, scratch?.cli ?? {});
        const shadeRow = `${SHEET} [data-slot="session-changes-arc-row"][data-arc="${CLASH}"]`;
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(shadeRow)}) !== null`,
          { timeoutMs: 30000 },
        );

        // The arc is behind its base, so the verb is live — the client cannot
        // know the replay will conflict, and it is not its business to guess.
        const menu = await readArcRowMenu(app.body("A"), shadeRow);
        note("at0469 clash-row menu", JSON.stringify(menu));
        expect(menu.replay.present).toBe(true);
        expect(menu.replay.disabled).toBe(false);

        // The press runs a real replay that stops at the conflicting round and
        // touches nothing. Every fact on the row is byte-identical afterwards,
        // which is exactly why the answer has to arrive somewhere else.
        await pressArcRowMenuItem(app.body("A"), shadeRow, "request-replay-arc");
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHADE_NOTICE)}) !== null`,
          { timeoutMs: 20000 },
        );
        const spoken = await app.body("A").evalJS<{ text: string; tone: string | null; channel: string | null }>(
          `(() => {
             const b = document.querySelector(${JSON.stringify(SHADE_NOTICE)});
             return {
               text: b?.textContent ?? "",
               tone: b?.getAttribute("data-tone") ?? null,
               channel: b?.getAttribute("data-channel") ?? null,
             };
           })()`,
        );
        note("at0469 the outcome spoke", JSON.stringify(spoken));
        expect(spoken.text).toContain(CLASH);
        // The description names the round it stopped at and the path it stopped
        // on — the only text that makes this refusal readable.
        expect(spoken.text).toContain(SHARED_FILE);
        expect(spoken.text).toContain("Nothing was touched");
        // A stopped replay is a caution, not a failure: it refused above every
        // write and the branch is exactly as it was.
        expect(spoken.tone).toBe("caution");

        // And the corner lane carries none of it. This is the half that makes
        // the split a tested fact: the same store slot feeds both readers, so a
        // controller that forgot to check the stamp would put this sentence
        // behind the scrim as well as in the band, and every other assertion
        // above would still pass.
        // Both lanes a toast can land in: the card's pane bulletin, in A's
        // body, and the deck's corner, which is the shell's.
        const corner = [
          ...(await app.body("A").evalJS<string[]>(CORNER_TEXTS)),
          ...(await app.evalJS<string[]>(CORNER_TEXTS)),
        ];
        note("at0469 corner bulletins after the shade's press", JSON.stringify(corner));
        expect(
          corner.every((t) => !t.includes(CLASH) && !t.includes("Nothing was touched")),
          "a shade press leaves the corner lane empty of its answer",
        ).toBe(true);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
