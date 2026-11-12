/**
 * `useSequencedBulletin` — one pane bulletin per new store sequence.
 *
 * The arc notice controllers — a refused transport press, a replay's outcome,
 * a refused bind — each project a store that holds at most one item per
 * session, stamped with a `seq` the store bumps on every new answer, onto a
 * pane bulletin. Each held the same gate: post when the sequence is new, do
 * nothing when it is the one already posted, and dismiss when the item
 * clears. This is that gate once, with the gate itself a pure function,
 * {@link nextBulletinAction}, so it is tested without a pane.
 *
 * It is not `transient-notice.ts`. That reconciler projects a whole snapshot
 * into a *set* of condition-keyed notices and diffs two sets; these post a
 * single notice per sequence and clear it by sequence — a different model,
 * and folding them into the reconcile would mean inventing a set of one.
 *
 * **Keyed on the sequence, not the words**, so two identical answers in a row
 * both speak: the second one is a second press.
 *
 * **`post` says which notice it put up**, by returning its id, so a dismissal
 * takes down the notice that is up rather than a sibling's — the press
 * controller's id carries the refused verb. Returning `null` passes the item
 * over: its sequence is still recorded, so the next notification does not
 * re-enter the same arm forever, and anything this hook had up comes down.
 *
 * The subscription registers in `useLayoutEffect` ([L03]) and talks to the
 * bulletin directly ([L22] — a bulletin is a DOM update, so it must not
 * round-trip through render); the posted sequence and id are refs, never
 * React state ([L24], [L02]); appearance is the bulletin's own ([L06]).
 *
 * @module components/tugways/cards/use-sequenced-bulletin
 */

import { useLayoutEffect, useRef } from "react";

import {
  useTugPaneBulletin,
  type TugPaneBulletinApi,
} from "../tug-pane-bulletin";

/** What a store holds for one session: an answer, stamped by sequence. */
export interface SequencedItem {
  seq: number;
}

/** What the gate says to do with the store's current item. */
export type BulletinAction = "post" | "dismiss" | "none";

/**
 * The sequence gate. A new sequence posts; the sequence already posted does
 * nothing; a cleared item dismisses whatever was posted, and is nothing when
 * nothing was.
 */
export function nextBulletinAction(
  prevSeq: number | null,
  item: SequencedItem | null,
): BulletinAction {
  if (item === null) return prevSeq === null ? "none" : "dismiss";
  return item.seq === prevSeq ? "none" : "post";
}

/** A store the hook reads: the current item, and a change subscription. */
export interface SequencedSource<T extends SequencedItem> {
  /** The current item, or null when there is none. */
  read: () => T | null;
  /** Subscribe to changes; returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void;
}

/**
 * Post `item` through `api` and return the posted notice's id, or `null` to
 * pass the item over.
 */
export type SequencedPost<T extends SequencedItem> = (
  item: T,
  api: TugPaneBulletinApi,
) => string | null;

/**
 * Project a sequenced store onto the enclosing pane's bulletin.
 *
 * `source` and `post` are read through refs at notification time, so callers
 * may build them inline; the subscription is rebuilt when `key` changes —
 * pass whatever names the slot being read (the session id, and anything else
 * the read or the post depends on).
 */
export function useSequencedBulletin<T extends SequencedItem>(
  source: SequencedSource<T>,
  post: SequencedPost<T>,
  key: string,
): void {
  const api = useTugPaneBulletin();
  const postedSeqRef = useRef<number | null>(null);
  const postedIdRef = useRef<string | null>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const postRef = useRef(post);
  postRef.current = post;

  useLayoutEffect(() => {
    const apply = (): void => {
      const item = sourceRef.current.read();
      const action = nextBulletinAction(postedSeqRef.current, item);
      if (action === "none") return;
      const up = postedIdRef.current;
      if (action === "dismiss" || item === null) {
        postedSeqRef.current = null;
        postedIdRef.current = null;
        if (up !== null) api.dismiss(up);
        return;
      }
      postedSeqRef.current = item.seq;
      const id = postRef.current(item, api);
      if (id === null) {
        postedIdRef.current = null;
        if (up !== null) api.dismiss(up);
        return;
      }
      postedIdRef.current = id;
    };
    apply();
    return sourceRef.current.subscribe(apply);
  }, [api, key]);
}
