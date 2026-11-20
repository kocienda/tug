/**
 * at0862-new-arc-menu.test.ts — File ▸ New Arc opens a Session card on its
 * picker, and the session the picker binds runs `/arc` as its first turn.
 *
 * What is read:
 *
 *   1. The File menu holds New Arc, live, and performing it adds a second
 *      Session card beside the one on the deck, unbound and showing its
 *      picker in its own body.
 *   2. Choosing a project there and pressing Open sends the `/arc` command as
 *      that session's first turn, once, from the card's own runner: the
 *      command was held from the menu gesture, across the card's hand-off to
 *      its body, until the picker bound it.
 *   3. The card that was already on the deck runs nothing.
 *
 * @covers tugdeck/src/body/body-intent.ts
 * @covers tugdeck/src/lib/opening-command-runner.ts
 * @covers tugapp/Sources/MenuBarBuilder.swift
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "./_harness";
import { waitForBodyReady } from "./_harness/card-reach";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch } from "./_harness/tugbank-helpers";
import { OPEN, PICKER_FORM, deckShape } from "./fixtures/runner";
import { CHOOSE_OTHER_FOLDER, PICKER_PATH_FIELD } from "./picker-sessions-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  // realpath: the picker resolves `/var` to `/private/var` before it names a row.
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "at0862-new-arc-")));
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
});

interface LifecycleEvent {
  kind: string;
  event?: string;
  fields?: { card_id?: string; name?: string };
}

describe.skipIf(!SHOULD_RUN)("AT0862: File ▸ New Arc", () => {
  test(
    "New Arc opens a Session card whose first turn, once it has a session, is /arc",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const app = await launchTugApp({
        testName: "at0862-new-arc-menu",
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await waitForBodyReady(app, "A");

        // ── The menu item, performed as the menu performs it ──────────────
        const performed = await app.performMenuItem("file.newArc");
        note("at0862 menu item", JSON.stringify(performed));
        expect(performed.found, "the File menu holds New Arc").toBe(true);
        if (!performed.found) return;
        expect(performed.title).toBe("New Arc");
        expect(performed.enabled && performed.performed, "New Arc is live and performs").toBe(true);

        // ── A second Session card, on its picker ──────────────────────────
        // card-dom: shell — the deck's cards: one placeholder per card in the shell.
        const newCardId = await app.waitForCondition<string>(
          `(function(){
            var ids = Array.from(document.querySelectorAll('[data-card-id]')).map(function(el){
              return el.getAttribute('data-card-id');
            }).filter(function(id){ return id !== "A"; });
            return ids.length === 1 ? ids[0] : null;
          })()`,
          { timeoutMs: 15_000 },
        );
        const page = await waitForBodyReady(app, newCardId);
        await page.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER_FORM)}) !== null`,
          { timeoutMs: 8_000 },
        );

        // ── Choose a project and open a new session in it ─────────────────
        expect(await page.evalJS<boolean>(CHOOSE_OTHER_FOLDER)).toBe(true);
        await page.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER_PATH_FIELD)}) !== null`,
          { timeoutMs: 5_000 },
        );
        await page.evalJS<boolean>(
          `(function(){
            var input = document.querySelector(${JSON.stringify(PICKER_PATH_FIELD)});
            var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
            setter.call(input, ${JSON.stringify(projectDir)});
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.blur();
            return true;
          })()`,
        );
        await page.waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(PICKER_PATH_FIELD)});
            return el !== null && el.value === ${JSON.stringify(projectDir)};
          })()`,
          { timeoutMs: 8_000 },
        );
        // The typed folder is a group of its own, and its New session row
        // names it: that row and no other project's.
        const newRow = `[data-testid="session-card-picker-session-new"][data-project-dir=${JSON.stringify(projectDir)}]`;
        await page.waitForCondition<boolean>(
          `(function(){
            var row = document.querySelector(${JSON.stringify(newRow)});
            if (row === null) return false;
            if (row.getAttribute("data-selected") === "true") return true;
            row.scrollIntoView({ block: "nearest" });
            row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            return false;
          })()`,
          { timeoutMs: 15_000 },
        );
        await page.evalJS<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(OPEN)});
            if (el === null) return false;
            el.scrollIntoView({ block: "nearest" });
            el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            return true;
          })()`,
        );

        // ── The session's first turn is the command ───────────────────────
        // Each page keeps its own trace. The window covers the runner's
        // catalog deadline, for a harness claude that never sends a catalog.
        const sentIn = async (): Promise<LifecycleEvent[]> => {
          const traces = [await app.getDeckTrace({})];
          for (const b of await app.bodies()) {
            if (b.cardId !== null) traces.push(await app.body(b.cardId).getDeckTrace({}));
          }
          return (traces.flat() as LifecycleEvent[]).filter(
            (e) => e.kind === "session-lifecycle" && e.event === "opening_command.sent",
          );
        };
        const deadline = Date.now() + 30_000;
        let sent = await sentIn();
        while (sent.length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 250));
          sent = await sentIn();
        }
        note("at0862 sent", JSON.stringify(sent));
        expect(sent.length, "the command went out once").toBe(1);
        expect(sent[0]?.fields?.card_id, "from the card New Arc opened").toBe(newCardId);
        expect(sent[0]?.fields?.name, "and it is the arc door").toMatch(/(^|:)arc$/);

        // The card's own row for the turn is in its transcript.
        await page.waitForCondition<boolean>(
          `document.querySelectorAll('[data-testid="session-card-transcript-user-body"]').length === 1`,
          { timeoutMs: 15_000 },
        );
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
