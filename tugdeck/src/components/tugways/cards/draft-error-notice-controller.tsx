/**
 * DraftErrorNoticeController — projects a refused Auto-Message onto a pane
 * bulletin ([L31]).
 *
 * `changeset_draft_state { state: "error" }` settles into the draft store's
 * overlay, and the composer reads it only on the edge *out of* `drafting`: a
 * generation that streamed and then failed reverts the field, which is the
 * whole of the surface. A request that never reached a scribe at all never
 * enters `drafting`, so it went from idle straight to error and the composer's
 * edge never fired — the Auto-Message button simply did nothing, forever, with
 * the error sitting in the store unread. That is the failure this notice is
 * for: the card says the scribe was not reached instead of looking idle.
 *
 * Addressed by {@link ChangesRouteController.requestOwnerId}, the same
 * derivation the request went out under, because the server stamps its answer
 * with the owner it was asked about. Both stores are subscribed: the draft
 * store for the overlay, and the changes controller because the owner it
 * derives moves when the line's seat does.
 *
 * Zero render, like its landing siblings: direct store subscriptions ([L22]),
 * registered in `useLayoutEffect` ([L03]), posted record in a ref ([L24]),
 * nothing in React state ([L02]).
 */

import { useLayoutEffect, useRef } from "react";

import type { ChangesRouteController } from "@/lib/changes-route-controller";
import { getChangesetDraftStore } from "@/lib/changeset-draft-store";

import { useTugPaneBulletin } from "../tug-pane-bulletin";

const NOTICE_ID = "draft-error";

export function DraftErrorNoticeController({
  changesController,
}: {
  /** The card whose Auto-Message refusals this notice reports on. */
  changesController: ChangesRouteController;
}): null {
  const api = useTugPaneBulletin();
  // The detail on screen right now. Local data ([L24]) — never React state.
  const postedRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const store = getChangesetDraftStore();
    if (store === null) return;
    const apply = (): void => {
      const overlay = store.overlay(
        changesController.workspaceKey,
        changesController.draftOwnerKind,
        changesController.requestOwnerId(),
      );
      const detail = overlay.phase === "error" ? overlay.detail : null;
      if (detail === postedRef.current) return;
      postedRef.current = detail;
      if (detail === null) {
        api.dismiss(NOTICE_ID);
      } else {
        api.danger("Auto-Message failed", {
          id: NOTICE_ID,
          description: detail,
          sticky: true,
        });
      }
    };
    apply();
    const unsubscribeDraft = store.subscribe(apply);
    const unsubscribeChanges = changesController.subscribe(apply);
    return () => {
      unsubscribeDraft();
      unsubscribeChanges();
    };
  }, [api, changesController]);

  return null;
}
