/**
 * ArcBindErrorNoticeController — projects a refused dash binding onto a pane
 * bulletin.
 *
 * `/dash <name>` sends a `bind_dash` CONTROL frame and raises no optimistic
 * state, so a success shows itself (the chip appears, the lane fronts) and a
 * refusal shows nothing at all. This zero-render controller mounts inside the
 * card's `TugPaneBulletinProvider`, subscribes straight to
 * {@link arcBindErrorStore} ([L22] — a bulletin is a direct DOM update, so it
 * must not round-trip through `useSyncExternalStore`/render), and posts one
 * caution carrying the server's reason.
 *
 * The subscription registers in `useLayoutEffect` ([L03]); no notice state
 * enters React state ([L02]); appearance is the bulletin's own CSS/DOM ([L06]).
 */

import { useLayoutEffect, useRef } from "react";

import { arcBindErrorStore } from "@/lib/arc-bind-error-store";

import { useTugPaneBulletin } from "../tug-pane-bulletin";

const NOTICE_ID = "dash-bind-error";

export function ArcBindErrorNoticeController({
  tugSessionId,
}: {
  /** The session whose bind refusals this notice reports on. */
  tugSessionId: string;
}): null {
  const api = useTugPaneBulletin();
  // The last refusal posted, by sequence. Local data ([L24]) — never React
  // state. Keyed on the sequence rather than the reason so two identical
  // refusals in a row still notify: the second one is a second attempt.
  const postedSeqRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const apply = (): void => {
      const error = arcBindErrorStore.errorFor(tugSessionId);
      if (error === null) {
        if (postedSeqRef.current !== null) {
          postedSeqRef.current = null;
          api.dismiss(NOTICE_ID);
        }
        return;
      }
      if (error.seq === postedSeqRef.current) return;
      postedSeqRef.current = error.seq;
      api.caution("Couldn't work that arc", {
        id: NOTICE_ID,
        description: error.reason,
      });
    };
    apply();
    return arcBindErrorStore.subscribe(apply);
  }, [api, tugSessionId]);

  return null;
}
