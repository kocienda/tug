/**
 * CardTitleBar — a pane's title bar: its icon and title or the active card's
 * masthead, the close control and its confirm popover, the rollup of the
 * card's own buttons, the width menu, the bullseye and fold controls, and the
 * place badge with its picker.
 *
 * It renders from props alone, plus the stores it reads itself ([L02]): the
 * active card's title-bar items, the workspace list, and — when it is given
 * `placePaneId` — the place facts off the deck. A bar with no deck behind it
 * passes no `placePaneId` and draws the badge from `placeArrangement`.
 *
 * `PaneChrome` composes it; `TugPane` re-exports the height constants so
 * their importers read them where they always did.
 *
 * @module components/chrome/card-title-bar
 */

import React, {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import { bodyCardsStore } from "@/lib/body-cards-store";
import {
  Blocks,
  ChevronsDownUp,
  CircleDot,
  MoreHorizontal,
  MoveHorizontal,
  X,
  icons,
} from "lucide-react";
import type { SlotStackEntry } from "@/deck-store-selectors";
import { getTugTiming } from "@/lib/scale-timing";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { DeckManagerContext } from "@/deck-manager-context";
import { dispatchCommand, sendToCardContent } from "@/command-dispatch";
import {
  type ColumnMode,
  readSettleMs,
  CONTENT_WIDTH_PRESETS,
  CONTENT_WIDTH_LABELS,
  type ContentWidth,
} from "@/lib/layout-imposer";
import { isSecondaryPress } from "@/lib/whole-entity-press";
import { TugButton } from "@/components/tugways/internal/tug-button";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { TugActionTooltip } from "@/components/tugways/tug-action-tooltip";
import { TugConfirmPopover } from "@/components/tugways/tug-confirm-popover";
import type { CardMastheadPayload } from "@/lib/card-title-store";
import { SessionMasthead } from "@/components/tugways/session-masthead";
import { CardMasthead } from "@/components/tugways/card-masthead";
import { CommitMasthead } from "@/components/tugways/commit-masthead";
import { CardSlotBadge } from "@/components/tugways/card-slot-badge";
import type { SlotFacts } from "@/lib/slot-facts";
import {
  TugColumnBadge,
  columnBadgeCharacter,
} from "@/components/tugways/tug-column-badge";
import { paneTitleBarItemsStore, type PaneTitleBarItem } from "@/lib/pane-title-bar-items-store";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";
import {
  refuseCardModalHold,
  useCardModalHold,
} from "@/lib/card-modal-hold-store";
import { TugPopupMenu } from "@/components/tugways/internal/tug-popup-menu";
import {
  commandAction,
  commandEntry,
  validateCommand,
} from "@/components/tugways/command-registry";
import { commandValidationSource } from "@/lib/host-menu-state";
import type { CardCloseDecision } from "@/lib/card-close-guard";
import type { CardCloseAdvice } from "@/lib/card-close-advice";
import { useSpaceLayerShownSource } from "@/components/chrome/space-layer";
import { useStoreDerived } from "@/lib/use-store-derived";
import { plainEqual } from "@/lib/plain-equal";
import { placeFactsFor, placeSource } from "./pane-place-facts";
import { CardFoldGlyph } from "@/components/chrome/card-fold-glyph";
import type { SpacesSnapshot } from "@/spaces";

const NOOP_SUBSCRIBE = (_listener: () => void): (() => void) => () => {};
const NOOP_SNAPSHOT = (): number => 0;

/**
 * One of the active card's title-bar items: a ghost icon button for a
 * command. Its enablement is the registry's answer asked of the chain, so it
 * asks again whenever the chain's validation version moves — a focus change,
 * a responder registered or gone — as a chain-action button does. A card
 * that draws its chrome in its own page publishes its items as it mounts,
 * before the responder that answers them has registered, and nothing in a
 * quiet page re-publishes them; the button follows the chain itself.
 */
function TitleBarItemButton({
  item,
  activeCardId,
}: {
  item: PaneTitleBarItem;
  activeCardId: string | null;
}): React.ReactElement | null {
  const chain = useResponderChain();
  const [subscribe, getSnapshot] = useMemo(
    () =>
      chain !== null
        ? ([chain.subscribe.bind(chain), chain.getValidationVersion.bind(chain)] as const)
        : ([NOOP_SUBSCRIBE, NOOP_SNAPSHOT] as const),
    [chain],
  );
  useSyncExternalStore(subscribe, getSnapshot);
  const entry = commandEntry(item.commandId);
  const label = entry?.title ?? item.commandId;
  const enabled =
    item.enabled ?? (entry !== undefined && validateCommand(entry, commandValidationSource()));
  const ItemIcon =
    item.icon !== undefined && icons[item.icon as keyof typeof icons] !== undefined
      ? icons[item.icon as keyof typeof icons]
      : null;
  if (ItemIcon === null) return null;
  return (
    <TugTooltip content={enabled ? label : (item.unavailableHint ?? label)}>
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
          onClick={() => {
            // A body card's item goes to that card's content, in its own
            // page: the key card the dispatch would walk from is the deck's
            // first responder, which a press on this pane's bar has not
            // moved yet.
            const action = entry === undefined ? null : commandAction(entry);
            if (activeCardId !== null && action !== null && bodyCardsStore.has(activeCardId)) {
              sendToCardContent(activeCardId, action);
              return;
            }
            dispatchCommand(item.commandId);
          }}
        />
      </span>
    </TugTooltip>
  );
}

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
 * pane's chrome is 88 + 36: masthead on top, tab row beneath it, unchanged.
 */
export const MASTHEAD_HEIGHT = 72;

/**
 * Height of the SESSION card's masthead tier, in either form. Must match
 * `calc(var(--tug-masthead-height) + var(--tugx-session-masthead-extra-line))`
 * — the rule in `tug-pane.css` that raises `--tugx-pane-chrome-height` for
 * `[data-masthead-kind="session"]`.
 *
 * The extra line is the DESCRIPTION run's second one ([B04]): during a turn
 * that run carries the Observer's post, written to a budget no single line
 * of this tier holds, so it wraps to two and the tier grows by exactly one
 * line rather than by whatever the text asks for. It was the folded form's
 * alone ([P07]); it is the Session card's in every form now, because the
 * post is worth the same second line with a transcript under it as without,
 * and a tier that changed height with the fold is a tier the wall's packing
 * has to re-read. Fixed in both directions, so nothing ripples.
 *
 * 88, and it stood at 102 for one arc, when the description line took a LOOSE
 * type setting and the pair needed a band a commit pill is whole in. The pill
 * left the line rather than the tier growing for it.
 */
export const SESSION_MASTHEAD_HEIGHT = 88;

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
   *   - `cardCount <= 1` → "Close <kind>?" ("Close Session?", from
   *     `cardKind`) with a "Close" confirm button.
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
   * The noun the single-card popover names the card by — the active card's
   * `cardKindName`. Defaults to "Card".
   */
  cardKind?: string;
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
   * consulted only when {@link confirmClose} is `true`: a `waive` closes
   * the pane immediately despite the type's opt-in, because the card is
   * holding nothing the confirm would protect (an empty Session card has
   * no transcript, and no draft in its composer).
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
  /**
   * The pane whose place the badge draws. Given, the badge reads the place's
   * members, this pane's band and the count from the deck itself
   * (`pane-place-facts.ts`) rather than from {@link slotStack} and
   * {@link placeArrangement}: those change on every member when one member
   * comes or goes, and as props they re-rendered each survivor's whole bar —
   * its tooltips, popovers and confirm popover — for a number on a chip.
   * Omitted by a bar with no deck behind it, which draws from the props.
   */
  placePaneId?: string;
  /**
   * The slot badge's facts, given, where no deck stands behind the bar to read
   * them from (a card that draws its own chrome). Omitted, the badge reads the
   * deck.
   */
  slot?: SlotFacts | null;
  /**
   * The workspaces the move control lists and the one the pane stands in,
   * given, where no deck stands behind the bar to read them from (a card
   * that draws its own chrome). Omitted, the bar reads the deck.
   */
  spaces?: { spaces: readonly { id: string; name: string }[]; ownSpaceId: string | undefined };
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
    mode: ColumnMode;
    kind: "rail" | "column";
    /** This pane's place in the run, topmost first — the band letter the badge
     *  draws when the place is split. Omitted when {@link placePaneId} is
     *  given: the badge reads it from the deck. */
    index?: number;
    /** How many panes share the place. Omitted with {@link placePaneId}, as
     *  `index` is. */
    count?: number;
  };
  /**
   * Arrange the COLUMN this pane stands in. `"split"` / `"stack"` set the mode;
   * `"equalize"` writes an equal division. Wired by `TugPane` to the registered
   * commands, never to a store method ([L30]) — the same path
   * {@link onSetWidth} takes.
   *
   * A rail passes none of these: it is always divided ([B01]) and its sashes
   * are the hand's, so there is no arrangement verb for its badge to offer.
   */
  onArrangePlace?: (
    verb: "split" | "stack" | "equalize",
  ) => void;
  /**
   * Apply a width preset to this pane. Present exactly when
   * {@link widthPreset} is — together they are "this pane has a width
   * control" — and wired to the `set-card-width` command, never to a store
   * method ([L30]).
   */
  onSetWidth?: (preset: ContentWidth) => void;
  /**
   * Give this slotted card its run's full height again — the Fill Height row
   * at the foot of the width popup, wired to the `fill-card-height` command.
   * Present only where a card's bottom edge can give it a height of its own:
   * alone or stacked in a slot. A split column's heights are its shares, and a
   * free pane's height is not a slot's.
   */
  onFillHeight?: () => void;
  /** Whether the card fills its run now, which checks the Fill Height row.
   *  Read only beside {@link onFillHeight}. */
  fillsHeight?: boolean;
  /**
   * File the pane's active card into another workspace. Wired in `DeckCanvas`
   * to `moveCardToSpace`; [B04] holds, so the user stays where they are and
   * the card is announced only by the destination's count changing.
   *
   * The workspace list the popup offers — every workspace OTHER than the one
   * this pane stands in, by name, in the user's order — is not a prop. The bar
   * reads it off the deck store itself (below), because a list threaded
   * through every pane's props changed on every switch and re-rendered every
   * pane in every mounted workspace for a menu nobody had opened. A list of
   * one is not an absent control: the trigger renders disabled and its
   * tooltip says why, which is the spine's rule everywhere else.
   */
  onMoveToSpace?: (spaceId: string) => void;
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
  /**
   * Whether this pane wears the FOLDED form ([P01], [P03]) — passed on to
   * the Session masthead, and to nothing else. The tier's own geometry is CSS
   * keyed on the frame's `data-folded` ([L06]); the one thing a stylesheet
   * cannot decide is that the beat renders as two runs rather than one, which
   * is the register this carries ([D185]).
   * @default false
   */
  folded?: boolean;
  /**
   * Whether the bar carries the fold's door for the active card ([B06]): a
   * Fold row in the rollup while open, and the pinned {@link CardFoldGlyph}
   * while folded. False on a rail, which does not fold, and on a card that
   * owns its folded form — the Session card's door is its Z2 seat ([B08]).
   * @default false
   */
  cardFold?: boolean;
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

/**
 * The place's arrangement, for the badge alone. Provided by
 * {@link CardTitleBar} and read by {@link CardPlaceBadge}, so a change to it
 * re-renders the badge and nothing else of the bar.
 */
const PlaceArrangementContext = createContext<CardTitleBarProps["placeArrangement"]>(undefined);

/**
 * The Fill Height row's two facts, for the width menu alone. Provided by
 * {@link CardTitleBar} and read by {@link CardWidthMenu}, for the reason
 * {@link PlaceArrangementContext} exists: a split or a stack flips whether a
 * slotted card's height is its own on every member of the column, and as
 * props the pair re-rendered each member's whole bar — its buttons, tooltips
 * and poppers — to redraw one check in a closed menu. The census read that
 * commit at 971–2,123 performed fibres on a nine-pane column flip, landing
 * inside the motion on every retarget.
 */
const FillHeightContext = createContext<
  { onFillHeight: () => void; fillsHeight: boolean } | undefined
>(undefined);

interface CardWidthMenuProps {
  widthPreset: CardTitleBarProps["widthPreset"];
  onSetWidth: (preset: ContentWidth) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The width control's menu: the presets, and below them the Fill Height row
 * where a card's height is its own. Its own component so it can read that row
 * from {@link FillHeightContext} without the bar taking it as props.
 */
const CardWidthMenu = memo(function CardWidthMenu({
  widthPreset,
  onSetWidth,
  open,
  onOpenChange,
}: CardWidthMenuProps) {
  const fill = useContext(FillHeightContext);
  return (
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
      // Controlled, and only because the rollup needs the answer. The menu
      // portals its rows outside the card, so the pointer travelling to a
      // width row leaves the title bar, ends its hover, and would collapse
      // the row this trigger is standing in — leaving an open menu hanging off
      // an anchor that is no longer painted. While it stands, the rollup is
      // held.
      open={open}
      onOpenChange={onOpenChange}
      items={[
        ...CONTENT_WIDTH_PRESETS.map((preset) => ({
          id: preset,
          label: CONTENT_WIDTH_LABELS[preset],
          // No check at a custom width: `widthPreset` is null then, and
          // claiming the nearest preset would be a resting lie.
          selected: widthPreset === preset,
        })),
        // The way back from a height the card's bottom edge gave it ([B07]):
        // checked while the card fills its run, which is the state choosing
        // it puts the card in.
        ...(fill === undefined
          ? []
          : [
              { type: "separator" as const },
              {
                id: FILL_HEIGHT_ITEM,
                label: "Fill Height",
                selected: fill.fillsHeight,
              },
            ]),
      ]}
      onSelect={(id) =>
        id === FILL_HEIGHT_ITEM ? fill?.onFillHeight() : onSetWidth(id as ContentWidth)
      }
      data-testid="tug-pane-title-bar-width-menu"
    />
  );
});

interface CardPlaceBadgeProps {
  placePaneId: string | undefined;
  slotStack: readonly SlotStackEntry[];
  onArrangePlace: CardTitleBarProps["onArrangePlace"];
  onRevealPane: CardTitleBarProps["onRevealPane"];
  modalHeld: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The column badge and the picker it opens: the one part of the title bar
 * that draws the pane's place in its run.
 *
 * Its own component so that it can read that place itself. The count, this
 * pane's band and the picker rows move on EVERY member of a place when one
 * member arrives or leaves, so a bar that took them as props re-rendered on
 * every survivor of a close. Read here, through the deck store ([L02]), a
 * close re-renders this badge on the panes whose place it changed, and
 * nothing else of their bars. A bar with no deck behind it (a spike) passes
 * no `placePaneId` and the badge draws from the props.
 */
const CardPlaceBadge = memo(function CardPlaceBadge({
  placePaneId,
  slotStack: slotStackProp,
  onArrangePlace,
  onRevealPane,
  modalHeld,
  open,
  onOpenChange,
}: CardPlaceBadgeProps) {
  const placeArrangement = useContext(PlaceArrangementContext);
  const deck = useContext(DeckManagerContext);
  const source = useMemo(
    () => (deck === null || placePaneId === undefined ? null : placeSource(deck)),
    [deck, placePaneId],
  );
  const facts = useStoreDerived(source, (snapshot) =>
    snapshot === null || placePaneId === undefined
      ? null
      : placeFactsFor(snapshot, placePaneId),
  );
  const slotStack = facts?.slotStack ?? slotStackProp;
  // Whether the place this badge describes is a divided rail rather than a
  // stack of any kind — the one fact the badge's glyph, its label, and its
  // verbs all read.
  const placeSplit = placeArrangement?.mode === "split";
  const badgeKind = placeSplit ? "split" : "stack";
  const badgeCount =
    facts !== null
      ? Math.max(facts.count, 1)
      : placeArrangement?.count ?? Math.max(slotStack.length, 1);
  const badgeIndex = facts?.index ?? placeArrangement?.index ?? 0;
  // A place one card deep. The badge draws its place all the same — `1` for a
  // stack, `A` for a slot set to split, both true sentences in the vocabulary
  // it already speaks, and inventing a fourth glyph for solitude would say
  // nothing either one does not. What DOES turn is the prose: a place holding
  // one card cannot offer to show you another, so the phrasing below asks a
  // different question of it.
  const placeAlone = badgeCount < 2;
  return (
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
    // chord to go stale. ⌃⌘/ is a TOGGLE, which is why the same chord is
    // named whether the place is stacked or split — it is the way back
    // as much as the way in.
    <TugActionTooltip
      action={TUG_ACTIONS.TOGGLE_COLUMN_SPLIT}
      content={
        onArrangePlace !== undefined && placeArrangement !== undefined
          ? placeSplit
            ? placeAlone
              ? `Band ${columnBadgeCharacter("split", badgeCount, badgeIndex)}, alone in this split ${placeArrangement.kind} — press to re-stack it`
              : `Band ${columnBadgeCharacter("split", badgeCount, badgeIndex)} of ${badgeCount} — press to show a card, or re-stack this ${placeArrangement.kind}`
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
                  ? placeAlone
                    ? `Split place, band ${columnBadgeCharacter("split", badgeCount, badgeIndex)}, alone in it`
                    : `Split of ${badgeCount} cards, band ${columnBadgeCharacter("split", badgeCount, badgeIndex)}`
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
          open={open}
          onOpenChange={onOpenChange}
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
                      : [
                          { id: PLACE_VERB_EQUALIZE, label: "Equalize Heights" },
                        ]),
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
  );
}, (prev, next) => plainEqual(prev, next));

/**
 * The pane's title bar, memoized on its props by value — the same comparator
 * the frame uses ({@link plainEqual}).
 *
 * The frame re-renders on GEOMETRY: its `placement` carries the flow strip's
 * position, so an activation that slides the strip, or a close that shortens
 * it, hands every pane on the deck a new placement. The frame must take that —
 * it writes where it stands. The bar draws nothing from it, and re-rendered
 * whole anyway: every pane's tooltips, popovers and confirm popover, inside
 * the settle window the gesture was animating through ([D204]). The commit
 * census read 1758 performed fibres at +18 ms on a close, nearly all of them
 * in bars that said exactly what they said before.
 *
 * Everything the bar draws that is not a prop it reads through its own
 * subscriptions ([L02]), so a bar whose props are equal has nothing to render.
 *
 * The one prop only the badge draws — `placeArrangement` — does not reach this
 * body at all: {@link CardTitleBar} hands it to the badge through
 * {@link PlaceArrangementContext} and tells the body only whether there is
 * one. A split or a stack changes the arrangement on every member of its
 * place, and as a prop it re-rendered each member's whole bar — its buttons,
 * tooltips and poppers, two dozen per bar — inside the gesture's set-up, to
 * redraw one glyph.
 */
const CardTitleBarBody = memo(React.forwardRef<CardTitleBarHandle, CardTitleBarBodyProps>(
function CardTitleBarBody({
  title,
  icon,
  closable = true,
  widthPreset,
  cardCount = 1,
  cardKind = "Card",
  resolveCloseGuard,
  resolveModalHold,
  confirmClose = false,
  resolveCloseAdvice,
  activeCardId,
  slotStack = EMPTY_SLOT_STACK,
  placePaneId,
  slot,
  spaces: spacesGiven,
  onRevealPane,
  bullseye = false,
  onToggleBullseye,
  hasPlaceArrangement,
  onArrangePlace,
  onSetWidth,
  onMoveToSpace,
  masthead = null,
  sidebar = false,
  folded = false,
  cardFold = false,
  onClose,
  onDragStart,
}: CardTitleBarBodyProps, ref) {
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
  const hasPlace = hasPlaceArrangement || slotStack.length > 1;
  // Generic title-bar contributions: the active card may publish items via
  // `paneTitleBarItemsStore`. The pane renders them without knowing what
  // card published them (the `cardTitleStore` precedent) — no cards-card import.
  // Every item is a standing ghost icon button in the control cluster, and
  // that is the only shape there is. A `⋮` popup of rows was the second one
  // until it was cut: a verb reached by opening a menu that sits inside a row
  // that is itself revealed on hover is two gestures deep before it is a verb
  // at all, and the transcript family it was carrying already has its chords
  // and its native submenu.
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

  const handleTitleBarPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest(".tug-button")) return;
      // A CONTENT card is dragged by its GRAB HANDLE and by nothing else. The
      // handle is the dot field on the chrome — a real element precisely so this
      // test can exist, because a press on a pseudo-element reports the pseudo's
      // originating element as the target and this line could not have told the
      // dots from the bar around them.
      //
      // A RAIL keeps the old behaviour, where the whole bar is the surface: a
      // rail wears no handle (it is not dragged between panes the way a card is),
      // so requiring one would make its bar undraggable rather than restricted.
      // The CSS says the same thing twice — `cursor: grab` sits on a sidebar bar
      // and on a content card's handle, and nowhere else.
      if (!sidebar && target.closest(".tug-pane-grab-handle") === null) return;
      // Only a PRIMARY press moves a pane, and the guard is load-bearing
      // rather than tidy. The drag takes POINTER CAPTURE on the frame at
      // pointer-down; WebKit then retargets every later event of that pointer
      // to the capture element — including the `contextmenu` that a secondary
      // press raises. So a secondary press anywhere in the title bar arrived
      // at `.tug-pane` rather than at the thing under the cursor, no handler
      // inside the bar ever saw it, and the app's own document-level fallback
      // answered every one of them with "No Actions". The masthead's three
      // lines live in that bar, which is how a session row with copies on it
      // came to look like a surface with nothing to offer.
      //
      // The test is `isSecondaryPress`, not `button !== 0`, and the difference
      // is the whole of this bug's second life. A macOS Control-click is
      // button 0: it passed a button-only guard, took the capture, and put the
      // masthead back where it started for every reader who right-clicks that
      // way. One spelling of "secondary" for the app, in the one place that
      // already defines it. The button test stays beside it: a middle press is
      // not a secondary press and still has no business moving a pane.
      if (event.button !== 0 || isSecondaryPress(event.nativeEvent)) return;
      onDragStart?.(event);
    },
    [onDragStart, sidebar],
  );

  // The controls cluster's measured width, published on the bar as
  // `--tugx-pane-controls-width`. The cluster only occupies the first chrome
  // band, and the masthead runs its lower lines under the dead space beneath
  // it to the card's edge — how far is a sibling's width, which CSS cannot
  // read, and which changes as the stack badge comes and goes. A DOM write on
  // resize, never React state ([L06]).
  const barElRef = useRef<HTMLDivElement | null>(null);
  const controlsElRef = useRef<HTMLDivElement | null>(null);

  // The deck, for one purpose only: the reveal a close question owes the card
  // it is about (see `openCloseConfirm`). The bar reads nothing else off it.
  //
  // Read off the context directly rather than through `useDeckManager`, which
  // throws when there is no provider — `spike-card-chrome` mounts real title
  // bars outside any deck, and a bar with no deck behind it simply has no
  // reveal to ask for.
  const deck = useContext(DeckManagerContext);

  // The workspace list, for the move control alone ([L02]). Off the same
  // snapshot the canvas reads, DERIVED to the two facts the control draws:
  // the list's rows, and which one is this bar's own workspace — the one the
  // menu leaves out. With no deck behind the bar there are no workspaces, and
  // no `onMoveToSpace` either, so the control is not drawn.
  //
  // The workspace left out is the one this pane's LAYER renders, not the
  // active one. For a shown pane they are the same; the difference is that
  // the layer's never changes, and the active one changes at every switch —
  // so reading it re-rendered every title bar of both layers inside the swap
  // commit, for a menu no hidden pane can open. A host that renders no
  // layers has no layer to ask, and falls back to the active workspace.
  const ownSpaceId = useSpaceLayerShownSource().spaceId;
  const spacesStore = useMemo(
    () =>
      deck === null
        ? null
        : { subscribe: deck.subscribeSpaces, getSnapshot: deck.getSpacesSnapshot },
    [deck],
  );
  const spacesView = useStoreDerived<SpacesSnapshot, SpacesView>(
    spacesStore,
    (snapshot) =>
      snapshot === null
        ? NO_SPACES_VIEW
        : {
            spaces: snapshot.spaces.map((space) => ({ id: space.id, name: space.name })),
            ownSpaceId: ownSpaceId ?? snapshot.activeSpaceId,
          },
  );
  // Given, where no deck stands behind the bar to read them from.
  const spaces = spacesGiven?.spaces ?? spacesView.spaces;
  const barSpaceId = spacesGiven !== undefined ? spacesGiven.ownSpaceId : spacesView.ownSpaceId;

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
    // The observer is the only reader, and that is deliberate on both sides.
    //
    // No synchronous `offsetWidth` here: a read in a layout effect forces a
    // layout in the middle of React's commit, and on a workspace switch every
    // arriving pane would pay one — the read→write→read chain the motion
    // probe named first. An observer's first delivery lands in the frame's
    // own rendering steps, after the engine's one layout and before its
    // paint, so the bar is never painted without the property and the
    // engine resolves once.
    //
    // And no gate on the workspace being shown. A pane in a hidden workspace
    // is laid out — its layer is `visibility: hidden` over `content-visibility:
    // hidden`, which skips paint and hit-testing and keeps the boxes ([B02]) —
    // but a ResizeObserver is SILENT under one: it delivers nothing for
    // contents the engine is skipping, and catches up in the first frame
    // after the layer is shown, before that frame paints (measured on this
    // engine and pinned by `at0642`). So the controls are read the moment
    // they are on screen and never before, which is exactly what the shown
    // gate used to arrange by hand ([L23]).
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
  // that is no longer painted. The card-width menu inside the row is therefore
  // CONTROLLED, and while it stands the row is held open.
  const [widthMenuOpen, setWidthMenuOpen] = useState(false);
  // Move to Workspace is controlled for the identical reason, stated at the
  // width control below, and feeds the same bit: two menus in the row, either
  // of which standing holds the row open.
  const [moveMenuOpen, setMoveMenuOpen] = useState(false);
  const rollupHeld = widthMenuOpen || moveMenuOpen;

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
  // pane via `onClose`, with multi-tab vs single-tab copy.
  const paneCloseIntent = useCallback(
    (): CloseIntent => ({
      message: isMultiTab ? `Close ${cardCount} Tabs?` : `Close ${cardKind}?`,
      confirmLabel: isMultiTab ? "Close All" : "Close",
      onConfirm: () => onClose?.(),
    }),
    [isMultiTab, cardCount, cardKind, onClose],
  );

  // Deferred open, so the popover is never seeded onto a pane the deck is
  // still carrying. Cleared on unmount — a pane closed by another route
  // during the travel must not raise a question about itself afterwards.
  const openCloseTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (openCloseTimerRef.current !== null)
        window.clearTimeout(openCloseTimerRef.current);
    },
    [],
  );

  // Every close gesture that asks a question funnels through here, and the
  // question is asked ON the card it is about: a pane standing half out of
  // the band is brought whole into view FIRST, and only then does the popover
  // open. Two reasons, and both are about the reader. A "Close Session?" anchored
  // to a title bar that is itself half off the band can be clipped by the
  // band's own edge — the question arrives unreadable, or not at all. And a
  // reader is being asked to discard something: they are owed a look at what
  // it is before they answer.
  //
  // What the wait keys on is the DECK SETTLING rather than on whether the
  // reveal below found anything to move, and the difference is the whole
  // correctness of it. A pointer close is preceded by the gesture
  // interpreter's own reveal — a release that travelled nowhere brings the
  // card it clicked into view — which lands BEFORE this handler and leaves
  // `revealCard` nothing left to commit. Asking "did I travel?" would answer
  // no on exactly the gesture that is travelling. The settle arms
  // synchronously on the store notify, whoever committed it, so the attribute
  // is already standing by the time we look.
  //
  // The reveal is still called: the keyboard routes (⌘W, the close-all
  // command, a remote close box) reach here with no pointer gesture ahead of
  // them, and for those this IS the travel.
  //
  // Nothing is deferred when the deck is at rest, so a close on a card in full
  // view opens the popover in the same frame it always did. Mid-travel the
  // popover waits rather than anchoring in flight: Radix positions its content
  // once at open against the anchor's current rect, and the band's crossing is
  // a CSS transform it does not follow.
  const openCloseConfirm = useCallback(
    (intent: CloseIntent) => {
      // A second gesture while the deck is already travelling toward the
      // question is the same gesture arriving twice. Let the first one finish
      // rather than opening the popover onto a band still in flight.
      if (openCloseTimerRef.current !== null) return;
      setCloseIntent(intent);
      if (deck !== null && activeCardId !== undefined) {
        deck.revealCard(activeCardId);
      }
      // Off this bar's own ancestor rather than a document-wide selector: a
      // title bar standing outside a deck at all — the component gallery, a
      // spike — finds nothing and opens immediately, which is right.
      const canvas =
        barElRef.current?.closest<HTMLElement>(
          "[data-deck-canvas-background]",
        ) ?? null;
      if (canvas === null || !canvas.hasAttribute("data-imposer-settling")) {
        setCloseOpen(true);
        return;
      }
      const settleMs = readSettleMs(canvas) * getTugTiming();
      openCloseTimerRef.current = window.setTimeout(() => {
        openCloseTimerRef.current = null;
        setCloseOpen(true);
      }, settleMs);
    },
    [deck, activeCardId],
  );

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
      // The depth is read at the press, from the deck when the bar has one —
      // the bar does not render from it ([L02]).
      const depth =
        deck !== null && placePaneId !== undefined
          ? placeFactsFor(placeSource(deck).getSnapshot(), placePaneId).slotStack.length
          : slotStack.length;
      if (depth <= 1) return;
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
  }), [confirmsClose, onClose, openCloseConfirm, paneCloseIntent, withCloseDecision, slotStack.length, deck, placePaneId]);

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
      ) : masthead.kind === "commit-masthead" ? (
        // A commit's three lines — the pill, the subject, then author · date ·
        // time. No key, for the document masthead's reason: a card re-seeded
        // with a different sha has nothing to carry across, and reconciling
        // the new record onto the same element is what should happen.
        <CommitMasthead payload={masthead} />
      ) : (
        // Keyed by session, so a payload naming a DIFFERENT session remounts
        // rather than reconciling. A new session is a new entity, which is
        // what [L26]'s test asks: the masthead holds the beat dwell queue's
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

      {/* The chrome's one drag surface on the UTILITY tier. The masthead tiers
          mount their own on the masthead's LEAD LINE, because that is where the
          run between a title and the controls actually is; this bar's run is its
          own, so here the handle is the bar's child. A rail gets none — its whole
          bar is still the surface. Mounted before the controls so its grow is
          what pushes them to the trailing edge, which is why the bar needs no
          `order` the way the rail's stripe band does. */}
      {masthead === null && !sidebar ? (
        <span
          className="tug-pane-grab-handle"
          data-slot="tug-pane-grab-handle"
          data-testid="tug-pane-grab-handle"
          aria-hidden="true"
        >
          <span className="tug-pane-grab-dots" />
        </span>
      ) : null}

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
            of the pointer.

            NOT ON A RAIL, and that is the whole of a sidebar card's controls
            cluster now: a close box, the rail's own place badge, and nothing
            behind a `⋯`. A rail's rollup only ever held two verbs, and a rail
            can do neither. It does not bullseye — it is pinned to an edge and
            holding a place open, and a posture that centres it in the band
            leaves that place behind. It does not move to another workspace —
            it stands on the deck edge rather than in the imposition, and its
            side is arrangement rather than filing. The row was therefore
            empty of anything a rail could act on, and a `⋯` promising an
            empty row is the resting lie this cluster is not allowed to tell. */}
        {!sidebar && (
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
                  summary on a Session card. Those are different glyphs meaning
                  different things, so those are the ones that should move
                  between card kinds.

                  Two mechanisms enforce it, because card verbs arrive by two
                  routes. `SHARED_VERB_RANK` sorts the items a card publishes
                  through the items store; the masthead orders its own portal by
                  hand, with the argument written at the site. */}
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
          {titleBarButtonItems.map((item) => (
            <TitleBarItemButton key={item.commandId} item={item} activeCardId={activeCardId ?? null} />
          ))}
          {/* Move to Workspace. Authored in place in the spine rather than
              published through the items store: the authored end of the row is
              for the PANE's own verbs, and a card of any kind moves — so this is
              the pane's verb rather than any card family's ([B08]).

              It sits before card width in source order, which is further LEFT in
              the right-to-left spine, so bullseye and width keep the two
              positions the eye has already learned.

              Choosing a row files the pane's active card into that workspace and
              leaves the user exactly where they are ([B04]): a drag is a filing
              gesture, not a travel one, and the menu is the same gesture wearing
              a name. Drag remains the fast path; this is the named door. */}
          {/* Fold. The pane's verb, like Move beside it — every content card
              folds ([B05]) — and the open form's door onto the command the
              pinned glyph below presses while folded ([B06]). Open only:
              folded, the glyph outside the rollup is the door, and a second
              copy of it behind a `⋯` would be one verb in two places. */}
          {cardFold && !folded && (
            <TugActionTooltip action={TUG_ACTIONS.TOGGLE_CARD_FOLD} content="Fold">
              <TugButton
                subtype="icon"
                emphasis="ghost"
                role="action"
                size="sm"
                icon={<ChevronsDownUp />}
                aria-label="Fold"
                data-testid="tug-pane-title-bar-fold-button"
                onClick={() => dispatchCommand(TUG_ACTIONS.TOGGLE_CARD_FOLD)}
              />
            </TugActionTooltip>
          )}
          {onMoveToSpace !== undefined && (
            <TugTooltip
              content={
                spaces.length > 1
                  ? "Move this card to another workspace"
                  : "Move this card to another workspace — there is only one"
              }
            >
              {/* The phrase rides the anchoring span rather than the button,
                  because a disabled button takes no pointer events and would
                  never raise the tooltip that explains why it is disabled
                  ([L31]). The composition the width control already uses
                  provides the span, so the one-workspace case needs nothing
                  added. */}
              <span className="tug-pane-title-bar-tooltip-anchor">
                <TugPopupMenu
                  trigger={
                    <TugButton
                      subtype="icon"
                      emphasis="ghost"
                      role="action"
                      size="sm"
                      icon={<Blocks />}
                      aria-label="Move to workspace"
                      disabled={spaces.length <= 1}
                      data-testid="tug-pane-title-bar-move-space-button"
                    />
                  }
                  align="end"
                  // Controlled for the reason written at card width below: the
                  // menu portals its rows outside the card, so the pointer
                  // travelling to a row leaves the title bar and would collapse
                  // the row this trigger stands in.
                  open={moveMenuOpen}
                  onOpenChange={setMoveMenuOpen}
                  items={spaces
                    .filter((space) => space.id !== barSpaceId)
                    .map((space) => ({ id: space.id, label: space.name }))}
                  onSelect={(id) => onMoveToSpace(id)}
                  data-testid="tug-pane-title-bar-move-space-menu"
                />
              </span>
            </TugTooltip>
          )}
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
                <CardWidthMenu
                  widthPreset={widthPreset}
                  onSetWidth={onSetWidth}
                  open={widthMenuOpen}
                  onOpenChange={setWidthMenuOpen}
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

              A rail never reaches this button: the whole rollup is a content
              pane's, for the reason written at the gate above.

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
        )}
        {/* The folded card's door, pinned OUTSIDE the rollup: a folded card's
            body is `inert`, so this is its one live stop, its key view and its
            Return-home ([B06], [B07]). See `card-fold-glyph.tsx`. */}
        {cardFold && folded && activeCardId !== undefined && activeCardId !== null && (
          <CardFoldGlyph cardId={activeCardId} />
        )}
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
        <CardSlotBadge cardId={activeCardId} {...(slot === undefined ? {} : { facts: slot })} />
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
          <CardPlaceBadge
            placePaneId={placePaneId}
            slotStack={slotStack}
            onArrangePlace={onArrangePlace}
            onRevealPane={onRevealPane}
            modalHeld={modalHeld}
            open={stackMenuOpen}
            onOpenChange={setStackMenuOpen}
          />
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
                (isMultiTab ? `Close ${cardCount} Tabs?` : `Close ${cardKind}?`)
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
}), (prev, next) => plainEqual(prev, next));

/**
 * {@link CardTitleBar}'s body: every prop but the arrangement, which only the
 * badge draws, and the Fill Height pair, which only the width menu draws.
 */
type CardTitleBarBodyProps = Omit<
  CardTitleBarProps,
  "placeArrangement" | "onFillHeight" | "fillsHeight"
> & {
  /** Whether the pane stands in a place with an arrangement record. */
  hasPlaceArrangement: boolean;
};

/**
 * The title bar: the arrangement to the badge through
 * {@link PlaceArrangementContext}, every other prop to the memoized body,
 * which a new arrangement does not reach.
 */
export const CardTitleBar = memo(React.forwardRef<CardTitleBarHandle, CardTitleBarProps>(
function CardTitleBar(
  { placeArrangement, onFillHeight, fillsHeight = true, ...rest }: CardTitleBarProps,
  ref,
) {
  const fill = useMemo(
    () => (onFillHeight === undefined ? undefined : { onFillHeight, fillsHeight }),
    [onFillHeight, fillsHeight],
  );
  return (
    <PlaceArrangementContext.Provider value={placeArrangement}>
      <FillHeightContext.Provider value={fill}>
        <CardTitleBarBody
          ref={ref}
          {...rest}
          hasPlaceArrangement={placeArrangement !== undefined}
        />
      </FillHeightContext.Provider>
    </PlaceArrangementContext.Provider>
  );
}), (prev, next) => plainEqual(prev, next));

// ===========================================================================
// The bar's frozen defaults
// ===========================================================================

// One frozen empty array for every pane that holds no slot, so an absent
// `slotStack` prop does not hand the title bar a fresh identity per render.
const EMPTY_SLOT_STACK: readonly SlotStackEntry[] = [];

// What the title bar's move control reads off the workspace list, and the one
// frozen answer for a bar with no deck behind it.
interface SpacesView {
  spaces: readonly { id: string; name: string }[];
  ownSpaceId: string | undefined;
}
const NO_SPACES_VIEW: SpacesView = { spaces: [], ownSpaceId: undefined };

/** The width popup's Fill Height row — an id no width preset can take. */
const FILL_HEIGHT_ITEM = "fill-height";
