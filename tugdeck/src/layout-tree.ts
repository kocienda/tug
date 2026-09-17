/**
 * Canvas data model for the card system (two-table shape).
 *
 * DeckState holds two flat arrays:
 *   - `cards`: the content identities — id, componentId, title, closable,
 *     plus an optional persistence bag.
 *   - `panes`: the visual frames — position, size, ordered cardIds, the
 *     active card in the pane, width preset, acceptsFamilies, title.
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
 *   6. At most one pane hosts each sidebar card type, and that pane carries no
 *      `slot` — a sidebar card is the imposition's fixed end, not a link in
 *      its chain.
 *
 *: Canvas Data Model Types
 */

import type {
  ContentWidth,
  DeckImposition,
  SidebarSide,
} from "@/lib/layout-imposer";
import { isSidebarCard } from "@/card-registry";

// ---- Types () ----

/**
 * Per-card state bag. Uniform schema across every card type; each component
 * owns its own apply logic (see [D01]). Axis fields are all optional; a
 * missing field means the card has nothing to persist for that axis.
 *
 * Stored in DeckManager's in-memory cache (primary read source during a
 * session) and in tugbank under `dev.tugapp.deck.cardstate/{cardId}` (durable
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
 * Panes own position, size, width preset, acceptsFamilies, and the ordered list
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
   * The width preset this pane was last *set* to, if any.
   *
   * A stamp, not a constraint: the width itself lives in `size.width`, and this
   * records which named width put it there so a picker can show a check. Any
   * manual resize clears it — a pane the user dragged to 912px is at no preset,
   * and claiming the nearest one would be a resting lie. Absent means "a width
   * nobody named". Additive-optional like `slot?` — no version bump.
   */
  widthPreset?: ContentWidth;
  /**
   * The numbered position this pane is imposed at, 0-based, within the
   * deck's active `imposition.kind`. Missing/undefined is a pane the
   * imposer does not place. A slotted pane derives its horizontal anchor
   * and its full canvas height at render (see `lib/layout-imposer.ts`)
   * while still owning its geometry per [L09]; the pane's width is never
   * touched by the imposer. The rail pane is imposed too but never
   * slotted — it is the strip's fixed end, pinned from
   * `imposition.sidebars`, and {@link validateDeckState} rejects a rail pane
   * carrying a slot. Additive-optional like `widthPreset?` — no
   * serialization version bump.
   */
  slot?: number;
  /**
   * The pane wears its folded form: the masthead and the Z2 status row,
   * whose trailing edge carries the fold control, with the transcript and
   * the composer folded away.
   * Absent means not folded — `true` is the only value the field ever
   * carries, and the key is deleted rather than written `false`.
   *
   * Geometry is the pane's ([L09]), and a pane is one box shared by its tabs,
   * so the flag describes the box rather than any card in it. Written only by
   * {@link DeckManager.setPaneFolded} and its card-addressed twin.
   * Additive-optional like `widthPreset?` and `slot?` — no serialization
   * version bump, and {@link validateDeckState} gains no invariant, because
   * the field constrains nothing about the rest of the state.
   */
  folded?: true;
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
 *   and `sidebars`, where each sidebar card records the side it holds and
 *   whether it stands at its pin. Always present; a card absent from it has
 *   never been placed and opens on the default side.
 * - `hasFocus` tracks whether the tugdeck window is the OS-foreground
 *   window. Session-only (never serialized): the deck store seeds it
 *   from `document.hasFocus()` at construction and flips it on window
 *   `focus` / `blur` events. Consumers that gate behavior on "is this
 *   card the focus destination" read it through the
 *   `isFocusDestination` selector (see `deck-store-selectors.ts`).
 * - `bullseyePaneId` names the pane standing in bullseye. Session-only
 *   (never serialized) and read through `bullseyePaneIdOf` /
 *   `DeckManager.getBullseyePaneId()`, which derive rather than trust it.
 *
 * Reload-focus restoration is handled one level up: the focused card is a
 * field on the SPACE record that holds this deck (`SpaceState.focusedCardId`
 * in `spaces.ts`), written into the v5 layout blob beside its deck. That
 * pointer is deliberately not part of `DeckState` — it would duplicate
 * persistence paths. A pre-v5 blob's pointer came from a standalone tugbank
 * row instead and still reaches `DeckManager` through the
 * `initialFocusedCardId` constructor parameter, which fills the migrated
 * space; the row is never written again.
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
  /**
   * The pane standing in bullseye — centered in the band at the comfy
   * width, with every other pane receded. Not serialized — session state
   * only, so a reload always comes back un-bullseyed.
   *
   * Read through `bullseyePaneIdOf()` (or `DeckManager.getBullseyePaneId()`,
   * which delegates to it), never directly: the accessor derives, and a raw
   * id may outlive the focus that justified it.
   */
  bullseyePaneId?: string;
  /**
   * How far the flow strip has slid left under the band, in pixels. Absent
   * reads as 0 — the strip at rest, its first slot against the band's left
   * edge.
   *
   * Written only by the reveal rule, on activation in flow mode ([P10]). Not
   * serialized — session state only, and deliberately: the offset is
   * derivable, since activating any card re-reveals it, and a restored one
   * would be a viewport nobody asked for onto an arrangement that may have
   * changed while the deck was closed.
   */
  flowOffset?: number;
  /**
   * How far each overflowing column's strip of members has slid up behind its
   * run, in pixels, keyed by slot. An absent slot reads as 0 — the strip at
   * rest, its first member against the run's top.
   *
   * The vertical twin of {@link DeckState.flowOffset}, and per-slot because
   * every overflowing column scrolls on its own. Written only by the reveal
   * rule, on activation and on a move within the column ([P12]). Not
   * serialized, for the same reason and with the same force: the number is
   * derivable, and a restored one would be a viewport nobody asked for onto a
   * column that may have changed while the deck was closed.
   */
  columnOffsets?: Readonly<Record<number, number>>;
  /**
   * How far each overflowing rail's strip of members has slid up behind its
   * run, in pixels, keyed by side. An absent side reads as 0 — the strip at
   * rest, its first member against the run's top.
   *
   * The side-keyed twin of {@link DeckState.columnOffsets}, and per side for
   * the reason that one is per slot: each overflowing place scrolls on its own.
   * Written only by the reveal rule, on activation ([P12]), and not serialized
   * for the same reason and with the same force: the number is derivable, and a
   * restored one would be a viewport nobody asked for onto a rail that may have
   * gained or lost members while the deck was closed.
   */
  railOffsets?: Readonly<Partial<Record<SidebarSide, number>>>;
  /**
   * The height, in pixels, a modal surface has stated it needs, keyed by the
   * member hosting it — pane id for a column member and componentId for a
   * rail one, which is how `placeMembers` names them, so nothing has to
   * translate between the two ([B01]).
   *
   * A place's allocator reads each entry as its member's FLOOR, never as a
   * target: a member whose stored share already exceeds it does not move
   * ([B07]). Only a sheet whose natural height is content-bounded declares one
   * and it says so at its own call site ([B02]); nothing is inferred.
   *
   * Session state only, and never serialized, for the same reason
   * {@link DeckState.columnOffsets} is not: a reservation is derivable from the
   * sheet that is up, and no sheet is up across a restart, so a restored one
   * would be a claim held for a surface nobody raised. It is likewise kept out
   * of `imposition`'s stored shares ([B03]) — the division the hand set with
   * the sash is the thing the card falls back into when the sheet goes, and a
   * claim written into the record would have destroyed it to honour it.
   *
   * Absent, rather than empty, when nobody is claiming: the field goes away
   * with its last entry, so absence is the one reading of "no reservation".
   */
  sheetReservations?: Readonly<Record<string, number>>;
  /**
   * The OPENING BID, in pixels, a member arrived carrying — keyed the way
   * {@link DeckState.sheetReservations} above is keyed — pane id for a column
   * member and componentId for a rail one, which is how `placeMembers` names
   * them, so nothing has to translate between the two.
   *
   * Read as one contributor to its member's FLOOR, alongside the card's own
   * stack policy and the reservation above it, with the member keeping its
   * weight ([B01]). So this field and that one are the same KIND of thing —
   * two floors on one member, the larger of which binds — and neither is read
   * ahead of the other. It was a floor and a ceiling once, which is what held
   * a card at its declared height while the column around it had room to
   * spare; the one member that still reads floor = ceiling is a folded one.
   *
   * Written at the REVEAL of a card that arrived hidden ([B04]) — the one
   * commit that clears the {@link DeckState.arriving} mark and seats the
   * newcomer — so nothing re-targets the settle a commit later. The number is
   * the sheet's own last report while the card stood hidden at its seat,
   * rather than declared or measured elsewhere — the panel's height depends
   * on what is in it, and nothing a registration can write knows that.
   * **Cleared by the sheet that supersedes it**, in `setSheetReservation`'s own
   * commit ([B02]): by a claim at least as high as the bid, and by the sheet
   * going, whatever the bid was. So a bid that was too small is corrected by
   * the measurement that knows better, a bid too generous costs air until its
   * sheet goes, and no card-state transition is a party to either — binding is
   * what makes a picker go, and the sheet going is what is read ([F07]). A card
   * torn down before its sheet ever measured drops its own bid.
   *
   * Session state only, and never serialized, for {@link
   * DeckState.sheetReservations}'s reason read one step further ([P03]): a bid
   * is what a card declared before it was laid out, nothing is arriving across
   * a restart, and a restored bid would hold a settled card's floor at a
   * height nothing on screen asked for. It is likewise kept out of
   * `imposition`'s stored shares — the division the hand set with the sash is
   * what the card falls back into once no floor is lifting it.
   *
   * Absent, rather than empty, when nothing is bidding: the field goes away
   * with its last entry, so absence is the one reading of "no bid".
   */
  openingBids?: Readonly<Record<string, number>>;
  /**
   * The ARRIVING mark: the members drawn in their column but not yet part of
   * its division, keyed by pane id the way {@link DeckState.openingBids} is.
   *
   * A marked pane is the real card, mounted hidden at the seat it will take,
   * so its content can lay out and report its height while the user sees
   * nothing move ([B01], [B02]). For as long as the mark stands the column
   * divides its run among the STANDING members only — `columnMembersOf`,
   * `deckColumnsOf` and `placeMembers` all leave a marked pane out ([B08]) —
   * so no neighbour's rect changes at the commit that appends the pane. The
   * reveal is the one commit that removes the mark and writes the opening bid
   * the hidden card measured, and from that commit the pane is an ordinary
   * member ([B04]).
   *
   * `true` rather than a height or a timestamp: what the record says is WHICH
   * panes are arriving, and the height it will arrive at is the sheet's own
   * report, held elsewhere until the reveal reads it.
   *
   * Session state only, and never serialized, for {@link
   * DeckState.openingBids}'s reason: nothing is arriving across a restart, and
   * a restored mark would hold a settled card hidden with nothing to reveal it.
   *
   * Absent, rather than empty, when nothing is arriving: the field goes away
   * with its last entry, so absence is the one reading of "nothing arriving".
   */
  arriving?: Readonly<Record<string, true>>;
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
 * Return `state` with no arriving mark naming a pane that is gone — the
 * enforcement half of {@link DeckState.arriving}'s "absent when nothing is
 * arriving".
 *
 * A card can be closed, or its pane torn down, in the window between the
 * commit that appended it hidden and the reveal that would have cleared its
 * mark, and the removal is one of several writers — close, detach, a batch
 * assignment — none of which is the arrival's own. So the mark is swept at
 * the store's commit point instead, where it holds for all of them at once,
 * exactly as {@link clampPanesToDeck} holds invariant 7.
 *
 * Returns the SAME object when nothing needed sweeping, so the common path
 * adds no allocation and no identity churn for `useSyncExternalStore`.
 */
export function sweptArriving(state: DeckState): DeckState {
  const marks = state.arriving;
  if (marks === undefined) return state;
  const live = new Set(state.panes.map((pane) => pane.id));
  const stale = Object.keys(marks).filter((paneId) => !live.has(paneId));
  if (stale.length === 0) return state;
  const kept = Object.fromEntries(
    Object.entries(marks).filter(([paneId]) => live.has(paneId)),
  ) as Record<string, true>;
  const { arriving: _dropped, ...rest } = state;
  return Object.keys(kept).length === 0 ? rest : { ...rest, arriving: kept };
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
 *   6. at most one pane hosts any one sidebar card, and it carries no `slot`.
 *   7. no pane's `position.y` is above the deck's top edge — a title bar
 *      the user cannot reach is a trap, not a layout ({@link DECK_TOP_Y}).
 *   8. when `state.bullseyePaneId` is set, it references a real pane. A
 *      sidebar pane is not asserted against here even though a rail never
 *      takes the posture ([D131], `DeckManager.toggleBullseye`): a raw id is
 *      allowed to be residue, and an invariant that threw on one would turn a
 *      stale field into a crash.
 *      Deliberately NOT asserted: that the pane still holds the first
 *      responder. The raw id is allowed to go stale when focus moves; the
 *      accessor derives it away, and asserting it here would throw on the
 *      normal path.
 *   9. every LIVE pane named in a column's `order` stands in that column's
 *      slot. Ids naming no live pane are inert residue and pass — a column
 *      is keyed by pane id and is never cleaned up ([L23]), so residue is
 *      the normal resting state, while a live pane in the wrong column is a
 *      member the column would try to lay out where it does not stand.
 *
 * Called from `DeckManager.notify` in dev/test builds only — guarded by
 * `isDevEnv()` so production builds pay no cost. Violations surface at the
 * mutation site that produced them rather than downstream.
 */
export function validateDeckState(state: DeckState): void {
  const cardIds = new Set<string>();
  /** Which sidebar card type each sidebar card id belongs to. */
  const sidebarComponentByCardId = new Map<string, string>();
  for (const card of state.cards) {
    if (cardIds.has(card.id)) {
      throw new DeckStateInvariantError(
        `duplicate card id "${card.id}" in deckState.cards`,
      );
    }
    cardIds.add(card.id);
    if (isSidebarCard(card.componentId)) {
      sidebarComponentByCardId.set(card.id, card.componentId);
    }
  }

  /** Which pane holds each sidebar card type — at most one apiece. */
  const sidebarPaneByComponentId = new Map<string, string>();

  const paneIds = new Set<string>();
  /** Which slot each pane stands in, for invariant 9. */
  const slotByPaneId = new Map<string, number | undefined>();
  const cardToPane = new Map<string, string>();
  for (const pane of state.panes) {
    if (paneIds.has(pane.id)) {
      throw new DeckStateInvariantError(
        `duplicate pane id "${pane.id}" in deckState.panes`,
      );
    }
    paneIds.add(pane.id);
    slotByPaneId.set(pane.id, pane.slot);

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
    for (const cid of pane.cardIds) {
      const componentId = sidebarComponentByCardId.get(cid);
      if (componentId === undefined) continue;
      const held = sidebarPaneByComponentId.get(componentId);
      if (held !== undefined) {
        throw new DeckStateInvariantError(
          `panes "${held}" and "${pane.id}" both host the "${componentId}" sidebar card`,
        );
      }
      sidebarPaneByComponentId.set(componentId, pane.id);
      if (pane.slot !== undefined) {
        throw new DeckStateInvariantError(
          `sidebar pane "${pane.id}" carries slot ${pane.slot}; a sidebar card is the imposition's fixed end, not a link in its chain`,
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

  // Invariant 8
  if (state.bullseyePaneId !== undefined) {
    const bullseyePane = state.panes.find((p) => p.id === state.bullseyePaneId);
    if (bullseyePane === undefined) {
      throw new DeckStateInvariantError(
        `bullseyePaneId "${state.bullseyePaneId}" does not reference a real pane`,
      );
    }
  }

  // Invariant 9
  for (const [key, arrangement] of Object.entries(
    state.imposition.columns ?? {},
  )) {
    const slot = Number(key);
    for (const paneId of arrangement.order ?? []) {
      // Residue is inert, not a violation: a pane id outlives the pane, and
      // the arrangement is never cleaned up. What the invariant catches is a
      // LIVE pane recorded in the wrong column — a member the column would
      // then lay out somewhere its pane does not stand.
      if (!paneIds.has(paneId)) continue;
      const standing = slotByPaneId.get(paneId);
      if (standing !== slot) {
        throw new DeckStateInvariantError(
          `column ${slot} names pane "${paneId}" as a member, but that pane stands ` +
            `${standing === undefined ? "outside the chain" : `in slot ${standing}`}`,
        );
      }
    }
  }
}
