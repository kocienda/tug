/**
 * at0421-dash-picker.test.ts — bare `/dash-bind`'s picker sheet, over three
 * real dashes.
 *
 * Picking a dash is a UI-concept act with no turn and no durable consequence,
 * so it is a sheet rather than transcript ink, and the whole round trip is
 * real: the sheet sends `bind_dash`, the server answers `bind_dash_ok`, and the
 * masthead chip is what moves. Nothing here writes the binding store
 * optimistically, which is why asserting on the chip is asserting on the
 * broadcast.
 *
 * Three behaviors, one file. Arrow keys move the cursor and Return binds the
 * highlighted row. Escape dismisses with the binding exactly as it was. And the
 * retired `/dash` spelling reaches the same picker — which is the whole reason
 * the alias is kept: a `/verb` that stops matching the local registry is
 * submitted to Claude as a prompt, a burned turn on a line the user meant as a
 * gesture.
 *
 * **Two branches of the bare form are not covered here, and cannot be.** The
 * one-dash case (bind directly, open nothing) and the zero-dash case (caution)
 * are conditions on the *project*, and the project is this repository — which
 * always holds at least the dash this test's own fixtures live beside, plus
 * whatever every other dash-touching app-test has in flight. Driving either
 * would mean releasing dashes out from under a parallel run. The branch is
 * three lines in `session-card.tsx`'s `dash-bind` handler and is read there.
 *
 * @covers tugdeck/src/components/tugways/cards/dash-picker-sheet.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/lib/card-session-binding-store.ts
 * @covers tugdeck/src/components/tugways/tug-session-identity.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import { createDash, discardDash } from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "at0421-session";
const CARD = '[data-card-id="A"]';
const PROMPT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const PICKER = '[data-slot="dash-picker-sheet"]';
const PICKER_ROWS = `${PICKER} [data-slot="dash-picker-row"]`;
// The dash marker on the masthead's title line — the identity's own run
// since the masthead badge was retired. Scoped to the masthead, because a
// line-tier identity anywhere else (a Lens row, a picker row) wears it too.
const CHIP =
  '[data-slot="session-masthead"] [data-slot="session-identity-dash"]';
/** What that run reads: the identity's dash grammar, sigil included. */
const chipText = (dash: string): string => `◊${dash}`;
const LENS_SECTION = '.lens-section[data-lens-section="dashes"]';

const PROJECT_DIR = realpathSync(resolve(import.meta.dir, "..", ".."));
/** Named so their sort order in the picker is the order they are created in —
 *  the picker keeps snapshot order, so the assertions read positionally. */
const DASHES = ["at0421-alpha", "at0421-bravo", "at0421-charlie"];

beforeAll(() => {
  if (!SHOULD_RUN) return;
  for (const name of DASHES) createDash(PROJECT_DIR, name, "at0421 fixture");
}, 60_000);

// Three real worktree teardowns, each a git subprocess, so this needs more
// than the 5s a hook gets by default — a timed-out cleanup fails the file
// while every assertion in it passed.
afterAll(() => {
  if (!SHOULD_RUN) return;
  for (const name of DASHES) discardDash(PROJECT_DIR, name);
}, 60_000);

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 680 },
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

const settle = (ms = 200): Promise<unknown> =>
  new Promise((r) => setTimeout(r, ms));

/** Type a command into the card's prompt and submit it. */
async function runCommand(app: App, line: string): Promise<void> {
  await app.nativeClickAtElement(PROMPT);
  await app.nativeType(line);
  await settle();
  // Dismiss the slash completion popup so Enter submits rather than accepting.
  await app.nativeKey("Escape");
  await settle();
  await app.nativeKey("Return", ["cmd"]);
}

/** Bring up a card that has answered its first aggregate compose. A picker
 *  opened before that would be picking from an empty list. */
async function openCard(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  await app.bindSession("A", {
    tugSessionId: SID,
    projectDir: PROJECT_DIR,
    workspaceKey: PROJECT_DIR,
  });
  await app.awaitEngineReady("A", { timeoutMs: 15000 });
  app.seedLedger({
    sessions: [
      {
        session_id: SID,
        workspace_key: PROJECT_DIR,
        project_dir: PROJECT_DIR,
        card_id: "A",
        name: "at0421 work",
      },
    ],
  });
  // The picker lists what the snapshot holds, so wait until it holds the
  // fixtures — before the first compose the bare form would caution instead.
  // The Lens's Dashes section reads the same `ChangesetAllStore` the card's
  // controller does, so a row there is the proof, and it is observable from
  // outside the card.
  await app.dispatchControlAction("toggle-lens");
  await app.waitForCondition<boolean>(
    `document.querySelector('${LENS_SECTION} [data-slot="lens-dashes-row"][data-dash="${DASHES[2]}"]') !== null`,
    { timeoutMs: 30000 },
  );
  await app.dispatchControlAction("toggle-lens");
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(LENS_SECTION)}) === null`,
    { timeoutMs: 8000 },
  );
}

const namesIn = (app: App): Promise<string[]> =>
  app.evalJS<string[]>(
    `Array.from(document.querySelectorAll(${JSON.stringify(PICKER_ROWS)}))
       .map((el) => el.getAttribute("data-dash"))`,
  );

describe.skipIf(!SHOULD_RUN)("AT0421: the /dash-bind picker", () => {
  test(
    "bare /dash-bind lists the project's dashes, and arrow-then-Return binds the highlighted one",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: PROJECT_DIR });
      const app = await launchTugApp({
        testName: "at0421-dash-picker",
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        await openCard(app);

        // ── The sheet lists the project's dashes ──────────────────────────
        await runCommand(app, "/dash-bind");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER)}) !== null`,
          { timeoutMs: 10000 },
        );
        const listed = await namesIn(app);
        for (const name of DASHES) expect(listed).toContain(name);
        note("at0421 picker rows", listed.join(", "));
        note("at0421 picker", (await app.screenshot()).path);

        // ── Escape dismisses, and the binding is untouched ────────────────
        await app.nativeKey("Escape");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER)}) === null`,
          { timeoutMs: 8000 },
        );
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(CHIP)}).length`,
          ),
        ).toBe(0);

        // ── Arrow to a row, Return binds it ───────────────────────────────
        // The seeded cursor is the card's own dash — there is none here, so it
        // rests on the first row, and one Down moves to the second.
        await runCommand(app, "/dash-bind");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER)}) !== null`,
          { timeoutMs: 10000 },
        );
        const rows = await namesIn(app);
        await app.nativeKey("ArrowDown");
        await settle();
        await app.nativeKey("Return");
        // The chip moves on `bind_dash_ok`, never on the click — so this
        // assertion is about the round trip, not about the handler.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHIP)}) !== null`,
          { timeoutMs: 15000 },
        );
        const bound = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(CHIP)})?.textContent ?? "").trim()`,
        );
        // The picker lists bare dash names; the masthead spells the binding in
        // the identity's grammar, so the comparison goes through `chipText`.
        expect(rows.map(chipText)).toContain(bound);
        expect(bound).not.toBe(chipText(rows[0]));
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the retired /dash spelling reaches the same picker",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: PROJECT_DIR });
      const app = await launchTugApp({
        testName: "at0421-dash-picker-alias",
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        await openCard(app);
        await runCommand(app, "/dash");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER)}) !== null`,
          { timeoutMs: 10000 },
        );
        expect((await namesIn(app)).length).toBeGreaterThan(1);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
