/**
 * at0560-run-brief-here.test.ts — `Run in This Session` on a transcript
 * `/arc` line sends the command as this card's next turn, and opens no
 * second card.
 *
 * One piece of the at0560-run-brief split (formerly
 * at0560-run-brief-command), a test to a file so each launch fits its own
 * budget. The three ways to run a command, and the seeded line they act on,
 * are `run-brief-fixture.ts`.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/annotator/registry.ts
 * @covers tugdeck/src/lib/command-atom.ts
 * @covers tugdeck/src/components/tugways/use-annotation-menu.tsx
 * @covers tugdeck/src/components/tugways/cards/transcript-host-helpers.ts
 * @covers tugdeck/src/components/tugways/prompt-insert-target.ts
 * @covers tugdeck/src/lib/session-restore.ts
 * @covers tugdeck/src/lib/card-services-store.ts
 * @covers tugdeck/src/action-dispatch.ts
 * @family at0560-run-brief
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIEF,
  PROMPT_INPUT,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  openCommandMenu,
  pickMenuItem,
  seedCardWithCommandLine,
} from "./run-brief-fixture";

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0560-run-brief-"));
  // The args name a real file.
  mkdirSync(join(projectDir, "briefs"), { recursive: true });
  writeFileSync(join(projectDir, BRIEF), "# A thing\n");
});
afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

describe.skipIf(!SHOULD_RUN)("AT0560: the three ways to run a command", () => {
  test(
    "Run in This Session sends the command as this card's next turn",
    async () => {
      const app = await seedCardWithCommandLine(projectDir, "at0560-run-brief-here");
      try {
        await openCommandMenu(app);
        await pickMenuItem(app, "run-command-here");

        // The submit is what distinguishes this from the click that only
        // seeds: the composer is empty afterwards, and the command is in the
        // transcript as the user's own row. Emptiness is asked of the atoms
        // as well as the ink — the seed's own mention is a chip, so a
        // text-only check would pass on a composer still holding it. The ink
        // is asked about the slug rather than asked to be empty: an empty
        // composer renders its placeholder, which is text.
        await app.body("A").waitForCondition<boolean>(
          `(function(){
            var cm = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
            if (!cm) return false;
            if (cm.querySelector('[data-atom-type]') !== null) return false;
            return (cm.textContent || '').indexOf('a-thing') === -1;
          })()`,
          { timeoutMs: 15_000 },
        );
        await app.body("A").waitForCondition<boolean>(
          `(function(){
            var rows = Array.from(document.querySelectorAll(
              '[data-card-id="A"] [data-testid="session-card-transcript-user-body"]'));
            return rows.some(function(r){
              return (r.textContent || '').indexOf(${JSON.stringify(BRIEF)}) !== -1;
            });
          })()`,
          { timeoutMs: 15_000 },
        );

        // And it ran HERE: no second card was opened behind the reader's back.
        // card-dom: shell — the deck's card count: one placeholder per card in the shell.
        const cardCount = await app.evalJS<number>(
          `document.querySelectorAll('[data-card-id]').length`,
        );
        expect(cardCount).toBe(1);
        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0560] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
