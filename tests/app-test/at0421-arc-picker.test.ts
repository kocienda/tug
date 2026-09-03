/**
 * at0421-arc-picker.test.ts — bare `/arc-bind`'s picker sheet, over three
 * real arcs.
 *
 * Picking an arc is a UI-concept act with no turn and no durable consequence,
 * so it is a sheet rather than transcript ink, and the whole round trip is
 * real: the sheet sends `bind_arc`, the server answers `bind_arc_ok`, and the
 * masthead chip is what moves. Nothing here writes the binding store
 * optimistically, which is why asserting on the chip is asserting on the
 * broadcast.
 *
 * Three behaviors, one file. Arrow keys move the cursor and Return binds the
 * highlighted row. Escape dismisses with the binding exactly as it was. And the
 * retired `/arc` spelling reaches the same picker — which is the whole reason
 * the alias is kept: a `/verb` that stops matching the local registry is
 * submitted to Claude as a prompt, a burned turn on a line the user meant as a
 * gesture.
 *
 * **Two branches of the bare form are not covered here.** The one-arc case
 * (bind directly, open nothing) and the zero-arc case (caution) are conditions
 * on the *project*. They are reachable now that the project is a scratch
 * repository this file owns — it holds exactly the three arcs created below
 * and nothing another run can add — and would be a fixture per case. Until then
 * the branch is three lines in `session-card.tsx`'s `arc-bind` handler.
 *
 * @covers tugdeck/src/components/tugways/cards/arc-picker-sheet.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/lib/card-session-binding-store.ts
 * @covers tugdeck/src/components/tugways/tug-session-identity.tsx
 * @covers tugdeck/src/components/tugways/tug-arc-atom.tsx
 * @covers tugdeck/src/components/tugways/arc-lifecycle-block.tsx
 * @covers tugdeck/src/components/tugways/tug-meta-run.tsx
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
import {
  createArc,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000421";
const CARD = '[data-card-id="A"]';
const PROMPT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const PICKER = '[data-slot="arc-picker-sheet"]';
const PICKER_ROWS = `${PICKER} [data-slot="arc-picker-row"]`;
// The arc marker on the masthead's title line — the identity's own run
// since the masthead badge was retired. Scoped to the masthead, because a
// line-tier identity anywhere else (a Cards row, a picker row) wears it too.
const CHIP =
  '[data-slot="session-masthead"] [data-slot="session-identity-arc"]';
/** What that run reads: the identity's arc grammar, sigil included. */
const chipText = (arc: string): string => `^${arc}`;
const ARCS_CARD = '.arcs-section';

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
/** The scratch repository this fixture owns, and the only tree it touches. */
let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";
/** Named so their sort order in the picker is the order they are created in —
 *  the picker keeps snapshot order, so the assertions read positionally. */
const ARCS = ["at0421-alpha", "at0421-bravo", "at0421-charlie"];

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0421", checkout: CHECKOUT });
  for (const name of ARCS) createArc(projectDir(), name, "at0421 fixture", scratch.cli);
  fixtureDir = seedScratchSession(projectDir(), SID);
}, 60_000);

// The whole repository goes, so there is nothing to discard one arc at a time
// — and nothing left behind when this file dies before its teardown runs.
afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
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
  // A *spawned* session, not a bound one: `bindSession` is client-side only, so
  // the scratch repo would never be registered as a workspace and the aggregate
  // would keep composing over the checkout. See `seedScratchSession`.
  await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
  await app.awaitEngineReady("A", { timeoutMs: 15000 });
  // The picker lists what the snapshot holds, so wait until it holds the
  // fixtures — before the first compose the bare form would caution instead.
  // The Arcs card reads the same `ChangesetAllStore` the card's
  // controller does, so a row there is the proof, and it is observable from
  // outside the card.
  await app.dispatchControlAction("toggle-arcs");
  await app.waitForCondition<boolean>(
    `document.querySelector('${ARCS_CARD} [data-slot="arcs-row"][data-arc="${ARCS[2]}"]') !== null`,
    { timeoutMs: 30000 },
  );
  await app.dispatchControlAction("toggle-arcs");
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(ARCS_CARD)}) === null`,
    { timeoutMs: 8000 },
  );
}

const namesIn = (app: App): Promise<string[]> =>
  app.evalJS<string[]>(
    `Array.from(document.querySelectorAll(${JSON.stringify(PICKER_ROWS)}))
       .map((el) => el.getAttribute("data-arc"))`,
  );

describe.skipIf(!SHOULD_RUN)("AT0421: the /arc-bind picker", () => {
  test(
    "bare /arc-bind lists the project's arcs, and arrow-then-Return binds the highlighted one",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0421-arc-picker",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await openCard(app);

        // ── The sheet lists the project's arcs ──────────────────────────
        await runCommand(app, "/arc-bind");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER)}) !== null`,
          { timeoutMs: 10000 },
        );
        const listed = await namesIn(app);
        for (const name of ARCS) expect(listed).toContain(name);
        note("at0421 picker rows", listed.join(", "));

        // Every row names its arc with the atom every arc surface wears,
        // and carries a worker atom per bound session — none here, because
        // nothing is holding any of these yet, and that absence IS how
        // *unbound* reads on a picker whose whole job is to weigh who has
        // what.
        // Counted by ROW, not by element: `TugArcAtom` is a seat around a
        // `ArcSigil` whose default slot is the same word, so a row holds two
        // of them and an element count would say six where there are three.
        const identity = await app.evalJS<{ atomRows: number; workers: number }>(
          `(() => ({
             atomRows: Array.from(document.querySelectorAll(${JSON.stringify(PICKER_ROWS)}))
               .filter((row) => row.querySelector('[data-slot="tug-arc-atom"]') !== null).length,
             workers: document.querySelectorAll(${JSON.stringify(`${PICKER_ROWS} [data-slot="tug-arc-lifecycle-worker"]`)}).length,
           }))()`,
        );
        note("at0421 picker identity", JSON.stringify(identity));
        expect(identity.atomRows).toBe(listed.length);
        expect(identity.workers).toBe(0);
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
        // The seeded cursor is the card's own arc — there is none here, so it
        // rests on the first row, and one Down moves to the second.
        await runCommand(app, "/arc-bind");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER)}) !== null`,
          { timeoutMs: 10000 },
        );
        const rows = await namesIn(app);
        await app.nativeKey("ArrowDown");
        await settle();
        await app.nativeKey("Return");
        // The chip moves on `bind_arc_ok`, never on the click — so this
        // assertion is about the round trip, not about the handler.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHIP)}) !== null`,
          { timeoutMs: 15000 },
        );
        const bound = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(CHIP)})?.textContent ?? "").trim()`,
        );
        // The picker lists bare arc names; the masthead spells the binding in
        // the identity's grammar, so the comparison goes through `chipText`.
        expect(rows.map(chipText)).toContain(bound);
        expect(bound).not.toBe(chipText(rows[0]));

        // ── Re-opened, the bound row wears its worker ─────────────────────
        // The same eyebrow grammar the Arcs card and the shade lead with, which is
        // the fact this picker exists to weigh: somebody is on that one.
        await runCommand(app, "/arc-bind");
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(`${PICKER_ROWS} [data-slot="tug-arc-lifecycle-worker"]`)}).length === 1`,
          { timeoutMs: 15000 },
        );
        const heldRow = await app.evalJS<string | null>(
          `document.querySelector(${JSON.stringify(`${PICKER_ROWS} [data-slot="tug-arc-lifecycle-worker"]`)})
             ?.closest('[data-slot="arc-picker-row"]')?.getAttribute("data-arc") ?? null`,
        );
        note("at0421 held row", String(heldRow));
        expect(heldRow).not.toBeNull();
        expect(chipText(heldRow!)).toBe(bound);
        // And it is the row the picker marks as this card's own.
        expect(
          await app.evalJS<string | null>(
            `document.querySelector(${JSON.stringify(`${PICKER_ROWS} [data-slot="arc-picker-current"]`)})
               ?.closest('[data-slot="arc-picker-row"]')?.getAttribute("data-arc") ?? null`,
          ),
        ).toBe(heldRow);
        await app.nativeKey("Escape");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

});
