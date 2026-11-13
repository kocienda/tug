/**
 * at0024-prompt-state-roundtrip-landing-restore.test.ts — a transcript restore made while the
 * Changes tab is up leaves the prompt in the Prompt tab and the commit message
 * in Changes.
 *
 * The two tabs share one editor and one document: opening Changes stashes the
 * prompt and puts the commit message on screen. A restore swaps the Session
 * card's body out (`transportState === "restoring"` unmounts it), which drops
 * the composer and the landing's in-memory mode with it, and when the body
 * remounts the card host replays the card's saved state into the composer. A
 * save taken while Changes was up used to file the document on screen as the
 * prompt draft, so the replay brought the commit message back as the prompt
 * and the prompt the user had typed was gone.
 *
 * This drives that on a live card: prompt typed, Changes opened, message typed,
 * the card's save read (it must be the prompt), then the transport through
 * `restoring` and back. After the remount the Prompt tab must hold the prompt,
 * and opening Changes must show the message.
 *
 * One piece of the prompt-state round-trip family: the round trip with a
 * landing up, whose first half is the same draft surviving the same remount.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/cards/prompt-entry.tsx
 * @covers tugdeck/src/lib/commit-mode-controller.ts
 * @family at0024-prompt-state-roundtrip
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch } from "./_harness/tugbank-helpers";
import {
  CHECKOUT,
  MESSAGE,
  PROMPT,
  PROMPT_INPUT,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  composerText,
  landingUp,
  makeLandingDraftScratch,
  openChanges,
  rmLandingDraftScratch,
  savedPromptText,
  standUpCard,
  typePromptThenMessage,
  waitForComposer,
  type LandingDraftScratch,
} from "./landing-draft-fixture";

const SID = "a7c0d1ea-0000-4000-8000-000000000810";

let s: LandingDraftScratch | null = null;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  s = makeLandingDraftScratch("at0024-landing-restore", SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmLandingDraftScratch(s);
});

describe.skipIf(!SHOULD_RUN)("AT0024: a restore mid-landing keeps each tab's text", () => {
  test(
    "the prompt comes back in the Prompt tab and the message stays in Changes",
    async () => {
      if (s === null) throw new Error("at0024-landing: no scratch repository");
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0024-landing-restore",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: s.scratch.dataRoot },
      });
      try {
        await standUpCard(app, s);
        await typePromptThenMessage(app);

        // While the message is on screen, the card's save files the prompt.
        expect(await savedPromptText(app), "a save during the landing files the prompt").toBe(PROMPT);

        // The transport drops and recovers into `restoring`, which unmounts the
        // body; the settle remounts it and the card host replays its bag.
        await app.driveSession("A", { op: "transportClose" });
        await app.driveSession("A", { op: "transportReconnect" });
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PROMPT_INPUT)}) === null`,
          { timeoutMs: 10_000 },
        );
        await app.driveSession("A", { op: "transportSettled" });

        let promptBack = false;
        try {
          await waitForComposer(app, PROMPT);
          promptBack = true;
        } catch {
          promptBack = false;
        }
        note("at0024-landing composer after the remount", JSON.stringify(await composerText(app)));
        expect(promptBack, "the Prompt tab holds the prompt after the restore").toBe(true);
        expect(await landingUp(app), "the card comes back on the Prompt tab").toBe(false);

        // The message is waiting in Changes.
        await openChanges(app);
        let messageBack = false;
        try {
          await waitForComposer(app, MESSAGE);
          messageBack = true;
        } catch {
          messageBack = false;
        }
        note("at0024-landing composer in Changes after the remount", JSON.stringify(await composerText(app)));
        expect(messageBack, "Changes holds the message after the restore").toBe(true);
        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0024-landing-restore] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
