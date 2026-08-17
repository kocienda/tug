/**
 * sidebar-toggle.ts — what a sidebar card's shortcut means (⌃⌘L Lens,
 * ⌃⌘J Jots, ⌃⌘O Overview).
 *
 * One key, three states, read off the deck:
 *
 *   - the rail is not showing        → show it and activate it
 *   - showing but not the active card → activate it
 *   - showing and active              → hide it
 *
 * Presence is still the open state ([P02]); the middle state is what a plain
 * show/hide toggle could not say — a visible rail that does not hold the
 * keyboard is not what the shortcut asked for, so the first press brings the
 * keyboard to it and only the second press takes the rail away.
 *
 * Both doors run this one performer: the Swift View-menu items dispatching
 * `toggle-lens` / `toggle-jots` / `toggle-overview` through `action-dispatch`,
 * and the deck-canvas key handlers. A tier sited at one door is a gesture that
 * means something different from the other one.
 *
 * Activation goes through `transferFocusForActivation` with keyboard modality,
 * the contract ⌘L (FOCUS_LENS) and ⌘J (NEW_JOT) already hold: a keyboard
 * gesture lands visibly ringed on the rail's remembered key view.
 */

import type { IDeckManagerStore } from "./deck-manager-store";
import { transferFocusForActivation } from "./focus-transfer";

/**
 * Run the three-state sidebar shortcut for `componentId`. No-op when the card
 * type is unregistered (`showSidebarPane` returns null and warns).
 */
export function toggleSidebarCard(
  store: IDeckManagerStore,
  componentId: string,
): void {
  const existing = store
    .getSnapshot()
    .cards.find((c) => c.componentId === componentId);
  const outgoingCardId = store.getFirstResponderCardId();

  if (existing !== undefined && existing.id === outgoingCardId) {
    store.hideSidebarPane(componentId);
    return;
  }

  const incomingCardId = store.showSidebarPane(componentId);
  if (incomingCardId === null) return;
  transferFocusForActivation({
    outgoingCardId,
    incomingCardId,
    store,
    commitMutation: () => store.activateCard(incomingCardId),
    modality: "keyboard",
  });
}
