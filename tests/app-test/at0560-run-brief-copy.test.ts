/**
 * at0560-run-brief-copy.test.ts — `Copy Command` on a transcript `/arc`
 * line puts the line on the pasteboard, unchanged, and runs nothing.
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
  LINE,
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
    "Copy Command puts the line on the pasteboard and runs nothing",
    async () => {
      const app = await seedCardWithCommandLine(projectDir, "at0560-run-brief-copy");
      try {
        await openCommandMenu(app);
        await pickMenuItem(app, "copy-command");

        await app.waitForCondition<boolean>(
          `(function(){
            var w = window;
            var bridge = w.webkit && w.webkit.messageHandlers && w.webkit.messageHandlers.clipboardRead;
            if (!bridge || typeof bridge.postMessage !== "function") return true;
            if (w.__at0560Clip !== undefined) return w.__at0560Clip !== null;
            w.__at0560Clip = null;
            var id = "at0560-" + Math.random().toString(36).slice(2);
            var prior = w.__tugBridge.onClipboardRead;
            w.__tugBridge.onClipboardRead = function(data){
              if (!data || data.requestId !== id) {
                if (typeof prior === "function") prior(data);
                return;
              }
              w.__tugBridge.onClipboardRead = prior;
              w.__at0560Clip = typeof data.text === "string" ? data.text : "";
            };
            bridge.postMessage({ requestId: id });
            return false;
          })()`,
          { timeoutMs: 15_000 },
        );
        const clip = await app.evalJS<string | null>(
          `(function(){
            var w = window;
            var bridge = w.webkit && w.webkit.messageHandlers && w.webkit.messageHandlers.clipboardRead;
            if (!bridge) return null;
            return typeof w.__at0560Clip === "string" ? w.__at0560Clip : null;
          })()`,
        );
        // No native pasteboard bridge in a browser-mode run: the copy has
        // nowhere to land and there is nothing to assert about it. The rest
        // of the test — that copying runs nothing — still holds.
        if (clip !== null) expect(clip).toContain(LINE);

        // A copy is not a run: the composer is empty and no card was opened.
        const here = await app.body("A").evalJS<string>(
          `(function(){
            var cm = document.querySelector(${JSON.stringify(PROMPT_INPUT)});
            return cm ? (cm.textContent || '') : '';
          })()`,
        );
        expect(here.indexOf(BRIEF)).toBe(-1);
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
