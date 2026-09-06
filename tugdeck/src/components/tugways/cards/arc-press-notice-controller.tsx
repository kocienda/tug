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
 * The subscription registers in `useLayoutEffect` ([L03]); no notice state
 * enters React state ([L02]); appearance is the bulletin's own CSS/DOM ([L06]).
 */

import { useLayoutEffect, useRef } from "react";

import { arcPressStore } from "@/lib/arc-press-store";

import { useTugPaneBulletin } from "../tug-pane-bulletin";

export function ArcPressNoticeController({
  tugSessionId,
}: {
  /** The session whose transport refusals this notice reports on. */
  tugSessionId: string;
}): null {
  const api = useTugPaneBulletin();
  // The last refusal posted, by sequence. Local data ([L24]) — never React
  // state. Keyed on the sequence rather than the reason so two identical
  // refusals in a row still notify: the second one is a second press.
  const postedSeqRef = useRef<number | null>(null);
  // The id of the notice actually posted, which carries the refused verb —
  // so a dismissal takes down the notice that is up rather than a sibling's.
  const postedIdRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const apply = (): void => {
      const refusal = arcPressStore.refusalFor(tugSessionId);
      if (refusal === null) {
        if (postedIdRef.current !== null) {
          const id = postedIdRef.current;
          postedSeqRef.current = null;
          postedIdRef.current = null;
          api.dismiss(id);
        }
        return;
      }
      if (refusal.seq === postedSeqRef.current) return;
      postedSeqRef.current = refusal.seq;
      const id = `arc-press-${refusal.verb}`;
      postedIdRef.current = id;
      api.caution(`Couldn't ${refusal.verb} ${refusal.arc}`, {
        id,
        description: refusal.reason,
      });
    };
    apply();
    return arcPressStore.subscribe(apply);
  }, [api, tugSessionId]);

  return null;
}
