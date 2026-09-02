/**
 * ArcReplayNoticeController — projects a replay's outcome onto a pane
 * bulletin.
 *
 * No replay outcome shows itself on a dash row: the row's line carries the
 * dash's own standing, not the checkout's git bookkeeping. So the bulletin is
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
 */

import { useLayoutEffect, useRef } from "react";

import {
  arcReplayOutcomeStore,
  type ArcReplayOutcome,
} from "@/lib/arc-replay-outcome-store";

import { useTugPaneBulletin } from "../tug-pane-bulletin";

const NOTICE_ID = "dash-replay-outcome";

/** The conflicting paths, as a sentence rather than a list nobody can read. */
function conflictDescription(outcome: ArcReplayOutcome): string {
  const round =
    outcome.roundSubject !== null && outcome.roundSubject.length > 0
      ? `Round “${outcome.roundSubject}” conflicts with the moved base`
      : "A round conflicts with the moved base";
  if (outcome.paths.length === 0) return `${round}. Nothing was touched.`;
  const shown = outcome.paths.slice(0, 3).join(", ");
  const rest = outcome.paths.length - 3;
  const paths = rest > 0 ? `${shown}, and ${rest} more` : shown;
  return `${round}: ${paths}. Nothing was touched.`;
}

export function ArcReplayNoticeController({
  tugSessionId,
}: {
  /** The session whose replay outcomes this notice reports on. */
  tugSessionId: string;
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
      postedSeqRef.current = outcome.seq;
      switch (outcome.outcome) {
        case "current":
          api(`${outcome.dash} is already current with its base`, {
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
          api.caution(`${outcome.dash} can't replay cleanly`, {
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
          api(`${outcome.dash} replayed onto its base`, { id: NOTICE_ID });
          return;
        case "recorded":
          api(`${outcome.dash}'s rebase is recorded`, { id: NOTICE_ID });
          return;
        default:
          return;
      }
    };
    apply();
    return arcReplayOutcomeStore.subscribe(apply);
  }, [api, tugSessionId]);

  return null;
}
