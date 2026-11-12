/**
 * ArcPressNoticeController — projects a refused transport press onto a pane
 * bulletin.
 *
 * Pressing **Start**, **Resume** or **Stop** sends a CONTROL frame and raises
 * no optimistic state, so a success shows itself — the arc is seated or
 * released, the chip follows, and the wheel opens or ends the stage — and a
 * refusal shows nothing at all. Without a voice the button would read as a
 * dead one, which is the failure the arc verbs have already paid for once
 * ([L31]).
 *
 * This zero-render controller mounts inside the card's
 * `TugPaneBulletinProvider`, subscribes straight to {@link arcPressStore}
 * ([L22] — a bulletin is a direct DOM update, so it must not round-trip
 * through `useSyncExternalStore`/render), and posts one caution carrying the
 * server's reason. Success needs no bulletin: the stage opening on this card
 * is the answer.
 *
 * The caution's id carries the verb, so a refused Stop and a refused Start
 * are two notices rather than one overwriting the other.
 *
 * **A refusal goes with its bulletin.** The shell holds the refusal, past
 * this page's life, so when the bulletin closes — the user's ✕, or its own
 * timeout — the refusal it spoke is let go by its sequence. Otherwise the
 * card that reloads or wakes would speak a refusal already read, and a newer
 * refusal that arrived meanwhile is not taken down with the old.
 *
 * The sequence gate is {@link useSequencedBulletin}'s: keyed on the sequence
 * rather than the reason, so two identical refusals in a row still notify —
 * the second one is a second press.
 */

import { arcPressStore, type ArcRefusedVerb } from "@/lib/arc-press-store";

import { useSequencedBulletin } from "./use-sequenced-bulletin";

/** What the notice's title says could not be done, by the verb refused. */
const REFUSED_PHRASE: Record<ArcRefusedVerb, string> = {
  start: "start",
  resume: "resume",
  stop: "stop",
  join: "join",
  changes: "show the changes of",
  diff: "open the diff of",
  bind: "bind",
  unbind: "unbind",
  replay: "replay",
  discard: "discard",
};

export function ArcPressNoticeController({
  tugSessionId,
}: {
  /** The session whose transport refusals this notice reports on. */
  tugSessionId: string;
}): null {
  useSequencedBulletin(
    {
      read: () => arcPressStore.refusalFor(tugSessionId),
      subscribe: (listener) => arcPressStore.subscribe(listener),
    },
    (refusal, api) => {
      // The id carries the refused verb, so the hook's dismissal takes down
      // the notice that is up rather than a sibling's.
      const id = `arc-press-${refusal.verb}`;
      api.caution(`Couldn't ${REFUSED_PHRASE[refusal.verb]} ${refusal.arc}`, {
        id,
        description: refusal.reason,
        onGone: () => arcPressStore.clearRefusal(tugSessionId, refusal.seq),
      });
      return id;
    },
    tugSessionId,
  );
  return null;
}
