/**
 * The whole-entity press: a secondary press that opens a menu about an
 * entity selects that entity — whole — and paints it.
 *
 * A menu whose every item acts on an entity must not open over a highlight
 * naming a fragment of it. Right-click a commit atom and the menu offers to
 * copy, insert and open the commit; the highlight under it has to say
 * `commit:56c4820f` and not the eight hex characters WebKit smart-selected out
 * of the pill. That is one rule about presses, and this module is the one
 * place it lives, so that every hook that opens a menu about an entity
 * composes it rather than re-learning it — or, as three of them did, never
 * learning it at all.
 *
 * **The press has two halves, and the first is not optional.** WebKit picks
 * the closest word inside `sendContextMenuEvent` itself, ahead of the
 * `contextmenu` event it dispatches to us, so by the time any handler runs
 * the sub-word is already painted and whatever the user had selected before
 * is gone. `preventDefault` cannot stop it. So:
 *
 *   1. **`mousedown`** — on a secondary press (right-click, or macOS
 *      Control-click = button 0 + ctrlKey) that lands on an entity, snapshot
 *      the selection as it stands BEFORE the smart-select gets to it.
 *   2. **`contextmenu`** — settle: select the entire entity and mark it
 *      `data-tug-entity-selected` (see `lib/entity-selection-paint`), unless
 *      the snapshot was a selection of the user's own that reaches past the
 *      entity, which is about more than this entity and stays theirs. The
 *      snapshot is what tells that selection from the browser's pick, which
 *      always lands wholly inside the element the click hit.
 *
 * Without a snapshot (a surface that stops its own pointer selection, like
 * the CM6 editor) the live selection stands in, and the only selection that
 * can be live by then is the browser's smart-select — inside the element, so
 * replaced — or one the surface kept from before the click.
 *
 * Two ways to compose it. {@link createWholeEntityPress} is the core — the
 * two halves as plain functions a hook that already owns its handlers calls
 * from them (`useTextSurfaceContextMenu`, whose consumers attach its
 * handlers themselves). {@link useWholeEntityPress} binds both halves to a
 * host element with **native listeners**, for a hook whose menu opens on a
 * React `onContextMenu` and needs the settle to have run before that fires.
 * Native rather than React props on purpose: `CommitShaText` stops React
 * propagation of `mousedown`/`mouseup`/`click`/`pointerdown` so a gesture on
 * a hash can't fold the History row out from under its own menu, and a React
 * `onMouseDown` on the claiming ancestor would therefore never fire. React 18
 * dispatches from the root container, so a native listener on that ancestor
 * has already seen the event by the time the synthetic `stopPropagation`
 * runs.
 *
 * Laws: [L06] — the selected face is a DOM attribute and a stylesheet, never
 * React state; nothing here re-renders anything. [L07] — the entity resolver
 * is read live at event time, never closed over stale.
 *
 * @module lib/whole-entity-press
 */

import { useCallback, useRef } from "react";

import {
  clearEntitySelected,
  paintEntitySelected,
  selectionCovers,
} from "./entity-selection-paint";

/**
 * Names the element a press landed on that the menu treats as one
 * indivisible entity, or `null` when the press missed every such element.
 */
export type EntityResolver = (event: MouseEvent) => HTMLElement | null;

/** A right-click, or macOS Control-click (button 0 + ctrlKey). */
export function isSecondaryPress(event: MouseEvent): boolean {
  return event.button === 2 || (event.button === 0 && event.ctrlKey);
}

// ---------------------------------------------------------------------------
// The settle
// ---------------------------------------------------------------------------

/**
 * The live selection as detached clones, or `null` when there is none.
 * Cloning matters: the live `Range` objects mutate as the selection moves,
 * so holding them would remember the smart-select rather than what preceded
 * it.
 */
export function snapshotSelection(): Range[] | null {
  const sel = window.getSelection();
  if (sel === null || sel.rangeCount === 0) return null;
  const ranges: Range[] = [];
  for (let i = 0; i < sel.rangeCount; i += 1) {
    ranges.push(sel.getRangeAt(i).cloneRange());
  }
  return ranges;
}

/** Put a {@link snapshotSelection} result back, or clear when it was empty. */
export function restoreSelection(ranges: Range[] | null): void {
  const sel = window.getSelection();
  if (sel === null) return;
  sel.removeAllRanges();
  if (ranges === null) return;
  for (const range of ranges) sel.addRange(range);
}

/**
 * Whether `ranges` is a selection that both touches `element` and reaches
 * beyond it — the shape only the user's own drag can have. WebKit's
 * contextual smart-select always lands wholly inside the element the click
 * hit, so this is what tells a selection worth keeping from the browser's
 * pick.
 */
export function reachesPastElement(
  ranges: Range[] | null,
  element: HTMLElement,
): boolean {
  if (ranges === null) return false;
  return ranges.some(
    (range) =>
      !range.collapsed &&
      range.intersectsNode(element) &&
      !(
        element.contains(range.startContainer) &&
        element.contains(range.endContainer)
      ),
  );
}

/** Select the whole of `element`, its boundaries included. */
export function selectWholeElement(element: HTMLElement): void {
  const sel = window.getSelection();
  if (sel === null) return;
  const range = document.createRange();
  range.selectNode(element);
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * Put the selection where a whole-entity menu can honestly open over it: on
 * the entire element, unless the user already had a selection of their own
 * that reaches past it, which stays theirs.
 *
 * `preClick` is the mousedown snapshot when the host wired the first half;
 * without one the live selection stands in (see the module note).
 *
 * The DOM selection is only half of what the reader sees. A text highlight
 * paints the runs it covers, so an entity whose mark is a BOX — a commit
 * pill, a session chip — would light its label and leave its node, padding
 * and border at rest. `paintEntitySelected` marks the element so the box can
 * wear the selection whole; see `lib/entity-selection-paint`.
 *
 * **An entity the selection cannot land on takes no mark.** A copyable is
 * `user-select: none`, and so is every row of chrome — the History shade, a
 * session row — so selecting one can settle to nothing. The paint is a second
 * face for a selection the DOM is holding, never a substitute for one, so it
 * is put on only when the selection actually covers the element and any
 * earlier mark is cleared otherwise. Nothing throws and nothing goes stale.
 *
 * What WebKit actually does in `user-select: none` chrome (the History shade,
 * measured): the range stands — it intersects the element, so the mark goes
 * on and the pill paints from it — while `Selection.toString()` gives no
 * text, because unselectable content renders none. That is the right face
 * for a menu about a commit in a shade: the pill lights whole, the native
 * highlight has nothing to paint inside it, and the mark retires with the
 * range on the next `selectionchange`.
 */
export function settleWholeEntitySelection(
  element: HTMLElement,
  preClick: Range[] | null,
): void {
  const prior = preClick ?? snapshotSelection();
  if (reachesPastElement(prior, element)) {
    restoreSelection(prior);
    clearEntitySelected();
    return;
  }
  selectWholeElement(element);
  if (selectionCovers(element)) {
    paintEntitySelected(element);
  } else {
    clearEntitySelected();
  }
}

// ---------------------------------------------------------------------------
// The press: both halves, bound to one resolver
// ---------------------------------------------------------------------------

export interface WholeEntityPress {
  /**
   * The `mousedown` half. Call for every mousedown on the host: an ordinary
   * press is a no-op, and a secondary press that misses every entity forgets
   * any earlier snapshot. Returns the entity the press landed on, or `null`.
   */
  press: (event: MouseEvent) => HTMLElement | null;
  /**
   * The `contextmenu` half. Settles the selection over the entity the event
   * names, consuming the snapshot {@link press} parked, and returns that
   * entity — or `null` when the event names none, in which case the
   * selection is the browser's business as usual and nothing was touched.
   */
  settle: (event: MouseEvent) => HTMLElement | null;
}

/**
 * The two halves of the press as plain functions over one resolver, for a
 * hook that already owns the handlers it attaches. `resolve` is called at
 * event time, so pass something that reads its own dependencies live.
 */
export function createWholeEntityPress(resolve: EntityResolver): WholeEntityPress {
  // The selection as it stood before a whole-entity secondary press, parked
  // by `press` and consumed by `settle`. `null` means the last secondary
  // press was not on an entity and the selection is the browser's business;
  // a set `ranges: null` means there was nothing of the user's to keep, so
  // the entity takes the selection.
  let preClick: { ranges: Range[] | null } | null = null;

  return {
    press(event) {
      if (!isSecondaryPress(event)) return null;
      const entity = resolve(event);
      preClick = entity !== null ? { ranges: snapshotSelection() } : null;
      return entity;
    },
    settle(event) {
      const parked = preClick;
      preClick = null;
      const entity = resolve(event);
      if (entity === null) return null;
      settleWholeEntitySelection(entity, parked?.ranges ?? null);
      return entity;
    },
  };
}

// ---------------------------------------------------------------------------
// The hook: both halves as native listeners on a host
// ---------------------------------------------------------------------------

export interface UseWholeEntityPressResult {
  /**
   * Ref callback for the host element — the element whose presses open the
   * menu, which may be wider than the entity (a History row claims the row;
   * its entity is the commit atom). Binds native `mousedown` and
   * `contextmenu` listeners; passing `null` (unmount) unbinds them.
   */
  attach: (host: HTMLElement | null) => void;
}

/**
 * Bind the press to a host with native listeners. The host's own React
 * `onContextMenu` — the one that opens the menu — runs after the native
 * settle here, because React dispatches from the root, so the menu opens
 * over the selection the press has already settled.
 */
export function useWholeEntityPress(
  resolve: EntityResolver,
): UseWholeEntityPressResult {
  // Read live at event time ([L07]); the callers pass a fresh closure per
  // render and the listeners must not remember an old one.
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;

  const pressRef = useRef<WholeEntityPress | null>(null);
  if (pressRef.current === null) {
    pressRef.current = createWholeEntityPress((event) =>
      resolveRef.current(event),
    );
  }

  const hostRef = useRef<HTMLElement | null>(null);
  const attach = useCallback((host: HTMLElement | null) => {
    const press = pressRef.current;
    if (press === null) return;
    const previous = hostRef.current;
    if (previous !== null) {
      previous.removeEventListener("mousedown", press.press);
      previous.removeEventListener("contextmenu", press.settle);
    }
    hostRef.current = host;
    if (host !== null) {
      host.addEventListener("mousedown", press.press);
      host.addEventListener("contextmenu", press.settle);
    }
  }, []);

  return { attach };
}
