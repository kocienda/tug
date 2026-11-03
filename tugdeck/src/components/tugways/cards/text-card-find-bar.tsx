/**
 * `TextCardFindBar` — the Text card's bottom-docked find bar.
 *
 * The bar itself is the shared {@link TugFindBar}; this wrapper supplies the
 * two things that are genuinely the Text card's own: the {@link FindSession}
 * and the CM6 engine behind it.
 *
 * One find CONTROLLER across the deck: the wrapper instantiates the shared
 * {@link FindSession} (query, options, wrap bookkeeping, the cluster face)
 * and hands it the editor's own engine — the shared CM6 engine every editable
 * surface finds through (`editor-find-engine.ts`), which is
 * virtualization-proof because CM6 works off the document. Options
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
import {
  readFindOptions,
  putFindOptions,
  readFindReplacement,
  putFindReplacement,
} from "@/settings-api";
import { FindSession, type FindEngineDelegate } from "@/lib/find-session";
import type { TugTextCardEditorDelegate } from "@/components/tugways/tug-text-card-editor";

/**
 * The Text card's find engine: the editor's shared CM6 engine, resolved at
 * each call rather than captured, so a bar that stays up while the editor
 * remounts finds through the live one. The engine owns the landing rule, the
 * count, the ring and the trace; the session owns everything else.
 */
function documentFindEngine(
  getDelegate: () => TugTextCardEditorDelegate | null,
): FindEngineDelegate {
  const engine = () => getDelegate()?.findEngine() ?? null;
  return {
    searchDidChange: (query, opts) => engine()?.searchDidChange?.(query, opts),
    findNext: () => engine()?.findNext?.(),
    findPrevious: () => engine()?.findPrevious?.(),
    matchInfo: () =>
      engine()?.matchInfo?.() ?? { count: 0, activeOrdinal: null, capped: false },
    clear: () => engine()?.clear?.(),
    replaceNext: (replacement) => engine()?.replaceNext?.(replacement),
    replaceAll: (replacement) => engine()?.replaceAll?.(replacement),
    isWritable: () => engine()?.isWritable?.() ?? false,
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
  /**
   * Show the replace row (⌥⌘F asked for it). It appears only while the
   * document is also writable — the session's `canReplace`.
   */
  replace?: boolean;
  /**
   * The document's read-only state. Pushed state, so the bar re-reads its
   * replace capability whenever it moves and the row cannot go stale.
   */
  readOnly?: boolean;
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
    replace = false,
    readOnly = false,
  }: TextCardFindBarProps,
  ref,
): React.ReactElement {
  const getDelegateRef = useRef(getDelegate);
  getDelegateRef.current = getDelegate;

  const sessionRef = useRef<FindSession | null>(null);
  if (sessionRef.current === null) {
    const client = getTugbankClient();
    const seeded = client ? readFindOptions(client) : null;
    const session = new FindSession(
      seeded ?? undefined,
      {
        onOptionsChanged: putFindOptions,
        onReplacementChanged: putFindReplacement,
      },
      client ? readFindReplacement(client) : "",
    );
    session.setDelegate(documentFindEngine(() => getDelegateRef.current()));
    sessionRef.current = session;
  }
  const session = sessionRef.current;
  useEffect(() => () => session.clear(), [session]);
  // The editor reconfigures its read-only facet in a layout effect, so by
  // this passive effect the engine reads the new state.
  useEffect(() => {
    session.refresh();
  }, [session, readOnly]);

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
      replace={replace}
      replacementTestId="text-card-replace-input"
    />
  );
});
