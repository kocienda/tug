/**
 * sidebar-toggle.ts — what a rail's shortcut means (⌃⌘← left, ⌃⌘→ right), and
 * what a sidebar card's own chord and menu row mean (⌃⌘R Arcs, ⌃⌘W Cards,
 * ⌃⌘J Jots, ⌃⌘L Layout, ⌃⌘O Overview) — and what ⌃⌘S means over BOTH sides at
 * once.
 *
 * One key, three states, read off the deck:
 *
 *   - the rail is not showing         → show it and activate it
 *   - showing but not holding the key → activate it
 *   - showing and holding the key     → hide it
 *
 * Presence is still the open state ([P02]); the middle state is what a plain
 * show/hide toggle could not say — a visible rail that does not hold the
 * keyboard is not what the shortcut asked for, so the first press brings the
 * keyboard to it and only the second press takes the rail away.
 *
 * The ladder is written twice over two objects, not once over one: a rail and
 * a card are addressed differently at every rung — which members show, which
 * one takes the keyboard, what "already holding it" means — and the shared part
 * is the shape of the decision rather than any of its steps.
 *
 * Every door runs these performers: the Swift menu items dispatching through
 * `action-dispatch` — View ▸ ⟨Card⟩ ▸ Show for the cards, Maker for the rail
 * pair — the chords those items carry, which AppKit resolves at the menu layer
 * so they arrive by the same route, and the deck-canvas key handlers. A tier
 * sited at one door is a gesture that means something different from the other
 * one, which is the whole reason the card rows' chords reach the SAME command
 * id their rows send rather than a ladder of their own.
 *
 * Activation goes through `transferFocusForActivation` with keyboard modality,
 * the contract ⌘J (NEW_JOT) already holds: a keyboard gesture lands visibly
 * ringed on the rail's remembered key view.
 */

import type { IDeckManagerStore } from "./deck-manager-store";
import {
  isSidebarPinned,
  railHiddenMembers,
  sidebarSide,
  type SidebarSide,
} from "./lib/layout-imposer";
import { findSidebarPanes } from "./deck-store-selectors";
import { transferFocusForActivation } from "./focus-transfer";

/**
 * Run the three-state rail shortcut for `side` — the ⌃⌘ arrow pair.
 *
 * The member the keyboard lands on is the rail's **z-frontmost**, which is the
 * one answer well defined in both arrangements: stacked, it is the member you
 * can actually see; split, it is the one the stack badge's picker checkmarks.
 * `railFrontmostPaneId` in `deck-canvas.tsx` reads z off the same array for the
 * same reason, and `findSidebarPanes` returns it — the panes array's order IS
 * the deck's z-order, back to front.
 *
 * A rail with nothing to show is inert rather than half-acting:
 * `showSidebarRail` returns null and no focus moves.
 */
export function toggleSidebarRail(
  store: IDeckManagerStore,
  side: SidebarSide,
): void {
  const state = store.getSnapshot();
  const imposition = state.imposition;
  const members = findSidebarPanes(state).filter(
    ({ componentId }) =>
      isSidebarPinned(imposition, componentId) &&
      sidebarSide(imposition, componentId) === side,
  );
  const outgoingCardId = store.getFirstResponderCardId();

  const holdsKey =
    outgoingCardId !== null &&
    members.some(({ pane }) => pane.cardIds.includes(outgoingCardId));
  if (holdsKey) {
    store.hideSidebarRail(side);
    return;
  }

  const frontmost = members[members.length - 1];
  const incomingCardId =
    frontmost === undefined
      ? store.showSidebarRail(side)
      : frontmost.pane.activeCardId;
  if (incomingCardId === null) return;
  transferFocusForActivation({
    outgoingCardId,
    incomingCardId,
    store,
    commitMutation: () => store.activateCard(incomingCardId),
    modality: "keyboard",
  });
}

/**
 * Hide or show BOTH rails on one gesture — ⌃⌘S, and View ▸ Hide / Show
 * Sidebars.
 *
 * Two states rather than the pair's three, because the question this gesture
 * asks is about the deck's edges rather than about a card: anything standing
 * on either side means the next press clears them, and nothing standing means
 * the next press brings them back. The middle rung the ⌃⌘ arrows have —
 * showing but not holding the keyboard — has no reading here: the reader
 * pressing this is asking for room to read in, not for the keyboard to go to
 * a rail.
 *
 * **Showing puts back only what a hide took away.** `hideSidebarRail` records
 * each side's members before it closes them, so the show branch reopens the
 * sides that carry such a memory and leaves the others alone —
 * `showSidebarRail` on a side with no memory falls back to that side's default
 * member, which on a deck the user had never opened a right rail on would MINT
 * one the gesture never hid. The fallback is right in exactly one case: no
 * side remembers anything, which is a first press of Show with nothing to
 * restore, and there the gesture means "open what each side would open".
 *
 * **The keyboard stays where the reader left it.** A hide's closes hand it on
 * themselves, and a show has to hand it BACK: `showSidebarPane` mints its pane
 * as the active one — right for ⌃⌘L, which is a summons — so without this the
 * gesture that gives the reader room to read would take their caret out of the
 * card they were typing in. The card the keyboard was on is re-activated when
 * it is still on the deck, which is every case but the one where the reader
 * was in a rail card the hide itself closed.
 */
export function toggleSidebars(store: IDeckManagerStore): void {
  const state = store.getSnapshot();
  const imposition = state.imposition;
  const standing = findSidebarPanes(state).some(({ componentId }) =>
    isSidebarPinned(imposition, componentId),
  );
  const sides: readonly SidebarSide[] = ["left", "right"];

  if (standing) {
    for (const side of sides) store.hideSidebarRail(side);
    return;
  }

  const outgoingCardId = store.getFirstResponderCardId();
  const remembered = sides.filter(
    (side) => railHiddenMembers(imposition, side).length > 0,
  );
  for (const side of remembered.length > 0 ? remembered : sides) {
    store.showSidebarRail(side);
  }
  if (outgoingCardId === null) return;
  const survives = store
    .getSnapshot()
    .cards.some((card) => card.id === outgoingCardId);
  if (survives) store.activateCard(outgoingCardId);
}

/**
 * Run the three-state sidebar shortcut for one CARD — the Show ⟨card⟩ menu
 * rows, and whatever the keymap pane has since been asked to bind them to.
 * No-op when the card type is unregistered (`showSidebarPane` returns null and
 * warns).
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

/**
 * Show a sidebar card and bring the keyboard to it, never hiding it.
 *
 * The toggle's third state is wrong for a link: a chip that promises to
 * reveal something must not take it away because it happened to be showing
 * already. Everything else is the shortcut's own path, so a revealed rail
 * lands ringed exactly as a pressed ⌃⌘L does.
 *
 * The modality is `pointer` rather than `keyboard`, because this door is a
 * click: the ring is for the keyboard's gestures, and painting one on a
 * mouse click would tell the reader their focus moved somewhere it did not.
 */
export function revealSidebarCard(
  store: IDeckManagerStore,
  componentId: string,
): void {
  const outgoingCardId = store.getFirstResponderCardId();
  const incomingCardId = store.showSidebarPane(componentId);
  if (incomingCardId === null) return;
  transferFocusForActivation({
    outgoingCardId,
    incomingCardId,
    store,
    commitMutation: () => store.activateCard(incomingCardId),
    modality: "pointer",
  });
}
