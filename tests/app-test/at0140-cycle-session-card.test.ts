/**
 * at0140-cycle-session-card.test.ts — the session card joins the keyboard-focus-cycling
 * mode: ⌥⇥ rings the stop the caret was in, Tab tours the card's chrome, ⌥⇥
 * again restores the editor caret ([P09]/[P10]/[P12], [#step-cycle-session-card]).
 *
 * ## Why this exists
 *
 * The cycle mechanism was proven generically on the `fixture-cycle-demo` card.
 * This test gates the *real consumer*: a connected session card. The card root
 * carries `data-cycling`, the engine signal the fill-suppression CSS keys on.
 *
 * **Mode entry does not advance.** ⌥⇥ engages and the ring lands on the stop
 * that already held the keyboard — from the composer that is the editor's own
 * stop, which parks (ring, no caret). Entering a mode is not a movement through
 * it; the ring's job is to mark where the keyboard IS. This test asserted the
 * opposite until the composer's ring was found to be painting nothing at all:
 * ⌥⇥ seeded the commit-home ([P10]'s lowest-order stop), so engaging silently
 * moved the user's place, and the only reason that looked survivable was that
 * the editor's ring was suppressed by CSS left over from the pre-KBF axiom.
 *
 * The walk:
 *   1. **rest:** clicking the editor puts the caret there (base mode); the card
 *      reads `data-cycling="false"` and the submit holds no key view.
 *   2. **empty editor → submit is skipped:** ⌥⇥ rings the editor's stop and one
 *      Tab wraps to the route (the editor is the LAST stop and the route is
 *      the FIRST, now that the fold seat has moved into Z2, [B03]);
 *      touring the live stops (route → Claude Code → AI → fold → STATE → TIME
 *      → CONTEXT → TASKS → JOBS → editor → wrap) never lands on the
 *      submit, because its empty-input gate disables it. ⌥⇥ off restores caret.
 *   3. **typed editor:** with content, the same entry — ring on the editor's
 *      stop, Tab to the route — and now the submit is live.
 *   4. **Tab tours the stops:** route → Claude Code → AI → submit →
 *      fold → STATE → TIME → CONTEXT → TASKS → JOBS → editor → wrap
 *      (trapped). The Session and Project chips are not on this route (the Z4B
 *      diet), and there is no BTW cell (the Z2 diet). Every Z4B chip and Z2 status cell
 *      is its own leaf stop ([P10] revised — no arrow-roving): Tab steps
 *      stop-to-stop and each wears the blue leaf ring in turn. The JOBS cell
 *      is the last leaf before the editor (the beat label retired with the Z2
 *      strip; the voice lives in the pane masthead, which takes no card-cycle
 *      stop). The editor is the last stop — a text
 *      stop: the input area takes the border while the editor stays blurred (no
 *      caret).
 *   5. **The editor stop is PARKED ([P12]):** arriving there by engine movement
 *      rings it and leaves the editor caret-less. Return or a printable
 *      character grants the caret; ⌥⇥ exits the cycle and the resting landing
 *      returns it.
 *   6. **Z2 popover keeps the cycle:** Return on a cell opens its popover;
 *      Escape returns the ring to the same cell — still cycling, editor
 *      untouched (the focus engine owns close-focus; the service-popup binding
 *      defers).
 *   7. **Using the mouse exits cycling (editor):** a click on the editor ends
 *      the cycle and returns the caret — the comprehensive rule for toggleable
 *      cycling (no ⌥⇥ needed).
 *   8. **Using the mouse exits cycling (Z4B chip):** re-enter, then a click on
 *      the Mode chip exits the cycle too (and opens its picker by mouse). The
 *      keyboard path — a sheet opened from a cycle stop returns the ring to that
 *      chip via the same engine-owns close-focus as the step-6 popover — lands
 *      with the cycle mode keys (#step-cycle-keys).
 *
 * Mode keys (Return / Space) are a later step; this gates the session-card
 * push/seed/wrap/restore + the `data-cycling` signal. The Picker → Open default
 * focus is environment-sensitive (it depends on whether a valid path seeds Open
 * enabled), so it is verified by-eye rather than asserted here.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/components/tugways/hooks/
 * @covers tugdeck/src/components/tugways/focus-manager.ts
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 * @covers tugdeck/src/components/tugways/cards/ai-chip.tsx
 * @covers tugdeck/src/components/tugways/cards/ai-config-sheet.tsx
 * @covers tugdeck/src/lib/model-label.ts
 * @covers tugdeck/src/components/tugways/tug-placard.tsx
 * @covers tugdeck/src/components/tugways/tug-popover.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";
import { ROUTE_CHOICE } from "./_harness/selectors";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-card-id="A"]';
const ROOT = `${CARD} [data-testid="session-card"]`;
const SUBMIT = `${CARD} .tug-prompt-entry-submit-button`;
const ROUTE = `${CARD} ${ROUTE_CHOICE}`;
// The card's one fold control ([B03]) — at the trailing edge of the Z2
// status row, in both of the card's forms, and so the stop just after the
// five cells.
const FOLD = `${CARD} [data-slot="session-fold-control"] button`;
// The three Z4B indicator chips now in the cycle ([P10] revised — no control
// left behind): the route indicator (Claude Code / Shell), the Session badge,
// and the Project button. Each is a leaf stop carrying `data-key-view-kbd`
// when active. All three are live + enabled in the headless harness
// (`bindSession` defaults a `projectDir`, and the Code route enables them).
// The Code route's two Z4B chips: the Claude Code identity chip, then the AI
// settings chip that replaced three — Mode, Model, and Effort — so the toolbar
// walk steps route → Claude Code → AI → submit.
const CLAUDE_CHIP = `${CARD} [data-slot="session-route-indicator-badge"]`;
const AI_CHIP = `${CARD} [data-slot="ai-chip"]`;
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
// The five Z2 status cells. Each is its own leaf cycle stop ([P10]
// revised — no item-group roving): the cell `<button>` carries
// `data-key-view-kbd` (and the leaf ring) when it is the active stop.
const Z2_STATE = `${CARD} [data-priority="state"]`;
const Z2_TIME = `${CARD} [data-priority="time"]`;
const Z2_CONTEXT = `${CARD} [data-priority="context"]`;
const Z2_TASKS = `${CARD} [data-priority="tasks"]`;
const Z2_JOBS = `${CARD} [data-priority="jobs"]`;
// A settings sheet opened from a cycle-stop chip (here the permission-mode chip,
// which populates reliably headless) and one of its option rows.
const SHEET = '[data-slot="tug-sheet"]';
// A row of the AI mixer sheet — the MODE choice group, whose presence is the
// simplest proof the sheet is up.
const SHEET_OPTION = `${SHEET} [data-testid="ai-config-mode"]`;

// Expression: does the element at `selector` hold the keyboard key view? Every
// stop is a leaf (submit, the route popup trigger, the Z4B chips, the Z2 cells)
// — the element itself carries `data-key-view-kbd` when it is the active stop.
function hasKeyView(selector: string): string {
  return `(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    return el ? el.hasAttribute("data-key-view-kbd") : false;
  })()`;
}

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 760, height: 560 },
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

// `data-cycling` on the session-card root, or null.
const CYCLING = `(function(){
  var el = document.querySelector(${JSON.stringify(ROOT)});
  return el ? el.getAttribute("data-cycling") : null;
})()`;

// Whether the submit button currently holds the keyboard key view.
const SUBMIT_HAS_KEY_VIEW = `(function(){
  var el = document.querySelector(${JSON.stringify(SUBMIT)});
  return el ? el.hasAttribute("data-key-view-kbd") : false;
})()`;

// Whether the route popup trigger holds the keyboard key view. The route is a
// single button leaf stop, so `data-key-view-kbd` lands on the button itself.
const ROUTE_HAS_KEY_VIEW = `(function(){
  var el = document.querySelector(${JSON.stringify(ROUTE)});
  return el ? el.hasAttribute("data-key-view-kbd") : false;
})()`;

// Whether the fold control holds the keyboard key view. A leaf stop like
// the cells beside it, so the attribute rides the button itself.
const FOLD_HAS_KEY_VIEW = `(function(){
  var el = document.querySelector(${JSON.stringify(FOLD)});
  return el ? el.hasAttribute("data-key-view-kbd") : false;
})()`;

// Whether DOM focus is on the editor's content surface (the restored caret).
const EDITOR_FOCUSED = `(function(){
  var el = document.querySelector(${JSON.stringify(EDITOR)});
  return el !== null && document.activeElement === el;
})()`;

// The composer's text stop wearing the ring — the PARKED state ([P12]). The
// stop registers on the editor element itself, so the ring attribute rides it.
const EDITOR_STOP_RINGED = `(function(){
  return document.querySelector(${JSON.stringify(
    `${CARD} [data-slot="tug-prompt-entry"] [data-key-view-kbd][data-slot="tug-text-editor"]`,
  )}) !== null;
})()`;

/**
 * ⌥⇥ with the caret in the editor, then two Tabs to the route — the opening
 * move of every walk below.
 *
 * Engaging the mode does NOT advance: the ring lands on the stop the keyboard
 * was already in, which is the editor's own, and the landing parks it (ring, no
 * caret). Entering a mode is not a movement through it. This used to seed the
 * commit-home unconditionally, which meant ⌥⇥ moved the user's place before
 * they had asked to go anywhere.
 *
 * The editor is the LAST stop in the card's order, so the first Tab out of it
 * wraps to the FIRST — which is the route group, the toolbar row's leftmost
 * control now that the fold seat has moved down to Z2 ([B03]). That is
 * where the tours below all begin.
 */
async function engageAndTabToRoute(app: App): Promise<void> {
  await app.nativeKey("Tab", ["alt"]);
  await app.waitForCondition<boolean>(`${CYCLING} === "true"`, { timeoutMs: 6000 });
  await app.waitForCondition<boolean>(EDITOR_STOP_RINGED, { timeoutMs: 6000 });
  expect(
    await app.evalJS<boolean>(EDITOR_FOCUSED),
    "engaging the mode parks the editor stop — ring, no caret",
  ).toBe(false);
  await app.nativeKey("Tab");
  await app.waitForCondition<boolean>(ROUTE_HAS_KEY_VIEW, { timeoutMs: 6000 });
}

// Whether a status-cell detail surface is currently open. The Z2 status
// cells open the shared TugPlacard (`data-slot="tug-placard"`); a plain
// TugPopover (`data-slot="tug-popover"`) counts too.
const POPOVER_OPEN = `(document.querySelector('[data-slot="tug-popover"]') !== null || document.querySelector('[data-slot="tug-placard"]') !== null)`;

// Capability payload whose default model supports reasoning effort, so the AI
// chip's composite carries all three tokens rather than dropping the effort one.
// The chip itself is a live stop regardless (it disables only with the submit
// button, on `!canSubmit`), but a seeded model is what makes its value the
// full `model · effort · mode` line this test reads.
function effortModelCapabilities() {
  return {
    type: "session_capabilities",
    models: [
      {
        value: "default",
        displayName: "Default (recommended)",
        description: "Opus 4.8 (1M context)",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
    ],
    commands: [],
    agents: [],
    available_output_styles: [],
    output_style: "default",
    account: null,
    effort: null,
    ipc_version: 2,
  };
}

describe.skipIf(!SHOULD_RUN)("AT0140: the session card joins the focus cycle", () => {
  test(
    "⌥⇥ rings the stop the caret was in, Tab tours route → Claude Code → AI → submit → STATE → TIME → CONTEXT → TASKS → JOBS → editor → wrap (each Z4B chip + Z2 cell a leaf stop), skips the disabled submit when empty, and the editor stop parks",
    async () => {
      const app = await launchTugApp({ testName: "at0140-cycle-session-card" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A");
        await app.awaitEngineReady("A");
        // Seed an effort-capable model so the EFFORT chip is enabled and
        // joins the Tab cycle (a disabled chip drops out — see helper).
        await app.ingestSessionMetadata("A", effortModelCapabilities());

        // The connected body is up: the submit button mounts and is authored
        // into the cycle scope (a registered focusable).
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SUBMIT)}) !== null`,
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(SUBMIT)});
            return el !== null && el.hasAttribute("data-tug-focusable");
          })()`,
          { timeoutMs: 6000 },
        );

        // (1) Put the caret in the editor (base mode). The card is not cycling
        // and the submit holds no key view.
        await app.nativeClickAtElement(EDITOR);
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(await app.evalJS<string | null>(CYCLING)).toBe("false");
        expect(await app.evalJS<boolean>(SUBMIT_HAS_KEY_VIEW)).toBe(false);

        // (2) Empty editor → ⌥⇥ rings the editor's stop, Tab wraps to the route.
        // The submit is disabled (its
        // empty-input gate), so it is NOT a Tab target — touring the live stops
        // (route → Claude Code → AI → STATE → … → JOBS → fold → editor →
        // wrap) skips it: Tab steps from AI straight to the STATE cell,
        // never the submit.
        await engageAndTabToRoute(app);
        await app.nativeKey("Tab");
        // route → Claude Code: the Session and Project chips left the code route
        // with the Z4B diet (their names read in the pane title bar instead).
        await app.waitForCondition<boolean>(hasKeyView(CLAUDE_CHIP), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        // Claude Code → AI: Mode / Model / Effort merged into this one chip.
        await app.waitForCondition<boolean>(hasKeyView(AI_CHIP), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        // AI → STATE (the disabled submit is skipped). Each Z2 cell is its own leaf stop, so Tab steps
        // cell-to-cell through the rest of the row.
        await app.waitForCondition<boolean>(hasKeyView(Z2_STATE), { timeoutMs: 6000 });
        expect(await app.evalJS<boolean>(SUBMIT_HAS_KEY_VIEW)).toBe(false);
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(hasKeyView(Z2_TIME), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(hasKeyView(Z2_CONTEXT), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(hasKeyView(Z2_TASKS), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(hasKeyView(Z2_JOBS), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        // JOBS → the fold control, the last thing in the Z2 row ([B03]).
        await app.waitForCondition<boolean>(FOLD_HAS_KEY_VIEW, { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        // fold → editor. JOBS is the row's last cell: the BTW cell went away
        // with the Z2 diet, and `/btw` reaches its placard by being asked rather
        // than by a stop. The BEAT stop went with the strip — the voice moved
        // to the masthead, which is pane chrome and takes no card-cycle stop.
        // Arriving by engine movement PARKS the stop ([P12]): the ring lands on
        // the editor's stop and the caret does not.
        await app.waitForCondition<boolean>(EDITOR_STOP_RINGED, { timeoutMs: 6000 });
        expect(await app.evalJS<boolean>(EDITOR_FOCUSED)).toBe(false);
        // Tab from the parked stop keeps walking the cycle and wraps to the
        // FIRST stop — the route group, leftmost in the toolbar row. The stop
        // has no caret to indent for.
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(ROUTE_HAS_KEY_VIEW, { timeoutMs: 6000 });
        // ⌥⇥ off → back to the editor caret.
        await app.nativeKey("Tab", ["alt"]);
        await app.waitForCondition<boolean>(`${CYCLING} === "false"`, { timeoutMs: 6000 });
        await app.waitForCondition<boolean>(EDITOR_FOCUSED, { timeoutMs: 6000 });

        // Type into the editor so the submit becomes actionable (and thus a
        // cycle stop).
        await app.nativeType("hello");
        await app.waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(SUBMIT)});
            return el !== null && el.closest(${JSON.stringify(`${CARD} [data-slot="tug-prompt-entry"]`)})
              ?.getAttribute("data-empty") === "false";
          })()`,
          { timeoutMs: 6000 },
        );

        // (3) Non-empty editor → the same entry, and now the submit is a live
        // stop on the tour ([P10] revised order).
        await engageAndTabToRoute(app);

        // (4) Tab tours the stops left→right, up to the editor: route → Claude
        // Code → AI → submit → STATE … JOBS → editor. The editor is the
        // last stop — a text stop that carries the editor's own focus contract,
        // so landing on it grants the caret. With a draft in the field the tour
        // ends there (Tab is the editor's again — it indents); the empty-editor
        // wrap back to the route was pinned in (2).
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(hasKeyView(CLAUDE_CHIP), { timeoutMs: 6000 });
        expect(await app.evalJS<boolean>(ROUTE_HAS_KEY_VIEW)).toBe(false);
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(hasKeyView(AI_CHIP), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(SUBMIT_HAS_KEY_VIEW, { timeoutMs: 6000 });
        // submit → the five cells, each its own leaf stop ([P10] revised):
        // STATE → TIME → CONTEXT → TASKS → JOBS. Each carries the leaf key
        // view (and the blue ring) in turn — no arrow-roving. The fold
        // control follows JOBS at the row's trailing edge ([B03]).
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(hasKeyView(Z2_STATE), { timeoutMs: 6000 });
        expect(await app.evalJS<boolean>(SUBMIT_HAS_KEY_VIEW)).toBe(false);
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(hasKeyView(Z2_TIME), { timeoutMs: 6000 });
        expect(await app.evalJS<boolean>(hasKeyView(Z2_STATE))).toBe(false);
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(hasKeyView(Z2_CONTEXT), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(hasKeyView(Z2_TASKS), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(hasKeyView(Z2_JOBS), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(FOLD_HAS_KEY_VIEW, { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        // fold → editor: the control is the last leaf before it. Under KBF mode
        // the landing PARKS the stop rather than granting it ([P12]) — the ring
        // lands on the editor's stop and the caret does not, because arriving by
        // engine movement is a request to move the ring, not to type. Return or
        // any printable character grants the caret from here.
        await app.waitForCondition<boolean>(EDITOR_STOP_RINGED, { timeoutMs: 6000 });
        expect(
          await app.evalJS<boolean>(EDITOR_FOCUSED),
          "a stop arrived at by movement is parked — no caret",
        ).toBe(false);

        // (5) ⌥⇥ from the parked stop exits cycling and the resting landing
        // puts the caret back in the editor, draft intact.
        await app.nativeKey("Tab", ["alt"]);
        await app.waitForCondition<boolean>(`${CYCLING} === "false"`, { timeoutMs: 6000 });
        await app.waitForCondition<boolean>(EDITOR_FOCUSED, { timeoutMs: 6000 });

        // (6) A status-cell popover opened from a Z2 cell must not be read as a
        // cycle exit ([P10]). Re-enter, Tab to TIME, Return to open its popover,
        // Escape to close: the popover pushes a nested focus mode on top of the
        // card's cycle scope, but the card is STILL cycling (its scope remains
        // on the stack), so closing the popover returns the ring to the SAME
        // cell — focus is NOT yanked to the editor and the cycle position is not
        // lost.
        await engageAndTabToRoute(app);
        // route→Claude Code→AI→submit→STATE→TIME (5 Tabs). Two fewer
        // than before the Z4B diet (which took Session and Project off this
        // route), two fewer again since Mode / Model / Effort became one chip.
        // The fold control sits after JOBS, so it is not on this path.
        for (let i = 0; i < 5; i++) await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(hasKeyView(Z2_TIME), { timeoutMs: 6000 });
        // Return opens the TIME cell's popover (the cell `<button>` activates).
        await app.nativeKey("Return");
        await app.waitForCondition<boolean>(POPOVER_OPEN, { timeoutMs: 6000 });
        // While the popover is open the card's cycle scope is covered but still
        // on the stack — the card reads as cycling, NOT exited.
        expect(await app.evalJS<string | null>(CYCLING)).toBe("true");
        // Escape closes the popover. The ring returns to the TIME cell, the card
        // is still cycling, and DOM focus did not fall back to the editor.
        await app.nativeKey("Escape");
        await app.waitForCondition<boolean>(`${POPOVER_OPEN} === false`, { timeoutMs: 6000 });
        await app.waitForCondition<boolean>(hasKeyView(Z2_TIME), { timeoutMs: 6000 });
        expect(await app.evalJS<string | null>(CYCLING)).toBe("true");
        expect(await app.evalJS<boolean>(EDITOR_FOCUSED)).toBe(false);

        // (7) Comprehensive rule: USING THE MOUSE EXITS CYCLING. From step 6
        // (still cycling, cycle is the top mode), a CLICK on the editor ends the
        // cycle and returns the caret — no ⌥⇥ needed.
        await app.nativeClickAtElement(EDITOR);
        await app.waitForCondition<boolean>(`${CYCLING} === "false"`, { timeoutMs: 6000 });
        await app.waitForCondition<boolean>(EDITOR_FOCUSED, { timeoutMs: 6000 });

        // (8) The mouse-exit rule also fires for a click on a Z4B chip: re-enter
        // cycling, then a CLICK on the AI chip exits the cycle (a mouse click
        // leaves keyboard cycling) AND opens the chip's sheet. Closing it then
        // restores the prompt-entry caret (the cycle has exited — no keyboard key
        // view — so close-focus falls to the editor, not the chip).
        await app.nativeKey("Tab", ["alt"]);
        await app.waitForCondition<boolean>(`${CYCLING} === "true"`, { timeoutMs: 6000 });
        await app.nativeClickAtElement(AI_CHIP);
        await app.waitForCondition<boolean>(`${CYCLING} === "false"`, { timeoutMs: 6000 });
      } catch (err) {
        // A walk failure says only which stop was expected; the useful fact is
        // which stop the ring actually reached.
        const where = await app.evalJS<string>(
          `(function(){
            var els = document.querySelectorAll('[data-key-view-kbd]');
            var out = [];
            for (var i = 0; i < els.length; i++) {
              out.push((els[i].getAttribute('data-slot') || els[i].className)
                + (els[i].getAttribute('data-priority')
                  ? ':' + els[i].getAttribute('data-priority')
                  : ''));
            }
            return out.join(' | ');
          })()`,
        );
        process.stderr.write(`\n[at0140-cycle-session-card] ring on: ${where}\n`);
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0140-cycle-session-card] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "arrows give the cycle a 2D feel: a toolbar ring + a seam to the status row; a disabled stop is skipped; the editor is not an arrow stop",
    async () => {
      const app = await launchTugApp({ testName: "at0140-cycle-session-card-arrows" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A");
        await app.awaitEngineReady("A");
        // Seed an effort-capable model so the EFFORT chip is enabled and
        // joins the Tab cycle (a disabled chip drops out — see helper).
        await app.ingestSessionMetadata("A", effortModelCapabilities());
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SUBMIT)}) !== null`,
          { timeoutMs: 8000 },
        );

        // Caret in the editor (base mode).
        await app.nativeClickAtElement(EDITOR);
        await new Promise((resolve) => setTimeout(resolve, 150));

        // ---- Phase 1: a disabled stop is skipped --------------------------------
        // Empty editor → the submit is disabled. Engage and reach the route; Tab to the
        // AI chip, then ArrowRight resolves toward the (disabled) submit — the
        // navigator must NOT strand the ring on it: it skips to the next live stop
        // (STATE, the Z2 row's first member), never beeping.
        await engageAndTabToRoute(app);
        // route→Claude Code→AI (2 Tabs).
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(hasKeyView(CLAUDE_CHIP), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(hasKeyView(AI_CHIP), { timeoutMs: 6000 });
        await app.nativeKey("ArrowRight");
        await app.waitForCondition<boolean>(hasKeyView(Z2_STATE), { timeoutMs: 6000 });
        expect(await app.evalJS<boolean>(SUBMIT_HAS_KEY_VIEW)).toBe(false);

        // ArrowUp from the Z2 row seams back to the toolbar (its first member,
        // the route group) — and NOT to the editor, which is excluded from the
        // grid.
        await app.nativeKey("ArrowUp");
        await app.waitForCondition<boolean>(ROUTE_HAS_KEY_VIEW, { timeoutMs: 6000 });
        expect(await app.evalJS<boolean>(EDITOR_FOCUSED)).toBe(false);

        // Exit, type so the full toolbar (incl. submit) is live.
        await app.nativeKey("Tab", ["alt"]);
        await app.waitForCondition<boolean>(`${CYCLING} === "false"`, { timeoutMs: 6000 });
        await app.waitForCondition<boolean>(EDITOR_FOCUSED, { timeoutMs: 6000 });
        await app.nativeType("hello");
        await app.waitForCondition<boolean>(
          `(function(){var el=document.querySelector(${JSON.stringify(SUBMIT)});return el!==null && el.closest(${JSON.stringify(`${CARD} [data-slot="tug-prompt-entry"]`)})?.getAttribute("data-empty")==="false";})()`,
          { timeoutMs: 6000 },
        );

        // ---- Phase 2: the toolbar ring + the cross-row seam ---------------------
        await engageAndTabToRoute(app);

        // Tab to the AI chip (a leaf), then Left/Right ring the toolbar.
        // route→Claude Code→AI (2 Tabs).
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(hasKeyView(CLAUDE_CHIP), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(hasKeyView(AI_CHIP), { timeoutMs: 6000 });
        await app.nativeKey("ArrowRight");
        await app.waitForCondition<boolean>(SUBMIT_HAS_KEY_VIEW, { timeoutMs: 6000 });
        // Right off the last toolbar member wraps the closed ring back to the
        // row's first — the route group, now that the fold seat has moved
        // down into Z2 ([B03]).
        await app.nativeKey("ArrowRight");
        await app.waitForCondition<boolean>(ROUTE_HAS_KEY_VIEW, { timeoutMs: 6000 });
        // Left reverses (route → submit, the ring's other edge).
        await app.nativeKey("ArrowLeft");
        await app.waitForCondition<boolean>(SUBMIT_HAS_KEY_VIEW, { timeoutMs: 6000 });

        // The cross-row seam: Down from a toolbar chip enters the status row; Up
        // returns to the toolbar. Arrow back to the AI chip first.
        await app.nativeKey("ArrowLeft"); // submit → AI
        await app.waitForCondition<boolean>(hasKeyView(AI_CHIP), { timeoutMs: 6000 });
        await app.nativeKey("ArrowDown");
        // Down from a toolbar chip enters the Z2 row at its first member —
        // STATE — and Right from there is TIME. The fold control is the
        // row's LAST member ([B03]).
        await app.waitForCondition<boolean>(hasKeyView(Z2_STATE), { timeoutMs: 6000 });
        await app.nativeKey("ArrowRight");
        await app.waitForCondition<boolean>(hasKeyView(Z2_TIME), { timeoutMs: 6000 });
        await app.nativeKey("ArrowUp");
        await app.waitForCondition<boolean>(ROUTE_HAS_KEY_VIEW, { timeoutMs: 6000 });
        // Across the whole arrow sequence the caret never landed in the editor
        // and the card never left cycling (no dead-end, no beep).
        expect(await app.evalJS<boolean>(EDITOR_FOCUSED)).toBe(false);
        expect(await app.evalJS<string | null>(CYCLING)).toBe("true");
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0140-cycle-session-card-arrows] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "committing a settings picker opened from a cycle stop keeps cycling and returns the ring to the originating chip ([P15] retain)",
    async () => {
      const app = await launchTugApp({ testName: "at0140-cycle-session-card-picker" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A");
        await app.awaitEngineReady("A");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(AI_CHIP)}) !== null`,
          { timeoutMs: 8000 },
        );

        // Caret in the editor, then ⌥⇥ + Tab to the route: engaging rings the
        // editor's own stop, and the first Tab out of it wraps to the route.
        await app.nativeClickAtElement(EDITOR);
        await new Promise((resolve) => setTimeout(resolve, 150));
        await engageAndTabToRoute(app);

        // Tab to the AI chip and open its sheet by keyboard (so the engine owns
        // close-focus and the cycle is preserved underneath).
        // route→Claude Code→AI (2 Tabs).
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(hasKeyView(CLAUDE_CHIP), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(hasKeyView(AI_CHIP), { timeoutMs: 6000 });
        await app.nativeKey("Return");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET_OPTION)}) !== null`,
          { timeoutMs: 6000 },
        );
        // The sheet (a nested trap) covers the cycle scope but the card is STILL
        // cycling — opening a picker is not an exit.
        expect(await app.evalJS<string | null>(CYCLING)).toBe("true");

        // Return commits the sheet's default (OK). Under the card's chosen
        // disposition (`SESSION_CYCLE_PICKER_COMMIT_DISPOSITION = "retain"`) committing
        // a setting from a cycle stop KEEPS the card cycling and returns the ring
        // to the originating chip — the user can keep cycling. (The framework
        // supports "relinquish" too: commit exits cycling, caret to the prompt.)
        await app.nativeKey("Return");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET_OPTION)}) === null`,
          { timeoutMs: 6000 },
        );
        await app.waitForCondition<boolean>(hasKeyView(AI_CHIP), { timeoutMs: 6000 });
        expect(
          await app.evalJS<string | null>(CYCLING),
          "committing a cycle-stop picker keeps the card cycling (retain)",
        ).toBe("true");
        expect(
          await app.evalJS<boolean>(hasKeyView(AI_CHIP)),
          "the ring returns to the originating chip (retain)",
        ).toBe(true);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0140-cycle-session-card-picker] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "Space toggles an info popover ([P02] space-dismiss): Space opens the STATE popover from its stop, a second Space closes it and the ring returns to the stop",
    async () => {
      const app = await launchTugApp({ testName: "at0140-cycle-session-card-space-toggle" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A");
        await app.awaitEngineReady("A");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(Z2_STATE)}) !== null`,
          { timeoutMs: 8000 },
        );

        // Caret in the editor, then ⌥⇥ + Tab to the route: engaging rings the
        // editor's own stop, and the first Tab out of it wraps to the route.
        await app.nativeClickAtElement(EDITOR);
        await new Promise((resolve) => setTimeout(resolve, 150));
        await engageAndTabToRoute(app);

        // Tab off the route popup onto the Claude Code chip, then the AI chip —
        // toolbar leaves — then ArrowDown seams from the toolbar straight to the
        // Z2 row's first member — STATE — independent of which stops are live.
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(hasKeyView(CLAUDE_CHIP), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(hasKeyView(AI_CHIP), { timeoutMs: 6000 });
        await app.nativeKey("ArrowDown");
        await app.waitForCondition<boolean>(hasKeyView(Z2_STATE), { timeoutMs: 6000 });

        // Space OPENS the STATE popover (the cell button activates).
        await app.nativeKey(" ");
        await app.waitForCondition<boolean>(POPOVER_OPEN, { timeoutMs: 6000 });
        expect(await app.evalJS<string | null>(CYCLING)).toBe("true");

        // A SECOND Space CLOSES it (space-dismiss): the popover dismisses, the ring
        // returns to the STATE cell, the card stays cycling, and DOM focus does not
        // fall back to the editor.
        await app.nativeKey(" ");
        await app.waitForCondition<boolean>(`${POPOVER_OPEN} === false`, { timeoutMs: 6000 });
        await app.waitForCondition<boolean>(hasKeyView(Z2_STATE), { timeoutMs: 6000 });
        expect(await app.evalJS<string | null>(CYCLING)).toBe("true");
        expect(await app.evalJS<boolean>(EDITOR_FOCUSED)).toBe(false);

        // There is no second stop to check the toggle against any more: the
        // BEAT label was the other one, and it retired with the Z2 strip when
        // the voice moved into the pane's masthead. The label is still a
        // popover trigger there, but as pointer-only chrome — a card-cycle
        // stop that walked out of the card and into its chrome would cross an
        // ownership boundary.
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0140-cycle-session-card-space-toggle] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
