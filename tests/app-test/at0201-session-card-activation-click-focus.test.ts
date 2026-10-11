/**
 * at0201-session-card-activation-click-focus.test.ts — clicking a deactivated
 * session card lands focus on its prompt entry, for every click target
 * [AT0201].
 *
 * ## Why this exists
 *
 * Regression: an activation click on a background session card's TRANSCRIPT
 * BODY activated the card but stripped the caret. The activation
 * transfer's engine claim (`transferFocusForActivation` → `applyBagFocus`
 * → engine hook → `view.focus()`) runs synchronously inside the
 * capture-phase pointerdown — so the browser's mousedown focus default
 * always ran AFTER it. When the click chain contained a focusable wrapper
 * (a `tabIndex` list-view row/container, or the transcript cell's own
 * `tabIndex={-1}` responder div), WebKit moved focus onto that wrapper;
 * when nothing was focusable, WebKit cleared focus to body. Either way
 * the prompt entry lost the caret the transfer had just placed.
 *
 * Three coordinated fixes, all exercised here:
 *  1. The transcript's `TugListView` is `interactive={false}`, and a
 *     read-only un-authored list renders NO tabindex on its container or
 *     row wrappers (a `0`/`-1` element is still mouse-focusable).
 *  2. Transcript cells no longer carry the `tabIndex={-1}` workaround
 *     (chain promotion of the cell needs no focusable element).
 *  3. `pane-focus-controller`'s mousedown listener suppresses the
 *     browser's focus default for a cross-card ACTIVATION click on card
 *     content — the transfer owns focus placement; without the
 *     suppression a click on non-focusable prose clears focus to body.
 *     (Mac first-click-activates: the activation click does not also
 *     place a caret or start a selection.)
 *
 * The title-bar and direct-editor click targets are pinned alongside so
 * the whole activation-click surface stays green together.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/focus-transfer.ts
 * @covers tugdeck/src/default-focus.ts
 * @covers tugdeck/src/components/chrome/pane-focus-controller.ts
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/components/tugways/tug-transcript-entry.tsx
 */

import { describe, test } from "bun:test";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CODE_OUTPUT_FEED = 0x40;
const PROMPT_INPUT_SELECTOR = '[data-slot="tug-text-editor"] .cm-content';

function activeElementInCard(cardId: string): string {
  return `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(PROMPT_INPUT_SELECTOR)}) && document.activeElement.closest('[data-card-id="${cardId}"]') !== null`;
}

/**
 * The pane's title-bar gesture surface. The BAR, not the title text inside it:
 * a Session pane wears a masthead rather than a title string, so there is no
 * `tug-pane-title` there to click — and the bar is what this test is about
 * anyway, since it is the activation/drag surface.
 */
function paneTitleSelectorFor(paneId: string): string {
  return `[data-pane-id="${paneId}"] [data-testid="tug-pane-title-bar"]`;
}

const twoSessionPanes = {
  cards: [
    { id: "A", componentId: "session", title: "Session A", closable: true },
    { id: "B", componentId: "session", title: "Session B", closable: true },
  ],
  panes: [
    {
      id: "p1",
      position: { x: 40, y: 40 },
      size: { width: 560, height: 520 },
      cardIds: ["A"],
      activeCardId: "A",
      title: "",
      acceptsFamilies: ["maker"],
    },
    {
      id: "p2",
      position: { x: 640, y: 40 },
      size: { width: 560, height: 520 },
      cardIds: ["B"],
      activeCardId: "B",
      title: "",
      acceptsFamilies: ["maker"],
    },
  ],
  activePaneId: "p1",
  hasFocus: true,
};

async function launchAndSeed(testName: string) {
  const app = await launchTugApp({ testName });
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: twoSessionPanes, focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
  );
  await app.bindSession("A");
  await app.awaitEngineReady("A");
  await app.bindSession("B");
  await app.awaitEngineReady("B");
  // Focus A's editor for a defined starting point.
  await app.nativeClickAtElement(`[data-card-id="A"] ${PROMPT_INPUT_SELECTOR}`);
  await app.waitForCondition<boolean>(activeElementInCard("A"));
  return app;
}

/** Deactivate pane 1 by activating pane 2 (title-bar click). */
async function activatePane2(app: Awaited<ReturnType<typeof launchTugApp>>) {
  await app.nativeClickAtElement(paneTitleSelectorFor("p2"));
  await app.waitForCondition<boolean>(activeElementInCard("B"), {
    timeoutMs: 3000,
  });
}

describe.skipIf(!SHOULD_RUN)(
  "AT0201: activation click on a deactivated session card focuses the prompt entry",
  () => {
    test(
      "TITLE BAR click refocuses A's editor",
      async () => {
        const app = await launchAndSeed("at0201-title");
        try {
          await activatePane2(app);
          await app.nativeClickAtElement(paneTitleSelectorFor("p1"));
          await app.waitForCondition<boolean>(activeElementInCard("A"), {
            timeoutMs: 3000,
          });
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "TRANSCRIPT BODY click (over real turn content) refocuses A's editor",
      async () => {
        const app = await launchAndSeed("at0201-body");
        try {
          // Fill A's transcript with a real turn so the click lands on a
          // transcript row's prose — the regression's exact shape. The
          // empty-transcript variant (bare list-view container) is covered
          // by the same fix but this is the user-visible path.
          const SID = "test-session-A";
          const ingest = (decoded: unknown) =>
            app.driveSession("A", {
              op: "ingestFrame",
              feedId: CODE_OUTPUT_FEED,
              decoded,
            });
          await ingest({ type: "replay_started", tug_session_id: SID });
          await ingest({
            type: "add_user_message",
            tug_session_id: SID,
            content: [{ type: "text", text: "hello there, please explain the plan" }],
          });
          await ingest({
            type: "assistant_text",
            status: "complete",
            tug_session_id: SID,
            msg_id: "m1",
            text: "Here is a longer assistant reply that spans the transcript region with enough prose that a click near the top of the content area lands on this row's text.",
            is_partial: false,
            rev: 0,
            seq: 1,
          });
          await ingest({
            type: "turn_complete",
            seq: 0,
            tug_session_id: SID,
            msg_id: "m1",
            result: "success",
          });
          await ingest({
            type: "replay_complete",
            tug_session_id: SID,
            count: 1,
            firstLoadedTurnIndex: 0,
            totalTurns: 1,
            hasOlder: false,
          });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('[data-card-id="A"] [data-slot="tug-transcript-entry-sequence"]').length > 0`,
            { timeoutMs: 5000 },
          );

          await activatePane2(app);

          // Click a point in the transcript region — 40px below the top of
          // the content area, horizontally centered — over the turn prose.
          const pt = await app.evalJS<{ x: number; y: number }>(
            `(function(){
              var el = document.querySelector('[data-pane-id="p1"] .tug-pane-content');
              var r = el.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + 40 };
            })()`,
          );
          await app.nativeClick(pt);
          await app.waitForCondition<boolean>(activeElementInCard("A"), {
            timeoutMs: 3000,
          });
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "PROMPT EDITOR click refocuses A's editor",
      async () => {
        const app = await launchAndSeed("at0201-editor");
        try {
          await activatePane2(app);
          await app.nativeClickAtElement(
            `[data-card-id="A"] ${PROMPT_INPUT_SELECTOR}`,
          );
          await app.waitForCondition<boolean>(activeElementInCard("A"), {
            timeoutMs: 3000,
          });
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
