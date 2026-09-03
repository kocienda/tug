/**
 * at0175-session-mount-focus.test.ts — when a session card mounts as the
 * focused card and its session binds, the prompt-entry editor
 * (CodeMirror's contentDOM) gains DOM focus AND the custom caret
 * layer renders, all without a user click.
 *
 * Pins TWO related contracts:
 *
 *   1. **Editor focus contract** (Spec [S02] in
 *      `arc/tugplan-session-init-orchestration.md`): every
 *      overlay that sets `inert` on `.tug-pane-body` MUST emit a
 *      per-card `xxxDidHide` lifecycle event after `inert` clears,
 *      and `SessionCardBody` MUST subscribe with an idempotent focus
 *      claim. The mechanism:
 *        - `tug-text-editor.tsx` `focus()` delegate routes through
 *          `manager.focusResponder(responderId)` → atomic chain
 *          promotion + DOM focus.
 *        - `cardDidActivate` in `SessionCardBody` calls
 *          `entryDelegate.focus()` on initial-sync via
 *          `useCardDelegate`.
 *        - `sheetDidHide` / `bannerDidHide` lifecycle handlers
 *          (per `lib/sheet-lifecycle.ts` + `lib/banner-lifecycle.ts`)
 *          re-claim editor focus when a sheet or banner finishes
 *          hiding.
 *
 *   2. **No-banner contract for new-mode bindings** (Spec [S01]):
 *      `deriveSessionCardBannerSpec` returns `kind: "none"` for the
 *      `phase === "replaying"` branch when `sessionMode === "new"`,
 *      so the JSONL-missing replay round-trip that fires for every
 *      binding land does not light up a "Loading session…" banner
 *      with no referent. The test verifies that `<TugPaneBanner>`
 *      is never mounted under the card during the bind window.
 *
 * Earlier symptoms this guards against:
 *   - Caret flashes and is stolen as a banner mounts (sets `inert`
 *     on `.tug-pane-body`, blurs the contentDOM), then the banner
 *     hides without anyone re-focusing the editor. Fixed by the
 *     lifecycle-event focus-claim handlers in `SessionCardBody`.
 *   - "Loading session…" banner shows for ~700ms during a new
 *     session's bind window even though there's no JSONL to
 *     replay, stealing focus and producing a flicker. Fixed by
 *     the mode-gate on banner-spec branch 5.
 *
 * Test strategy: seed a session card + bind a fake session, wait for
 * the editor to mount, capture focus + caret + banner-mount state
 * at multiple timepoints. The harness skips the picker UI by
 * binding the session directly — the production picker has its
 * own UI surface that's awkward to drive in the harness, but the
 * focus-claim plumbing and banner-spec derivation on the post-bind
 * path are what matter here.
 *
 * The two test blocks below cover the two contracts independently:
 *   - The first ("after seed + bind…") asserts the focus contract:
 *     contentDOM is activeElement, `.cm-focused` is set, exactly
 *     one caret renders, and state is stable across a 1s settling
 *     window.
 *   - The second ("new-mode bind: no banner mounts…") installs a
 *     MutationObserver before bind to record any banner-element
 *     addition under the card subtree, then asserts the count is
 *     zero through the bind window — pinning the no-banner contract
 *     and ensuring that focus is never gated on a banner exit for
 *     new-mode sessions.
 *
 * FOREGROUND: the caret layer paints only while `.cm-focused` is set, and CM6
 * derives that from real DOM focus. A background-mode window's document never
 * has focus, so `.cm-content` becomes activeElement but `.cm-focused` never
 * applies and no caret renders — the very thing this test asserts.
 *
 * @foreground
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor/
 * @covers tugdeck/src/default-focus.ts
 * @covers tugdeck/src/components/tugways/tug-pane-banner.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 60_000;

// CodeMirror's editable surface is `.cm-content[contenteditable]`
// inside the `<div data-slot="tug-text-editor">` host. The custom
// caret is rendered by `tug-text-editor/caret-layer.ts` as
// `.tug-text-editor-caret`, which only paints when CM6's
// `view.hasFocus` is true (see `caret-layer.ts:181`). Asserting on
// the caret element existence is the user-visible test for "is the
// caret blinking?".
const PROMPT_INPUT_SELECTOR = '[data-slot="tug-text-editor"] .cm-content';

const SESSION_DECK_STATE = {
  cards: [
    { id: "A", componentId: "session", title: "Session A", closable: true },
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

interface FocusState {
  matchesPromptEntry: boolean;
  underCardId: string | null;
  hasFocus: boolean;
  caretCount: number;
  cmFocused: boolean;
}

async function captureFocus(app: App, cardId: string): Promise<FocusState> {
  const promptSelector = `[data-card-id="${cardId}"] ${PROMPT_INPUT_SELECTOR}`;
  return app.evalJS<FocusState>(
    `(function(){
      var el = document.activeElement;
      var card = el && el.closest ? el.closest("[data-card-id]") : null;
      var matches = el !== null && el.matches ? el.matches(${JSON.stringify(promptSelector)}) : false;
      var carets = document.querySelectorAll(${JSON.stringify(`[data-card-id="${cardId}"] .tug-text-editor-caret`)});
      var cmEditor = document.querySelector(${JSON.stringify(`[data-card-id="${cardId}"] .cm-editor`)});
      return {
        matchesPromptEntry: matches,
        underCardId: card ? card.getAttribute("data-card-id") : null,
        hasFocus: document.hasFocus(),
        caretCount: carets.length,
        cmFocused: cmEditor !== null && cmEditor.classList.contains("cm-focused"),
      };
    })()`,
  );
}

/**
 * Counter shape returned by the banner-mount observer installed in
 * the WebView. `total` is the number of `<TugPaneBanner>` element
 * additions seen under the card subtree since `installBannerWatch`
 * was called; a non-zero value violates the no-banner contract for
 * the new-mode bind window.
 */
interface BannerWatchSnapshot {
  /** Number of banner element additions observed under the card. */
  total: number;
  /** Banner element count present in the DOM at read time. */
  current: number;
}

/**
 * Install a `MutationObserver` in the WebView that records every
 * `[data-slot="tug-pane-banner"]` addition under the given card's
 * subtree until `readBannerWatch(app)` is called and the observer is
 * disconnected.
 *
 * Polling for banner presence at fixed timepoints would miss a
 * brief mount/unmount that fits between two samples. The observer
 * sees every mutation and records a monotonic count, so a single
 * read at the end of the bind window proves "banner never mounted"
 * for the entire window.
 */
async function installBannerWatch(app: App, cardId: string): Promise<void> {
  const cardSelector = `[data-card-id="${cardId}"]`;
  await app.evalJS<null>(
    `(function(){
      var bannerSel = '[data-slot="tug-pane-banner"]';
      var cardSel = ${JSON.stringify(cardSelector)};
      window.__at0175BannerTotal = 0;
      window.__at0175BannerObserver = new MutationObserver(function(muts){
        for (var i = 0; i < muts.length; i++) {
          var m = muts[i];
          for (var j = 0; j < m.addedNodes.length; j++) {
            var node = m.addedNodes[j];
            if (node.nodeType !== 1) continue;
            var el = node;
            // Direct match.
            if (el.matches && el.matches(bannerSel)) {
              window.__at0175BannerTotal++;
              continue;
            }
            // Banner mounted as a descendant of an added subtree
            // (the typical case — TugPaneBanner portals into the
            // pane chrome, which lands under the card subtree).
            if (el.querySelectorAll) {
              window.__at0175BannerTotal +=
                el.querySelectorAll(bannerSel).length;
            }
          }
        }
      });
      // Observe the whole document because TugPaneBanner portals into
      // \`TugPanePortalContext\` (the host pane's chrome), which lives
      // under the card subtree but isn't a direct child of the card
      // root. A subtree:true observation on the document body covers
      // every reachable mount path.
      var card = document.querySelector(cardSel);
      var root = card !== null ? card : document.body;
      window.__at0175BannerObserver.observe(root, {
        childList: true,
        subtree: true,
      });
      return null;
    })()`,
  );
}

/**
 * Read the banner-watch counter and disconnect the observer.
 * Returns both the running total of additions seen since
 * `installBannerWatch` and the current banner count in the DOM.
 * Both are expected to be zero through a new-mode bind window.
 */
async function readBannerWatch(
  app: App,
  cardId: string,
): Promise<BannerWatchSnapshot> {
  const bannerSelector = `[data-card-id="${cardId}"] [data-slot="tug-pane-banner"]`;
  return app.evalJS<BannerWatchSnapshot>(
    `(function(){
      var total = window.__at0175BannerTotal || 0;
      var current = document.querySelectorAll(${JSON.stringify(bannerSelector)}).length;
      if (window.__at0175BannerObserver) {
        window.__at0175BannerObserver.disconnect();
        window.__at0175BannerObserver = undefined;
      }
      window.__at0175BannerTotal = undefined;
      return { total: total, current: current };
    })()`,
  );
}

async function waitForEditor(app: App, cardId: string): Promise<void> {
  // The 2-second waitForCondition cap is too short for the
  // seedDeckState → mount → bindSession → engine-construct
  // pipeline. Longer dwells sidestep the cap; the production
  // contract is "settles within a second or so" (these dwells are
  // for headroom in the harness, not real production timing).
  await new Promise<void>((r) => setTimeout(r, 1500));
  const dump = await app.evalJS<{
    hostRootRegistered: boolean;
    engineReady: boolean;
    contentPresent: boolean;
  }>(
    `(function(){
      var promptSel = '[data-card-id=${JSON.stringify(cardId).slice(1, -1)}] [data-slot="tug-text-editor"] .cm-content';
      return {
        hostRootRegistered: typeof window.__tug !== "undefined" && window.__tug.assertHostRootRegistered(${JSON.stringify(cardId)}),
        engineReady: typeof window.__tug !== "undefined" && window.__tug.isEngineReady(${JSON.stringify(cardId)}),
        contentPresent: document.querySelector(promptSel) !== null,
      };
    })()`,
  );
  expect(dump.hostRootRegistered, `host root not registered for ${cardId}; dump=${JSON.stringify(dump)}`).toBe(true);
  expect(dump.engineReady, `engine not ready for ${cardId}; dump=${JSON.stringify(dump)}`).toBe(true);
  expect(dump.contentPresent, `editor contentDOM missing for ${cardId}; dump=${JSON.stringify(dump)}`).toBe(true);
}

describe.skipIf(!SHOULD_RUN)(
  "AT0175: session card mount-time focus + caret claim",
  () => {
    test(
      "after seed + bind: editor's contentDOM is activeElement, .cm-focused is set, exactly one caret renders",
      async () => {
        const tugbankPath = mkTempTugbank();
        try {
          seedTugbankForLaunch(tugbankPath);

          const app = await launchTugApp({
            testName: "at0175-session-mount-focus",
            env: { TUGBANK_PATH: tugbankPath },
            persistInTestMode: true,
            foreground: true,
          });

          try {
            await app.enableDeckTrace(true);
            await app.seedDeckState({ state: SESSION_DECK_STATE, focusCardId: "A" });
            await new Promise<void>((r) => setTimeout(r, 1500));
            await app.bindSession("A");
            await waitForEditor(app, "A");

            // Probe focus state at multiple timepoints. Settling
            // window covers any late session-init banner activity
            // that previously stole focus from the editor.
            const t0 = await captureFocus(app, "A");
            await new Promise<void>((r) => setTimeout(r, 1000));
            const t1000 = await captureFocus(app, "A");

            // The user-visible contract: caret renders on the
            // editor for cardId "A", and stays there.
            expect(
              t1000.matchesPromptEntry,
              `expected editor contentDOM activeElement at t+1s; saw ${JSON.stringify(t1000)}`,
            ).toBe(true);
            expect(t1000.underCardId).toBe("A");
            expect(
              t1000.cmFocused,
              `expected .cm-focused on .cm-editor (CM6 view.hasFocus=true); saw ${JSON.stringify(t1000)}`,
            ).toBe(true);
            expect(
              t1000.caretCount,
              `expected exactly one caret element rendered; saw ${JSON.stringify(t1000)}`,
            ).toBe(1);

            // Also ensure the caret didn't appear-then-disappear:
            // both timepoints should agree.
            expect(
              t0.caretCount,
              `expected caret rendered at t+0 too; saw t0=${JSON.stringify(t0)} t1000=${JSON.stringify(t1000)}`,
            ).toBe(1);
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
      "new-mode bind: no banner mounts during the bind window; caret stays focused",
      async () => {
        // Pins Spec [S01] from `tugplan-session-init-orchestration.md`:
        // for `sessionMode === "new"`, `deriveSessionCardBannerSpec`
        // returns `kind: "none"` for the active-phase replay-loading
        // branch, so the JSONL-missing replay round-trip that fires
        // for every binding-land doesn't paint a "Loading session…"
        // banner with no referent. This in turn means the editor's
        // caret claim from `cardDidActivate` is never interrupted by
        // a banner-induced `inert`/blur cycle.
        //
        // Method: install a MutationObserver before the bind that
        // records every `<TugPaneBanner>` element addition under the
        // card subtree. After the bind window settles, assert the
        // count is zero. A polling-based approach would miss a brief
        // banner that fits between two samples; the observer sees
        // every mutation and gives a monotonic, sample-free witness
        // that "the banner never mounted."
        //
        // Also asserts the caret-presence claim from the focus
        // contract holds for the new-mode path — same expectations
        // as the test above, but explicitly under
        // `sessionMode: "new"` to document the path.
        const tugbankPath = mkTempTugbank();
        try {
          seedTugbankForLaunch(tugbankPath);

          const app = await launchTugApp({
            testName: "at0175-session-mount-focus-new-mode",
            env: { TUGBANK_PATH: tugbankPath },
            persistInTestMode: true,
            foreground: true,
          });

          try {
            await app.enableDeckTrace(true);
            await app.seedDeckState({ state: SESSION_DECK_STATE, focusCardId: "A" });
            await new Promise<void>((r) => setTimeout(r, 1500));

            // Install the banner-mount observer BEFORE bind so we
            // catch any banner that mounts and unmounts entirely
            // within the bind window — the case the contract is
            // designed to prevent.
            await installBannerWatch(app, "A");

            // Explicit `sessionMode: "new"` documents the path. The
            // harness defaults to "new" anyway, but pinning it here
            // makes the test's intent unambiguous to a future reader.
            await app.bindSession("A", { sessionMode: "new" });
            await waitForEditor(app, "A");

            // Settling window: catches any late banner activity
            // (replay_started / replay_complete{jsonl_missing}
            // round-trip). Pre-Step 2 of the orchestration plan,
            // this window would have shown a ~700ms banner cycle
            // (500ms minMountedMs + 200ms exit). Post-Step 2, the
            // observer should record zero mounts.
            await new Promise<void>((r) => setTimeout(r, 1500));

            const focus = await captureFocus(app, "A");
            const banner = await readBannerWatch(app, "A");

            // No-banner contract: zero additions, zero present.
            expect(
              banner.total,
              `expected no banner mounts during the new-mode bind window; observer recorded ${banner.total} addition(s)`,
            ).toBe(0);
            expect(
              banner.current,
              `expected no banner element in the DOM at end of bind window; saw ${banner.current}`,
            ).toBe(0);

            // Focus contract: caret claimed without banner gate.
            expect(
              focus.matchesPromptEntry,
              `expected editor contentDOM activeElement after new-mode bind; saw ${JSON.stringify(focus)}`,
            ).toBe(true);
            expect(focus.underCardId).toBe("A");
            expect(
              focus.cmFocused,
              `expected .cm-focused on .cm-editor for new-mode bind; saw ${JSON.stringify(focus)}`,
            ).toBe(true);
            expect(
              focus.caretCount,
              `expected exactly one caret element rendered after new-mode bind; saw ${JSON.stringify(focus)}`,
            ).toBe(1);
          } finally {
            await app.close();
          }
        } finally {
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
