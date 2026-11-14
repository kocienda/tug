/**
 * activation-first-responder-fixture.ts — the shared decks, frames and key
 * helpers the at0165-activation-first-responder-* files drive the responder
 * chain through.
 *
 * The active card always owns first-responder-routed accelerators ([P21]).
 *
 * Cmd-W (`close`) routes to the chain's single first responder; Escape runs the
 * engine's Escape ladder (reads the active card's context directly). When a card
 * or pane closes, the next active card must take the first responder so Cmd-W
 * isn't dropped. The first responder otherwise rides DOM `focusin`, which doesn't
 * fire when the activated card has no focus-accepting element (a static card) or
 * when the activation `.focus()` is idempotency-skipped — leaving the first
 * responder fallen up on the `deck-canvas` root, where `close` has no handler.
 *
 * Two complementary fixes, both exercised across the split:
 *  1. `FocusManager.setKeyCard` (the universal activation signal) restores the
 *     first responder to the activated card on every key-card change, including
 *     pane-frontmost promotion (Bugs A–D pin the post-activation invariant).
 *  2. `DeckCanvas` is the `canHandle` root; its last-resort `close` handler
 *     routes to the active pane, so Cmd-W closes the frontmost card even when the
 *     first responder is stranded on `deck-canvas` (Bug E — the literal repro of
 *     the reported drop, pinned red→green).
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @module tests/app-test/activation-first-responder-fixture
 */

import type { App } from "./_harness";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 150_000;

export const SID = "at0165-session";
export const FEED_CODE_OUTPUT = 0x40;
export const REQUEST_ID = "at0165-perm-1";

export const CARD = (id: string) => `[data-card-id="${id}"]`;
/** A tab in a pane's bar, which the pane's active card draws in its own page. */
export const TAB = (id: string) => `[data-testid="tug-tab-${id}"]`;
export const DIALOG = `${CARD("A")} [data-slot="session-permission-dialog"]`;

// Two separate panes, each one card. p2 (card B) is the active/frontmost pane.
// Closing B destroys p2 and promotes p1 (card A) to frontmost — a pane
// activation that fires no card-level focus claim and no `focusin`.
export function twoPanes() {
  return {
    cards: [
      { id: "A", componentId: "gallery-input", title: "Card A", closable: true },
      { id: "B", componentId: "gallery-input", title: "Card B", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 460, height: 520 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
      {
        id: "p2",
        position: { x: 560, y: 40 },
        size: { width: 460, height: 520 },
        cardIds: ["B"],
        activeCardId: "B",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p2",
    hasFocus: true,
  };
}

export function twoCards(aComponent: string) {
  return {
    cards: [
      { id: "A", componentId: aComponent, title: "Card A", closable: true },
      { id: "B", componentId: "gallery-input", title: "Card B", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 860, height: 620 },
        cardIds: ["A", "B"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

export function controlRequestForward(): Record<string, unknown> {
  return {
    type: "control_request_forward",
    tug_session_id: SID,
    request_id: REQUEST_ID,
    is_question: false,
    tool_name: "Bash",
    input: { command: "tokei" },
    permission_suggestions: [
      { behavior: "allow", destination: "project", type: "addRules", rules: [{ toolName: "Bash" }] },
    ],
  };
}

export const frWithin = (cardSel: string) =>
  `(function(){
    var fr = document.querySelector('[data-first-responder]');
    var card = document.querySelector(${JSON.stringify(cardSel)});
    return fr !== null && card !== null && card.contains(fr);
  })()`;

export const exists = (sel: string) => `document.querySelector(${JSON.stringify(sel)}) !== null`;

/** Synthetic capture-phase ⌘ keydown — a posted ⌘ chord can be swallowed by
 *  macOS before the WebView; the synthetic event drives the same capture-phase
 *  keybinding pipeline (matchKeybinding → sendToFirstResponder). */
export async function cmdKey(app: App, code: string, key: string): Promise<void> {
  await app.evalJS<void>(
    `document.dispatchEvent(new KeyboardEvent("keydown", { code: ${JSON.stringify(code)}, key: ${JSON.stringify(key)}, metaKey: true, bubbles: true, cancelable: true }))`,
  );
}

export const settle = () => new Promise((r) => setTimeout(r, 350));
