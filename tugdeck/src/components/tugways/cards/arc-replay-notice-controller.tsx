/**
 * ArcReplayNoticeController — projects a replay's outcome onto a pane
 * bulletin.
 *
 * No replay outcome shows itself on an arc row: the row's line carries the
 * arc's own standing, not the checkout's git bookkeeping. So the bulletin is
 * the whole answer — `current` had nothing to do, `deferred` failed a
 * precondition, `conflicted` stopped at a round without touching the branch,
 * and `replayed`/`recorded` moved the rounds. Without a voice the verb would
 * read as a dead button — the failure this arc has already paid for once.
 *
 * This zero-render controller mounts inside the card's
 * `TugPaneBulletinProvider`, subscribes straight to
 * {@link arcReplayOutcomeStore} ([L22] — a bulletin is a direct DOM update, so
 * it must not round-trip through `useSyncExternalStore`/render), and says what
 * the server said. A success speaks in the plain tone; only a refusal or a
 * stopped replay is a caution.
 *
 * The subscription registers in `useLayoutEffect` ([L03]); no notice state
 * enters React state ([L02]); appearance is the bulletin's own CSS/DOM ([L06]).
 *
 * ## It is the Arcs card's reader, not the store's only one
 *
 * A replay pressed *in the Changes shade* is answered inside the shade, by its
 * own notice band ([B01]) — this lane sits in the transcript region the shade's
 * scrim dims, so a bulletin posted there would be the dimmed corner notice the
 * whole arc removed. One store holds one outcome per session and both surfaces
 * read that slot, so `shadeEntryKey` is how they divide it: an outcome carrying
 * it belongs to the shade, and this controller ignores it and dismisses whatever
 * it had posted. The division is on the stamp rather than on presented state,
 * because a shade that happens to be up when an Arcs-card press answers is a
 * coincidence of timing, not an origin ([P01]).
 *
 * The two readers are not mounted alike, and that asymmetry is the reason the
 * stamp has to exist rather than being belt-and-braces. `session-card.tsx`
 * mounts this controller only when `boundSessionId !== null`, while the band
 * reads `changesController.tugSessionId`, which a card has whether or not it is
 * bound. So on an unbound card the band is the slot's **only** reader, and
 * without the stamp it would claim an Arcs-card press as its own. When the card
 * *is* bound the two ids are the same session — verified: `boundSessionId` is
 * the card's bound tug session id and `ChangesRouteController.tugSessionId` is
 * the id that same card registered its workspace under.
 */

import { useLayoutEffect, useRef } from "react";

import {
  arcReplayOutcomeStore,
  conflictDescription,
} from "@/lib/arc-replay-outcome-store";

import { useTugPaneBulletin } from "../tug-pane-bulletin";

const NOTICE_ID = "arc-replay-outcome";

export function ArcReplayNoticeController({
  tugSessionId,
  shadeEntryKey,
}: {
  /** The session whose replay outcomes this notice reports on. */
  tugSessionId: string;
  /**
   * The Changes shade's own changeset entry key. An outcome stamped with it was
   * pressed in the shade and is the band's to say, never this lane's.
   */
  shadeEntryKey: string;
}): null {
  const api = useTugPaneBulletin();
  // The last outcome posted, by sequence. Local data ([L24]) — never React
  // state. Keyed on the sequence rather than the words so two identical
  // outcomes in a row both speak: the second one is a second press.
  const postedSeqRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const apply = (): void => {
      const outcome = arcReplayOutcomeStore.outcomeFor(tugSessionId);
      if (outcome === null) {
        if (postedSeqRef.current !== null) {
          postedSeqRef.current = null;
          api.dismiss(NOTICE_ID);
        }
        return;
      }
      if (outcome.seq === postedSeqRef.current) return;
      // A shade press is not this lane's. The skipped seq is still recorded:
      // without it every store notification re-enters this arm and the dismiss
      // fires again forever.
      if (outcome.entryKey === shadeEntryKey) {
        postedSeqRef.current = outcome.seq;
        api.dismiss(NOTICE_ID);
        return;
      }
      postedSeqRef.current = outcome.seq;
      switch (outcome.outcome) {
        case "current":
          api(`${outcome.arc} is already current with its base`, {
            id: NOTICE_ID,
          });
          return;
        case "deferred":
          api.caution("Couldn't replay that arc", {
            id: NOTICE_ID,
            description: outcome.detail ?? undefined,
          });
          return;
        case "conflicted":
          api.caution(`${outcome.arc} can't replay cleanly`, {
            id: NOTICE_ID,
            description: conflictDescription(outcome),
          });
          return;
        case "error":
          api.caution("Couldn't replay that arc", {
            id: NOTICE_ID,
            description: outcome.detail ?? undefined,
          });
          return;
        case "replayed":
          api(`${outcome.arc} replayed onto its base`, { id: NOTICE_ID });
          return;
        case "recorded":
          api(`${outcome.arc}'s rebase is recorded`, { id: NOTICE_ID });
          return;
        default:
          return;
      }
    };
    apply();
    return arcReplayOutcomeStore.subscribe(apply);
  }, [api, tugSessionId, shadeEntryKey]);

  return null;
}
