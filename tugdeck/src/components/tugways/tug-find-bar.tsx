/**
 * `TugFindBar` — the deck's find face: one bar, mounted by any card that has
 * something to search.
 *
 * The bar composes the shared pieces — {@link TugEntryShell} (the entry panel
 * + toolbar shell), a {@link TugTextEditor} CM6 substrate as the query field,
 * and one trailing group holding the shared {@link TugFindCluster} (the count
 * badge, then Case / Word / Grep) beside the ↑ / ↓ pair (outlined "Find
 * previous" beside filled "Find next"), led by a ghost ✕. It docks immediately
 * above the host's status bar; ⌘F summons and dismisses it, Escape dismisses,
 * and the ✕ is that same dismissal for a hand already on the mouse.
 *
 * The controls sit at `sm` metrics — a find bar is one line of thin entry
 * field, and a rail of `lg` buttons under it reads as the loudest thing on the
 * card rather than its quietest.
 *
 * Keys: Enter → next, Shift-Enter → previous, Escape → dismiss — a dedicated
 * find field follows the universal find-bar convention. Bound as a
 * `Prec.high` keymap through the substrate's `extensions` seam; the query
 * mirrors out of the CM6 doc via an `updateListener`, so there is no
 * controlled-input round-trip.
 *
 * **The replace row.** A host whose text is editable asks for it with
 * `replace`, and the bar shows it exactly while the session says
 * `canReplace` — so a read-only document never offers a button that does
 * nothing, and the transcript and help bars never show it at all. The row is
 * the shell's accessory row and holds the replacement field alone, wrapping
 * and growing as the query does; Replace and All end the toolbar, after Find
 * next. Return in that field is Replace, Tab moves between the two fields rather
 * than writing a tab, and Escape dismisses the whole bar. The
 * replacement lives in the row's CM6 doc and mirrors into the session the way
 * the query does, and the row seeds from the session's remembered text,
 * selected whole so the next keystroke replaces it.
 *
 * **The host owns the session.** {@link FindSession} construction, its engine
 * delegate, and its lifetime are the host's business — the Text card's
 * session is bar-scoped and cleared on unmount, the Session card's is
 * card-scoped and outlives the bar. The bar reads and drives the session it
 * is handed; it never clears one.
 *
 * Laws: [L02] the surface snapshot is `Object.is`-stable between refreshes;
 * [L06] match painting is engine-owned (CM6 decorations / CSS Custom
 * Highlights), never React state; [L11] the cluster's toggles emit `setValue`
 * and this bar's responder applies it; [L22]-adjacent: the query lives in the
 * CM6 doc, mirrored imperatively.
 *
 * @module components/tugways/tug-find-bar
 */

import "./tug-find-bar.css";

import React, { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

import { TugEntryShell } from "@/components/tugways/tug-entry-shell";
import { FindWrapOverlay } from "@/components/tugways/chrome/find-wrap-overlay";
import { TugFindCluster } from "@/components/tugways/tug-find-cluster";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugActionTooltip } from "@/components/tugways/tug-action-tooltip";
import {
  TugTextEditor,
  type TugTextEditorDelegate,
} from "@/components/tugways/tug-text-editor";
import { useOptionalResponder } from "@/components/tugways/use-responder";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import type { FindSession } from "@/lib/find-session";
import { requestMenuStateRefresh } from "@/lib/host-menu-state";
import {
  advanceKeyViewFocus,
  BASE_FOCUS_MODE,
  getFocusManager,
} from "@/components/tugways/focus-manager";
import { dispatchCommand } from "@/command-dispatch";

/** The bar's Tab stops, in reading order, as offsets from the host's
 *  `focusOrderBase`. The query field leads because it is where ⌘F lands and
 *  what every other control is about; the replacement field follows it while
 *  the replace row shows, so Tab walks field to field, and the toolbar's
 *  controls come after both — Replace and All last, where they sit. */
const FIND_STOP_QUERY = 0;
const FIND_STOP_REPLACEMENT = 1;
/** The toolbar's three, without the replace row; one later with it. */
const FIND_STOP_OPTIONS = 1;
const FIND_STOP_PREVIOUS = 2;
const FIND_STOP_NEXT = 3;
const FIND_STOP_REPLACE = 5;
const FIND_STOP_REPLACE_ALL = 6;

/**
 * How many consecutive orders the bar claims from `focusOrderBase`: four
 * without the replace row, seven with it. A host's census reserves the
 * larger number where its bar can show the row, so the row's stops never
 * land on an order the host's next control owns.
 */
export function findBarStopCount(withReplaceRow: boolean): number {
  return withReplaceRow ? FIND_STOP_REPLACE_ALL + 1 : FIND_STOP_NEXT + 1;
}

/**
 * Tab in a query field with no second field to move to: what ⌥⇥ then Tab
 * does. The cycle action engages the host's cycle with the ring on the stop
 * the caret is in — the query's own — and the shared advance performer then
 * takes the step from there. Engaging first is what puts the step in the
 * card's cycle rather than the page's base walk, which a card's stops are not
 * in; with a cycle already up, the step is taken in it directly.
 */
function stepOutOfQuery(direction: 1 | -1): void {
  const manager = getFocusManager();
  if (manager !== null && manager.currentFocusMode() === BASE_FOCUS_MODE) {
    dispatchCommand(TUG_ACTIONS.CYCLE_FOCUS_MODE);
  }
  advanceKeyViewFocus(getFocusManager(), direction);
}

export interface TugFindBarProps {
  /** The host's find session — the bar drives it, the host owns it. */
  session: FindSession;
  /** Dismiss gesture (Escape). The host closes the bar. */
  onClose: () => void;
  /**
   * The card's root element — the shared {@link FindWrapOverlay}'s
   * containment box (the wrap graphic anchors to the card).
   */
  cardRootRef: React.RefObject<HTMLElement | null>;
  /** Query-field placeholder, which doubles as its accessible name. */
  placeholder: string;
  /** Host class on the bar root, alongside the shared `tug-find-bar`. */
  className?: string;
  /** `data-slot` on the bar root (defaults to `"tug-find-bar"`). */
  dataSlot?: string;
  /** `data-testid` on the query field. */
  inputTestId?: string;
  /**
   * Seeds the query field at mount and selects it whole, so reopening the
   * bar resumes the previous search and the next keystroke replaces it —
   * the standard macOS find behavior. Hosts whose session dies with the bar
   * (the Text card) pass nothing.
   */
  initialQuery?: string;
  /**
   * Authors the bar's four controls — query field, option group, Previous,
   * Next — into the host's Tab walk ([P02]), at `focusOrderBase + 0…3`. A find
   * bar is a surface a keyboard user has to be able to *work*, not just type
   * into: the option toggles change what the query means and the ↑ / ↓ pair is
   * the gesture Return duplicates. Omitted by hosts that have not authored a
   * walk for it, which leaves the controls plain pointer targets.
   */
  focusGroup?: string;
  /** First of the four consecutive orders in {@link focusGroup}. Defaults to 0. */
  focusOrderBase?: number;
  /**
   * Ask for the replace row. It shows while this is true AND the session
   * reports `canReplace`; a host over read-only text never passes it.
   */
  replace?: boolean;
  /** `data-testid` on the replacement field. */
  replacementTestId?: string;
}

/** Imperative surface the host drives: ⌘F on an already-open bar must put
 *  the caret back in the query field, unconditionally; and a find navigation
 *  performed OUTSIDE the bar refreshes the count badge through
 *  `refreshCount`. */
export interface TugFindBarHandle {
  focusQuery(): void;
  /**
   * Replace the query with `query`, select it whole, and take the caret —
   * ⌘E's landing on an ALREADY-OPEN bar (a bar summoned by ⌘E seeds the same
   * text through `initialQuery` at mount, which is the identical gesture one
   * render earlier). The write goes through the CM6 doc rather than the
   * session, because the doc is the query's only home once the bar is up: the
   * substrate's `updateListener` is what mirrors it into the session and runs
   * the search.
   */
  setQuery(query: string): void;
  refreshCount(): void;
  /**
   * Whether the keyboard is currently inside the bar — the caret in the query
   * field, or the engine's key view on one of its controls (which parks
   * `document.activeElement` on the key sink OUTSIDE the bar, so containment
   * alone cannot answer this). The host asks before dismissing: a bar that
   * holds the keyboard owes it somewhere to land.
   */
  holdsKeyboard(): boolean;
  /**
   * Whether the bar is showing its replace row — the gate a host reads for
   * Replace (⌥⌘G) and Replace All (⌥⇧⌘G) when the caret is outside the
   * bar. Deliberately not "is there a match": a press with nothing to
   * replace still arrives and is refused on the count chip ([L31]).
   */
  replaceShown(): boolean;
  /** Replace the active match and step on — ⌥⌘G answered by the host. */
  replaceNext(): void;
  /** Replace every match — ⌥⇧⌘G answered by the host. */
  replaceAll(): void;
  /**
   * Step the bar's session to the next / previous match — ⌘G / ⇧⌘G answered
   * by a host whose caret is in the text this bar searches, outside the bar.
   */
  findNext(): void;
  findPrevious(): void;
}

export const TugFindBar = React.forwardRef<TugFindBarHandle, TugFindBarProps>(
  function TugFindBar(
    {
      session,
      onClose,
      cardRootRef,
      placeholder,
      className,
      dataSlot = "tug-find-bar",
      inputTestId,
      initialQuery,
      focusGroup,
      focusOrderBase = 0,
      replace = false,
      replacementTestId,
    }: TugFindBarProps,
    ref,
  ): React.ReactElement {
    const barResponderId = React.useId();
    const substrateRef = useRef<TugTextEditorDelegate | null>(null);
    // The replace row's field, so Tab in the query can hand it the caret.
    // Null while the row is not showing, which is what makes Tab a no-op then.
    const replacementFieldRef = useRef<TugTextEditorDelegate | null>(null);
    const barRootRef = useRef<HTMLDivElement | null>(null);

    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    // Whether the row shows is structure — it mounts a field and three Tab
    // stops — so it is read from the session's store ([L02]), never derived
    // from the engine directly.
    const canReplace = useSyncExternalStore(
      session.subscribe,
      () => session.getSnapshot().canReplace,
    );
    const replaceRowShown = replace && canReplace;
    // Read by the responder's gate and the host's handle at dispatch time,
    // so it is the value of the latest render rather than a closure's.
    const replaceRowShownRef = useRef(replaceRowShown);
    replaceRowShownRef.current = replaceRowShown;
    // Replace and Replace All are gated on the row, and nothing in the chain
    // sees it come and go — a read-only flip of the text moves it with no
    // focus or registration change — so the bar republishes the menu state
    // whenever it moves. Each republish waits a microtask, past the rest of
    // the commit, so the host's ref to this bar is attached (or, at unmount,
    // nulled) before the host's gate is read.
    useLayoutEffect(() => {
      queueMicrotask(requestMenuStateRefresh);
    }, [replaceRowShown]);
    useLayoutEffect(
      () => () => {
        queueMicrotask(requestMenuStateRefresh);
      },
      [],
    );
    // Replace and All act on a match, so with no query or a zero count they
    // render disabled — the visible reason a press would do nothing ([L31]).
    // Read from the same store as `canReplace` ([L02]).
    const hasReplaceable = useSyncExternalStore(session.subscribe, () => {
      const snap = session.getSnapshot();
      return snap.hasQuery && snap.count > 0;
    });
    // The replacement field takes the stop after the query, so the toolbar's
    // stops move down one while it shows and the span stays consecutive.
    const toolbarStopShift = replaceRowShown ? 1 : 0;

    // The seed is a mount-time value, not a live prop: once the bar is open
    // the CM6 doc is the query's only home.
    const initialQueryRef = useRef(initialQuery ?? "");

    // Substrate extensions — captured at mount (the substrate's `extensions`
    // contract), so every callback reads through stable refs. `Prec.high`
    // puts the find keys ahead of the substrate's own Enter handling.
    const findBarExtensions = useMemo(
      () => [
        Prec.high(
          keymap.of([
            {
              key: "Enter",
              run: () => {
                session.next();
                return true;
              },
            },
            {
              key: "Shift-Enter",
              run: () => {
                session.previous();
                return true;
              },
            },
            {
              key: "Escape",
              run: () => {
                onCloseRef.current();
                return true;
              },
            },
            // Tab moves between the bar's two fields and never writes a tab:
            // a find query is not indented. With no replace row there is no
            // other field, so Tab does what ⌥⇥ then Tab does: it engages the
            // host's cycle at the query's own stop and steps to the next (the
            // options group), and ⇧Tab steps back. The key is never dead
            // ([L31]).
            {
              key: "Tab",
              run: () => {
                const replacement = replacementFieldRef.current;
                if (replacement !== null) replacement.focus();
                else stepOutOfQuery(1);
                return true;
              },
            },
            {
              key: "Shift-Tab",
              run: () => {
                const replacement = replacementFieldRef.current;
                if (replacement !== null) replacement.focus();
                else stepOutOfQuery(-1);
                return true;
              },
            },
          ]),
        ),
        // The query is the CM6 doc — mirror every edit into the session
        // (search-as-you-type; the engine selects + reveals the first result).
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          session.setQuery(update.state.doc.toString());
        }),
      ],
      [session],
    );

    // Write the query doc whole and select what was written, so the next
    // keystroke replaces it. The only writer besides the user's own typing:
    // the mount seed and ⌘E's re-seed both land here, and both are mirrored
    // into the session by the `updateListener` above.
    const writeQuery = React.useCallback((text: string) => {
      const view = substrateRef.current?.view() ?? null;
      if (view === null) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: 0, head: text.length },
      });
    }, []);

    // Summoned: seed the remembered query (selected whole, so typing replaces
    // it) and take the caret. The `updateListener` above mirrors the seeded
    // doc into the session, which re-runs the search. ⌘F on an already-open
    // bar re-summons through the same imperative seam.
    useEffect(() => {
      const seed = initialQueryRef.current;
      if (seed.length > 0) writeQuery(seed);
      substrateRef.current?.focus();
    }, [writeQuery]);
    React.useImperativeHandle(
      ref,
      (): TugFindBarHandle => ({
        focusQuery: () => {
          substrateRef.current?.focus();
        },
        setQuery: (query: string) => {
          writeQuery(query);
          substrateRef.current?.focus();
        },
        refreshCount: () => {
          session.refresh();
        },
        holdsKeyboard: () => {
          const root = barRootRef.current;
          if (root === null) return false;
          // Two registers, because the engine uses two ([P01]): a caret in the
          // query field is real DOM focus (`dom-granted`), while a ring on the
          // options or the ↑ / ↓ pair is `engine-routed` and parks
          // `activeElement` on the key sink outside the bar — for those the
          // projected `data-key-view` mark is the only local evidence.
          return (
            root.contains(document.activeElement) ||
            root.querySelector("[data-key-view]") !== null
          );
        },
        replaceShown: () => replaceRowShownRef.current,
        replaceNext: () => {
          session.replaceNext();
        },
        replaceAll: () => {
          session.replaceAll();
        },
        findNext: () => {
          session.next();
        },
        findPrevious: () => {
          session.previous();
        },
      }),
      [session, writeQuery],
    );

    // The bar is the responder for find NAVIGATION while it is open: with the
    // caret in the query field, ⌘G / ⇧⌘G walk field → bar and land here (the
    // host's own handlers are a sibling branch the walk from the field can
    // never reach). The bar drives the search session (query, options, count)
    // — it is the responder for the actions that mutate it ([L11]).
    const { ResponderScope, responderRef } = useOptionalResponder({
      id: barResponderId,
      actions: {
        // No `FIND` handler here on purpose. ⌘F toggles the bar, and a
        // toggle that declined to fire from inside the thing it toggles
        // would be unreachable by the obvious gesture — ⌘F lands the caret
        // in this field, so the second press is always "from inside". The
        // host's handler is the only one, and it dismisses.
        [TUG_ACTIONS.FIND_NEXT]: () => {
          session.next();
        },
        [TUG_ACTIONS.FIND_PREVIOUS]: () => {
          session.previous();
        },
        // ⌥⌘G / ⌥⇧⌘G with the caret in the bar. With nothing to replace the
        // session refuses on the count chip, so the press is never silent.
        [TUG_ACTIONS.FIND_REPLACE_NEXT]: () => {
          session.replaceNext();
        },
        [TUG_ACTIONS.FIND_REPLACE_ALL]: () => {
          session.replaceAll();
        },
        // Escape after a CLICK on one of the bar's controls. The query
        // field's own `Prec.high` keymap covers the caret, and a host whose
        // Tab order reached these controls owns Escape at that point (the
        // session card's focus cycle ascends out of itself) — what is left is
        // the pointer path, where the chain has promoted to this bar and
        // nothing else would answer.
        [TUG_ACTIONS.CANCEL_DIALOG]: () => {
          onCloseRef.current();
        },
      },
      // Replace is live only while the row shows: a bar over read-only text
      // has nothing to replace into.
      validateAction: (action) => {
        if (
          action === TUG_ACTIONS.FIND_REPLACE_NEXT ||
          action === TUG_ACTIONS.FIND_REPLACE_ALL
        ) {
          return replaceRowShownRef.current;
        }
        return true;
      },
    });

    // One callback into the responder registration and the local root ref,
    // which `holdsKeyboard` reads to answer "is the keyboard in here?".
    const shellRef = React.useCallback(
      (el: HTMLDivElement | null) => {
        barRootRef.current = el;
        (responderRef as (node: HTMLDivElement | null) => void)(el);
      },
      [responderRef],
    );

    return (
      <ResponderScope>
        <TugEntryShell
          ref={shellRef}
          className={className ? `tug-find-bar ${className}` : "tug-find-bar"}
          data-slot={dataSlot}
          accessoryRow={
            replaceRowShown ? (
              <FindReplaceField
                fieldRef={replacementFieldRef}
                queryRef={substrateRef}
                session={session}
                onCloseRef={onCloseRef}
                testId={replacementTestId}
                focusGroup={focusGroup}
                focusOrderBase={focusOrderBase}
              />
            ) : undefined
          }
          statusRow={
            // Dismissal sits in the bar's top-right corner, out of the
            // toolbar entirely: in the trailing group it read as a fourth
            // navigation button. It takes no cycle stop — Escape and ⌘F are
            // the keyboard's two dismissals already, and a fifth stop here
            // would push every host's find span into the orders its status
            // strip owns. Ghost, so the one control that ends the search is
            // also the quietest.
            <div
              className="tugx-find-dismiss"
              data-slot="find-dismiss"
              // Same refusal the shell's toolbar row carries: clicking the ✕
              // must not pull first-responder off the host's editor on its
              // way to dismissing the bar. Ancestor-matched, so the button
              // inherits it. [L11]
              data-tug-focus="refuse"
            >
              <TugActionTooltip
                // Escape's own command — the chord the tooltip shows for this
                // button is the one that does the same thing without it.
                action={TUG_ACTIONS.CANCEL_DIALOG}
                content="Close the find bar"
              >
                <TugPushButton
                  subtype="icon"
                  size="sm"
                  emphasis="ghost"
                  role="action"
                  onClick={() => onCloseRef.current()}
                  aria-label="Close find bar"
                  icon={<X size={16} strokeWidth={2.5} />}
                />
              </TugActionTooltip>
            </div>
          }
          toolbarTrailing={
            <>
              {/* Everything about the search reads as one trailing group:
                  what the search found, what it is searching FOR, and the
                  two buttons that walk it. Centring the cluster instead put
                  a card's width of empty toolbar between the count and the
                  ↑/↓ pair that changes it. */}
              <TugFindCluster
                surface={session}
                focusGroup={focusGroup}
                focusOrder={focusOrderBase + FIND_STOP_OPTIONS + toolbarStopShift}
              />
              <TugActionTooltip
                action={TUG_ACTIONS.FIND_PREVIOUS}
                content="Go to the previous match"
              >
                <TugPushButton
                  subtype="icon"
                  size="sm"
                  // Outlined, not filled: Previous is the secondary of the
                  // Next/Previous pair — the filled button is "next" (the
                  // Return gesture's twin), this outlined one is "previous".
                  emphasis="outlined"
                  role="action"
                  onClick={() => session.previous()}
                  aria-label="Find previous"
                  icon={<ChevronUp size={16} strokeWidth={2.5} />}
                  focusGroup={focusGroup}
                  focusOrder={focusOrderBase + FIND_STOP_PREVIOUS + toolbarStopShift}
                />
              </TugActionTooltip>
              <TugActionTooltip
                action={TUG_ACTIONS.FIND_NEXT}
                content="Go to the next match"
              >
                <TugPushButton
                  subtype="icon"
                  size="sm"
                  emphasis="filled"
                  role="action"
                  // Return in the query field IS this button, so it wears the
                  // shell's default ring — and gives the fill back the moment the
                  // caret leaves for the composer, whose submit is Return's home
                  // there.
                  data-tug-entry-default=""
                  onClick={() => session.next()}
                  aria-label="Find next"
                  icon={<ChevronDown size={16} strokeWidth={2.5} />}
                  focusGroup={focusGroup}
                  focusOrder={focusOrderBase + FIND_STOP_NEXT + toolbarStopShift}
                />
              </TugActionTooltip>
              {replaceRowShown ? (
                // Replace and All end the toolbar, past every control the bar
                // always has: they act on what the search found, so they
                // follow the controls that find it.
                <>
                  <TugActionTooltip
                    action={TUG_ACTIONS.FIND_REPLACE_NEXT}
                    content="Replace this match and go to the next"
                  >
                    <TugPushButton
                      size="sm"
                      emphasis="outlined"
                      role="action"
                      onClick={() => session.replaceNext()}
                      disabled={!hasReplaceable}
                      data-testid="find-replace-next"
                      focusGroup={focusGroup}
                      focusOrder={focusOrderBase + FIND_STOP_REPLACE}
                    >
                      Replace
                    </TugPushButton>
                  </TugActionTooltip>
                  <TugActionTooltip
                    action={TUG_ACTIONS.FIND_REPLACE_ALL}
                    content="Replace every match"
                  >
                    <TugPushButton
                      size="sm"
                      emphasis="outlined"
                      role="action"
                      onClick={() => session.replaceAll()}
                      disabled={!hasReplaceable}
                      aria-label="Replace all"
                      data-testid="find-replace-all"
                      focusGroup={focusGroup}
                      focusOrder={focusOrderBase + FIND_STOP_REPLACE_ALL}
                    >
                      All
                    </TugPushButton>
                  </TugActionTooltip>
                </>
              ) : null}
            </>
          }
        >
          <TugTextEditor
            ref={substrateRef}
            borderless
            // A query is prose, not code: it soft-wraps and the field grows
            // with it, the same bargain the composer strikes. A find field
            // that scrolled sideways would hide the very text you are
            // checking against the results.
            lineWrap
            maxRows={8}
            placeholder={placeholder}
            aria-label={placeholder}
            data-testid={inputTestId}
            /* The host owns its card-state-preservation slot; a transient
               find field must not stash editor state into the card bag. */
            preserveState={false}
            /* And it must not churn the card's engine-hooks set either:
               registering hooks on mount re-fires the card's `applyBagFocus`
               restore, which replays the SAVED focus target — yanking the
               caret ⌘F just placed here back to the card's editor. */
            suppressCardEngineHooks
            focusGroup={focusGroup}
            focusOrder={focusOrderBase + FIND_STOP_QUERY}
            extensions={findBarExtensions}
          />
        </TugEntryShell>
        <FindWrapOverlay findSession={session} cardRef={cardRootRef} />
      </ResponderScope>
    );
  },
);

interface FindReplaceFieldProps {
  /** Filled with the field's delegate, so the query's Tab can reach it. */
  fieldRef: React.RefObject<TugTextEditorDelegate | null>;
  /** The query field, which this field's Tab hands the caret back to. */
  queryRef: React.RefObject<TugTextEditorDelegate | null>;
  session: FindSession;
  onCloseRef: React.RefObject<() => void>;
  testId?: string;
  focusGroup?: string;
  focusOrderBase: number;
}

/**
 * The bar's second row: the replacement field, whose Replace and All buttons
 * end the toolbar below it. Mounted only while the bar shows it, so it seeds
 * from the session's remembered replacement each time the row appears.
 */
function FindReplaceField({
  fieldRef,
  queryRef,
  session,
  onCloseRef,
  testId,
  focusGroup,
  focusOrderBase,
}: FindReplaceFieldProps): React.ReactElement {
  const extensions = useMemo(
    () => [
      // Return is Replace. It has to be claimed in a keydown handler above the
      // substrate's own: that handler runs before any keymap and hands a plain
      // Return to the shell's default button, which in this bar is Find next.
      // Stopping propagation also keeps the chain's default-button activation
      // from pressing that button a second way.
      Prec.highest(
        EditorView.domEventHandlers({
          keydown(event) {
            if (event.key !== "Enter") return false;
            if (event.metaKey || event.ctrlKey || event.altKey) return false;
            event.preventDefault();
            event.stopPropagation();
            // A Shift-Enter newline is not taken either: a newline in the
            // replacement is written `\n`, as a tab is written `\t`.
            if (!event.shiftKey) session.replaceNext();
            return true;
          },
        }),
      ),
      Prec.high(
        keymap.of([
          {
            key: "Escape",
            run: () => {
              onCloseRef.current();
              return true;
            },
          },
          // Tab and Shift-Tab hand the caret back to the query: the bar's two
          // fields are one pair, and neither ever writes a tab.
          {
            key: "Tab",
            run: () => {
              queryRef.current?.focus();
              return true;
            },
          },
          {
            key: "Shift-Tab",
            run: () => {
              queryRef.current?.focus();
              return true;
            },
          },
        ]),
      ),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        session.setReplacement(update.state.doc.toString());
      }),
    ],
    [session, onCloseRef, queryRef],
  );

  // Seed the remembered replacement, selected whole, as the query seeds. The
  // write mirrors back through the listener as the same text — a no-op.
  useEffect(() => {
    const text = session.getSnapshot().replacement;
    const view = fieldRef.current?.view() ?? null;
    if (view === null || text === "") return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0, head: text.length },
    });
  }, [session, fieldRef]);

  return (
    <div className="tugx-find-replace-row" data-slot="find-replace-row">
      <TugTextEditor
        ref={fieldRef}
        borderless
        // Wraps and grows like the query field above it, so a long
        // replacement is read whole rather than scrolled.
        lineWrap
        maxRows={8}
        placeholder="Replace with"
        aria-label="Replace with"
        data-testid={testId}
        preserveState={false}
        suppressCardEngineHooks
        focusGroup={focusGroup}
        focusOrder={focusOrderBase + FIND_STOP_REPLACEMENT}
        extensions={extensions}
      />
    </div>
  );
}
