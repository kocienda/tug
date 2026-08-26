/**
 * Canvas data model for the card system (two-table shape).
 *
 * DeckState holds two flat arrays:
 *   - `cards`: the content identities — id, componentId, title, closable,
 *     plus an optional persistence bag.
 *   - `panes`: the visual frames — position, size, ordered cardIds, the
 *     active card in the pane, collapsed, acceptsFamilies, title.
 *
 * Invariants:
 *   1. Every `cardIds` entry in every pane references a real card (by id) in
 *      `deckState.cards`.
 *   2. Each card appears in exactly one pane's `cardIds` (no orphans, no
 *      duplicates).
 *   3. No pane has an empty `cardIds` array — closing the last card of a
 *      pane closes the pane.
 *   4. Each pane's `activeCardId` is a member of that pane's `cardIds`.
 *   5. `activePaneId`, when set, references a real pane in `panes`.
 *   6. At most one pane hosts the Lens card, and that pane carries no
 *      `slot` — the Lens is the imposition's fixed end, not a link in
 *      its chain.
 *
 *: Canvas Data Model Types
 */

import type { DeckImposition } from "@/lib/layout-imposer";
import { LENS_CARD_ID } from "@/lib/lens-card-id";

// ---- Types () ----

/**
 * Per-card state bag. Uniform schema across every card type; each component
 * owns its own apply logic (see [D01]). Axis fields are all optional; a
 * missing field means the card has nothing to persist for that axis.
 *
 * Stored in DeckManager's in-memory cache (primary read source during a
 * session) and in tugbank under `dev.tugtool.deck.cardstate/{cardId}` (durable
 * backing store).
 *
 *: CardStateBag type ([D01], [D02])
 */
export interface CardStateBag {
  /** Scroll position of the card's host content element. */
  scroll?: { x: number; y: number };
  /** Component-owned content payload (e.g. dev engine state). */
  content?: unknown;
  /**
   * Snapshot of every `<input>` / `<textarea>` inside the card that carries
   * a `data-tug-state-key="<key>"` attribute, keyed by the attribute's
   * value. Captured at save time by walking the card-host subtree.
   * Reapplied on restore and on any DOM mutation that introduces a matching
   * element later (to handle late mounts). DOM-authority persistence for
   * native input state that sits outside `useCardStatePreservation`'s opt-in path.
   */
  formControls?: Record<string, FormControlSnapshot>;
  /** Nested-region scroll snapshot keyed by `data-tug-scroll-key`. */
  regionScroll?: RegionScrollSnapshot | null;
  /** Content-editable range snapshot captured from the card's owning boundary. */
  domSelection?: DomSelectionSnapshot | null;
  /** Element-level focus snapshot identifying which descendant of the card root held focus at save time. */
  focus?: FocusSnapshot | null;
  /**
   * Opt-in per-component state harvested at capture time, keyed by the
   * scoped `componentStatePreservationKey` each component registered
   * via `useComponentStatePreservation`. Populated by the Component
   * State Preservation Protocol ([D13], [A9]); absent when the card
   * uses no opt-in components, empty when it uses some but none
   * produced state.
   */
  components?: Record<string, unknown>;
}

/**
 * DOM-authority snapshot of a single native `<input>` or `<textarea>`.
 *
 * Captured and reapplied by `CardHost` for any element bearing
 * `data-tug-state-key="<key>"`. The snapshot covers three axes:
 *
 *   - `value` — the control's text value. Always present.
 *   - `scrollTop` / `scrollLeft` — scroll inside textareas (and
 *     horizontally-scrolling single-line inputs). Always captured
 *     alongside `value`; zeros round-trip as zeros. (Optional on the
 *     type so consumers that synthesize snapshots by hand can omit
 *     them.)
 *   - `selectionStart` / `selectionEnd` / `selectionDirection` —
 *     the caret or highlighted range inside the control. Omitted
 *     for control types that do not support a text selection (e.g.
 *     `<input type="checkbox">` / `"radio"` / `"number"` in most
 *     browsers), or when the field is unreadable at save time.
 *
 * Focus is NOT recorded here — element-level focus rides
 * `bag.focus` (see [D10]). Selection persists regardless of focus
 * at save time; the restore path ([Step 10]) re-anchors the caret
 * after value restore and leaves paint to the browser once focus
 * lands on the element.
 */
export interface FormControlSnapshot {
  value: string;
  scrollTop?: number;
  scrollLeft?: number;
  selectionStart?: number;
  selectionEnd?: number;
  selectionDirection?: "forward" | "backward" | "none";
}

/**
 * Scroll positions of nested scrollable regions inside a card, keyed
 * by the element's `data-tug-scroll-key="<key>"` attribute.
 *
 * Distinct from `bag.scroll`, which captures the card's *outer*
 * host-content scroll (one per card). `regionScroll` covers inner
 * scrollers — most notably `tug-markdown-view`'s virtual-list
 * container — that the user has scrolled independently.
 *
 * Uniqueness of keys within a card subtree is an author contract
 * (same rule as `data-tug-state-key`): `CardHost` walks the card
 * root and writes the last-encountered value per key.
 *
 * **Per-region metadata (`meta`).** Optional, opaque per-region
 * JSON-serializable payload alongside `{x, y}`. The framework treats
 * it as transparent storage; regions encode their own semantics.
 *
 * Motivating use case: variable-height virtualized lists (e.g.
 * `TugListView` driving the session-card transcript) cannot rely on raw
 * `{x, y}` alone because cell heights drift between save and restore
 * — markdown content arrives, tool blocks settle, file viewers
 * measure their substrates — and the saved pixel `y` no longer maps
 * to the saved *content* by the time the bag is replayed. Such
 * regions write a `(anchorIndex, anchorOffset)` payload into `meta`
 * and read it back on `tug-region-scroll-set`; the framework's
 * `MutationObserver`-driven retry loop continues to operate against
 * `{x, y}` for the settle check, while the region's listener re-
 * derives the target `scrollTop` from its live layout state on
 * every commit.
 *
 * **Geometry schemas.** Three families of `meta` payload ship today.
 * The TypeScript shape stays `meta?:
 * unknown` because per-region writers own their schema; the prose
 * below documents the conventions so substrates that extend them
 * stay coherent. A meta payload may carry any combination of the
 * three; listeners that don't recognize a key ignore it.
 *
 *  - `meta.anchor: { index: number; offset: number }` —
 *    cell-relative scroll anchor for variable-height virtualized
 *    lists.
 *
 *  - `meta.cellHeights: number[]` — per-cell measured heights at
 *    save time (`heightIndex.snapshot()`), array index = cell index.
 *    Unmeasured cells get `0` entries. Hydrated into the live
 *    `HeightIndex` at restore so the first paint's anchor-resolve
 *    math is exact, not estimated. Cells render with inline
 *    `min-height` from this array until their own ResizeObserver
 *    reports a fresh measurement.
 *
 *  - `meta.line: { number: number; offsetPx: number }` —
 *    content-anchored scroll position for code editors (CM6 in
 *    `FileBlock`). `number` is the 1-based line number; `offsetPx`
 *    is the intra-line pixel offset of the viewport top from the
 *    line's top. On restore the substrate dispatches its own
 *    scrollIntoView so the saved line lands at the viewport top
 *    regardless of how the font metric resolves on the new page.
 *
 *  - `meta.scrollHeight: number` — validation field; captures the
 *    scroller's total content height at save time. Not consumed at
 *    restore today (deterministic scrollers don't need it); kept
 *    for symmetry and forward-compat cross-version layout checks.
 *
 * Fixed-height inner scrollers (`TerminalBlock` virtualized line
 * pool, markdown view) restore correctly from raw `{x, y}` alone
 * because their internal layout is deterministic across reload;
 * they may still write `meta.scrollHeight` for documentation /
 * cross-version validation.
 */
export type RegionScrollSnapshot = Record<
  string,
  { x: number; y: number; meta?: unknown }
>;

/**
 * Serialized form of a DOM selection anchored inside a card's boundary.
 *
 * Paths are arrays of child indices rooted at the card's registered
 * boundary element (see {@link useSelectionBoundary}). Offsets mirror
 * `Range`'s start/end offsets at the resolved nodes. Captured by
 * `CardHost` from `selectionGuard.getCardRange(cardId)` at save time
 * and resolved back to a `Range` via `pathToNode` on restore.
 */
export interface DomSelectionSnapshot {
  anchorPath: readonly number[];
  anchorOffset: number;
  focusPath: readonly number[];
  focusOffset: number;
  /**
   * Which end of the range the user anchored on. `"forward"` (the default
   * for bags written before the field existed) puts the base at the range
   * start; `"backward"` puts it at the range end. Restore re-establishes the
   * base/extent orientation from it, so a shift-extension after a restore
   * pivots on the end the user actually anchored.
   */
  direction?: "forward" | "backward";
}

/**
 * Element-level focus snapshot.
 *
 * Captured by `CardHost` from `document.activeElement` at save time and
 * narrowed to the descendant of the card's boundary that held focus.
 * Four variants cover every real case:
 *
 *   - `form-control` — a `<input>` or `<textarea>` carrying
 *     `data-tug-state-key="<key>"`. Focus travels with the
 *     componentStatePreservationKey; restore re-focuses that element after its value is
 *     re-applied.
 *   - `dom` — a non-form-control focusable element carrying an opt-in
 *     `data-tug-focus-key="<key>"` marker (e.g. a button, a card-local
 *     menu trigger). Keyed lookup on restore.
 *   - `engine` — focus belongs to a content-owning engine that exposes
 *     a `paintMirrorAsActive` hook (CodeMirror-backed TugTextEditor,
 *     dev prompt-input contentEditable, etc.). The framework's
 *     single-channel dispatcher invokes `store.invokeEnginePaintMirrorAsActive(cardId)`
 *     to drive the claim; the engine no longer self-claims via
 *     `onCardActivated`. See `tuglaws/state-preservation.md`'s
 *     [Focus dispatch model] section. _Migration:_ persisted bags from
 *     before Phase E.11 stored `{ kind: "component-owned" }` for this
 *     case; the deserialization boundary coerces those reads to
 *     `engine` so old bags continue to drive the correct dispatch
 *     path (see `coerceFocusSnapshotOnRead` in `card-host.tsx`).
 *   - `none` — no interesting focus inside the card (or focus is on
 *     `document.body`, or outside the card root entirely).
 *
 * Applied on cold-boot restore only, and only for the active card of
 * the active pane (see [D10]). In-app transitions preserve focus by
 * leaving the DOM mounted (see [D08]).
 */
export type FocusSnapshot =
  | { kind: "none" }
  | { kind: "form-control"; componentStatePreservationKey: string }
  // `keyboard` records whether this focusable was the engine's *keyboard* key
  // view (wearing the focus ring, `data-key-view-kbd`) at save. Restored so the
  // ring resumes across reload / relaunch on exactly the element focus lands on.
  | { kind: "dom"; focusKey: string; keyboard?: boolean }
  | { kind: "engine" };

/**
 * A card — the content identity that survives cross-pane moves.
 *
 * A card knows its componentId, title, and whether it is closable. Position,
 * size, and active-ness are properties of the enclosing pane, not the card.
 * An optional `state` bag carries per-content persistence.
 */
export interface CardState {
  id: string;
  componentId: string;
  title: string;
  closable: boolean;
  /**
   * Optional per-card tab icon (a lucide icon name) that overrides the
   * componentId's registry default in `TugTabBar`. Presentational, like
   * `title`; not serialized. Used by fixed tab sets whose tabs share one
   * sentinel componentId (e.g. the Settings card's panel tabs) so each
   * tab can carry a distinct icon. Omit for ordinary deck cards — the
   * tab bar falls back to the registration's `defaultMeta.icon`.
   */
  icon?: string;
  state?: CardStateBag;
}

/**
 * A pane — the visual frame containing one or more cards.
 *
 * Panes own position, size, collapsed, acceptsFamilies, and the ordered list
 * of cardIds they contain. Exactly one of the cardIds is the pane's
 * `activeCardId`, which is the card whose content is visible in the pane.
 */
export interface TugPaneState {
  id: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  /** Ordered list of card ids belonging to this pane. */
  cardIds: readonly string[];
  /** The currently-active card in the pane. Must be in `cardIds`. */
  activeCardId: string;
  /** Card-level display title (e.g. "Component Gallery"). Empty string for generic panes. */
  title: string;
  /** Families of card types this pane can host in its type picker. Defaults to ["standard"]. */
  acceptsFamilies: readonly string[];
  /**
   * Whether the pane is collapsed (title bar only, content hidden).
   * Missing/undefined is treated as false. ([D04])
   */
  collapsed?: boolean;
  /**
   * The numbered position this pane is imposed at, 0-based, within the
   * deck's active `imposition.kind`. Missing/undefined is a pane the
   * imposer does not place. A slotted pane derives its horizontal anchor
   * and its full canvas height at render (see `lib/layout-imposer.ts`)
   * while still owning its geometry per [L09]; the pane's width is never
   * touched by the imposer. The Lens pane is imposed too but never
   * slotted — it is the strip's fixed end, pinned from
   * `imposition.lens`, and {@link validateDeckState} rejects a Lens pane
   * carrying a slot. Additive-optional like `collapsed?` — no
   * serialization version bump.
   */
  slot?: number;
}

/**
 * The deck's full state.
 *
 * - `cards` holds every card identity in the deck.
 * - `panes` holds every pane frame; each pane's `cardIds` partitions
 *   `cards`.
 * - `activePaneId` identifies the deck's currently-active pane, if any.
 * - `imposition` is the deck's layout imposition: `kind`, the active N-up
 *   rule the imposer places slotted panes with (absent = nothing imposed),
 *   and `lens`, the side the Lens holds. Always present; the default is
 *   `{ lens: "right" }`.
 * - `hasFocus` tracks whether the tugdeck window is the OS-foreground
 *   window. Session-only (never serialized): the deck store seeds it
 *   from `document.hasFocus()` at construction and flips it on window
 *   `focus` / `blur` events. Consumers that gate behavior on "is this
 *   card the focus destination" read it through the
 *   `isFocusDestination` selector (see `deck-store-selectors.ts`).
 *
 * Reload-focus restoration is handled out-of-band: `putFocusedCardId`
 * writes a single-field row to tugbank, and `DeckManager` reads it back
 * via the `initialFocusedCardId` constructor parameter. That pointer is
 * deliberately not part of `DeckState` — it would duplicate persistence
 * paths.
 */
export interface DeckState {
  cards: readonly CardState[];
  panes: readonly TugPaneState[];
  activePaneId?: string;
  imposition: DeckImposition;
  /**
   * True when the tugdeck window owns OS focus (foreground). Seeded
   * from `document.hasFocus()` at store construction; toggled by
   * window `focus` / `blur` events installed at deck-store module
   * init. Not serialized — session state only.
   */
  hasFocus: boolean;
}

// ---- Invariant validation ----

/**
 * Thrown by {@link validateDeckState} when the two-table invariants are
 * violated. The `message` names the violated invariant and includes the
 * offending ids so failures are traceable in test output.
 */
export class DeckStateInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeckStateInvariantError";
  }
}

/**
 * The deck's top edge, in canvas coordinates. A pane's `position.y` is measured
 * from here and the title bar is the pane's first row, so `y >= DECK_TOP_Y` is
 * exactly "the title bar is on the deck."
 */
export const DECK_TOP_Y = 0;

/**
 * Return `state` with every pane's title bar on the deck — the enforcement half
 * of invariant 7.
 *
 * A pane above the deck top is not a layout the user can undo: the deck does
 * not scroll, so a title bar parked above `DECK_TOP_Y` cannot be grabbed, and
 * the pane it belongs to can never be moved back. The drag gesture has always
 * clamped, but a gesture is one writer among many — restore from a persisted
 * layout, detach, arrange, and any future writer all land geometry too. So the
 * floor is applied at the store's commit point instead, where it holds for all
 * of them at once.
 *
 * Returns the SAME object when nothing needed clamping, so the common path adds
 * no allocation and no identity churn for `useSyncExternalStore`.
 *
 * Imposed panes do not pass through here — their frame is derived, pinned a gap
 * below the canvas top in CSS ({@link imposeStyle}), so the law holds for them
 * by construction rather than by clamp.
 */
export function clampPanesToDeck(state: DeckState): DeckState {
  let changed = false;
  const panes = state.panes.map((pane) => {
    if (pane.position.y >= DECK_TOP_Y) return pane;
    changed = true;
    return { ...pane, position: { ...pane.position, y: DECK_TOP_Y } };
  });
  return changed ? { ...state, panes } : state;
}

/**
 * Validate every DeckState invariant documented above. Throws
 * {@link DeckStateInvariantError} on the first violation.
 *
 * Invariants checked:
 *   1. every `pane.cardIds` entry references a real `state.cards[].id`;
 *   2. every card appears in exactly one pane's `cardIds` (no orphans, no
 *      duplicates);
 *   3. no pane has `cardIds.length === 0`;
 *   4. every `pane.activeCardId` is a member of that pane's `cardIds`;
 *   5. when `state.activePaneId` is set, it references a real pane;
 *   6. at most one pane hosts the Lens card, and it carries no `slot`.
 *   7. no pane's `position.y` is above the deck's top edge — a title bar
 *      the user cannot reach is a trap, not a layout ({@link DECK_TOP_Y}).
 *
 * Called from `DeckManager.notify` in dev/test builds only — guarded by
 * `isDevEnv()` so production builds pay no cost. Violations surface at the
 * mutation site that produced them rather than downstream.
 */
export function validateDeckState(state: DeckState): void {
  const cardIds = new Set<string>();
  const lensCardIds = new Set<string>();
  for (const card of state.cards) {
    if (cardIds.has(card.id)) {
      throw new DeckStateInvariantError(
        `duplicate card id "${card.id}" in deckState.cards`,
      );
    }
    cardIds.add(card.id);
    if (card.componentId === LENS_CARD_ID) lensCardIds.add(card.id);
  }

  let lensPaneId: string | undefined;

  const paneIds = new Set<string>();
  const cardToPane = new Map<string, string>();
  for (const pane of state.panes) {
    if (paneIds.has(pane.id)) {
      throw new DeckStateInvariantError(
        `duplicate pane id "${pane.id}" in deckState.panes`,
      );
    }
    paneIds.add(pane.id);

    // Invariant 3
    if (pane.cardIds.length === 0) {
      throw new DeckStateInvariantError(
        `pane "${pane.id}" has empty cardIds (no empty panes permitted)`,
      );
    }

    for (const cid of pane.cardIds) {
      // Invariant 1
      if (!cardIds.has(cid)) {
        throw new DeckStateInvariantError(
          `pane "${pane.id}" references missing card id "${cid}"`,
        );
      }
      // Invariant 2
      const existingHost = cardToPane.get(cid);
      if (existingHost !== undefined) {
        throw new DeckStateInvariantError(
          `card "${cid}" appears in both pane "${existingHost}" and "${pane.id}"`,
        );
      }
      cardToPane.set(cid, pane.id);
    }

    // Invariant 6
    if (pane.cardIds.some((cid) => lensCardIds.has(cid))) {
      if (lensPaneId !== undefined) {
        throw new DeckStateInvariantError(
          `panes "${lensPaneId}" and "${pane.id}" both host the Lens card`,
        );
      }
      lensPaneId = pane.id;
      if (pane.slot !== undefined) {
        throw new DeckStateInvariantError(
          `Lens pane "${pane.id}" carries slot ${pane.slot}; the Lens is the imposition's fixed end, not a link in its chain`,
        );
      }
    }

    // Invariant 7
    if (pane.position.y < DECK_TOP_Y) {
      throw new DeckStateInvariantError(
        `pane "${pane.id}" sits at y=${pane.position.y}, above the deck top (${DECK_TOP_Y}) — its title bar would be unreachable`,
      );
    }

    // Invariant 4
    if (!pane.cardIds.includes(pane.activeCardId)) {
      throw new DeckStateInvariantError(
        `pane "${pane.id}" activeCardId "${pane.activeCardId}" is not in cardIds`,
      );
    }
  }

  // Invariant 2 (second half): every card has a host pane.
  for (const card of state.cards) {
    if (!cardToPane.has(card.id)) {
      throw new DeckStateInvariantError(
        `card "${card.id}" is orphaned (no pane references it)`,
      );
    }
  }

  // Invariant 5
  if (
    state.activePaneId !== undefined &&
    !paneIds.has(state.activePaneId)
  ) {
    throw new DeckStateInvariantError(
      `activePaneId "${state.activePaneId}" does not reference a real pane`,
    );
  }
}
