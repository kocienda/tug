/**
 * pane-focus-controller.ts — sole authority for the `data-focused` DOM
 * attribute on every `.tug-pane[data-pane-id]` element within the deck root,
 * and the consumer that turns the gesture interpreter's activation and
 * deselect decisions into store mutations.
 *
 * **Attribute authority.**
 *   - Reads: the store's `activePaneId` (snapshot-reactive via
 *     `useSyncExternalStore`) and the deck root ref.
 *   - Writes: `data-focused="true"` on the active pane's frame,
 *     `data-focused="false"` on every other pane's frame. Writes happen twice:
 *     from a synchronous store subscriber, in the commit's own task, so a
 *     press whose React commit is deferred past the next paint still lights
 *     its pane in that paint; and in `useLayoutEffect` post-commit so
 *     newly-mounted panes receive their attribute before paint — no flicker.
 *   - React no longer renders `data-focused` from a prop; React's reconciler
 *     therefore never considers or clobbers this attribute.
 *
 * **Deselect lives in the DOM, not React.** Deselect is expressed as "write
 * `data-focused="false"` on every pane" — there is no separate
 * `data-deselected` attribute, no React state, no mask CSS rules. Selection is
 * exactly "which pane is `activePaneId`".
 *
 * **Gesture classification lives in `gesture-interpreter.ts`.** This module
 * installs the interpreter and consumes two of its decisions —
 * `activation: "activate"` (run the focus transfer) and
 * `activation: "deselect"` (clear the active card). The preservation behaviors
 * that used to be spelled out here — Cmd-click on a pane does not activate, a
 * background close-box click does not activate, primary button only, deferred
 * activation for a gesture that starts on draggable content, the post-drag
 * pointer-stream resync — are all classification, and live in the interpreter
 * with the rest of the pointer stream.
 *
 * **Pointer→click z-index ordering.** Classification runs synchronously in
 * capture phase and `store.activateCard` mutates synchronously;
 * `useSyncExternalStore` forces a sync re-render for external-store updates
 * outside a React event handler, so the browser's pointer→click sequence for
 * clicks on interactive elements in background panes is preserved.
 *
 * Tuglaws:
 *   - **L03** — `useLayoutEffect` for event-dependent registration, so the
 *     interpreter's listeners are installed before paint (and before the
 *     provider's consumers, which this effect's position in the tree
 *     guarantees).
 *   - **L06** — pane focus is appearance state; lives in the DOM.
 *   - **L07** — `applyFocusRef` holds the latest closure so the reactive apply
 *     reads current state at event-time, not from a stale mount-time closure.
 *   - **L10** — controller owns exactly one responsibility: pane focus
 *     authority.
 *   - **L11** — pane activation is DeckManager-owned state mutation.
 *   - **L22** — store observation drives direct DOM mutation, no round-trip
 *     through React state.
 *   - **L23** — pane activation and the deselect visual are user-observable
 *     state, preserved across the refactor.
 *
 * @module components/chrome/pane-focus-controller
 */

import { useLayoutEffect, useRef } from "react";
import { useStoreDerived } from "@/lib/use-store-derived";
import type { DeckState } from "@/layout-tree";

import { useDeckManager } from "@/deck-manager-context";
import { getFocusManager } from "@/components/tugways/focus-manager";
import { mayDeferCommit, transferFocusForActivation } from "@/focus-transfer";
import { installGestureInterpreter } from "@/gesture-interpreter";
import { SHOWN_PANE_FRAMES } from "./space-layer";

function applyPaneFocus(root: HTMLElement | null, activePaneId: string | null): void {
  if (root === null) return;
  for (const pane of root.querySelectorAll<HTMLElement>(SHOWN_PANE_FRAMES)) {
    pane.dataset.focused = pane.dataset.paneId === activePaneId ? "true" : "false";
  }
}

/**
 * What the focus controller's effects read: the active pane, the pane set
 * (a newly mounted frame needs its `data-focused` written), and the hidden
 * arrivals whose reveal lands the keyboard. A commit that moves none of them
 * runs no effect here.
 */
interface FocusFacts {
  activePaneId: string | null;
  paneKey: string;
  arriving: DeckState["arriving"];
}

function focusFacts(snapshot: DeckState | null): FocusFacts {
  return {
    activePaneId: snapshot?.activePaneId ?? null,
    paneKey: snapshot === null ? "" : snapshot.panes.map((p) => p.id).join("\u0000"),
    arriving: snapshot?.arriving,
  };
}

function focusFactsEqual(a: FocusFacts, b: FocusFacts): boolean {
  return a.activePaneId === b.activePaneId && a.paneKey === b.paneKey && a.arriving === b.arriving;
}

export function usePaneFocusController(
  deckRootRef: React.RefObject<HTMLDivElement | null>,
): void {
  const store = useDeckManager();
  const { activePaneId, paneKey, arriving } = useStoreDerived(store, focusFacts, focusFactsEqual);

  // `applyFocusRef.current` is rewritten on every render so it closes over the
  // current `activePaneId`. The reactive useLayoutEffect calls
  // `applyFocusRef.current()` and always sees the latest snapshot without
  // participating in the effect dep array.
  //
  // The active pane's title bar is its only selection signal: a deselect clears
  // `activePaneId` in the store, so every pane drops to `data-focused="false"`
  // here.
  const applyFocusRef = useRef<() => void>(() => {});
  applyFocusRef.current = () => {
    applyPaneFocus(deckRootRef.current, activePaneId);
  };

  // Reactive apply: runs after each React commit when the snapshot changes.
  // Handles pane add / remove, activation, and deselect.
  useLayoutEffect(() => {
    applyFocusRef.current();
  }, [activePaneId, paneKey, deckRootRef]);

  // Immediate apply: the commit's own task, read from the store rather than
  // the rendered snapshot. A pane-chrome press defers React's commit past the
  // next paint (`mayDeferCommit`), and the pane it activates is on screen
  // already, so its title bar lights in the press's own frame ([L22]). The
  // reactive apply above still runs for the panes the commit mounts.
  useLayoutEffect(() => {
    const apply = (): void => {
      applyPaneFocus(deckRootRef.current, store.getSnapshot().activePaneId ?? null);
    };
    return store.subscribeSync?.(apply, "pane-focus") ?? (() => {});
  }, [store, deckRootRef]);

  // The keyboard lands when a hidden arrival is revealed.
  //
  // A pane that arrives HIDDEN carries `visibility: hidden` for the length of
  // its mark, and a hidden element is not being rendered, so it cannot take
  // DOM focus: a card whose content seeds its own key view while the mark
  // stands — the Session picker does, the moment its sheet mounts — records
  // the stop and finds `el.focus()` a no-op. The ring is engine state and
  // paints at the reveal while `document.activeElement` is still wherever the
  // gesture left it, which is a ringed surface the keys do not reach.
  //
  // So the mark coming off is when the keyboard is landed. `focusKeyView`
  // re-derives the route from the current key view and skips the move when
  // `activeElement` is already the stop, and it is gated on the active
  // context — so a reveal that changed nothing, and a reader who moved to
  // another card while the newcomer was hidden, both cost nothing.
  //
  // This reads the store through the rendered snapshot and writes the DOM
  // from a layout effect, which is the round-trip [L22] warns against for
  // store-driven DOM writes. It is the right shape HERE and the exception is
  // the reason [L22] gives: the DOM state this write depends on — the frame's
  // `visibility` — is itself React-rendered from the same snapshot, so a
  // direct store observer would fire before the frame can take focus. The
  // write has to follow React's commit, and a layout effect is the one
  // place that is guaranteed to ([L03]).
  const arrivingRef = useRef(arriving);
  useLayoutEffect(() => {
    const previous = arrivingRef.current;
    arrivingRef.current = arriving;
    if (previous === undefined || previous === arriving) return;
    const revealed = Object.keys(previous).some(
      (paneId) => arriving?.[paneId] !== true,
    );
    if (revealed) getFocusManager()?.focusKeyView();
  }, [arriving]);

  // Install the gesture interpreter and consume its activation/deselect
  // decisions. This effect owns the registration slot the interpreter needs:
  // it runs in `deck-canvas.tsx`, a child of `ResponderChainProvider`, so these
  // listeners register — and therefore fire — before the provider's consumers
  // read `currentGesture()`.
  useLayoutEffect(() => {
    return installGestureInterpreter({
      deckRoot: () => deckRootRef.current,
      store,
      // The save → commit → resolve → gate → focus sequence for pane-chrome
      // activation. Safe on the already-active card id: `_flipFirstResponder`'s
      // same-bit branch short-circuits the will/didActivate events, and the
      // reactive effect above restores `data-focused="true"` — which is how a
      // click back onto the only pane leaves a deselected deck.
      //
      // `reveal: false`: this is the POINTER's activation, and the hand is
      // already on the card it named. A strip reveal here would slide an
      // overflowing rail or column under the press, carrying the title bar
      // out from under a mouse that is still holding it.
      activate: ({ outgoingCardId, incomingCardId }) => {
        transferFocusForActivation({
          outgoingCardId,
          incomingCardId,
          store,
          commitMutation: () => store.activateCard(incomingCardId, { reveal: false }),
          deferCommit: mayDeferCommit(store, incomingCardId),
        });
      },
      // The click's other half: a release that travelled nowhere is when the
      // hand has let go, and the card it clicked may come fully into view.
      reveal: (cardId) => {
        store.revealCard(cardId);
      },
      // Clear the active card so no pane is the first responder; the store
      // notify repaints every title bar through the reactive effect above.
      deselect: () => {
        store.deselectActiveCard();
      },
    });
  }, [store, deckRootRef]);
}
