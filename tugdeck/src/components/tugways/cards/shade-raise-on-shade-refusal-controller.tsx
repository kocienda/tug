/**
 * ShadeRaiseOnShadeRefusalController — brings the Changes shade back when a
 * refusal's only seat is inside it ([P06]).
 *
 * The shade's notice band is the one surface a refused claim or disclaim speaks
 * on, and a band that is unmounted says nothing — which is [L31]'s failure, the
 * dead button, with the sentence sitting unread in a store. So a fresh error
 * raises the shade, and the raise is narrower than "the chords can fire with
 * the shade down", because that is not the window the code leaves open:
 *
 * - The chords cannot fire with no landing up. `tug-prompt-entry.tsx` registers
 *   ⌃⌘A and ⌃⇧⌘A only while a landing is active, and closing the Changes shade
 *   exits the landing, which takes them down with it.
 * - But a landing being active is not the same as Changes being the *presented*
 *   shade. The shade is a single slot, so `show("history")` swaps Changes out
 *   while the landing stands — chords live, band unmounted.
 * - And the card's `CLAIM_ALL_CHANGES` / `DISCLAIM_ALL_CHANGES` handlers carry
 *   no landing gate at all, so any dispatch reaching the first-responder walk
 *   performs the verb, chord or not.
 *
 * That is the window, and `show("changes")` closes it: idempotent when Changes
 * is already presented, a swap back from History when it is not.
 *
 * The landing modes need no help here and get none. `CommitModeController` and
 * `JoinModeController` each watch the verb store and call their own `enter()` on
 * a non-`done` phase while inactive — "bring it (and the shade) back so the
 * error surfaces where the user acted" — and the card's `anyLandingActive`
 * effect raises Changes off that. Discard and Auto-Message are not raised for
 * either: both are pressed from surfaces of their own, and neither has a chord
 * that can fire while this band is unmounted.
 *
 * Zero render, like the bulletin controllers it stands in for: a direct store
 * subscription ([L22] — a shade raise is a DOM act, not a render), registered in
 * `useLayoutEffect` ([L03]), last-seen detail per verb in a ref ([L24]), nothing
 * in React state ([L02]).
 */

import { useLayoutEffect, useRef } from "react";

import { getChangesetVerbStore } from "@/lib/changeset-verb-store";

export function ShadeRaiseOnShadeRefusalController({
  entryKey,
  onRaise,
}: {
  /** The card entry whose claim/disclaim round trips this watches. */
  entryKey: string;
  /** Present the Changes shade. Called only on a fresh error. */
  onRaise: () => void;
}): null {
  // Last-seen detail per verb. Local data ([L24]) — never React state.
  const seenRef = useRef<{ claim: string | null; disclaim: string | null }>({
    claim: null,
    disclaim: null,
  });

  useLayoutEffect(() => {
    const store = getChangesetVerbStore();
    if (store === null) return;

    // The first read seeds the refs without raising: an error already standing
    // when this mounts is one the band is about to render anyway, and raising
    // for it would make a remount of the card re-present a shade the user had
    // closed over a refusal they have already read.
    let seeded = false;
    const apply = (): void => {
      const seen = seenRef.current;
      const claim = store.claimState(entryKey).error;
      const disclaim = store.disclaimState(entryKey).error;
      // Fresh means a detail that is there now and was not there before, under
      // this same text. A success and a pending both clear to null, which is a
      // change in the other direction and raises nothing.
      const fresh =
        (claim !== null && claim !== seen.claim) ||
        (disclaim !== null && disclaim !== seen.disclaim);
      seen.claim = claim;
      seen.disclaim = disclaim;
      if (seeded && fresh) onRaise();
      seeded = true;
    };

    apply();
    return store.subscribe(apply);
  }, [entryKey, onRaise]);

  return null;
}
