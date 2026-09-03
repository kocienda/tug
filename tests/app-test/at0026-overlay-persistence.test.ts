/**
 * at0026-overlay-persistence.test.ts — TugSheet open state survives
 * appReload via the Component State Preservation Protocol [A9]
 * (selection [AT0026] state-preserving classification).
 *
 * ## Why this exists
 *
 * Previously, opening a `tug-sheet` (typically wrapping a settings form
 * or multi-step flow) and then reloading lost the open state — the
 * sheet closed silently, dropping the user's in-progress work
 * unless that work had its own persistence wiring. [L23] violation
 * for the open-flag axis: an internal implementation operation
 * (mount-time `useState(false)`) destroyed user-visible state.
 *
 * Uses `componentStatePreservationKey` + `useComponentStatePreservation` to
 * `TugSheet`. The component is uncontrolled-only — open lives in
 * `useState` — so capture reads the live value, restore writes back
 * via `setOpen`. Per-surface payloads (form fields inside the
 * sheet, scroll position, etc.) ride their own `bag.components`
 * keys via the consumer's `useResponderForm` / opt-in components.
 *
 * ## Why TugAlert is NOT covered
 *
 * `tug-alert` was reclassified EPHEMERAL. It is
 * imperative-promise-based: `await showAlert(...)` opens the dialog
 * and resolves on click; the resolver is held in a ref captured at
 * the call site. Persisting `open: true` would re-open the alert
 * after reload but the resolver is gone — the awaiting code has
 * vanished with its re-rendered component, and clicks would resolve
 * nothing. Persistence would actively break the Promise contract.
 * `tug-confirm-popover`, `tug-popover`, `tug-tooltip`, and
 * `tug-context-menu` are similarly EPHEMERAL — see [AT0026]
 * for full rationale.
 *
 * ## Test matrix
 *
 *   1 component (sheet) × 1 trigger (appReload) = 1 test.
 *
 *   - Trigger: `appReload` (fresh WKWebView, disk round-trip).
 *     Gates the full persistence pipeline: capture → save → flush →
 *     load → restore.
 *   - The cmd-tab transition is not added; m04 / m05 / m17 already
 *     cover the will-phase save → cardStateCache write path that
 *     `useComponentStatePreservation` rides on.
 *
 * The test seeds `bag.components.{componentStatePreservationKey}` with `{ open: true }`,
 * drives `appReload`, and asserts the sheet's portal-rendered content
 * (`[data-slot="tug-sheet"]`) appears after restore.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/component-state-preservation-registry.ts
 * @covers tugdeck/src/components/tugways/tug-sheet.tsx
 * @covers tugdeck/src/lib/sheet-lifecycle.ts
 * @covers tugdeck/src/serialization.ts
 * @covers tugdeck/src/components/tugways/cards/gallery-sheet.tsx
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

const SHEET_PERSIST_KEY = "sheet-basic";

function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "gallery-sheet", title: "Sheet", closable: true },
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

function makeBag(open: boolean): Record<string, unknown> {
  return {
    components: {
      [SHEET_PERSIST_KEY]: { open },
    },
  };
}

async function seedAndMount(app: App, openSeed: boolean): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({
    state: deckShape(),
    cardStates: { A: makeBag(openSeed) },
    focusCardId: "A",
  });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  // Wait for the gallery card to render at least the trigger button.
  await app.waitForCondition<boolean>(
    `document.querySelector('[data-testid="gallery-sheet-trigger"]') !== null`,
    { timeoutMs: 4000 },
  );
}

interface DiskBag {
  components?: Record<string, { open?: boolean }>;
}

function readDiskOpen(tugbankPath: string): boolean | undefined {
  const onDisk = tugbankRead<DiskBag>(
    tugbankPath,
    "dev.tugapp.deck.cardstate",
    "A",
  );
  if (!onDisk) return undefined;
  const bag = onDisk.value as DiskBag | undefined;
  return bag?.components?.[SHEET_PERSIST_KEY]?.open;
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
    `document.querySelector('[data-testid="gallery-sheet-trigger"]') !== null`,
    { timeoutMs: 4000 },
  );
}

/**
 * Wait for the sheet's portal-rendered content to be present in the
 * DOM (`data-slot="tug-sheet"`). The sheet portals into the pane
 * element via `TugPanePortalContext`, so the content lives outside
 * the card-host subtree but inside the same pane.
 */
async function expectSheetOpen(app: App): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelector('[data-slot="tug-sheet"]') !== null`,
    { timeoutMs: 4000 },
  );
  const present = await app.evalJS<boolean>(
    `document.querySelector('[data-slot="tug-sheet"]') !== null`,
  );
  expect(present, "sheet content portal must be in DOM after restore").toBe(true);
}

async function expectSheetClosed(app: App): Promise<void> {
  // No wait — this is a synchronous "must already be true" assertion.
  const present = await app.evalJS<boolean>(
    `document.querySelector('[data-slot="tug-sheet"]') !== null`,
  );
  expect(present, "sheet content portal must NOT be in DOM when closed").toBe(false);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)("m26: TugSheet open state survives transitions", () => {
  test(
    "tug-sheet × appReload — open=true survives disk round-trip",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0026-sheet-open-app-reload",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          // Seed with the sheet already open and verify the cold-mount
          // restore path opens the portal.
          await seedAndMount(app, true);
          await expectSheetOpen(app);

          // appReload drives the full save/load cycle through tugbank.
          await app.appReload();

          // Disk gate: open=true persists.
          expect(
            readDiskOpen(tugbankPath),
            "axis bag.components.sheet-basic.open: appReload must round-trip true to disk",
          ).toBe(true);

          // Re-seed from disk; sheet must reopen.
          await reseedFromDisk(app, tugbankPath);
          await expectSheetOpen(app);
        } finally {
          await app.close();
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "tug-sheet × appReload — open=false stays closed",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0026-sheet-closed-app-reload",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await seedAndMount(app, false);
          await expectSheetClosed(app);

          await app.appReload();

          expect(
            readDiskOpen(tugbankPath),
            "axis bag.components.sheet-basic.open: appReload must round-trip false to disk",
          ).toBe(false);

          await reseedFromDisk(app, tugbankPath);
          await expectSheetClosed(app);
        } finally {
          await app.close();
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
