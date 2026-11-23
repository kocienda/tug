/**
 * at0872-docket-card.test.ts — the Docket card shows a docket as threads, and
 * work is filed on it by placing its atom.
 *
 * ## What this gates
 *
 * The unit tests know each piece: the feed's guard, the lookups, what an atom
 * files, how a filing is worded, the sender's deadline. What only the app can
 * show is the loop closed through the real server: a gesture in the card
 * writes the store, the store's watch recomposes the feed, and the card draws
 * what the feed says.
 *
 *   A. **A docket is created from the card.** New Docket… in the chooser,
 *      a name in the input dialog, Return; the built `tugtool docket list`
 *      names it, and the chooser shows it.
 *
 *   B. **An arc is filed by placing its atom.** The arc is mentioned with
 *      `@` in the Session card's composer, which mints its atom; Edit ▸ Copy
 *      writes the atom sidecar and Edit ▸ Paste puts it in the Docket card's
 *      field. The thread row shows the arc pill and its sketch, the field
 *      empties, and `tugtool docket show` holds the same thread.
 *
 *   C. **A live arc's fraction is the Arcs card's.** A step closed through
 *      the real arc verb moves the row's fraction to match.
 *
 *   D. **A thread moves to another docket.** Move to Docket from the row's
 *      menu files it on a second docket; the first says "Nothing filed" and
 *      the filing line says the move.
 *
 *   E. **Retire is a field, not a removal.** A retired docket leaves the
 *      chooser and returns under Show Retired.
 *
 * Everything runs in a scratch repository under a scratch `TUG_DATA_DIR`
 * through this checkout's built `tugtool`, so nothing here touches the
 * user's own dockets or arcs.
 *
 * @covers tugdeck/src/components/docket/docket-card.tsx
 * @covers tugdeck/src/components/docket/docket-card-registration.tsx
 * @covers tugdeck/src/lib/docket-store.ts
 * @covers tugdeck/src/lib/docket-filing.ts
 * @covers tugdeck/src/lib/docket-verbs.ts
 * @covers tugdeck/src/lib/docket-card-open-registry.ts
 * @covers tugdeck/src/lib/open-docket-in-card.ts
 * @covers tugrust/crates/tugcast/src/feeds/dockets.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor/control/dockets.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { kindBody } from "./_harness/card-reach";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  createArc,
  makeArcScratchRepo,
  recordStampedPlan,
  tugtool,
  type ArcScratchRepo,
} from "./arc-fixture";
import { CHECKOUT } from "./arcs-card-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "aa11bb22-0000-4000-8000-00000000a872";
const SID_B = "aa11bb22-0000-4000-8000-00000000b872";
const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const ARC = "rail";
const SKETCH_TEXT = "a rail panel beside the deck";

const CARD = '[data-card-id="A"]';
const COMPOSER = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const COMPLETION_ITEMS = '[data-slot="tug-completion-menu"] .tug-completion-menu-item';

const CHOOSER = '.docket-chooser [data-slot="tug-popup-button"]';

const CHOOSER_ITEM = (i: number) => `[data-testid="docket-chooser"] .tug-menu-item[data-item-id="${i}"]`;
const DIALOG_FIELD = '[data-slot="tug-modal-input-dialog-field"]';
const FIELD = '[data-testid="docket-filing-field"]';
const FIELD_CONTENT = `${FIELD} .cm-content`;
const ROW = '[data-slot="docket-thread-row"]';
const FILING_LINE = '[data-slot="docket-filing-line"]';
const EMPTY = '[data-slot="docket-empty"]';
const MENU_ITEMS = '[data-slot="tug-editor-context-menu"] [role="menuitem"]';

let scratch: ArcScratchRepo | null = null;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0872", checkout: CHECKOUT });
  const created = createArc(scratch.repo, ARC, "at0872 fixture", scratch.cli);
  // A three-row plan with step 1 open, so the fraction has somewhere to move.
  recordStampedPlan(scratch.repo, ARC, created.worktree, { ...scratch.cli, rows: 3, through: 3 });
  const docs = join(scratch.repo, ".tug", "arcs", ARC);
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "sketch.md"), `${SKETCH_TEXT}\n`);
  cli(["sketch", "record", ARC]);
});

afterAll(() => {
  if (scratch === null) return;
  rmSync(scratch.repo, { recursive: true, force: true });
  rmSync(scratch.dataRoot, { recursive: true, force: true });
});

/** This checkout's tugtool, in the scratch repo, against the scratch data. */
function cli(args: string[]): string {
  const s = scratch!;
  return tugtool(args, { cwd: s.repo, binaryRoot: s.cli.binaryRoot, env: s.cli.env });
}

interface ListedDocket {
  id: string;
  name: string;
  retired: boolean;
  threads: number;
}

function listDockets(all = false): ListedDocket[] {
  const out = JSON.parse(cli(["docket", "list", ...(all ? ["--all"] : []), "--json"])) as {
    data: ListedDocket[];
  };
  return out.data;
}

function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
      { id: "B", componentId: "session", title: "Session", closable: true },
      { id: "D", componentId: "docket", title: "Docket", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 20, y: 20 },
        size: { width: 620, height: 520 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["standard"],
      },
      {
        id: "p2",
        position: { x: 660, y: 20 },
        size: { width: 640, height: 520 },
        cardIds: ["D"],
        activeCardId: "D",
        title: "",
        acceptsFamilies: ["standard"],
      },
      {
        id: "p3",
        position: { x: 20, y: 560 },
        size: { width: 420, height: 300 },
        cardIds: ["B"],
        activeCardId: "B",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "p2",
    hasFocus: true,
  };
}

/** Bring D's pane forward, so the presses below land on a raised card. */
async function focusDocket(app: App): Promise<void> {
  await app.dispatchControlAction("focus-pane", { paneId: "p2" });
}

/** Wait until D's view is the window's first responder, where Paste goes. */
async function awaitDocketResponder(app: App): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await app.bodies()).some((b) => b.cardId === "D" && b.firstResponder === true)) {
    if (Date.now() > deadline) throw new Error("D's view never became the first responder");
    await Bun.sleep(50);
  }
}

/**
 * Open a popup by a real press on `trigger` and wait for `item` to stand. A
 * press into a card that is not yet key may only raise it, so a second press
 * follows when the first opened nothing, as a hand would.
 */
async function openPopup(app: App, trigger: string, item: string): Promise<void> {
  const open = `document.querySelector(${JSON.stringify(item)}) !== null`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await app.body("D").nativeClickAtElement(trigger);
    try {
      await app.body("D").waitForCondition<boolean>(open, { timeoutMs: 1_500 });
      return;
    } catch {
      // Raised, not opened; press again.
    }
  }
  const seen = await app.body("D").evalJS<string>(
    `(function(){
      var t = document.querySelector(${JSON.stringify(trigger)});
      var items = Array.from(document.querySelectorAll(".tug-menu-item")).map(function (e) { return (e.textContent || "").trim(); });
      return JSON.stringify({ trigger: t === null ? null : t.outerHTML.slice(0, 300), items: items });
    })()`,
  );
  note("at0872 popup did not open", `${trigger}: ${seen}`);
  throw new Error(`the popup at ${trigger} never opened`);
}

/** The chooser's items, by label, in their order. */
async function chooserLabels(app: App): Promise<string[]> {
  return app.body("D").evalJS<string[]>(
    `Array.from(document.querySelectorAll('[data-testid="docket-chooser"] .tug-menu-item')).map(function (el) { return (el.textContent || "").trim(); })`,
  );
}

/** Open the chooser and press the item whose label is `label`. */
async function pickFromChooser(app: App, label: string): Promise<void> {
  await focusDocket(app);
  await openPopup(app, CHOOSER, CHOOSER_ITEM(0));
  const labels = await chooserLabels(app);
  const index = labels.indexOf(label);
  expect(index, `the chooser offers ${label} (it offered ${labels.join(" | ")})`).toBeGreaterThan(-1);
  await app.body("D").nativeClickAtElement(CHOOSER_ITEM(index));
}

/** New Docket… with `name` typed into the input dialog. */
async function newDocket(app: App, name: string): Promise<void> {
  await pickFromChooser(app, "New Docket…");
  await app.body("D").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(DIALOG_FIELD)}) !== null`,
    { timeoutMs: 5_000 },
  );
  await app.nativeType(name);
  await app.body("D").waitForCondition<boolean>(
    `document.querySelector('[data-slot="tug-modal-input-dialog-list"]') !== null
     && (document.querySelector('[data-slot="tug-modal-input-dialog-list"]').textContent || "").indexOf(${JSON.stringify(name)}) !== -1`,
    { timeoutMs: 5_000 },
  );
  await app.nativeKey("Return");
  await app.body("D").waitForCondition<boolean>(
    `(document.querySelector(${JSON.stringify(CHOOSER)}).textContent || "").indexOf(${JSON.stringify(name)}) !== -1`,
    { timeoutMs: 10_000 },
  );
}

/** The row's arc fraction, or null when no row draws one. */
async function rowFraction(app: App): Promise<string | null> {
  return app.body("D").evalJS<string | null>(
    `(function(){ var el = document.querySelector('${ROW} [data-slot="docket-arc-fraction"]'); return el === null ? null : (el.textContent || "").trim(); })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0872 — the Docket card", () => {
  test(
    "creates, files by atom, follows the live arc, moves a thread and retires a docket",
    async () => {
      const s = scratch!;
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0872-docket-card",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: s.dataRoot },
      });
      try {
        // The card opens on the scratch project, as `open-docket` seeds one;
        // the harness's own checkout is open too, so an unseeded card would
        // ask which.
        await app.seedDeckState({
          state: deckShape(),
          cardStates: { D: { content: { projectDir: s.repo } } },
          focusCardId: "D",
        });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        // The scratch repo enters both aggregates as a registered workspace,
        // and spawning a session on it is what registers it — on B, so A is
        // free to be bound for its composer below.
        await app.spawnSessionResume("B", { tugSessionId: SID_B, projectDir: s.repo });
        await app.awaitEngineReady("B", { timeoutMs: 15_000 });
        await app.body("D").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(EMPTY)}) !== null
           && (document.querySelector(${JSON.stringify(EMPTY)}).textContent || "").trim() === "No dockets"`,
          { timeoutMs: 20_000 },
        );

        // ---- A. A docket is created from the card. -------------------------
        await newDocket(app, "Rail work");
        const first = listDockets().find((d) => d.name === "Rail work");
        expect(first, "tugtool docket list names the new docket").toBeDefined();

        // ---- B. An arc is filed by placing its atom. -----------------------
        // The composer stands once the card is bound to a session with a
        // transcript, which a replay of an empty one gives it — at0871's
        // route. The arc provider then searches the card's project.
        await app.bindSession("A", { tugSessionId: SID, projectDir: s.repo });
        await app.driveSession("A", {
          op: "ingestFrame",
          feedId: CODE_OUTPUT_FEED,
          decoded: { type: "replay_started", tug_session_id: SID },
        });
        await app.driveSession("A", {
          op: "ingestFrame",
          feedId: CODE_OUTPUT_FEED,
          decoded: {
            type: "replay_complete",
            tug_session_id: SID,
            count: 0,
            firstLoadedTurnIndex: 0,
            totalTurns: 0,
            hasOlder: false,
          },
        });
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(COMPOSER)}) !== null`,
          { timeoutMs: 15_000 },
        );
        await app.dispatchControlAction("focus-session-card", { cardId: "A" });
        const deadline = Date.now() + 5_000;
        while (!(await app.bodies()).some((b) => b.cardId === "A" && b.firstResponder === true)) {
          if (Date.now() > deadline) throw new Error("A's view never became the first responder");
          await Bun.sleep(50);
        }
        await app.body("A").focusElement(COMPOSER);
        await app.nativeType(`@${ARC}`);
        await app.body("A").waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(${JSON.stringify(COMPLETION_ITEMS)})).some(function (el) { return (el.textContent || "").indexOf(${JSON.stringify(ARC)}) !== -1; })`,
          { timeoutMs: 15_000 },
        );
        await app.nativeKey("Return");
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('${COMPOSER} [data-atom-type="arc"]') !== null`,
          { timeoutMs: 10_000 },
        );
        await app.nativeKey("a", ["cmd"]);
        const copied = await app.performMenuItem("edit.copy");
        expect(copied.found && copied.performed, "Edit ▸ Copy performs").toBe(true);

        await focusDocket(app);
        await app.body("D").nativeClickAtElement(FIELD);
        await awaitDocketResponder(app);
        const pasted = await app.performMenuItem("edit.paste");
        expect(pasted.found && pasted.performed, "Edit ▸ Paste performs").toBe(true);
        try {
          await app.body("D").waitForCondition<boolean>(
            `document.querySelector('${ROW} [data-slot="docket-arc-cell"] [data-slot="tug-arc-atom"]') !== null
             && document.querySelector('${ROW} [data-slot="docket-sketch-cell"]') !== null`,
            { timeoutMs: 15_000 },
          );
        } catch (error) {
          const seen = await app.body("D").evalJS<string>(
            `JSON.stringify({
              line: (document.querySelector(${JSON.stringify(FILING_LINE)}) || {}).textContent || null,
              field: (document.querySelector(${JSON.stringify(FIELD)}) || {}).innerHTML ? document.querySelector(${JSON.stringify(FIELD)}).innerHTML.slice(0, 600) : null,
              rows: Array.from(document.querySelectorAll(${JSON.stringify(ROW)})).map(function (r) { return r.outerHTML.slice(0, 600); }),
              empty: (document.querySelector(${JSON.stringify(EMPTY)}) || {}).textContent || null,
            })`,
          );
          note("at0872 filing", `${seen} cli=${cli(["docket", "list", "--json"]).slice(0, 400)}`);
          throw error;
        }
        await app.body("D").waitForCondition<boolean>(
          `document.querySelector('${FIELD_CONTENT} [data-atom-type]') === null`,
          { timeoutMs: 5_000 },
        );
        const shown = JSON.parse(cli(["docket", "show", first!.id, "--json"])) as {
          data: { threads: Array<{ arc?: { name: string } | null; sketch?: { id: string } | null }> };
        };
        note("at0872 shown", JSON.stringify(shown.data).slice(0, 600));
        expect(shown.data.threads.length).toBe(1);
        expect(shown.data.threads[0]!.arc?.name).toBe(ARC);
        expect(shown.data.threads[0]!.sketch).toBeTruthy();

        // ---- C. A live arc's fraction is the Arcs card's. ------------------
        const before = await rowFraction(app);
        cli(["arc", "step", ARC, "done", "1"]);
        cli(["arc", "step", ARC, "start", "2", "--through", "3"]);
        await app.body("D").waitForCondition<boolean>(
          `(function(){ var el = document.querySelector('${ROW} [data-slot="docket-arc-fraction"]'); return el !== null && (el.textContent || "").trim() !== ${JSON.stringify(before)}; })()`,
          { timeoutMs: 20_000 },
        );
        const after = await rowFraction(app);
        await app.dispatchControlAction("toggle-arcs");
        const arcs = await kindBody(app, "dashes").evalJS<string | null>(
          `(function(){ var el = document.querySelector('[data-slot="arcs-row"][data-arc="${ARC}"] [data-slot="tug-step-fraction"]') || document.querySelector('[data-slot="tug-step-fraction"]'); return el === null ? null : (el.textContent || "").replace(/\\s+/g, ""); })()`,
        );
        note("at0872 fractions", JSON.stringify({ before, after, arcs }));
        expect(after).not.toBe(before);
        expect(arcs?.replace(/\s+/g, "")).toContain(after!.replace(/\s+/g, ""));
        await app.dispatchControlAction("toggle-arcs");

        // ---- D. A thread moves to another docket. --------------------------
        await newDocket(app, "Platform");
        await pickFromChooser(app, "Rail work");
        await app.body("D").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 10_000 },
        );
        await focusDocket(app);
        await app.body("D").nativeRightClickAtElement(ROW);
        await app.body("D").waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(${JSON.stringify(MENU_ITEMS)})).some(function (el) { return (el.textContent || "").trim() === "Platform"; })`,
          { timeoutMs: 5_000 },
        );
        await app.body("D").evalJS<null>(
          `(function(){ var el = Array.from(document.querySelectorAll(${JSON.stringify(MENU_ITEMS)})).find(function (e) { return (e.textContent || "").trim() === "Platform"; }); el.setAttribute("data-at0872-target", "1"); return null; })()`,
        );
        await app.body("D").nativeClickAtElement('[data-at0872-target="1"]');
        await app.body("D").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(EMPTY)}) !== null
           && (document.querySelector(${JSON.stringify(EMPTY)}).textContent || "").trim() === "Nothing filed"
           && (document.querySelector(${JSON.stringify(FILING_LINE)})?.textContent || "").indexOf("oved") !== -1`,
          { timeoutMs: 15_000 },
        );
        const moved = listDockets();
        expect(moved.find((d) => d.name === "Platform")?.threads).toBe(1);
        expect(moved.find((d) => d.name === "Rail work")?.threads).toBe(0);

        // ---- E. Retire is a field, not a removal. --------------------------
        await pickFromChooser(app, "Retire…");
        await app.body("D").waitForCondition<boolean>(
          `document.querySelector('[data-slot="tug-confirm-confirm"]') !== null`,
          { timeoutMs: 5_000 },
        );
        await app.body("D").nativeClickAtElement(
          '[data-slot="tug-confirm-confirm"]',
        );
        await app.body("D").waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(CHOOSER)}).textContent || "").indexOf("Rail work") === -1`,
          { timeoutMs: 10_000 },
        );
        expect(listDockets(true).find((d) => d.name === "Rail work")?.retired).toBe(true);
        await focusDocket(app);
        await openPopup(app, CHOOSER, CHOOSER_ITEM(0));
        expect(await chooserLabels(app)).not.toContain("Rail work");
        await app.nativeKey("Escape");
        await pickFromChooser(app, "Show Retired");
        await focusDocket(app);
        await openPopup(app, CHOOSER, CHOOSER_ITEM(0));
        expect(await chooserLabels(app)).toContain("Rail work (retired)");
        await app.nativeKey("Escape");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
