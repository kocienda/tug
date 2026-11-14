/**
 * at0560-run-brief-menu.test.ts — a transcript `/arc` line's context menu
 * offers both runs ahead of the copies, and both stay live even when the
 * brief its argument names is not on disk ([B03]).
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
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  openCommandMenu,
  seedCardWithCommandLine,
} from "./run-brief-fixture";

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0560-run-brief-"));
  // The args name a real file — the menu test takes it away for its own run.
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
    "the menu offers both runs ahead of the copies, live",
    async () => {
      // No brief on disk: the rows must stay live regardless.
      rmSync(join(projectDir, BRIEF), { force: true });
      const app = await seedCardWithCommandLine(projectDir, "at0560-run-brief-menu");
      try {
        await openCommandMenu(app);
        const rows = JSON.parse(
          await app.body("A").evalJS<string>(
            `JSON.stringify(Array.from(document.querySelectorAll('[data-item-action]')).map(function(el){
              return {
                action: el.getAttribute('data-item-action'),
                disabled: el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled'),
              };
            }))`,
          ),
        ) as Array<{ action: string; disabled: boolean }>;
        const actions = rows.map((r) => r.action);
        // The two runs lead, the copies follow — the registry's order, on a
        // real menu rather than in a unit test's array.
        expect(actions.indexOf("run-command-here")).toBe(0);
        expect(actions.indexOf("run-command-in-new-session")).toBe(1);
        expect(actions.indexOf("copy-command")).toBe(2);
        // A live card with a composer: both runs stand, and the missing brief
        // dims neither.
        expect(rows[0].disabled).toBe(false);
        expect(rows[1].disabled).toBe(false);
        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0560] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
        writeFileSync(join(projectDir, BRIEF), "# A thing\n");
      }
    },
    TEST_TIMEOUT_MS,
  );
});
