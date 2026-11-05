/**
 * editor-find-engine — Find over one CodeMirror `EditorView`, behind the
 * shared {@link FindEngineDelegate} protocol.
 *
 * Every editable CM6 surface that hosts the shared find bar searches the same
 * way, so the engine is written once, over a view getter, and each surface
 * hands it its own view. CodeMirror's `@codemirror/search` does the matching
 * (it works off the document, so it is virtualization-proof); this engine adds
 * what the shared bar promises on every surface:
 *
 *  - **the landing rule** — search-as-you-type selects the first match AT OR
 *    AFTER the reader's anchor (the scrollport's top row for ⌘F, the selection
 *    itself for ⌘E), wrapping to the document's first match when there is
 *    none, and scrolls only when that match is not already on screen
 *    (`find-reveal.ts`);
 *  - **the count** — a capped enumeration with the active ordinal, which the
 *    cluster's chip reads;
 *  - **the landing ring** — the shared one-shot accent flash
 *    (`find-flash.ts`) over the match every navigation lands on, plus the
 *    horizontal settle that favours zero horizontal scroll;
 *  - **the trace** — one `gesture` event per find gesture (`find-trace.ts`).
 *
 * Replace rides CodeMirror's own commands. CodeMirror's `replaceNext`
 * replaces the selection only when it is exactly a match, and otherwise just
 * selects the next one, so the engine selects the next match first when none
 * is selected and a press always replaces; `replaceAll` is one transaction.
 * Both carry CodeMirror's `input.replace` user events, so a host's store sees
 * ordinary edits and one ⌘Z undoes one replace gesture. Both refuse a
 * read-only state, and `isWritable` reports that state so the bar can hide
 * its replace row rather than offer a button that does nothing.
 *
 * The view's search extension must be installed (`search({ top: true })`);
 * the engine opens the bundled panel, which the host keeps hidden, because
 * that panel's state field is what the match highlighter paints from.
 *
 * Beside it the view installs {@link findViewObserver}, which is how the
 * engine learns that the editor it searches moved: every document change and
 * every change to `EditorState.readOnly` is reported, and an engine whose
 * session is attached re-reads its count and its writability on the next
 * frame. Nobody pushes writability in from outside; the view's own state is
 * the one truth, and a new host gets it without listing its read-only causes.
 *
 * Laws: [L06] appearance through CM6 decorations and the DOM ring, never React
 * state; [L07] the view is read through its getter at the moment each
 * operation runs, so a remounted editor is never searched through a stale
 * closure; [L27] the observation is a registration that returns its release,
 * released when the session detaches and when the engine is disposed; [L28]
 * writability is read from the view, never re-derived beside it.
 *
 * @module components/tugways/editor-find-engine
 */

import { EditorSelection, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import {
  SearchQuery,
  setSearchQuery,
  getSearchQuery,
  searchPanelOpen,
  openSearchPanel,
  closeSearchPanel,
  findNext as cmFindNext,
  findPrevious as cmFindPrevious,
  replaceNext as cmReplaceNext,
  replaceAll as cmReplaceAll,
} from "@codemirror/search";

import type { FindEngineDelegate, FindMatchInfo } from "@/lib/find-session";
import {
  findTrace,
  inferFindGesture,
  type FindGestureSnapshot,
} from "@/lib/find-trace";
import { placeFindFlash, type FindFlashHandle } from "./find-flash";
import { findRevealFor } from "./find-reveal";
import { scheduleAfterPaint, type CancelAfterPaint } from "@/lib/after-paint";

/**
 * Enumeration cap for `matchInfo` — mirrors the transcript engine's
 * `DEFAULT_MATCH_LIMIT` so a degenerate query over a huge file cannot stall
 * the chip's per-keystroke recount. A capped count renders as `N+`.
 */
export const EDITOR_MATCH_INFO_CAP = 5000;

const NO_MATCHES: FindMatchInfo = { count: 0, activeOrdinal: null, capped: false };

/**
 * The search text a `SearchQuery` is built from, for what the user typed.
 *
 * CodeMirror's query is not `literal`, so it unquotes `\n`, `\r`, `\t` and
 * `\\` in the search text — and it unquotes the replacement under the same
 * flag, which is how a literal-mode replacement expands `\n`. Turning
 * `literal` on would make the query literal and kill the replacement's
 * escapes with it. So in literal mode the query's backslashes are doubled
 * here instead, and the unquote hands the user's text back unchanged: `\n`
 * means the two characters on every surface, as it already does in the
 * transcript and Help. A grep pattern is a regular expression and passes
 * through untouched.
 */
export function editorSearchText(query: string, grep: boolean): string {
  return grep ? query : query.replace(/\\/g, "\\\\");
}

// ── The view observer ──────────────────────────────────────────────────────

/** One engine's interest in the views that report. */
type FindViewListener = (view: object) => void;

const findViewListeners = new Set<FindViewListener>();

/**
 * Say that `view`'s document or writability moved. The observer extension is
 * the only caller in the product; every engine's listener hears it and keeps
 * it only when the view is the one that engine searches.
 */
export function reportFindViewChange(view: object): void {
  for (const listener of [...findViewListeners]) listener(view);
}

/**
 * The extension every searchable editor installs beside `search()`. A view
 * that is constructed reports too: a remounted editor is a new view behind
 * the same getter, and the engine searching through it owes a re-read.
 */
export const findViewObserver: Extension = ViewPlugin.define((view) => {
  reportFindViewChange(view);
  return {
    update(update: ViewUpdate) {
      if (update.docChanged || update.state.readOnly !== update.startState.readOnly) {
        reportFindViewChange(update.view);
      }
    },
  };
});

/** Run `fn` once, later; returns the release that cancels it. */
export type FindChangeScheduler = (fn: () => void) => CancelAfterPaint;

/**
 * Watch the view `getView` resolves to, and call `onChange` at most once per
 * frame however many changes it reports. The view is resolved when the frame
 * runs rather than when the report arrives, so a report from a view still
 * being constructed — before its host's ref points at it — is not lost.
 * Returns the release; after it nothing further is called.
 */
export function observeFindView(
  getView: () => object | null,
  onChange: () => void,
  schedule: FindChangeScheduler = scheduleAfterPaint,
): () => void {
  const reported = new Set<object>();
  let pending = false;
  let cancel: CancelAfterPaint | null = null;
  const run = (): void => {
    pending = false;
    cancel = null;
    const current = getView();
    const hit = current !== null && reported.has(current);
    reported.clear();
    if (hit) onChange();
  };
  const listener: FindViewListener = (view) => {
    reported.add(view);
    if (pending) return;
    pending = true;
    // A scheduler with no frame to wait for runs `run` before it returns.
    const release = schedule(run);
    if (pending) cancel = release;
  };
  findViewListeners.add(listener);
  return () => {
    findViewListeners.delete(listener);
    cancel?.();
    cancel = null;
    pending = false;
    reported.clear();
  };
}

/** The shared engine, plus the two things only its host can call. */
export interface EditorFindEngine extends FindEngineDelegate {
  /**
   * Record where the reader is, so the next search lands there rather than
   * at the top of the document. `"viewport"` takes the first position of the
   * visual row at the scrollport's top edge; `"selection"` takes the main
   * selection's `from` — which is what makes ⌘E land on the very text the
   * user selected rather than on the next occurrence after it.
   *
   * The host calls this as find OPENS, and only then: a bar already open
   * has an anchor that its own navigation keeps up to date.
   */
  captureFindAnchor(source: "viewport" | "selection"): void;
  /** Retract a landing ring still showing. The host calls it at teardown. */
  dispose(): void;
}

/** Which editable surface an engine searches, as its trace records it. */
export type EditorFindSurface = "text" | "composer";

/**
 * Build the engine over `getView`. One engine per editor: the anchor it keeps
 * outlives any one bar, because the host captures it before the bar mounts.
 * `surface` names the editor in the trace, so a composer's search never reads
 * as a Text card's.
 */
export function createEditorFindEngine(
  getView: () => EditorView | null,
  surface: EditorFindSurface,
): EditorFindEngine {
  /**
   * Where the reader is, for the landing rule. `null` until find opens — and
   * a landing with no anchor is the document's first match, which is what a
   * search over a document nobody has scrolled means anyway.
   */
  let anchor: number | null = null;
  let flash: FindFlashHandle | null = null;
  // The attached session's observation of the view, while one is attached.
  let releaseObserver: (() => void) | null = null;
  const stopObserving = (): void => {
    releaseObserver?.();
    releaseObserver = null;
  };

  const removeFlash = (): void => {
    flash?.remove();
    flash = null;
  };

  // After every find navigation (typed landing, next, previous):
  //  - if the selected match is fully visible with the scroller panned all
  //    the way LEFT, snap `scrollLeft` to 0 — zero horizontal scroll is
  //    favored over the minimal pan CM6's scrollIntoView leaves behind;
  //  - draw the one-shot accent ring over the match (the Session card's
  //    landing flash), absolutely positioned in the scroller's content
  //    coordinates so it scrolls with the text and clips at the editor.
  const settleNavigation = (): void => {
    const live = getView();
    if (live === null) return;
    const sel = live.state.selection.main;
    if (sel.empty) return;
    live.requestMeasure({
      read: (view) => {
        const scroller = view.scrollDOM;
        const start = view.coordsAtPos(sel.from, 1);
        const end = view.coordsAtPos(sel.to, -1);
        if (start === null || end === null) return null;
        // Content space is layout px, the space `scroll*` and `client*`
        // speak; the caret coords are viewport px under a zoom, so their
        // deltas are divided by CM6's own scale.
        const { scaleX, scaleY } = view;
        const rect = scroller.getBoundingClientRect();
        const contentLeft = (start.left - rect.left) / scaleX + scroller.scrollLeft;
        const contentRight = (end.right - rect.left) / scaleX + scroller.scrollLeft;
        const contentTop = (start.top - rect.top) / scaleY + scroller.scrollTop;
        return {
          scroller,
          scaleX,
          scaleY,
          contentLeft,
          contentTop,
          width: Math.max(contentRight - contentLeft, 8),
          height: Math.max((start.bottom - start.top) / scaleY, 12),
          snapZero:
            scroller.scrollLeft > 0 &&
            contentRight <= scroller.clientWidth - 8,
        };
      },
      write: (m) => {
        if (m === null) return;
        if (m.snapZero) m.scroller.scrollLeft = 0;
        removeFlash();
        // Shared placement helper takes VIEWPORT coordinates; convert the
        // measured content-space rect back through the live scroller box.
        const box = m.scroller.getBoundingClientRect();
        flash = placeFindFlash(m.scroller, {
          left:
            box.left +
            (m.contentLeft + m.scroller.clientLeft - m.scroller.scrollLeft) * m.scaleX,
          top:
            box.top +
            (m.contentTop + m.scroller.clientTop - m.scroller.scrollTop) * m.scaleY,
          width: m.width * m.scaleX,
          height: m.height * m.scaleY,
        });
      },
    });
  };

  const selectMatchFromAnchor = (): void => {
    const live = getView();
    if (live === null) return;
    const query = getSearchQuery(live.state);
    if (!query.valid) return;
    // The cursor starts AT the anchor, never at `anchor + 1`: a selection's
    // own `from` is the anchor, so ⌘E must be able to land on the text the
    // user selected rather than skip past it to the next occurrence.
    let hit =
      anchor === null
        ? query.getCursor(live.state).next()
        : query.getCursor(live.state, anchor).next();
    if (hit.done) hit = query.getCursor(live.state).next();
    if (hit.done) return;
    const { from, to } = hit.value;
    // Already on screen? Then select it and leave the page alone. Scrolling
    // a visible match to the vertical centre is motion the user did not ask
    // for and cannot distinguish from the view losing its place — and a
    // match on a PARTLY visible line (the clipped top line a dense file
    // lands on) is visible: it gets the least motion that shows it whole,
    // never the centre. See `find-reveal.ts`.
    const box = live.scrollDOM.getBoundingClientRect();
    const start = live.coordsAtPos(from, 1);
    const end = live.coordsAtPos(to, -1);
    const reveal = findRevealFor(
      start !== null && end !== null
        ? { top: start.top, bottom: end.bottom, left: start.left, right: end.right }
        : null,
      box,
    );
    live.dispatch({
      selection: EditorSelection.single(from, to),
      ...(reveal === "none"
        ? {}
        : {
            effects: EditorView.scrollIntoView(
              EditorSelection.range(from, to),
              // `x: "nearest"` pans a long unwrapped line to the match; an
              // off-screen match takes the vertical centre, as the
              // findNext/findPrevious landing does.
              { y: reveal, x: "nearest" },
            ),
          }),
      userEvent: "select.search",
    });
    settleNavigation();
  };

  const matchInfo = (): FindMatchInfo => {
    const live = getView();
    if (live === null) return NO_MATCHES;
    const query = getSearchQuery(live.state);
    if (!query.valid) return NO_MATCHES;
    const sel = live.state.selection.main;
    const cursor = query.getCursor(live.state);
    let count = 0;
    let activeOrdinal: number | null = null;
    let capped = false;
    let next = cursor.next();
    while (!next.done) {
      if (next.value.from === sel.from && next.value.to === sel.to) {
        activeOrdinal = count;
      }
      count += 1;
      if (count >= EDITOR_MATCH_INFO_CAP) {
        // The cap probe CONSUMES match number `count`, so it is the first
        // candidate of the continuation below rather than something to skip
        // — resuming with a fresh `cursor.next()` would make every past-cap
        // ordinal one too low.
        const probe = cursor.next();
        capped = !probe.done;
        // `count` and `capped` keep their meaning (the chip still reads
        // `5000+`); only the ORDINAL is uncapped, because a chip that can
        // count to 5000 and not say which one you are on is no answer. The
        // walk is bounded by the selection, not the document: it stops at
        // the first match at or past it.
        if (activeOrdinal === null && !sel.empty) {
          let ordinal = count;
          let candidate = probe;
          while (!candidate.done) {
            if (
              candidate.value.from === sel.from &&
              candidate.value.to === sel.to
            ) {
              activeOrdinal = ordinal;
              break;
            }
            if (candidate.value.from >= sel.from) break;
            ordinal += 1;
            candidate = cursor.next();
          }
        }
        break;
      }
      next = cursor.next();
    }
    return { count, activeOrdinal, capped };
  };

  // The trace's own view of this surface. CM6 owns the document and the
  // selection, so there is no index/DOM pair to diverge and no reveal to
  // outlive its budget — an editor contributes `gesture` events only, and
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
    const info = matchInfo();
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
      surface,
      cardId: null,
      gesture: inferFindGesture(prev, snap),
      navSeq,
      query,
      count: info.count,
      activeOrdinal: info.activeOrdinal,
      // An editor's match lives in its document, not at a `(row, segment)`
      // the transcript's coordinates can name.
      target: null,
    });
    prev = snap;
  };
  const recordStep = (): void => {
    if (prev !== null) {
      recordGesture(prev.query, prev.caseSensitive, prev.wholeWord, prev.grep);
    }
  };

  // A step moves the selection to the next match, and stepping IS the reader
  // moving: the next query edit starts from the match they stepped to, not
  // from where find opened. With no live query, as when ⌘G reaches the
  // editor with its bar closed, there is nothing to step to and the command
  // is never run: CodeMirror's answer to an invalid query is to open its
  // search panel seeded from the selection, which would paint matches under
  // no visible bar. A command that found no match moves nothing either, so
  // neither draws a ring on whatever the user had selected.
  const step = (command: (view: EditorView) => boolean): void => {
    const live = getView();
    if (live === null) return;
    if (!getSearchQuery(live.state).valid) return;
    if (!command(live)) return;
    anchor = live.state.selection.main.from;
    settleNavigation();
  };

  // The live query, re-issued with the replacement text. The query spec's
  // `replace` is read only by the replace commands, so the field is written
  // at the moment of a replace rather than mirrored on every keystroke. The
  // spec is not `literal`, so a literal-mode replacement unquotes `\n`, `\t`
  // and `\\`, and a grep-mode one expands `$1`…`$9` and `$&`. The search
  // text is the live query's own, already escaped by `editorSearchText`.
  const withReplacement = (live: EditorView, replacement: string): boolean => {
    const query = getSearchQuery(live.state);
    if (!query.valid) return false;
    if (query.replace !== replacement) {
      live.dispatch({
        effects: setSearchQuery.of(
          new SearchQuery({
            search: query.search,
            caseSensitive: query.caseSensitive,
            regexp: query.regexp,
            wholeWord: query.wholeWord,
            replace: replacement,
          }),
        ),
      });
    }
    return true;
  };

  return {
    didAttach: (session) => {
      stopObserving();
      releaseObserver = observeFindView(getView, () => session.refresh());
    },
    didDetach: stopObserving,
    searchDidChange: (query, opts) => {
      const live = getView();
      if (live === null) return;
      // Mounting the (hidden) bundled panel initializes the search state's
      // `panel` field, which the match highlighter requires before painting
      // decorations — same mechanism as `TugCodeView`.
      if (!searchPanelOpen(live.state)) {
        openSearchPanel(live);
      }
      live.dispatch({
        effects: setSearchQuery.of(
          new SearchQuery({
            search: editorSearchText(query, opts.grep),
            caseSensitive: opts.caseSensitive,
            regexp: opts.grep,
            wholeWord: opts.wholeWord,
          }),
        ),
      });
      if (query.length > 0) selectMatchFromAnchor();
      recordGesture(query, opts.caseSensitive, opts.wholeWord, opts.grep);
    },
    findNext: () => {
      step(cmFindNext);
      recordStep();
    },
    findPrevious: () => {
      step(cmFindPrevious);
      recordStep();
    },
    matchInfo,
    replaceNext: (replacement) => {
      const live = getView();
      if (live === null || live.state.readOnly) return;
      if (!withReplacement(live, replacement)) return;
      // CodeMirror's replace only replaces a selection that is exactly a
      // match, and otherwise just selects the next one. The caret leaves the
      // match whenever the user clicks into the text — the case ⌥⌘G is for —
      // so a press there would select without replacing. A Replace press
      // always replaces: with no match selected, the next one is selected
      // first, and that is the one replaced.
      step((view) => {
        if (matchInfo().activeOrdinal === null) cmFindNext(view);
        return cmReplaceNext(view);
      });
    },
    replaceAll: (replacement) => {
      const live = getView();
      if (live === null || live.state.readOnly) return;
      if (!withReplacement(live, replacement)) return;
      cmReplaceAll(live);
      removeFlash();
    },
    isWritable: () => {
      const live = getView();
      return live !== null && !live.state.readOnly;
    },
    clear: () => {
      prev = null;
      const live = getView();
      if (live === null) return;
      live.dispatch({
        effects: setSearchQuery.of(new SearchQuery({ search: "" })),
      });
      if (searchPanelOpen(live.state)) {
        closeSearchPanel(live);
      }
    },
    captureFindAnchor: (source) => {
      const live = getView();
      if (live === null) return;
      if (source === "selection") {
        anchor = live.state.selection.main.from;
        return;
      }
      // The top of the scrollport, snapped to the start of the visual row
      // there: the first row the reader can see is the first text a search
      // should consider. A ROW, not the logical line — a soft-wrapped line
      // straddling the top edge has its start (and any match there) above
      // the scrollport, and landing on that is a jump the reader never
      // asked for (`find-reveal.ts` centres a match with nothing on screen).
      const port = live.scrollDOM.getBoundingClientRect();
      if (port.height === 0) {
        // No box to read rows from (a folded card's editor is out of
        // layout): the line at the remembered offset is the best answer.
        anchor = live.lineBlockAtHeight(live.scrollDOM.scrollTop * live.scaleY).from;
        return;
      }
      const content = live.contentDOM.getBoundingClientRect();
      // Imprecise, so it always answers: the nearest position to the point.
      const pos = live.posAtCoords({ x: content.left + 1, y: port.top + 1 }, false);
      anchor = live.moveToLineBoundary(EditorSelection.cursor(pos), false, true).head;
    },
    dispose: () => {
      removeFlash();
      stopObserving();
    },
  };
}
