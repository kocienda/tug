/**
 * trip-card-controller.tsx — opens a Session card on a trip that is running,
 * without taking the user's view ([P08]).
 *
 * A trip is an ordinary Tug session with hands, and the deck is where sessions
 * are seen. What was missing was somebody to open the card: the engine seats
 * the session and writes its id onto the trip row the moment it has one, and
 * until now nothing on the deck acted on that. This is that somebody — a
 * headless component that watches the roster it is already subscribed to and
 * dispatches the resume the user would otherwise have to perform by hand.
 *
 * **Off the roster feed rather than a new wire frame.** The roster already
 * carries `open_session` for exactly this purpose, is already pushed on every
 * settle, and a deck that is not connected misses nothing it could have acted
 * on. It also carries `open_session_dir` — the arc worktree the session is
 * standing in — because an effect walking a frame of rows cannot ask the
 * citation store for a project dir: that store is a one-id React hook whose
 * answer arrives asynchronously and which exposes no imperative read.
 *
 * **It never takes the key view.** The dispatch names no origin and passes
 * `activate: false`, which suppresses the first-responder flip, the focused-
 * card write, and — the one that matters most — the reveal that would scroll
 * the band to the new card ([B03]). The card is flashed rather than raised,
 * and with no slot named it takes whichever slot the band is showing.
 *
 * @module components/tripwires/trip-card-controller
 */

import React from "react";
import { getRegistryHandler } from "@/action-dispatch";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { cardIdForSession } from "@/lib/card-session-binding-store";
import { getTripwiresStore } from "@/lib/tripwires-store";

/**
 * Which trip sessions this deck has already carded.
 *
 * Module-scoped and deliberately not React state ([L02], [#state-zone-mapping]):
 * no render reads it, and a `useState` here would publish a notification per
 * arrival that changes nothing on screen. It is a dedupe over *dispatches*, not
 * a record of what is open — {@link cardIdForSession} is the record, and is
 * consulted beside this on every row.
 *
 * Both are needed. The binding store answers "is a card holding this now", and
 * lags the dispatch by the round trip the restore takes; without the set, every
 * roster frame inside that window would open another card for the same session.
 * Without the binding store, a card the user closed and a session a card
 * already held from some other gesture would both be got wrong.
 */
const dispatched = new Set<string>();

/** Test-only: forget which sessions have been carded. */
export function _resetTripCardsForTest(): void {
  dispatched.clear();
}

/**
 * Watch the roster and open a card on each running trip's session.
 *
 * `useLayoutEffect` rather than `useEffect`, because the subscription is a
 * registration events depend on ([L03]): a roster frame that landed between
 * render and a passive effect would be missed, and the store publishes on the
 * frame rather than on a timer.
 */
export function TripCardController(): null {
  React.useLayoutEffect(() => {
    const store = getTripwiresStore();
    const sweep = () => {
      const resume = getRegistryHandler(TUG_ACTIONS.RESUME_SESSION);
      if (resume === undefined) return;
      for (const tripwire of store.getSnapshot().tripwires) {
        if (!tripwire.running) continue;
        const sessionId = tripwire.open_session;
        const projectDir = tripwire.open_session_dir;
        if (sessionId === null || projectDir === null) continue;
        if (projectDir.length === 0) continue;
        if (dispatched.has(sessionId)) continue;
        if (cardIdForSession(sessionId) !== null) continue;
        // Recorded before the dispatch, not after: the restore can land a
        // binding inside the same tick, and a second frame arriving in
        // between would otherwise open a second card on one session.
        dispatched.add(sessionId);
        resume({ sessionId, projectDir, activate: false });
      }
    };
    // Once for the frame that is already in hand — the store holds what the
    // last frame said, and a trip that started before this card was opened is
    // exactly the one a reader wants a card on.
    sweep();
    return store.subscribe(sweep);
  }, []);
  return null;
}
