/**
 * at0874-arc-card-docket.test.ts — the arc card names its docket.
 *
 * ## What this gates
 *
 * The arc shade's Arc panel draws one "On docket" line, with the docket's
 * atom, when the arc's thread is on a docket, and nothing when it is not.
 * The lookup is a pure function the unit tests pin (`docketForArc`); what
 * only the app can show is the join of two live feeds on one panel, and the
 * press that leaves it.
 *
 *   A. **An unfiled arc's panel is as it was.** With a live arc bound to a
 *      spawned Session card and its shade raised, the Arc panel has no
 *      docket line.
 *   B. **Filed, the panel names the docket.** The arc's atom, placed in the
 *      card's composer by its `@` completion and pasted into the Docket
 *      card's field, files it; the raised panel grows "On docket" and the
 *      docket's atom.
 *   C. **The press opens the docket at the arc's thread.** The Docket card
 *      is brought to the docket with the arc's thread marked `data-focused`.
 *   D. **Removed, the line goes.** Removed from the docket by its row menu,
 *      the arc's panel loses the line and its verb row stands where it stood
 *      before the arc was filed.
 *
 * Everything runs in a scratch repository under a scratch `TUG_DATA_DIR`
 * through this checkout's built `tugtool`, so nothing here touches the
 * user's own arcs or dockets.
 *
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-popovers.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-popovers.css
 * @covers tugdeck/src/lib/docket-store.ts
 * @covers tugdeck/src/lib/open-docket-in-card.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  bindArc,
  createArc,
  makeArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  type ArcScratchRepo,
} from "./arc-fixture";
import { CHECKOUT } from "./arcs-card-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "aa11bb22-0000-4000-8000-00000000a874";
const NAME = "Rail work";
// A name no docket's matches, so its `@` completion offers the arc alone.
const ARC = "at0874-link";

const CARD = '[data-card-id="A"]';
const COMPOSER = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const COMPLETION_ITEMS = '[data-slot="tug-completion-menu"] .tug-completion-menu-item';
const SHADE = `${CARD} [data-slot="session-arc-shade"]`;
const SLOT = `${CARD} .session-view-slot`;
const ARC_PANEL = `${SHADE} [data-slot="session-arc-panel"][data-rung="arc"]`;
const VERB_ROW = `${ARC_PANEL} [data-slot="arc-verb-row"]`;
const ON_DOCKET = `${ARC_PANEL} [data-slot="session-arc-popover-docket"]`;
const ON_DOCKET_OPEN = `${ARC_PANEL} [data-slot="session-arc-popover-docket-open"]`;

const CHOOSER = '.docket-chooser [data-slot="tug-popup-button"]';
const CHOOSER_ITEM = (i: number) => `[data-testid="docket-chooser"] .tug-menu-item[data-item-id="${i}"]`;
const DIALOG_FIELD = '[data-slot="tug-modal-input-dialog-field"]';
const EMPTY = '[data-slot="docket-empty"]';
const HEADER_ATOM = '[data-slot="docket-card-atom"] [data-atom-type="docket"]';
const FIELD = '[data-testid="docket-filing-field"]';
const FIELD_CONTENT = `${FIELD} .cm-content`;
const ROW = '[data-slot="docket-thread-row"]';
const MENU_ITEMS = '[data-slot="tug-editor-context-menu"] [role="menuitem"]';

let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0874", checkout: CHECKOUT });
  createArc(scratch.repo, ARC, "at0874 fixture", scratch.cli);
  // A resume needs a transcript to replay, or the card stays on its picker.
  fixtureDir = seedScratchSession(scratch.repo, SID);
});

afterAll(() => {
  if (fixtureDir !== "") rmScratchSession(fixtureDir);
  if (scratch === null) return;
  rmSync(scratch.repo, { recursive: true, force: true });
  rmSync(scratch.dataRoot, { recursive: true, force: true });
});

/** This checkout's tugtool, in the scratch repo, against the scratch data. */
function cli(args: string[]): string {
  const s = scratch!;
  return tugtool(args, { cwd: s.repo, binaryRoot: s.cli.binaryRoot, env: s.cli.env });
}

function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
      { id: "D", componentId: "docket", title: "Docket", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 20, y: 20 },
        size: { width: 700, height: 900 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
      {
        id: "p2",
        position: { x: 740, y: 20 },
        size: { width: 600, height: 520 },
        cardIds: ["D"],
        activeCardId: "D",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "p2",
    hasFocus: true,
  };
}

/** Wait until `cardId`'s view is the window's first responder. */
async function awaitResponder(app: App, cardId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await app.bodies()).some((b) => b.cardId === cardId && b.firstResponder === true)) {
    if (Date.now() > deadline) throw new Error(`${cardId}'s view never became the first responder`);
    await Bun.sleep(50);
  }
}

/**
 * Open the chooser by a real press and wait for its items to stand. A press
 * into a card that is not yet key may only raise it, so a second press
 * follows when the first opened nothing, as a hand would.
 */
async function openChooser(app: App): Promise<void> {
  const open = `document.querySelector(${JSON.stringify(CHOOSER_ITEM(0))}) !== null`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await app.body("D").nativeClickAtElement(CHOOSER);
    try {
      await app.body("D").waitForCondition<boolean>(open, { timeoutMs: 1_500 });
      return;
    } catch {
      // Raised, not opened; press again.
    }
  }
  throw new Error("the docket chooser never opened");
}

/** Open the chooser and press the item whose label is `label`. */
async function pickFromChooser(app: App, label: string): Promise<void> {
  await app.dispatchControlAction("focus-pane", { paneId: "p2" });
  await openChooser(app);
  const labels = await app.body("D").evalJS<string[]>(
    `Array.from(document.querySelectorAll('[data-testid="docket-chooser"] .tug-menu-item')).map(function (el) { return (el.textContent || "").trim(); })`,
  );
  const index = labels.indexOf(label);
  expect(index, `the chooser offers ${label} (it offered ${labels.join(" | ")})`).toBeGreaterThan(-1);
  await app.body("D").nativeClickAtElement(CHOOSER_ITEM(index));
}

/** Raise or lower A's arc shade and wait for it to settle against its slot. */
async function shade(app: App, raised: boolean): Promise<void> {
  const now = await app.body("A").evalJS<boolean>(
    `(function(){ var s = document.querySelector(${JSON.stringify(SHADE)}); return s !== null && s.getAttribute("data-raised") === "true"; })()`,
  );
  if (now !== raised) {
    await app.dispatchControlAction("focus-session-card", { cardId: "A" });
    await awaitResponder(app, "A");
    await app.dispatchControlAction("toggle-arc-shade");
  }
  await app.body("A").waitForCondition<boolean>(
    `(function(){
      var s = document.querySelector(${JSON.stringify(SHADE)});
      var slot = document.querySelector(${JSON.stringify(SLOT)});
      if (s === null || slot === null) return false;
      if (s.getAttribute("data-raised") !== ${JSON.stringify(raised ? "true" : "false")}) return false;
      var a = s.getBoundingClientRect(), b = slot.getBoundingClientRect();
      return ${raised ? "Math.abs(a.bottom - b.bottom) <= 1" : "a.top >= b.bottom - 1"};
    })()`,
    { timeoutMs: 10_000 },
  );
}

/**
 * The Arc panel's verb row, measured from the panel's own top and left, so a
 * scroll of the shade around the panel does not move it.
 */
function verbRowBox(app: App): Promise<{ t: number; l: number }> {
  return app.body("A").evalJS<{ t: number; l: number }>(
    `(function(){
      var r = document.querySelector(${JSON.stringify(VERB_ROW)}).getBoundingClientRect();
      var p = document.querySelector(${JSON.stringify(ARC_PANEL)}).getBoundingClientRect();
      return { t: r.top - p.top, l: r.left - p.left };
    })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0874 — the arc card names its docket", () => {
  test(
    "a filed arc's panel names its docket, opens it at the thread, and loses the line when removed",
    async () => {
      const s = scratch!;
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0874-arc-card-docket",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: s.dataRoot },
      });
      try {
        await app.seedDeckState({
          state: deckShape(),
          cardStates: { D: { content: { projectDir: s.repo } } },
          focusCardId: "D",
        });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: s.repo });
        await app.awaitEngineReady("A", { timeoutMs: 15_000 });
        bindArc(s.repo, ARC, SID, { binaryRoot: CHECKOUT, env: s.cli.env });

        // A docket to file on, made from the card.
        await app.body("D").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(EMPTY)}) !== null
           && (document.querySelector(${JSON.stringify(EMPTY)}).textContent || "").trim() === "No dockets"`,
          { timeoutMs: 20_000 },
        );
        await pickFromChooser(app, "New Docket…");
        await app.body("D").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DIALOG_FIELD)}) !== null`,
          { timeoutMs: 5_000 },
        );
        await app.nativeType(NAME);
        await app.body("D").waitForCondition<boolean>(
          `document.querySelector('[data-slot="tug-modal-input-dialog-list"]') !== null
           && (document.querySelector('[data-slot="tug-modal-input-dialog-list"]').textContent || "").indexOf(${JSON.stringify(NAME)}) !== -1`,
          { timeoutMs: 5_000 },
        );
        await app.nativeKey("Return");
        await app.body("D").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(HEADER_ATOM)}) !== null`,
          { timeoutMs: 10_000 },
        );
        const id = await app.body("D").evalJS<string | null>(
          `document.querySelector(${JSON.stringify(HEADER_ATOM)}).getAttribute("data-atom-value")`,
        );
        expect(id, "the header names the new docket").not.toBeNull();

        // ---- A. An unfiled arc's panel is as it was. -----------------------
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${SHADE} [data-slot="session-arc-panels"]`)}) !== null`,
          { timeoutMs: 20_000 },
        );
        await shade(app, true);
        const unfiled = await verbRowBox(app);
        expect(
          await app.body("A").evalJS<boolean>(`document.querySelector(${JSON.stringify(ON_DOCKET)}) === null`),
          "an arc on no docket draws no docket line",
        ).toBe(true);
        await shade(app, false);

        // ---- B. Filed, the panel names the docket. -------------------------
        await app.body("A").focusElement(COMPOSER);
        await app.nativeType(`@${ARC}`);
        // A real session's file completion offers the arc's worktree paths
        // above the arc itself, so the arc's own row is pressed by name.
        await app.body("A").waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(${JSON.stringify(COMPLETION_ITEMS)})).some(function (el) { return (el.textContent || "").trim() === ${JSON.stringify(ARC)}; })`,
          { timeoutMs: 15_000 },
        );
        await app.body("A").evalJS<null>(
          `(function(){ var el = Array.from(document.querySelectorAll(${JSON.stringify(COMPLETION_ITEMS)})).find(function (e) { return (e.textContent || "").trim() === ${JSON.stringify(ARC)}; }); el.setAttribute("data-at0874-arc", "1"); return null; })()`,
        );
        await app.body("A").nativeClickAtElement('[data-at0874-arc="1"]');
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('${COMPOSER} [data-atom-type="arc"]') !== null`,
          { timeoutMs: 10_000 },
        );
        await app.nativeKey("a", ["cmd"]);
        const copied = await app.performMenuItem("edit.copy");
        expect(copied.found && copied.performed, "Edit ▸ Copy performs").toBe(true);
        await app.dispatchControlAction("focus-pane", { paneId: "p2" });
        await app.body("D").nativeClickAtElement(FIELD);
        await awaitResponder(app, "D");
        const pasted = await app.performMenuItem("edit.paste");
        expect(pasted.found && pasted.performed, "Edit ▸ Paste performs").toBe(true);
        await app.body("D").waitForCondition<boolean>(
          `document.querySelector('${ROW} [data-slot="docket-arc-cell"]') !== null
           && document.querySelector('${FIELD_CONTENT} [data-atom-type]') === null`,
          { timeoutMs: 15_000 },
        );
        const threadKey = await app.body("D").evalJS<string | null>(
          `(document.querySelector(${JSON.stringify(ROW)}).closest("[data-thread-key]") || { getAttribute: function () { return null; } }).getAttribute("data-thread-key")`,
        );
        expect(threadKey, "the filed arc's row carries its thread key").not.toBeNull();

        await shade(app, true);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${ON_DOCKET_OPEN} [data-atom-type="docket"]`)}) !== null`,
          { timeoutMs: 15_000 },
        );
        const line = await app.body("A").evalJS<{ text: string; value: string | null }>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(ON_DOCKET)});
            return {
              text: (el.textContent || "").replace(/\\s+/g, " ").trim(),
              value: el.querySelector('[data-atom-type="docket"]').getAttribute("data-atom-value"),
            };
          })()`,
        );
        note("at0874 docket line", JSON.stringify(line));
        expect(line.text).toContain("On docket");
        expect(line.value).toBe(id);

        // ---- C. The press opens the docket at the arc's thread. ------------
        await app.body("D").evalJS<null>(
          `(function(){ document.querySelectorAll("[data-focused]").forEach(function (el) { el.removeAttribute("data-focused"); }); return null; })()`,
        );
        // The line sits in the panel's scroller under the arc's head, so it is
        // brought into view first, as a hand would scroll to it.
        await app.body("A").evalJS<null>(
          `(function(){ document.querySelector(${JSON.stringify(ON_DOCKET_OPEN)}).scrollIntoView({ block: "center" }); return null; })()`,
        );
        await app.body("A").nativeClickAtElement(ON_DOCKET_OPEN);
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
          (await app.bodies()).filter((b) => b.componentId === "docket").map((b) => b.cardId),
          "the open raised the card already on the docket, not a second one",
        ).toEqual(["D"]);

        // ---- D. Removed, the line goes. ------------------------------------
        await app.dispatchControlAction("focus-pane", { paneId: "p2" });
        await app.body("D").nativeRightClickAtElement(ROW);
        await app.body("D").waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(${JSON.stringify(MENU_ITEMS)})).some(function (el) { return (el.textContent || "").trim() === "Remove from Docket"; })`,
          { timeoutMs: 5_000 },
        );
        await app.body("D").evalJS<null>(
          `(function(){ var el = Array.from(document.querySelectorAll(${JSON.stringify(MENU_ITEMS)})).find(function (e) { return (e.textContent || "").trim() === "Remove from Docket"; }); el.setAttribute("data-at0874-target", "1"); return null; })()`,
        );
        await app.body("D").nativeClickAtElement('[data-at0874-target="1"]');
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ON_DOCKET)}) === null`,
          { timeoutMs: 15_000 },
        );
        await shade(app, true);
        const removed = await verbRowBox(app);
        note("at0874 verb row", JSON.stringify({ unfiled, removed }));
        expect(Math.abs(removed.t - unfiled.t), "the verb row stands where it stood").toBeLessThanOrEqual(0.5);
        expect(Math.abs(removed.l - unfiled.l)).toBeLessThanOrEqual(0.5);
        expect(cli(["docket", "show", id!])).toContain("nothing filed");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
