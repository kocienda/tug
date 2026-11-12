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
 * The sequence gate is {@link useSequencedBulletin}'s: keyed on the sequence
 * rather than the words, so two identical outcomes in a row both speak — the
 * second one is a second press.
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

import {
  arcReplayOutcomeStore,
  conflictDescription,
} from "@/lib/arc-replay-outcome-store";

import { useSequencedBulletin } from "./use-sequenced-bulletin";

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
  useSequencedBulletin(
    {
      read: () => arcReplayOutcomeStore.outcomeFor(tugSessionId),
      subscribe: (listener) => arcReplayOutcomeStore.subscribe(listener),
    },
    (outcome, api) => {
      // A shade press is not this lane's: passed over, which records its
      // sequence (so the next notification does not re-enter this arm) and
      // takes down whatever this lane had up.
      if (outcome.entryKey === shadeEntryKey) return null;
      switch (outcome.outcome) {
        case "current":
          api(`${outcome.arc} is already current with its base`, {
            id: NOTICE_ID,
          });
          return NOTICE_ID;
        case "deferred":
          api.caution("Couldn't replay that arc", {
            id: NOTICE_ID,
            description: outcome.detail ?? undefined,
          });
          return NOTICE_ID;
        case "conflicted":
          api.caution(`${outcome.arc} can't replay cleanly`, {
            id: NOTICE_ID,
            description: conflictDescription(outcome),
          });
          return NOTICE_ID;
        case "error":
          api.caution("Couldn't replay that arc", {
            id: NOTICE_ID,
            description: outcome.detail ?? undefined,
          });
          return NOTICE_ID;
        case "replayed":
          api(`${outcome.arc} replayed onto its base`, { id: NOTICE_ID });
          return NOTICE_ID;
        case "recorded":
          api(`${outcome.arc}'s rebase is recorded`, { id: NOTICE_ID });
          return NOTICE_ID;
        default:
          return null;
      }
    },
    `${tugSessionId}\u0000${shadeEntryKey}`,
  );
  return null;
}
