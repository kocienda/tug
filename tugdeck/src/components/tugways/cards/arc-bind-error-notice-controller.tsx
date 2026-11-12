/**
 * ArcBindErrorNoticeController — projects a refused arc binding onto a pane
 * bulletin.
 *
 * `/arc <name>` sends a `bind_arc` CONTROL frame and raises no optimistic
 * state, so a success shows itself (the chip appears, the lane fronts) and a
 * refusal shows nothing at all. This zero-render controller mounts inside the
 * card's `TugPaneBulletinProvider`, subscribes straight to
 * {@link arcBindErrorStore} ([L22] — a bulletin is a direct DOM update, so it
 * must not round-trip through `useSyncExternalStore`/render), and posts one
 * caution carrying the server's reason.
 *
 * The sequence gate is {@link useSequencedBulletin}'s: keyed on the sequence
 * rather than the reason, so two identical refusals in a row still notify —
 * the second one is a second attempt.
 */

import { arcBindErrorStore } from "@/lib/arc-bind-error-store";

import { useSequencedBulletin } from "./use-sequenced-bulletin";

const NOTICE_ID = "arc-bind-error";

export function ArcBindErrorNoticeController({
  tugSessionId,
}: {
  /** The session whose bind refusals this notice reports on. */
  tugSessionId: string;
}): null {
  useSequencedBulletin(
    {
      read: () => arcBindErrorStore.errorFor(tugSessionId),
      subscribe: (listener) => arcBindErrorStore.subscribe(listener),
    },
    (error, api) => {
      api.caution("Couldn't work that arc", {
        id: NOTICE_ID,
        description: error.reason,
      });
      return NOTICE_ID;
    },
    tugSessionId,
  );
  return null;
}
