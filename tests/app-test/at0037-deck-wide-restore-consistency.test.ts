/**
 * at0037-deck-wide-restore-consistency.test.ts — multi-card restore
 * preserves the active/inactive selection invariants ([AT0037]).
 *
 * Renamed from `m26-*`; the
 * original `m26` prefix collided with the AT0026 overlay-policy tag
 * (gated by `at0026-overlay-persistence.test.ts`). AT0037 was assigned in
 * the canonical inventory at `tuglaws/at-series-inventory.md`.
 *
 * ## What this gates
 *
 * The engine paint API split into active vs. inactive paths and
 * CardHost's `onRestore` routes by `isActive`. This test
 * verifies the result on multi-card decks:
 *
 *   1. Exactly one card holds document focus — the deck-level
 *      first responder.
 *   2. Exactly one card's range is in `window.getSelection()` (same
 *      card).
 *   3. Every inactive card's selection lives in
 *      `selectionGuard.cardRanges` and is observable via
 *      `__tug.getCaretState(cardId)`.
 *   4. Every inactive card's range is in the
 *      `inactive-selection` CSS Custom Highlight; the active card's
 *      range is NOT.
 *   5. Every card's bag-on-disk has the four 25C.3 axes
 *      (text/atoms/selection/scrollTop) preserved.
 *
 * Pre-25C.4: tests fail because every card's restore calls
 * `setSelectedRange` (focus + `addRange` + `removeAllRanges`), the
 * last writer wins the global Selection / focus, and the deck-level
 * first responder may not be the last writer.
 * Post-25C.4: deterministic — only the active card runs
 * `paintMirrorAsActive`; every inactive card runs
 * `paintMirrorAsInactive(publish)`.
 *
 * ## Test matrix (4 layouts × 2 triggers = 8 tests)
 *
 *   | Layout | Pane geometry | Active (deck FR) | Inactive |
 *   |--------|---------------|------------------|----------|
 *   | L1 | 1 pane, 2 cards (tabs) | gallery-prompt-entry #A | gallery-prompt-entry #B |
 *   | L2 | 1 pane, 2 cards (tabs) | gallery-prompt-entry | dev |
 *   | L3 | 1 pane, 2 cards (tabs) | dev | gallery-prompt-entry |
 *   | L4 | 2 panes, 1 card each | gallery-prompt-entry (in active pane) | dev (pane-active in non-active pane) |
 *
 * L4 is the load-bearing case for the "active = deck-level first
 * responder, NOT pane-active" precision ("Defining
 * 'active' precisely"). Dev is the active card of P2, but P2 is
 * not the active pane — so dev is NOT the deck-level first
 * responder, and its selection routes through
 * `paintMirrorAsInactive`.
 *
 * Triggers: `app.appReload()` (Layer 1 primitive) and
 * `app.quitGracefully()` + relaunch.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/serialization.ts
 * @covers tugdeck/src/card-state-orchestrator.ts
 * @covers tugdeck/src/components/tugways/selection-guard.ts
 * @covers tugdeck/src/deck-manager.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankRead,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 90_000;

const PROMPT_INPUT_SELECTOR =
  '[data-slot="tug-text-editor"] .cm-content';

const TUG_PROMPT_ENTRY_DEFAULT_ROUTE = "❯";

// ---------------------------------------------------------------------------
// Per-card seed payload — each card carries a unique selection so the
// test can attribute survival/loss to the right card.
// ---------------------------------------------------------------------------

/**
 * Build a per-card seed text. The card's `suffix` is embedded in
 * every line so the per-card selected substring (offsets 50-100) is
 * distinct across cards — letting the test verify which card's
 * selection ended up in `window.getSelection()` etc.
 */
function seedTextForCard(suffix: string): string {
  return [
    `card-${suffix} line 1: alpha beta gamma delta`,
    `card-${suffix} line 2: epsilon zeta eta theta`,
    `card-${suffix} line 3: iota kappa lambda mu`,
    `card-${suffix} line 4: nu xi omicron pi`,
    `card-${suffix} line 5: rho sigma tau upsilon`,
    `card-${suffix} line 6: phi chi psi omega`,
    `card-${suffix} line 7: aaa bbb ccc ddd eee`,
    `card-${suffix} line 8: 1234 5678 9012 3456`,
  ].join("\n");
}

const SEED_SELECTION = { start: 50, end: 100 };
const SEED_SCROLL_TOP = 0;

interface EngineState {
  text: string;
  atoms: ReadonlyArray<{
    position: number;
    type: string;
    label: string;
    value: string;
  }>;
  selection: { start: number; end: number } | null;
}

function makeEngineState(suffix: string): EngineState {
  return {
    text: seedTextForCard(suffix),
    atoms: [],
    selection: SEED_SELECTION,
  };
}

type PromptComponentId =
  | "gallery-prompt-entry"
  | "session";

function makeContentBag(
  _componentId: PromptComponentId,
  suffix: string,
): Record<string, unknown> {
  const engineState = makeEngineState(suffix);
  return {
    currentRoute: TUG_PROMPT_ENTRY_DEFAULT_ROUTE,
    perRoute: { [TUG_PROMPT_ENTRY_DEFAULT_ROUTE]: engineState },
    maximized: false,
  };
}

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

type LayoutId = "L1" | "L2" | "L3" | "L4";

interface CardDescriptor {
  cardId: string;
  componentId: PromptComponentId;
  suffix: string;
}

interface PaneDescriptor {
  id: string;
  cardIds: string[];
  activeCardId: string;
}

interface Layout {
  id: LayoutId;
  cards: CardDescriptor[];
  panes: PaneDescriptor[];
  activePaneId: string;
  /** The deck-level first responder — the card that should hold focus. */
  activeCardId: string;
}

function buildDeckShape(layout: Layout) {
  return {
    cards: layout.cards.map((c) => ({
      id: c.cardId,
      componentId: c.componentId,
      title: `Card ${c.cardId}`,
      closable: true,
    })),
    panes: layout.panes.map((p, i) => ({
      id: p.id,
      position: { x: 40 + i * 480, y: 40 },
      size: { width: 460, height: 360 },
      cardIds: p.cardIds,
      activeCardId: p.activeCardId,
      title: "",
      acceptsFamilies: ["maker"],
    })),
    activePaneId: layout.activePaneId,
    hasFocus: true,
  };
}

function makeLayout(id: LayoutId): Layout {
  switch (id) {
    case "L1":
      return {
        id,
        cards: [
          { cardId: "A", componentId: "gallery-prompt-entry", suffix: "A" },
          { cardId: "B", componentId: "gallery-prompt-entry", suffix: "B" },
        ],
        panes: [{ id: "p1", cardIds: ["A", "B"], activeCardId: "A" }],
        activePaneId: "p1",
        activeCardId: "A",
      };
    case "L2":
      return {
        id,
        cards: [
          { cardId: "A", componentId: "gallery-prompt-entry", suffix: "A" },
          { cardId: "B", componentId: "session", suffix: "B" },
        ],
        panes: [{ id: "p1", cardIds: ["A", "B"], activeCardId: "A" }],
        activePaneId: "p1",
        activeCardId: "A",
      };
    case "L3":
      return {
        id,
        cards: [
          { cardId: "A", componentId: "session", suffix: "A" },
          { cardId: "B", componentId: "gallery-prompt-entry", suffix: "B" },
        ],
        panes: [{ id: "p1", cardIds: ["A", "B"], activeCardId: "A" }],
        activePaneId: "p1",
        activeCardId: "A",
      };
    case "L4":
      return {
        id,
        cards: [
          { cardId: "A", componentId: "gallery-prompt-entry", suffix: "A" },
          { cardId: "B", componentId: "session", suffix: "B" },
        ],
        panes: [
          { id: "p1", cardIds: ["A"], activeCardId: "A" },
          { id: "p2", cardIds: ["B"], activeCardId: "B" },
        ],
        activePaneId: "p1",
        activeCardId: "A",
      };
  }
}

// ---------------------------------------------------------------------------
// Phase A — seed all cards with text + selection in bag.content;
// active card has bag.focus pointing to its engine root; wait for
// all engines ready; trigger reload (caller-driven).
// ---------------------------------------------------------------------------

async function setupPhaseA(app: App, layout: Layout): Promise<void> {
  await app.enableDeckTrace(true);

  const cardStates: Record<string, { content: Record<string, unknown> }> = {};
  for (const c of layout.cards) {
    cardStates[c.cardId] = {
      content: makeContentBag(c.componentId, c.suffix),
    };
  }

  await app.seedDeckState({
    state: buildDeckShape(layout),
    cardStates,
    focusCardId: layout.activeCardId,
  });

  // Bind dev sessions (skip past the project picker).
  for (const c of layout.cards) {
    if (c.componentId === "session") {
      await app.bindSession(c.cardId);
    }
  }

  // Wait for all card hosts registered.
  for (const c of layout.cards) {
    await app.waitForCondition<boolean>(
      `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(c.cardId)})`,
    );
  }

  // Wait for all engines ready.
  for (const c of layout.cards) {
    await app.awaitEngineReady(c.cardId);
  }

  // Wait for content to be restored on all cards.
  for (const c of layout.cards) {
    const seedText = seedTextForCard(c.suffix);
    await app.waitForCondition<boolean>(
      `(function(){
        var s = window.__tug.getEmCardState(${JSON.stringify(c.cardId)});
        return s !== null && s.text === ${JSON.stringify(seedText)};
      })()`,
      { timeoutMs: 4000 },
    );
  }
}

// ---------------------------------------------------------------------------
// Bag-on-disk axis read helper
// ---------------------------------------------------------------------------

interface RawBag {
  content?: unknown;
}

function readActiveEngineState(
  bag: RawBag,
  _componentId: PromptComponentId,
): Record<string, unknown> | null {
  const content = bag.content;
  if (typeof content !== "object" || content === null) return null;
  const wrapper = content as Record<string, unknown>;
  // Current TugPromptEntry wrapper: { route, draft, maximized }.
  if (
    typeof wrapper.route === "string" &&
    typeof wrapper.draft === "object" &&
    wrapper.draft !== null
  ) {
    return wrapper.draft as Record<string, unknown>;
  }
  // Legacy wrapper: { currentRoute, perRoute }.
  const currentRoute = wrapper.currentRoute;
  const perRoute = wrapper.perRoute;
  if (
    typeof currentRoute !== "string" ||
    typeof perRoute !== "object" ||
    perRoute === null
  ) {
    return null;
  }
  const inner = (perRoute as Record<string, unknown>)[currentRoute];
  if (typeof inner !== "object" || inner === null) return null;
  return inner as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Phase B — re-seed deck from disk and assert invariants
// ---------------------------------------------------------------------------

async function reseedFromDisk(
  app: App,
  layout: Layout,
  tugbankPath: string,
): Promise<Record<string, RawBag>> {
  const cardStates: Record<string, RawBag> = {};
  for (const c of layout.cards) {
    const onDisk = tugbankRead<RawBag>(
      tugbankPath,
      "dev.tugapp.deck.cardstate",
      c.cardId,
    );
    expect(
      onDisk,
      `expected bag for card ${c.cardId} to exist on tugbank disk`,
    ).not.toBeNull();
    cardStates[c.cardId] = onDisk!.value as RawBag;
  }

  await app.enableDeckTrace(true);
  await app.seedDeckState({
    state: buildDeckShape(layout),
    cardStates,
    focusCardId: layout.activeCardId,
  });

  for (const c of layout.cards) {
    if (c.componentId === "session") {
      await app.bindSession(c.cardId);
    }
  }

  for (const c of layout.cards) {
    await app.waitForCondition<boolean>(
      `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(c.cardId)})`,
    );
    await app.awaitEngineReady(c.cardId);
  }

  return cardStates;
}

function assertBagOnDisk(
  cardStates: Record<string, RawBag>,
  layout: Layout,
): void {
  for (const c of layout.cards) {
    const bag = cardStates[c.cardId];
    expect(bag, `bag for ${c.cardId}`).toBeDefined();
    const engineState = readActiveEngineState(bag, c.componentId);
    expect(
      engineState,
      `engine state extracted from bag.content for ${c.cardId}`,
    ).not.toBeNull();
    const expectedText = seedTextForCard(c.suffix);
    expect(
      engineState!.text,
      `bag-on-disk axis text for ${c.cardId} (${c.componentId})`,
    ).toBe(expectedText);
    expect(
      engineState!.selection,
      `bag-on-disk axis selection for ${c.cardId} (${c.componentId}) — pre-25C.4 inactive cards lost their selection in the restore race`,
    ).toEqual(SEED_SELECTION);
    expect(
      Array.isArray(engineState!.atoms),
      `bag-on-disk axis atoms for ${c.cardId} is an array`,
    ).toBe(true);
    expect(
      (engineState as Record<string, unknown>).scrollTop,
      `bag-on-disk axis scrollTop for ${c.cardId}`,
    ).toBe(SEED_SCROLL_TOP);
  }
}

async function assertPhaseBInvariants(
  app: App,
  layout: Layout,
  cardStates: Record<string, RawBag>,
): Promise<void> {
  const activeCard = layout.cards.find((c) => c.cardId === layout.activeCardId)!;
  const inactiveCards = layout.cards.filter(
    (c) => c.cardId !== layout.activeCardId,
  );

  // Wait for content restored on every card.
  for (const c of layout.cards) {
    const seedText = seedTextForCard(c.suffix);
    await app.waitForCondition<boolean>(
      `(function(){
        var s = window.__tug.getEmCardState(${JSON.stringify(c.cardId)});
        return s !== null && s.text === ${JSON.stringify(seedText)};
      })()`,
      { timeoutMs: 4000 },
    );
  }

  // Wait for the active card's selection to land in the global
  // Selection (paintMirrorAsActive is called by onRestore for the
  // active card). The seed text uses `\n` separators which the engine
  // restores as `<br>` elements; `Range.toString()` concatenates
  // visible text and skips the `<br>` glyph, so the expected text
  // strips `\n` from the JS-string slice.
  const activeSeedText = seedTextForCard(activeCard.suffix);
  const expectedActiveSelText = activeSeedText
    .slice(SEED_SELECTION.start, SEED_SELECTION.end)
    .replace(/\n/g, "");
  await app.waitForCondition<boolean>(
    `(function(){
      var sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return false;
      return sel.getRangeAt(0).toString() === ${JSON.stringify(expectedActiveSelText)};
    })()`,
    { timeoutMs: 4000 },
  );

  // Invariant 1 — Single focus on the active card's editor.
  const focusInfo = await app.evalJS<{
    activeCardOf: string | null;
    matchesPromptEditor: boolean;
  }>(
    `(function(){
      var ae = document.activeElement;
      if (!ae) return { activeCardOf: null, matchesPromptEditor: false };
      var card = ae.closest && ae.closest("[data-card-id]");
      var matches = ae.matches && ae.matches(${JSON.stringify(PROMPT_INPUT_SELECTOR)});
      return {
        activeCardOf: card ? card.getAttribute("data-card-id") : null,
        matchesPromptEditor: !!matches,
      };
    })()`,
  );
  expect(
    focusInfo.activeCardOf,
    `Invariant 1 (single focus): document.activeElement should be inside active card ${activeCard.cardId}`,
  ).toBe(activeCard.cardId);
  expect(
    focusInfo.matchesPromptEditor,
    `Invariant 1 (single focus): document.activeElement should match the prompt-input editor selector`,
  ).toBe(true);

  // Invariant 2 — Single global Selection in active card's root.
  const globalSel = await app.evalJS<{
    rangeCount: number;
    text: string;
    inActiveRoot: boolean;
  }>(
    `(function(){
      var sel = window.getSelection();
      if (!sel) return { rangeCount: 0, text: "", inActiveRoot: false };
      var rc = sel.rangeCount;
      if (rc === 0) return { rangeCount: 0, text: "", inActiveRoot: false };
      var r = sel.getRangeAt(0);
      var startEl = r.startContainer.nodeType === 1
        ? r.startContainer
        : r.startContainer.parentElement;
      var card = startEl ? startEl.closest("[data-card-id]") : null;
      var inActiveRoot = !!card && card.getAttribute("data-card-id") === ${JSON.stringify(activeCard.cardId)};
      return { rangeCount: rc, text: r.toString(), inActiveRoot: inActiveRoot };
    })()`,
  );
  expect(
    globalSel.rangeCount,
    `Invariant 2 (single global Selection): exactly one Range in window.getSelection()`,
  ).toBe(1);
  expect(
    globalSel.inActiveRoot,
    `Invariant 2 (single global Selection): Range anchored in active card ${activeCard.cardId}`,
  ).toBe(true);
  expect(
    globalSel.text,
    `Invariant 2 (single global Selection): Range text matches active card's seeded selection`,
  ).toBe(expectedActiveSelText);

  // Invariant 3 — Every inactive card's selection in selectionGuard.
  for (const c of inactiveCards) {
    const caret = await app.getCaretState(c.cardId);
    expect(
      caret,
      `Invariant 3 (inactive cards in selectionGuard): __tug.getCaretState(${c.cardId}) returns non-null`,
    ).not.toBeNull();
    expect(caret?.kind).toBe("range");
    if (caret?.kind === "range") {
      // Same `<br>` quirk as Invariant 2 — strip `\n` from the JS
      // slice to match `Range.toString()`.
      const expectedText = seedTextForCard(c.suffix)
        .slice(SEED_SELECTION.start, SEED_SELECTION.end)
        .replace(/\n/g, "");
      expect(
        caret.text,
        `Invariant 3 (inactive cards in selectionGuard): caret text matches seed for ${c.cardId}`,
      ).toBe(expectedText);
    }
  }

  // Invariant 4 — Inactive paint coverage via CSS Custom Highlight API.
  // Every inactive card's range should be in the inactive-selection
  // Highlight; the active card's range should NOT be.
  const highlight = await app.evalJS<{
    available: boolean;
    cardIdsInHighlight: string[];
  }>(
    `(function(){
      if (typeof CSS === "undefined" || !CSS.highlights) {
        return { available: false, cardIdsInHighlight: [] };
      }
      var h = CSS.highlights.get("inactive-selection");
      if (!h) return { available: false, cardIdsInHighlight: [] };
      var cardIds = [];
      var iter = h.values ? h.values() : h[Symbol.iterator]();
      var step = iter.next();
      while (!step.done) {
        var range = step.value;
        var startEl = range.startContainer.nodeType === 1
          ? range.startContainer
          : range.startContainer.parentElement;
        if (startEl) {
          var card = startEl.closest("[data-card-id]");
          if (card) cardIds.push(card.getAttribute("data-card-id"));
        }
        step = iter.next();
      }
      return { available: true, cardIdsInHighlight: cardIds };
    })()`,
  );
  expect(
    highlight.available,
    `Invariant 4 (inactive paint): CSS Custom Highlight API available with "inactive-selection" highlight registered`,
  ).toBe(true);
  const expectedInactiveIds = inactiveCards.map((c) => c.cardId).sort();
  const actualInactiveIds = [...new Set(highlight.cardIdsInHighlight)].sort();
  expect(
    actualInactiveIds,
    `Invariant 4 (inactive paint): the inactive-selection highlight contains exactly the inactive cards' ranges`,
  ).toEqual(expectedInactiveIds);
  expect(
    highlight.cardIdsInHighlight.includes(activeCard.cardId),
    `Invariant 4 (inactive paint): the active card ${activeCard.cardId} is NOT in the inactive-selection highlight`,
  ).toBe(false);

  // Invariant 5 — Bag-on-disk consistency for every card.
  assertBagOnDisk(cardStates, layout);
}

// ---------------------------------------------------------------------------
// Trigger drivers
// ---------------------------------------------------------------------------

async function runAppReloadScenario(layout: Layout): Promise<void> {
  const tugbankPath = mkTempTugbank();
  try {
    seedTugbankForLaunch(tugbankPath);
    const app = await launchTugApp({
      testName: `m26-${layout.id}-app-reload`,
      env: { TUGBANK_PATH: tugbankPath },
      persistInTestMode: true,
    });
    try {
      await setupPhaseA(app, layout);
      await app.appReload();
      const cardStates = await reseedFromDisk(app, layout, tugbankPath);
      await assertPhaseBInvariants(app, layout, cardStates);
    } finally {
      await app.close();
    }
  } finally {
    rmTempTugbank(tugbankPath);
  }
}

async function runRelaunchScenario(layout: Layout): Promise<void> {
  const tugbankPath = mkTempTugbank();
  try {
    seedTugbankForLaunch(tugbankPath);
    {
      const appA = await launchTugApp({
        testName: `m26-${layout.id}-relaunch-A`,
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
      });
      try {
        await setupPhaseA(appA, layout);
        await appA.quitGracefully();
      } finally {
        // quitGracefully tears down on success.
      }
    }

    {
      const appB = await launchTugApp({
        testName: `m26-${layout.id}-relaunch-B`,
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
      });
      try {
        const cardStates = await reseedFromDisk(appB, layout, tugbankPath);
        await assertPhaseBInvariants(appB, layout, cardStates);
      } finally {
        await appB.close();
      }
    }
  } finally {
    rmTempTugbank(tugbankPath);
  }
}

// ---------------------------------------------------------------------------
// Test cases — 4 layouts × 2 triggers
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)(
  "m37: deck-wide restore consistency (active/inactive paint split)",
  () => {
    test(
      "L1 (1 pane, 2 cards: gallery-prompt-entry × 2) × appReload",
      () => runAppReloadScenario(makeLayout("L1")),
      TEST_TIMEOUT_MS,
    );
    test(
      "L1 (1 pane, 2 cards: gallery-prompt-entry × 2) × relaunch",
      () => runRelaunchScenario(makeLayout("L1")),
      TEST_TIMEOUT_MS,
    );
    test(
      "L2 (1 pane: gallery-prompt-entry active + dev inactive) × appReload",
      () => runAppReloadScenario(makeLayout("L2")),
      TEST_TIMEOUT_MS,
    );
    test(
      "L2 (1 pane: gallery-prompt-entry active + dev inactive) × relaunch",
      () => runRelaunchScenario(makeLayout("L2")),
      TEST_TIMEOUT_MS,
    );
    test(
      "L3 (1 pane: dev active + gallery-prompt-entry inactive) × appReload",
      () => runAppReloadScenario(makeLayout("L3")),
      TEST_TIMEOUT_MS,
    );
    test(
      "L3 (1 pane: dev active + gallery-prompt-entry inactive) × relaunch",
      () => runRelaunchScenario(makeLayout("L3")),
      TEST_TIMEOUT_MS,
    );
    test(
      "L4 (2 panes: gallery-prompt-entry in active pane, dev pane-active in non-active pane) × appReload",
      () => runAppReloadScenario(makeLayout("L4")),
      TEST_TIMEOUT_MS,
    );
    test(
      "L4 (2 panes: gallery-prompt-entry in active pane, dev pane-active in non-active pane) × relaunch",
      () => runRelaunchScenario(makeLayout("L4")),
      TEST_TIMEOUT_MS,
    );
  },
);
