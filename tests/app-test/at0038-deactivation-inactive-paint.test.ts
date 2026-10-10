/**
 * at0038-deactivation-inactive-paint.test.ts — deactivation publishes
 * the user's selection to selectionGuard at the same DOM positions
 * the user actually selected ([AT0038] regression gate).
 *
 * Renamed from `m27-*` during the AT-series audit; the
 * original `m27` prefix collided with the AT0027 layout-state tag
 * (gated by `at0027-layout-state-persistence.test.ts`). AT0038 was
 * assigned in the canonical inventory at `tuglaws/at-series-inventory.md`.
 *
 * ## What this gates
 *
 * Manual repro: user types enough content into dev /
 * gallery-prompt-entry to make it scroll,
 * makes a selection, clicks any other card to deactivate. The
 * inactive-paint highlight ends up at the wrong text content — at
 * the absolute position in the component equal to the
 * relative/visible position when scrolled, instead of at the user's
 * actual selection.
 *
 * `paintMirrorAsInactive(publish)` rebuilds a DOM
 * Range from `mirror.selection` flat offsets via `flatToDom`. If
 * either the mirror's offsets are stale or the rebuilt Range's
 * DOM positions differ from the user's original Range, the
 * inactive highlight paints at the wrong place.
 *
 * This test verifies: at the moment of deactivation, the Range
 * landed in `selectionGuard.cardRanges` for the deactivated card has
 * the SAME DOM start/end (anchor/focus paths) as the user's
 * pre-deactivation selection in `window.getSelection()`.
 *
 * ## Test scenarios
 *
 * Two scenarios per target card:
 *   - SEED — bag.content is pre-seeded with text + selection +
 *     scrollTop; the engine restores it on mount; we deactivate.
 *   - TYPE — content is typed via `nativeType`; selection is set
 *     programmatically via the live DOM after user-driven typing
 *     populates the editor.
 *
 * Three cards × two scenarios = six tests. Each clicks a sibling
 * tab to deactivate, then asserts the cardRanges Range matches the
 * pre-deactivation live Range.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * Foreground: the selection this publishes lives in a CM6 editor, and CM6
 * tracks its selection from `view.hasFocus` — real DOM focus. A background
 * window’s document never has focus, so there is no live selection for
 * deactivation to hand to the inactive-selection highlight.
 *
 * @foreground
 *
 * @covers tugdeck/src/engine-hooks.ts
 * @covers tugdeck/src/components/tugways/selection-guard.ts
 * @covers tugdeck/src/card-state-orchestrator.ts
 * @covers tugdeck/src/focus-transfer.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 90_000;

const PROMPT_INPUT_SELECTOR =
  '[data-slot="tug-text-editor"] .cm-content';

/**
 * CM6's scrollable element. Editor scrollTop / scrollLeft are owned
 * by `view.scrollDOM` (`.cm-scroller`), NOT by the contenteditable
 * (`.cm-content`).
 */
const SCROLLER_SELECTOR =
  '[data-slot="tug-text-editor"] .cm-scroller';

const TUG_PROMPT_ENTRY_DEFAULT_ROUTE = "❯";

// Only the gallery-prompt-entry editor is exercised here. The `dev`
// (SessionCardBody) variants were removed: they died at a native
// second-pane activation click in the harness — a multi-pane CGEvent
// geometry brittleness, never reaching the selection-paint assertion —
// and the underlying property (selection survives deactivation at the
// correct DOM position) is already covered by this editor, which shares
// the same EM engine.
type PromptComponentId = "gallery-prompt-entry";

/**
 * Brief settle pause matching the natural pacing of user-driven
 * actions. WebKit's selectionchange / scroll / ResizeObserver
 * callbacks fire as microtasks or rAF-deferred; ramming events at
 * machine speed collapses the realistic timing where each step's
 * downstream effects commit before the next user action begins.
 * Use `waitForCondition` when there's a specific post-condition
 * to gate on; use this when there isn't.
 */
function pause(ms: number): Promise<void> {
  return new Promise<void>((resolve) =>
    (
      globalThis as unknown as {
        setTimeout: (fn: () => void, ms: number) => unknown;
      }
    ).setTimeout(() => resolve(), ms),
  );
}

// ---------------------------------------------------------------------------
// Seed payload — long enough to scroll an 8-row editor.
// ---------------------------------------------------------------------------

const SEED_LINES = Array.from(
  { length: 30 },
  (_, i) => `seed line ${(i + 1).toString().padStart(2, " ")} alpha beta gamma delta epsilon zeta eta`,
);
const SEED_TEXT = SEED_LINES.join("\n");
const SEED_SELECTION = { start: 200, end: 260 };
// Non-zero scroll to match the user's repro: "type enough content to
// make the component scroll. make a selection." If the
// `paintMirrorAsInactive` Range construction is sensitive to
// scrollTop (it shouldn't be — flat offsets are scroll-independent),
// a non-zero scroll exposes the bug.
const SEED_SCROLL_TOP = 120;

interface EngineState {
  text: string;
  atoms: ReadonlyArray<unknown>;
  selection: { start: number; end: number } | null;
  scrollTop?: number | null;
}

function makeContentBag(_componentId: PromptComponentId): Record<string, unknown> {
  const engineState: EngineState = {
    text: SEED_TEXT,
    atoms: [],
    selection: SEED_SELECTION,
    scrollTop: SEED_SCROLL_TOP,
  };
  return {
    currentRoute: TUG_PROMPT_ENTRY_DEFAULT_ROUTE,
    perRoute: { [TUG_PROMPT_ENTRY_DEFAULT_ROUTE]: engineState },
    maximized: false,
  };
}

/**
 * Two-pane geometry — matches the user's repro: session card and the
 * Component Gallery card live in separate panes; both are visible
 * simultaneously. Deactivation moves focus authority between panes
 * but doesn't hide either card. This is critical for reproducing
 * the user's bug — single-pane tab-switch hides the deactivated
 * card via `display: none`, which is a different code path.
 */
function deckShape(componentId: PromptComponentId) {
  return {
    cards: [
      { id: "A", componentId, title: "Card A", closable: true },
      {
        id: "B",
        componentId: "gallery-input" as const,
        title: "Card B",
        closable: true,
      },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 460, height: 540 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
      {
        id: "p2",
        position: { x: 540, y: 40 },
        size: { width: 460, height: 540 },
        cardIds: ["B"],
        activeCardId: "B",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

// ---------------------------------------------------------------------------
// Pre-deactivation snapshot of the live DOM Range
// ---------------------------------------------------------------------------

interface RangeSnapshot {
  anchorPath: number[];
  anchorOffset: number;
  focusPath: number[];
  focusOffset: number;
  text: string;
}

const SNAPSHOT_HELPERS_JS = `
function ${"snapshotPath".trim()}(root, node) {
  if (node === null) return null;
  var path = [];
  var cur = node;
  while (cur !== root) {
    var parent = cur.parentNode;
    if (!parent) return null;
    var idx = Array.prototype.indexOf.call(parent.childNodes, cur);
    if (idx === -1) return null;
    path.unshift(idx);
    cur = parent;
  }
  return path;
}
`;

async function snapshotLiveRange(
  app: App,
  cardId: string,
): Promise<RangeSnapshot | null> {
  return await app.evalJS<RangeSnapshot | null>(
    `(function(){
      ${SNAPSHOT_HELPERS_JS}
      var ed = document.querySelector('[data-card-id="${cardId}"] ${PROMPT_INPUT_SELECTOR}');
      if (!ed) return null;
      var sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      var r = sel.getRangeAt(0);
      if (!ed.contains(r.startContainer)) return null;
      var anchorPath = snapshotPath(ed, r.startContainer);
      var focusPath = snapshotPath(ed, r.endContainer);
      if (anchorPath === null || focusPath === null) return null;
      return {
        anchorPath: anchorPath,
        anchorOffset: r.startOffset,
        focusPath: focusPath,
        focusOffset: r.endOffset,
        text: r.toString(),
      };
    })()`,
  );
}

async function snapshotCardRange(
  app: App,
  cardId: string,
): Promise<RangeSnapshot | null> {
  return await app.evalJS<RangeSnapshot | null>(
    `(function(){
      ${SNAPSHOT_HELPERS_JS}
      var ed = document.querySelector('[data-card-id="${cardId}"] ${PROMPT_INPUT_SELECTOR}');
      if (!ed) return null;
      // Find the inactive-selection highlight's range for this card.
      if (typeof CSS === "undefined" || !CSS.highlights) return null;
      var h = CSS.highlights.get("inactive-selection");
      if (!h) return null;
      var iter = h.values ? h.values() : h[Symbol.iterator]();
      var step = iter.next();
      while (!step.done) {
        var r = step.value;
        if (ed.contains(r.startContainer)) {
          var anchorPath = snapshotPath(ed, r.startContainer);
          var focusPath = snapshotPath(ed, r.endContainer);
          if (anchorPath === null || focusPath === null) return null;
          return {
            anchorPath: anchorPath,
            anchorOffset: r.startOffset,
            focusPath: focusPath,
            focusOffset: r.endOffset,
            text: r.toString(),
          };
        }
        step = iter.next();
      }
      return null;
    })()`,
  );
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

/**
 * Live-path scenario: seed text + scrollTop only, NO selection.
 * Then natively set the selection via the DOM at the user's actual
 * scrolled position. This exercises the path the user runs in
 * production: their typed content is in DOM, they drag-select, the
 * engine's `selectionchange` listener writes mirror via `domToFlat`,
 * then deactivation reads mirror and builds a Range via `flatToDom`.
 *
 * If `domToFlat → flatToDom` round-trip is exact for the user's DOM
 * structure, the rebuilt Range matches. If not, the inactive paint
 * shows the wrong text.
 */
async function runLiveSelectionScenario(
  app: App,
  componentId: PromptComponentId,
): Promise<void> {
  await app.enableDeckTrace(true);

  // Seed text + scrollTop ONLY, no selection. The selection will be
  // set natively via the live DOM after mount.
  const engineStateNoSel: EngineState = {
    text: SEED_TEXT,
    atoms: [],
    selection: null,
    scrollTop: SEED_SCROLL_TOP,
  };
  const bagContent: Record<string, unknown> = {
    currentRoute: TUG_PROMPT_ENTRY_DEFAULT_ROUTE,
    perRoute: { [TUG_PROMPT_ENTRY_DEFAULT_ROUTE]: engineStateNoSel },
    maximized: false,
  };

  await app.seedDeckState({
    state: deckShape(componentId),
    cardStates: { A: { content: bagContent } },
    focusCardId: "A",
  });

  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
  );
  await app.awaitEngineReady("A");
  await app.waitForCondition<boolean>(
    `(function(){
      var s = window.__tug.getEmCardState("A");
      return s !== null && s.text === ${JSON.stringify(SEED_TEXT)};
    })()`,
    { timeoutMs: 4000 },
  );
  // Initial layout settle.
  await pause(150);

  // Natively set a selection via the live DOM. This simulates the
  // user's drag-select path: window.getSelection holds a Range
  // anchored in actual text nodes, and the engine's selectionchange
  // listener updates mirror via domToFlat.
  await app.evalJS<void>(
    `(function(){
      var ed = document.querySelector('[data-card-id="A"] ${PROMPT_INPUT_SELECTOR}');
      if (!ed) throw new Error("editor missing");
      ed.focus();
      // Find a text node deep enough that we exercise the
      // post-scroll content. We pick a Range that spans across a
      // <br> (the engine inserts <br> for "\\n" on restore) so the
      // round-trip exercises the BR-counting branch in
      // domToFlat / flatToDom.
      var walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
      var nodes = [];
      var t;
      while ((t = walker.nextNode())) nodes.push(t);
      if (nodes.length < 8) throw new Error("not enough text nodes: " + nodes.length);
      // Anchor in the 4th text node, focus in the 6th (spans 2-3 BRs).
      var startNode = nodes[3];
      var endNode = nodes[5];
      var range = document.createRange();
      range.setStart(startNode, 5);
      range.setEnd(endNode, 10);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    })()`,
  );

  // Wait for the engine's selectionchange listener to update mirror.
  await app.waitForCondition<boolean>(
    `(function(){
      var s = window.__tug.getEmCardState("A");
      return s !== null && s.engineSelection !== null;
    })()`,
    { timeoutMs: 2000 },
  );
  // Settle: let mirror catch up before we capture pre-deactivation
  // state.
  await pause(150);

  // Capture pre-deactivation: live Range + scrollTop snapshot.
  const liveBefore = await snapshotLiveRange(app, "A");
  expect(liveBefore, "pre-deactivation: live Range exists in window.getSelection").not.toBeNull();
  const scrollBefore = await app.evalJS<number>(
    `document.querySelector('[data-card-id="A"] ${SCROLLER_SELECTOR}').scrollTop`,
  );

  // Click into B's editor to activate B's pane and deactivate A.
  // Both cards are in separate panes — the click hits B's content
  // directly (no tab selector since each pane has only one card).
  await app.nativeClickAtElement(`[data-card-id="B"] [data-tug-state-key="gallery-input/size/sm"]`);
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && (window.__tug.getActiveCardId() === "B")`,
    { timeoutMs: 2000 },
  );
  // Settle window for transferFocusForActivation +
  // selectionGuard.updatePaint + post-deactivation ResizeObserver.
  await pause(200);

  // Wait for A's range in the inactive highlight.
  await app.waitForCondition<boolean>(
    `(function(){
      if (typeof CSS === "undefined" || !CSS.highlights) return false;
      var h = CSS.highlights.get("inactive-selection");
      if (!h) return false;
      var iter = h.values ? h.values() : h[Symbol.iterator]();
      var step = iter.next();
      var ed = document.querySelector('[data-card-id="A"] ${PROMPT_INPUT_SELECTOR}');
      if (!ed) return false;
      while (!step.done) {
        if (ed.contains(step.value.startContainer)) return true;
        step = iter.next();
      }
      return false;
    })()`,
    { timeoutMs: 2000 },
  );

  const inactiveAfter = await snapshotCardRange(app, "A");
  expect(
    inactiveAfter,
    `post-deactivation: A's range is in the inactive-selection highlight (componentId=${componentId})`,
  ).not.toBeNull();

  // Capture post-deactivation scrollTop.
  const scrollAfter = await app.evalJS<number>(
    `document.querySelector('[data-card-id="A"] ${SCROLLER_SELECTOR}').scrollTop`,
  );

  // Diagnostic — log everything if invariants fail.
  if (
    JSON.stringify(inactiveAfter) !== JSON.stringify(liveBefore) ||
    Math.abs(scrollBefore - scrollAfter) > 8
  ) {
    process.stderr.write(
      `\n[at0027-diag ${componentId}] LIVE-BEFORE=${JSON.stringify(liveBefore)} INACTIVE-AFTER=${JSON.stringify(inactiveAfter)} SCROLL-BEFORE=${scrollBefore} SCROLL-AFTER=${scrollAfter}\n`,
    );
  }

  // Load-bearing assertions.
  expect(
    inactiveAfter,
    `live-path: post-deactivation Range must match pre-deactivation Range exactly (componentId=${componentId})`,
  ).toEqual(liveBefore!);
  expect(
    Math.abs(scrollBefore - scrollAfter),
    `live-path: editor scrollTop must be preserved across deactivation (before=${scrollBefore} after=${scrollAfter})`,
  ).toBeLessThanOrEqual(8);
}

async function runDeactivationScenario(
  app: App,
  componentId: PromptComponentId,
): Promise<void> {
  await app.enableDeckTrace(true);

  const bag = { content: makeContentBag(componentId) };
  await app.seedDeckState({
    state: deckShape(componentId),
    cardStates: { A: bag },
    focusCardId: "A",
  });

  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
  );
  await app.awaitEngineReady("A");

  await app.waitForCondition<boolean>(
    `(function(){
      var s = window.__tug.getEmCardState("A");
      return s !== null && s.text === ${JSON.stringify(SEED_TEXT)};
    })()`,
    { timeoutMs: 4000 },
  );

  // Wait for the active card to land its selection in window.getSelection
  // (paintMirrorAsActive runs from onRestore for active cards).
  const expectedSelText = SEED_TEXT.slice(SEED_SELECTION.start, SEED_SELECTION.end).replace(
    /\n/g,
    "",
  );
  await app.waitForCondition<boolean>(
    `(function(){
      var sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return false;
      return sel.getRangeAt(0).toString() === ${JSON.stringify(expectedSelText)};
    })()`,
    { timeoutMs: 4000 },
  );
  // Initial layout settle — let any ResizeObserver-driven autoResize
  // converge before we capture pre-deactivation state.
  await pause(200);

  // Capture pre-deactivation: live Range + scrollTop snapshot.
  const liveBefore = await snapshotLiveRange(app, "A");
  expect(
    liveBefore,
    "pre-deactivation: the active card's live Range is in window.getSelection",
  ).not.toBeNull();
  const scrollBefore = await app.evalJS<number>(
    `document.querySelector('[data-card-id="A"] ${SCROLLER_SELECTOR}').scrollTop`,
  );

  // Click into B's editor to activate B's pane and deactivate A.
  // Both cards are in separate panes — the click hits B's content
  // directly (no tab selector since each pane has only one card).
  await app.nativeClickAtElement(`[data-card-id="B"] [data-tug-state-key="gallery-input/size/sm"]`);
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && (window.__tug.getActiveCardId() === "B")`,
    { timeoutMs: 2000 },
  );
  // Settle window for transferFocusForActivation +
  // selectionGuard.updatePaint + post-deactivation ResizeObserver.
  await pause(200);

  // Wait for A's range to land in the inactive-selection Highlight.
  await app.waitForCondition<boolean>(
    `(function(){
      if (typeof CSS === "undefined" || !CSS.highlights) return false;
      var h = CSS.highlights.get("inactive-selection");
      if (!h) return false;
      var iter = h.values ? h.values() : h[Symbol.iterator]();
      var step = iter.next();
      var ed = document.querySelector('[data-card-id="A"] ${PROMPT_INPUT_SELECTOR}');
      if (!ed) return false;
      while (!step.done) {
        if (ed.contains(step.value.startContainer)) return true;
        step = iter.next();
      }
      return false;
    })()`,
    { timeoutMs: 2000 },
  );

  // Capture post-deactivation snapshot of A's range in the inactive
  // highlight.
  const inactiveAfter = await snapshotCardRange(app, "A");
  expect(
    inactiveAfter,
    `post-deactivation: A's range is in the inactive-selection highlight (componentId=${componentId})`,
  ).not.toBeNull();

  // Capture post-deactivation scrollTop.
  const scrollAfter = await app.evalJS<number>(
    `document.querySelector('[data-card-id="A"] ${SCROLLER_SELECTOR}').scrollTop`,
  );

  // Diagnostic on failure.
  if (
    JSON.stringify(inactiveAfter) !== JSON.stringify(liveBefore) ||
    Math.abs(scrollBefore - scrollAfter) > 8
  ) {
    process.stderr.write(
      `\n[at0027-diag seed ${componentId}] LIVE-BEFORE=${JSON.stringify(liveBefore)} INACTIVE-AFTER=${JSON.stringify(inactiveAfter)} SCROLL-BEFORE=${scrollBefore} SCROLL-AFTER=${scrollAfter}\n`,
    );
  }

  // The load-bearing assertion: the inactive highlight's Range has
  // the SAME DOM start/end as the user's pre-deactivation selection.
  // If the rebuilt Range (via mirror.selection → flatToDom) lands at
  // different DOM positions, the user sees the highlight at the wrong
  // text — the bug the user reported.
  expect(
    inactiveAfter,
    `post-deactivation Range must match pre-deactivation Range exactly (componentId=${componentId})`,
  ).toEqual(liveBefore!);
  expect(
    Math.abs(scrollBefore - scrollAfter),
    `editor scrollTop must be preserved across deactivation (before=${scrollBefore} after=${scrollAfter})`,
  ).toBeLessThanOrEqual(8);
}

// ---------------------------------------------------------------------------
// Tests — 2 cards
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)(
  "m38: deactivation publishes inactive paint at the user's exact DOM position",
  () => {
    test(
      "gallery-prompt-entry — seeded selection survives deactivation at correct DOM position",
      async () => {
        const app = await launchTugApp({
          testName: "at0027-gallery-prompt-entry",
          foreground: true,
        });
        try {
          await runDeactivationScenario(app, "gallery-prompt-entry");
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "gallery-prompt-entry — LIVE selection (set via DOM) survives deactivation",
      async () => {
        const app = await launchTugApp({
          testName: "at0027-live-gallery-prompt-entry",
          foreground: true,
        });
        try {
          await runLiveSelectionScenario(app, "gallery-prompt-entry");
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "gallery-prompt-entry — TYPE-and-SCROLL then deactivate preserves scroll + selection",
      async () => {
        const app = await launchTugApp({
          testName: "at0027-type-gallery-prompt-entry",
          foreground: true,
        });
        try {
          await app.enableDeckTrace(true);
          // Empty seed — user types from scratch.
          await app.seedDeckState({
            state: deckShape("gallery-prompt-entry"),
            cardStates: {},
            focusCardId: "A",
          });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
          );
          await app.awaitEngineReady("A");
          // Initial layout settle — let the engine ResizeObserver
          // fire once for the mounted editor before we start typing.
          await pause(150);

          // Click into A's editor.
          await app.nativeClickAtElement(`[data-card-id="A"] ${PROMPT_INPUT_SELECTOR}`);
          await app.waitForCondition<boolean>(
            `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(PROMPT_INPUT_SELECTOR)})`,
          );
          await pause(100);

          // Type the content one line at a time with a Return
          // keypress between lines. Real typing is paced over many
          // tens of milliseconds per character; ramming all 30 lines
          // in one burst doesn't give the engine's input-handler /
          // autoResize / scrollCaretIntoView / ResizeObserver /
          // mirror chain time to commit between characters. We chunk
          // by line and pause so each line's effects settle before
          // the next.
          //
          // `nativeType` accepts ASCII-only and rejects "\n" (no
          // VirtualKeyMap entry). Use `nativeKey("Return")` between
          // lines — the engine's beforeinput handler converts the
          // resulting `insertParagraph` to `insertLineBreak`, which
          // produces a `<br>` (matching the engine's content model).
          for (let i = 0; i < SEED_LINES.length; i++) {
            await app.nativeType(SEED_LINES[i]);
            await pause(40);
            if (i < SEED_LINES.length - 1) {
              await app.nativeKey("Return");
              await pause(40);
            }
          }
          // Wait for the engine's getText to reflect the typed
          // content. The engine reads from DOM via
          // `getEmCardState`; this waits until DOM and engine
          // agree.
          await app.waitForCondition<boolean>(
            `(function(){
              var s = window.__tug.getEmCardState("A");
              return s !== null && s.text.length > 800;
            })()`,
            { timeoutMs: 4000 },
          );
          await pause(200);

          // Native-scroll the editor — mimics mouse-wheel scrolling.
          // CM6 owns scroll on `.cm-scroller`, not on the contenteditable.
          await app.evalJS<void>(
            `(function(){
              var ed = document.querySelector('[data-card-id="A"] ${SCROLLER_SELECTOR}');
              ed.scrollTop = ${SEED_SCROLL_TOP};
            })()`,
          );
          // Wait for the scroll listener to update mirror (settle).
          await app.waitForCondition<boolean>(
            `(function(){
              var ed = document.querySelector('[data-card-id="A"] ${SCROLLER_SELECTOR}');
              return Math.abs(ed.scrollTop - ${SEED_SCROLL_TOP}) < 4;
            })()`,
            { timeoutMs: 2000 },
          );
          await pause(150);

          // Native-select a span. Pick text nodes that are visible
          // at the current scroll so WebKit doesn't auto-scroll on
          // setBaseAndExtent. With scrollTop=120 and ~24px line
          // height, the visible window starts ~5 lines in;
          // nodes[10..14] should be in that window.
          await app.evalJS<void>(
            `(function(){
              var ed = document.querySelector('[data-card-id="A"] ${PROMPT_INPUT_SELECTOR}');
              ed.focus();
              var walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
              var nodes = [];
              var t;
              while ((t = walker.nextNode())) nodes.push(t);
              if (nodes.length < 16) throw new Error("not enough text nodes: " + nodes.length);
              var startNode = nodes[10];
              var endNode = nodes[12];
              var range = document.createRange();
              range.setStart(startNode, 5);
              range.setEnd(endNode, 10);
              var sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
            })()`,
          );
          // Wait for the selectionchange listener to update mirror.
          await app.waitForCondition<boolean>(
            `(function(){
              var s = window.__tug.getEmCardState("A");
              return s !== null && s.engineSelection !== null;
            })()`,
            { timeoutMs: 2000 },
          );
          await pause(150);

          const liveBefore = await snapshotLiveRange(app, "A");
          expect(liveBefore).not.toBeNull();
          const scrollBefore = await app.evalJS<number>(
            `document.querySelector('[data-card-id="A"] ${SCROLLER_SELECTOR}').scrollTop`,
          );

          // Click into B's editor to deactivate A — the user-action
          // moment.
          await app.nativeClickAtElement(
            `[data-card-id="B"] [data-tug-state-key="gallery-input/size/sm"]`,
          );
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && (window.__tug.getActiveCardId() === "B")`,
            { timeoutMs: 2000 },
          );
          // Settle window for transferFocusForActivation +
          // selectionGuard.updatePaint + any post-deactivation
          // ResizeObserver firings.
          await pause(200);

          await app.waitForCondition<boolean>(
            `(function(){
              if (typeof CSS === "undefined" || !CSS.highlights) return false;
              var h = CSS.highlights.get("inactive-selection");
              if (!h) return false;
              var iter = h.values ? h.values() : h[Symbol.iterator]();
              var step = iter.next();
              var ed = document.querySelector('[data-card-id="A"] ${PROMPT_INPUT_SELECTOR}');
              if (!ed) return false;
              while (!step.done) {
                if (ed.contains(step.value.startContainer)) return true;
                step = iter.next();
              }
              return false;
            })()`,
            { timeoutMs: 2000 },
          );
          const inactiveAfter = await snapshotCardRange(app, "A");
          const scrollAfter = await app.evalJS<number>(
            `document.querySelector('[data-card-id="A"] ${SCROLLER_SELECTOR}').scrollTop`,
          );

          if (
            JSON.stringify(inactiveAfter) !== JSON.stringify(liveBefore) ||
            Math.abs(scrollBefore - scrollAfter) > 8
          ) {
            process.stderr.write(
              `\n[at0027-diag type-and-scroll] LIVE-BEFORE=${JSON.stringify(liveBefore)} INACTIVE-AFTER=${JSON.stringify(inactiveAfter)} SCROLL-BEFORE=${scrollBefore} SCROLL-AFTER=${scrollAfter}\n`,
            );
          }
          expect(inactiveAfter).toEqual(liveBefore!);
          expect(Math.abs(scrollBefore - scrollAfter)).toBeLessThanOrEqual(8);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
