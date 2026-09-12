/**
 * at0559-ready-folded-form.test.ts — a finished arc calls for the user
 * without opening a room over the folded card.
 *
 * ## What this gates
 *
 * The Changes shade is a room of the OPEN form ([B06]). A folded Session card
 * is a masthead tier and Z2 and nothing else ([P03]), so a shade mounted over
 * it lands on top of the one door the form has — the fold control at Z2's
 * leading edge ([F06]) — and the Join it offers is folded away and inert
 * ([F07]). A reveal that arrives while the card is folded therefore does not
 * enter the room; it waits, unspent, for the user's unfold.
 *
 * Waiting is not the same as going quiet, which is the other half of this
 * file. The folded form still has two voices and it announces in both
 * ([B08]): the masthead's phase dot turns over to the new `Ready` key — green
 * and pulsing, the dot's only green ([B01], [B03]) — and Z2's ARC cell takes
 * the arc join register's own word, `ready`, in place of the fraction it wears
 * while the arc walks.
 *
 * Four claims, in one arc's life:
 *
 *   1. **Folded, the offer raises no shade.** Sampled across a window rather
 *      than read once, because the failure is a reveal that fires and is
 *      superseded — which a single late read would report as silence.
 *   2. **And the door is still a door.** At the fold control's own point, the
 *      topmost thing belonging to the deck is the fold control — nothing of
 *      this card's is over it. That is [F06] stated as the thing the user can
 *      actually do.
 *   3. **The folded form says so anyway.** The dot reads `ready` and the ARC
 *      cell reads `ready`, both off the one derivation ([B02], [B08]), so the
 *      card that cannot show the room can still say there is one.
 *   4. **The unfold spends the offer, once.** Unfolding opens the room
 *      already armed — the Changes route is active and the Z5 is the Join —
 *      and closing it does not summon it again for the same head ([B09]).
 *      The head is spent by the reveal that actually happened, never by the
 *      one that was declined.
 *
 * The arc is real: a scratch repository, one arc, one committed round, and
 * the join pilot deriving readiness on its own with nothing marked — the same
 * fixture shape at0445 drives the open card through. The card is folded
 * **before** the arc is bound, so the offer can never have arrived on an open
 * card first; what this file watches is the first reveal of its life meeting a
 * folded form.
 *
 * `@covers` names the gate and the readings, and leaves `session-card.tsx`
 * out for the reason at0550 and at0551 both give: it stands at the selection
 * budget's ceiling, and at0140 catches its breakage sooner. What the card
 * itself contributes here — the deferred effect's `folded` dependency — is
 * the one thing `join-offer-reveal.ts` was extracted to make nameable, and
 * that file is named below.
 *
 * @covers tugdeck/src/lib/join-offer-reveal.ts
 * @covers tugdeck/src/lib/code-session-store/use-session-phase.ts
 * @covers tugdeck/src/lib/code-session-store/session-phase-visual.ts
 * @covers tugdeck/src/lib/arc-join-register.ts
 * @covers tugdeck/src/components/tugways/session-phase-dot.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  commitRound,
  createArc,
  makeArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 420_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000559";
const ARC = "at0559-folded";

const PANE_ID = "p1";
const PANE = `.tug-pane[data-pane-id="${PANE_ID}"]`;
const CARD = '[data-card-id="A"]';
/** The shade — its presence in the DOM IS the reveal, and its absence is claim 1. */
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const STATUS_BAR = `${CARD} [data-slot="session-card-status-bar"]`;
/** The folded form's one door ([B03]). */
const CONTROL = `${STATUS_BAR} [data-slot="session-fold-control"]`;
/** Z2's ARC cell reading — a fraction while the arc walks, a word when it is ready. */
const ARC_VALUE = `${STATUS_BAR} [data-slot="session-telemetry-arc-value"]`;
/** The masthead's phase dot, which carries its key as `data-phase`. */
const DOT = `${PANE} .session-masthead-row .tug-session-row-dot [data-phase]`;
const ROUTE_GROUP = `${CARD} .tug-prompt-entry-route-group`;
const JOIN_BUTTON = `${CARD} .tug-prompt-entry-commit-button[aria-label="Join"]`;

/** The checkout whose built binaries the fixture drives. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch = "";
let dataRoot = "";
let fixtureDir = "";
let cli: { binaryRoot?: string; env?: Record<string, string> } = {};

beforeAll(() => {
  if (!SHOULD_RUN) return;
  const base = makeArcScratchRepo({ prefix: "at0559", checkout: CHECKOUT });
  scratch = base.repo;
  dataRoot = base.dataRoot;
  cli = base.cli;

  const arc = createArc(scratch, ARC, "at0559 folded-form fixture", cli);
  writeFileSync(join(arc.worktree, "folded.txt"), "at0559 the arc's work\n");
  commitRound(scratch, ARC, "at0559(round): the arc's work", cli);
  // Nothing is marked anywhere: a plan-less arc with a committed round on a
  // clean worktree is the whole of what arms the offer ([D147]).

  fixtureDir = seedScratchSession(scratch, SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
  if (dataRoot !== "") rmSync(dataRoot, { recursive: true, force: true });
  rmScratchSession(fixtureDir);
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: PANE_ID,
        position: { x: 40, y: 40 },
        size: { width: 900, height: 680 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: PANE_ID,
    hasFocus: true,
  };
}

const settle = (ms = 200): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

/** Whether the shade is up right now. */
function shadeUp(app: App): Promise<boolean> {
  return app.evalJS<boolean>(
    `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
  );
}

/**
 * Watch for the shade across a window and answer whether it ever appeared.
 * Sampled rather than read once: a reveal that fires and is superseded is
 * exactly the defect, and a single late read would call it silence.
 */
async function shadeAppearsWithin(app: App, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await shadeUp(app)) return true;
    await settle(500);
  }
  return false;
}

/**
 * Watch the composer's route across a window and answer whether it ever left
 * Prompt — a second reveal, sampled rather than read once for the same reason
 * {@link shadeAppearsWithin} is.
 */
async function routeLeavesPromptWithin(app: App, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const resting = await app.evalJS<boolean>(
      `document.querySelector('${ROUTE_GROUP} button[data-choice-value="prompt"]')?.getAttribute("data-state") === "active"`,
    );
    if (!resting) return true;
    await settle(500);
  }
  return false;
}

/** Flip the fold flag through the one command every door reaches ([P02]). */
async function toggleFolded(app: App, want: boolean): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("toggle-session-fold"), null)`,
  );
  await app.waitForCondition<boolean>(
    `window.__tug.getPaneRecord(${JSON.stringify(PANE_ID)}).folded === ${want}`,
    { timeoutMs: 8000 },
  );
  // The flag arms the motion; the card writes the terminal form when the
  // motion ENDS, and `data-fold` is its own account of that.
  await app.waitForCondition<boolean>(
    `(function () {
       var card = document.querySelector(${JSON.stringify(CARD)} + " .session-card");
       if (card === null) return false;
       return card.getAttribute("data-fold") === ${want ? '"settled"' : "null"};
     })()`,
    { timeoutMs: 8000 },
  );
}


/**
 * What the card itself puts over the fold control's own centre.
 *
 * The claim is [F06]'s: no room of THIS card lands on the one door the folded
 * form has. The app-modal scrim the restore gate leaves behind is not one of
 * this card's rooms, and it has to be got out of the way before the question
 * can even be asked — Radix keeps a closed AlertDialog mounted through an exit
 * animation that never runs under the harness's suppressed motion, and a modal
 * dialog holds `pointer-events: none` on the body while it is mounted. So the
 * whole deck is un-hit-testable in this fixture for a reason that has nothing
 * to do with the fold, and {@link clearStaleAppModal} takes exactly that
 * leftover away first.
 *
 * Then the real question, off `elementFromPoint`: what the reader's pointer
 * would find at the control's own centre is the control, its button, or its
 * glyph.
 */
function whatIsOverTheControl(app: App): Promise<string> {
  return app.evalJS<string>(
    `(function () {
       var control = document.querySelector(${JSON.stringify(CONTROL)});
       if (control === null) return "no control";
       var box = control.getBoundingClientRect();
       if (box.width === 0 || box.height === 0) return "control has no box";
       var hit = document.elementFromPoint(
         box.left + box.width / 2,
         box.top + box.height / 2,
       );
       if (hit === null) return "nothing under the point";
       if (control.contains(hit)) return "control";
       return hit.tagName + " " + (hit.getAttribute("data-slot") || hit.className || "");
     })()`,
  );
}

/**
 * Stand a closed-but-mounted app-modal down, without unmounting it.
 *
 * Inline `pointer-events` and the body lock are Radix's own inline writes, so
 * setting them is undoing exactly what the stale layer did and nothing React
 * has an opinion about. The nodes are left where they are on purpose: pulling
 * React-managed elements out of the DOM by hand is how a test kills the deck
 * it is about to ask a question of.
 *
 * Returns what it found, so the record says whether the fixture had one — a
 * run where it finds nothing is a run whose hit test needed no help.
 */
function clearStaleAppModal(app: App): Promise<string> {
  return app.evalJS<string>(
    `(function () {
       var stale = Array.from(
         document.querySelectorAll('.tug-alert-overlay[data-state="closed"], .tug-alert-content[data-state="closed"]'),
       );
       stale.forEach(function (el) { el.style.pointerEvents = "none"; });
       var locked = document.body.style.pointerEvents;
       if (document.querySelector('.tug-alert-content:not([data-state="closed"])') === null) {
         document.body.style.pointerEvents = "";
       }
       return JSON.stringify({ stoodDown: stale.length, bodyWas: locked || "unset" });
     })()`,
  );
}

/** The dot's phase key, or null when there is no dot. */
function dotPhase(app: App): Promise<string | null> {
  return app.evalJS<string | null>(
    `document.querySelector(${JSON.stringify(DOT)})?.getAttribute("data-phase") ?? null`,
  );
}

/** Z2's ARC cell reading, flattened. */
function arcCellReading(app: App): Promise<string> {
  return app.evalJS<string>(
    `((document.querySelector(${JSON.stringify(ARC_VALUE)})?.textContent) || "").trim()`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0559: a standing offer on a folded card", () => {
  test(
    "the shade waits outside the fold while the dot and the ARC cell say Ready, and the unfold opens the room armed, spending the head once",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0559-ready-folded-form",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: dataRoot },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 15000 },
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: scratch });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // Folded FIRST, and only then bound. The offer this card meets is
        // therefore the first of its life and it meets a folded form — there
        // is no open moment for a reveal to have been spent in.
        await toggleFolded(app, true);
        expect(await shadeUp(app), "nothing is revealed yet").toBe(false);

        // The real `arc bind` verb: the pilot works from the LEDGER row, so a
        // client-side broadcast would leave the server thinking nobody holds
        // this arc and nothing downstream would ever run.
        tugtool(["arc", "bind", ARC], {
          cwd: scratch,
          binaryRoot: cli.binaryRoot,
          env: { ...(cli.env ?? {}), TUG_SESSION_ID: SID },
        });

        // ── The folded form announces ────────────────────────────────────
        // Waited on rather than merely asserted: this is the arc reaching
        // ready, which is also the moment a reveal would have fired.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DOT)})?.getAttribute("data-phase") === "ready"`,
          { timeoutMs: 240000 },
        );
        note("at0559 dot", (await dotPhase(app)) ?? "none");

        // The dot is the one green on the session's mark, and it breathes:
        // a live wait on a person, not a settled session ([B03]).
        const dotVisual = await app.evalJS<{ role: string | null; state: string | null }>(
          `(function () {
             var el = document.querySelector(${JSON.stringify(DOT)});
             return {
               role: el === null ? null : el.getAttribute("data-role"),
               state: el === null ? null : el.getAttribute("data-state"),
             };
           })()`,
        );
        note("at0559 dot visual", JSON.stringify(dotVisual));
        expect(dotVisual.role).toBe("success");
        expect(dotVisual.state).toBe("running");

        // And Z2's ARC cell takes the register's own word rather than
        // composing a second one ([B08]).
        await app.waitForCondition<boolean>(
          `((document.querySelector(${JSON.stringify(ARC_VALUE)})?.textContent) || "").trim() === "ready"`,
          { timeoutMs: 60000 },
        );
        note("at0559 ARC cell", await arcCellReading(app));

        // ── …and raises no room over itself ──────────────────────────────
        expect(
          await shadeAppearsWithin(app, 15000),
          "a folded card is not a room the shade may mount in",
        ).toBe(false);

        // The door is still a door: nothing of this card's stands between the
        // reader and the one control the form has ([F06]).
        note("at0559 stale app-modal", await clearStaleAppModal(app));
        const overTheControl = await whatIsOverTheControl(app);
        note("at0559 under the control", overTheControl);
        expect(overTheControl).toBe("control");

        // ── The unfold spends the offer ──────────────────────────────────
        // Through the control itself, which is the gesture the deferred entry
        // is waiting on ([B06]) and the door the claim above just measured.
        await app.click(`${CONTROL} button`);
        await app.waitForCondition<boolean>(
          `window.__tug.getPaneRecord(${JSON.stringify(PANE_ID)}).folded === false`,
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(
          `(function () {
             var card = document.querySelector(${JSON.stringify(CARD)} + " .session-card");
             return card !== null && card.getAttribute("data-fold") === null;
           })()`,
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 60000 },
        );
        note("at0559 revealed: the deferred entry carried on the unfold");

        // Armed, not merely open: the Changes route is active and the Z5 is
        // the control that lands. The passive reveal goes through the one
        // path ([D152]), so the room it opens is the same one ⌃⌘C opens.
        await app.waitForCondition<boolean>(
          `document.querySelector('${ROUTE_GROUP} button[data-choice-value="changes"]')?.getAttribute("data-state") === "active"`,
          { timeoutMs: 20000 },
        );
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(JOIN_BUTTON)}) !== null`,
          ),
          "the composer is the join's, so its ⬆ is the control that lands",
        ).toBe(true);

        // ── Once, and only once ──────────────────────────────────────────
        // Closing costs nothing and summons nothing: the head was spent by
        // the reveal that actually happened, and the decline never spent it.
        await app.dispatchControlAction("toggle-changes-view");
        await app.waitForCondition<boolean>(
          `document.querySelector('${ROUTE_GROUP} button[data-choice-value="prompt"]')?.getAttribute("data-state") === "active"`,
          { timeoutMs: 20000 },
        );
        // The ROUTE is what says the room was left, and it is what a second
        // entry would move: a reveal takes the card to Changes, so a card
        // still resting on Prompt a window later has not been re-entered.
        expect(
          await routeLeavesPromptWithin(app, 10000),
          "one head, one reveal — the room does not re-summon itself",
        ).toBe(false);
        note("at0559 spent: the head bought exactly one entry");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
