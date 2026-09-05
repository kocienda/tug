/**
 * TugPane — pane chrome and frame: title bar, tabs, content area,
 * drag/resize, z-order, and responder integration.
 *
 * Responsibilities:
 * - Absolutely-positioned `.tug-pane` at position/size from `stackState`
 * - Title bar, accessory / tab bar, and content portal target
 * - Drag: RAF appearance-zone mutation during, `onCardMoved` commit on end
 * - Resize: 8 handles, clamped to min-size, `onCardMoved` on end
 *
 * Pane activation (bring-to-front on pointer-down) is driven by the
 * document-level capture-phase listener in `pane-focus-controller.ts`
 * — not by any React handler on this frame. The frame's own
 * `data-focused` attribute is also written by that module, not
 * rendered from a prop here.
 *
 * [D03] TugPane chrome, [D06] appearance-zone drag
 *
 * @module components/chrome/tug-pane
 */

import "../tugways/tug-pane.css";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import {
  CircleDot,
  MoreHorizontal,
  MoreVertical,
  MoveHorizontal,
  X,
  icons,
} from "lucide-react";
import type { CardState, TugPaneState } from "@/layout-tree";
import type { SlotStackEntry } from "@/deck-store-selectors";
import type { CardMeta, CardSizePolicy, LayoutRole } from "@/card-registry";
import { DEFAULT_SIZE_POLICY, getRegistration } from "@/card-registry";
import { computeSnap, computeResizeSnap } from "@/snap";
import type { Rect, GuidePosition, SnapResult } from "@/snap";
import {
  autoscrollDelta,
  autoscrollKey,
  dropZoneKey,
  pickLiveZone,
  type AutoscrollTarget,
  type DropZone,
  type DropZoneHost,
} from "@/lib/drop-zones";

/** One strip a drag has scrolled, and where it left it. */
interface AutoscrollRun {
  target: AutoscrollTarget;
  offset: number;
}
import { flashCardPane } from "@/lib/flash-pane-border";
import { getTugZoom } from "@/components/tugways/scale-timing";
import { animate, type TugAnimation } from "@/components/tugways/tug-animator";
import { useResponder } from "@/components/tugways/use-responder";
import type { ActionEvent } from "@/components/tugways/responder-chain";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { TugTabBar } from "@/components/tugways/tug-tab-bar";
import { useDeckManager } from "@/deck-manager-context";
import { dispatchCommand } from "@/command-dispatch";
import type { MovePaneOptions } from "@/deck-manager-store";
import {
  imposeStyle,
  type ColumnMemberPlacement,
  imposeSidebarStyle,
  sidebarWidthProperty,
  type PinnedFrame,
  type RailMode,
  type SidebarSide,
  IMPOSITION_GAP_PX,
  readSettleMs,
  type ImposedPlacement,
  CONTENT_WIDTH_PRESETS,
  CONTENT_WIDTH_LABELS,
  DEFAULT_CONTENT_WIDTH,
  resolveContentWidthPx,
  type ContentWidth,
} from "@/lib/layout-imposer";
import { motionKeyframes, velocityAlongTravel } from "@/lib/imposer-motion";
import { TugButton } from "@/components/tugways/internal/tug-button";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { TugActionTooltip } from "@/components/tugways/tug-action-tooltip";
import { TugConfirmPopover } from "@/components/tugways/tug-confirm-popover";
import {
  cardTitleStore,
  type CardMastheadPayload,
} from "@/lib/card-title-store";
import { SessionMasthead } from "@/components/tugways/session-masthead";
import { CardMasthead } from "@/components/tugways/card-masthead";
import { CardSlotBadge } from "@/components/tugways/card-slot-badge";
import {
  TugColumnBadge,
  columnBadgeCharacter,
} from "@/components/tugways/tug-column-badge";
import { beginResizeEpisode } from "@/lib/resize-episode";
import { composePaneTitleBarText } from "@/lib/pane-title";
import { paneTitleBarItemsStore } from "@/lib/pane-title-bar-items-store";
import {
  cardModalHoldStore,
  isCardHeld,
  refuseCardModalHold,
  useCardModalHold,
} from "@/lib/card-modal-hold-store";
import {
  TugPopupMenu,
  type TugPopupMenuEntry,
} from "@/components/tugways/internal/tug-popup-menu";
import {
  commandEntry,
  validateCommand,
} from "@/components/tugways/command-registry";
import { commandShortcut } from "@/components/tugways/keymap-registry";
import { commandValidationSource } from "@/lib/host-menu-state";
import {
  getCardCloseGuard,
  type CardCloseDecision,
} from "@/lib/card-close-guard";
import {
  cardWaivesCloseConfirm,
  readCardCloseAdvice,
  type CardCloseAdvice,
} from "@/lib/card-close-advice";
import * as paneContentRegistry from "@/components/chrome/pane-content-registry";
import * as paneFrameRegistry from "@/components/chrome/pane-frame-registry";
import * as paneRootRegistry from "@/components/chrome/pane-root-registry";
import {
  captureFocusForDragStart,
  transferFocusForActivation,
} from "@/focus-transfer";
import { paneOcclusionGesture } from "@/components/chrome/pane-occlusion-controller";

// ===========================================================================
// CardTitleBar (window title chrome)
// ===========================================================================

/**
 * Height of the card title bar in pixels. Must match --tug-chrome-height.
 */
export const CARD_TITLE_BAR_HEIGHT = 36;

/**
 * Height of the masthead chrome tier in pixels. Must match
 * `--tug-masthead-height`.
 *
 * Fixed, never content-driven: the masthead's three lines truncate rather
 * than wrap, so this number is what the chrome is, not what its content
 * happened to need. The pane wears it exactly when its ACTIVE card publishes
 * a masthead sidecar — chrome follows the frontmost tab, because a pinned
 * tall chrome over a Text tab would caption one card with another's identity.
 *
 * The masthead and the tab bar STACK; they do not merge. A multi-tab Session
 * pane's chrome is 72 + 36: masthead on top, tab row beneath it, unchanged.
 */
export const MASTHEAD_HEIGHT = 72;

/**
 * Imperative handle on CardTitleBar — lets the surrounding TugPane
 * route the chain-action close (Cmd-W) through the same confirm popover
 * the X button opens, so a `confirmClose` pane never bypasses the guard.
 */
/**
 * One close gesture's confirm-popover copy and confirm action. Shared by
 * the pane-close (X / single-tab Cmd-W), active-card-close (multi-tab
 * Cmd-W) and close-all flows.
 */
interface CloseIntent {
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
}

export interface CardTitleBarHandle {
  /**
   * Run the title-bar close flow as if the X button had been clicked.
   * When `confirmClose` is `true` the popover opens; when `false` the
   * pane closes immediately via `onClose`.
   */
  requestClose: () => void;
  /**
   * General close-with-confirm entry point shared by Cmd-W (active-card
   * close on a multi-tab pane) and the "Close All Card Tabs" command. When
   * `needsConfirm` is `true` the shared confirm popover opens with the
   * supplied copy and `onConfirm` fires only on confirm; when `false`,
   * `onConfirm` runs immediately. Always anchored to the X button.
   */
  requestCloseWith: (intent: {
    needsConfirm: boolean;
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
    /**
     * Which cards' close guards this gesture must consult: `"active"`
     * (single-card close — Cmd-W's close-active-tab) or `"pane"` (the
     * whole pane is going away — Close All; every hosted card's guard
     * runs, visiting each dirty card). Defaults to `"active"`.
     */
    guardScope?: "active" | "pane";
  }) => void;
  /**
   * Toggle the stack picker. Opens it as if the badge had been clicked;
   * closes it when it is already open, which is also what the chord's own
   * chain dispatch would do to it. No-op when the pane holds no slot or its
   * slot holds one pane — no badge is rendered, so there is no anchor.
   */
  revealStack: () => void;
}

export interface CardTitleBarProps {
  title: string;
  icon?: string;
  closable?: boolean;
  /**
   * The width preset this pane is currently stamped with, or `null` at a width
   * the user chose by hand. Drives the check in the width popup, and nothing
   * else — a custom width shows no check rather than a false one.
   *
   * Omitted → the pane has no width control (a sidebar-role pane: rails take
   * their width from the allocator, not from a preset).
   */
  widthPreset?: ContentWidth | null;
  /**
   * Number of cards in this pane. Drives only the *wording* of the
   * close-confirmation popover the title-bar X button opens:
   *
   *   - `cardCount > 1` → "Close N Tabs?" with a "Close All" confirm
   *     button.
   *   - `cardCount <= 1` → "Close Card?" with a "Close" confirm
   *     button.
   *
   * Whether the popover opens at all is governed by `confirmClose`,
   * not this prop. Option-click on X bypasses the popover regardless
   * and closes the pane immediately. Either way the X click activates a
   * background pane first (the button carries no `data-no-activate`),
   * so the user sees the pane they are about to discard.
   *
   * Defaults to `1` (single-card wording) so callers that don't pass
   * the prop get the single-card popover copy.
   */
  cardCount?: number;
  /**
   * Resolve the close decision for a close gesture, if any card demands
   * one. `"active"` consults only the active card's guard (single-card
   * close); `"pane"` composes every hosted card's guard — the pane visits
   * each dirty card before it dies. A resolved decision supersedes the
   * `confirmClose` popover; Option-click still bypasses it. Called live at
   * close time so the guards always reflect current cards.
   */
  resolveCloseGuard?: (scope: "active" | "pane") => CardCloseDecision | null;
  /**
   * Resolve which card, if any, is held by a modal run and therefore refuses
   * to be closed — the id of the holder, or `null` when the gesture may
   * proceed. `"active"` asks about the active card; `"pane"` asks about every
   * hosted card, because the gestures with that scope kill all of them. Called
   * live at close time, like {@link resolveCloseGuard} beside it, and consulted
   * ahead of it: a card that is not closable has no save decision to make.
   */
  resolveModalHold?: (scope: "active" | "pane") => string | null;
  /**
   * Whether the X button (and the imperative `requestClose()` handle)
   * routes through the close-confirm popover. When `false`, X-click and
   * Cmd-W both close the pane immediately — no popover. When `true`,
   * the popover opens and `onClose` fires only once the user confirms.
   *
   * The Option-click escape hatch always closes immediately regardless
   * of this flag.
   */
  confirmClose?: boolean;
  /**
   * What the pane's card says about a close, asked live at close time and
   * consulted only when {@link confirmClose} is `true`. A `waive` closes
   * the pane immediately despite the type's opt-in (an empty Session card
   * has no transcript to protect); a `message` words the popover in the
   * card's own terms when the confirm does stand (an unsent draft).
   *
   * Wired only for a single-card pane: a multi-card pane's guard is about
   * discarding N tabs at once, which no card's emptiness answers.
   */
  resolveCloseAdvice?: () => CardCloseAdvice | null;
  /**
   * The pane's active card id. Used only to look up any title-bar items the
   * active card has contributed via `paneTitleBarItemsStore` — its standing
   * buttons and its `…` rows. Omitted → the card contributes nothing.
   */
  activeCardId?: string;
  /**
   * Every pane sharing this pane's slot, topmost first, already resolved for
   * display — passed straight through from {@link TugPaneProps.slotStack}.
   * Drives the stack badge (rendered only past depth 1) and the rows of the
   * picker it opens. Empty for a free pane and for a rail pane.
   */
  slotStack?: readonly SlotStackEntry[];
  /** Raise the pane a picker row names. Wired in `DeckCanvas`. */
  onRevealPane?: (entry: SlotStackEntry) => void;
  /**
   * Whether this pane currently stands in bullseye. Drives the target
   * button's on-state and its label, and nothing else — the posture itself is
   * deck state, read by `TugPane` from the prop `DeckCanvas` derives.
   * @selector [data-on]
   */
  bullseye?: boolean;
  /**
   * Put this pane in bullseye, or take it out. Wired by `TugPane` to the
   * pane-addressed `set-bullseye` command, never to a store method ([L30]) —
   * the same path {@link onSetWidth} takes. Present on every pane, rails
   * included: a rail's place on the edge is reserved while it holds the
   * posture, so the button is not a hide.
   */
  onToggleBullseye?: () => void;
  /**
   * How the PLACE this pane shares is arranged — a side's rail or a numbered
   * slot's column, whichever {@link slotStack} names. Present → the stack badge
   * is also the gateway to arranging that place, which is the one piece of
   * chrome a shared place already puts on screen.
   *
   * The verbs are the *place's*, not the pane's, which is why the mode arrives
   * as a fact and leaves as a named verb — the bar renders from props and
   * reports the choice, exactly as it does for a picker row or a width preset.
   * The bar does not know or care which kind of place it is; `TugPane` resolves
   * the verb to the right command.
   */
  placeArrangement?: {
    mode: RailMode;
    kind: "rail" | "column";
    /** This pane's place in the run, topmost first — the band letter the badge
     *  draws when the place is split. */
    index: number;
    /** How many panes share the place. */
    count: number;
  };
  /**
   * Arrange the place this pane stands in. `"split"` / `"stack"` set the mode;
   * `"equalize"` divides the run evenly again. Wired by `TugPane` to the
   * registered commands, never to a store method ([L30]) — the same path
   * {@link onSetWidth} takes.
   */
  onArrangePlace?: (verb: "split" | "stack" | "equalize") => void;
  /**
   * Apply a width preset to this pane. Present exactly when
   * {@link widthPreset} is — together they are "this pane has a width
   * control" — and wired to the `set-card-width` command, never to a store
   * method ([L30]).
   */
  onSetWidth?: (preset: ContentWidth) => void;
  /**
   * The active card's masthead request, or null for the one-line bar. Present
   * → the bar renders at {@link MASTHEAD_HEIGHT} and gives its title region
   * to the card family's masthead component instead of a title string; the
   * pane's own controls stay exactly where they are, aligned to the lead
   * line. The payload is a KEY — the masthead resolves what to display
   * itself; nothing about identity travels through this prop.
   * @selector [data-masthead="true"]
   */
  masthead?: CardMastheadPayload | null;
  /**
   * Whether this pane is a RAIL rather than a card in the slot band. A rail's
   * chrome is a different thing wearing a different look — a slimmer tier, a
   * flush ground instead of the tinted title band, and a tracked label in
   * place of an icon-and-title — because the layout imposer already treats it
   * as a different thing and the chrome should say so.
   *
   * Passed by `TugPane` from the active card's registered `layoutRole` — what
   * the card IS, not where it currently stands. A released rail keeps this
   * chrome and gains a width control, which `sidebarSide` still governs.
   * @selector [data-role="sidebar"]
   */
  sidebar?: boolean;
  onClose?: () => void;
  onDragStart?: (event: React.PointerEvent) => void;
}

/**
 * The stack menu's arrange verbs, as row ids.
 *
 * Prefixed because the same menu's other rows are keyed by paneId, and a verb
 * that could collide with one would raise a pane instead of arranging the
 * place.
 */
const PLACE_VERB_SPLIT = "place:split";
const PLACE_VERB_STACK = "place:stack";

/**
 * Verbs more than one kind of card offers, ordered as they stand in the
 * rollup, and pinned to its trailing end.
 *
 * The row reads right to left as a fixed spine — bullseye, then card width,
 * then Reveal in Finder — and only the LEFTMOST positions belong to whatever a
 * particular card happens to add. A Text card contributes Card Settings and a
 * Session card contributes its summary; those are different glyphs meaning
 * different things, so they are the ones that should move between card kinds.
 * Reveal is the same act on both and had been landing at a different offset on
 * each, which is the cost the hand pays for an ordering nobody stated.
 *
 * Bullseye and width are the pane's own and are authored in place at the end
 * of the row. This table is for the verbs a CARD publishes, which arrive in
 * whatever order the card wrote them and cannot be trusted to agree with the
 * next card's.
 *
 * A verb not in the table ranks ahead of every verb that is, so an unshared
 * one falls to the left without needing an entry. Add a command here only when
 * a second card kind starts publishing it — a table of one-card verbs would be
 * an ordering with nothing to order against.
 */
const SHARED_VERB_RANK: Readonly<Record<string, number>> = {
  [TUG_ACTIONS.REVEAL_CARD_FILE]: 0,
};

function sharedVerbRank(commandId: string): number {
  return SHARED_VERB_RANK[commandId] ?? -1;
}
const PLACE_VERB_EQUALIZE = "place:equalize";

export const CardTitleBar = React.forwardRef<CardTitleBarHandle, CardTitleBarProps>(
function CardTitleBar({
  title,
  icon,
  closable = true,
  widthPreset,
  cardCount = 1,
  resolveCloseGuard,
  resolveModalHold,
  confirmClose = false,
  resolveCloseAdvice,
  activeCardId,
  slotStack = EMPTY_SLOT_STACK,
  onRevealPane,
  bullseye = false,
  onToggleBullseye,
  placeArrangement,
  onArrangePlace,
  onSetWidth,
  masthead = null,
  sidebar = false,
  onClose,
  onDragStart,
}: CardTitleBarProps, ref) {
  // Whether the place this badge describes is a divided rail rather than a
  // stack of any kind — the one fact the badge's glyph, its label, and its
  // verbs all read.
  const placeSplit = placeArrangement?.mode === "split";
  // Whether this pane stands in a PLACE at all — a slot, or a rail. That is
  // the badge's whole condition now, and depth is no part of it: a card alone
  // in its column is standing in a place one card deep, which is a true fact
  // worth stating and, more to the point, the only door to the verb that gives
  // it a neighbour. A free pane holds no place, so it draws nothing rather
  // than a chip claiming a position it does not have — the same rule
  // `CardSlotBadge` beside it already follows.
  //
  // `slotStack.length > 1` survives as a fallback, not as a gate: a pane can
  // share a place while reaching the bar without an arrangement record, and
  // when it does the depth the title bar can see for itself still answers.
  const hasPlace = placeArrangement !== undefined || slotStack.length > 1;
  const badgeKind = placeSplit ? "split" : "stack";
  const badgeCount = placeArrangement?.count ?? Math.max(slotStack.length, 1);
  const badgeIndex = placeArrangement?.index ?? 0;
  // A place one card deep. The badge draws the count all the same — one-of-one
  // is a true sentence in the vocabulary the badge already speaks, and
  // inventing a fourth glyph for solitude would say nothing the numeral does
  // not. What DOES turn is the prose: a menu holding one card cannot offer to
  // show you another, so the phrasing below asks a different question of it.
  const placeAlone = badgeCount < 2;
  // Generic title-bar contributions: the active card may publish items via
  // `paneTitleBarItemsStore`. The pane renders them without knowing what
  // card published them (the `cardTitleStore` precedent) — no cards-card import.
  // An item wears itself as a standing button or as a `…` row; the two are
  // split here so each side renders only what belongs to it, and the `…`
  // button itself appears only when a row asked for it.
  const titleBarItems = useSyncExternalStore(
    paneTitleBarItemsStore.subscribe,
    () => paneTitleBarItemsStore.get(activeCardId ?? null),
  );
  // Whether the active card is held by a modal run — a `/compact` in flight
  // behind its own sheet. The cluster below is deliberately ABOVE the pane's
  // modal scrim, which is right for a picker and wrong for a run: a card whose
  // only honest ways forward are the run settling and the user canceling it
  // must not also offer a close box, a stack picker, and a rollup of verbs.
  // While the hold stands the whole cluster reads disabled and the rollup does
  // not unfurl; the bar itself is untouched, so the pane can still be dragged.
  const modalHeld = useCardModalHold(activeCardId ?? null);
  // Sorted so the SHARED verbs anchor the trailing end of the card's own run,
  // in one order on every kind of card. See `SHARED_VERB_RANK`.
  const titleBarButtonItems = useMemo(
    () =>
      (titleBarItems ?? [])
        .filter((item) => item.presentation === "button")
        .map((item, index) => ({ item, index }))
        .sort(
          (a, b) =>
            sharedVerbRank(a.item.commandId) - sharedVerbRank(b.item.commandId) ||
            // Stable within a rank: a card's own order among its unshared
            // verbs is the card's business, and nothing here has an opinion.
            a.index - b.index,
        )
        .map((entry) => entry.item),
    [titleBarItems],
  );
  const titleBarMenuItems = useMemo(
    () => (titleBarItems ?? []).filter((item) => item.presentation !== "button"),
    [titleBarItems],
  );

  // Every row is a command reference, so a row's title, its enablement, and
  // its shortcut glyph are all the TABLE's answers — the same ones the chord
  // and the native menu item get ([L30]). A card chooses which commands are
  // on its menu and in what order; it never says whether one is enabled,
  // because a second opinion beside the entry that already answers is exactly
  // what drifts from ⌘S the first time a gate changes.
  //
  // Sampled at OPEN, keyed on the open flag: `commandValidationSource()` is a
  // snapshot of the last menu-state flush, and open time is the moment an
  // in-page menu wants it — the same rule `buildTextEditingMenuItems` follows.
  // Closed, the rows are not rendered and not worth computing.
  //
  // A row whose command is invalid renders DISABLED rather than vanishing: a
  // menu whose rows come and go is one the hand cannot learn.
  const [titleBarMenuOpen, setTitleBarMenuOpen] = useState(false);

  // A chosen row's command runs once the menu is GONE, not while it stands.
  // An open menu owns focus — its content is portalled outside the card — so a
  // command dispatched from inside the selection handler is asked to find a
  // key card and a first responder that the menu is currently holding, and it
  // finds neither. Parking the id and dispatching from a layout effect that
  // runs after the close commits is what makes the row mean the same thing
  // its chord does.
  const [pendingCommandId, setPendingCommandId] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (pendingCommandId === null || titleBarMenuOpen) return;
    setPendingCommandId(null);
    dispatchCommand(pendingCommandId);
  }, [pendingCommandId, titleBarMenuOpen]);
  const titleBarMenuRows = useMemo<TugPopupMenuEntry[]>(() => {
    if (!titleBarMenuOpen) return [];
    const source = commandValidationSource();
    return titleBarMenuItems.map((item) => {
      const entry = commandEntry(item.commandId);
      const shortcut = commandShortcut(item.commandId);
      return {
        id: item.commandId,
        label:
          entry?.dynamicTitle?.(source) ?? entry?.title ?? item.commandId,
        disabled: entry === undefined || !validateCommand(entry, source),
        ...(item.checked !== undefined ? { selected: item.checked } : {}),
        ...(shortcut !== undefined ? { shortcut } : {}),
      };
    });
  }, [titleBarMenuOpen, titleBarMenuItems]);
  const handleTitleBarPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest(".tug-button")) return;
      // Only the primary button moves a pane, and the guard is load-bearing
      // rather than tidy. The drag takes POINTER CAPTURE on the frame at
      // pointer-down; WebKit then retargets every later event of that pointer
      // to the capture element — including the `contextmenu` that a right
      // press raises. So a right-click anywhere in the title bar arrived at
      // `.tug-pane` rather than at the thing under the cursor, no handler
      // inside the bar ever saw it, and the app's own document-level fallback
      // answered every one of them with "No Actions". The masthead's three
      // lines live in that bar, which is how a session row with copies on it
      // came to look like a surface with nothing to offer.
      if (event.button !== 0) return;
      onDragStart?.(event);
    },
    [onDragStart],
  );

  // The controls cluster's measured width, published on the bar as
  // `--tugx-pane-controls-width`. The cluster only occupies the first chrome
  // band, and the masthead runs its lower lines under the dead space beneath
  // it to the card's edge — how far is a sibling's width, which CSS cannot
  // read, and which changes as the stack badge comes and goes. A DOM write on
  // resize, never React state ([L06]).
  const barElRef = useRef<HTMLDivElement | null>(null);
  const controlsElRef = useRef<HTMLDivElement | null>(null);

  // Whether the pointer is inside the title bar — the fact the rollup's reveal
  // reads. Written to the DOM as `data-pointer-within`, never to React state
  // ([L06]): it is pure appearance, it turns on every pass of the pointer
  // across every card on the deck, and a re-render per crossing is a re-render
  // for nothing.
  //
  // `pointerenter`/`pointerleave` rather than the `:hover` pseudo-class, and
  // the difference is worth stating because `:hover` would be one line of CSS.
  // A pseudo-class is decided by the engine's own hit-testing against the real
  // cursor, and nothing outside the engine can move it — which makes a
  // hover-revealed surface unreachable from a test that is not driving a
  // physical mouse, and this app's tests deliberately run in a background
  // window with the user's pointer untouched. The pair of events IS what hover
  // is derived from, so a hand gets identical behavior, and a dispatched event
  // reaches the same listener a real one does. The reveal stays testable
  // without a test-only door into the product.
  //
  // `pointerleave` fires only when the pointer exits the bar AND every
  // descendant, so moving from the bar into the revealed row — a child of it —
  // keeps the row up. Leaving for a portalled menu does end it, which is what
  // `data-held` on the rollup exists to cover.
  useLayoutEffect(() => {
    const bar = barElRef.current;
    if (bar === null) return;
    const enter = (): void => bar.setAttribute("data-pointer-within", "");
    const leave = (): void => bar.removeAttribute("data-pointer-within");
    bar.addEventListener("pointerenter", enter);
    bar.addEventListener("pointerleave", leave);
    // A pointer that is cancelled out from under us — a drag taking capture, a
    // window change — sends no `pointerleave`, and the row would stay open
    // over a card nobody is pointing at.
    bar.addEventListener("pointercancel", leave);
    return () => {
      bar.removeEventListener("pointerenter", enter);
      bar.removeEventListener("pointerleave", leave);
      bar.removeEventListener("pointercancel", leave);
    };
  }, []);

  useLayoutEffect(() => {
    const bar = barElRef.current;
    const controls = controlsElRef.current;
    if (bar === null || controls === null) return;
    const observer = new ResizeObserver(() => {
      bar.style.setProperty(
        "--tugx-pane-controls-width",
        `${controls.offsetWidth}px`,
      );
    });
    observer.observe(controls);
    return () => {
      observer.disconnect();
    };
  }, []);

  // Controlled-mode open state for the close-confirm popover (the shared
  // `TugConfirmPopover` component). The X button and the imperative
  // `requestClose*` handles drive it open; the component's onConfirm /
  // onCancel drive it closed. Anchored to the X button element, captured
  // by a callback ref so the popover re-positions once the button mounts.
  //
  // `closeIntent` carries the popover copy and the confirm action for the
  // *current* close gesture — a pane close (X / Cmd-W on a single-tab
  // pane), an active-card close (Cmd-W on a multi-tab pane), or a
  // close-all (the "Close All Card Tabs" command). It is set on open and
  // retained while the popover animates closed so the copy never flips
  // mid-dismiss.
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeIntent, setCloseIntent] = useState<CloseIntent | null>(null);
  const [closeAnchorEl, setCloseAnchorEl] = useState<HTMLButtonElement | null>(null);

  // Slot-stack picker open state. Local-data [L24], beside `closeOpen`: it is
  // transient UI the title bar owns, and the deck never hears about it.
  const [stackMenuOpen, setStackMenuOpen] = useState(false);

  // The rollup's HELD state — the row stands open even though the pointer has
  // left the bar. The reveal itself is not here and must not be: hover is
  // appearance, so it is a CSS state on the bar ([L06]) and React never learns
  // the pointer arrived. What React owns is the one fact CSS cannot derive —
  // that a menu opened from inside the row is currently standing.
  //
  // That is load-bearing rather than tidy. A `TugPopupMenu` portals its content
  // outside the card, so the moment the pointer leaves the bar for the menu the
  // hover ends, the row collapses, and the menu is left hanging off an anchor
  // that is no longer painted. Both menus inside the row are therefore
  // CONTROLLED, and while either stands the row is held open.
  const [widthMenuOpen, setWidthMenuOpen] = useState(false);
  const rollupHeld = titleBarMenuOpen || widthMenuOpen;

  // Where a masthead's own chrome affordance mounts: an empty host inside the
  // control cluster, directly AFTER the stack badge. Held as state rather than
  // in a ref because the masthead portals into it and must re-render once the
  // node exists.
  const [controlsAccessoryEl, setControlsAccessoryEl] =
    useState<HTMLElement | null>(null);

  // The open state must not outlive the badge. A pane can lose its PLACE while
  // the picker is up — released from its slot by a resize, unpinned from a
  // rail — and the trigger would then unmount open: the focus trap's
  // `onCloseAutoFocus` never runs (keyboard focus left on a removed node) and
  // the stale `true` would make the badge mount already-open the next time
  // this pane stands somewhere. The props the picker already reads are the
  // signal; nothing has to notify us.
  //
  // The test is `hasPlace`, not depth. Depth was the right question only while
  // the badge itself was gated on it; now that a place one card deep still
  // draws one, closing the picker when a peer leaves would snatch the menu out
  // from under a hand that is about to press "Split Vertically".
  useEffect(() => {
    if (!hasPlace) setStackMenuOpen(false);
  }, [hasPlace]);

  // Drives the popover's copy only — not whether it appears.
  const isMultiTab = cardCount > 1;

  // The pane-close intent (X button / single-tab Cmd-W): closes the whole
  // pane via `onClose`, with multi-tab vs single-tab copy. A single card
  // that has something specific to say about what the close would take
  // (a Session card holding an unsent message) words the popover itself
  // ([L31]); everything else gets the pane's own question.
  const paneCloseIntent = useCallback(
    (): CloseIntent => ({
      message: isMultiTab
        ? `Close ${cardCount} Tabs?`
        : (resolveCloseAdvice?.()?.message ?? "Close Card?"),
      confirmLabel: isMultiTab ? "Close All" : "Close",
      onConfirm: () => onClose?.(),
    }),
    [isMultiTab, cardCount, onClose, resolveCloseAdvice],
  );

  const openCloseConfirm = useCallback((intent: CloseIntent) => {
    setCloseIntent(intent);
    setCloseOpen(true);
  }, []);

  const handleClosePointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );

  // Single-flight latch so a second close gesture while the guard sheet is
  // already up is swallowed rather than stacking a second sheet.
  const guardRunningRef = useRef(false);

  // Consult the active card's close guard, if one is registered. Returns
  // `true` when a guard exists and has taken ownership
  // of the close decision (it runs `proceed` only on `"close"`); returns
  // `false` when there is no guard, so the caller falls back to its
  // existing `confirmClose`-or-immediate behavior. Every close site routes
  // its proceed action through here, so the guard covers the plain X-click
  // (`!confirmClose` short-circuit) as well as ⌘W and the imperative
  // handle — Option-click bypasses it at the call site.
  const withCloseDecision = useCallback(
    (proceed: () => void, scope: "active" | "pane"): boolean => {
      // A card held by a modal run is not closable, and the refusal comes
      // first — ahead of the save guard, because there is nothing to decide
      // about a card that is not going anywhere. The X is already disabled,
      // so what arrives here is a route with no on-screen control to dim:
      // ⌘W, Close All Card Tabs, a rail card's remote close box. The holder
      // speaks the reason ([L31]).
      const heldId = resolveModalHold?.(scope) ?? null;
      if (heldId !== null) {
        refuseCardModalHold(heldId);
        return true;
      }
      const decision = resolveCloseGuard?.(scope) ?? null;
      if (!decision) return false;
      if (guardRunningRef.current) return true;
      guardRunningRef.current = true;
      void decision().then((outcome) => {
        guardRunningRef.current = false;
        if (outcome === "close") proceed();
      });
      return true;
    },
    [resolveCloseGuard, resolveModalHold],
  );

  // The confirm policy, resolved at the moment of the gesture rather than
  // at render: a card that opts into the guard by type may be holding
  // nothing right now, and only it can say so. Read from handlers only
  // ([L02]) — the advice is a live call, not React state.
  const confirmsClose = useCallback(
    (): boolean => confirmClose && resolveCloseAdvice?.()?.waive !== true,
    [confirmClose, resolveCloseAdvice],
  );

  const handleClosePointerUp = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      const inside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      if (!inside) return;
      // Popover already showing → this click just dismisses it, exactly
      // like a click on the title bar outside the buttons. Never reopens
      // (which would re-seed and drop the focus ring) or closes the pane.
      if (closeOpen) {
        setCloseOpen(false);
        return;
      }
      // Option-click is the power-user escape hatch: close immediately,
      // bypassing both the guard and the confirm popover.
      if (event.altKey) {
        onClose?.();
        return;
      }
      // A registered close guard supersedes the confirm popover — even on
      // a non-`confirmClose` pane, where a plain X-click would otherwise
      // close immediately. The X kills the whole pane, so every hosted
      // card's guard runs, not just the active one.
      if (withCloseDecision(() => onClose?.(), "pane")) return;
      if (!confirmsClose()) {
        onClose?.();
      } else {
        openCloseConfirm(paneCloseIntent());
      }
    },
    [closeOpen, onClose, confirmsClose, openCloseConfirm, paneCloseIntent, withCloseDecision],
  );

  const handleCloseClick = useCallback(
    (event?: React.MouseEvent<HTMLButtonElement>) => {
      // Mouse clicks are owned by `handleClosePointerUp` (which already ran
      // on the preceding pointerup). The trailing `click` fires AFTER React
      // re-renders with the new `closeOpen`, so acting on it here would undo
      // what pointerup just did — opening then instantly closing (a blink).
      // A mouse-originated click reports `detail > 0`; skip it. Only keyboard
      // activation (Enter / Space — no pointer event, `detail === 0`) is
      // handled below, with the same toggle/close logic as pointerup.
      if (event && event.detail > 0) return;
      if (closeOpen) {
        setCloseOpen(false);
        return;
      }
      if (event?.altKey) {
        onClose?.();
        return;
      }
      if (withCloseDecision(() => onClose?.(), "pane")) return;
      if (!confirmsClose()) {
        onClose?.();
        return;
      }
      openCloseConfirm(paneCloseIntent());
    },
    [closeOpen, onClose, confirmsClose, openCloseConfirm, paneCloseIntent, withCloseDecision],
  );

  // Confirm / cancel callbacks for the shared `TugConfirmPopover`. Confirm closes
  // the pane; cancel just dismisses the popover. The component owns the focus model
  // (default-button seed, arrow navigation, Escape / Cmd-. cancel) — chrome no
  // longer hand-rolls any of it.
  const handleCloseConfirm = useCallback(() => {
    setCloseOpen(false);
    closeIntent?.onConfirm();
  }, [closeIntent]);

  const handleCloseCancel = useCallback(() => {
    setCloseOpen(false);
  }, []);

  // Imperative bridge for the surrounding TugPane: route Cmd-W and the
  // close-all command through the same popover the X button uses, so a
  // `confirmClose` pane gets the guard on keyboard close too rather than
  // slipping past it.
  React.useImperativeHandle(ref, () => ({
    requestClose: () => {
      const proceed = () => {
        if (confirmsClose()) openCloseConfirm(paneCloseIntent());
        else onClose?.();
      };
      // ⌘W has no Option-bypass; the guard always gets first say. This
      // handle closes the whole pane, so run every hosted card's guard.
      if (withCloseDecision(proceed, "pane")) return;
      proceed();
    },
    requestCloseWith: ({ needsConfirm, message, confirmLabel, onConfirm, guardScope }) => {
      const proceed = () => {
        if (needsConfirm) openCloseConfirm({ message, confirmLabel, onConfirm });
        else onConfirm();
      };
      // The caller says whose guards this gesture answers to; a multi-tab
      // pane still keeps its "Close N Tabs?" popover after the guards
      // resolve `"close"`.
      if (withCloseDecision(proceed, guardScope ?? "active")) return;
      proceed();
    },
    revealStack: () => {
      // A pane with no stack has no badge, therefore no anchor to open at.
      if (slotStack.length <= 1) return;
      // Toggle, not set. The chord that reaches here travels the responder
      // chain, and `sendToFirstResponder` runs the responder action before it
      // notifies the dispatch observers — so an OPEN menu's observeDispatch
      // subscription sees this same dispatch and closes it. Toggling is the
      // one form that is single-valued in both directions: open → the toggle
      // queues false and the observer queues false again, the menu closes;
      // closed → the subscription is gated on `open` so no observer exists,
      // and the toggle simply opens it. It also reads correctly for the
      // pointer callers, where "again" ought to dismiss.
      setStackMenuOpen((prev) => !prev);
    },
  }), [confirmsClose, onClose, openCloseConfirm, paneCloseIntent, withCloseDecision, slotStack.length]);

  const IconComponent =
    icon && icons[icon as keyof typeof icons]
      ? icons[icon as keyof typeof icons]
      : null;

  return (
    <div
      ref={barElRef}
      className="tug-pane-title-bar"
      data-slot="tug-pane-title-bar"
      data-masthead={masthead !== null ? "true" : undefined}
      data-role={sidebar ? "sidebar" : undefined}
      {...(modalHeld ? { "data-modal-hold": "" } : {})}
      onPointerDown={handleTitleBarPointerDown}
      data-testid="tug-pane-title-bar"
      // The title bar is an ACTIVATION/DRAG gesture surface, never a
      // responder target: clicking it must not steal first responder (or
      // browser focus) from the card's content — the caret keeps blinking
      // in the editor and the card's accelerators keep landing there.
      // Cross-pane activation still restores the newly-active card's first
      // responder through the engine ([P21]); this marker only stops the
      // pointer walk from promoting the coarse pane container. See
      // responder-chain.md § First responder.
      data-tug-fr-preserve=""
    >
      {/* The masthead REPLACES the icon and the title string — a card wearing
          one is saying its own name in its own three lines, and a registry
          icon plus a duplicate title beside them would be two answers to one
          question. The pane's controls below are untouched. */}
      {masthead === null ? (
        <>
          {IconComponent && (
            <span className="tug-pane-icon" data-testid="tug-pane-icon">
              {React.createElement(IconComponent)}
            </span>
          )}

          <span className="tug-pane-title" data-testid="tug-pane-title">
            {title}
          </span>
        </>
      ) : masthead.kind === "card-masthead" ? (
        // A document card's lines. No key: unlike a session there is no dwell
        // queue or open placard to carry across, so reconciling a new path
        // onto the same element is exactly right.
        <CardMasthead payload={masthead} />
      ) : (
        // Keyed by session, so a payload naming a DIFFERENT session remounts
        // rather than reconciling. A new session is a new entity, which is
        // what [L26]'s test asks: the masthead holds the PULSE dwell queue's
        // current line and an open telemetry placard, and reconciling would
        // carry both across — the previous session's line reading under the
        // new session's callsign for a dwell window. Reachable two ways:
        // resuming a different session in the same card, and switching
        // between two stacked Session tabs.
        <SessionMasthead
          key={masthead.sessionId}
          sessionId={masthead.sessionId}
          cardId={activeCardId}
          // Its telemetry widget stands in the pane's control cluster, not
          // beside it — see the host below.
          accessoryHost={controlsAccessoryEl}
        />
      )}

      <div ref={controlsElRef} className="tug-pane-title-bar-controls" data-testid="tug-pane-title-bar-controls">
        {/* The cluster reads in two registers, and its order is the argument.
            FIRST the rollup — every verb the pane offers, behind one `⋯`.
            THEN, pinned hard against the trailing edge, the two badges that
            say where this card stands and the box that closes it. Nothing
            else stands in the row: a verb is either in the rollup or it does
            not exist, and the only controls outside it are the two readouts
            and the one act that must be reachable without a hover.

            The badges used to lead the row, on the reasoning that the head of
            the cluster is the region that holds still. That was exactly
            backwards. `.tug-pane-title-bar` is `space-between` and the cluster
            is `flex-shrink: 0`, so the cluster is anchored by its RIGHT edge:
            the head is precisely the end that slides whenever one card carries
            one more verb than its neighbour, which is why a Session card's
            slot chip and a text card's sat at different x. The trailing edge
            is the fixed one, so that is where the controls the eye must find
            without looking now live. */}
        {/* THE ROLLUP. Every verb the pane offers, at rest behind a single `⋯`,
            revealed the moment the pointer touches the title bar anywhere.
            Nothing about the buttons changes — same glyphs, same order, same
            acts. What changes is that a card at rest shows a `⋯`, two badges
            and a close box instead of seven controls, and the verbs arrive
            when a hand does.

            The reveal is CSS on the bar's own `:hover` ([L06]); React never
            learns the pointer arrived. `data-held` is the other half, and it
            has exactly one job: a menu opened from inside the row portals
            outside the card, so the pointer travelling to it ends the hover —
            and without the hold the row would collapse out from under a
            standing menu, leaving it anchored to something no longer painted.

            The row REPLACES the `⋯` rather than growing beside it. It is an
            overlay anchored to the rollup's own trailing edge, so it unfurls
            leftward over the bar's dead middle from the exact spot the `⋯`
            occupies, and the handle goes out as the row comes in — one
            control's worth of space, showing one thing at a time. Grown in
            the flex flow instead, it would widen the cluster and
            `space-between` would re-truncate the card's title on every pass
            of the pointer. */}
        <div
          className="tug-pane-title-bar-rollup"
          data-slot="tug-pane-title-bar-rollup"
          {...(rollupHeld ? { "data-held": "" } : {})}
          data-testid="tug-pane-title-bar-rollup"
        >
          <div
            className="tug-pane-title-bar-rollup-row"
            data-testid="tug-pane-title-bar-rollup-row"
          >
            {/* THE ROW READS RIGHT TO LEFT AS A FIXED SPINE, and everything
                below is that ordering.

                Trailing end first, because it is the end that holds still:
                bullseye, card width, then Reveal in Finder — the three verbs
                more than one kind of card offers. A reader who learns where
                Reveal is on a Text card finds it at the same offset on a
                Session card. Ahead of them, filling leftward, whatever this
                particular card adds: Card Settings on a Text card, the session
                summary on a Session card, the `⋮` overflow on any card with
                one. Those are different glyphs meaning different things, so
                those are the ones that should move between card kinds.

                Two mechanisms enforce it, because card verbs arrive by two
                routes. `SHARED_VERB_RANK` sorts the items a card publishes
                through the items store; the masthead orders its own portal by
                hand, with the argument written at the site. */}
            {/* The `⋮` overflow leads: it is the least shared thing in the
                row — most cards publish no menu rows at all — and its own
                contents are already a list, so it has the least claim on a
                fixed offset. */}
            {titleBarMenuItems.length > 0 && (
              // Same span anchor as the stack badge, for the same reason. The
              // phrase names what the menu HOLDS — the commands for the card
              // the title bar belongs to — rather than describing the press.
              //
              // VERTICAL ellipsis, and it must stay vertical: the rollup's own
              // mark is a horizontal `⋯`, and two identical glyphs in one row
              // meaning different things is the one thing this cluster cannot
              // afford. The convention does the teaching — `⋯` reads as "more
              // of this row", `⋮` as "this thing's own menu" — so the pair is
              // learnable rather than merely distinct.
              <TugTooltip content="Assorted commands">
                <span className="tug-pane-title-bar-tooltip-anchor">
                  <TugPopupMenu
                    trigger={
                      <TugButton
                        subtype="icon"
                        emphasis="ghost"
                        role="action"
                        size="sm"
                        icon={<MoreVertical />}
                        aria-label="Card menu"
                        data-testid="tug-pane-title-bar-menu-button"
                      />
                    }
                    align="end"
                    open={titleBarMenuOpen}
                    onOpenChange={setTitleBarMenuOpen}
                    items={titleBarMenuRows}
                    onSelect={setPendingCommandId}
                  />
                </span>
              </TugTooltip>
            )}
            {/* The masthead's own chrome affordances — on a Session card, the
                summary popover's trigger and then Reveal in Finder — mount
                HERE, portaled in by the masthead that owns them. They are
                verbs the card publishes about itself, so they belong in the
                rollup with every other verb.

                `display: contents` — an empty host contributes no box, so a
                pane with no masthead accessory lays out exactly as before. */}
            <span
              ref={setControlsAccessoryEl}
              className="tug-pane-title-bar-accessory"
              data-slot="tug-pane-title-bar-accessory"
            />
        {/* A card's standing verbs, each as its own ghost icon button in the
            rollup — the shape a verb the card offers every time it is open
            wants. The glyph is the card's (a lucide NAME, resolved here, the
            `cardTitleStore` rule); the phrase is the registry's, so a button
            and the same command's menu item can never say different things.

            A button that cannot act right now DIMS; it never disappears — a
            row whose membership changes under the hand is one the hand cannot
            learn, and that rule is what the rollup preserves rather than
            breaks: the row's contents are constant, and it is the WHOLE row
            that comes and goes, at one predictable place, on one predictable
            gesture. Enablement is the registry's answer asked
            of the chain, and for a key-card command that query is LIVE rather
            than a snapshot, so sampling here is correct as long as this bar
            re-renders when the fact turns — which it does, because the card
            re-publishes its items when the fact that decides them changes.
            What the card adds is only the PHRASE for the dimmed state, which
            is the one part of it the registry cannot know.

            The tooltip anchors a span rather than the button: a disabled
            `.tug-button` takes `pointer-events: none`, so a bubble hung
            directly on it would never open — and the dimmed state is exactly
            when the reader most needs to be told why. */}
        {titleBarButtonItems.map((item) => {
          const entry = commandEntry(item.commandId);
          const label = entry?.title ?? item.commandId;
          const enabled =
            entry !== undefined && validateCommand(entry, commandValidationSource());
          const ItemIcon =
            item.icon !== undefined &&
            icons[item.icon as keyof typeof icons] !== undefined
              ? icons[item.icon as keyof typeof icons]
              : null;
          if (ItemIcon === null) return null;
          return (
            <TugTooltip
              key={item.commandId}
              content={enabled ? label : (item.unavailableHint ?? label)}
            >
              <span className="tug-pane-title-bar-tooltip-anchor">
                <TugButton
                  subtype="icon"
                  emphasis="ghost"
                  role="action"
                  size="sm"
                  icon={<ItemIcon />}
                  disabled={!enabled}
                  aria-label={label}
                  data-testid={`tug-pane-title-bar-item-${item.commandId}`}
                  onClick={() => dispatchCommand(item.commandId)}
                />
              </span>
            </TugTooltip>
          );
        })}
        {/* Card width. A dedicated, persistent trigger rather than a row in
            the `…` overflow above: width is reached often and carries state,
            and a control whose current value is invisible until you open it
            is the wrong shape for both. Composed as `TugPopupMenu` + a ghost
            `TugButton`, matching the stack badge and section menu beside it —
            pane chrome is one of that component's sanctioned composers.

            On EVERY pane that has a width, masthead-bearing ones included. It
            was suppressed on those for a while, on the reasoning that the
            masthead's first row is identity plus its own telemetry wave and
            this control competed with the name for it. The Session card is the
            pane whose width is retuned most often, so the one surface that most
            needs the control was the one that did not have it — and a control
            that appears on some panes and not others is a cluster the eye
            cannot learn. It sits immediately before the close box, which is
            where it lands on every other pane. */}
        {onSetWidth !== undefined && (
          // A plain bubble, not a `TugActionTooltip`: the width row is
          // ⌃⌘1/2/3, one chord per preset, and this trigger is none of them —
          // naming the current preset's chord would advertise the keystroke
          // that changes nothing. The menu's rows are where those chords
          // belong. The phrase carries the current width instead, which is the
          // fact the closed control cannot show; at a custom width `widthPreset`
          // is null and the phrase says nothing rather than claiming the
          // nearest preset, the same rule the menu's check column follows.
          <TugTooltip
            content={
              widthPreset === null || widthPreset === undefined
                ? "Set this card's width"
                : `Set this card's width — now ${CONTENT_WIDTH_LABELS[widthPreset]}`
            }
          >
            <span className="tug-pane-title-bar-tooltip-anchor">
              <TugPopupMenu
                trigger={
                  <TugButton
                    subtype="icon"
                    emphasis="ghost"
                    role="action"
                    size="sm"
                    icon={<MoveHorizontal />}
                    aria-label="Card width"
                    data-testid="tug-pane-title-bar-width-button"
                  />
                }
                align="end"
                // Controlled, and only because the rollup needs the answer.
                // The menu portals its rows outside the card, so the pointer
                // travelling to a width row leaves the title bar, ends its
                // hover, and would collapse the row this trigger is standing
                // in — leaving an open menu hanging off an anchor that is no
                // longer painted. While it stands, the rollup is held.
                open={widthMenuOpen}
                onOpenChange={setWidthMenuOpen}
                items={CONTENT_WIDTH_PRESETS.map((preset) => ({
                  id: preset,
                  label: CONTENT_WIDTH_LABELS[preset],
                  // No check at a custom width: `widthPreset` is null then, and
                  // claiming the nearest preset would be a resting lie.
                  selected: widthPreset === preset,
                }))}
                onSelect={(id) => onSetWidth(id as ContentWidth)}
                data-testid="tug-pane-title-bar-width-menu"
              />
            </span>
          </TugTooltip>
        )}
        {/* LAST in the row, and the position is the design rather than an
            ordering preference.

            The `⋯` mark this row replaces is three dots on a baseline, and its
            middle dot is the mark's centre. The row is anchored to the same
            trailing edge the mark is, with no padding on that side, so this
            button's box lands exactly on the mark's box — and the target's
            own centre dot lands exactly on the ellipsis's middle dot. Reveal
            and conceal therefore read as one glyph resolving into another in
            place, with nothing hopping sideways. Any other control here would
            put a hole, a bar, or a folder where the dot was.

            It is also the control the mark REPORTS for: bullseye is the one
            rolled-up verb carrying a posture, and it is the mark's `data-on`
            that says so at rest. The thing the dot lights for is the thing the
            dot becomes.

            A rail gets it for the same reason it gets the badge: bullseye
            writes no geometry, so a bullseyed rail keeps its width and its
            side in the store and the band keeps the inset it was already
            taking. The rail is standing somewhere else for a moment, not
            hidden, and it drops back onto its edge on exit.

            The button reports its own state rather than only acting: `data-on`
            while the pane holds the posture, which is what makes a second
            press read as an exit instead of a no-op. */}
        {onToggleBullseye !== undefined && (
          // `TugActionTooltip`, not a plain bubble: ⌃⌘B does exactly what this
          // button does, and the chip is read from the keymap registry so a
          // rebind reaches the tooltip rather than leaving an authored chord
          // behind to go stale. The phrase turns with the posture for the same
          // reason the `aria-label` does — a control that acts one way and
          // reads the other is the resting lie the label already avoids.
          <TugActionTooltip
            action={TUG_ACTIONS.TOGGLE_BULLSEYE}
            content={
              bullseye
                ? "Take this card out of bullseye"
                : "Center this card in bullseye"
            }
          >
            <TugButton
              subtype="icon"
              emphasis="ghost"
              role="action"
              size="sm"
              icon={<CircleDot />}
              className="tug-pane-title-bar-bullseye-button"
              {...(bullseye ? { "data-on": "" } : {})}
              aria-pressed={bullseye}
              aria-label={bullseye ? "Leave bullseye" : "Bullseye"}
              data-testid="tug-pane-title-bar-bullseye-button"
              onClick={onToggleBullseye}
            />
          </TugActionTooltip>
        )}
          </div>
          {/* The rollup's MARK — the row's one visible trace at rest, standing
              in the space the row itself occupies once it unfurls.

              A mark and not a button, and that is a decision rather than an
              omission. Hovering the bar is what opens the row, and the row
              covers this spot when it does, so a button here could be pressed
              to open but never pressed again to close — its own contents would
              be sitting on top of it. A control whose second press cannot
              reach it is worse than no control. What the keyboard needs is
              served by `:focus-within` on the row instead, which reveals it
              for a walk arriving with no pointer at all.

              It reports, which is the other half of its job. `data-on` when a
              verb hidden behind it is currently engaged — today that is
              bullseye, the one rolled-up control carrying a posture rather
              than an act. A card sitting in bullseye with its ⊙ tucked away
              would show nothing about the posture it holds, which is the
              resting lie this cluster is not allowed to tell. Popping ⊙ back
              out would tell the truth by making the row's membership change
              under the hand — so the mark lights instead, the geometry never
              moves, and the fact is on the surface either way.

              `aria-hidden`: the row behind it is in the accessibility tree
              whether or not it is painted, so a screen reader already reaches
              every verb. Announcing a decorative ellipsis beside them would
              add a stop that does nothing. */}
          <span
            className="tug-pane-title-bar-rollup-mark"
            data-slot="tug-pane-title-bar-rollup-mark"
            {...(bullseye ? { "data-on": "" } : {})}
            aria-hidden="true"
            data-testid="tug-pane-title-bar-rollup-mark"
          >
            <MoreHorizontal />
          </span>
        </div>
        {/* THE PLACE PAIR, pinned against the trailing edge behind only the
            close box. Two controls that report where you are, reading
            outward-in: the slot badge names the place the PANE stands in the
            imposition, the column badge names where this CARD stands inside
            that place. They sit at the cluster's one fixed end because a
            readout you glance at is worthless if you have to find it first,
            and the cluster's leading edge — where these two used to live —
            is the end that slides with every change of membership.

            The slot badge takes no condition here. `CardSlotBadge` answers
            with nothing when there is no place to name — a one-up imposition,
            a pane holding no slot, a sidebar — and those are its guards to
            hold, not this bar's to duplicate. */}
        <CardSlotBadge cardId={activeCardId} />
        {/* The column badge, on every pane that stands in a place — and now at
            depth one as well as depth many.

            The old condition was `slotStack.length > 1`, which read as
            economy and was really a hole: the badge is the only door to the
            arrange verbs, so a card alone in its column had no way to split it
            and no way to learn that splitting was a thing columns did. A place
            one card deep is still a place. The badge draws `1` over the three
            slices, which is a quiet sentence but a true one, and its menu
            carries the verb that makes it a bigger number.

            Every pane in a stack renders it — no "am I on top?" test, which
            would need a cross-pane fact the title bar does not have. What the
            user SEES therefore depends on the arrangement: in a slot stack or
            a stacked rail, occlusion hides the badge along with everything
            else on a covered pane, so a same-width stack shows exactly one. In
            a SPLIT nothing is occluded, so every member shows one — several
            badges saying the same true thing about the one place they share,
            which is the honest reading rather than a duplicate. */}
        {hasPlace && (
          // The tooltip anchors a SPAN around the menu rather than the trigger
          // button itself. Both `TugTooltip` and `TugPopupMenu` hand their
          // child to a Radix `asChild` slot, and neither wrapper forwards the
          // props or the ref that slot injects — so they cannot be nested
          // directly. A span is a DOM element both can address: the menu takes
          // the button inside it, the tooltip takes the span. Hover and the
          // inner button's focus both reach the span (React's `onFocus` is
          // `focusin`, which bubbles), and the pointerdown that opens the menu
          // is the same one Radix closes the bubble on.
          //
          // The phrase says the COUNT and then the act, in that order, and the
          // chord chip closes it. The badge is small and its glyph is
          // schematic, so a reader hovering it is asking two questions at once
          // — what am I looking at, and what happens if I press — and a
          // tooltip that answered only the second left the first to be
          // guessed from a numeral behind a stack of slices.
          //
          // `TugActionTooltip`, so the chip is read from the keymap registry
          // and a rebind reaches the bubble rather than leaving an authored
          // chord to go stale. ⌃⌘S is a TOGGLE, which is why the same chord is
          // named whether the place is stacked or split — it is the way back
          // as much as the way in.
          <TugActionTooltip
            action={TUG_ACTIONS.TOGGLE_COLUMN_SPLIT}
            content={
              onArrangePlace !== undefined && placeArrangement !== undefined
                ? placeSplit
                  ? `Band ${columnBadgeCharacter("split", badgeCount, badgeIndex)} of ${badgeCount} — press to show a card, or re-stack this ${placeArrangement.kind}`
                  : placeAlone
                    ? `One card in this ${placeArrangement.kind} — press to split it`
                    : `${badgeCount} cards in this ${placeArrangement.kind} — press to show one, or split it`
                : `${badgeCount} cards stacked here — press to show another`
            }
          >
            <span className="tug-pane-title-bar-tooltip-anchor">
              <TugPopupMenu
                trigger={
                  <TugButton
                    subtype="icon"
                    emphasis="ghost"
                    role="action"
                    size="sm"
                    /* One badge in the slot chip's footprint, rather than a
                       lucide glyph beside a numeral. A stack draws how many
                       cards are behind this one — the fact the eye cannot get,
                       since a visible stacked card is the top one by
                       construction. A split draws this member's band letter,
                       because every band of a split is visible and the badge's
                       job there is naming rather than revealing. */
                    icon={
                      <TugColumnBadge
                        kind={badgeKind}
                        count={badgeCount}
                        index={badgeIndex}
                        // The cluster draws the RUN and lets the character
                        // name the position. At this size a lit rung is a
                        // fraction of a pixel of extra weight in a ladder the
                        // height of a lowercase letter — it reads as grit on
                        // the badge rather than as an answer, and the
                        // character beside it is already saying the same
                        // thing exactly. The Cards row keeps the mark, where
                        // the slot picker's own selection fill teaches it.
                        showLevel={false}
                      />
                    }
                    className="tug-pane-title-bar-stack-badge"
                    aria-label={
                      placeSplit
                        ? `Split of ${badgeCount} cards, band ${columnBadgeCharacter("split", badgeCount, badgeIndex)}`
                        : placeAlone
                          ? "Alone in this place"
                          : `Stack of ${badgeCount} cards`
                    }
                    data-testid="tug-pane-title-bar-stack-badge"
                    // The badge is a door into the OTHER cards in this place —
                    // showing one, splitting the column. A held card is not a
                    // card to be navigated away from.
                    disabled={modalHeld}
                  />
                }
                align="end"
                open={stackMenuOpen}
                onOpenChange={setStackMenuOpen}
                items={[
                  ...slotStack.map((entry) => {
                    // Each row is a miniature of the title bar it stands for: the
                    // pane's own icon, then the pane's own title, in that order and
                    // from the same `CardMeta.icon` the real title bar draws.
                    const RowIcon =
                      entry.icon !== undefined && entry.icon in icons
                        ? icons[entry.icon as keyof typeof icons]
                        : null;
                    return {
                      id: entry.paneId,
                      label: entry.title,
                      ...(RowIcon === null
                        ? {}
                        : { icon: React.createElement(RowIcon) }),
                      // Set on every row, not just the checked one, so the check
                      // column aligns across the menu.
                      selected: entry.selected,
                    };
                  }),
                  // The place's own verbs, below its members. Their ids are
                  // prefixed so they cannot collide with a paneId. Alone in a
                  // place there is nothing to stack and nothing to equalize,
                  // so only the verb that changes that is offered.
                  ...(onArrangePlace === undefined || placeArrangement === undefined
                    ? []
                    : placeSplit
                      ? [
                          { id: PLACE_VERB_STACK, label: "Stack" },
                          ...(placeAlone
                            ? []
                            : [{ id: PLACE_VERB_EQUALIZE, label: "Equalize Heights" }]),
                        ]
                      : [{ id: PLACE_VERB_SPLIT, label: "Split Vertically" }]),
                ]}
                onSelect={(id) => {
                  if (id === PLACE_VERB_SPLIT) return onArrangePlace?.("split");
                  if (id === PLACE_VERB_STACK) return onArrangePlace?.("stack");
                  if (id === PLACE_VERB_EQUALIZE) return onArrangePlace?.("equalize");
                  const entry = slotStack.find((e) => e.paneId === id);
                  if (entry) onRevealPane?.(entry);
                }}
                data-testid="tug-pane-title-bar-stack-menu"
              />
            </span>
          </TugActionTooltip>
        )}

        {closable && (
          // Pane-level close confirmation: every pane's X button —
          // single-tab and multi-tab alike — opens a "Close …?" confirm
          // popover (the shared `TugConfirmPopover`), so a pane is never
          // discarded on a single stray click. Option-click on X bypasses
          // the popover and closes immediately (see `handleClosePointerUp`).
          //
          // Controlled mode: the X button and the `requestClose*` handles
          // drive `closeOpen` (with `closeIntent` carrying the copy and
          // confirm action), and the X is the popover's anchor (captured
          // via `setCloseAnchorEl`). The X
          // is a plain button, NOT a `TugPopoverTrigger`, because its
          // pointer-capture open flow on `pointerup` would race Radix's
          // auto-toggle and flash the popover closed. The component owns the
          // focus model — default-button seed, Cancel↔Close arrow nav, and
          // Escape / Cmd-. cancel (it claims first responder on focus so the
          // keyboard cancel keys land on it, not the card behind it).
          <>
            {/* The tooltip anchors the SPAN, never the button — the one
                composition this control cannot take. The X does not run the
                ordinary click protocol: it captures the pointer on
                `pointerdown` (preventing the default), decides on `pointerup`
                by hit-testing its own rect, and is itself the anchor the
                confirm popover hangs from. Making it a Radix trigger directly
                puts a second pointer-handling primitive into its own handler
                chain, and Option-click stopped closing the pane —
                reproducibly, and with the bubble's open delay pushed past the
                test, so it was the composition and not the bubble. Around the
                span, Radix's listeners sit on an element the button's
                handlers never consult, and the button keeps its own props
                untouched. at0040 is what holds this. */}
            {/* The chord named is the one that does what THIS press does, so
                it turns with the pane: on a single-card pane the X closes the
                card and ⌘W is its keyboard twin, while on a multi-tab pane it
                takes the whole stack and the twin is ⌥⌘W (Close All Tabs).
                `CLOSE_PANE` is neither — it is the internal target action the
                X dispatches, and it holds no binding to advertise. */}
            <TugActionTooltip
              action={isMultiTab ? TUG_ACTIONS.CLOSE_ALL : TUG_ACTIONS.CLOSE}
              content={isMultiTab ? `Close all ${cardCount} tabs` : "Close this card"}
            >
              <span className="tug-pane-title-bar-tooltip-anchor">
                <TugButton
                  ref={setCloseAnchorEl}
                  subtype="icon"
                  emphasis="ghost"
                  role="action"
                  size="sm"
                  icon={<X />}
                  onPointerDown={handleClosePointerDown}
                  onPointerUp={handleClosePointerUp}
                  onClick={handleCloseClick}
                  // Nothing but the run's own settling or its Cancel takes a
                  // held card down. Disabled rather than guarded, because a
                  // dimmed box is an answer the eye gets before the press.
                  disabled={modalHeld}
                  aria-label={
                    isMultiTab ? `Close pane (${cardCount} tabs)` : "Close card"
                  }
                  data-testid="tug-pane-close-button"
                />
              </span>
            </TugActionTooltip>
            <TugConfirmPopover
              open={closeOpen}
              anchorEl={closeAnchorEl}
              onConfirm={handleCloseConfirm}
              onCancel={handleCloseCancel}
              side="bottom"
              // The X sits at the card's trailing edge; anchor the popover's
              // end edge to it so it hangs back into the card interior rather
              // than centering under the X and spilling past the card's right
              // side. The arrow then points up at the X, naming the control
              // that opened it.
              align="end"
              arrow
              sideOffset={6}
              // Pin the popover inside the card it is confirming so it can
              // never overlap a neighboring card — an overlap makes the
              // targeted card ambiguous. Radix shifts/flips within this
              // boundary instead of the viewport. `sticky="always"` drops the
              // attach-to-anchor shift limiter so the popover slides fully
              // inside the card even when the X is dragged toward the edge;
              // the padding keeps it off the card's border.
              collisionBoundary={closeAnchorEl?.closest(".tug-pane-chrome") ?? null}
              sticky="always"
              collisionPadding={8}
              message={
                closeIntent?.message ??
                (isMultiTab ? `Close ${cardCount} Tabs?` : "Close Card?")
              }
              confirmLabel={closeIntent?.confirmLabel ?? (isMultiTab ? "Close All" : "Close")}
              confirmRole="action"
              cancelLabel="Cancel"
            />
          </>
        )}
      </div>
    </div>
  );
});

// ===========================================================================
// Portal + dirty contexts (card content consumes these)
// ===========================================================================

/**
 * React context: the pane frame's root element (`HTMLDivElement`, the
 * `.tug-pane-chrome` host). Sheet and tooltip layers portal here so overlays attach
 * inside the pane's chrome. Card content outside the `TugPane` tree
 * (e.g. `CardHost`) re-bridges this via `pane-root-registry`.
 */
export const TugPanePortalContext = createContext<HTMLDivElement | null>(null);

/**
 * React context: the pane frame element (`HTMLDivElement`, the `.tug-pane`
 * outer frame, parent of the chrome). Pane-modal surfaces (`TugSheet`,
 * future modal-class surfaces) portal into this element so their panel
 * sits inside the pane's stacking context — peer panes z-stacked above
 * paint above the panel without manual z coordination [D19, D20].
 *
 * The frame's `position: absolute` + inline `z-index` makes it its own
 * stacking context. The frame has `overflow: visible` (default) so a
 * panel whose natural height exceeds the chrome's body can extend into
 * the canvas grid below — without escaping the pane's stacking context.
 *
 * Standalone consumers (gallery preview, tests rendered without a
 * `TugPane` ancestor) read `null` and fall back to `document.body` —
 * same shape as `useCanvasOverlay`'s null fallback. Production code
 * always renders pane-modal surfaces inside a `TugPane`.
 */
export const TugPaneFrameContext = createContext<HTMLDivElement | null>(null);

export const CardDirtyContext = createContext<(() => void) | null>(null);

/**
 * Returns a stable `markDirty` callback from `CardDirtyContext`, or a no-op
 * outside a provider. Card content uses this to participate in the pane's
 * debounced auto-save path alongside scroll/selection listeners.
 */
export function useCardDirty(): () => void {
  const markDirty = useContext(CardDirtyContext);
  return markDirty ?? noop;
}

function noop(): void {}

// ---------------------------------------------------------------------------
// snapshotCardRects
// ---------------------------------------------------------------------------

/**
 * Snapshot all `.tug-pane[data-pane-id]` elements as canvas-relative Rects.
 * Optionally excludes a pane by ID.
 *
 * `getBoundingClientRect` returns visual (post-`body { zoom }`) pixels, but card
 * frames are positioned with `style.left/top` in layout pixels. Dividing by
 * `zoom` yields layout-space rects so they line up with the moving frame's
 * position and size (which come from layout-space `style`/`offsetWidth`). All
 * snap math then runs in one consistent space.
 */
/** Per-edge offset (layout px) from a card frame's measured box to its visible
 *  border. See measureGuideEdgeOffsets. */
interface GuideEdgeOffsets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const ZERO_EDGE_OFFSETS: GuideEdgeOffsets = { left: 0, right: 0, top: 0, bottom: 0 };

/**
 * Measure how far each visible card edge (the `.tug-pane-chrome` border box) sits
 * from the measured `.tug-pane` frame box that snap geometry uses.
 *
 * The chrome is `border-box` with `width/height: 100%` + a 1px border, so its
 * border box normally coincides with the frame box and the offsets are zero.
 * Reading the actual delta (rather than assuming a box model) keeps snap guides
 * landing on the visible border exactly, whatever the border/box-sizing turns
 * out to be. All cards share this geometry, so one measurement per gesture
 * suffices. Returned in layout px (÷ zoom).
 */
function measureGuideEdgeOffsets(frame: HTMLElement, zoom = 1): GuideEdgeOffsets {
  const chrome = frame.querySelector(".tug-pane-chrome");
  if (!chrome) return ZERO_EDGE_OFFSETS;
  const f = frame.getBoundingClientRect();
  const c = chrome.getBoundingClientRect();
  return {
    left: (c.left - f.left) / zoom,
    right: (c.right - f.right) / zoom,
    top: (c.top - f.top) / zoom,
    bottom: (c.bottom - f.bottom) / zoom,
  };
}

function snapshotCardRects(
  canvasBounds: DOMRect | null,
  excludeId?: string,
  zoom = 1,
): { id: string; rect: Rect }[] {
  const results: { id: string; rect: Rect }[] = [];
  // Every pane is a snap candidate — including a pinned rail. A free pane
  // dragged with Option snaps its edge to the rail's edge just as it does to
  // any other card, so a card can be abutted to it. A rail exposes the same
  // `getBoundingClientRect` as any pane, so its rect needs no special case.
  const els = document.querySelectorAll<HTMLElement>(
    ".tug-pane[data-pane-id]",
  );
  els.forEach((el) => {
    const paneId = el.getAttribute("data-pane-id");
    if (!paneId || paneId === excludeId) return;
    const domRect = el.getBoundingClientRect();
    results.push({
      id: paneId,
      rect: {
        x: (domRect.left - (canvasBounds ? canvasBounds.left : 0)) / zoom,
        y: (domRect.top - (canvasBounds ? canvasBounds.top : 0)) / zoom,
        width: domRect.width / zoom,
        height: domRect.height / zoom,
      },
    });
  });
  return results;
}

// ---------------------------------------------------------------------------
// Canvas padding for resize clamping
//
// Resize handles are hard-clamped to the canvas edges with this padding.
// Dragging uses the relaxed Finder-style rules below instead.
// ---------------------------------------------------------------------------

const CANVAS_PADDING = 2;

// ---------------------------------------------------------------------------
// Finder-style title bar visibility constraints (drag only)
//
// When dragging, cards may overhang canvas edges, but enough of the title bar
// must remain visible and grabbable. Modeled after macOS Finder window
// constraining.
// ---------------------------------------------------------------------------

/** Minimum horizontal px of title bar visible when card overhangs left/right. */
const TITLE_BAR_VISIBLE_MIN_X = 100;

/** Minimum vertical px of title bar visible when card overhangs bottom. */
const TITLE_BAR_VISIBLE_MIN_Y = CARD_TITLE_BAR_HEIGHT;

/**
 * Width of a snap guide line in layout px. Must match the `border` width on
 * `.snap-guide-line-x` / `.snap-guide-line-y` in chrome.css so a right/bottom-edge
 * guide can be pulled back by exactly one line width to sit on the card's edge.
 */
const SNAP_GUIDE_LINE_PX = 2;

/**
 * How stale the last pointer sample may be and still count as the hand's
 * motion at the release, in milliseconds.
 *
 * A drop inherits the hand's velocity ([P05] of
 * `arc/layout-imposer-polish.md`), and the question that answers is "how
 * fast was the hand going as it opened" — not "how fast was it going at some
 * point during the drag". Four display frames is long enough to survive a
 * dropped frame and short enough that a hand which paused before letting go
 * reads, correctly, as stopped.
 */
const RELEASE_VELOCITY_WINDOW_MS = 68;

/**
 * Freeze an imposed frame into free pixel geometry at the rect it currently
 * shows, and hand back that rect in canvas coordinates.
 *
 * An imposed frame is positioned by CSS pins (`left`/`right` against the rail
 * inset, `top`/`bottom` against the canvas), which the drag and resize
 * machines' per-frame writes would fight. Both gestures release the pane from
 * its slot at the moment they become a move — not at pointer-down — by
 * converting it here: the DOM keeps showing exactly what the user was looking
 * at, and the commit that follows carries `evictSlot`, so React re-renders in
 * free mode consistent with the DOM.
 *
 * Seeding the gesture from this measurement rather than from `position` matters
 * — an imposed pane's stored position holds stale last-known values, so a
 * gesture seeded from state would teleport the frame on its first move.
 */
function releaseImposedFrame(
  frame: HTMLElement,
  canvas: DOMRect | null,
): { x: number; y: number; width: number; height: number } {
  const zoom = getTugZoom() || 1;
  const rect = frame.getBoundingClientRect();
  const released = {
    x: (rect.left - (canvas ? canvas.left : 0)) / zoom,
    y: (rect.top - (canvas ? canvas.top : 0)) / zoom,
    width: rect.width / zoom,
    height: rect.height / zoom,
  };
  frame.style.right = "";
  frame.style.bottom = "";
  frame.style.left = `${released.x}px`;
  frame.style.top = `${released.y}px`;
  frame.style.width = `${released.width}px`;
  frame.style.height = `${released.height}px`;
  return released;
}

/**
 * How far the pointer must travel before a press becomes a gesture — on the
 * title bar (drag), on a resize handle, and on a rail's deck-facing edge.
 *
 * Under this, the press is a click: it focuses the pane and commits nothing.
 * The distinction matters most for a pane whose geometry is derived — a slotted
 * card, or a pinned rail — because committing a move or a resize is what
 * releases it from the arrangement, and that should take an actual drag.
 */
export const DRAG_MOVE_THRESHOLD_PX = 3;

/** Height of the title bar chrome inside `.tug-pane-body` (below the outer frame). */
const HEADER_HEIGHT_PX = 28;
const DEFAULT_MIN_CONTENT: { width: number; height: number } = { width: 100, height: 60 };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Where a pane stands on the rail it shares — the side, the rail's arrangement,
 * and this pane's place in it. Resolved by `DeckCanvas`, which is the only
 * party that can see a rail's other members.
 *
 * In a **stack** every member takes the same geometry — one gap below the
 * canvas top, the deeper gap above its bottom — and z-order decides which you
 * see; `memberIndex` then means only where the member sits in the picker's
 * list. In a **split** the index IS geometry: it names the member's share of
 * the run, and the frame pins itself to the seams either side of it.
 */
export interface SidebarStackStanding {
  /** The deck edge the rail holds. */
  side: SidebarSide;
  /** Which sidebar card this pane is, as the arrangement record names it —
   *  the key an order or a height weight is stored under. */
  componentId: string;
  /** How many cards stand on the rail — what tells the title bar it is in a
   *  stack worth offering a picker for. */
  count: number;
  /** How the members stand against one another. */
  mode: RailMode;
  /** This pane's place in the rail's vertical order, top to bottom. */
  memberIndex: number;
}

/**
 * Props for the TugPane component (frame + pane chrome).
 */
export interface TugPaneProps {
  /** Window position, size, id, and width preset from DeckState. */
  stackState: TugPaneState;
  /** Default metadata for the window (from card registration). */
  meta: CardMeta;
  /**
   * The active card's registered layout role. Companion to {@link meta}: a
   * single-card pane has no `cards` array to resolve a registration from, so
   * the caller — which already holds that registration — hands the role down.
   * A stacked pane resolves it from its own active card instead. `"sidebar"`
   * is what puts the pane in the rail chrome tier.
   */
  layoutRole?: LayoutRole;
  /**
   * Minimum content area size (below title bar + accessory).
   * Total min-size = header + accessory + this region.
   */
  minContentSize?: { width: number; height: number };
  /** Top accessory when single-tab; ignored when multi-tab tab bar is shown. */
  accessory?: React.ReactNode | null;
  /** All cards in this window; when length > 1, the tab bar is shown. */
  cards?: readonly CardState[];
  /**
   * Active card id for merge hit-testing and tab chrome.
   * Defaults to `stackState.activeCardId` when omitted.
   */
  activeCardId?: string;
  /** Title prefix when multi-tab: `"${cardTitle}: ${title}"`. */
  cardTitle?: string;
  /** Families for the [+] type picker (multi-tab). */
  acceptedFamilies?: readonly string[];
  /** Close the window or last card (from title bar). */
  onClose?: () => void;
  /** Called on drag-end or resize-end (structure-zone commit). */
  onCardMoved: (
    id: string,
    position: { x: number; y: number },
    size: { width: number; height: number },
    opts?: MovePaneOptions,
  ) => void;
  /**
   * This pane's place in the imposition chain, when it holds a slot. Resolved
   * by `DeckCanvas`, which is the only vantage point that can see every
   * slotted pane's width at once — a pane cannot work out its own offset down
   * the chain from its own state. Absent for a free pane and for a rail pane.
   */
  placement?: ImposedPlacement;
  /**
   * True while this pane stands in bullseye — centered in the band at the
   * comfy width, over the full vertical run, with every other pane receded.
   *
   * A presentation over whichever geometry mode the pane already holds, not a
   * fourth mode: it takes precedence over both derived modes while it lasts,
   * and the pane's stored `position` / `size` / `slot` / `widthPreset` are
   * untouched throughout, so leaving bullseye restores nothing — nothing was
   * disturbed. Resolved by `DeckCanvas`, which owns the deck state the
   * posture lives in.
   */
  bullseye?: boolean;
  /**
   * Set while ANOTHER pane stands in bullseye and this one is a content pane
   * — so this pane gets out of the way. The value is the bullseyed pane's
   * PRE-bullseye centre as a CSS length expression: this pane leaves by the
   * left edge if it sits left of that line and by the right edge if it sits
   * right of it.
   *
   * Sorting around the bullseyed card rather than around the canvas centre is
   * what makes crossings impossible: each pane leaves by the side it was
   * already on, so nothing slides through the card arriving at the centre.
   *
   * Set on content panes only. Rails keep their pins and recede in place: a
   * rail that left the deck would take the band's insets with it, moving the
   * bullseyed card the moment the posture began.
   *
   * Like {@link bullseye} itself this writes nothing — the stored
   * `position` / `size` are untouched and the pane slides straight back on
   * exit. Resolved by `DeckCanvas`, which owns the deck state.
   */
  bullseyeExit?: string;
  /**
   * The deck's content-width preset in pixels — the width an ordinary card
   * opens at in this arrangement. Deck state, so `DeckCanvas` resolves it.
   *
   * Only a size-locked pane reads it, and only to size its SLOT: About is 320
   * wide by registration, but the slot it stands in is the one every other
   * card in the arrangement gets, and About is centred inside that. A pane
   * that takes its own width for its slot ignores this entirely.
   */
  contentWidthPx?: number;
  /**
   * Every pane sharing this pane's slot, topmost first — the slot's stack.
   * Resolved by `DeckCanvas` for the same reason `placement` is: a pane cannot
   * see its slot's other occupants from its own state.
   *
   * The entries arrive display-resolved (title and topmost flag already
   * decided), so the title bar renders its stack picker from props alone and
   * never reaches for the deck store. Absent for a free pane and for a rail,
   * which hold no slot and therefore stand in no stack.
   */
  slotStack?: readonly SlotStackEntry[];
  /**
   * Raise the pane a stack-picker row names. Wired in `DeckCanvas`, which is
   * where the store lives; the pane and its title bar only report the choice.
   */
  onRevealPane?: (entry: SlotStackEntry) => void;
  /**
   * Set only on a pane standing in a rail: where that rail stands and where
   * this pane stands on it. A rail is imposed as the strip's fixed end rather
   * than a link in its chain, so its panes take a pin instead of a `placement`:
   * resizable only on the deck-facing edge, and excluded from snap and merge.
   * Resolved by `DeckCanvas` — the pane carries no marker of its own ([P04]).
   */
  sidebarStack?: SidebarStackStanding;
  /**
   * Set only on a pane standing in a SPLIT slot: which slot, which position in
   * its column, and how many members divide the run.
   *
   * The content-side twin of the `sidebarStack` member fields, and resolved by
   * `DeckCanvas` for the same reason — a pane cannot see its slot's other
   * occupants, and a member's index is a fact about the column rather than
   * about the pane. Absent on a stacked slot, on a column of one, on a free
   * pane, and on a rail, all of which take the undivided run.
   */
  columnMember?: ColumnMemberPlacement;
  /**
   * Set on a pane hosting a sidebar card, pinned or not. Separate from
   * {@link sidebarStack}, which says only where a PINNED rail stands: a rail
   * dragged off its pin is an ordinary free pane for geometry purposes but is
   * still a rail, and the one thing that stays true either way is that it
   * hosts a singleton card and never accepts a merge.
   */
  isSidebarPane?: boolean;
  /**
   * Called when a card drag ends over another card's tab bar ([D45]).
   *
   * Receives the source card id, the target card id, and the insertion index
   * within the target's tab array. The active tab of the source card is merged
   * into the target card at insertIndex.
   *
   * Wired in DeckCanvas to `moveCardToPane`. When this prop is not provided,
   * card drag always falls back to onCardMoved (no merge behaviour).
   */
  onCardMerged?: (sourceCardId: string, targetCardId: string, insertIndex: number) => void;
  /**
   * The canvas's half of the drop-zone drag ([P09]): what places this pane may
   * land in, how the live one is shown, and how a release commits.
   *
   * Absent for a pane on a canvas with no arrangement to land in, in which case
   * the gesture is the ordinary free drag it has always been.
   */
  dropZones?: DropZoneHost;
  /** CSS z-index for stacking order. */
  zIndex: number;
  /**
   * Size policy for this card type. Enforces min as a floor (content-reported
   * min cannot go below this) and max as a ceiling during resize.
   * Falls back to DEFAULT_SIZE_POLICY when omitted.
   */
  sizePolicy?: CardSizePolicy;
}

/**
 * A resolved `left` value as a term usable inside a CSS math expression.
 *
 * React writes a bare number as `px`; the imposer writes a `calc()` string.
 * Nesting a `calc()` inside another calculation is legal — it reads as
 * parenthesised — so both forms compose into the bullseye-exit clamp without
 * the caller having to know which mode produced the pin. Anything else (an
 * absent or non-length value, which no geometry mode emits) falls back to
 * `0px` rather than producing an invalid expression that would drop the whole
 * declaration.
 */
function cssLength(value: CSSProperties["left"]): string {
  if (typeof value === "number") return `${value}px`;
  if (typeof value === "string" && value.length > 0) return value;
  return "0px";
}

// ---------------------------------------------------------------------------
// Resize edge descriptors
// ---------------------------------------------------------------------------

// One frozen empty array for every pane that holds no slot, so an absent
// `slotStack` prop does not hand the title bar a fresh identity per render.
const EMPTY_SLOT_STACK: readonly SlotStackEntry[] = [];

type ResizeEdge = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

const RESIZE_EDGES: ResizeEdge[] = ["n", "s", "e", "w", "nw", "ne", "sw", "se"];

// Gutter reserved on the deck side so a rail can't be widened to cover
// the whole viewport. The effective max width is `window.innerWidth - this`.
const RAIL_MIN_GUTTER_PX = 80;

// Safety net for a resize episode opened by a pointer gesture. Pointer-up is
// the real end and always fires; this only covers a pane torn down mid-drag,
// so it is sized to be unreachable by any drag a person actually performs
// rather than to approximate one.
const GESTURE_EPISODE_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// TugPane
// ---------------------------------------------------------------------------

/**
 * TugPane — positions, drags, resizes, and hosts a window's cards on the canvas.
 */
export function TugPane({
  stackState,
  meta,
  layoutRole,
  minContentSize: minContentSizeProp,
  accessory = null,
  cards,
  activeCardId: activeCardIdFromProps,
  cardTitle,
  acceptedFamilies,
  onClose,
  onCardMoved,
  sizePolicy: sizePolicyProp,
  onCardMerged,
  dropZones,
  zIndex,
  placement,
  contentWidthPx,
  slotStack = EMPTY_SLOT_STACK,
  onRevealPane,
  sidebarStack,
  isSidebarPane = false,
  bullseye = false,
  bullseyeExit,
  columnMember,
}: TugPaneProps) {
  const sidebarSide = sidebarStack?.side;
  // A split rail's member takes its share of the run instead of the whole of
  // it. Passed to the imposer rather than resolved here — the pins are its
  // arithmetic, and a rail of one is stacked geometry whatever the mode says,
  // so a side split while only one card stands on it looks exactly as it did.
  const railSplit =
    sidebarStack !== undefined &&
    sidebarStack.mode === "split" &&
    sidebarStack.count > 1;
  const railMember =
    railSplit && sidebarStack !== undefined
      ? {
          member: {
            side: sidebarStack.side,
            index: sidebarStack.memberIndex,
            count: sidebarStack.count,
          },
        }
      : undefined;
  const { id, position, size } = stackState;
  // Two derived geometry modes, both placed by `lib/layout-imposer.ts`.
  //
  // Pinned — a rail card, while it is standing at its side. It holds that side
  // at a fixed pin and keeps its own width, so it exposes only its deck-facing
  // resize edge and is excluded from merge. It is DRAGGABLE, and dragging it
  // is exactly how it stops being pinned: the commit releases it, `sidebarSide`
  // arrives undefined on the next render, and it becomes a free pane in the
  // deck like any other.
  //
  // Imposed — a slotted pane. It derives its position from its slot's anchor
  // and its height from the canvas, instead of from `position`. Its width is
  // still its own; the imposer never touches it.
  //
  // The two are mutually exclusive, which the deck-state invariant already
  // guarantees (a rail pane never carries a slot); the check here keeps the
  // render honest against a hand-built state. A free pane is neither and uses
  // its stored `position`/`size`. Every mode still owns its geometry [L09].
  const pinned = sidebarSide !== undefined;
  const imposed = !pinned && placement !== undefined;
  // All three place the frame by CSS pins rather than by stored pixels, so all
  // three need the same two things at gesture time: a freeze of the live rect
  // before the first move, and an `evictSlot` on the commit that follows. A
  // bullseyed pane's stored rect is stale for exactly the reason the other
  // two's are — the frame is somewhere the store never said — so a drag on one
  // without this would jump it to that stale position at the threshold
  // crossing. Read from a ref so the drag and resize machines' `useCallback`
  // identities do not churn with the arrangement.
  const derivedRef = useRef(pinned || imposed || bullseye);
  derivedRef.current = pinned || imposed || bullseye;
  const activeCardId = activeCardIdFromProps ?? stackState.activeCardId;

  // Ref to the frame DOM element for appearance-zone style mutations.
  const frameRef = useRef<HTMLDivElement>(null);

  // Resolved size policy: use prop or fall back to DEFAULT_SIZE_POLICY.
  const sizePolicy = sizePolicyProp ?? DEFAULT_SIZE_POLICY;

  // Min-size reported by chrome + accessory measurement, floored to sizePolicy.min.
  const [minSize, setMinSize] = useState<{ width: number; height: number }>({
    width: sizePolicy.min.width,
    height: sizePolicy.min.height,
  });

  // Latest minSize held in a ref so resize closure always sees current value
  // without needing to be re-created every time minSize state updates.
  const minSizeRef = useRef(minSize);
  minSizeRef.current = minSize;

  // Max-size from policy (undefined = unbounded). Held in a ref so the resize
  // closure always reads the current value without re-creation.
  const maxSizeRef = useRef(sizePolicy.max);
  maxSizeRef.current = sizePolicy.max;

  const stackId = id;
  const minContentSize = minContentSizeProp ?? DEFAULT_MIN_CONTENT;
  const store = useDeckManager();

  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null);
  // Frame element exposed via TugPaneFrameContext and bridged through
  // `pane-frame-registry` for consumers (card content) that live
  // outside the pane's React tree. The same DOM node is also tracked
  // through frameRef.current for direct DOM access in drag/resize
  // handlers; the callback ref keeps both in sync. State (not just
  // the ref) is required so React-tree consumers re-render when the
  // frame mounts. [D19]
  const [frameEl, setFrameEl] = useState<HTMLDivElement | null>(null);
  const frameRefCallback = useCallback((el: HTMLDivElement | null) => {
    frameRef.current = el;
    setFrameEl(el);
  }, []);
  const contentRef = useRef<HTMLDivElement>(null);

  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const activeCardIdRef = useRef(activeCardId);
  activeCardIdRef.current = activeCardId;

  const performSelectCard = useCallback(
    (newCardId: string) => {
      // Route the intra-pane tab switch through `transferFocusForActivation`
      // Tab row: this is row 1 of the
      // activation trigger taxonomy: tab click within a pane.
      //
      // The helper's five-step body subsumes the previous explicit
      // save + setActiveCardInPane pair: step 1 saves the outgoing
      // bag (skipped for null / same-card / outgoingWillBeDestroyed),
      // step 2 invokes `commitMutation` inside `flushSync` so the
      // incoming card's `display: none` flips to `display: contents`
      // before resolution, steps 3–5 resolve / gate / focus.
      //
      // The `flushSync` sandwich is load-bearing here: tab clicks
      // dispatch through React's synthetic event system, so without
      // it `setActiveCardInPane`'s `notify()` would be batched and
      // step 5's `.focus()` would land on a still-`display:none`
      // element (silent failure). See [AT0001] closure
      // gate.
      transferFocusForActivation({
        outgoingCardId: activeCardIdRef.current ?? null,
        incomingCardId: newCardId,
        store,
        commitMutation: () => store.setActiveCardInPane(stackId, newCardId),
      });
    },
    [store, stackId],
  );

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    paneContentRegistry.register(stackId, el);
    return () => {
      paneContentRegistry.unregister(stackId);
    };
  }, [stackId]);

  useLayoutEffect(() => {
    if (!cardEl) return;
    paneRootRegistry.register(stackId, cardEl);
    return () => {
      paneRootRegistry.unregister(stackId);
    };
  }, [stackId, cardEl]);

  // Bridge the frame element through `pane-frame-registry` so card
  // content rendered via `CardPortal` (which lives outside the pane's
  // React tree) can subscribe and re-provide `TugPaneFrameContext` at
  // the card-host position. Without this bridge, pane-modal surfaces
  // inside card content would fall back to `document.body` and lose
  // per-pane stacking. [D19, D20]
  useLayoutEffect(() => {
    if (!frameEl) return;
    paneFrameRegistry.register(stackId, frameEl);
    return () => {
      paneFrameRegistry.unregister(stackId);
    };
  }, [stackId, frameEl]);

  // Imperative handle on the title bar so the chain-action close path
  // can route through the same confirm popover the X button opens.
  // Wired below into the `TUG_ACTIONS.CLOSE` responder.
  const titleBarRef = useRef<CardTitleBarHandle>(null);

  // Chain-action close (Cmd-W via TUG_ACTIONS.CLOSE). Browser-standard
  // "close the active tab" semantics: multi-tab → remove the active
  // card with no confirm (one of N tabs is recoverable). Single-tab →
  // delegate to the title bar's `requestClose()`, which honours the
  // pane's `confirmClose` policy: opens the popover when the active
  // card opts in, closes immediately otherwise. This keeps Cmd-W and
  // the X button symmetric: a pane that confirms on click also
  // confirms on key, and a pane that doesn't never traps Cmd-W behind
  // a guard.
  const handleChromeClose = useCallback(() => {
    const currentCards = cardsRef.current;
    const currentActiveId = activeCardIdRef.current;
    if (currentCards && currentCards.length > 1 && currentActiveId) {
      // Multi-tab: Cmd-W removes only the active card. Honour that
      // card's own `confirmClose` policy — pop a single-card confirm
      // before discarding an opt-in card (e.g. the Session card), remove
      // immediately otherwise. (The whole-pane "Close N Tabs?" guard
      // belongs to the X button and the close-all command, not to the
      // single-tab close Cmd-W performs here.)
      const activeCard = currentCards.find((c) => c.id === currentActiveId);
      const reg = activeCard ? getRegistration(activeCard.componentId) : undefined;
      // The card's own word on the close, live: it may be holding nothing
      // (waive the guard) or holding something it can name (word the
      // popover with it).
      const advice = readCardCloseAdvice(currentActiveId);
      const needsConfirm =
        reg?.defaultMeta.confirmClose === true && advice?.waive !== true;
      titleBarRef.current?.requestCloseWith({
        needsConfirm,
        message: advice?.message ?? "Close Card?",
        confirmLabel: "Close",
        onConfirm: () => store.removeCard(stackId, currentActiveId),
      });
    } else {
      titleBarRef.current?.requestClose();
    }
  }, [store, stackId]);

  // Title-bar X close. Always closes the entire pane. CardTitleBar
  // is responsible for surfacing the confirm popover before calling
  // this — by the time we get here the user has already confirmed,
  // or Option-clicked the X to skip the confirmation outright.
  const handleTitleBarClose = useCallback(() => {
    onClose?.();
  }, [onClose]);

  // Close All Card Tabs (TUG_ACTIONS.CLOSE_ALL — File ▸ Close All Card Tabs,
  // ⌥⌘W). Closes the entire focused pane (every hosted tab). The
  // confirm rule is per-card: pop the "Close N Tabs?" guard only when at
  // least one hosted card opts into `confirmClose`, close immediately
  // otherwise. This differs from the X button, whose multi-tab close
  // always confirms — the menu command is a deliberate gesture, the X a
  // single stray-click target. The Swift menu enables the item only for
  // a multi-card focused pane; the `count > 1` copy guards the rare
  // stray dispatch onto a single-card pane.
  const handleCloseAll = useCallback(() => {
    const currentCards = cardsRef.current;
    const count = currentCards?.length ?? 1;
    const anyConfirms = !!currentCards?.some(
      (c) =>
        getRegistration(c.componentId)?.defaultMeta.confirmClose === true &&
        !cardWaivesCloseConfirm(c.id),
    );
    titleBarRef.current?.requestCloseWith({
      needsConfirm: anyConfirms,
      message: count > 1 ? `Close ${count} Tabs?` : "Close Card?",
      confirmLabel: count > 1 ? "Close All" : "Close",
      onConfirm: () => onClose?.(),
      // Every hosted card dies with the pane — visit each dirty one.
      guardScope: "pane",
    });
  }, [onClose]);

  // Single-flight latch for the tab-× close guard, so a double-click on a
  // tab's × doesn't stack two sheets.
  const closeTabGuardRunningRef = useRef(false);

  const { ResponderScope, responderRef } = useResponder({
    id: stackId,
    kind: "card",
    actions: {
      [TUG_ACTIONS.CLOSE]: (_event: ActionEvent) => handleChromeClose(),
      [TUG_ACTIONS.CLOSE_ALL]: (_event: ActionEvent) => handleCloseAll(),
      // The X button, aimed from elsewhere — today the Cards card's pane row. It
      // delegates to the same `requestClose()` the chrome close goes through,
      // so a remote close box inherits the X's whole policy rather than a
      // second, weaker one: every hosted card's save guard runs, and a
      // multi-tab pane still asks "Close N Tabs?" before anything dies.
      [TUG_ACTIONS.CLOSE_PANE]: (_event: ActionEvent) => {
        titleBarRef.current?.requestClose();
      },
      // Same shape as CLOSE_PANE: the pane answers the chain by calling an
      // imperative handle on the title bar, which owns the transient UI.
      [TUG_ACTIONS.REVEAL_STACK]: (_event: ActionEvent) => {
        titleBarRef.current?.revealStack();
      },
      // The depth pair: switch within the slot's stack without reading
      // anything. Nothing transient is put on screen, so neither reaches the
      // title bar.
      //
      // NEXT raises the LAST entry: `slotStack` is topmost-first, so that is
      // the pane buried longest, raised through the same `onRevealPane` the
      // picker's rows go through — one raise policy for both. Raising the
      // bottom-most is what makes repeated presses a ring rather than a
      // two-pane ping-pong — every raise sends the outgoing front pane one
      // place back, so a depth-N slot is home again after N presses and the
      // user can count instead of look. It is also what ⌘` does with
      // windows. The raise moves the first responder to the pane that came
      // up, so the *next* press is answered by that pane reading its own
      // freshly-ordered stack.
      [TUG_ACTIONS.NEXT_STACK_CARD]: (_event: ActionEvent) => {
        if (slotStack.length <= 1) return;
        const buried = slotStack[slotStack.length - 1];
        if (buried) onRevealPane?.(buried);
      },
      // PREVIOUS is NEXT's exact inverse: this pane leaves the front by
      // going all the way to the back (`sendPaneBehind` the bottom member),
      // fronting the entry beneath it — a true rotation, where raising the
      // second-from-top instead would ping-pong. Focus rides
      // `transferFocusForActivation` like every other activation path.
      [TUG_ACTIONS.PREVIOUS_STACK_CARD]: (_event: ActionEvent) => {
        if (slotStack.length <= 1) return;
        const next = slotStack[1];
        const bottom = slotStack[slotStack.length - 1];
        if (!next || !bottom) return;
        transferFocusForActivation({
          outgoingCardId: store.getFirstResponderCardId(),
          incomingCardId: next.cardId,
          store,
          commitMutation: () => {
            store.sendPaneBehind(stackId, bottom.paneId);
            store.activateCard(next.cardId);
          },
        });
      },
      [TUG_ACTIONS.SELECT_TAB]: (event: ActionEvent) => {
        if (typeof event.value !== "string") return;
        performSelectCard(event.value);
      },
      [TUG_ACTIONS.CLOSE_TAB]: (event: ActionEvent) => {
        if (typeof event.value !== "string") return;
        const targetId = event.value;
        // A tab whose card is held by a modal run stays. The tab × is the one
        // close gesture that can name a card other than the active one, so it
        // asks the store about ITS target rather than about whatever is front.
        if (refuseCardModalHold(targetId)) return;
        // The tab × is a close gesture like the pane X — it must honour the
        // target card's close guard rather than destroy a dirty manual File
        // card silently. A card that opts out (e.g. the Session card's
        // picker-cancel) registers none and closes directly. A dirty
        // background tab is VISITED (activated) before its sheet, so the
        // decision is made looking at the buffer it concerns.
        const guard = getCardCloseGuard(targetId);
        if (!guard) {
          store.removeCard(stackId, targetId);
          return;
        }
        if (closeTabGuardRunningRef.current) return;
        closeTabGuardRunningRef.current = true;
        if (guard.needsDecision() && activeCardIdRef.current !== targetId) {
          performSelectCard(targetId);
        }
        void guard.run().then((decision) => {
          closeTabGuardRunningRef.current = false;
          if (decision === "close") store.removeCard(stackId, targetId);
        });
      },
      [TUG_ACTIONS.ADD_TAB]: (event: ActionEvent) => {
        if (typeof event.value !== "string") return;
        store.addCardToPane(stackId, event.value);
      },
      // No FIND handler here on purpose. A registered no-op would make
      // the native Edit ▸ Find item validate as enabled (the menu pulls
      // `chain.validateAction(FIND)`) while doing nothing — a live
      // shortcut to a stub. Find enables only where a surface really
      // implements it (e.g. the code view's search session); everywhere
      // else it stays disabled until a real find lands.
    },
  });

  const hasMultipleCards = cards !== undefined && cards.length > 1;
  const activeCard =
    hasMultipleCards && activeCardId
      ? cards!.find((c) => c.id === activeCardId)
      : undefined;
  const activeCardRegistration = activeCard
    ? getRegistration(activeCard.componentId)
    : undefined;

  const effectiveMeta: CardMeta = activeCardRegistration
    ? activeCardRegistration.defaultMeta
    : meta;

  // Rail-ness follows the ACTIVE card's registration, the same way the
  // masthead and the title do. It reads `layoutRole` — what the card IS — and
  // not `sidebarSide`, which says only where a rail currently stands: a
  // released rail card is still a tool, and its livery should not blink when it
  // leaves its pin. `activeCardRegistration` resolves only for a stacked pane,
  // so a single-card pane falls back to the role its caller resolved from the
  // same registration, exactly as `effectiveMeta` falls back to `meta`.
  const effectiveLayoutRole: LayoutRole | undefined = activeCardRegistration
    ? activeCardRegistration.layoutRole
    : layoutRole;
  const isRail = effectiveLayoutRole === "sidebar";

  // Per-card title override (cardTitleStore) — the name a card takes once its
  // identity resolves: a Text card's filename, the Session card's bound
  // project path. It REPLACES the registry title rather than prefixing it
  // (`lib/pane-title.ts` owns that rule), so a card with a name of its own is
  // called by it and nothing else. Subscription is keyed on the active card so
  // a card swap repaints the title without prop drill.
  const activeCardTitleOverride = useSyncExternalStore(
    cardTitleStore.subscribe,
    useCallback(
      () => cardTitleStore.get(activeCardId ?? null),
      [activeCardId],
    ),
  );

  // The active card's masthead request ([P14]: chrome follows the frontmost
  // tab, so a stacked Session card behind another tab contributes nothing
  // here). The payload object is stable while unchanged, so this is a
  // legitimate `useSyncExternalStore` snapshot.
  const activeCardMasthead = useSyncExternalStore(
    cardTitleStore.subscribe,
    useCallback(
      () => cardTitleStore.getMasthead(activeCardId ?? null),
      [activeCardId],
    ),
  );

  // Which hosted card, if any, is held by a modal run — the same shape as
  // `resolveCloseGuard` below and read at the same moment, live at close time
  // ([L07]). `"pane"` scans every hosted card because the gestures carrying
  // that scope take all of them: a background tab compacting is as good a
  // reason to refuse as the front one is.
  const resolveModalHold = useCallback(
    (scope: "active" | "pane"): string | null => {
      const holds = cardModalHoldStore.getSnapshot();
      const activeId = activeCardIdRef.current;
      if (scope === "active") {
        return isCardHeld(holds, activeId) ? (activeId ?? null) : null;
      }
      const ids = [
        ...(activeId ? [activeId] : []),
        ...(cardsRef.current ?? [])
          .map((c) => c.id)
          .filter((id) => id !== activeId),
      ];
      return ids.find((id) => isCardHeld(holds, id)) ?? null;
    },
    [],
  );

  // Resolve the close decision for a close gesture, live at close time;
  // the refs keep it correct between renders as cards and activation
  // change. `"active"` consults only the active card (single-card close);
  // `"pane"` composes every hosted card's guard — background tabs stay
  // mounted (`display: none`), so their stores are live and their guards
  // registered. The composite VISITS each card that needs a decision
  // (activates it before prompting) so the user chooses looking at the
  // buffer in question; any `"cancel"` aborts the whole close.
  const resolveCloseGuard = useCallback(
    (scope: "active" | "pane"): CardCloseDecision | null => {
      const activeId = activeCardIdRef.current;
      if (scope === "active") {
        const guard = activeId ? getCardCloseGuard(activeId) : null;
        return guard ? guard.run : null;
      }
      const ids = [
        ...(activeId ? [activeId] : []),
        ...(cardsRef.current ?? [])
          .map((c) => c.id)
          .filter((id) => id !== activeId),
      ];
      const guarded = ids.filter((id) => getCardCloseGuard(id) !== null);
      if (guarded.length === 0) return null;
      // All guards clean → no decisions to collect; fall through to the
      // normal confirm-popover flow so a multi-tab pane keeps its
      // "Close N Tabs?" stray-click protection. When any card IS dirty,
      // the visit sequence collects an explicit per-card decision and
      // supersedes the popover — asking again after would double-prompt.
      if (!guarded.some((id) => getCardCloseGuard(id)?.needsDecision() === true)) {
        return null;
      }
      return async () => {
        for (const id of guarded) {
          // Re-resolve at visit time: an earlier decision (e.g. Save) may
          // have replaced or released this card's guard.
          const guard = getCardCloseGuard(id);
          if (!guard) continue;
          if (guard.needsDecision() && activeCardIdRef.current !== id) {
            performSelectCard(id);
          }
          if ((await guard.run()) === "cancel") return "cancel";
        }
        return "close";
      };
    },
    [performSelectCard],
  );

  // The composition rule itself lives in `lib/pane-title.ts`, because this is
  // not the only surface that names a pane — the slot-stack picker and the
  // Window menu's pane list name the same panes, and a second copy of this
  // arithmetic is how they came to disagree with the title bar.
  const displayTitle = composePaneTitleBarText({
    metaTitle: effectiveMeta.title,
    paneTitle: cardTitle,
    titleOverride: activeCardTitleOverride,
  });

  const resolvedAccessory: React.ReactNode | null = hasMultipleCards
    ? (
        <TugTabBar
          stackId={stackId}
          cards={cards!}
          activeCardId={activeCardId!}
          acceptedFamilies={acceptedFamilies}
        />
      )
    : accessory;

  const accessoryRef = useRef<HTMLDivElement>(null);
  const [accessoryHeight, setAccessoryHeight] = useState(0);

  useLayoutEffect(() => {
    const el = accessoryRef.current;
    if (!el) {
      setAccessoryHeight(0);
      return;
    }
    setAccessoryHeight(el.getBoundingClientRect().height);
    const ro = new ResizeObserver(() => {
      setAccessoryHeight(el.getBoundingClientRect().height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [resolvedAccessory]);

  // ---------------------------------------------------------------------------
  // onMinSizeChange — content-reported minimum drives resize clamp
  // ---------------------------------------------------------------------------

  const handleMinSizeChange = useCallback(
    (newSize: { width: number; height: number }) => {
      // Enforce policy min as floor: content cannot report a min below the policy.
      setMinSize({
        width: Math.max(newSize.width, sizePolicy.min.width),
        height: Math.max(newSize.height, sizePolicy.min.height),
      });
    },
    [sizePolicy.min.width, sizePolicy.min.height],
  );

  const totalMinWidth = minContentSize.width;
  const totalMinHeight = HEADER_HEIGHT_PX + accessoryHeight + minContentSize.height;

  useEffect(() => {
    handleMinSizeChange({
      width: totalMinWidth,
      height: totalMinHeight,
    });
  }, [handleMinSizeChange, totalMinWidth, totalMinHeight]);

  // ---------------------------------------------------------------------------
  // Drag system
  //
  // The drag mechanic is a three-phase state machine:
  //
  //   1. START (handleDragStart): snapshot all state, set up pointer capture,
  //      build caches for snap/merge hit-testing, attach move/up listeners.
  //
  //   2. FRAME (applyDragFrame, called via rAF from onPointerMove): compute
  //      clamped position, apply snap or free-drag, hit-test tab bars for
  //      merge feedback. All DOM mutations are appearance-zone.
  //
  //   3. END (onPointerUp): commit final position to store, handle merge-on-drop,
  //      clean up listeners and state.
  //
  // All drag state lives in refs — zero React re-renders during drag.
  //
  // Two drag modes (determined per-frame in applyDragFrame):
  //   - Free drag: no modifier. Position = clamped pointer delta.
  //   - Snap mode: Option held. Position snapped to other card edges.
  //
  // Merge: dragging over another card's tab bar highlights the drop target.
  // Releasing on the tab bar merges this card's active tab into the target.
  // ---------------------------------------------------------------------------

  // Whether a drag gesture is currently active.
  const dragActive = useRef(false);
  // Pending rAF handle; null when no frame is scheduled.
  const dragRafId = useRef<number | null>(null);
  // Client-space pointer coordinates captured at pointer-down.
  const dragStartPointer = useRef({ x: 0, y: 0 });
  // Canvas-relative card position captured at pointer-down.
  const dragStartPosition = useRef({ x: 0, y: 0 });
  // Whether the pointer has travelled far enough to make this a move rather
  // than a click. Until it has, the gesture commits nothing.
  const dragMoved = useRef(false);
  // Whether the press that opened this gesture held the command key. Read only
  // in the no-travel branch of `onPointerUp`, where a Cmd-click resolves as
  // "reveal this pane's stack" — a Cmd-drag latches `dragMoved` and never
  // reaches it.
  const dragStartedWithMeta = useRef(false);
  // Canvas bounding rect snapshotted at drag-start; used for all clamping.
  const dragCanvasBounds = useRef<DOMRect | null>(null);
  // Most recent client-space pointer coordinates from onPointerMove.
  const latestDragPointer = useRef({ x: 0, y: 0 });
  /**
   * The previous pointer sample and when it arrived — the two numbers a
   * release velocity is made of.
   *
   * A drop's landing inherits the hand ([P05] of
   * `arc/layout-imposer-polish.md`): a card let go while still moving
   * toward its zone arrives carrying that motion instead of stopping dead and
   * starting again. Two samples are enough — the estimate only has to know how
   * fast the hand was going at the instant it opened, and a longer window
   * would average away the flick it is trying to catch.
   */
  const previousDragPointer = useRef<{
    x: number;
    y: number;
    at: number;
  } | null>(null);

  // Track the tab bar element currently highlighted as a merge drop target.
  // Appearance-zone only: set/cleared via data-drop-target attribute. [D45, Rule 4]
  const dragDropTargetEl = useRef<HTMLElement | null>(null);

  // The zone drag in flight, or null for a gesture that has nowhere to land —
  // a free pane, an unimposed deck, a canvas with no host. `live` is the one
  // indicated zone, which is never null while the drag is a zone drag ([P09]).
  const zoneDragRef = useRef<{
    zones: readonly DropZone[];
    live: DropZone | null;
    /** The place the card started on, kept for the whole gesture: a release
     *  back onto it commits nothing, and a drop that commits nothing is the one
     *  the landing has to animate itself. */
    origin: DropZone | null;
  } | null>(null);
  // Whether ⌘ was held at the most recent frame. Read like `latestAltKey` and
  // for the same reason — the modifier's meaning is decided by where the hand
  // is now, not by where it was at pointer-down ([P13]).
  const latestMetaKey = useRef(false);
  const dropZonesRef = useRef(dropZones);
  dropZonesRef.current = dropZones;
  // A zone drop whose frame is still wearing the transform the hand left it
  // on, waiting to be carried into the tile the indicator promised. `from` is
  // where the frame stood on screen at the release — measured before the
  // commit, because that is the last moment the old arrangement is real, and it
  // is the only rect a landing can honestly start from.
  const pendingZoneDropRef = useRef<{
    el: HTMLElement;
    from: DOMRect;
    /** The hand's speed at the release, in CSS px/s, for the landing to
     *  inherit. `{x: 0, y: 0}` for a release the hand had stopped moving on. */
    releaseVelocity: { x: number; y: number };
  } | null>(null);
  // Every strip this gesture has scrolled, and where it left each one. Held per
  // strip rather than as one number because a drag can cross from one
  // overflowing column to another, and each keeps what the hand did to it.
  // Written imperatively during the gesture; committed once at its end.
  const autoscrolledRef = useRef(new Map<string, AutoscrollRun>());
  // The timestamp of the last frame that advanced the clock, or null between
  // gestures. Elapsed time is what makes the travel the same for a given hold
  // however the frames happen to fall.
  const autoscrollClockRef = useRef<number | null>(null);
  // The tab-bar rects the gesture snapshotted at its latch, kept so a
  // re-enumeration mid-autoscroll can be handed the same ones. Re-querying them
  // would be a different snapshot in the middle of one gesture.
  const zoneTabBarsRef = useRef<ReadonlyMap<string, Rect>>(new Map());

  /**
   * Carry a dropped frame from where the hand left it into the place the
   * commit gave it — a FLIP, and the reason a drop is a landing rather than a
   * jump.
   *
   * **Every drop animates, including the one that commits nothing.** A release
   * on the card's own position is still a release onto a zone ([P09]), and the
   * card has still travelled under the hand; letting that one snap home while
   * every other drop glides would say the gesture had been ignored. So the
   * distance is measured rather than assumed: whatever the commit did or did
   * not change, the frame crosses from the release rect to the resting one.
   *
   * The frame keeps `data-gesture` until the landing finishes, which is what
   * holds the imposer's own settle off it — the settle carries every OTHER
   * frame the commit moved, and this one is already being carried.
   *
   * Reading `--tugx-imposer-settle-duration` rather than the constant means the
   * landing is retuned by the same override that retunes the settle: one knob
   * for how fast cards move, and the drop is not the exception to it.
   */
  const landZoneDrop = useCallback(() => {
    const pending = pendingZoneDropRef.current;
    if (pending === null) return;
    pendingZoneDropRef.current = null;
    const { el, from, releaseVelocity } = pending;
    el.style.transform = "";
    const to = el.getBoundingClientRect();
    const zoom = getTugZoom() || 1;
    const dx = (from.left - to.left) / zoom;
    const dy = (from.top - to.top) / zoom;
    if (dx === 0 && dy === 0) {
      el.removeAttribute("data-gesture");
      return;
    }
    // The `landing` recipe, seeded with whatever the hand was still doing at
    // the release. The travel is from where the frame sits back to zero, so
    // the vector the velocity is projected onto is the negative of the FLIP's
    // inverse offset — the direction the card is about to go.
    const curve = motionKeyframes("landing", {
      nominalMs: readSettleMs(el),
      initialVelocity: velocityAlongTravel(releaseVelocity, {
        x: -dx,
        y: -dy,
      }),
    });
    const landing = animate(
      el,
      curve.progress.map((p, i) => ({
        offset: i / (curve.progress.length - 1),
        // The curve walks the inverse offset away; an overshoot carries the
        // frame past its place and the spring brings it back.
        transform: `translate(${(1 - p) * dx}px, ${(1 - p) * dy}px)`,
      })),
      {
        // Raw ms: TugAnimator scales by getTugTiming() itself.
        duration: curve.durationMs,
        // The physics is in the keyframes, so the easing is the keyword that
        // keeps the effect accelerable (`lib/pane-flip.ts` says why).
        easing: "linear",
        // No retained effect after the tween ends ([D6]).
        fill: "none",
        key: "zone-drop-landing",
      },
    );
    const done = () => el.removeAttribute("data-gesture");
    landing.finished.then(done, done);
  }, []);

  /**
   * Land the drop on the commit that gave the frame its new place ([L03] — a
   * layout effect, so it runs after the DOM is updated and before anything is
   * painted or measured against it).
   *
   * A layout effect rather than a frame callback because the thing being waited
   * for is a React commit, and rAF's timing against one is a browser detail
   * rather than a contract ([L05]). A drop that commits nothing renders
   * nothing, so it never reaches here — `onPointerUp` lands that one itself.
   */
  useLayoutEffect(() => {
    landZoneDrop();
  });

  /**
   * Snapshot all `.tug-tab-bar[data-pane-id]` elements at drag-start (excluding
   * our own pane). Used for hit-testing during drag and on pointer-up. [D45]
   */
  const dragTabBarCache = useRef<Array<{ paneId: string; rect: DOMRect; el: HTMLElement }>>([]);

  // Snap-related refs [D01, D03, D04]
  // Canvas-relative rects of all other cards, snapshotted at drag-start for computeSnap. [D04]
  const dragOtherRects = useRef<{ id: string; rect: Rect }[]>([]);
  // Active snap guide DOM elements; cleared on drop and on each rAF if guides change. [D03]
  const dragGuideEls = useRef<HTMLElement[]>([]);
  // Whether alt key is held during drag.
  const latestAltKey = useRef(false);
  // Snap result computed in the last rAF; read in onPointerUp to finalise snapped position. [D01]
  const lastSnapResult = useRef<SnapResult | null>(null);

  /**
   * Set a tab bar element as the current drag drop target (appearance-zone).
   * Clears the previous target before applying the new one. [D45, Rule 4]
   */
  function setDragDropTarget(el: HTMLElement | null): void {
    if (dragDropTargetEl.current === el) return;
    if (dragDropTargetEl.current) {
      dragDropTargetEl.current.removeAttribute("data-card-drag-target");
    }
    dragDropTargetEl.current = el;
    if (el) {
      el.setAttribute("data-card-drag-target", "true");
    }
  }

  /**
   * Compute insertion index for a merge into a target tab bar's tab array,
   * based on pointer X coordinate vs tab midpoints. Uses the same approach
   * as TabDragCoordinator.computeReorderIndex. [D45]
   */
  function computeMergeInsertIndex(barEl: HTMLElement, pointerX: number): number {
    const tabEls = barEl.querySelectorAll<HTMLElement>('.tug-tab:not([data-overflow="hidden"])');
    if (tabEls.length === 0) return 0;
    for (let i = 0; i < tabEls.length; i++) {
      const rect = tabEls[i].getBoundingClientRect();
      if (pointerX < rect.left + rect.width / 2) return i;
    }
    return tabEls.length;
  }

  /**
   * Render snap guide DOM elements from a list of guide positions. [D03]
   * Creates or reuses <div> elements with .snap-guide-line CSS classes.
   * Appends to container; removes excess guide elements.
   * Works for both move-drag (dragGuideEls) and resize (resizeGuideEls).
   */
  function syncGuideElements(
    guideRef: React.MutableRefObject<HTMLElement[]>,
    guides: GuidePosition[],
    container: HTMLElement,
    edgeOffsets: GuideEdgeOffsets,
  ): void {
    // Guide positions are in layout space (snapshotCardRects divides the visual
    // measurements by zoom). They reference the measured `.tug-pane` frame edge;
    // `edgeOffsets` carries the measured delta to the visible `.tug-pane-chrome`
    // border so the line lands on the edge the user actually sees. The visible
    // border occupies a 1px band: at a left/top edge it runs forward from the
    // border-box origin, so the line (a 1px border that paints forward) sits at
    // the origin; at a right/bottom edge the band ends at the exclusive border-box
    // edge, so the line is pulled back one line-width to cover the band.
    for (let i = 0; i < guides.length; i++) {
      const guide = guides[i];
      let el = guideRef.current[i];
      if (!el) {
        el = document.createElement("div");
        el.classList.add("snap-guide-line");
        container.appendChild(el);
        guideRef.current.push(el);
      }
      // Reset axis classes
      el.classList.remove("snap-guide-line-x", "snap-guide-line-y");
      if (guide.axis === "x") {
        el.classList.add("snap-guide-line-x");
        const left = guide.cardEdge === "right"
          ? guide.position + edgeOffsets.right - SNAP_GUIDE_LINE_PX
          : guide.position + edgeOffsets.left;
        el.style.left = `${left}px`;
        el.style.top = "";
      } else {
        el.classList.add("snap-guide-line-y");
        const top = guide.cardEdge === "bottom"
          ? guide.position + edgeOffsets.bottom - SNAP_GUIDE_LINE_PX
          : guide.position + edgeOffsets.top;
        el.style.top = `${top}px`;
        el.style.left = "";
      }
    }
    // Remove excess guide elements
    while (guideRef.current.length > guides.length) {
      const excess = guideRef.current.pop();
      if (excess && excess.parentNode) {
        excess.parentNode.removeChild(excess);
      }
    }
  }

  /**
   * Remove all snap guide elements from the DOM and clear tracking ref. [D03]
   * Works for both move-drag (dragGuideEls) and resize (resizeGuideEls).
   */
  function clearGuideElements(guideRef: React.MutableRefObject<HTMLElement[]>): void {
    for (const el of guideRef.current) {
      if (el.parentNode) {
        el.parentNode.removeChild(el);
      }
    }
    guideRef.current = [];
  }

  const handleDragStart = useCallback(
    (event: React.PointerEvent) => {
      // Drag-start focus save. The pane
      // title bar is not focusable, so WebKit's mousedown default
      // would normally blur whatever element inside the active
      // card has focus. Saving the active card's bag in capture
      // phase — before the blur lands — preserves `bag.focus` and
      // `bag.domSelection` so the helper can restore them after
      // the gesture (drop, cancel, or even no-op release).
      // The save is unconditional: cheap, idempotent with the
      // subsequent debounced save.
      const currentActiveCardId = activeCardIdRef.current;
      if (currentActiveCardId) {
        captureFocusForDragStart({
          sourceCardId: currentActiveCardId,
          store,
        });
      }

      if (!frameRef.current) return;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const frame: HTMLDivElement = frameRef.current!;

      // Capture pointer on the frame element for reliable move/up tracking outside bounds.
      frame.setPointerCapture(event.nativeEvent.pointerId);

      // Disable height transition during drag so the collapse animation does not
      // conflict with pointer-driven position updates. [D07, chrome.css]
      frame.setAttribute("data-gesture", "true");

      // === PHASE 1: SNAPSHOT ===
      // Capture all state needed for the drag gesture. Everything below runs
      // once at pointer-down and is read (not written) during the drag.

      // Snapshot canvas bounds and drag start state once.
      dragCanvasBounds.current = frame.parentElement?.getBoundingClientRect() ?? null;
      dragActive.current = true;
      dragStartPointer.current = { x: event.clientX, y: event.clientY };

      // A derived pane (a pinned rail, an imposed card) is released from whatever
      // was deriving its geometry by MOVING it, not by being touched: the
      // release waits for the pointer to travel (see `releaseImposedFrame`,
      // called from the first frame past the threshold). Until then the pane
      // still belongs to the arrangement, so a click on a rail's title bar —
      // to focus it, or to start a gesture and think better of it — leaves it
      // pinned where it was.
      dragMoved.current = false;
      // Whether the press that started this gesture was meta-modified. A
      // Cmd-drag on a title bar is meaningful today and must survive: for a
      // free pane it is the Mac convention of moving a background window
      // without raising it, and for an imposed pane the drag is how it is
      // evicted from its slot. So Cmd does not decide anything on the way
      // down — the decision waits for the gesture's ending, and the no-travel
      // branch in `onPointerUp` below IS that ending, already written.
      dragStartedWithMeta.current = event.metaKey;
      dragStartPosition.current = { x: position.x, y: position.y };
      latestDragPointer.current = { x: event.clientX, y: event.clientY };
      // A fresh grab has no history, so a release without a single move
      // inherits nothing — which is right: that hand never moved.
      previousDragPointer.current = null;

      // Build tab bar cache for merge hit-testing. [D45]
      // Snapshot all .tug-tab-bar[data-pane-id] elements (excluding this pane).
      dragTabBarCache.current = [];
      const barEls = document.querySelectorAll<HTMLElement>(".tug-tab-bar[data-pane-id]");
      barEls.forEach((el) => {
        const paneId = el.getAttribute("data-pane-id");
        if (!paneId || paneId === id) return;
        // A rail never accepts a merge — skip its tab bar as a drop
        // target.
        if (el.closest(".tug-pane[data-sidebar-pane]")) return;
        dragTabBarCache.current.push({ paneId, rect: el.getBoundingClientRect(), el });
      });

      // Snapshot other card rects at drag-start for snap computation. [D04]
      // Convert to canvas-relative coordinates by subtracting canvas bounds offset.
      // All snap geometry runs in layout space; `body { zoom }` requires dividing
      // the visual measurements by the zoom factor. Read once per gesture.
      const dragZoom = getTugZoom() || 1;
      const dragGuideEdgeOffsets = measureGuideEdgeOffsets(frame, dragZoom);
      const canvasBounds = dragCanvasBounds.current;
      dragOtherRects.current = snapshotCardRects(canvasBounds, id, dragZoom);

      // Initialize drag state.
      latestAltKey.current = false;
      lastSnapResult.current = null;

      /** The canvas point the pointer is over, in the layout space every drop
       *  zone's rect is measured in. */
      function pointerOnCanvas(client: { x: number; y: number }) {
        const canvas = dragCanvasBounds.current;
        return {
          x: (client.x - (canvas?.left ?? 0)) / dragZoom,
          y: (client.y - (canvas?.top ?? 0)) / dragZoom,
        };
      }

      /**
       * Latch the drag into zone mode, or answer null for a gesture with
       * nowhere to land — a free pane, an unimposed deck, an unpinned sidebar
       * card, or a canvas with no host.
       *
       * A PINNED sidebar card does land somewhere: its rail's positions are
       * zones like any other ([P11]), which is what let the corridor retire.
       */
      function beginZoneDrag(): {
        zones: readonly DropZone[];
        live: DropZone | null;
        origin: DropZone | null;
      } | null {
        const host = dropZonesRef.current;
        if (host === undefined) return null;
        const tabBars = new Map<string, Rect>();
        for (const entry of dragTabBarCache.current) {
          const canvas = dragCanvasBounds.current;
          tabBars.set(entry.paneId, {
            x: (entry.rect.left - (canvas?.left ?? 0)) / dragZoom,
            y: (entry.rect.top - (canvas?.top ?? 0)) / dragZoom,
            width: entry.rect.width / dragZoom,
            height: entry.rect.height / dragZoom,
          });
        }
        zoneTabBarsRef.current = tabBars;
        const set = host.enumerate(id, tabBars);
        if (set.zones.length === 0) return null;
        return { zones: set.zones, live: set.origin, origin: set.origin };
      }

      /**
       * Advance whatever strip the pointer is holding at the edge of, and
       * answer whether anything moved.
       *
       * On the gesture's own rAF ([D135] — no second clock), and imperatively:
       * the offset goes onto its custom property and nowhere near the store
       * (Spec S03). A store write here would change `arrangementSignature`
       * ([P12]) and arm a FLIP settle on every frame of the drag — the dragged
       * frame is exempt for carrying `data-gesture`, but every OTHER member of
       * that column would be measured and tweened under the user's hand. The
       * number commits once, at the drop or the cancel.
       *
       * Rescheduling itself while it is advancing is what makes a HELD pointer
       * keep scrolling: the drag's frames are otherwise driven by pointermove,
       * and a hand that has stopped moving posts none.
       */
      function advanceAutoscroll(pointer: { x: number; y: number }): boolean {
        const host = dropZonesRef.current;
        if (host === undefined) return false;
        const now = performance.now();
        const last = autoscrollClockRef.current;
        autoscrollClockRef.current = now;
        const target = host.autoscrollTargetFor(pointer);
        if (target === null || last === null) return false;

        const key = autoscrollKey(target);
        const running = autoscrolledRef.current.get(key);
        const standing = running?.offset ?? target.offset;
        const delta = autoscrollDelta({
          pointer: target.axis === "y" ? pointer.y : pointer.x,
          bandStart: target.bandStart,
          bandEnd: target.bandEnd,
          elapsedMs: now - last,
        });
        if (delta === 0) return false;

        // Keep the clock alive while the hand holds, whether or not the strip
        // still has anywhere to go — a strip pinned at its end that stopped
        // scheduling frames would never notice the hand moving off the edge.
        scheduleDragFrame();
        const next = Math.min(Math.max(0, standing + delta), target.maxOffset);
        if (next === standing) return false;
        autoscrolledRef.current.set(key, { target, offset: next });
        host.applyScroll(target, next);
        return true;
      }

      /** Commit every strip this gesture scrolled — one store write each, at
       *  the end. Real state, so a cancel commits them too: the card goes home
       *  and the view stays where the hand took it. */
      function commitAutoscroll(): void {
        const host = dropZonesRef.current;
        for (const run of autoscrolledRef.current.values()) {
          host?.commitScroll(run.target, run.offset);
        }
        autoscrolledRef.current.clear();
        autoscrollClockRef.current = null;
      }

      /** The tab bar element a tab-bar zone names, for the indication it has
       *  always used ([P10]). */
      function tabBarElementOf(paneId: string): HTMLElement | null {
        return (
          dragTabBarCache.current.find((entry) => entry.paneId === paneId)?.el ??
          null
        );
      }

      /**
       * One frame of a zone drag: the frame follows the pointer on a transform,
       * and the indication follows the pointer to the nearest zone.
       *
       * The transform is why `left`/`top` are never written here — an imposed
       * pane's are calc pins over the live band, and a pixel write would fight
       * them for the rest of the gesture.
       *
       * With ⌘ held the card is being freed ([P13]): no zone is live and the
       * indicator goes away, but the frame still travels on its transform, so
       * the conversion to free pixels can wait for the drop. Option's snap
       * guides do not draw during that stretch — they position against
       * `left`/`top`, which this frame is deliberately not writing.
       */
      /**
       * How far the dragged frame's own base has slid out from under it.
       *
       * An imposed frame's `left`/`top` is a calc that SUBTRACTS its strip's
       * offset (`columnMemberPins`, `flowMemberPins`), so a strip advancing
       * by d moves every member on it — the dragged one included — back by d.
       * The drag's transform is pointer-relative and knows nothing about
       * that, so without this the card creeps out of the hand for as long as
       * the autoscroll runs.
       *
       * Each entry's `target.offset` is where its strip stood when the drag
       * first reached it and never moves after (autoscroll writes the CSS
       * property, never the store — Spec S03), so `offset - target.offset` is
       * the whole travel since the grab. Summed per axis because one drag can
       * scroll a column and the flow band on different axes.
       */
      /**
       * How fast the hand was moving when it opened, in CSS px/s.
       *
       * Taken from the last pointer move and the release itself, using the
       * events' own timestamps rather than a clock read here — the release
       * may be dispatched a frame after the move that preceded it, and the
       * gap between them is the denominator.
       *
       * Zero when there is no previous sample (a press and release with no
       * travel) or when the two share a timestamp (which would divide by
       * nothing). A stale sample is treated as a stop: a hand that paused
       * before letting go has no momentum to give, and inheriting a velocity
       * from 200ms ago would throw a card that was sitting still.
       */
      function releaseVelocity(e: PointerEvent): { x: number; y: number } {
        const previous = previousDragPointer.current;
        if (previous === null) return { x: 0, y: 0 };
        const dt = e.timeStamp - previous.at;
        if (dt <= 0 || dt > RELEASE_VELOCITY_WINDOW_MS) return { x: 0, y: 0 };
        return {
          x: ((e.clientX - previous.x) / dt) * 1000,
          y: ((e.clientY - previous.y) / dt) * 1000,
        };
      }

      function autoscrollCompensation(): { dx: number; dy: number } {
        let dx = 0;
        let dy = 0;
        for (const run of autoscrolledRef.current.values()) {
          const travelled = run.offset - run.target.offset;
          if (run.target.axis === "y") dy += travelled;
          else dx += travelled;
        }
        return { dx, dy };
      }

      function applyZoneDragFrame(state: {
        zones: readonly DropZone[];
        live: DropZone | null;
      }): void {
        const pointer = latestDragPointer.current;
        const start = dragStartPointer.current;
        // Advance first, then place the frame: the compensation has to be
        // read AFTER this frame's scroll, or the card lags the strip by one
        // frame for the whole hold.
        const scrolled =
          !latestMetaKey.current && advanceAutoscroll(pointerOnCanvas(pointer));
        const slide = autoscrollCompensation();
        frame.style.transform = `translate(${
          (pointer.x - start.x) / dragZoom + slide.dx
        }px, ${(pointer.y - start.y) / dragZoom + slide.dy}px)`;
        // Where the frame now stands, published once per frame to whoever is
        // drawing the deck elsewhere ([P08]). After the transform write and
        // before the zone work, so an instrument's ghost and the canvas's own
        // indication are answering the same frame.
        dropZonesRef.current?.gaugeDragFrame(frame);
        if (latestMetaKey.current) {
          state.live = null;
          autoscrollClockRef.current = null;
          dropZonesRef.current?.indicate(null);
          setDragDropTarget(null);
          return;
        }
        if (scrolled) {
          // The strip moved, so every tile moved with it. Re-measure rather
          // than translate the cached rects: the browser has already reflowed
          // against the property this frame wrote, and reading it back is the
          // one answer that cannot drift from what the user is looking at.
          state.zones = dropZonesRef.current?.enumerate(id, zoneTabBarsRef.current).zones ?? state.zones;
        }
        state.live = pickLiveZone(state.zones, pointerOnCanvas(pointer), state.live);
        dropZonesRef.current?.indicate(state.live);
        setDragDropTarget(
          state.live?.kind === "tab-bar"
            ? tabBarElementOf(state.live.paneId)
            : null,
        );
      }

      // === PHASE 2: FRAME (rAF callback) ===
      // Called once per animation frame during drag. Computes position,
      // applies snap or free-drag, hit-tests merge.
      // All mutations are appearance-zone (direct DOM, no React state).
      function applyDragFrame() {
        dragRafId.current = null;
        if (!dragActive.current) return;

        // Below the threshold this is still a click, and a click moves nothing.
        if (!dragMoved.current) {
          const start = dragStartPointer.current;
          const travelled = Math.hypot(
            latestDragPointer.current.x - start.x,
            latestDragPointer.current.y - start.y,
          );
          if (travelled < DRAG_MOVE_THRESHOLD_PX) return;
          dragMoved.current = true;
          // The move is about to expose whatever this frame was covering,
          // without a store commit; reveal every occluded pane before the
          // first moved paint and hold hides until the gesture ends.
          //
          // Unconditional, in BOTH modes. The bracket is not about the rail's
          // footprint — it is about frames covering each other, which is
          // precisely what a reorder does transiently as the dragged member
          // translates over its sibling. Left to itself the occlusion
          // controller would arm its hide timer and stamp a fully covered
          // sibling `data-occluded` under the user's hand, since a paused
          // pointer with no tween running is exactly the quiescent state it
          // waits for. It also keeps the drop's unconditional `end()` paired.
          paneOcclusionGesture.begin();
          // One latch for every arrangeable pane, content and rail alike
          // ([P11]). A rail member's places are its rail's positions and a
          // content card's are the content-side vocabulary; which it gets is
          // the engine's to answer, and the gesture no longer has to know.
          const zoneSet = beginZoneDrag();
          if (zoneSet !== null) {
            // A zone drag never releases the frame. The pane keeps its derived
            // geometry for the whole gesture and travels on a transform, so a
            // release that lands on a zone — which is every unmodified release
            // ([P09]) — has nothing to undo. Only a ⌘-freed drop converts, and
            // it converts at the drop, where the decision is actually made.
            zoneDragRef.current = zoneSet;
            dropZonesRef.current?.indicate(zoneSet.live);
          } else if (derivedRef.current) {
            // Now it is a move. A derived pane converts to free pixel geometry
            // here, at the moment the gesture becomes one.
            const released = releaseImposedFrame(frame, dragCanvasBounds.current);
            dragStartPosition.current = { x: released.x, y: released.y };
          }
        }

        // Zone mode owns the rest of the frame: the pane is still derived, so
        // its travel is a transform and its `left`/`top` stay the
        // arrangement's — a pixel write would fight the calc pins.
        const zoneDrag = zoneDragRef.current;
        if (zoneDrag !== null) {
          applyZoneDragFrame(zoneDrag);
          return;
        }

        // Always solo card clamping.
        const pos = clampedPosition(
          latestDragPointer.current,
          dragStartPointer.current,
          dragStartPosition.current,
          dragCanvasBounds.current,
          { width: frame.offsetWidth, height: frame.offsetHeight },
          dragZoom,
        );

        if (latestAltKey.current) {
          // Snap mode: Option held. [D01]
          const movingRect: Rect = {
            x: pos.x,
            y: pos.y,
            width: frame.offsetWidth,
            height: frame.offsetHeight,
          };
          const snapResult = computeSnap(
            movingRect,
            dragOtherRects.current.map((r) => r.rect),
            undefined,
            -IMPOSITION_GAP_PX,
          );
          lastSnapResult.current = snapResult;
          if (snapResult.x !== null) {
            pos.x = snapResult.x;
          }
          if (snapResult.y !== null) {
            pos.y = snapResult.y;
          }
          // Render snap guides via DOM manipulation. [D03]
          const container = frame.parentElement;
          if (container) {
            syncGuideElements(dragGuideEls, snapResult.guides, container, dragGuideEdgeOffsets);
          }
        } else {
          // Free drag: no snap modifier. Clear guides and snap result.
          lastSnapResult.current = null;
          clearGuideElements(dragGuideEls);
        }

        frame.style.left = `${pos.x}px`;
        frame.style.top = `${pos.y}px`;

        // Hit-test tab bars for drop target visual feedback. [D45, Rule 4]
        const cx = latestDragPointer.current.x;
        const cy = latestDragPointer.current.y;
        let found: HTMLElement | null = null;
        for (const entry of dragTabBarCache.current) {
          const r = entry.rect;
          if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
            found = entry.el;
            break;
          }
        }
        setDragDropTarget(found);
      }

      // === POINTER HANDLERS ===
      function onPointerMove(e: PointerEvent) {
        previousDragPointer.current = {
          ...latestDragPointer.current,
          at: e.timeStamp,
        };
        latestDragPointer.current = { x: e.clientX, y: e.clientY };
        latestAltKey.current = e.altKey;
        latestMetaKey.current = e.metaKey;
        if (dragRafId.current === null) {
          dragRafId.current = requestAnimationFrame(applyDragFrame);
        }
      }

      /**
       * Take the gesture's listeners off and stop its clock — everything an
       * ending has to do whatever kind of ending it is.
       *
       * Shared by the drop and the two cancels so they cannot drift: a cancel
       * path that forgot one listener would leave a dead gesture answering the
       * pointer, which is the failure mode that makes cancel paths worth
       * writing at all.
       */
      function endGestureListeners(pointerId: number | null): void {
        dragActive.current = false;
        if (dragRafId.current !== null) {
          cancelAnimationFrame(dragRafId.current);
          dragRafId.current = null;
        }
        frame.removeEventListener("pointermove", onPointerMove);
        frame.removeEventListener("pointerup", onPointerUp);
        frame.removeEventListener("pointercancel", onPointerCancel);
        window.removeEventListener("keydown", onGestureKeyDown, true);
        window.removeEventListener("keyup", onGestureKeyUp, true);
        if (pointerId !== null && frame.hasPointerCapture(pointerId)) {
          frame.releasePointerCapture(pointerId);
        }
      }

      /**
       * End the gesture with nothing committed: the card goes home, the
       * indication goes away, and the arrangement is exactly what it was.
       *
       * Both cancel paths land here — Escape and `pointercancel` (a system
       * gesture or a scroll takeover claiming the pointer). Neither existed
       * before this: the pane drag registered `pointermove` and `pointerup` and
       * nothing else, so an interrupted gesture left `data-gesture`, the
       * occlusion bracket, and any preview transforms behind it.
       *
       * One unwind covers every drag in the deck, which is what unifying rails
       * onto the engine bought ([P11]): there is no second drag grammar left
       * with its own preview state for a cancel to have to know about.
       */
      function cancelDrag(pointerId: number | null): void {
        if (!dragActive.current) return;
        endGestureListeners(pointerId);

        zoneDragRef.current = null;
        dropZonesRef.current?.indicate(null);
        dropZonesRef.current?.gaugeDragFrame(null);
        // A cancel takes back the MOVE, not the view. The strip the hand
        // scrolled to is where the user is now looking, and rewinding it would
        // undo something they did not ask to undo.
        commitAutoscroll();

        frame.style.transform = "";
        frame.removeAttribute("data-gesture");
        clearGuideElements(dragGuideEls);
        setDragDropTarget(null);
        for (const entry of dragTabBarCache.current) {
          entry.el.removeAttribute("data-card-drag-target");
        }
        dragTabBarCache.current = [];

        // The bracket is only open if the gesture ever latched into a move.
        if (dragMoved.current) paneOcclusionGesture.end();

        dragMoved.current = false;
        dragStartedWithMeta.current = false;
        dragOtherRects.current = [];
        latestAltKey.current = false;
        latestMetaKey.current = false;
        lastSnapResult.current = null;
      }

      /**
       * Escape cancels, and the key goes no further.
       *
       * Capture phase and `stopImmediatePropagation` because the Cards card's
       * `CANCEL_DIALOG` responder is also listening for Escape, and a cancelled
       * drag that additionally collapsed that card's selection would be one
       * keypress doing two unrelated things. `card-drag-coordinator.ts` swallows
       * it the same way for the tab drag, and `tugways/block-reorder.ts`'s comment
       * names this gesture as the same case.
       */
      function onGestureKeyDown(e: KeyboardEvent) {
        if (!dragActive.current) return;
        latestMetaKey.current = e.metaKey;
        if (e.key !== "Escape") {
          scheduleDragFrame();
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        cancelDrag(null);
      }

      // ⌘ is read on its own edges as well as the pointer's, so letting go of
      // it brings the indication back without waiting for the hand to move.
      function onGestureKeyUp(e: KeyboardEvent) {
        if (!dragActive.current) return;
        latestMetaKey.current = e.metaKey;
        scheduleDragFrame();
      }

      function onPointerCancel(e: PointerEvent) {
        cancelDrag(e.pointerId);
      }

      function scheduleDragFrame(): void {
        if (dragRafId.current === null) {
          dragRafId.current = requestAnimationFrame(applyDragFrame);
        }
      }

      // === PHASE 3: DROP ===
      // Pointer released. Commit final position to store, handle merge,
      // clean up listeners and reset all drag state.
      /**
       * One pointer-up is one gesture, so it is one store notification.
       *
       * A release does several mutations — `commitAutoscroll` writes every
       * strip the drag scrolled, the zone commit moves the pane, and
       * `movePaneToSlot` raises the arriving card on its way through
       * `transferFocusForActivation`. Left unbatched, each of those told
       * the canvas separately, and the canvas arms its settle once per
       * telling: an autoscrolled release armed twice, and a cross-slot drop
       * notified three times. The card is making ONE journey, so the deck
       * hears about it once, at the end, over the final arrangement.
       *
       * The batch also makes the landing's First measurement safer than it
       * was: `pendingZoneDropRef`'s `from` rect is read while the old
       * arrangement is still on screen, and now nothing can have rendered
       * between the commit and the read.
       */
      function onPointerUp(e: PointerEvent) {
        store.batchGesture(() => endPaneDrag(e));
      }

      function endPaneDrag(e: PointerEvent) {
        if (!dragActive.current) return;
        endGestureListeners(e.pointerId);

        // Re-enable height transition now that the drag gesture is complete. [D07]
        //
        // A gesture that ENDS on a zone keeps the attribute a little longer:
        // the commit below arms a settle, and the settle must skip this frame —
        // it already rests at its final visual position, and both of the
        // settle's passes would measure it through the inline transform that
        // puts it there. The choice is made on how the gesture ENDS, never on
        // how it latched: a ⌘-freed drop is a free drag by then and drops its
        // attribute exactly where every other drag does.
        const zoneState = zoneDragRef.current;
        const zoneDrop = latestMetaKey.current ? null : zoneState;
        // ⌘ at the release is what frees the card ([P13]), and the conversion
        // to free pixels happens here rather than the moment the key went down:
        // the key is readable up to the last instant, so deciding earlier would
        // make a modifier tapped and released mid-drag irreversible.
        const freedFromZone = zoneState !== null && latestMetaKey.current;
        zoneDragRef.current = null;
        dropZonesRef.current?.indicate(null);
        dropZonesRef.current?.gaugeDragFrame(null);
        // Ahead of the zone commit below, so the settle that animates the
        // landing is the arrangement change's rather than the offset's. This
        // one moves no frame: CSS has been drawing the number all along.
        commitAutoscroll();
        if (zoneDrop === null) frame.removeAttribute("data-gesture");

        // Remove snap guides immediately on drop. [D03]
        // Must happen before any early return (e.g. merge) to prevent guide leaks.
        clearGuideElements(dragGuideEls);

        // Clear drop target highlight before committing. [D45, Rule 4]
        setDragDropTarget(null);
        // Belt-and-suspenders: clear attribute on all cached bar elements.
        for (const entry of dragTabBarCache.current) {
          entry.el.removeAttribute("data-card-drag-target");
        }

        // The pointer never travelled, so this was a click on the title bar.
        // Nothing was moved, nothing merges, and nothing is committed — in
        // particular a derived pane keeps the slot or the pin it started with.
        if (!dragMoved.current) {
          // ...and if it was a Cmd-click, that click means "show me what is
          // behind this pane". The same handle the ⌘R chord calls, so there is
          // one opener with several callers rather than several openers. The
          // gesture interpreter's own meta branch already suppressed
          // activation for this press, which is exactly right: the picker
          // opens without raising the pane it was clicked on.
          if (dragStartedWithMeta.current) {
            titleBarRef.current?.revealStack();
          }
          dragStartedWithMeta.current = false;
          dragOtherRects.current = [];
          latestAltKey.current = false;
          lastSnapResult.current = null;
          return;
        }
        dragStartedWithMeta.current = false;

        // Close the occlusion bracket opened at the move latch; the commit
        // below (or the merge's store mutation) recomputes from final
        // geometry through the controller's store subscription.
        paneOcclusionGesture.end();

        // A zone drop lands where the indicator said it would.
        //
        // The frame keeps its drag transform and `data-gesture` across the
        // commit, and `landZoneDrop` carries it from there into the place the
        // commit gave it. The settle skips it for that whole crossing, which is
        // the division of labour: the settle carries every OTHER frame the
        // commit moved, and this one is being carried by its own landing. That
        // is what makes a drop an arrangement change rather than a jump.
        //
        // A refusal is an outcome, not a silence ([P09]). The frame goes home,
        // the pane flashes, and nothing is left hanging at a zone that never
        // took it.
        if (zoneDrop !== null) {
          // Re-picked from the RELEASE point rather than read off the last
          // frame that happened to run. The gesture's frames are scheduled on
          // rAF and the drop cancels whichever one is pending, so a release
          // that lands within a frame of the last processed move would
          // otherwise commit the zone the pointer was leaving — the indicator
          // and the outcome disagreeing exactly at the moment they must not.
          // Same incumbent, same hysteresis, so nothing about the feel changes;
          // only the last read is made to exist.
          const live = pickLiveZone(
            zoneDrop.zones,
            pointerOnCanvas({ x: e.clientX, y: e.clientY }),
            zoneDrop.live,
          );
          if (live !== null && live.kind === "tab-bar") {
            // The one zone whose commit was already written: the merge keeps
            // its own insert index and its own verb ([P10]).
            const barEl = tabBarElementOf(live.paneId);
            if (onCardMerged && activeCardId && barEl !== null) {
              frame.style.transform = "";
              frame.removeAttribute("data-gesture");
              onCardMerged(id, live.paneId, computeMergeInsertIndex(barEl, e.clientX));
              dragTabBarCache.current = [];
              dragOtherRects.current = [];
              latestAltKey.current = false;
              latestMetaKey.current = false;
              lastSnapResult.current = null;
              return;
            }
          }
          const committed =
            live !== null && dropZonesRef.current?.commit(live, id) === true;
          if (committed && live !== null) {
            // The release rect, measured while the old arrangement is still the
            // one on screen: this is where the frame visually is, and the
            // landing has to start there whatever the commit does next.
            pendingZoneDropRef.current = {
              el: frame,
              from: frame.getBoundingClientRect(),
              releaseVelocity: releaseVelocity(e),
            };
            // A drop onto the card's own position commits nothing, so nothing
            // renders and the layout effect never runs. It is still a drop, and
            // it still animates ([P09]) — landed here, inline, rather than left
            // waiting on a commit that is not coming.
            if (
              zoneDrop.origin !== null &&
              dropZoneKey(live) === dropZoneKey(zoneDrop.origin)
            ) {
              landZoneDrop();
            }
          } else {
            // Home is a place too. A refused release animates back by the same
            // landing a taken one animates in by, so the gesture ends in motion
            // either way and the flash says which of the two it was.
            pendingZoneDropRef.current = {
              el: frame,
              from: frame.getBoundingClientRect(),
              releaseVelocity: releaseVelocity(e),
            };
            landZoneDrop();
            flashCardPane(store, activeCardIdRef.current ?? id);
          }
          dragTabBarCache.current = [];
          dragOtherRects.current = [];
          latestAltKey.current = false;
          latestMetaKey.current = false;
          lastSnapResult.current = null;
          return;
        }

        // ⌘ frees the card ([P13]). The transform that carried it becomes its
        // free geometry here, in this order — `releaseImposedFrame` measures a
        // transform-inclusive rect and does not clear the transform, so banking
        // the offset into `left`/`top` and leaving the translate on top of it
        // would double the frame's travel, exactly as it would at the rail
        // corridor's exit.
        if (freedFromZone) {
          const released = releaseImposedFrame(frame, dragCanvasBounds.current);
          frame.style.transform = "";
          dragStartPosition.current = { x: released.x, y: released.y };
        }

        // Hit-test tab bars for merge on drop. [D45]
        if (onCardMerged && activeCardId) {
          const cx = e.clientX;
          const cy = e.clientY;
          for (const entry of dragTabBarCache.current) {
            const r = entry.rect;
            if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
              const insertIndex = computeMergeInsertIndex(entry.el, cx);
              onCardMerged(id, entry.paneId, insertIndex);
              dragTabBarCache.current = [];
              // Reset all drag state.
              dragOtherRects.current = [];
              latestAltKey.current = false;
              lastSnapResult.current = null;
              return;
            }
          }
        }

        dragTabBarCache.current = [];

        // Compute final clamped position.
        const clampedPos = clampedPosition(
          { x: e.clientX, y: e.clientY },
          dragStartPointer.current,
          dragStartPosition.current,
          dragCanvasBounds.current,
          { width: frame.offsetWidth, height: frame.offsetHeight },
          dragZoom,
        );

        // Apply snapped position if snap was active at drop.
        const snapResult = lastSnapResult.current;
        const finalPos = {
          x: snapResult && snapResult.x !== null ? snapResult.x : clampedPos.x,
          y: snapResult && snapResult.y !== null ? snapResult.y : clampedPos.y,
        };

        frame.style.left = `${finalPos.x}px`;
        frame.style.top = `${finalPos.y}px`;

        // A dragged pane leaves its slot: the explicit gesture wins, and the
        // dropped rect becomes its free geometry. Resize never passes this.
        onCardMoved(
          id,
          finalPos,
          { width: frame.offsetWidth, height: frame.offsetHeight },
          derivedRef.current ? { evictSlot: true } : undefined,
        );

        // Reset all drag state.
        dragOtherRects.current = [];
        latestAltKey.current = false;
        lastSnapResult.current = null;
      }

      frame.addEventListener("pointermove", onPointerMove);
      frame.addEventListener("pointerup", onPointerUp);
      // The two endings the pane drag never had (Spec S03).
      //
      // On WINDOW, in capture, and that is not interchangeable with `document`.
      // The responder chain's own key listener is a window-capture listener
      // (`responder-chain-provider.tsx`), and capture descends outward-in — so
      // a document-capture listener runs AFTER it and never sees a key the
      // chain stopped. `tugways/block-reorder.ts` registers its drag's Escape the
      // same way, for the same reason; `card-drag-coordinator.ts` uses
      // `document` and gets away with it only because nothing swallows the keys
      // it cares about first.
      frame.addEventListener("pointercancel", onPointerCancel);
      window.addEventListener("keydown", onGestureKeyDown, true);
      window.addEventListener("keyup", onGestureKeyUp, true);
    },
    // position.x/y captured into dragStartPosition at drag-start; id, onCardMoved,
    // onCardMerged, activeCardId, and store are stable or handled via closure capture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, onCardMoved, onCardMerged, activeCardId, position.x, position.y, store],
  );

  // ---------------------------------------------------------------------------
  // Resize system
  //
  // Same three-phase pattern as drag: snapshot at start, rAF frame updates,
  // commit on pointer-up. Supports 8 edge/corner handles, min-size clamping,
  // and snap-to-edge.
  // ---------------------------------------------------------------------------

  // Snap guide DOM elements for resize (separate from drag guides). [D03]
  const resizeGuideEls = useRef<HTMLElement[]>([]);

  const handleResizeStart = useCallback(
    (edge: ResizeEdge, event: React.PointerEvent) => {
      // Pane activation (including the metaKey-held no-activate
      // nuance) is handled by `pane-focus-controller.ts`'s
      // document-level capture-phase pointerdown listener, which
      // fires before this handler. No per-handle activation call
      // is needed.
      event.stopPropagation();

      if (!frameRef.current) return;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const frame: HTMLDivElement = frameRef.current!;

      const pid = event.nativeEvent.pointerId;
      frame.setPointerCapture(event.nativeEvent.pointerId);

      // Disable height transition during resize. [D07, chrome.css]
      frame.setAttribute("data-gesture", "true");

      // Hold the reader's place across the drag. Opened at pointer-down
      // rather than at the move latch, because this is the last moment
      // the pre-gesture layout is on screen — a gesture that turns out to
      // be a click closes it having changed nothing.
      const scrollEpisode = beginResizeEpisode(frame, GESTURE_EPISODE_WINDOW_MS);

      const startX = event.clientX;
      const startY = event.clientY;

      // Snapshot canvas bounds and other card rects for resize snapping. [D04]
      // Snap geometry runs in layout space; divide visual measurements by zoom.
      const resizeZoom = getTugZoom() || 1;
      const resizeGuideEdgeOffsets = measureGuideEdgeOffsets(frame, resizeZoom);
      const resizeCanvasBounds = frame.parentElement?.getBoundingClientRect() ?? null;

      // Resizing releases an imposed pane from its slot, exactly as dragging
      // does — and on the same terms: only once the pointer has travelled far
      // enough for the gesture to be a resize rather than a click. Until the
      // latch below sets, nothing here has written to the frame, so the
      // release's measurement at latch time sees the same rect it would have
      // seen at pointer-down.
      let resizeMoved = false;
      let released: { x: number; y: number; width: number; height: number } | null = null;
      let startLeft = position.x;
      let startTop = position.y;
      let startW = size.width;
      let startH = size.height;
      const resizeOtherCardRects = snapshotCardRects(resizeCanvasBounds, id, resizeZoom);
      const resizeOtherRects = resizeOtherCardRects.map((r) => r.rect);

      const latestResizePointer = { x: startX, y: startY };
      let latestResizeModifier = event.nativeEvent.altKey;
      let resizeRafId: number | null = null;
      let resizeActive = true;

      /**
       * Answer whether the gesture has become a resize, latching it the first
       * time the pointer travels past the threshold. A derived pane converts to
       * free pixel geometry at that moment, and the machine re-seeds from the
       * measurement rather than from stale stored geometry.
       */
      function latchResizeMove(pointer: { x: number; y: number }): boolean {
        if (resizeMoved) return true;
        const travelled = Math.hypot(pointer.x - startX, pointer.y - startY);
        if (travelled < DRAG_MOVE_THRESHOLD_PX) return false;
        resizeMoved = true;
        // A shrinking edge exposes what this frame was covering, without a
        // store commit; reveal occluded panes now and hold hides until the
        // gesture ends.
        paneOcclusionGesture.begin();
        if (derivedRef.current) {
          const frozen = releaseImposedFrame(frame, resizeCanvasBounds);
          released = frozen;
          startLeft = frozen.x;
          startTop = frozen.y;
          startW = frozen.width;
          startH = frozen.height;
        }
        return true;
      }

      function computeAndApplyResize(pointer: { x: number; y: number }, snapModifier: boolean): {
        left: number; top: number; width: number; height: number;
      } {
        const r = resizeDelta(
          pointer,
          { x: startX, y: startY },
          startLeft,
          startTop,
          startW,
          startH,
          edge,
          minSizeRef.current,
          resizeCanvasBounds,
          maxSizeRef.current,
          resizeZoom,
        );

        // Apply snap-to-edge if modifier is held. [D01]
        if (snapModifier) {
          // Build the set of edges being actively resized (absolute canvas coords).
          const resizingEdges: { top?: number; bottom?: number; left?: number; right?: number } =
            {};
          if (edge.includes("n")) resizingEdges.top = r.top;
          if (edge.includes("s")) resizingEdges.bottom = r.top + r.height;
          if (edge.includes("w")) resizingEdges.left = r.left;
          if (edge.includes("e")) resizingEdges.right = r.left + r.width;

          // Pass borderWidth=1 so adjacent-edge resize snaps overlap by 1px for border collapse. [D56]
          const snapResult = computeResizeSnap(resizingEdges, resizeOtherRects, -IMPOSITION_GAP_PX);

          // Apply snapped values back to the rect, clamped to minSize.
          let { left, top, width, height } = r;
          if (snapResult.left !== undefined) {
            const newW = Math.max(minSizeRef.current.width, left + width - snapResult.left);
            left = left + width - newW;
            width = newW;
          }
          if (snapResult.right !== undefined) {
            width = Math.max(minSizeRef.current.width, snapResult.right - left);
          }
          if (snapResult.top !== undefined) {
            const newH = Math.max(minSizeRef.current.height, top + height - snapResult.top);
            top = top + height - newH;
            height = newH;
          }
          if (snapResult.bottom !== undefined) {
            height = Math.max(minSizeRef.current.height, snapResult.bottom - top);
          }

          // Render resize snap guides. [D03]
          const container = frame.parentElement;
          if (container) {
            syncGuideElements(resizeGuideEls, snapResult.guides, container, resizeGuideEdgeOffsets);
          }

          return { left, top, width, height };
        } else {
          clearGuideElements(resizeGuideEls);
          return r;
        }
      }

      function applyResizeFrame() {
        resizeRafId = null;
        if (!resizeActive) return;
        if (!latchResizeMove(latestResizePointer)) return;
        const r = computeAndApplyResize(latestResizePointer, latestResizeModifier);
        frame.style.left = `${r.left}px`;
        frame.style.top = `${r.top}px`;
        frame.style.width = `${r.width}px`;
        frame.style.height = `${r.height}px`;
      }

      function onPointerMove(e: PointerEvent) {
        latestResizePointer.x = e.clientX;
        latestResizePointer.y = e.clientY;
        latestResizeModifier = e.altKey;
        if (resizeRafId === null) {
          resizeRafId = requestAnimationFrame(applyResizeFrame);
        }
      }

      function onPointerUp(e: PointerEvent) {
        if (!resizeActive) return;
        resizeActive = false;
        if (resizeRafId !== null) {
          cancelAnimationFrame(resizeRafId);
          resizeRafId = null;
        }
        frame.removeEventListener("pointermove", onPointerMove);
        frame.removeEventListener("pointerup", onPointerUp);
        frame.releasePointerCapture(e.pointerId);

        // Re-enable height transition now that the resize gesture is complete. [D07]
        frame.removeAttribute("data-gesture");

        // The pointer never travelled, so this was a click on a resize handle.
        // Nothing was resized and nothing is committed — in particular a
        // derived pane keeps the slot or the pin it started with. The handles
        // overhang the frame into the imposition gap, so a stray click on the
        // seam between two imposed cards is easy to make; committing here
        // would evict a card from its slot at a pixel-identical rect, and the
        // arrangement would only visibly break at the next canvas change.
        if (!latchResizeMove({ x: e.clientX, y: e.clientY })) {
          clearGuideElements(resizeGuideEls);
          scrollEpisode.end();
          return;
        }

        // Close the occlusion bracket opened at the move latch.
        paneOcclusionGesture.end();

        // Compute final resize with snap applied first, THEN clear guides. [D03]
        const r = computeAndApplyResize({ x: e.clientX, y: e.clientY }, e.altKey);
        clearGuideElements(resizeGuideEls);
        frame.style.left = `${r.left}px`;
        frame.style.top = `${r.top}px`;
        frame.style.width = `${r.width}px`;
        frame.style.height = `${r.height}px`;

        // A resized pane leaves its slot, on the same footing as a dragged one:
        // any manual geometry gesture releases the pane, and there is no
        // control that does it any other way.
        onCardMoved(
          id,
          { x: r.left, y: r.top },
          { width: r.width, height: r.height },
          released !== null ? { evictSlot: true } : undefined,
        );

        // After the final geometry is written, so the last anchor lands
        // against the size the pane keeps.
        scrollEpisode.end();
      }

      frame.addEventListener("pointermove", onPointerMove);
      frame.addEventListener("pointerup", onPointerUp);
    },
    // minSizeRef.current is always current; position/size are start values read at resize-start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, onCardMoved, position.x, position.y, size.width, size.height],
  );

  // Deck-facing-edge resize for a pinned rail. It stays pinned to its
  // side, so only its width changes. For a right-side rail the exposed edge
  // is the west one (dragging left grows it); for a left-side rail it is the
  // east edge (dragging right grows it). Width-only keeps the derived pin
  // intact (the generic handler would set left/top, fighting it). The commit
  // writes `size.width` to the pane; the reopen-width mirror to `sidebarWidthStore`
  // lives in the deck manager's card-moved handler, keeping this pane
  // card-agnostic.
  //
  // The width is written as `sidebarWidthProperty(side)` on the frames' container
  // rather than onto this frame, because the width is not this frame's alone:
  // a right-side rail is pinned by an expression that SUBTRACTS its width from
  // the canvas, and the band the cards ride is inset by it. Writing the frame's
  // own `width` moves only the dragged edge's box and leaves those two
  // expressions on the width the last render baked in — the rail's pinned edge
  // walks off the deck edge it is supposed to hold, and the cards do not learn
  // the rail moved until pointer-up. One property write feeds all three, and
  // the browser resolves them together: the pinned edge holds and the
  // arrangement re-imposes under the moving edge, live ([L06]).
  //
  // The exposed edge snaps with Option held, exactly like any other pane
  // edge: the rail is the moving side and every other pane is a snap target.
  // Those targets are re-measured per frame rather than snapshotted at gesture
  // start — under live re-imposition a card's edge moves as the rail grows, and
  // a guide drawn from a start-of-gesture rect would mark an alignment that is
  // no longer there. [D01, D03, D04]
  const handleSidebarResizeStart = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!frameRef.current) return;
      if (sidebarSide === undefined) return;
      const frame: HTMLDivElement = frameRef.current;
      const container = frame.parentElement;
      if (!container) return;

      // A rail drag is not one pane's resize: the property it writes insets
      // the band every content pane rides, so the whole arrangement re-widths
      // live under the moving edge. Every frame in the container gets an
      // episode, the rail's own included.
      const scrollEpisodes = [
        ...container.querySelectorAll<HTMLElement>(".tug-pane[data-pane-id]"),
      ].map((paneFrame) =>
        beginResizeEpisode(paneFrame, GESTURE_EPISODE_WINDOW_MS),
      );
      const endScrollEpisodes = (): void => {
        for (const episode of scrollEpisodes) episode.end();
      };

      const widthProperty = sidebarWidthProperty(sidebarSide);
      const zoom = getTugZoom() || 1;
      const startClientX = event.clientX;
      const startWidth = size.width;
      const minWidth = sizePolicy.min.width;
      const maxWidth = Math.max(
        minWidth,
        window.innerWidth - RAIL_MIN_GUTTER_PX,
      );
      // A left rail's deck edge faces right (east): rightward motion
      // grows it. A right rail's deck edge faces left (west): leftward
      // motion grows it.
      const growSign = sidebarSide === "left" ? 1 : -1;

      // The pinned edge is measured rather than derived from `position`, which
      // a pinned rail does not use. It is a fixed number for the gesture:
      // the deck edge the rail holds is the one thing this drag may not move.
      const canvasBounds = container.getBoundingClientRect();
      const guideEdgeOffsets = measureGuideEdgeOffsets(frame, zoom);
      const frameRect = frame.getBoundingClientRect();
      const canvasLeft = canvasBounds.left;
      const pinnedEdge =
        sidebarSide === "left"
          ? (frameRect.left - canvasLeft) / zoom
          : (frameRect.right - canvasLeft) / zoom;

      frame.setPointerCapture(event.pointerId);
      frame.setAttribute("data-gesture", "resize");

      let width = startWidth;
      let latestX = startClientX;
      let latestAlt = event.altKey;
      let rafId: number | null = null;
      let railResizeMoved = false;

      // The deck-facing edge is a handle like any other: under the move
      // threshold the press is a click, which states no width and commits
      // nothing.
      const latchSidebarResizeMove = (clientX: number): boolean => {
        if (railResizeMoved) return true;
        if (Math.abs(clientX - startClientX) < DRAG_MOVE_THRESHOLD_PX) return false;
        railResizeMoved = true;
        // A rail is a coverer like any other pane; a shrinking rail
        // exposes what it hid, without a store commit until pointer-up.
        paneOcclusionGesture.begin();
        return true;
      };

      const computeWidth = (): number => {
        // Convert the visual pointer delta to layout space via zoom, then
        // apply the deck-facing grow direction.
        const deltaLayout = (latestX - startClientX) / zoom;
        let next = Math.min(
          maxWidth,
          Math.max(minWidth, startWidth + growSign * deltaLayout),
        );

        if (!latestAlt) {
          clearGuideElements(resizeGuideEls);
          return next;
        }

        // The exposed edge is the only one being resized; the pinned edge
        // never moves, so width follows directly from the snapped edge.
        const exposedEdge = pinnedEdge + growSign * next;
        const snapResult = computeResizeSnap(
          sidebarSide === "left" ? { right: exposedEdge } : { left: exposedEdge },
          snapshotCardRects(canvasBounds, id, zoom).map((r) => r.rect),
          -IMPOSITION_GAP_PX,
        );
        const snapped = sidebarSide === "left" ? snapResult.right : snapResult.left;
        if (snapped !== undefined) {
          next = Math.min(
            maxWidth,
            Math.max(minWidth, growSign * (snapped - pinnedEdge)),
          );
        }

        syncGuideElements(resizeGuideEls, snapResult.guides, container, guideEdgeOffsets);
        return next;
      };

      const apply = (): void => {
        rafId = null;
        if (!latchSidebarResizeMove(latestX)) return;
        width = computeWidth();
        container.style.setProperty(widthProperty, `${width}px`);
      };

      const onPointerMove = (e: PointerEvent): void => {
        latestX = e.clientX;
        latestAlt = e.altKey;
        if (rafId === null) rafId = requestAnimationFrame(apply);
      };

      const onPointerUp = (e: PointerEvent): void => {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        frame.removeEventListener("pointermove", onPointerMove);
        frame.removeEventListener("pointerup", onPointerUp);
        frame.releasePointerCapture(e.pointerId);
        frame.removeAttribute("data-gesture");
        latestX = e.clientX;
        latestAlt = e.altKey;
        if (!latchSidebarResizeMove(latestX)) {
          clearGuideElements(resizeGuideEls);
          endScrollEpisodes();
          return;
        }
        // Close the occlusion bracket opened at the move latch.
        paneOcclusionGesture.end();
        // Final width with snap applied, THEN clear the guides. [D03]
        width = computeWidth();
        clearGuideElements(resizeGuideEls);
        // The property stays as the gesture left it. The commit re-renders the
        // rail at this width and `DeckCanvas` writes the same number back, so
        // there is no frame where the deck reads the pre-gesture width.
        container.style.setProperty(widthProperty, `${width}px`);
        onCardMoved(id, position, { width, height: size.height });
        endScrollEpisodes();
      };

      frame.addEventListener("pointermove", onPointerMove);
      frame.addEventListener("pointerup", onPointerUp);
    },
    [
      id,
      onCardMoved,
      position,
      size.width,
      size.height,
      sizePolicy.min.width,
      sidebarSide,
    ],
  );


  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // Persisted size can predate the current floor — a card kind
  // raised its policy `min`, or a wider sibling joined the stack, so
  // the stored width/height may sit below `minSize`. Clamp the
  // rendered frame up to the floor: the pane paints at its true
  // minimum immediately, and the next move or resize commits the
  // corrected size back to the store.
  const renderWidth = Math.max(size.width, minSize.width);
  const frameHeight = Math.max(size.height, minSize.height);

  // A card whose policy pins an axis — `min === max`, which is how a
  // registration says "exactly one correct size" — is PLACED by the imposition
  // rather than sized by it: no resize handle offers to change that dimension,
  // so the imposer must not change it either. The declaration is already in the
  // registry, so nothing new has to be declared to opt in. A policy with no
  // `max` is unbounded above and therefore never pinned.
  //
  // The pinned axes travel together into `imposeStyle`, which needs both to
  // separate the slot from the frame: the slot is an ordinary content card's
  // box, and the pinned card is centred inside it (see `PinnedFrame`).
  const widthPinned = sizePolicy.max?.width === sizePolicy.min.width;
  const heightPinned = sizePolicy.max?.height === sizePolicy.min.height;
  const pinnedFrame: PinnedFrame | undefined =
    widthPinned || heightPinned
      ? {
          ...(widthPinned ? { width: renderWidth } : {}),
          ...(heightPinned ? { height: frameHeight } : {}),
        }
      : undefined;
  // A width-pinned card's slot is the deck's content width, not its own — but
  // never narrower than the card, or the slot would sit inside the frame.
  const slotWidth =
    widthPinned && contentWidthPx !== undefined
      ? Math.max(contentWidthPx, renderWidth)
      : renderWidth;
  // Bullseye's width is `comfy`, held between the stack's own bounds by the
  // same `resolveContentWidthPx` call the width doors make — not a fourth
  // number and not a second opinion about width ([D130]).
  const bullseyeWidth = resolveContentWidthPx(
    DEFAULT_CONTENT_WIDTH,
    sizePolicy.min.width,
    sizePolicy.max?.width,
  );

  // The width control, on content-role panes only: a rail takes its width from
  // the allocator, so a preset there would be overwritten by the next solve.
  // Dispatched as a command rather than called on the store ([L30]).
  const handleSetWidth = useCallback(
    (preset: ContentWidth) => {
      dispatchCommand(TUG_ACTIONS.SET_CARD_WIDTH, { paneId: id, preset });
    },
    [id],
  );

  // The target button's act, on the same path the width control takes: the
  // pane-addressed command, naming this pane rather than "the pane I am in"
  // ([L30]). The press lands after the title bar's own activation, so by the
  // time the command runs this pane is the selection and the derived accessor
  // can read the posture back.
  const handleToggleBullseye = useCallback(() => {
    dispatchCommand(TUG_ACTIONS.SET_BULLSEYE, { paneId: id });
  }, [id]);

  // The arrange verbs the stack badge offers, on the same path the width
  // control takes: dispatched as registered commands rather than threaded back
  // through `DeckCanvas` as two more props ([L30]). The title bar keeps
  // rendering from props alone and the pane owns the dispatch.
  //
  // The badge is one control over two kinds of place. Which pair of commands a
  // verb resolves to is decided HERE, from what this pane actually stands in —
  // a rail if it holds a side, otherwise its slot — rather than in the bar,
  // which has no business knowing the deck has two kinds of place.
  const handleArrangePlace = useCallback(
    (verb: "split" | "stack" | "equalize") => {
      if (sidebarSide !== undefined) {
        if (verb === "equalize") {
          dispatchCommand(TUG_ACTIONS.EQUALIZE_RAIL, { side: sidebarSide });
          return;
        }
        dispatchCommand(TUG_ACTIONS.SET_RAIL_MODE, {
          side: sidebarSide,
          mode: verb,
        });
        return;
      }
      const slot = placement?.slot;
      if (slot === undefined) return;
      if (verb === "equalize") {
        dispatchCommand(TUG_ACTIONS.EQUALIZE_COLUMN, { slot });
        return;
      }
      dispatchCommand(TUG_ACTIONS.SET_COLUMN_MODE, { slot, mode: verb });
    },
    [sidebarSide, placement],
  );

  const closable = effectiveMeta.closable !== false;

  // Pane-close confirmation policy. Multi-card panes always confirm —
  // closing the pane discards every hosted tab at once, so the guard is
  // unconditional. Single-card panes follow the active card's opt-in
  // (`confirmClose: true` in its registration). Defaults to no
  // confirm for single-card panes whose card type doesn't opt in.
  const paneConfirmClose =
    (cards?.length ?? 1) > 1 || effectiveMeta.confirmClose === true;

  // …unless the one card in a single-card pane says it is holding nothing
  // (an empty Session card). Resolved at close time, not here: the card
  // fills up without the pane re-rendering. A multi-card pane keeps its
  // guard unconditionally — that one is about discarding N tabs at once.
  const soleCardId = (cards?.length ?? 1) > 1 ? null : (cards?.[0]?.id ?? activeCardId);
  const resolveCloseAdvice = useCallback(
    (): CardCloseAdvice | null =>
      soleCardId === null ? null : readCardCloseAdvice(soleCardId),
    [soleCardId],
  );

  const rootRefCallback = useCallback(
    (el: HTMLDivElement | null) => {
      setCardEl(el);
      responderRef(el);
    },
    [responderRef],
  );

  // Three geometry modes, and one presentation over them. A pinned sidebar
  // holds one side of the canvas a gap in, runs the canvas height less a gap
  // top and the deeper gap at the bottom, and takes only its width from the
  // store. An imposed pane pins to its place in the imposition chain over the
  // same vertical run, also taking only its width from the store — unless it
  // is size-locked, in which case the slot is an ordinary content card's box
  // and the pane is centred inside it. A free pane uses its stored
  // left/top/width/height. [L06]/[L09]
  //
  // Bullseye is not a fourth mode: it is a presentation that supersedes
  // whichever mode the pane holds, for as long as the pane holds focus, and
  // it writes nothing — so the branch below it is what the frame returns to
  // on exit, unchanged. It comes first because that supersession is the whole
  // point. Precedence over imposed is the feature (a slotted card bullseyes
  // to the centre and returns to its slot); precedence over pinned is
  // defensive only, since a rail can never be bullseyed. The placement is
  // one-up — `travelFraction` already answers 0.5 for `count < 2`, so
  // "centred in the band" is the imposer's existing definition rather than
  // new centring math.
  const modeStyle: CSSProperties = bullseye
    ? // Bullseye supersedes the column: a bullseyed pane is centred in the band
      // at the comfy width, taking the whole run, and returns to its share of
      // the split on exit.
      imposeStyle({ slot: 0, count: 1 }, bullseyeWidth, pinnedFrame)
    : sidebarSide !== undefined
      ? imposeSidebarStyle(sidebarSide, renderWidth, railMember)
      : imposed && placement !== undefined
        ? imposeStyle(placement, slotWidth, pinnedFrame, { member: columnMember })
        : {
            left: position.x,
            top: position.y,
            width: renderWidth,
            height: frameHeight,
          };

  // Another pane is in bullseye, so this one leaves the canvas by the
  // horizontal edge it is already nearest. Overrides `left` alone: the
  // vertical run, the width, and the mode's other pins all stand, so the pane
  // slides straight out and straight back.
  //
  // THIS PANE'S SIDE IS READ FROM `modeStyle.left`, its ACTUAL resolved pin,
  // never from `position.x`. For an imposed pane the stored position is a
  // last-known value the imposer has long since superseded — a three-up deck
  // can have all three panes stored at nearly the same x while sitting left,
  // centre, and right on screen — so deciding from it sent every card out the
  // same side. `modeStyle.left` is a number for a free pane and the imposer's
  // `calc()` for a slotted one, and both compose here.
  //
  // THE LINE IT IS COMPARED AGAINST is the bullseyed pane's own former
  // centre, handed down in `bullseyeExit` — not the canvas centre. Panes left
  // of the bullseyed card leave leftward and panes right of it leave
  // rightward, so no pane ever crosses the card arriving at the middle. The
  // canvas centre was the first cut and it produced exactly that crossing:
  // bullseye the leftmost card of a three-up and the middle card, still left
  // of the canvas centre, slid left THROUGH it.
  //
  // The comparison itself stays in CSS rather than being resolved here: both
  // terms are length expressions over the live insets, and evaluating them at
  // render would mean measuring, which is the observation [L06] keeps out of
  // the geometry path. A clamp does it instead — the inner term is this
  // pane's centre minus that line, negative on one side and positive on the
  // other, and multiplying by a large number saturates it into one bound or
  // the other. The 1px bias breaks an exact tie toward the left, which would
  // otherwise resolve to 0 and leave the pane sitting on screen.
  //
  // BOTH BOUNDS PARK THE PANE JUST PAST ITS OWN EDGE — one gap beyond, not a
  // whole canvas away. That symmetry is about the MOTION, not the resting
  // place: the frame animates out on the FLIP settle, and a left bound of
  // `-100%` would send a left-leaving pane a full canvas-width further than a
  // right-leaving one travels, so the two would cross at visibly different
  // speeds over the same duration. Equal travel, equal read.
  //
  // The win over measuring: this re-resolves on a window resize for free,
  // like every other pin the imposer emits, and the right bound stays a
  // percentage — the form that lets the settle cross rather than cut ([D121]).
  const exitStyle: CSSProperties =
    bullseyeExit === undefined
      ? {}
      : {
          left: `clamp(${-(renderWidth + IMPOSITION_GAP_PX)}px, (${cssLength(modeStyle.left)} + ${renderWidth / 2}px - ${bullseyeExit} - 1px) * 10000, calc(100% + ${IMPOSITION_GAP_PX}px))`,
        };

  return (
    <div
      ref={frameRefCallback}
      className="tug-pane"
      data-testid="tug-pane"
      data-pane-id={id}
      // The chrome tier this pane wears. CSS turns it into
      // `--tugx-pane-chrome-height`, which every in-pane surface seating below
      // the title bar measures against — the scrim, the sheet's clip, the
      // banner. A custom property rather than a measured number, so the 72↔36
      // swap is one cascade and not four subscriptions ([L06]).
      {...(activeCardMasthead !== null ? { "data-masthead": "true" } : {})}
      // The rail tier, stamped here as well as on the bar so the height is a
      // pane fact: the scrim, the sheet clip, and the banner all seat below a
      // 32px bar. CSS cannot read the bar's own attribute from up here —
      // `:has()` does not invalidate on a descendant attribute change.
      {...(isRail ? { "data-role": "sidebar" } : {})}
      {...(isSidebarPane ? { "data-sidebar-pane": "" } : {})}
      // `data-rail-side` is NOT the same bit: it carries which edge a rail is
      // pinned to, and a released rail has rail chrome with no side.
      {...(sidebarSide !== undefined ? { "data-rail-side": sidebarSide } : {})}
      // A member of a rail that is currently divided rather than stacked — the
      // sibling bit to `data-rail-side`, and what the seam elements and the reorder
      // drag find their fellow members by.
      {...(railSplit ? { "data-rail-split": "" } : {})}
      // Which card of the rail this frame is, so a reorder can name its
      // members the way the record does — by componentId, not by pane id.
      {...(railSplit && sidebarStack !== undefined
        ? { "data-rail-member": sidebarStack.componentId }
        : {})}
      // A member of a column that is currently divided rather than stacked — the
      // content-side sibling of `data-rail-split`, and what the column seams
      // and the split UI find their fellow members by. Suppressed under
      // bullseye, which supersedes the column and takes the whole run.
      {...(columnMember !== undefined && !bullseye
        ? {
            "data-column-split": "",
            "data-column-member": String(columnMember.index),
          }
        : {})}
      {...(imposed && placement !== undefined && !bullseye
        ? { "data-imposed": String(placement.slot) }
        : {})}
      {...(bullseye ? { "data-bullseye": "" } : {})}
      data-stack-depth={String(slotStack.length)}
      style={{
        position: "absolute",
        ...modeStyle,
        ...exitStyle,
        zIndex,
        boxSizing: "border-box",
        // Expose the pane's minimum width to descendants via CSS custom
        // property. `wide` TugSheets size relative to this floor rather
        // than the pane's (potentially much larger) live width, so a
        // wide sheet stays a predictable size instead of sprawling on a
        // big card. [L06]
        ["--tug-pane-min-width" as string]: `${sizePolicy.min.width}px`,
      }}
    >
      {/* Resize handles. A pinned sidebar exposes only its deck-facing edge
          (west for a right-side rail, east for a left-side one).
          Everything else exposes all eight, imposed or not: resizing an imposed
          pane releases it from its slot, so there is no edge it needs to be
          protected from. */}
      {sidebarSide !== undefined ? (
        // A rail standing in bullseye exposes no edge at all. Its one handle
        // drags the RAIL's width — measured from the deck edge the rail is
        // pinned to — and the frame is not standing there for the moment, so
        // the drag would resize the place the rail is holding open from a
        // grip nowhere near it. The handle comes back with the rail.
        bullseye ? null : (
          <div
            className={`tug-pane-resize tug-pane-resize-${sidebarSide === "left" ? "e" : "w"}`}
            onPointerDown={handleSidebarResizeStart}
          />
        )
      ) : (
        RESIZE_EDGES.map((edge) => (
          <div
            key={edge}
            className={`tug-pane-resize tug-pane-resize-${edge}`}
            onPointerDown={(e) => handleResizeStart(edge, e)}
          />
        ))
      )}

      <TugPaneFrameContext value={frameEl}>
      <TugPanePortalContext value={cardEl}>
        <div
          ref={rootRefCallback}
          className="tug-pane-chrome"
          data-slot="tug-pane"
          data-pane-id={stackId}
        >
          <CardTitleBar
            ref={titleBarRef}
            title={displayTitle}
            icon={effectiveMeta.icon}
            closable={closable}
            {...(sidebarSide === undefined
              ? {
                  widthPreset: stackState.widthPreset ?? null,
                  onSetWidth: handleSetWidth,
                }
              : {})}
            cardCount={cards?.length ?? 1}
            resolveCloseGuard={resolveCloseGuard}
            resolveModalHold={resolveModalHold}
            confirmClose={paneConfirmClose}
            resolveCloseAdvice={resolveCloseAdvice}
            activeCardId={activeCardId}
            slotStack={slotStack}
            onRevealPane={onRevealPane}
            bullseye={bullseye}
            onToggleBullseye={handleToggleBullseye}
            {...(sidebarStack !== undefined
              ? {
                  placeArrangement: {
                    mode: sidebarStack.mode,
                    kind: "rail" as const,
                    index: sidebarStack.memberIndex,
                    count: sidebarStack.count,
                  },
                  onArrangePlace: handleArrangePlace,
                }
              : placement !== undefined
                ? {
                    // A content pane standing in a slot — sharing it or not.
                    // The `slotStack.length > 1` gate this once carried is
                    // gone: it made the arrangement record, and with it the
                    // badge's whole menu, conditional on already having a
                    // neighbour, so the one card that most needs "Split
                    // Vertically" — a card alone in its column — was the one
                    // card with no door to it. A slot is a place at depth one.
                    //
                    // The mode is read off
                    // `columnMember`, which `DeckCanvas` sets exactly when the
                    // column is split and has two or more members — the same
                    // condition the geometry uses, so the badge cannot offer
                    // "Stack" for a column that is already drawing as one.
                    placeArrangement: {
                      mode: (columnMember !== undefined
                        ? "split"
                        : "stack") as RailMode,
                      kind: "column" as const,
                      // A stacked column has no member record and needs none:
                      // the badge draws the depth, and every pane in the stack
                      // draws the same one.
                      index: columnMember?.index ?? 0,
                      count: columnMember?.count ?? slotStack.length,
                    },
                    onArrangePlace: handleArrangePlace,
                  }
                : {})}
            masthead={activeCardMasthead}
            sidebar={isRail}
            onClose={handleTitleBarClose}
            onDragStart={handleDragStart}
          />

          <div className="tug-pane-body" data-testid="tug-pane-body">
            <ResponderScope>
              <div
                ref={accessoryRef}
                className="tug-pane-accessory"
                data-testid="tug-pane-accessory"
                data-pane-id={stackId}
                style={resolvedAccessory == null ? { height: 0, overflow: "hidden" } : undefined}
              >
                {resolvedAccessory}
              </div>

              <div
                ref={contentRef}
                className="tug-pane-content"
                data-testid="tug-pane-content"
              />
            </ResponderScope>
          </div>

          {/* Pane-owned scrim layer [D18]. Permanent element; visibility
              is driven by `data-scrim` on the chrome (set imperatively
              by `useTugPaneScrim()` consumers via the pane-scrim
              registry). Sized below the title bar so the title bar
              stays interactive while pane-modal surfaces are up. */}
          <div className="tug-pane-scrim" aria-hidden="true" data-testid="tug-pane-scrim" />
        </div>
      </TugPanePortalContext>
      </TugPaneFrameContext>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Geometry helpers (pure functions, testable in isolation)
// ---------------------------------------------------------------------------

/**
 * Compute drag position with Finder-style constraining.
 *
 * The card may overhang any edge, but enough of its title bar must stay
 * visible and grabbable:
 * - Top: title bar top stays at or below y = 0 (cannot move above canvas).
 * - Bottom: at least TITLE_BAR_VISIBLE_MIN_Y of the title bar stays visible.
 * - Left/Right: at least TITLE_BAR_VISIBLE_MIN_X of the title bar stays visible.
 */
function clampedPosition(
  pointer: { x: number; y: number },
  startPointer: { x: number; y: number },
  startPosition: { x: number; y: number },
  canvasBounds: DOMRect | null,
  frameSize: { width: number; height: number },
  zoom = 1,
): { x: number; y: number } {
  // startPosition/frameSize are layout pixels; pointer is visual (client) pixels.
  // Convert the pointer delta to layout space so the card tracks the cursor 1:1
  // at any zoom, and clamp against layout-space canvas extents.
  let x = startPosition.x + (pointer.x - startPointer.x) / zoom;
  let y = startPosition.y + (pointer.y - startPointer.y) / zoom;

  if (canvasBounds) {
    const canvasWidth = canvasBounds.width / zoom;
    const canvasHeight = canvasBounds.height / zoom;
    // Left/right: card can hang off either side, but TITLE_BAR_VISIBLE_MIN_X must stay visible.
    x = Math.max(-(frameSize.width - TITLE_BAR_VISIBLE_MIN_X),
                 Math.min(x, canvasWidth - TITLE_BAR_VISIBLE_MIN_X));
    // Top: title bar stays at or below CANVAS_PADDING (matches resize top constraint).
    // Bottom: at least TITLE_BAR_VISIBLE_MIN_Y of title bar stays visible.
    y = Math.max(CANVAS_PADDING, Math.min(y, canvasHeight - TITLE_BAR_VISIBLE_MIN_Y));
  }

  return { x, y };
}

/**
 * Compute new bounding rect after resizing on the given edge.
 *
 * Width and height are clamped to minSize (floor) and maxSize (ceiling).
 * When canvasBounds is provided, the resulting rect is hard-clamped so the
 * card cannot extend beyond the canvas edges (accounting for CANVAS_PADDING).
 * Unlike drag (which uses relaxed Finder-style rules), resize is rigid.
 */
function resizeDelta(
  pointer: { x: number; y: number },
  startPointer: { x: number; y: number },
  startLeft: number,
  startTop: number,
  startW: number,
  startH: number,
  edge: ResizeEdge,
  minSize: { width: number; height: number },
  canvasBounds?: DOMRect | null,
  maxSize?: { width: number; height: number },
  zoom = 1,
): { left: number; top: number; width: number; height: number } {
  // start*/sizes are layout pixels; pointer is visual (client) pixels. Convert
  // the pointer delta to layout so the edge tracks the cursor 1:1 at any zoom.
  const dx = (pointer.x - startPointer.x) / zoom;
  const dy = (pointer.y - startPointer.y) / zoom;

  let left = startLeft;
  let top = startTop;
  let width = startW;
  let height = startH;

  if (edge.includes("e")) {
    width = Math.max(minSize.width, startW + dx);
    if (maxSize) width = Math.min(maxSize.width, width);
  }
  if (edge.includes("w")) {
    let newW = Math.max(minSize.width, startW - dx);
    if (maxSize) newW = Math.min(maxSize.width, newW);
    left = startLeft + (startW - newW);
    width = newW;
  }
  if (edge.includes("s")) {
    height = Math.max(minSize.height, startH + dy);
    if (maxSize) height = Math.min(maxSize.height, height);
  }
  if (edge.includes("n")) {
    let newH = Math.max(minSize.height, startH - dy);
    if (maxSize) newH = Math.min(maxSize.height, newH);
    top = startTop + (startH - newH);
    height = newH;
  }

  // Hard-clamp to canvas bounds so the card cannot be resized past any canvas edge.
  if (canvasBounds) {
    const maxRight = canvasBounds.width / zoom - CANVAS_PADDING;
    const maxBottom = canvasBounds.height / zoom - CANVAS_PADDING;

    // Clamp right edge: prevent card from extending past canvas right.
    if (left + width > maxRight) {
      if (edge.includes("e")) {
        width = Math.max(minSize.width, maxRight - left);
      } else if (edge.includes("w")) {
        left = Math.max(CANVAS_PADDING, left);
        width = startLeft + startW - left;
        if (width < minSize.width) {
          width = minSize.width;
          left = startLeft + startW - width;
        }
      }
    }
    // Clamp left edge.
    if (left < CANVAS_PADDING) {
      const rightEdge = left + width;
      left = CANVAS_PADDING;
      width = Math.max(minSize.width, rightEdge - left);
    }

    // Clamp bottom edge: prevent card from extending past canvas bottom.
    if (top + height > maxBottom) {
      if (edge.includes("s")) {
        height = Math.max(minSize.height, maxBottom - top);
      } else if (edge.includes("n")) {
        top = Math.max(CANVAS_PADDING, top);
        height = startTop + startH - top;
        if (height < minSize.height) {
          height = minSize.height;
          top = startTop + startH - height;
        }
      }
    }
    // Clamp top edge.
    if (top < CANVAS_PADDING) {
      const bottomEdge = top + height;
      top = CANVAS_PADDING;
      height = Math.max(minSize.height, bottomEdge - top);
    }
  }

  return { left, top, width, height };
}
