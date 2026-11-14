/**
 * at0560-run-brief-new-session.test.ts — `Run in New Session` on a
 * transcript `/arc` line opens a second card that runs the command as its
 * first turn, and leaves the originating card alone ([B06]).
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
import { waitForBodyReady } from "./_harness/card-reach";
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
    "Run in New Session opens a second card that runs the command, and leaves this one alone",
    async () => {
      const app = await seedCardWithCommandLine(projectDir, "at0560-run-brief-new-session");
      try {
        await openCommandMenu(app);
        await pickMenuItem(app, "run-command-in-new-session");

        // A second Session card appears — the answer to the gesture is a card
        // somewhere else, never a rotation on the one being read ([B06]).
        // card-dom: shell — the deck's cards: one placeholder per card in the shell.
        await app.waitForCondition<boolean>(
          `document.querySelectorAll('[data-card-id]').length > 1`,
          { timeoutMs: 15_000 },
        );
        const cards = JSON.parse(
          // card-dom: shell — the deck's cards, by their placeholders' ids.
          await app.evalJS<string>(
            `JSON.stringify(Array.from(document.querySelectorAll('[data-card-id]')).map(function(el){
              return el.getAttribute('data-card-id');
            }))`,
          ),
        ) as string[];
        expect(cards).toContain("A");
        expect(cards.length).toBeGreaterThan(1);

        // The new card runs the command as its first turn: the reader's own
        // row carrying the brief, sent by the card's own runner rather than
        // left waiting in its composer. The window covers the runner's
        // catalog deadline, for a harness claude that never sends one.
        const newCard = `[data-card-id]:not([data-card-id="A"])`;
        // The new card's DOM is in its own body.
        const newCardId = cards.find((id) => id !== "A") as string;
        const theirPage = await waitForBodyReady(app, newCardId);
        await theirPage.waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(${JSON.stringify(
            `${newCard} [data-testid="session-card-transcript-user-body"]`,
          )})).some(function(r){
            return (r.textContent || '').indexOf(${JSON.stringify(BRIEF)}) !== -1;
          })`,
          { timeoutMs: 30_000 },
        );
        // Each page keeps its own trace, so the sends are counted in every one.
        const traces = [await app.getDeckTrace({})];
        for (const b of await app.bodies()) {
          if (b.cardId !== null) traces.push(await app.body(b.cardId).getDeckTrace({}));
        }
        const sentEvents = traces.flat().filter(
          (e) => e.kind === "session-lifecycle" && e.event === "opening_command.sent",
        );
        expect(sentEvents.length).toBe(1);
        const theirs = await theirPage.evalJS<string>(
          `(function(){
            var cm = document.querySelector(${JSON.stringify(
              `${newCard} [data-slot="tug-text-editor"] .cm-content`,
            )});
            return cm ? (cm.querySelectorAll('[data-atom-type]').length + ':' + (cm.textContent || '')) : 'none';
          })()`,
        );
        expect(theirs.indexOf("a-thing")).toBe(-1);

        // The originating card's own composer is untouched: the command did
        // not run here, and the transcript the reader was reading still says
        // what it said.
        const here = await app.body("A").evalJS<string>(
          `(function(){
            var cm = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
            return cm ? (cm.textContent || '') : '';
          })()`,
        );
        expect(here.indexOf(BRIEF)).toBe(-1);
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
