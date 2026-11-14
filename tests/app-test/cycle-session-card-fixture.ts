/**
 * cycle-session-card-fixture.ts — the selectors, probes and opening move the
 * at0140-cycle-session-card-* files share.
 *
 * Split out of `at0140-cycle-session-card.test.ts` when that file was cut, a
 * test to a file, into `at0140-cycle-session-card-walk`, `-arrows`, `-picker`
 * and `-space-toggle` so each launch fits its own budget.
 *
 * ## Why this exists
 *
 * The session card joins the keyboard-focus-cycling mode: ⌥⇥ rings the stop
 * the caret was in, Tab tours the card's chrome, ⌥⇥ again restores the editor
 * caret ([P09]/[P10]/[P12], [#step-cycle-session-card]).
 *
 * The cycle mechanism was proven generically on the `fixture-cycle-demo` card.
 * These files gate the *real consumer*: a connected session card. The card root
 * carries `data-cycling`, the engine signal the fill-suppression CSS keys on.
 *
 * **Mode entry does not advance.** ⌥⇥ engages and the ring lands on the stop
 * that already held the keyboard — from the composer that is the editor's own
 * stop, which parks (ring, no caret). Entering a mode is not a movement through
 * it; the ring's job is to mark where the keyboard IS. The test asserted the
 * opposite until the composer's ring was found to be painting nothing at all:
 * ⌥⇥ seeded the commit-home ([P10]'s lowest-order stop), so engaging silently
 * moved the user's place, and the only reason that looked survivable was that
 * the editor's ring was suppressed by CSS left over from the pre-KBF axiom.
 *
 * The walk (`-walk`):
 *   1. **rest:** clicking the editor puts the caret there (base mode); the card
 *      reads `data-cycling="false"` and the submit holds no key view.
 *   2. **empty editor → submit is skipped:** ⌥⇥ rings the editor's stop and one
 *      Tab wraps to the route (the editor is the LAST stop and the route is
 *      the FIRST, now that the fold seat has moved into Z2, [B03]);
 *      touring the live stops (route → Claude Code → AI → fold → STATE → TIME
 *      → CONTEXT → ARC → JOBS → editor → wrap) never lands on the
 *      submit, because its empty-input gate disables it. ⌥⇥ off restores caret.
 *   3. **typed editor:** with content, the same entry — ring on the editor's
 *      stop, Tab to the route — and now the submit is live.
 *   4. **Tab tours the stops:** route → Claude Code → AI → mic → submit →
 *      fold → STATE → TIME → CONTEXT → ARC → JOBS → editor → wrap
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
 * `-arrows` pins the 2D arrow feel, `-picker` the [P15] retain disposition of
 * a settings picker committed from a cycle stop, and `-space-toggle` the [P02]
 * space-dismiss of an info popover.
 *
 * Mode keys (Return / Space) are a later step; this gates the session-card
 * push/seed/wrap/restore + the `data-cycling` signal. The Picker → Open default
 * focus is environment-sensitive (it depends on whether a valid path seeds Open
 * enabled), so it is verified by-eye rather than asserted here.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @module tests/app-test/cycle-session-card-fixture
 */

import { expect } from "bun:test";

import { type App } from "./_harness";
import { ROUTE_CHOICE } from "./_harness/selectors";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 120_000;

export const CARD = '[data-card-id="A"]';
export const ROOT = `${CARD} [data-testid="session-card"]`;
export const SUBMIT = `${CARD} .tug-prompt-entry-submit-button`;
export const ROUTE = `${CARD} ${ROUTE_CHOICE}`;
// The card's one fold control ([B03]) — at the trailing edge of the Z2
// status row, in both of the card's forms, and so the stop just after the
// five cells.
export const FOLD = `${CARD} [data-slot="session-fold-control"] button`;
// The three Z4B indicator chips now in the cycle ([P10] revised — no control
// left behind): the route indicator (Claude Code / Shell), the Session badge,
// and the Project button. Each is a leaf stop carrying `data-key-view-kbd`
// when active. All three are live + enabled in the headless harness
// (`bindSession` defaults a `projectDir`, and the Code route enables them).
// The Code route's two Z4B chips: the Claude Code identity chip, then the AI
// settings chip that replaced three — Mode, Model, and Effort — so the toolbar
// walk steps route → Claude Code → AI → mic → submit.
export const CLAUDE_CHIP = `${CARD} [data-slot="session-route-indicator-badge"]`;
export const AI_CHIP = `${CARD} [data-slot="ai-chip"]`;
/** The Z5 mic, which sits between the AI chip and the submit (Spec S06). */
export const DICTATE = `${CARD} [data-testid="tug-dictation-button"]`;
export const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
// The five Z2 status cells. Each is its own leaf cycle stop ([P10]
// revised — no item-group roving): the cell `<button>` carries
// `data-key-view-kbd` (and the leaf ring) when it is the active stop.
export const Z2_STATE = `${CARD} [data-priority="state"]`;
export const Z2_TIME = `${CARD} [data-priority="time"]`;
export const Z2_CONTEXT = `${CARD} [data-priority="context"]`;
export const Z2_ARC = `${CARD} [data-priority="arc"]`;
export const Z2_JOBS = `${CARD} [data-priority="jobs"]`;
// A settings sheet opened from a cycle-stop chip (here the permission-mode chip,
// which populates reliably headless) and one of its option rows.
export const SHEET = '[data-slot="tug-sheet"]';
// A row of the AI mixer sheet — the MODE choice group, whose presence is the
// simplest proof the sheet is up.
export const SHEET_OPTION = `${SHEET} [data-testid="ai-config-mode"]`;

// Expression: does the element at `selector` hold the keyboard key view? Every
// stop is a leaf (submit, the route popup trigger, the Z4B chips, the Z2 cells)
// — the element itself carries `data-key-view-kbd` when it is the active stop.
export function hasKeyView(selector: string): string {
  return `(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    return el ? el.hasAttribute("data-key-view-kbd") : false;
  })()`;
}

// `data-cycling` on the session-card root, or null.
export const CYCLING = `(function(){
  var el = document.querySelector(${JSON.stringify(ROOT)});
  return el ? el.getAttribute("data-cycling") : null;
})()`;

// Whether the submit button currently holds the keyboard key view.
export const SUBMIT_HAS_KEY_VIEW = `(function(){
  var el = document.querySelector(${JSON.stringify(SUBMIT)});
  return el ? el.hasAttribute("data-key-view-kbd") : false;
})()`;

// Whether the route popup trigger holds the keyboard key view. The route is a
// single button leaf stop, so `data-key-view-kbd` lands on the button itself.
export const ROUTE_HAS_KEY_VIEW = `(function(){
  var el = document.querySelector(${JSON.stringify(ROUTE)});
  return el ? el.hasAttribute("data-key-view-kbd") : false;
})()`;

// Whether the fold control holds the keyboard key view. A leaf stop like
// the cells beside it, so the attribute rides the button itself.
export const FOLD_HAS_KEY_VIEW = `(function(){
  var el = document.querySelector(${JSON.stringify(FOLD)});
  return el ? el.hasAttribute("data-key-view-kbd") : false;
})()`;

// Whether DOM focus is on the editor's content surface (the restored caret).
export const EDITOR_FOCUSED = `(function(){
  var el = document.querySelector(${JSON.stringify(EDITOR)});
  return el !== null && document.activeElement === el;
})()`;

// The composer's text stop wearing the ring — the PARKED state ([P12]). The
// stop registers on the editor element itself, so the ring attribute rides it.
export const EDITOR_STOP_RINGED = `(function(){
  return document.querySelector(${JSON.stringify(
    `${CARD} [data-slot="tug-prompt-entry"] [data-key-view-kbd][data-slot="tug-text-editor"]`,
  )}) !== null;
})()`;

/**
 * ⌥⇥ with the caret in the editor, then two Tabs to the route — the opening
 * move of every walk.
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
 * where the tours all begin.
 */
export async function engageAndTabToRoute(app: App): Promise<void> {
  await app.nativeKey("Tab", ["alt"]);
  await app.body("A").waitForCondition<boolean>(`${CYCLING} === "true"`, { timeoutMs: 6000 });
  await app.body("A").waitForCondition<boolean>(EDITOR_STOP_RINGED, { timeoutMs: 6000 });
  expect(
    await app.body("A").evalJS<boolean>(EDITOR_FOCUSED),
    "engaging the mode parks the editor stop — ring, no caret",
  ).toBe(false);
  await app.nativeKey("Tab");
  await app.body("A").waitForCondition<boolean>(ROUTE_HAS_KEY_VIEW, { timeoutMs: 6000 });
}

// Whether a status-cell detail surface is currently open. The Z2 status
// cells open the shared SessionPlacard (`data-slot="tug-placard"`); a plain
// TugPopover (`data-slot="tug-popover"`) counts too.
export const POPOVER_OPEN = `(document.querySelector('[data-slot="tug-popover"]') !== null || document.querySelector('[data-slot="tug-placard"]') !== null)`;

// Capability payload whose default model supports reasoning effort, so the AI
// chip's composite carries all three tokens rather than dropping the effort one.
// The chip itself is a live stop regardless (it disables only with the submit
// button, on `!canSubmit`), but a seeded model is what makes its value the
// full `model · effort · mode` line the walk reads.
export function effortModelCapabilities() {
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
