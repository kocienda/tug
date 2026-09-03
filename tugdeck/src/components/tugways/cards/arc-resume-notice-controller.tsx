/**
 * ArcResumeNoticeController — projects a refused resume onto a pane bulletin.
 *
 * Pressing **Resume** in a stop receipt sends an `arc_resume` CONTROL frame
 * and raises no optimistic state, so a success shows itself — the arc is
 * seated, the chip appears, and the wheel opens the stage it stopped in — and
 * a refusal shows nothing at all. Without a voice the button would read as a
 * dead one, which is the failure the arc verbs have already paid for once.
 *
 * This zero-render controller mounts inside the card's
 * `TugPaneBulletinProvider`, subscribes straight to {@link arcResumeStore}
 * ([L22] — a bulletin is a direct DOM update, so it must not round-trip
 * through `useSyncExternalStore`/render), and posts one caution carrying the
 * server's reason. Success needs no bulletin: the stage opening on this card
 * is the answer.
 *
 * The subscription registers in `useLayoutEffect` ([L03]); no notice state
 * enters React state ([L02]); appearance is the bulletin's own CSS/DOM ([L06]).
 */

import { useLayoutEffect, useRef } from "react";

import { arcResumeStore } from "@/lib/arc-resume-store";

import { useTugPaneBulletin } from "../tug-pane-bulletin";

const NOTICE_ID = "arc-resume-error";

export function ArcResumeNoticeController({
  tugSessionId,
}: {
  /** The session whose resume refusals this notice reports on. */
  tugSessionId: string;
}): null {
  const api = useTugPaneBulletin();
  // The last refusal posted, by sequence. Local data ([L24]) — never React
  // state. Keyed on the sequence rather than the reason so two identical
  // refusals in a row still notify: the second one is a second press.
  const postedSeqRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const apply = (): void => {
      const refusal = arcResumeStore.refusalFor(tugSessionId);
      if (refusal === null) {
        if (postedSeqRef.current !== null) {
          postedSeqRef.current = null;
          api.dismiss(NOTICE_ID);
        }
        return;
      }
      if (refusal.seq === postedSeqRef.current) return;
      postedSeqRef.current = refusal.seq;
      api.caution(`Couldn't resume ${refusal.arc}`, {
        id: NOTICE_ID,
        description: refusal.reason,
      });
    };
    apply();
    return arcResumeStore.subscribe(apply);
  }, [api, tugSessionId]);

  return null;
}
