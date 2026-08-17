/**
 * at0280-shared-agent-absent.test.ts — what the app looks like with no agent.
 *
 * Shell arbitration and PULSE intent summaries are strict enhancement: with the
 * `SharedAgent` unavailable, nothing about the app changes. That claim is easy
 * to state and easy to break, because both tenants live on surfaces people touch
 * constantly — the PULSE strip and the prompt composer. This pins the agentless
 * posture so a regression shows up as a failing test rather than as a stray line
 * or a chip nobody asked for.
 *
 * **The forcing mechanism is the app-test gate itself ([P08]).** The pool
 * refuses to spawn a worker when `TUGAPP_APP_TEST=1` is in the environment, and
 * the harness launches every instance with it — the variable reaches tugcast
 * because `ProcessManager.swift` seeds the tugcast child's environment from the
 * app's own. So the agentless posture is what every app-test instance has, on
 * every machine, with nothing to seed. Deliberately **no tugbank kill switches
 * are written here**: seeding them would let this test pass for a reason other
 * than the one it claims, and it would stop testing the gate.
 *
 * **The positive path cannot be covered here, by design.** No app-test may spend
 * subscription tokens, so no app-test can ever see a real verdict or a real
 * description. That path is covered by the on-demand real-claude worker test and by
 * the Rust fake-spawner suites (`shared_agent.rs`, `feeds/shell.rs`,
 * `feeds/session_synopsis.rs`); the submit-time routing logic is covered as pure
 * logic in `shell-line-classifier.test.ts` and the deck's parking and
 * correlation in `shell-classify-store.test.ts`.
 *
 * Three claims:
 *   1. The masthead renders its activity run, and there is no headline run at
 *      all — nor any `PULSE` ink standing in for one. With no agent no goal is
 *      ever composed, and the reading for that is now an absence rather than a
 *      placeholder word: the standing-goal level left chrome, so a session with
 *      nothing composed for it simply has two lines that say true things and no
 *      third that says a word. Never an invented goal, and never a line that
 *      quietly fabricates one from the activity beside it.
 *   2. Typing lines that open with a PATH executable — `make test`, `git
 *      status` — leaves the composer holding plain text: no routing chip, no
 *      atom of any kind. Routing is a submit-time decision over the whole
 *      line, so nothing may materialize in the document while the user types.
 *   3. The Lens's row for the same session shows no goal line either. The
 *      card's strip and the Lens row read the same PULSE state through two
 *      separate call sites, so absence has to be pinned on both.
 *
 * **Typing only — this test never submits a turn.** A real send into a
 * replay-backed harness session is out of bounds.
 *
 * Foreground: ⌘A is an Edit-menu key equivalent, so AppKit resolves it
 * against the main menu before the web view sees a keydown. A background
 * instance has no key window for that resolution to land in, and the
 * select-all that clears the editor never happens.
 *
 * @foreground
 *
 * @covers tugdeck/src/lib/shared-agent-store.ts
 * @covers tugdeck/src/lib/shell-classify-store.ts
 * @covers tugdeck/src/lib/shell-line-classifier.ts
 * @covers tugdeck/src/components/tugways/session-masthead.tsx
 * @covers tugdeck/src/components/lens/sections/cards-section.tsx
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, type App } from "./_harness";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch } from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

// UUID-shaped so the bound session reads as a real one.
const SID = "a7c0d1ea-0000-4000-8000-000000000280";

const CARD = '[data-card-id="A"]';
const PROMPT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const ATOM = `${CARD} [data-slot="tug-text-editor"] img[data-atom-type]`;
// The card's activity line lives in its pane chrome, on the masthead.
const PANE = '.tug-pane[data-pane-id="p1"]';
const MASTHEAD = `${PANE} [data-slot="session-masthead"]`;
const STRIP = `${MASTHEAD} .tug-pulse`;
const HEADLINE = `${PANE} [data-slot="tug-pulse-headline"]`;

// The Lens's own row for the same session. Addressed the way
// `at0257-lens-session-reorder.test.ts` addresses Sessions rows.
const LENS_ROW = `.lens-cards-list .session-row-content[data-session-id="${SID}"]`;
const LENS_INTENT = `${LENS_ROW} [data-slot="tug-pulse-headline"]`;

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "at0280-proj-")));
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session A", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 640 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

async function count(app: App, selector: string): Promise<number> {
  return app.evalJS<number>(
    `document.querySelectorAll(${JSON.stringify(selector)}).length`,
  );
}

/**
 * Everything the masthead has to say, as rendered text.
 *
 * The headline run's ABSENCE is what this file pins, and an absence is counted
 * rather than read — but a count alone would pass while a placeholder word
 * appeared on some other line, so the whole tier's ink is checked beside it.
 */
async function mastheadText(app: App): Promise<string> {
  return app.evalJS<string>(
    `(document.querySelector(${JSON.stringify(MASTHEAD)})
       || { innerText: "" }).innerText`,
  );
}

/**
 * Type `text` into the composer and block until the document reads exactly it.
 *
 * The wait is the point: anything the composer materializes on its own does so
 * in a microtask after the keystroke, so a document that still reads as plain
 * text once the WHOLE line has landed is a document nothing was inserted into.
 */
async function typeLine(app: App, text: string, replace = false): Promise<void> {
  await app.nativeClickAtElement(PROMPT);
  // Select-all before typing so the second line overwrites the first — one
  // gesture instead of a separate delete whose emptied-doc state is awkward to
  // wait on.
  if (replace) await app.nativeKey("a", ["cmd"]);
  await app.nativeType(text);
  await app.waitForCondition<boolean>(
    // Trimmed: the leading edge of the composer can carry a stray space from a
    // select-all-then-type gesture. The atom count below is what actually
    // decides the claim — an inserted chip renders as its own element, and
    // contributes nothing to `textContent`, so text alone cannot see it.
    `(function(){
       var el = document.querySelector(${JSON.stringify(PROMPT)});
       return el !== null && el.textContent.trim() === ${JSON.stringify(text)};
     })()`,
    { timeoutMs: 10_000 },
  );
}

describe.skipIf(!SHOULD_RUN)(
  "AT0280: with no shared agent, nothing about the app changes",
  () => {
    test(
      "the strip stays single-line and typing never auto-inserts the shell chip",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0280-shared-agent-absent",
          env: { TUGBANK_PATH: tugbankPath },
          foreground: true,
        });
        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );
          // Bound, not resumed: the composer and the PULSE are what this pins,
          // and neither needs a live agent behind them.
          await app.bindSession("A", { tugSessionId: SID, projectDir });
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(PROMPT)}) !== null`,
            { timeoutMs: 20_000 },
          );

          // 1. The activity line is there, and there is no headline run at all
          //    — no agent means no goal was ever composed, and an absent level
          //    is now an absence rather than a word standing in for one.
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(STRIP)}) !== null`,
            { timeoutMs: 20_000 },
          );
          expect(await count(app, HEADLINE)).toBe(0);
          expect(await mastheadText(app)).not.toContain("PULSE");

          // 2. Two lines that open with a real PATH executable — the exact
          //    shape that would be put to the agent when one is available.
          await typeLine(app, "make test");
          expect(await count(app, ATOM)).toBe(0);

          await typeLine(app, "git status", true);
          expect(await count(app, ATOM)).toBe(0);

          // Still no composed goal after all that activity.
          expect(await count(app, HEADLINE)).toBe(0);
          expect(await mastheadText(app)).not.toContain("PULSE");

          // 3. The Lens says the same thing. The strip and the Lens row are
          //    two separate readers of the same PULSE state, so a regression can
          //    land in one and not the other — the claim is only pinned where
          //    it is asserted.
          await app.dispatchControlAction("toggle-lens");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(LENS_ROW)}) !== null`,
            { timeoutMs: 10_000 },
          );
          // No goal line in the rail either, and no word standing in for one.
          expect(await count(app, LENS_INTENT)).toBe(0);
          expect(
            await app.evalJS<string>(
              `(document.querySelector(${JSON.stringify(LENS_ROW)})
                 || { innerText: "" }).innerText`,
            ),
          ).not.toContain("PULSE");
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
