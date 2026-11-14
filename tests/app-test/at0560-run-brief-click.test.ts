/**
 * at0560-run-brief-click.test.ts — a plain click on a transcript `/arc`
 * line seeds the composer with the command chip and its `@` mention as a
 * file chip, and sends nothing.
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
  CMD,
  PROMPT_INPUT,
  SHOULD_RUN,
  SPAN,
  TEST_TIMEOUT_MS,
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
    "a click seeds the command chip and its `@` mention as a file chip",
    async () => {
      const app = await seedCardWithCommandLine(projectDir, "at0560-run-brief-click");
      try {
        await app.body("A").nativeClickAtElement(SPAN);

        // Two chips and no loose path characters: the command leads, the
        // mention follows, and the argument between them is still ink.
        const atoms = await app.body("A").waitForCondition<string>(
          `(function(){
            var cm = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
            if (!cm) return "";
            var found = Array.from(cm.querySelectorAll('[data-atom-type]')).map(function(el){
              return el.getAttribute('data-atom-type') + ':' + el.getAttribute('data-atom-value');
            });
            return found.length === 2 ? JSON.stringify(found) : "";
          })()`,
          { timeoutMs: 15_000 },
        );
        expect(JSON.parse(atoms) as string[]).toEqual([
          `command:${CMD}`,
          `file:${BRIEF}`,
        ]);

        // The path is the chip's value, not the composer's text — which is
        // the whole of the difference a reader sees.
        const ink = await app.body("A").evalJS<string>(
          `(function(){
            var cm = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
            return cm ? (cm.textContent || '') : '';
          })()`,
        );
        expect(ink).toContain("a-thing");
        expect(ink.indexOf("@" + BRIEF)).toBe(-1);

        // A click seeds and stops: nothing was sent.
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
