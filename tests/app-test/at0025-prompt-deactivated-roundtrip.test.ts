/**
 * at0025-prompt-deactivated-roundtrip.test.ts — selection survives the
 * deactivation → reload/relaunch path ([AT0025] Layer 4).
 *
 * ## The user-reported regression this gates
 *
 * Reproducer (paraphrased): open a Session card with a sibling card in
 * the same pane. Type into Dev; make a selection. Click the sibling
 * card's tab to deactivate Dev. Reload (or quit + relaunch). Click
 * Dev's tab to reactivate. Result before this gate: selection lost.
 *
 * ## Root cause
 *
 * `engine.captureState()` reads the live DOM Selection via
 * `getSelectedRange()`, which returns null when `window.getSelection()`
 * has moved outside the engine's root. That's exactly what happens on
 * a tab-switch: the user's click on the sibling card's tab hands the
 * browser's Selection to that tab's input, leaving the engine's root
 * with no live selection. The deactivation save callback that fires
 * a microsecond later writes `selection: null` into `bag.content` —
 * destroying the user's selection on disk before the reload trigger
 * even runs. A clear [L23] violation: an internal implementation
 * operation (the deactivation save) destroyed user-visible state.
 *
 * ## The fix this test gates
 *
 * The engine maintains a `_lastInRootSelection` cache in flat offsets,
 * updated synchronously on every `setSelectedRange` and on every
 * `emitSelectionChanged`'s in-root branch (the document
 * `selectionchange` listener already filters out-of-root events,
 * which is exactly the discipline we need to preserve the cache
 * across focus-out). `captureState` falls back to the cache when the
 * live DOM selection has moved out of root.
 *
 * ## Test matrix
 *
 *   2 cards × 2 reload triggers = 4 tests. Each card pairs with a
 *   sibling `gallery-input` card in the same pane so a tab-switch
 *   simulates the user's "click another card" gesture (as opposed to
 *   `at0024-prompt-state-roundtrip`, which keeps a single card active
 *   through reload).
 *
 *   Triggers are `app.appReload()` and `app.quitGracefully()` +
 *   relaunch — same as m24.
 *
 * ## Phase A → Phase B contract
 *
 *   **Phase A** mirrors m24's seed-and-drive: pre-cooked
 *   `bag.content` with text + atoms + selection, programmatic
 *   `editor.scrollTop = 80` post-restore. The new bit: BEFORE
 *   triggering the reload, click the sibling card's tab to deactivate
 *   the prompt card. The deactivation save callback fires; pre-fix it
 *   wrote `selection: null`; post-fix it writes the cached selection.
 *
 *   **Phase A disk assertion** reads the on-disk bag and asserts each
 *   axis matches the seed — including the load-bearing `selection`
 *   axis. This is the assertion that fails today (pre-Layer-4):
 *   `selection: null` on disk after deactivation.
 *
 *   **Phase B** re-seeds the deck (with the same multi-card layout —
 *   A active again) and asserts live engine state matches the seed
 *   on the reactivated card.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/serialization.ts
 * @covers tugdeck/src/card-state-orchestrator.ts
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor/
 * @covers tugdeck/src/components/tugways/tug-text-editor.tsx
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

type PromptComponentId =
  | "gallery-prompt-entry"
  | "session";

const PROMPT_INPUT_SELECTOR =
  '[data-slot="tug-text-editor"] .cm-content';

/**
 * CM6's scrollable element. Editor scrollTop / scrollLeft are owned
 * by `view.scrollDOM` (`.cm-scroller`), NOT by the contenteditable
 * (`.cm-content`).
 */
const SCROLLER_SELECTOR =
  '[data-slot="tug-text-editor"] .cm-scroller';

const TUG_ATOM_CHAR = "￼";

const TUG_PROMPT_ENTRY_DEFAULT_ROUTE = "❯";

function tabSelectorFor(cardId: string): string {
  return `[data-testid="tug-tab-${cardId}"]`;
}

// ---------------------------------------------------------------------------
// Seed payload (same shape as m24, kept self-contained so the two test
// files don't accidentally drift on each other's invariants)
// ---------------------------------------------------------------------------

const TEXT_BEFORE_ATOM = "line  1: x";
const ACTIVE_LINES_AFTER_ATOM: ReadonlyArray<string> = [
  "yz alpha",
  "line  2: beta gamma delta",
  "line  3: epsilon zeta eta theta",
  "line  4: iota kappa lambda mu",
  "line  5: nu xi omicron pi",
  "line  6: rho sigma tau upsilon",
  "line  7: phi chi psi omega",
  "line  8: aaa bbb ccc ddd eee",
  "line  9: 1234 5678 9012 3456",
  "line 10: red orange yellow",
  "line 11: green blue indigo",
  "line 12: violet pink brown",
  "line 13: forest sky ocean",
  "line 14: mountain valley canyon",
  "line 15: desert tundra grassland",
  "line 16: rainforest mangrove savanna",
];
const FILLER_LINES: ReadonlyArray<string> = Array.from(
  { length: 50 - ACTIVE_LINES_AFTER_ATOM.length },
  (_, i) => `line ${(17 + i).toString().padStart(2)}: filler text padding for scroll overflow`,
);
const TEXT_AFTER_ATOM = [...ACTIVE_LINES_AFTER_ATOM, ...FILLER_LINES].join("\n");
const SEED_TEXT = TEXT_BEFORE_ATOM + TUG_ATOM_CHAR + TEXT_AFTER_ATOM;

const SEED_ATOM = {
  position: TEXT_BEFORE_ATOM.length, // = 10
  type: "file",
  label: "filename.ts",
  value: "/path/to/filename.ts",
};

const SEED_SELECTION = { start: 50, end: 100 };

const SEED_SCROLL_TOP = 80;

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

const ACTIVE_ENGINE_STATE: EngineState = {
  text: SEED_TEXT,
  atoms: [SEED_ATOM],
  selection: SEED_SELECTION,
};

function makeContentBag(_componentId: PromptComponentId): Record<string, unknown> {
  return {
    currentRoute: TUG_PROMPT_ENTRY_DEFAULT_ROUTE,
    perRoute: {
      [TUG_PROMPT_ENTRY_DEFAULT_ROUTE]: ACTIVE_ENGINE_STATE,
    },
    maximized: false,
  };
}

// ---------------------------------------------------------------------------
// Deck shape — A (prompt) + B (sibling) tabbed in one pane, A active
// ---------------------------------------------------------------------------

function deckShape(componentId: PromptComponentId, activeCardId: "A" | "B" = "A") {
  return {
    cards: [
      { id: "A", componentId, title: "Prompt A", closable: true },
      { id: "B", componentId: "gallery-input", title: "FC B", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 720, height: 540 },
        cardIds: ["A", "B"],
        activeCardId,
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

// ---------------------------------------------------------------------------
// Phase A: seed → drive scroll → DEACTIVATE A by tab-switching to B → trigger
// ---------------------------------------------------------------------------

async function setupPhaseA(
  app: App,
  componentId: PromptComponentId,
): Promise<void> {
  await app.enableDeckTrace(true);

  const bag = { content: makeContentBag(componentId) };

  await app.seedDeckState({
    state: deckShape(componentId, "A"),
    cardStates: { A: bag },
    focusCardId: "A",
  });

  if (componentId === "session") {
    await app.bindSession("A");
  }

  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
  );

  await app.awaitEngineReady("A");

  // Wait for the engine's restore to commit the seeded text.
  await app.waitForCondition<boolean>(
    `(function(){
      var s = window.__tug.getEmCardState("A");
      return s !== null && s.text === ${JSON.stringify(SEED_TEXT)};
    })()`,
    { timeoutMs: 4000 },
  );

  // Drive editor's scrollTop. CM6 owns scroll on `.cm-scroller`,
  // not on the contenteditable.
  await app.evalJS<void>(
    `(function(){
      var el = document.querySelector('[data-card-id="A"] ${SCROLLER_SELECTOR}');
      if (!el) throw new Error("[m25] phaseA: editor scroller not found for cardId=A");
      el.scrollTop = ${SEED_SCROLL_TOP};
    })()`,
  );

  await app.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector('[data-card-id="A"] ${SCROLLER_SELECTOR}');
      return el !== null && Math.abs(el.scrollTop - ${SEED_SCROLL_TOP}) < 2;
    })()`,
    { timeoutMs: 2000 },
  );

  // CRITICAL STEP — distinguishes m25 from m24. Click the sibling
  // tab to deactivate A. The deactivation save callback fires with
  // window.getSelection() having moved to B's input; pre-fix
  // captureState writes selection:null and the user's selection is
  // destroyed before the reload even runs.
  await app.nativeClickAtElement(tabSelectorFor("B"));
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && (window.__tug.getActiveCardId() === "B")`,
    { timeoutMs: 2000 },
  );

  // Force a synchronous save now to drive the deactivation-bag onto
  // disk (`getEmCardState` invokes the save callback). The reload
  // trigger does its own synchronous flush, but firing here too gives
  // every save-write site equal coverage and makes the disk-side
  // assertion deterministic regardless of which trigger we run.
  await app.evalJS<unknown>(`window.__tug.getEmCardState("A")`);
}

// ---------------------------------------------------------------------------
// Disk-side bag introspection (Phase A assertion)
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

function assertBagOnDisk(
  tugbankPath: string,
  componentId: PromptComponentId,
): void {
  const onDisk = tugbankRead<RawBag>(
    tugbankPath,
    "dev.tugapp.deck.cardstate",
    "A",
  );
  expect(onDisk, "expected bag for card A to exist on tugbank disk").not.toBeNull();
  expect(onDisk?.type).toBe("json");
  const bag = onDisk?.value;
  expect(bag).toBeDefined();

  const engineState = readActiveEngineState(bag as RawBag, componentId);
  expect(
    engineState,
    "expected on-disk bag.content to carry an engine state for the active route",
  ).not.toBeNull();

  expect(
    engineState!.text,
    "axis text: on-disk bag.content text must match seeded value",
  ).toBe(SEED_TEXT);

  const atoms = engineState!.atoms as ReadonlyArray<Record<string, unknown>>;
  expect(atoms.length).toBe(1);
  expect(atoms[0]?.label).toBe(SEED_ATOM.label);

  // The load-bearing assertion — pre-fix this returns null because
  // captureState ran with the live DOM Selection in card B, not in A.
  expect(
    engineState!.selection,
    "axis selection: bag.content.selection must round-trip the seeded range across deactivation (this fails pre-Layer-4)",
  ).toEqual(SEED_SELECTION);

  expect(
    (engineState as Record<string, unknown>).scrollTop,
    "axis scrollTop: bag.content.scrollTop must carry the seeded editor offset",
  ).toBe(SEED_SCROLL_TOP);
}

// ---------------------------------------------------------------------------
// Phase B: re-seed deck (B active, mirroring end-of-Phase-A) → reactivate A
// ---------------------------------------------------------------------------

async function reseedFromDiskAndReactivate(
  app: App,
  componentId: PromptComponentId,
  tugbankPath: string,
): Promise<void> {
  const onDisk = tugbankRead<RawBag>(
    tugbankPath,
    "dev.tugapp.deck.cardstate",
    "A",
  );
  expect(onDisk).not.toBeNull();
  const cardStates: Record<string, RawBag> = {};
  cardStates.A = onDisk!.value as RawBag;

  await app.enableDeckTrace(true);

  // Re-seed with B active (matches end-of-Phase-A state at reload time).
  await app.seedDeckState({
    state: deckShape(componentId, "B"),
    cardStates,
    focusCardId: "B",
  });

  if (componentId === "session") {
    await app.bindSession("A");
  }

  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
  );

  await app.awaitEngineReady("A");

  // Reactivate A — the user's gesture on return (clicks Dev tab). Right
  // after an appReload the freshly re-hosted window can swallow the first
  // click while it is still becoming interactable, so a click that didn't
  // take is retried — exactly what a person does when a click lands during
  // a repaint.
  const activated = `(typeof window.__tug !== "undefined") && (window.__tug.getActiveCardId() === "A")`;
  for (let attempt = 0; attempt < 3; attempt++) {
    await app.nativeClickAtElement(tabSelectorFor("A"));
    try {
      await app.waitForCondition<boolean>(activated, { timeoutMs: 2000 });
      return;
    } catch {
      // Not active yet — click again.
    }
  }
  await app.waitForCondition<boolean>(activated, { timeoutMs: 2000 });
}

async function assertLiveState(app: App): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function(){
      var s = window.__tug.getEmCardState("A");
      return s !== null && s.text === ${JSON.stringify(SEED_TEXT)};
    })()`,
    { timeoutMs: 4000 },
  );
  const liveText = await app.evalJS<string>(
    `window.__tug.getEmCardState("A").text`,
  );
  expect(liveText).toBe(SEED_TEXT);

  const atomLabels = await app.evalJS<string[]>(
    `(function(){
      var ed = document.querySelector('[data-card-id="A"] ${PROMPT_INPUT_SELECTOR}');
      if (!ed) return [];
      var imgs = ed.querySelectorAll('img[data-atom-label]');
      var labels = [];
      for (var i = 0; i < imgs.length; i++) {
        labels.push(imgs[i].getAttribute('data-atom-label'));
      }
      return labels;
    })()`,
  );
  expect(atomLabels.length).toBe(1);
  expect(atomLabels[0]).toBe(SEED_ATOM.label);

  const live = await app.getEmCardState("A");
  expect(live).not.toBeNull();
  expect(
    live!.engineSelection,
    "axis selection: live engine selection must match seeded range after deactivation+reload+reactivate",
  ).toEqual(SEED_SELECTION);

  const liveScroll = await app.evalJS<number>(
    `(function(){
      var ed = document.querySelector('[data-card-id="A"] ${SCROLLER_SELECTOR}');
      return ed ? ed.scrollTop : -1;
    })()`,
  );
  expect(
    Math.abs(liveScroll - SEED_SCROLL_TOP),
    `axis scrollTop: live editor scrollTop must be within 8px of seeded ${SEED_SCROLL_TOP} (got ${liveScroll})`,
  ).toBeLessThanOrEqual(8);
}

// ---------------------------------------------------------------------------
// Trigger drivers
// ---------------------------------------------------------------------------

async function runAppReloadScenario(
  componentId: PromptComponentId,
): Promise<void> {
  const tugbankPath = mkTempTugbank();
  try {
    seedTugbankForLaunch(tugbankPath);

    const app = await launchTugApp({
      testName: `m25-${componentId}-app-reload`,
      env: { TUGBANK_PATH: tugbankPath },
      persistInTestMode: true,
    });

    try {
      await setupPhaseA(app, componentId);
      await app.appReload();
      assertBagOnDisk(tugbankPath, componentId);
      await reseedFromDiskAndReactivate(app, componentId, tugbankPath);
      await assertLiveState(app);
    } finally {
      await app.close();
    }
  } finally {
    rmTempTugbank(tugbankPath);
  }
}

async function runRelaunchScenario(
  componentId: PromptComponentId,
): Promise<void> {
  const tugbankPath = mkTempTugbank();
  try {
    seedTugbankForLaunch(tugbankPath);

    {
      const appA = await launchTugApp({
        testName: `m25-${componentId}-relaunch-A`,
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
      });
      try {
        await setupPhaseA(appA, componentId);
        await appA.quitGracefully();
      } finally {
        // quitGracefully tears down on success.
      }
    }

    assertBagOnDisk(tugbankPath, componentId);

    {
      const appB = await launchTugApp({
        testName: `m25-${componentId}-relaunch-B`,
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
      });
      try {
        await reseedFromDiskAndReactivate(appB, componentId, tugbankPath);
        await assertLiveState(appB);
      } finally {
        await appB.close();
      }
    }
  } finally {
    rmTempTugbank(tugbankPath);
  }
}

// ---------------------------------------------------------------------------
// Test cases — 2 cards × 2 triggers
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)(
  "m25: prompt-state survives deactivation → reload + reactivation",
  () => {
    test(
      "gallery-prompt-entry × appReload",
      () => runAppReloadScenario("gallery-prompt-entry"),
      TEST_TIMEOUT_MS,
    );

    test(
      "gallery-prompt-entry × relaunch",
      () => runRelaunchScenario("gallery-prompt-entry"),
      TEST_TIMEOUT_MS,
    );

    test(
      "dev × appReload",
      () => runAppReloadScenario("session"),
      TEST_TIMEOUT_MS,
    );

    test(
      "dev × relaunch",
      () => runRelaunchScenario("session"),
      TEST_TIMEOUT_MS,
    );
  },
);
