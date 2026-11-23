/**
 * at0878-arc-shade-docket-doors.test.ts — the arc shade's Sketch and Brief
 * panels are doors into the Docket card when the arc is on a docket.
 *
 * ## What this gates
 *
 * The panels' press rules are DOM and CSS, and the lookup is a pure function
 * the unit tests pin (`docketForArc`). What only the app can show is the join
 * of two live feeds on one shade, a press that crosses into another card, and
 * that a door's press is the door's alone.
 *
 *   A. **On no docket, nothing changes.** With a live arc bound to Session
 *      card A and its shade raised, the Sketch panel is not pressable, a
 *      press on it opens nothing, and the Brief panel has no door.
 *   B. **Filed through an idea, the panels grow their doors.** An idea is
 *      captured on a docket, its sketch kept, and the arc adopts that sketch;
 *      the Sketch panel becomes pressable and the Brief panel shows
 *      "Open in Docket".
 *   C. **The Sketch panel opens the editor.** A press on it brings Docket
 *      card D to the editor on the arc's sketch.
 *   D. **The door opens the thread and expands nothing.** "Open in Docket"
 *      on the collapsed Brief panel marks the arc's thread in D, and the
 *      shade's panels stay at rest.
 *
 * @covers tugdeck/src/components/tugways/cards/session-arc-panels.tsx
 * @covers tugdeck/src/components/tugways/cards/session-arc-panels.css
 * @covers tugdeck/src/components/tugways/cards/session-arc-shade-content.tsx
 * @covers tugdeck/src/lib/open-docket-in-card.ts
 * @covers tugdeck/src/components/docket/docket-card.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { App } from "./_harness";
import { bindArc, createArc } from "./arc-fixture";
import { CHECKOUT } from "./arcs-card-fixture";
import {
  EDITOR,
  EDITOR_TEXT,
  EMPTY,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  awaitResponder,
  captureIdea,
  cli,
  ideaId,
  keepSketch,
  launchAuthoring,
  makeAuthoringScratch,
  newDocket,
  rmAuthoringScratch,
  type AuthoringScratch,
} from "./docket-authoring-fixture";

const SID = "aa11bb22-0000-4000-8000-00000000a878";
const ARC = "at0878-doors";
const IDEA = "doors from the shade into the docket";
const WANT = "Want doors from the arc shade into the docket.";

const CARD = '[data-card-id="A"]';
const SHADE = `${CARD} [data-slot="session-arc-shade"]`;
const SLOT = `${CARD} .session-view-slot`;
const PANELS = `${SHADE} [data-slot="session-arc-panels"]`;
const SKETCH_PANEL = `${SHADE} [data-slot="session-arc-panel"][data-rung="sketch"]`;
const SKETCH_HEAD = `${SKETCH_PANEL} .session-arc-panel-head`;
const DOOR = `${SHADE} [data-slot="session-arc-docket-door"]`;
const DOOR_BUTTON = `${DOOR} button`;

let s: AuthoringScratch | null = null;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  s = makeAuthoringScratch("at0878", SID);
  createArc(s.scratch.repo, ARC, "at0878 fixture", s.scratch.cli);
});

afterAll(() => {
  rmAuthoringScratch(s);
});

/** Raise A's arc shade and wait for it to settle against its slot. */
async function raiseShade(app: App): Promise<void> {
  const raised = await app.body("A").evalJS<boolean>(
    `(function(){ var s = document.querySelector(${JSON.stringify(SHADE)}); return s !== null && s.getAttribute("data-raised") === "true"; })()`,
  );
  if (!raised) {
    await app.dispatchControlAction("focus-session-card", { cardId: "A" });
    await awaitResponder(app, "A");
    await app.dispatchControlAction("toggle-arc-shade");
  }
  await app.body("A").waitForCondition<boolean>(
    `(function(){
      var s = document.querySelector(${JSON.stringify(SHADE)});
      var slot = document.querySelector(${JSON.stringify(SLOT)});
      if (s === null || slot === null || s.getAttribute("data-raised") !== "true") return false;
      return Math.abs(s.getBoundingClientRect().bottom - slot.getBoundingClientRect().bottom) <= 1;
    })()`,
    { timeoutMs: 10_000 },
  );
}

describe.skipIf(!SHOULD_RUN)("at0878 — the arc shade's docket doors", () => {
  test(
    "an arc on a docket opens the editor from Sketch and the thread from Brief's door; on none, neither",
    async () => {
      const { app, close } = await launchAuthoring(s!, "at0878-arc-shade-docket-doors");
      try {
        bindArc(s!.scratch.repo, ARC, SID, { binaryRoot: CHECKOUT, env: s!.scratch.cli.env });
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PANELS)}) !== null`,
          { timeoutMs: 20_000 },
        );

        // ---- A. On no docket, nothing changes. -----------------------------
        await raiseShade(app);
        expect(
          await app.body("A").evalJS<{ pressable: string | null; door: boolean }>(
            `({ pressable: document.querySelector(${JSON.stringify(SKETCH_PANEL)}).getAttribute("data-pressable"),
                door: document.querySelector(${JSON.stringify(DOOR)}) !== null })`,
          ),
        ).toEqual({ pressable: null, door: false });
        await app.body("A").nativeClickAtElement(SKETCH_HEAD);
        // The press had nowhere to go: D still has no docket to show, let
        // alone an editor, and the panels did not expand.
        expect(
          await app.body("D").evalJS<boolean>(
            `document.querySelector(${JSON.stringify(EDITOR)}) === null
             && (document.querySelector(${JSON.stringify(EMPTY)}) || { textContent: "" }).textContent.trim() === "No dockets"`,
          ),
        ).toBe(true);
        expect(
          await app.body("A").evalJS<string | null>(
            `document.querySelector(${JSON.stringify(PANELS)}).getAttribute("data-expanded")`,
          ),
        ).toBeNull();

        // ---- B. Filed through an idea, the panels grow their doors. --------
        await newDocket(app, "Shade doors");
        await captureIdea(app, IDEA);
        const sketch = keepSketch(s!, ideaId(s!, IDEA), WANT, "1–2");
        const docs = join(s!.scratch.repo, ".tug", "arcs", ARC);
        mkdirSync(docs, { recursive: true });
        writeFileSync(join(docs, "sketch.md"), `# Sketch\n\n${WANT}\n\nSource: session ${SID}, turns 1–2\n`);
        cli(s!, ["sketch", "record", ARC, "--sketch", sketch]);
        await raiseShade(app);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DOOR)}) !== null
           && document.querySelector(${JSON.stringify(SKETCH_PANEL)}).getAttribute("data-pressable") === "true"`,
          { timeoutMs: 20_000 },
        );
        const ARC_ROW = `Array.from(document.querySelectorAll('[data-slot="docket-thread-row"]')).find(function (r) {
              return r.querySelector('[data-slot="docket-arc-cell"]') !== null;
            })`;
        await app.body("D").waitForCondition<boolean>(`${ARC_ROW} !== undefined`, { timeoutMs: 10_000 });
        const threadKey = await app.body("D").evalJS<string | null>(
          `(function(){
            var row = ${ARC_ROW};
            return row === undefined ? null : row.getAttribute("data-thread-key");
          })()`,
        );
        expect(threadKey, "the arc's thread is on the docket").not.toBeNull();

        // ---- C. The Sketch panel opens the editor. -------------------------
        await app.body("A").nativeClickAtElement(SKETCH_HEAD);
        await app.body("D").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(EDITOR_TEXT)}) !== null
           && document.querySelector(${JSON.stringify(EDITOR_TEXT)}).value.indexOf(${JSON.stringify(WANT)}) !== -1`,
          { timeoutMs: 10_000 },
        );
        await app.dispatchControlAction("focus-pane", { paneId: "p2" });
        await app.body("D").nativeClickAtElement('[data-testid="docket-sketch-cancel"]');
        await app.body("D").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(EDITOR)}) === null`,
          { timeoutMs: 5_000 },
        );

        // ---- D. The door opens the thread and expands nothing. -------------
        await app.body("D").evalJS<null>(
          `(function(){ document.querySelectorAll("[data-focused]").forEach(function (el) { el.removeAttribute("data-focused"); }); return null; })()`,
        );
        await raiseShade(app);
        await app.body("A").nativeClickAtElement(DOOR_BUTTON);
        await app.body("D").waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector('[data-focused="true"]');
            if (el === null) return false;
            var row = el.closest("[data-thread-key]") || el.querySelector("[data-thread-key]");
            return row !== null && row.getAttribute("data-thread-key") === ${JSON.stringify(threadKey)};
          })()`,
          { timeoutMs: 10_000 },
        );
        expect(
          await app.body("A").evalJS<string | null>(
            `document.querySelector(${JSON.stringify(PANELS)}).getAttribute("data-expanded")`,
          ),
          "the door's press expanded no panel",
        ).toBeNull();
        expect(
          await app.body("D").evalJS<boolean>(`document.querySelector(${JSON.stringify(EDITOR)}) === null`),
          "the door opens the thread, not the editor",
        ).toBe(true);
      } finally {
        await close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
