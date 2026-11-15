/**
 * `TextCardFindBar` — the Text card's bottom-docked find bar.
 *
 * The bar itself is the shared {@link TugFindBar}; this wrapper supplies the
 * two things that are genuinely the Text card's own: the {@link FindSession}
 * and the CM6 engine behind it.
 *
 * One find CONTROLLER across the deck: the wrapper instantiates the shared
 * {@link FindSession} (query, options, wrap bookkeeping, the cluster face)
 * and hands it the engine the card names. Over the editor that is the
 * editor's own — the shared CM6 engine every editable surface finds through
 * (`editor-find-engine.ts`), which is virtualization-proof because CM6 works
 * off the document. Over the card's Markdown preview it is a read-only engine
 * over the rendered text, and the session follows the card from one to the
 * other with its query standing. Options
 * seed from the GLOBAL find preference and persist back through the session's
 * `onOptionsChanged` hook (`putFindOptions`) — identical wiring to the
 * Session card. The engine watches the editor's view, so the count and the
 * replace row follow every edit and every read-only change while the bar is
 * open.
 *
 * The session's lifetime is the bar's here: it is created on mount and
 * cleared on unmount, so dismissing the bar ends the search. The editor's
 * engine is attached to it directly: the editor and the bar mount and unmount
 * together in the card's ready state, so the engine outlives every bar that
 * searches through it and there is nothing to forward. A change of engine
 * under an open bar clears the one being left and replays the standing query
 * into the one arriving.
 *
 * @module components/tugways/cards/text-card-find-bar
 */

import React, { useLayoutEffect, useRef } from "react";

import {
  TugFindBar,
  useFindBarHost,
  type TugFindBarHandle,
} from "@/components/tugways/tug-find-bar";
import { createFindSession } from "@/lib/create-find-session";
import type { FindEngineDelegate, FindSession } from "@/lib/find-session";

export interface TextCardFindBarProps {
  /**
   * Resolve the engine the bar searches through (null while there is none).
   * Read when the bar mounts and again whenever {@link engineKey} changes.
   */
  getEngine: () => FindEngineDelegate | null;
  /**
   * Names the engine {@link getEngine} currently answers with. A new value
   * moves the session onto the new engine.
   */
  engineKey: string | number;
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
}

/** The Text card drives the shared bar's imperative surface directly. */
export type TextCardFindBarHandle = TugFindBarHandle;

export const TextCardFindBar = React.forwardRef<
  TextCardFindBarHandle,
  TextCardFindBarProps
>(function TextCardFindBar(
  {
    getEngine,
    engineKey,
    initialQuery,
    onClose,
    cardRootRef,
    focusGroup,
    focusOrderBase,
    replace = false,
  }: TextCardFindBarProps,
  ref,
): React.ReactElement {
  const getEngineRef = useRef(getEngine);
  getEngineRef.current = getEngine;

  const sessionRef = useRef<FindSession | null>(null);
  if (sessionRef.current === null) {
    sessionRef.current = createFindSession({ replace: true });
  }
  const session = sessionRef.current;
  // Attached in a layout effect, where the editor's ref is already set even
  // when the two mount in one commit; a query the bar seeds first is replayed
  // into the engine as it attaches. Dismissing the bar ends the search and
  // releases the engine, which stops watching the editor for this session.
  // The engine being left is cleared, so its match paint does not outlive the
  // search that moved on.
  useLayoutEffect(() => {
    const engine = getEngineRef.current();
    session.setDelegate(engine);
    return () => engine?.clear?.();
  }, [session, engineKey]);
  useLayoutEffect(() => {
    return () => {
      session.clear();
      session.setDelegate(null);
    };
  }, [session]);

  // The bar's dismissal arrives as `close-find` ([L11]); this wrapper hands
  // it to its host's `onClose`.
  const FindBarHost = useFindBarHost(onClose);

  return (
    <FindBarHost>
    <TugFindBar
      ref={ref}
      session={session}
      cardRootRef={cardRootRef}
      initialQuery={initialQuery}
      placeholder="Find in file"
      className="text-card-find-bar"
      data-slot="text-card-find-bar"
      inputTestId="text-card-find-input"
      focusGroup={focusGroup}
      focusOrderBase={focusOrderBase}
      replace={replace}
      replacementTestId="text-card-replace-input"
    />
    </FindBarHost>
  );
});
