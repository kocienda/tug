/**
 * `TextCardFindBar` — the Text card's bottom-docked find bar.
 *
 * The bar itself is the shared {@link TugFindBar}; this wrapper supplies the
 * two things that are genuinely the Text card's own: the {@link FindSession}
 * and the CM6 engine behind it.
 *
 * One find CONTROLLER across the deck: the wrapper instantiates the shared
 * {@link FindSession} (query, options, wrap bookkeeping, the cluster face)
 * and supplies the Text card's {@link FindEngineDelegate} — a thin object
 * over the editor's own CodeMirror search (`TugTextCardEditorDelegate`),
 * which is virtualization-proof because CM6 works off the document. Options
 * seed from the GLOBAL find preference and persist back through the session's
 * `onOptionsChanged` hook (`putFindOptions`) — identical wiring to the
 * Session card. (Parity note: the count refreshes on find actions, not on
 * document edits made while the bar is open.)
 *
 * The session's lifetime is the bar's here: it is created on mount and
 * cleared on unmount, so dismissing the bar ends the search.
 *
 * @module components/tugways/cards/text-card-find-bar
 */

import React, { useEffect, useRef } from "react";

import {
  TugFindBar,
  type TugFindBarHandle,
} from "@/components/tugways/tug-find-bar";
import { getTugbankClient } from "@/lib/tugbank-singleton";
import { readFindOptions, putFindOptions } from "@/settings-api";
import { FindSession, type FindEngineDelegate } from "@/lib/find-session";
import {
  findTrace,
  inferFindGesture,
  type FindGestureSnapshot,
} from "@/lib/find-trace";
import type { TugTextCardEditorDelegate } from "@/components/tugways/tug-text-card-editor";

/**
 * The Text card's find engine: CM6 search behind the shared
 * {@link FindEngineDelegate} protocol. Search-as-you-type lands on the
 * first result AT OR AFTER the reader's anchor — the scrollport's top line
 * for ⌘F, the selection itself for ⌘E — wrapping to the document's first
 * match when there is none, and scrolling only when the landing is not
 * already on screen; the session owns everything else.
 */
function documentFindEngine(
  getDelegate: () => TugTextCardEditorDelegate | null,
): FindEngineDelegate {
  // The trace's own view of this surface. CM6 owns the document and the
  // selection, so there is no index/DOM pair to diverge and no reveal to
  // outlive its budget — a Text card contributes `gesture` events only, and
  // they are what a walk over a large file is checked against. `navSeq`
  // counts this engine's own gestures: the session's own counter is not
  // handed to the delegate, and a per-engine count answers the one question
  // the trace asks of it (which press produced which landing).
  let navSeq = 0;
  let prev: FindGestureSnapshot | null = null;
  const recordGesture = (
    query: string,
    caseSensitive: boolean,
    wholeWord: boolean,
    grep: boolean,
  ): void => {
    const info = getDelegate()?.getMatchInfo() ?? {
      count: 0,
      activeOrdinal: null,
      capped: false,
    };
    const snap: FindGestureSnapshot = {
      query,
      caseSensitive,
      wholeWord,
      grep,
      activeOrdinal: info.activeOrdinal,
      count: info.count,
    };
    navSeq += 1;
    findTrace.record({
      kind: "gesture",
      surface: "text",
      cardId: null,
      gesture: inferFindGesture(prev, snap),
      navSeq,
      query,
      count: info.count,
      activeOrdinal: info.activeOrdinal,
      // A Text card match lives in the editor's document, not at a
      // `(row, segment)` the transcript's coordinates can name.
      target: null,
    });
    prev = snap;
  };
  return {
    searchDidChange: (query, opts) => {
      const delegate = getDelegate();
      if (delegate === null) return;
      delegate.setSearchQuery({
        search: query,
        caseSensitive: opts.caseSensitive,
        regexp: opts.grep,
        wholeWord: opts.wholeWord,
      });
      if (query.length > 0) delegate.selectMatchFromAnchor();
      recordGesture(query, opts.caseSensitive, opts.wholeWord, opts.grep);
    },
    findNext: () => {
      getDelegate()?.findNext();
      if (prev !== null) {
        recordGesture(prev.query, prev.caseSensitive, prev.wholeWord, prev.grep);
      }
    },
    findPrevious: () => {
      getDelegate()?.findPrevious();
      if (prev !== null) {
        recordGesture(prev.query, prev.caseSensitive, prev.wholeWord, prev.grep);
      }
    },
    matchInfo: () =>
      getDelegate()?.getMatchInfo() ?? {
        count: 0,
        activeOrdinal: null,
        capped: false,
      },
    clear: () => {
      getDelegate()?.clearSearch();
      prev = null;
    },
  };
}

export interface TextCardFindBarProps {
  /** Resolve the live editor delegate (null while unmounted). */
  getDelegate: () => TugTextCardEditorDelegate | null;
  /**
   * Seeds the query field at mount, selected whole. Empty for a plain ⌘F —
   * this card's session dies with the bar, so there is no remembered query;
   * ⌘E is the one gesture that opens the bar already knowing what to search
   * for.
   */
  initialQuery?: string;
  /** Dismiss gesture (Escape). The host clears the search + refocuses. */
  onClose: () => void;
  /**
   * The card's root element — the shared find-wrap overlay's containment box
   * (the wrap graphic anchors to the card).
   */
  cardRootRef: React.RefObject<HTMLElement | null>;
  /**
   * Register the bar's stops in the card's cycle group, so the bar takes its
   * seat in the card's one Tab order rather than opening a walk of its own
   * ([P10]) — the same wiring the Session card's bar uses.
   */
  focusGroup?: string;
  /** First of the bar's consecutive stop orders. */
  focusOrderBase?: number;
}

/** The Text card drives the shared bar's imperative surface directly. */
export type TextCardFindBarHandle = TugFindBarHandle;

export const TextCardFindBar = React.forwardRef<
  TextCardFindBarHandle,
  TextCardFindBarProps
>(function TextCardFindBar(
  {
    getDelegate,
    initialQuery,
    onClose,
    cardRootRef,
    focusGroup,
    focusOrderBase,
  }: TextCardFindBarProps,
  ref,
): React.ReactElement {
  const getDelegateRef = useRef(getDelegate);
  getDelegateRef.current = getDelegate;

  const sessionRef = useRef<FindSession | null>(null);
  if (sessionRef.current === null) {
    const client = getTugbankClient();
    const seeded = client ? readFindOptions(client) : null;
    const session = new FindSession(seeded ?? undefined, {
      onOptionsChanged: putFindOptions,
    });
    session.setDelegate(documentFindEngine(() => getDelegateRef.current()));
    sessionRef.current = session;
  }
  const session = sessionRef.current;
  useEffect(() => () => session.clear(), [session]);

  return (
    <TugFindBar
      ref={ref}
      session={session}
      onClose={onClose}
      cardRootRef={cardRootRef}
      initialQuery={initialQuery}
      placeholder="Find in file"
      className="text-card-find-bar"
      dataSlot="text-card-find-bar"
      inputTestId="text-card-find-input"
      focusGroup={focusGroup}
      focusOrderBase={focusOrderBase}
    />
  );
});
