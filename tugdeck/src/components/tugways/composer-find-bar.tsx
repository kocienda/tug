/**
 * `ComposerFindBar` — a composer's own find bar, with its replace row.
 *
 * Each composer is its own find surface ([B03]): the Session card's prompt
 * entry and the Overview card's composer each mount one of these, docked
 * under the composer's entry shell, beside — never instead of — any find the
 * card already has. The bar is the shared {@link TugFindBar}; this wrapper
 * supplies the two things that are the composer's own: a {@link FindSession}
 * that lives and dies with the bar, and the shared CM6 engine
 * (`editor-find-engine.ts`) over the composer's view, the same engine the
 * Text card finds through.
 *
 * It is summoned by ⌥⌘F with the caret in the composer, so it always asks for
 * the replace row; the row shows while the composer is writable, which is the
 * session's `canReplace`. The engine watches the composer's view, so the
 * count follows typing and the row follows every read-only cause the
 * composer has, with nothing pushed in from the host.
 *
 * The search anchors at the composer's caret, captured when the bar is
 * created — before its query field takes the keyboard — so the first match is
 * the one at or after where the user was typing.
 *
 * Laws: [L02] the bar reads the session through `useSyncExternalStore`; [L06]
 * match paint is CM6 decorations and the engine's DOM ring; [L07] the view is
 * read through its getter at each call, so a remounted composer is never
 * searched through a stale one.
 *
 * @module components/tugways/composer-find-bar
 */

import React, { useLayoutEffect, useRef } from "react";
import type { EditorView } from "@codemirror/view";

import {
  TugFindBar,
  useFindBarHost,
  type TugFindBarHandle,
} from "@/components/tugways/tug-find-bar";
import {
  createEditorFindEngine,
  type EditorFindEngine,
} from "@/components/tugways/editor-find-engine";
import { createFindSession } from "@/lib/create-find-session";
import type { FindSession } from "@/lib/find-session";

export interface ComposerFindBarProps {
  /** Resolve the composer's live view (null while unmounted). */
  getView: () => EditorView | null;
  /** Dismiss gesture (Escape, ✕). The host unmounts the bar and refocuses. */
  onClose: () => void;
  /** The find-wrap overlay's containment box. */
  cardRootRef: React.RefObject<HTMLElement | null>;
  /** The host's cycle group, so the bar's stops join the card's Tab order. */
  focusGroup?: string;
  /** First of the bar's consecutive stop orders. */
  focusOrderBase?: number;
  dataSlot: string;
  inputTestId: string;
  replacementTestId: string;
}

export type ComposerFindBarHandle = TugFindBarHandle;

export const ComposerFindBar = React.forwardRef<
  ComposerFindBarHandle,
  ComposerFindBarProps
>(function ComposerFindBar(
  {
    getView,
    onClose,
    cardRootRef,
    focusGroup,
    focusOrderBase,
    dataSlot,
    inputTestId,
    replacementTestId,
  }: ComposerFindBarProps,
  ref,
): React.ReactElement {
  const getViewRef = useRef(getView);
  getViewRef.current = getView;

  const engineRef = useRef<EditorFindEngine | null>(null);
  const sessionRef = useRef<FindSession | null>(null);
  if (sessionRef.current === null || engineRef.current === null) {
    const engine = createEditorFindEngine(() => getViewRef.current(), "composer");
    engine.captureFindAnchor("selection");
    const session = createFindSession({ replace: true });
    session.setDelegate(engine);
    engineRef.current = engine;
    sessionRef.current = session;
  }
  const session = sessionRef.current;
  const engine = engineRef.current;
  // Dismissing the bar ends the search: the session clears the composer's
  // match paint, and the engine drops any landing ring still in flight.
  useLayoutEffect(
    () => () => {
      session.clear();
      engine.dispose();
    },
    [session, engine],
  );

  // The bar's dismissal arrives as `close-find` ([L11]); this wrapper hands
  // it to its host's `onClose`.
  const FindBarHost = useFindBarHost(onClose);

  return (
    <FindBarHost>
    <TugFindBar
      ref={ref}
      session={session}
      cardRootRef={cardRootRef}
      placeholder="Find in message"
      className="composer-find-bar"
      data-slot={dataSlot}
      inputTestId={inputTestId}
      focusGroup={focusGroup}
      focusOrderBase={focusOrderBase}
      replace
      replacementTestId={replacementTestId}
    />
    </FindBarHost>
  );
});
