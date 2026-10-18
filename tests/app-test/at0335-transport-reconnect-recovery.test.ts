/**
 * at0335-transport-reconnect-recovery.test.ts — a real WebSocket close,
 * and the deck healing itself.
 *
 * A couple of times a day every session card in the deck dropped its
 * session at once and sat behind a red "Connection lost — transport
 * closed" banner that made the card body `inert`. In the worst case the
 * cards never came back on their own. This test is the end-to-end guard
 * on the recovery: it closes the actual socket and asserts the deck is
 * usable afterwards.
 *
 * It uses `app.connectionClose()`, NOT
 * `driveSession(..., {op: "transportClose"})`. That distinction is the
 * whole point of the test. The `driveSession` op dispatches straight
 * into one card's reducer and never reaches `ConnectionLifecycle` or
 * `reassertOnReconnect` — it can show a green result while the recovery
 * path is entirely broken. `connectionClose` closes the real wire without
 * the `intentionalClose` latch, so the whole chain runs: close →
 * `connectionDidClose` → backoff → reconnect → `connectionDidReconnect` →
 * the page re-asserts its cards. The server is the same one, so they are
 * re-bound rather than rebuilt; a harness-bound card the ledger never
 * heard of is cleared, as a restart would clear it.
 *
 * What it pins:
 *   - No error banner is raised for a transport close — not while the
 *     wire is down, and not after it returns — and no card body is
 *     locked `inert` at any point.
 *   - The wire genuinely drops and genuinely comes back: the app-level
 *     disconnect strip appears and then clears on its own, with no
 *     gesture from the user and no reload.
 *   - The reducer contract stays pinned independently of the wire, via
 *     the store-level `transportClose` op on a separate card.
 *
 * What it deliberately does NOT pin, and why:
 *   - **Cards rebinding after the restore.** `bindSession` is a
 *     synthetic harness bind — it writes the client's binding store
 *     directly and leaves no server-side ledger row. The restore pass
 *     asks `list_card_bindings`, which has never heard of these cards,
 *     so they correctly fall to the picker. Asserting a rebind here would require a real
 *     `spawn_session` per card. Rebinding is covered by the plan's
 *     manual screen-lock run.
 *   - The multi-minute suspension case (the harness cannot throttle
 *     timers the way a slept machine does) and the WebContent kill (it
 *     would race the harness's own RPC bridge). Both are manual.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/connection.ts
 * @covers tugdeck/src/lib/code-session-store/reducer.ts
 * @covers tugdeck/src/lib/session-restore.ts
 * @covers tugdeck/src/lib/card-services-store.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 180_000;

/** Cards that ride the real close; `S` stays on the store-level op. */
const WIRE_CARD_IDS = ["A", "B", "C"] as const;
const STORE_CARD_ID = "S";
const ALL_CARD_IDS = [...WIRE_CARD_IDS, STORE_CARD_ID] as const;
type CardId = (typeof ALL_CARD_IDS)[number];

function sessionIdFor(cardId: CardId): string {
  return `test-session-${cardId}`;
}

function deckShape() {
  return {
    cards: ALL_CARD_IDS.map((id) => ({
      id,
      componentId: "session",
      title: `Dev ${id}`,
      closable: true,
    })),
    panes: ALL_CARD_IDS.map((id, i) => ({
      id: `p-${id}`,
      position: { x: 40 + i * 24, y: 40 + i * 24 },
      size: { width: 640, height: 460 },
      cardIds: [id],
      activeCardId: id,
      title: "",
      acceptsFamilies: ["maker"],
    })),
    activePaneId: "p-A",
    hasFocus: true,
  };
}

// ---------------------------------------------------------------------------
// DOM readers
// ---------------------------------------------------------------------------

/**
 * Count error-variant pane banners anywhere in the deck. The
 * error-variant `TugPaneBanner` is the one surface allowed to lock a
 * card body, so its absence is the assertion this whole test exists
 * for.
 */
async function errorBannerCount(app: App): Promise<number> {
  // A card's pane banner renders in its own body, so every card's page is
  // counted.
  let n = 0;
  for (const id of ALL_CARD_IDS) {
    n += await app.body(id).evalJS<number>(
      `document.querySelectorAll('.tug-pane-banner[data-variant="error"]').length`,
    );
  }
  return n;
}

/** Whether this card's pane body carries the banner's `inert` lock. */
function bodyIsInert(app: App, cardId: CardId): Promise<boolean> {
  return app.body(cardId).evalJS<boolean>(
    `(function(){
      var el = document.querySelector('[data-card-id="${cardId}"] [inert]');
      return el !== null;
    })()`,
  );
}

/** The submit button's `data-mode`, or null when the card has no body. */
function submitButtonMode(app: App, cardId: CardId): Promise<string | null> {
  return app.body(cardId).evalJS<string | null>(
    `(function(){
      var el = document.querySelector(
        '[data-card-id="${cardId}"] .tug-prompt-entry-submit-button');
      return el ? el.getAttribute("data-mode") : null;
    })()`,
  );
}

/** Whether the app-level "Disconnected — reconnecting…" strip is up. */
function disconnectStripVisible(app: App): Promise<boolean> {
  // card-dom: shell — the app-level strip is the deck's, in the shell page.
  return app.evalJS<boolean>(
    `document.querySelector('.tug-banner[data-visible="true"]') !== null`,
  );
}

async function waitForSubmitMode(
  app: App,
  cardId: CardId,
  mode: string,
  timeoutMs = 8000,
): Promise<void> {
  await app.body(cardId).waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector(
        '[data-card-id="${cardId}"] .tug-prompt-entry-submit-button');
      return el !== null && el.getAttribute("data-mode") === ${JSON.stringify(mode)};
    })()`,
    { timeoutMs },
  );
}

async function mountAllCards(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  for (const id of ALL_CARD_IDS) {
    await app.waitForCondition<boolean>(
      `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("${id}")`,
    );
    await app.bindSession(id, { tugSessionId: sessionIdFor(id) });
  }
  for (const id of ALL_CARD_IDS) {
    await app.body(id).waitForCondition<boolean>(
      `document.querySelector(
        '[data-card-id="${id}"] [data-slot="session-telemetry-status-row"]') !== null`,
      { timeoutMs: 8000 },
    );
  }
}

// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)(
  "AT0335: a transport close is a blip, not a lost afternoon",
  () => {
    test(
      "a real socket close leaves no error banner and every card usable",
      async () => {
        const app = await launchTugApp({
          testName: "at0335-transport-reconnect-recovery",
        });
        try {
          await mountAllCards(app);

          // Baseline: every card live, nothing bannered.
          for (const id of ALL_CARD_IDS) {
            expect(
              await submitButtonMode(app, id),
              `${id}: starts with a live submit`,
            ).toBe("submit");
          }
          expect(
            await errorBannerCount(app),
            "no banner before the close",
          ).toBe(0);

          // Give one card an in-flight turn, so the close has a turn to
          // lose — that is the branch that used to stamp the error.
          await app.driveSession("A", { op: "send", text: "long running" });
          await waitForSubmitMode(app, "A", "stop");

          // --- The real close ------------------------------------------
          // Every page rides a socket of its own — the shell's and each
          // card's body's — so the close the user experiences (the wire
          // going down) drops the shell's and every wire card's.
          expect(
            await app.connectionClose(),
            "the app had a connection to close",
          ).toBe(true);
          for (const id of WIRE_CARD_IDS) {
            expect(
              await app.body(id).evalJS<boolean>(`window.__tug.connectionClose()`),
              `${id}: the card's body had a connection to close`,
            ).toBe(true);
          }

          // The deck notices the wire is down: submit clamps to the
          // inert Reconnecting mode on a card that had nothing in
          // flight. This is the condition being *represented* — the
          // point is what it is NOT, asserted next.
          //
          // The app-level disconnect strip is deliberately not asserted
          // here: it has a 2 s show delay and the reconnect backoff
          // also starts at 2 s, so whether it ever paints is a genuine
          // coin flip. Its end state below is the reliable half.
          await waitForSubmitMode(app, "B", "reconnecting");

          // The wound this whole phase exists to close: a transport
          // close must never raise the card-locking error banner.
          expect(
            await errorBannerCount(app),
            "a transport close raises no error banner",
          ).toBe(0);
          for (const id of WIRE_CARD_IDS) {
            expect(
              await bodyIsInert(app, id),
              `${id}: the card body is not locked while the wire is down`,
            ).toBe(false);
          }

          // --- Recovery -------------------------------------------------
          // The connection retries on its own backoff (2 s doubling to
          // a 30 s cap). The deck must not be left announcing a
          // disconnect — no gesture from the user, and no reload.
          // card-dom: shell — the app-level strip is the deck's, in the shell page.
          await app.waitForCondition<boolean>(
            `document.querySelector('.tug-banner[data-visible="true"]') === null`,
            { timeoutMs: 90_000 },
          );
          expect(
            await disconnectStripVisible(app),
            "the deck is not left stuck announcing a disconnect",
          ).toBe(false);

          expect(
            await errorBannerCount(app),
            "recovery leaves no banner behind either",
          ).toBe(0);
          for (const id of WIRE_CARD_IDS) {
            expect(
              await bodyIsInert(app, id),
              `${id}: the recovered card body is not locked`,
            ).toBe(false);
          }
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "the store-level transport contract stays pinned independently of the wire",
      async () => {
        const app = await launchTugApp({
          testName: "at0335-transport-reconnect-recovery-store",
        });
        try {
          await mountAllCards(app);

          // A mid-turn close on one card, driven straight into its
          // reducer. This is the [P01] contract: errored phase, offline
          // transport, and NO banner — the "Reconnecting…" bulletin
          // owns the condition.
          await app.driveSession(STORE_CARD_ID, {
            op: "send",
            text: "mid-turn",
          });
          await waitForSubmitMode(app, STORE_CARD_ID, "stop");
          await app.driveSession(STORE_CARD_ID, { op: "transportClose" });
          await waitForSubmitMode(app, STORE_CARD_ID, "reconnecting");

          expect(
            await errorBannerCount(app),
            "a reducer-level transport close raises no banner either",
          ).toBe(0);
          expect(
            await bodyIsInert(app, STORE_CARD_ID),
            "the card body is not locked by a reducer-level close",
          ).toBe(false);

          // The recovery edge moves the card to `restoring`. Submit
          // stays clamped there on purpose — the wire being live does
          // not mean the supervisor has re-acked this card's session,
          // and only the binding landing (`transport_settled`) releases
          // it. What matters here is that no banner appears on either
          // edge.
          await app.driveSession(STORE_CARD_ID, { op: "transportReconnect" });
          expect(
            await errorBannerCount(app),
            "no banner after the store-level recovery either",
          ).toBe(0);
          expect(
            await bodyIsInert(app, STORE_CARD_ID),
            "still no lock on the recovery edge",
          ).toBe(false);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
