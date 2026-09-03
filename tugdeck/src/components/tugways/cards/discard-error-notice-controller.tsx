/**
 * DiscardErrorNoticeController — projects a refused discard onto a pane
 * bulletin ([L31]).
 *
 * `changeset_discard_err` settles into the verb store's discard state and was
 * read by nothing: the transcript receipts read discard state for the *done*
 * case only, so a Discard press that the server refused left the row where it
 * was and said nothing. Discard sits beside Join on the same arc row and
 * fails for the same kinds of reason — a dirty worktree, a base that moved —
 * so a silent one is the same investigation over again.
 *
 * Zero render, like its landing siblings: a direct store subscription ([L22]),
 * registered in `useLayoutEffect` ([L03]), posted record in a ref ([L24]),
 * nothing in React state ([L02]).
 */

import { useLayoutEffect, useRef } from "react";

import { getChangesetVerbStore } from "@/lib/changeset-verb-store";

import { useTugPaneBulletin } from "../tug-pane-bulletin";

const NOTICE_ID = "discard-error";

export function DiscardErrorNoticeController({
  entryKey,
}: {
  /** The changeset entry whose discard refusals this notice reports on. */
  entryKey: string;
}): null {
  const api = useTugPaneBulletin();
  // The detail on screen right now. Local data ([L24]) — never React state.
  const postedRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const store = getChangesetVerbStore();
    if (store === null) return;
    const apply = (): void => {
      const detail = store.discardState(entryKey).error;
      if (detail === postedRef.current) return;
      postedRef.current = detail;
      if (detail === null) {
        api.dismiss(NOTICE_ID);
      } else {
        api.danger("Discard failed", { id: NOTICE_ID, description: detail, sticky: true });
      }
    };
    apply();
    return store.subscribe(apply);
  }, [api, entryKey]);

  return null;
}
