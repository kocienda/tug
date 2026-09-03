/**
 * at0027-layout-state-persistence.test.ts — TugAccordion's open-section
 * value survives cmd-tab + reload via the Component Persistence
 * Protocol [A9] ([AT0027]).
 *
 * ## Why this exists
 *
 * Pre-25D, TugAccordion's open-section state lived inside Radix's
 * internal state machine — opaque to the host. Open a section,
 * cmd-tab away, come back: closed. Reload: closed. [L23] violation:
 * an internal implementation operation (mount-time Radix init)
 * destroyed user-visible state.
 *
 * Uses `componentStatePreservationKey` + `useComponentStatePreservation` to
 * TugAccordion. Uncontrolled accordions mirror Radix's value in a
 * `useState` so capture/restore can read/write it; controlled
 * accordions dispatch `toggleSection` through the responder chain
 * on restore (best-effort, parent owns the truth).
 *
 * ## Scope
 *
 * Tug-split-pane is intentionally out of scope. Its bespoke
 * `storageKey` → tugbank persistence already works; the [AT0027]
 * subquestion ("card-scope or pane-scope?") is resolved in this
 * step's plan-doc update as "keep existing storageKey path."
 * Migrating split-pane to bag.components would duplicate two
 * persistence layers without closing any user-visible gap.
 *
 * ## Test matrix
 *
 *   2 axes × 3 triggers = 6 tests.
 *
 *   - Axes: `single` mode (one open section, value=string), `multiple`
 *     mode (set of open sections, value=string[]).
 *   - Triggers: `appReload` (fresh WKWebView, same Tug.app process),
 *     `quitGracefully+relaunch` (fresh process, same tugbank disk),
 *     `simulateAppResign+Become` (cmd-tab; same WebView, exercises
 *     the will-phase save path).
 *
 * Each test seeds `bag.components.{componentStatePreservationKey}` with a non-default
 * open value, drives the trigger, and asserts:
 *
 *   1. The seeded section's `data-state="open"` after restore (and
 *      no other section is open beyond what was seeded).
 *   2. `bag.components` round-tripped to disk for the persistence-
 *      flushing triggers (`appReload`, `relaunch`).
 *
 * The gallery-accordion card registers two componentStatePreservationKey-bearing
 * accordions: `single` (the "Single Mode" demo) and `multiple` (the
 * "Multiple Mode" demo). Both render side-by-side; each test seeds
 * one mode while leaving the other at its default.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @foreground
 * @covers tugdeck/src/components/tugways/component-state-preservation-registry.ts
 * @covers tugdeck/src/components/tugways/tug-accordion.tsx
 * @covers tugdeck/src/serialization.ts
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

const TEST_TIMEOUT_MS = 60_000;

const SINGLE_KEY = "single";
const MULTIPLE_KEY = "multiple";

const SINGLE_SEED_OPEN = "configuration"; // matches gallery-accordion item id
const MULTIPLE_SEED_OPEN: ReadonlyArray<string> = ["features", "examples"];

function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "gallery-accordion", title: "Accordion", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 720, height: 540 },
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

interface AccordionPersist {
  value: string | string[];
}

function makeBag(
  axis: "single" | "multiple",
): Record<string, unknown> {
  const components: Record<string, AccordionPersist> = {};
  if (axis === "single") {
    components[SINGLE_KEY] = { value: SINGLE_SEED_OPEN };
  } else {
    components[MULTIPLE_KEY] = { value: [...MULTIPLE_SEED_OPEN] };
  }
  return { components };
}

function rootSelectorFor(axis: "single" | "multiple"): string {
  return `[data-card-id="A"] [data-testid="gallery-accordion-${axis}"]`;
}

async function seedAndMount(app: App, axis: "single" | "multiple"): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({
    state: deckShape(),
    cardStates: { A: makeBag(axis) },
    focusCardId: "A",
  });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  // Wait for the seeded-axis accordion to render at least one item.
  // Other accordions in the gallery card (uncontrolled, no componentStatePreservationKey)
  // are intentionally NOT scoped — the test asserts only on the
  // persistent accordion's items.
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(rootSelectorFor(axis) + " [data-slot=\"tug-accordion-item\"]")}) !== null`,
    { timeoutMs: 4000 },
  );
}

/**
 * Read item-states for the persistent accordion of the given axis.
 * Scoped via the `data-testid` selector on the gallery's
 * componentStatePreservationKey-bearing accordion (`gallery-accordion-single` or
 * `gallery-accordion-multiple`) so the gallery's other uncontrolled
 * demo accordions don't leak into the assertion.
 */
async function readItemStates(
  app: App,
  axis: "single" | "multiple",
): Promise<Record<string, string>> {
  return await app.evalJS<Record<string, string>>(
    `(function(){
      var out = {};
      var root = document.querySelector(${JSON.stringify(rootSelectorFor(axis))});
      if (!root) return out;
      var items = root.querySelectorAll('[data-slot="tug-accordion-item"]');
      for (var i = 0; i < items.length; i++) {
        var state = items[i].getAttribute("data-state");
        var trigger = items[i].querySelector('.tug-accordion-trigger');
        var label = trigger ? (trigger.textContent || "").trim() : "";
        if (state !== null && label.length > 0) {
          out[label] = state;
        }
      }
      return out;
    })()`,
  );
}

/**
 * Assert exactly the given set of trigger labels has
 * `data-state="open"` inside the persistent accordion of the given
 * axis. Items in other (non-persistent) gallery accordions are
 * intentionally ignored.
 */
async function expectOpenTriggers(
  app: App,
  axis: "single" | "multiple",
  expectedOpenLabels: ReadonlyArray<string>,
): Promise<void> {
  const wantSorted = [...expectedOpenLabels].sort();
  await app.waitForCondition<boolean>(
    `(function(){
      var root = document.querySelector(${JSON.stringify(rootSelectorFor(axis))});
      if (!root) return false;
      var items = root.querySelectorAll('[data-slot="tug-accordion-item"]');
      var openLabels = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].getAttribute("data-state") === "open") {
          var trig = items[i].querySelector('.tug-accordion-trigger');
          if (trig) openLabels.push((trig.textContent || "").trim());
        }
      }
      var want = ${JSON.stringify(wantSorted)};
      openLabels.sort();
      if (openLabels.length !== want.length) return false;
      for (var j = 0; j < want.length; j++) {
        if (openLabels[j] !== want[j]) return false;
      }
      return true;
    })()`,
    { timeoutMs: 4000 },
  );
  const live = await readItemStates(app, axis);
  const liveOpen = Object.entries(live)
    .filter(([, s]) => s === "open")
    .map(([k]) => k)
    .sort();
  expect(
    liveOpen,
    `open items in the ${axis} accordion must match the seeded set`,
  ).toEqual(wantSorted);
}

/**
 * Map item-value (the `value` prop on `TugAccordionItem`) to the
 * trigger label rendered inside the item. Mirrors the
 * `gallery-accordion.tsx` source so the test can target items by
 * their persisted value while asserting on the human-visible label.
 */
const SINGLE_LABELS: Record<string, string> = {
  "getting-started": "Getting Started",
  "installation": "Installation",
  "configuration": "Configuration",
};
const MULTIPLE_LABELS: Record<string, string> = {
  "features": "Features",
  "api-reference": "API Reference",
  "examples": "Examples",
};

interface DiskBag {
  components?: Record<string, AccordionPersist>;
}

function readDiskValue(
  tugbankPath: string,
  key: string,
): AccordionPersist["value"] | undefined {
  const onDisk = tugbankRead<DiskBag>(
    tugbankPath,
    "dev.tugapp.deck.cardstate",
    "A",
  );
  if (!onDisk) return undefined;
  const bag = onDisk.value as DiskBag | undefined;
  return bag?.components?.[key]?.value;
}

async function reseedFromDisk(app: App, tugbankPath: string): Promise<void> {
  const onDisk = tugbankRead<unknown>(
    tugbankPath,
    "dev.tugapp.deck.cardstate",
    "A",
  );
  expect(onDisk).not.toBeNull();
  await app.enableDeckTrace(true);
  await app.seedDeckState({
    state: deckShape(),
    cardStates: { A: onDisk!.value as Record<string, unknown> },
    focusCardId: "A",
  });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  await app.waitForCondition<boolean>(
    `document.querySelector('[data-card-id="A"] [data-slot="tug-accordion-item"]') !== null`,
    { timeoutMs: 4000 },
  );
}

// ---------------------------------------------------------------------------
// Trigger drivers
// ---------------------------------------------------------------------------

async function runAppReloadScenario(axis: "single" | "multiple"): Promise<void> {
  const tugbankPath = mkTempTugbank();
  try {
    seedTugbankForLaunch(tugbankPath);
    const app = await launchTugApp({
      testName: `at0027-accordion-${axis}-app-reload`,
      env: { TUGBANK_PATH: tugbankPath },
      persistInTestMode: true,
    });
    try {
      await seedAndMount(app, axis);
      await app.appReload();

      if (axis === "single") {
        expect(
          readDiskValue(tugbankPath, SINGLE_KEY),
          "axis bag.components: single accordion value must round-trip to disk",
        ).toBe(SINGLE_SEED_OPEN);
      } else {
        const v = readDiskValue(tugbankPath, MULTIPLE_KEY);
        expect(
          Array.isArray(v),
          "axis bag.components: multi accordion value must be an array on disk",
        ).toBe(true);
        expect(
          [...(v as string[])].sort(),
          "axis bag.components: multi accordion array must match seeded set",
        ).toEqual([...MULTIPLE_SEED_OPEN].sort());
      }

      await reseedFromDisk(app, tugbankPath);

      const expectedLabels =
        axis === "single"
          ? [SINGLE_LABELS[SINGLE_SEED_OPEN]!]
          : MULTIPLE_SEED_OPEN.map((v) => MULTIPLE_LABELS[v]!);
      await expectOpenTriggers(app, axis, expectedLabels);
    } finally {
      await app.close();
    }
  } finally {
    rmTempTugbank(tugbankPath);
  }
}

async function runRelaunchScenario(axis: "single" | "multiple"): Promise<void> {
  const tugbankPath = mkTempTugbank();
  try {
    seedTugbankForLaunch(tugbankPath);
    const app1 = await launchTugApp({
      testName: `at0027-accordion-${axis}-relaunch-a`,
      env: { TUGBANK_PATH: tugbankPath },
      persistInTestMode: true,
    });
    try {
      await seedAndMount(app1, axis);
      await app1.quitGracefully();
    } finally {
      await app1.close();
    }
    if (axis === "single") {
      expect(
        readDiskValue(tugbankPath, SINGLE_KEY),
        "axis bag.components: single accordion value must persist across relaunch",
      ).toBe(SINGLE_SEED_OPEN);
    } else {
      const v = readDiskValue(tugbankPath, MULTIPLE_KEY);
      expect(Array.isArray(v)).toBe(true);
      expect([...(v as string[])].sort()).toEqual([...MULTIPLE_SEED_OPEN].sort());
    }

    const app2 = await launchTugApp({
      testName: `at0027-accordion-${axis}-relaunch-b`,
      env: { TUGBANK_PATH: tugbankPath },
      persistInTestMode: true,
    });
    try {
      await reseedFromDisk(app2, tugbankPath);
      const expectedLabels =
        axis === "single"
          ? [SINGLE_LABELS[SINGLE_SEED_OPEN]!]
          : MULTIPLE_SEED_OPEN.map((v) => MULTIPLE_LABELS[v]!);
      await expectOpenTriggers(app2, axis, expectedLabels);
    } finally {
      await app2.close();
    }
  } finally {
    rmTempTugbank(tugbankPath);
  }
}

async function runCmdTabScenario(axis: "single" | "multiple"): Promise<void> {
  const app = await launchTugApp({
    testName: `at0027-accordion-${axis}-cmd-tab`,
    // Foreground: the cmd-tab cycle is a real resign / become-active pair.
    foreground: true,
  });
  try {
    await seedAndMount(app, axis);

    // Cold-mount restore should already have the seeded sections open.
    const expectedLabels =
      axis === "single"
        ? [SINGLE_LABELS[SINGLE_SEED_OPEN]!]
        : MULTIPLE_SEED_OPEN.map((v) => MULTIPLE_LABELS[v]!);
    await expectOpenTriggers(app, axis, expectedLabels);

    // gallery-accordion has no auto-focused element on mount (unlike
    // EM cards whose engine claims focus). simulateAppResign waits
    // for `document.hasFocus()` to flip false, so we need a focused
    // element first. Programmatically focus the first accordion
    // trigger via JS (clicking via mousedown would also toggle the
    // section, polluting the open set we're trying to preserve).
    await app.evalJS<void>(
      `(function(){
        var btn = document.querySelector(${JSON.stringify(rootSelectorFor(axis) + " .tug-accordion-trigger")});
        if (btn) btn.focus();
      })()`,
    );
    await app.waitForCondition<boolean>(
      `(typeof window.__tug !== "undefined") && (window.__tug.getHasFocus() === true)`,
      { timeoutMs: 2000 },
    );

    await app.simulateAppResign();
    await app.simulateAppBecomeActive();

    // After cmd-tab cycle, the seeded sections must still be open
    // (the will-phase save captured state, the become-active path
    // doesn't re-mount, so internal Radix state is preserved).
    await expectOpenTriggers(app, axis, expectedLabels);
  } finally {
    await app.close();
  }
}

describe.skipIf(!SHOULD_RUN)("m27: TugAccordion open-section state survives transitions", () => {
  test(
    "single × appReload",
    () => runAppReloadScenario("single"),
    TEST_TIMEOUT_MS,
  );
  test(
    "single × relaunch",
    () => runRelaunchScenario("single"),
    TEST_TIMEOUT_MS,
  );
  test(
    "single × cmd-tab",
    () => runCmdTabScenario("single"),
    TEST_TIMEOUT_MS,
  );
  test(
    "multiple × appReload",
    () => runAppReloadScenario("multiple"),
    TEST_TIMEOUT_MS,
  );
  test(
    "multiple × relaunch",
    () => runRelaunchScenario("multiple"),
    TEST_TIMEOUT_MS,
  );
  test(
    "multiple × cmd-tab",
    () => runCmdTabScenario("multiple"),
    TEST_TIMEOUT_MS,
  );
});
