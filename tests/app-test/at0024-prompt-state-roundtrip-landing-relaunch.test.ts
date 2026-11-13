/**
 * at0024-prompt-state-roundtrip-landing-relaunch.test.ts — a quit made while the Changes tab is
 * up saves the prompt as the prompt, and the relaunched card shows it in the
 * Prompt tab with the commit message still in Changes.
 *
 * Commit mode is in-memory, so a quit with Changes up loses the mode, and the
 * termination save is the one that decides what the next launch shows as the
 * prompt. It used to file the document on screen — the commit message — as
 * the prompt draft, and append any unsent prompts to that message; the next
 * launch then restored the message as the prompt.
 *
 * Phase A types a prompt, opens Changes, types a message, and quits through
 * the app's own graceful-termination path. The bag on disk must carry the
 * prompt and not the message. Phase B relaunches over the same tugbank and
 * data root, re-seeds the card from disk on the same session, and asserts the
 * Prompt tab holds the prompt and Changes holds the message.
 *
 * One piece of the prompt-state round-trip family: the quit-and-relaunch
 * round trip with a landing up.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/cards/prompt-entry.tsx
 * @covers tugdeck/src/lib/commit-mode-controller.ts
 * @family at0024-prompt-state-roundtrip
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankRead,
} from "./_harness/tugbank-helpers";
import {
  CHECKOUT,
  MESSAGE,
  PROMPT,
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

const SID = "a7c0d1ea-0000-4000-8000-000000000811";
const CARDSTATE_DOMAIN = "dev.tugapp.deck.cardstate";

type Bag = { content?: { draft?: { text?: string } | null } | null };

let s: LandingDraftScratch | null = null;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  s = makeLandingDraftScratch("at0024-landing-relaunch", SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmLandingDraftScratch(s);
});

describe.skipIf(!SHOULD_RUN)("AT0024: a relaunch after a quit mid-landing keeps each tab's text", () => {
  test(
    "the quit saves the prompt, and the relaunch shows it with the message in Changes",
    async () => {
      if (s === null) throw new Error("at0024-landing: no scratch repository");
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const env = { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: s.scratch.dataRoot };
      // One instance across both launches, as a real relaunch is: the commit
      // draft lives in the instance's `changes.db`, and a harness-minted id per
      // launch would hand phase B an empty one. The instance dir sits under the
      // scratch data root, which the fixture removes.
      const instanceId = `apptest-at0024-landing-${randomUUID()}`;
      try {
        // ── Phase A: prompt, Changes, message, quit. ──
        {
          const app = await launchTugApp({
            testName: "at0024-landing-relaunch-A",
            env,
            instanceId,
            persistInTestMode: true,
          });
          try {
            await standUpCard(app, s);
            await typePromptThenMessage(app);
            expect(await savedPromptText(app), "a save during the landing files the prompt").toBe(PROMPT);
            await app.quitGracefully();
          } catch (err) {
            const tail = app.tailLog(200);
            if (tail !== "") process.stderr.write(`\n[at0024-landing-relaunch-A] log tail:\n${tail}\n`);
            await app.close();
            throw err;
          }
        }

        // ── Between processes: the bag on disk holds the prompt. ──
        const onDisk = tugbankRead<Bag>(tugbankPath, CARDSTATE_DOMAIN, "A");
        expect(onDisk, "the quit wrote card A's bag").not.toBeNull();
        const bag = onDisk?.value as Bag;
        note("at0024-landing the draft on disk", JSON.stringify(bag?.content?.draft?.text ?? null));
        expect(bag?.content?.draft?.text, "the saved prompt draft is the prompt").toBe(PROMPT);
        expect(JSON.stringify(bag), "the commit message is not in the card's bag").not.toContain(MESSAGE);

        // ── Phase B: relaunch over the same state. ──
        {
          const app = await launchTugApp({
            testName: "at0024-landing-relaunch-B",
            env,
            instanceId,
            persistInTestMode: true,
          });
          try {
            await standUpCard(app, s, { A: bag });

            let promptBack = false;
            try {
              await waitForComposer(app, PROMPT);
              promptBack = true;
            } catch {
              promptBack = false;
            }
            note("at0024-landing composer after the relaunch", JSON.stringify(await composerText(app)));
            expect(promptBack, "the Prompt tab holds the prompt after the relaunch").toBe(true);
            expect(await landingUp(app), "the card comes back on the Prompt tab").toBe(false);

            await openChanges(app);
            let messageBack = false;
            try {
              await waitForComposer(app, MESSAGE);
              messageBack = true;
            } catch {
              messageBack = false;
            }
            note("at0024-landing composer in Changes after the relaunch", JSON.stringify(await composerText(app)));
            expect(messageBack, "Changes holds the message after the relaunch").toBe(true);
            process.stdout.write("VERDICT: PASS\n");
          } catch (err) {
            process.stdout.write("VERDICT: FAIL\n");
            const tail = app.tailLog(200);
            if (tail !== "") process.stderr.write(`\n[at0024-landing-relaunch-B] log tail:\n${tail}\n`);
            throw err;
          } finally {
            await app.close();
          }
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
