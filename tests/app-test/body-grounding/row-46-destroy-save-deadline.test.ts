/**
 * row-46-destroy-save-deadline.test.ts — a body asked to save on its way out
 * is removed at the save's deadline when its page never answers.
 *
 * `bodyDestroy` with `save` has the page write its card's state before the
 * host removes it. A page that hangs on that call must not keep its body:
 * held, its process would leak, the card would still read as having a body
 * so a later ask for one is dropped, and a body still loading would hold a
 * lane slot. The host races the save against `saveDeadline` (two seconds,
 * `BodyLifecycle.swift`) and removes the body at whichever comes first.
 *
 * One Session card stands. Its page's `saveState` is made to never answer,
 * and the shell posts `bodyDestroy` with `save` for it by hand — the shell's
 * own close posts it without one today, so the row is what keeps the path
 * honest. The body is still in the host's list for most of the
 * deadline — the host is waiting on the save, not ignoring it — and gone
 * soon after it.
 *
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/BodyLifecycle.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "../_harness";
import { bodyOf, pollFor, sessionPane, settleFor } from "./_bodies";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const A = "r45-a";
/** `BodyLifecycle.saveDeadline`. */
const SAVE_DEADLINE_MS = 2_000;
/** How far past the deadline the body may still be listed: the timer's firing, the removal and the reads between. */
const LATE_MS = 400;

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: A, componentId: "session", title: "A", closable: true }],
    panes: [sessionPane(A, 0)],
    activePaneId: `${A}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 46: a destroy whose save hangs", () => {
  test(
    "a body whose page never answers the save is removed at the save's deadline",
    async () => {
      const app = await launchTugApp({ testName: "body-grounding-row-46-destroy-save-deadline" });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        await pollFor(() => bodyOf(app, A), (b) => b?.state === "ready" && b.visible, 30_000);

        // ---- The page will never answer its save ----
        // The resolver is held: WebKit ends a call whose promise is collected
        // unresolved, and a hung page's work still holds its own.
        await app.body(A).evalJS<null>(
          `(window.__r45Held = [], window.tugdeck.saveState = function () { return new Promise(function (resolve) { window.__r45Held.push(resolve); }); }, null)`,
        );

        // ---- The shell asks for the body to go, saving first ----
        // card-dom: shell — the message the shell's close posts, posted by hand with `save`.
        const askedAt = Date.now();
        await app.evalJS<null>(
          `(window.webkit.messageHandlers.bodyDestroy.postMessage(JSON.stringify({ cardId: ${JSON.stringify(A)}, save: true })), null)`,
        );
        let lastSeen = askedAt;
        const gone = await settleFor(
          async () => {
            const b = await bodyOf(app, A);
            if (b !== null) lastSeen = Date.now();
            return b;
          },
          (b) => b === null,
          SAVE_DEADLINE_MS + 5_000,
        );
        const goneAt = Date.now();
        note(`the body was last listed ${lastSeen - askedAt} ms and gone by ${goneAt - askedAt} ms after the destroy, for a save deadline of ${SAVE_DEADLINE_MS} ms`);
        expect(gone, "the body whose save hung is removed").toBeNull();
        expect(lastSeen - askedAt, "the host waited on the save before it gave up on it").toBeGreaterThanOrEqual(SAVE_DEADLINE_MS - 300);
        expect(goneAt - askedAt, "and gave up at the deadline, not later").toBeLessThanOrEqual(SAVE_DEADLINE_MS + LATE_MS);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
