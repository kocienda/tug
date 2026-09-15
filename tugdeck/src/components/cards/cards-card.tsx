/**
 * cards-card.tsx — the **Workspaces** card: a pane-first mirror of the deck
 * canvas, one level per workspace. Every card on every workspace's deck has a
 * row here, grouped by kind (Sessions / Files / Tools) under the workspace
 * that holds it.
 *
 * The list is three-level, and the outermost level is the workspace ([P09]).
 * The active workspace is expanded and wears the mark; each other one is one
 * row that says what it holds, opening to a READ-ONLY view of its rows — a
 * glance across the wall before deciding to go. The card's name is the noun
 * the whole suite uses; its component id, its class names and its ⌃⌘W are
 * unchanged ([P13]).
 *
 * The two inner levels are facts of the deck's data model rather than folders
 * the user opens:
 *
 *  - A **single-card pane** renders exactly the row its card has always had —
 *    the session monitor, the file row, a generic tool row. No chevron, no
 *    indent, nothing to expand. This is the invariant the section exists to
 *    honor: the overwhelmingly common case pays nothing for the rare one.
 *  - A **multi-card pane** renders one pane row with all of its cards as
 *    indented subrows beneath it, always visible. There is no per-pane fold
 *    state and there is not going to be one; a heavy stack is handled by
 *    collapsing its *group*.
 *
 * Workspace and group headers alike are cursorable rows, not `TugListView`'s
 * inert `"header"`
 * role: the arrow walk reaches them and Enter/Space toggles that group's
 * collapse. That choice is what makes the cursor-seed rule below necessary. To
 * the mouse the header is the group's drag handle and the chevron is the only
 * thing that folds — travel tells the two apart, so a press that goes nowhere
 * does nothing.
 *
 * The list is one Tab stop; arrows rove the movement cursor, and
 * the three commit keys mean three different things: Enter and a click front
 * the row's card (`focus-session-card`), while SPACE only toggles it in the
 * layout selection — the set the deck's slot and width verbs act on. ⇧+arrow
 * extends that selection and ⌘+arrow walks past rows without disturbing it,
 * both seeding the row they start from. Three things carry,
 * all on the shared `useBlockReorder` FLIP: a pane row within its own group
 * (committing `cardsRowOrder`), a whole GROUP by its header — the header
 * and every row under it move as one block (committing `cardsGroupOrder`) —
 * and a whole WORKSPACE the same way one level out (committing the space
 * order). A pane row has one destination that is not a reorder at all:
 * dropped on another workspace's header it MOVES the card into that
 * workspace, its id and its session binding intact ([P10], [B07]).
 *
 * Laws: [L02] the deck, the open registries, the bindings, and the persisted
 * arrangement all enter React through `useSyncExternalStore`; [L06] cursor,
 * selection, and the header's collapsed look are CSS on DOM attributes, never
 * React state; [L19]/[L20] every row composes a real Tug primitive; [L22] the
 * FocusManager owns the cursor; [L24] selection is the list's.
 *
 * @module components/cards/cards-card
 */

import "./cards-card.css";

import React, {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  File,
  FileText,
  Image as ImageIcon,
  GitBranch,
  LayoutGrid,
  MessageSquareText,
  Wrench,
  X,
} from "lucide-react";

import { dispatchCommand } from "@/command-dispatch";
import { BlockDropCaret } from "@/components/tugways/block-drop-caret";
import { BlockFoldCue } from "@/components/tugways/body-kinds/affordances/block-fold-cue";
import { useBlockReorder } from "@/components/tugways/block-reorder";
import { RAIL_LIST_PRESENTATION } from "@/components/tugways/rail-list-presentation";
import {
  cardsSelectionStore,
  setLayoutCursorCard,
} from "./cards-selection-store";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { SlotPicker } from "./slot-picker";
import { CardsColumnBadge } from "./cards-column-badge";
import { TugFilterField } from "@/components/tugways/tug-filter-field";
import { useAttachedFilter } from "@/components/tugways/attached-filter";
import { setCardsFilterBinding, shrinkCardsState } from "./cards-escape";
import { useResponder } from "@/components/tugways/use-responder";
import { useAnnotationClicks } from "@/components/tugways/use-annotation-clicks";
import { renderFilterHighlight } from "@/components/tugways/filter-highlight";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";
import type { ActionEvent } from "@/components/tugways/responder-chain";
import { TugConfirmPopover } from "@/components/tugways/tug-confirm-popover";
import { TugIconButton } from "@/components/tugways/tug-icon-button";
import { fileTip } from "@/components/tugways/entity-tips";
import { TugTooltip } from "@/components/tugways/tug-tooltip";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugListRow } from "@/components/tugways/tug-list-row";
import { TugListView } from "@/components/tugways/tug-list-view";
import type {
  TugListViewCellProps,
  TugListViewCellRenderer,
  TugListViewDelegate,
  TugListViewHandle,
} from "@/components/tugways/tug-list-view";
import {
  useFocusManager,
  useSeedKeyView,
} from "@/components/tugways/use-focusable";
import { renderIcon } from "@/components/tugways/tug-tab-bar";
import { getCardCloseGuard } from "@/lib/card-close-guard";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import { useChangesetAll } from "@/lib/changeset-all-store";
import { getDeckStore } from "@/lib/deck-store-registry";
import { classifyFileKind } from "@/lib/file-kinds";
import { cardsStore } from "@/components/cards/cards-store/cards-store";
import { sessionNameStore } from "@/lib/session-name-store";
import { sessionTagStore } from "@/lib/session-tag-store";

import {
  displayPath,
  idOfRow,
  useCardsDataSource,
  type CardIdentity,
  type CardsRow,
  type CardsDataSource,
} from "./cards-data-source";
import { expandedSpacesStore } from "./cards-space-expansion";
import {
  GROUP_TITLES,
  groupOfRunKey,
  groupRunKey,
  type CardsGroup,
} from "./cards-groups";
import { CardsSessionRow } from "./cards-session-cell";
import {
  CardsCellContext,
  CARDS_RENAME_FOCUS_ORDER,
  useCellContext,
  type CardsCellContextValue,
} from "./cards-cell-context";
import { SpaceHeaderCell } from "./cards-space-header";

/** The card's focus group — its chrome and its rows both live here, so the Tab
 *  walk runs the filter field and then the list. */
export const CARDS_FOCUS_GROUP = "cards-card";

/** Chrome stands ahead of the list, which registers at 0. */
const CARDS_FILTER_FOCUS_ORDER = -1;

// Pane rows are matched for reorder by their uniform order key. Deliberately
// NOT `data-card-id`: that attribute is the card HOST's, and a row carrying it
// would make `[data-card-id="…"]` resolve to a Cards card row instead of the card's
// own pane.
const ROW_SELECTOR = ".cards-row[data-cards-row-id]";
const ROW_KIND_ATTR = "data-cards-row-id";

// A group's run for the GROUP reorder: its header plus every row filed under
// it, all carrying the same `<spaceId>:<group>` key. `useBlockReorder` treats
// elements sharing a key as one block, so matching the run here is the whole
// of what makes a group carry its rows with it — and the key is scoped to the
// workspace because two expanded workspaces each render a Sessions run, and an
// unscoped key would splice them into one block ([P09], [P10]).
const GROUP_RUN_SELECTOR = "[data-cards-group-run]";
const GROUP_RUN_ATTR = "data-cards-group-run";

// A WORKSPACE's run for the workspace reorder: its header plus every row under
// it, all wearing the same workspace id. Same machinery one level out — a
// workspace travels with everything it holds, collapsed or open ([P10]).
const SPACE_RUN_SELECTOR = "[data-cards-space-run]";
const SPACE_RUN_ATTR = "data-cards-space-run";

// A workspace HEADER as a drop target for a pane row: dragging a card's row
// onto one moves the card into that workspace ([P10], [B07]). The header is
// the one target that is unambiguous, works for a collapsed workspace, and
// never interferes with the in-group FLIP.
const SPACE_HEADER_SELECTOR = ".cards-space-header";
const SPACE_HEADER_ATTR = "data-cards-space-id";

/** Focus group for a row's close box. The rows render inside `TugListView`'s
 *  per-row `FocusModeContext`, so the button registers into its own row's
 *  descend scope — the mode scopes the walk, this constant is only the
 *  within-row ordering. ArrowRight on the cursor row descends onto it, ahead of
 *  the slot picker. */
const ROW_ACTION_FOCUS_GROUP = "cards-row-actions";

/**
 * The two attributes every row under a workspace wears.
 *
 * `data-cards-space-run` is the workspace reorder's block key — the header and
 * every row beneath it share it, so a workspace carries its contents ([P10]).
 * `data-cards-space-inactive` is the read-only mark: the rows of a workspace
 * that is not on screen name cards the rendered deck does not hold, so they
 * are shown but never picked, dragged or selected ([P09]). Appearance follows
 * from the attribute in CSS, never from React state ([L06]).
 */
function spaceRowAttrs(
  spaceId: string,
  active: boolean,
): Record<string, string> {
  return {
    "data-cards-space-run": spaceId,
    ...(active ? {} : { "data-cards-space-inactive": "true" }),
  };
}

// The section's remembered selection — the last-touched row id, mapped to a
// cursor seed on the next Cmd-L / Tab. Module-level so it outlives a collapse
// toggle; valid while the Cards card is a singleton card.
let lastSelectedRowId: string | null = null;

/**
 * Whether closing this card will stop and ask rather than just close — the
 * card's own close guard has unsaved work to raise a Save / Don't Save sheet
 * over. It is asked BEFORE the close is sent, because the answer decides
 * whether the Cards card fronts the card first: only a close that puts a question on
 * screen needs the user looking at the card it appears on.
 *
 * The pane's `close-tab` handler consults exactly this guard and nothing else,
 * so the reading here and the behaviour there cannot disagree.
 */
function askedBeforeClosing(cardId: string): boolean {
  return getCardCloseGuard(cardId)?.needsDecision() === true;
}

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

/** A file row's kind glyph: a text card wears the document mark, a viewer
 *  wears the one for what it is showing. The path decides, so a viewer row's
 *  glyph tracks the file it is bound to rather than the card family. */
function fileGlyph(identity: CardIdentity): React.ReactElement {
  if (identity.componentId === "text" || identity.path === null) {
    return <FileText size={12} />;
  }
  return classifyFileKind(identity.path) === "image" ? (
    <ImageIcon size={12} />
  ) : (
    <File size={12} />
  );
}

/** A group's glyph — what the cards filed under it ARE, so the header names its
 *  kind twice over: Sessions wears the session card's own mark, Files the
 *  document mark its rows wear, Tools the one for everything else. It stands
 *  where the rows' glyphs stand, which is what keeps the group's rows reading as
 *  indented under it now that nothing else occupies that column. */
const GROUP_GLYPHS: Readonly<Record<CardsGroup, React.ReactElement>> = {
  sessions: <MessageSquareText size={12} />,
  files: <FileText size={12} />,
  tools: <Wrench size={12} />,
};

/** Any other card's glyph: its registration's icon, through the same resolver
 *  the tab bar uses, so a card looks the same in the Cards card as on its tab. */
function registrationGlyph(identity: CardIdentity): React.ReactNode {
  return renderIcon(identity.icon ?? undefined);
}

// ---------------------------------------------------------------------------
// The one-line row body — shared by the file, tool, and subcard cells
// ---------------------------------------------------------------------------

/** A one-line row on the shared `TugListRow` chrome: a kind glyph, the name, an
 *  optional muted disambiguating suffix, the slot picker, and a leading close
 *  box. The directory is not ink — it reaches the user as the row's hover
 *  title, which carries the whole abbreviated path.
 *
 *  When two open files share a filename, the shortest trailing directory run
 *  that tells them apart rides beside the name, muted (`roadmap`, `Desktop`),
 *  so the list never shows two rows the user cannot choose between. The name
 *  alone paints filter matches — the suffix is disambiguation, not the row's
 *  voice.
 *
 *  The content column is authored by hand because it carries the slot picker on
 *  the name line, which is what lines the pickers up down the Cards card.
 *
 *  A card with unsaved changes carries the same `•` after its name that the
 *  card's own header wears (`text-card.tsx` sets it on `cardTitleStore`), so
 *  the dirty bit reads identically wherever the file appears. */
/**
 * The row's content column, hovered when the card it stands for has a path.
 *
 * A pathless card (a Session, the Overview) has nothing the hover would add,
 * so it renders the bare headline rather than an empty bubble.
 */
function RowHeadlineHover({
  path,
  children,
}: {
  path: string;
  children: React.ReactNode;
}): React.ReactElement {
  const headline = <span className="cards-row-headline">{children}</span>;
  if (path.length === 0) return headline;
  return (
    <TugTooltip variant="entity" align="start" content={fileTip({ path })}>
      {headline}
    </TugTooltip>
  );
}

function OneLineRow({
  identity,
  glyph,
  disambiguator,
  rowId,
  group,
  subrow,
  showSlots,
  showClose,
  closesPane,
  trailing,
  selected,
  spaceId,
  spaceActive,
}: {
  identity: CardIdentity;
  glyph: React.ReactNode;
  disambiguator: string | null;
  /** The reorder key, on a pane row; absent on a subrow (subrows do not drag). */
  rowId: string | null;
  /** The group this row sits in — names the run a pane row belongs to. */
  group: CardsGroup;
  subrow: boolean;
  showSlots: boolean;
  showClose: boolean;
  /**
   * The close box closes this whole PANE rather than the row's own card. Only
   * a multi-card pane row passes it — that row stands for the pane, not for
   * any one of the cards in it, so its × has to mean the pane.
   */
  closesPane?: { paneId: string; cardCount: number };
  trailing?: React.ReactNode;
  /** This row's card is in the layout selection — the list computed it and the
   *  row paints it with `TugListRow`'s own selection fill. */
  selected: boolean;
  /** The workspace holding this row, and whether it is the one on screen. */
  spaceId: string;
  spaceActive: boolean;
}): React.ReactElement {
  const ctx = useCellContext();
  const hoverPath = identity.path !== null ? displayPath(identity.path) : "";
  const closeLabel =
    closesPane !== undefined
      ? `Close all ${closesPane.cardCount} tabs`
      : `Close ${identity.title}`;
  return (
    <TugListRow
      selected={selected}
      className={
        subrow
          ? "cards-oneline cards-subrow"
          : "cards-oneline cards-row"
      }
      data-cards-group-run={groupRunKey(spaceId, group)}
      {...spaceRowAttrs(spaceId, spaceActive)}
      {...(rowId !== null
        ? { "data-cards-row-id": rowId, "data-cards-row-group": group }
        : {})}
      {...(subrow ? { "data-cards-subrow-card-id": identity.cardId } : {})}
      leading={
        showClose ? (
          <TugIconButton
            className="cards-row-close"
            icon={<X size={12} />}
            size="xs"
            aria-label={closeLabel}
            title={closeLabel}
            focusGroup={ROW_ACTION_FOCUS_GROUP}
            focusOrder={0}
            onClick={(e) => {
              // Closing is not a row activation — stop it reaching the cell.
              e?.stopPropagation();
              if (closesPane !== undefined) {
                ctx.onClosePane(closesPane.paneId, identity.cardId);
              } else {
                ctx.onClose(identity.cardId);
              }
            }}
          />
        ) : undefined
      }
      // A pane row is its own reorder handle — a vertical drag from anywhere on
      // it that is not the close box or the slot picker carries it. A subrow
      // has no handle: reordering tabs from the Cards card is not this section's job.
      onPointerDown={
        rowId !== null && spaceActive
          ? (e) => ctx.onRowPointerDown(rowId, e)
          : undefined
      }
    >
      {/* The path is the row's hover, in the house file tip — a row shows a
          card's title, and its path is the fact that title cannot carry.
          `TugListRow` owns the `title` prop as row text, so the hover rides
          the content column instead. */}
      <RowHeadlineHover path={hoverPath}>
        <span className="cards-row-glyph" aria-hidden="true">
          {glyph}
        </span>
        <TugLabel className="tug-list-row-title" size="sm" maxLines={1}>
          {renderFilterHighlight(identity.title, ctx.filterQuery)}
          {identity.unsaved ? (
            <span
              className="cards-row-unsaved"
              data-testid="cards-card-unsaved"
              title="Unsaved changes"
              aria-label="Unsaved changes"
            >
              •
            </span>
          ) : null}
        </TugLabel>
        {disambiguator !== null ? (
          <span className="cards-row-where" data-testid="cards-card-where">
            {disambiguator}
          </span>
        ) : null}
        {trailing}
        {/* The slot the card holds, then where it stands inside it — the same
            outward-in coordinate a Session row and the card's own masthead
            read. Both halves resolve their own facts from the deck store, so
            the row keeps taking everything else as props. */}
        {showSlots ? (
          <span className="cards-row-slots">
            <SlotPicker cardId={identity.cardId} />
            <CardsColumnBadge cardId={identity.cardId} />
          </span>
        ) : null}
      </RowHeadlineHover>
    </TugListRow>
  );
}

// ---------------------------------------------------------------------------
// Cell renderers
// ---------------------------------------------------------------------------

/** The group header: a cursorable row whose Space toggles the group's collapse.
 *  It composes `TugListRow` like every other row, and its fold wears the SAME
 *  affordance the rail cards' bands wear, at the same edge — a `BlockFoldCue`
 *  in the trailing slot, one size down. A rail whose two levels of fold looked
 *  and sat differently made the reader learn each one; one cue, always at the
 *  right, means learning it once. The leading column is the group's kind glyph
 *  instead, which is what the header had to say that a chevron never did.
 *
 *  To the MOUSE the header body is the group's drag handle, and the cue is the
 *  only thing that folds. Travel is what tells them apart, so a press that goes
 *  nowhere does nothing at all — no part of a label the user is reading past can
 *  fold a group out from under them, and the row swallows the trailing click so
 *  the cell never reads it as a pick. Keyboard reach is unaffected: the row
 *  stays cursorable and its Space reaches the delegate, and the cue is a stop of
 *  its own inside the row's descend scope (ArrowRight lands on it). */
const GroupHeaderCell: TugListViewCellRenderer<CardsDataSource> = ({
  index,
  dataSource,
}: TugListViewCellProps<CardsDataSource>) => {
  const row = dataSource.rowAt(index);
  const ctx = useCellContext();
  if (row.type !== "group-header") return null;
  const title = GROUP_TITLES[row.group];
  return (
    <TugListRow
      className="cards-header"
      data-cards-group={row.group}
      data-cards-group-run={groupRunKey(row.spaceId, row.group)}
      data-group-collapsed={row.collapsed ? "true" : "false"}
      data-testid="cards-header"
      {...spaceRowAttrs(row.spaceId, row.spaceId === dataSource.activeSpaceId())}
      // The header IS the group's drag handle: a press arms the carry of the
      // whole run, and travel past the threshold engages it.
      onPointerDown={(e) => ctx.onGroupPointerDown(row.spaceId, row.group, e)}
      // Below the threshold the press is still a click, and on a header a
      // click is nothing — the fold cue is the only thing that folds. Swallowed
      // so the cell wrapper never reads it as a pick.
      onClick={(e) => e.stopPropagation()}
      trailing={
        <BlockFoldCue
          className="cards-header-fold"
          collapsed={row.collapsed}
          onToggle={() => ctx.onToggleGroup(row.group)}
          collapsedLabel="Expand"
          expandedLabel="Collapse"
          ariaLabelExpand={`Expand ${title}`}
          ariaLabelCollapse={`Collapse ${title}`}
          size="2xs"
          subtype="icon"
          focusGroup={ROW_ACTION_FOCUS_GROUP}
          focusOrder={0}
        />
      }
    >
      <span className="cards-header-line">
        <span className="cards-header-glyph" aria-hidden="true">
          {GROUP_GLYPHS[row.group]}
        </span>
        {/* The summary is INSIDE the label, not a column beside it: it is part
            of what the folded group is called, so it takes the label's size,
            weight, case and tracking by inheritance rather than by a second
            set of rules that could drift from them. The colon hugs the title
            for the same reason — it is a separator within one phrase. Rendered
            always and hidden by CSS while the group is open ([L06]). */}
        <TugLabel className="tug-list-row-title" size="sm" maxLines={1}>
          {title}
          <span
            className="cards-header-count"
            data-testid="cards-header-count"
          >
            {`: ${row.summary}`}
          </span>
        </TugLabel>
      </span>
    </TugListRow>
  );
};

/** A single-card session pane — the monitor row, unchanged from the section it
 *  came from. An unbound session card has no monitor to draw, so it falls
 *  through to the generic row. */
const SessionPaneCell: TugListViewCellRenderer<CardsDataSource> = ({
  index,
  dataSource,
  selected,
}: TugListViewCellProps<CardsDataSource>) => {
  const row = dataSource.rowAt(index);
  const ctx = useCellContext();
  if (row.type !== "pane") return null;
  const { identity } = row;
  if (identity.tugSessionId === null || identity.projectDir === null) {
    return (
      <OneLineRow
        selected={selected}
        identity={identity}
        glyph={registrationGlyph(identity)}
        disambiguator={null}
        rowId={row.orderKey}
        group={row.group}
        spaceId={row.spaceId}
        spaceActive={row.spaceId === dataSource.activeSpaceId()}
        subrow={false}
        showSlots
        showClose={identity.closable}
      />
    );
  }
  return (
    <CardsSessionRow
      selected={selected}
      cardId={identity.cardId}
      tugSessionId={identity.tugSessionId}
      projectDir={identity.projectDir}
      orderKey={row.orderKey}
      filterQuery={ctx.filterQuery}
      onRowPointerDown={ctx.onRowPointerDown}
      spaceId={row.spaceId}
      spaceActive={row.spaceId === dataSource.activeSpaceId()}
    />
  );
};

/** A single-card file pane — the file row, unchanged from the section it came
 *  from. */
const FilePaneCell: TugListViewCellRenderer<CardsDataSource> = ({
  index,
  dataSource,
  selected,
}: TugListViewCellProps<CardsDataSource>) => {
  const row = dataSource.rowAt(index);
  if (row.type !== "pane") return null;
  return (
    <OneLineRow
      selected={selected}
      identity={row.identity}
      glyph={fileGlyph(row.identity)}
      disambiguator={row.disambiguator}
      rowId={row.orderKey}
      group={row.group}
      spaceId={row.spaceId}
      spaceActive={row.spaceId === dataSource.activeSpaceId()}
      subrow={false}
      showSlots
      showClose={row.identity.closable}
    />
  );
};

/** Any other single-card pane — a Settings card, the About box, a gallery
 *  demo. Its registration's icon and title, the slot picker, and a close box
 *  when the card is closable. */
const ToolPaneCell: TugListViewCellRenderer<CardsDataSource> = ({
  index,
  dataSource,
  selected,
}: TugListViewCellProps<CardsDataSource>) => {
  const row = dataSource.rowAt(index);
  if (row.type !== "pane") return null;
  return (
    <OneLineRow
      selected={selected}
      identity={row.identity}
      glyph={registrationGlyph(row.identity)}
      disambiguator={null}
      rowId={row.orderKey}
      group={row.group}
      spaceId={row.spaceId}
      spaceActive={row.spaceId === dataSource.activeSpaceId()}
      subrow={false}
      showSlots
      showClose={row.identity.closable}
    />
  );
};

/** A multi-card pane. It shows the active card's glyph and title, a muted tab
 *  count, and the slot picker — placement is pane geometry, so the picker
 *  belongs to the pane row.
 *
 *  Its close box closes the whole pane, because the row IS the pane: the
 *  subrows below it are how you reach any one card, so a × here that killed
 *  only the front tab would be the one gesture in the section that doesn't do
 *  what its row says. The weight is carried by the pane's own policy rather
 *  than by withholding the affordance — `close-pane` runs the X's flow, and a
 *  multi-tab pane always asks "Close N Tabs?" first. */
const StackPaneCell: TugListViewCellRenderer<CardsDataSource> = ({
  index,
  dataSource,
  selected,
}: TugListViewCellProps<CardsDataSource>) => {
  const row = dataSource.rowAt(index);
  if (row.type !== "pane") return null;
  return (
    <OneLineRow
      selected={selected}
      identity={row.identity}
      glyph={registrationGlyph(row.identity)}
      disambiguator={null}
      rowId={row.orderKey}
      group={row.group}
      spaceId={row.spaceId}
      spaceActive={row.spaceId === dataSource.activeSpaceId()}
      subrow={false}
      showSlots
      showClose={row.closable}
      closesPane={{ paneId: row.paneId, cardCount: row.cardCount }}
      trailing={
        <span className="cards-row-tabs" data-testid="cards-tab-count">
          {`${row.cardCount} tabs`}
        </span>
      }
    />
  );
};

/** One card inside a multi-card pane. Generic regardless of kind: a session
 *  card inside a stack rendered as a full three-line monitor would make the
 *  outline heavy, and stacked sessions are rare. Activating it fronts that tab
 *  within its pane. */
const SubcardCell: TugListViewCellRenderer<CardsDataSource> = ({
  index,
  dataSource,
  selected,
}: TugListViewCellProps<CardsDataSource>) => {
  const row = dataSource.rowAt(index);
  if (row.type !== "card") return null;
  const glyph =
    row.group === "files"
      ? fileGlyph(row.identity)
      : registrationGlyph(row.identity);
  return (
    <OneLineRow
      selected={selected}
      identity={row.identity}
      glyph={glyph}
      disambiguator={null}
      rowId={null}
      group={row.group}
      spaceId={row.spaceId}
      spaceActive={row.spaceId === dataSource.activeSpaceId()}
      subrow
      showSlots={false}
      showClose={row.identity.closable}
    />
  );
};

const CARDS_CELL_RENDERERS: Record<
  string,
  TugListViewCellRenderer<CardsDataSource>
> = {
  "space-header": SpaceHeaderCell,
  "group-header": GroupHeaderCell,
  "session-pane": SessionPaneCell,
  "file-pane": FilePaneCell,
  "tool-pane": ToolPaneCell,
  "stack-pane": StackPaneCell,
  subcard: SubcardCell,
};

// ---------------------------------------------------------------------------
// The band
// ---------------------------------------------------------------------------

/** The open cards' bindings, read straight from the store ([L02]). */
function useOpenBindings(): ReturnType<
  typeof cardSessionBindingStore.getSnapshot
> {
  return useSyncExternalStore(
    cardSessionBindingStore.subscribe,
    cardSessionBindingStore.getSnapshot,
  );
}

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

/** Feed the data source from every store the projection reads. */
function useCardsInputs(filterQuery: string): CardsDataSource {
  const bindings = useOpenBindings();
  const cardsRowOrder = useSyncExternalStore(
    cardsStore.subscribe,
    useCallback(() => cardsStore.getSnapshot().cardsRowOrder, []),
  );
  const groupOrder = useSyncExternalStore(
    cardsStore.subscribe,
    useCallback(() => cardsStore.getSnapshot().cardsGroupOrder, []),
  );
  const collapsedGroups = useSyncExternalStore(
    cardsStore.subscribe,
    useCallback(() => cardsStore.getSnapshot().collapsedCardGroups, []),
  );
  // A session label is `<project>/<callsign>`, built at recompute time, so the
  // tag store's version is an input: a callsign arriving late — or the ledger
  // rerolling the optimistic one — must re-run the projection.
  const tagVersion = useSyncExternalStore(
    sessionTagStore.subscribe,
    sessionTagStore.getVersion,
  );
  // The user's name is not in the label, but it is on the row and the filter
  // matches it — so a `/rename` must re-run the projection too.
  const nameVersion = useSyncExternalStore(
    sessionNameStore.subscribe,
    sessionNameStore.getVersion,
  );
  // The account-global aggregate, for the arc sub-rows. A whole snapshot
  // rather than a version token: the projection needs the arc's facts, and the
  // index it builds from them is memoized on this snapshot's identity.
  const changesets = useChangesetAll();
  const dataSource = useCardsDataSource({
    cardsRowOrder,
    groupOrder,
    collapsedGroups,
    filterQuery,
    bindings,
    tagVersion,
    nameVersion,
    changesets,
  });
  return dataSource;
}

export interface CardsContentProps {
  /** The Cards card's id. */
  cardId: string;
}

export function CardsContent({ cardId }: CardsContentProps): React.ReactElement {
  // The query is card-local: the field and the list are siblings under this
  // one component, so nothing has to cross a module store to pair them — which
  // is what the section's filter store existed to do.
  const [filterQuery, setFilterQuery] = useState("");
  const dataSource = useCardsInputs(filterQuery);
  const focusManager = useFocusManager();
  const count = dataSource.numberOfItems();
  const filtering = dataSource.isFiltering();

  // Rows below the workspace level, not every row: a workspace header stands
  // whether or not anything under it survived the filter, so `count` alone can
  // never read zero once there is a workspace ([P09]). Group headers still
  // count — a fully collapsed list is showing its headers and is not empty.
  const hasContent = dataSource.innerRowCount() > 0;
  const hasItems = dataSource.unfilteredCount() > 0;
  // Every workspace emits a header whatever the filter does, so the rendered
  // header count IS the workspace count — what disables Delete on the last one.
  const spaceCount = dataSource.visibleSpaceOrder().length;

  // The opening key view lands on a real row rather than on the chrome; an
  // empty list is not a focus stop, and `useSeedKeyView` re-arms while the key
  // is null ([P02]).
  useSeedKeyView(hasContent ? `${CARDS_FOCUS_GROUP}:0` : null);

  // The cursor seeds onto the remembered row, else onto the first PANE row —
  // never left undefined. `TugListView` seeds an unset cursor to its first
  // cursorable row, and because group headers are cursorable that would be a
  // collapse toggle: every fresh open of this card would land on a header
  // instead of on a card. Index 0 is the fallback only when the projection
  // holds no pane row at all (every group collapsed), where the header is the
  // only thing there to land on.
  const initialSelectedIndex = useMemo(() => {
    if (lastSelectedRowId !== null) {
      const i = dataSource.indexForId(lastSelectedRowId);
      if (i >= 0) return i;
    }
    const first = dataSource.firstPaneRowIndex();
    return first >= 0 ? first : 0;
    // Recompute when membership changes (the data source version bumps `count`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSource, count]);

  // Reorder by carrying the row: commit on drop. Pane rows match by their
  // uniform `data-cards-row-id`; the FLIP animates the row, the store commit
  // persists the new user order.
  //
  // The drag is CLAMPED to the dragged row's own group by handing
  // `getVisibleOrder` only that group's keys. `beginDrag` ignores matched
  // elements absent from the order it is given, so the whole gesture — target
  // computation, the sibling shift, the committed order — stays inside one
  // group without the shared hook needing to know groups exist. Unclamped, a
  // drag across a boundary would slide rows past a header that stays nailed in
  // place, since `applyShift` only translates matched elements.
  const listWrapRef = useRef<HTMLDivElement | null>(null);
  // The card's delegated annotation layer ([B05]). A session cell's
  // description is annotated prose now, and a stamped run needs someone to
  // service its click — the masthead has had this listener for its beat line
  // all along, and the Cards card had none.
  //
  // On the CONTENT element rather than the list wrap: the wrap is absent from
  // the empty-state branch, and this effect reads its root once at mount, so a
  // card that opens with no sessions would never attach a listener for the
  // sessions that arrive after. The content element always renders and
  // encloses every cell.
  //
  // The card's own file rows are untouched by this: they hold a path as a fact
  // and hand it to `fileTip` directly, which is the known-path form and not an
  // annotation ([B06]).
  const annotationRootRef = useRef<HTMLDivElement | null>(null);
  useAnnotationClicks(annotationRootRef, {});
  const caretRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<TugListViewHandle>(null);

  // The field and the list are paired here ([P08]) — ↑/↓ in the field drive the
  // list's cursor while the caret stays put, and a character typed at the list
  // lands in the field.
  const filter = useAttachedFilter(() => listRef.current);
  // Publish the binding for the two chain backstops ([P08]): the card's own
  // responder below, and the deck root's conditional clear, which answers when
  // a slot chord has already taken the keyboard out of this card.
  useLayoutEffect(() => {
    setCardsFilterBinding(filter);
    return () => setCardsFilterBinding(null);
  }, [filter]);
  const dragGroupRef = useRef<{ group: CardsGroup; spaceId: string } | null>(
    null,
  );
  /** The workspace whose group run a drag is carrying. */
  const dragSpaceRef = useRef<string | null>(null);

  // Hand the keyboard back to the row (or group) that was just set down. The
  // press that started the carry would otherwise have placed it here itself —
  // the arm cancels that pointerdown and the drop swallows the trailing click,
  // so without this a carry is the one gesture in the list that leaves the
  // keyboard nowhere. Two halves, because a list's key view and its movement
  // cursor are two different registers: the list takes the key view ([L22],
  // through `place()` — never a raw focus write), and the cursor parks on the
  // block. `moveCursorTo` is a no-op for a row that is gone, so a drop whose
  // commit removed its own row simply leaves the cursor alone.
  const landCursorOn = useCallback(
    (index: number): void => {
      if (index < 0) return;
      lastSelectedRowId = dataSource.idForIndex(index);
      focusManager?.place(
        cardId,
        { kind: "focus-key", focusKey: `${CARDS_FOCUS_GROUP}:0` },
        { modality: "keyboard" },
      );
      listRef.current?.moveCursorTo(index);
    },
    [dataSource, focusManager, cardId, CARDS_FOCUS_GROUP],
  );
  const { onRowPointerDown: beginRowReorder } = useBlockReorder({
    containerRef: listWrapRef,
    caretRef,
    getVisibleOrder: () => {
      const from = dragGroupRef.current;
      if (from === null) return [];
      const groups = dataSource.groupByOrderKey();
      // Scoped to the group AND the workspace the drag started in: the
      // persisted arrangement is per group with no space scoping ([B09]), so a
      // visible order spanning two workspaces would commit one workspace's
      // keys over the other's.
      return dataSource.visibleOrder().filter((key) => {
        const at = groups.get(key);
        return at !== undefined && at.group === from.group && at.spaceId === from.spaceId;
      });
    },
    commit: (order) => {
      const from = dragGroupRef.current;
      if (from === null) return;
      cardsStore.setCardsRowOrder(from.group, [...order]);
    },
    selector: ROW_SELECTOR,
    kindAttr: ROW_KIND_ATTR,
    // Dropping the row on another workspace's header moves the card there
    // ([P10]). The row's own workspace is a no-op rather than an unavailable
    // target: a header that lights up and then declines to move a card that is
    // already where it was dropped reads as nothing happening, which is what
    // happened.
    dropTargets: {
      selector: SPACE_HEADER_SELECTOR,
      attr: SPACE_HEADER_ATTR,
      onDrop: (orderKey, spaceId) => {
        const from = dataSource.groupByOrderKey().get(orderKey);
        if (from === undefined || from.spaceId === spaceId) return;
        const cardId = dataSource.cardIdForOrderKey(orderKey);
        if (cardId === null) return;
        getDeckStore()?.moveCardToSpace(cardId, spaceId);
      },
    },
    landKeyboard: (orderKey) =>
      landCursorOn(dataSource.indexForOrderKey(orderKey)),
  });
  // Reorder is unavailable while a filter is active: the drop order describes
  // only the VISIBLE rows and the commit persists the whole group's
  // arrangement, so committing a partial order would scramble the hidden rows.
  // The gesture is simply never armed.
  const onRowPointerDown = useCallback(
    (orderKey: string, event: React.PointerEvent): void => {
      if (filtering) return;
      const at = dataSource.groupByOrderKey().get(orderKey) ?? null;
      // A parked workspace's rows are a read-only view ([P09]).
      if (at === null || at.spaceId !== dataSource.activeSpaceId()) return;
      dragGroupRef.current = at;
      beginRowReorder(orderKey, event);
    },
    [filtering, beginRowReorder, dataSource],
  );

  // Reorder the GROUPS themselves, by carrying a group header. The block the
  // hook carries is the whole run — the header and every row filed under it,
  // all wearing the same `data-cards-group-run` — so Sessions travels with its
  // sessions and lands as one thing. Same container, same caret, same FLIP;
  // only the granularity differs.
  const { onRowPointerDown: beginGroupReorder } = useBlockReorder({
    containerRef: listWrapRef,
    caretRef,
    getVisibleOrder: () =>
      dragSpaceRef.current === null
        ? []
        : dataSource
            .visibleGroupOrder(dragSpaceRef.current)
            .map((group) => groupRunKey(dragSpaceRef.current ?? "", group)),
    // The order the hook hands back is of run keys; what persists is the group
    // order, one arrangement shared by every deck ([B09]).
    commit: (order) => cardsStore.setCardsGroupOrder(order.map(groupOfRunKey)),
    selector: GROUP_RUN_SELECTOR,
    kindAttr: GROUP_RUN_ATTR,
    // The keyboard lands on the group's header — the block's own handle, and
    // the row the user was pointing at when they let go.
    landKeyboard: (runKey) =>
      landCursorOn(
        dragSpaceRef.current === null
          ? -1
          : dataSource.indexForGroup(
              dragSpaceRef.current,
              groupOfRunKey(runKey),
            ),
      ),
  });
  // Unarmed while filtering, for the row reorder's reason: a group with no
  // surviving row emits no header, so the visible order is a partial one and
  // committing it would drop the missing group's place.
  const onGroupPointerDown = useCallback(
    (spaceId: string, group: CardsGroup, event: React.PointerEvent): void => {
      if (filtering) return;
      // A parked workspace's rows are a read-only view ([P09]), and the group
      // order this would commit is one arrangement shared by every deck.
      if (spaceId !== dataSource.activeSpaceId()) return;
      // Which workspace's run is being carried — the group reorder's visible
      // order and its keyboard landing are both scoped to it.
      dragSpaceRef.current = spaceId;
      beginGroupReorder(groupRunKey(spaceId, group), event);
    },
    [filtering, beginGroupReorder, dataSource],
  );

  // Reorder the WORKSPACES, by carrying a header. Same machinery one level
  // out: the block is the header plus every row under it, all wearing the same
  // `data-cards-space-run`, so a workspace travels with everything it holds
  // whether it is open or collapsed ([P10]).
  const { onRowPointerDown: beginSpaceReorder } = useBlockReorder({
    containerRef: listWrapRef,
    caretRef,
    getVisibleOrder: () => dataSource.visibleSpaceOrder(),
    commit: (order) => {
      getDeckStore()?.reorderSpaces([...order]);
    },
    selector: SPACE_RUN_SELECTOR,
    kindAttr: SPACE_RUN_ATTR,
    // The keyboard lands on the workspace's own header — the block's handle,
    // and the row the user was pointing at when they let go.
    landKeyboard: (spaceId) => landCursorOn(dataSource.indexForSpace(spaceId)),
  });
  // Unarmed while filtering, for the two inner reorders' reason: the visible
  // order under a filter is a partial one, and this commit persists the whole
  // list's arrangement.
  const onSpacePointerDown = useCallback(
    (spaceId: string, event: React.PointerEvent): void => {
      if (filtering) return;
      beginSpaceReorder(spaceId, event);
    },
    [filtering, beginSpaceReorder],
  );

  // The close box names the card it closes — `close-tab` carrying the row's own
  // `cardId`, walked from that card up to its host pane. This is the tab ×'s
  // event, and for the same reason: `close` means "close the active one", which
  // is only ever the row the user aimed at by luck. A row for a background tab
  // would close its pane's front card instead — the wrong card, silently. The
  // named path also keeps the close guard attached to the card it concerns, so
  // a dirty Text buffer is activated before it raises its save sheet.
  const chain = useResponderChain();
  const onClose = useCallback(
    (cardId: string): void => {
      // `sendToTarget` throws on an unregistered target, and a row can outlive
      // its card by a frame (the deck snapshot the rows were built from is one
      // render behind the unmount).
      if (chain === null || !chain.hasResponder(cardId)) return;
      // A card with unsaved work answers this × with a sheet, and the sheet
      // comes up on the card — which may be behind another pane, or be a
      // background tab nobody can see. So front it first, exactly as a plain
      // click on this row would, flash and all: the question has to arrive
      // somewhere the user is already looking. A close that simply happens
      // gets no announcement; the row vanishing is the whole answer.
      if (askedBeforeClosing(cardId)) {
        dispatchCommand("focus-session-card", { cardId });
      }
      chain.sendToTarget(cardId, {
        action: TUG_ACTIONS.CLOSE_TAB,
        value: cardId,
        phase: "discrete",
      });
    },
    [chain],
  );

  // A pane row's × is the pane's own X, aimed from here. `close-pane` goes to
  // the PANE's responder (registered under the pane id), which runs the title
  // bar's close flow whole — save guards, then the confirm. A multi-tab pane
  // always confirms, so this one always fronts and flashes: the popover it
  // opens is anchored to that pane's X, off in the deck.
  const onClosePane = useCallback(
    (paneId: string, activeCardId: string): void => {
      if (chain === null || !chain.hasResponder(paneId)) return;
      dispatchCommand("focus-session-card", { cardId: activeCardId });
      chain.sendToTarget(paneId, {
        action: TUG_ACTIONS.CLOSE_PANE,
        phase: "discrete",
      });
    },
    [chain],
  );

  const onToggleGroup = useCallback((group: CardsGroup): void => {
    const collapsed = cardsStore.getSnapshot().collapsedCardGroups;
    cardsStore.setCardGroupCollapsed(group, !collapsed.includes(group));
  }, []);

  // The fold cue on an inactive workspace's header. The active one is expanded
  // by the data source's own rule and its cue is drawn disabled, so nothing
  // here has to special-case it.
  const onToggleSpace = useCallback((spaceId: string): void => {
    expandedSpacesStore.toggle(spaceId);
  }, []);

  // Which workspace's header is showing its rename field, and which delete is
  // waiting on its confirm. Both are view scope ([L24]): a rename nobody
  // committed and a confirm nobody answered are not worth remembering, and
  // closing the card forgets them.
  const [renamingSpaceId, setRenamingSpaceId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    spaceId: string;
    name: string;
    sessions: number;
    anchor: HTMLElement | null;
  } | null>(null);

  const onCommitRename = useCallback(
    (spaceId: string, name: string): void => {
      setRenamingSpaceId(null);
      // An empty or unchanged name is the store's refusal, not this card's:
      // one definition of what a workspace may be called ([P05]).
      getDeckStore()?.renameSpace(spaceId, name);
    },
    [],
  );
  const onCancelRename = useCallback((): void => setRenamingSpaceId(null), []);

  // The keyboard follows the field that just opened ([L22]): placement, never
  // a raw focus write, because in this card's keyboard-focus mode the route
  // itself is what a placement changes — a field with DOM focus and no key
  // view receives nothing.
  const focusRenameField = useCallback((): void => {
    focusManager?.place(
      cardId,
      {
        kind: "focus-key",
        focusKey: `${CARDS_FOCUS_GROUP}:${CARDS_RENAME_FOCUS_ORDER}`,
      },
      { modality: "keyboard" },
    );
  }, [focusManager, cardId]);

  /** The header row's CELL, for a popover that must outlive the menu that
   *  armed it — the anchor the Arcs card's confirm takes, for its reason. */
  const anchorForSpace = useCallback((spaceId: string): HTMLElement | null => {
    const root = listWrapRef.current;
    if (root === null) return null;
    const header = root.querySelector<HTMLElement>(
      `.cards-space-header[data-cards-space-id="${CSS.escape(spaceId)}"]`,
    );
    if (header === null) return null;
    return (header.closest(".tug-list-view-cell") as HTMLElement | null) ?? header;
  }, []);

  /** What a workspace is called, read off the projection the rows came from. */
  const spaceNameOf = useCallback(
    (spaceId: string): string => {
      const row = dataSource.rowAt(dataSource.indexForSpace(spaceId));
      return row !== undefined && row.type === "space-header" ? row.name : "";
    },
    [dataSource],
  );

  const cellContext = useMemo<CardsCellContextValue>(
    () => ({
      onRowPointerDown,
      onClose,
      onClosePane,
      onGroupPointerDown,
      onToggleGroup,
      onSpacePointerDown,
      onToggleSpace,
      renamingSpaceId,
      onCommitRename,
      onCancelRename,
      focusGroup: CARDS_FOCUS_GROUP,
      focusRenameField,
      spaceCount,
      filterQuery,
    }),
    [
      onRowPointerDown,
      onClose,
      onClosePane,
      onGroupPointerDown,
      onToggleGroup,
      onSpacePointerDown,
      onToggleSpace,
      renamingSpaceId,
      onCommitRename,
      onCancelRename,
      focusRenameField,
      spaceCount,
      filterQuery,
    ],
  );

  // `onSelect` is the CLICK's callback and `onActivate` is Enter's, and on this
  // list they are no longer the same act. A click both moves the selection onto
  // the row (the primitive's own `onPick`, below) and fronts its card; Enter
  // fronts the cursor row. Space reaches neither — it is a selection gesture and
  // the primitive keeps it, which is what gives the keyboard a way to say "this
  // row is what I mean" without also opening it.
  //
  // A group header is the exception at both doors: it has no card to front, so
  // either key toggles the group.
  //
  // A WORKSPACE header maps to no card either, and what it means instead is
  // "go there" ([P09], Spec S05): the primitive routes the gesture to
  // `onActivate` and the command is a no-op on the workspace already showing.
  const delegate = useMemo<TugListViewDelegate>(() => {
    const activate = (index: number): void => {
      const row: CardsRow | undefined = dataSource.rowAt(index);
      if (row === undefined) return;
      if (row.type === "space-header") {
        dispatchCommand("activate-space", { spaceId: row.spaceId });
        return;
      }
      if (row.type === "group-header") {
        onToggleGroup(row.group);
        return;
      }
      lastSelectedRowId = dataSource.idForIndex(index);
      dispatchCommand("focus-session-card", {
        cardId: row.identity.cardId,
      });
    };
    return { onSelect: activate, onActivate: activate };
  }, [dataSource, onToggleGroup]);

  // ---- The layout selection ----
  //
  // The list is a VIEW of the selection ([L02]); the set itself lives in
  // `cardsSelectionStore` because it outlives this section — the deck's slot and
  // width verbs resolve through it whether the Cards card is open or collapsed.
  //
  // Two id spaces meet here and the section is the translator. The list speaks
  // row ids (`pane:…` / `card:…` / `header:…`, from `idOfRow`) because that is
  // what identifies a row; the store speaks CARD ids, because that is what a
  // layout verb acts on. A card shows as a pane row when it is its pane's
  // identity card and as a subrow when it is not, so the mapping has to be read
  // off the live rows rather than assumed from either spelling.
  const selection = useSyncExternalStore(
    cardsSelectionStore.subscribe,
    cardsSelectionStore.getSnapshot,
  );
  const { selectedRowIds, cardIdByRowId, visibleCardOrder } = useMemo(() => {
    const selected = new Set(selection.ids);
    const rowIds = new Set<string>();
    const byRowId = new Map<string, string>();
    const order: string[] = [];
    const seen = new Set<string>();
    // Rows of a parked workspace name cards the rendered deck does not hold.
    const activeSpaceId = dataSource.activeSpaceId();
    for (let i = 0; i < dataSource.numberOfItems(); i += 1) {
      const row = dataSource.rowAt(i);
      // Headers map to no card; and a row of an INACTIVE workspace maps to a
      // card that is not in the rendered deck, so a layout chord aimed at it
      // would act on nothing ([P09]).
      if (
        row === undefined ||
        row.type === "space-header" ||
        row.type === "group-header"
      ) {
        continue;
      }
      if (row.spaceId !== activeSpaceId) continue;
      const rowId = idOfRow(row);
      const cardId = row.identity.cardId;
      byRowId.set(rowId, cardId);
      if (selected.has(cardId)) rowIds.add(rowId);
      // A stack's identity card owns two rows — the pane row and its own
      // subrow. The order carries it once, at its first appearance, so a range
      // never depends on which of the two the user happened to click.
      if (!seen.has(cardId)) {
        seen.add(cardId);
        order.push(cardId);
      }
    }
    return {
      selectedRowIds: rowIds,
      cardIdByRowId: byRowId,
      visibleCardOrder: order,
    };
  }, [dataSource, selection]);

  // A group header maps to no card, so every intent answers `false` for one and
  // the primitive puts the gesture back on the activate path — which for a
  // header means folding its group, the meaning it has always had.
  const multiSelect = useMemo(
    () => ({
      selectedIds: selectedRowIds,
      // A plain pick collapses the set to the row picked. On a click the
      // delegate's `onSelect` fires alongside it and fronts the card — the two
      // halves of a plain click ([P06]) — while Space stops here.
      onPick: (rowId: string): boolean => {
        const cardId = cardIdByRowId.get(rowId);
        if (cardId === undefined) return false;
        cardsSelectionStore.pickOnly(cardId);
        return true;
      },
      onToggle: (rowId: string): boolean => {
        const cardId = cardIdByRowId.get(rowId);
        if (cardId === undefined) return false;
        cardsSelectionStore.toggle(cardId);
        return true;
      },
      onExtendTo: (rowId: string): boolean => {
        const cardId = cardIdByRowId.get(rowId);
        if (cardId === undefined) return false;
        cardsSelectionStore.extendTo(cardId, visibleCardOrder);
        return true;
      },
      // Escape, whenever there is a set — the same clear the Cards card's own
      // `CANCEL_DIALOG` responder runs, reached from the one place the ladder
      // could otherwise outrank it: while the list holds the keyboard.
      onClear: (): boolean => {
        if (cardsSelectionStore.getSnapshot().ids.length === 0) return false;
        cardsSelectionStore.clear();
        return true;
      },
      // The set is the store's, not the visible rows'. `selectedRowIds` is a
      // projection over the rows showing right now, so a selection the filter
      // has hidden — or one folded inside a collapsed group — projects to
      // nothing, and Escape's gate would read "no set" over a set that stands.
      // What the press takes back is the selection, not the visible part of it.
      hasSelection: (): boolean =>
        cardsSelectionStore.getSnapshot().ids.length > 0,
    }),
    [selectedRowIds, cardIdByRowId, visibleCardOrder],
  );

  // Publish where the keyboard is standing, so a slot or width chord typed with
  // the caret on a row and nothing selected acts on THAT row
  // (`resolveLayoutSelection`'s second rung). The list hands back `null` the
  // moment it stops holding the keyboard, and a header maps to no card, so the
  // published answer is only ever a card the user is actually pointed at.
  const publishCursor = useCallback(
    (rowId: string | null): void => {
      setLayoutCursorCard(
        rowId === null ? null : (cardIdByRowId.get(rowId) ?? null),
      );
    },
    [cardIdByRowId],
  );
  // The card can unmount with the keyboard still in it (a rail close), and a
  // cursor nobody can see must not go on answering for one.
  useLayoutEffect(() => () => setLayoutCursorCard(null), []);

  // ArrowDown out of the filter field hands the key view to the list — the
  // field's advance contract, routed through the FocusManager ([L22]).
  const advanceToList = useCallback((): void => {
    focusManager?.place(
      cardId,
      { kind: "focus-key", focusKey: `${CARDS_FOCUS_GROUP}:0` },
      { modality: "keyboard" },
    );
  }, [focusManager, cardId]);
  const filterDelegate = useMemo(
    () => ({
      filterFieldDidChangeQuery: setFilterQuery,
      onAdvance: advanceToList,
      ...filter.delegate,
    }),
    [advanceToList, filter],
  );

  // Escape anywhere inside the card that is not the field or the list: the
  // same table those two run, reached from the one place they cannot answer.
  // The focus-out rung is not this responder's — the rail ladder owns leaving
  // a rail — so an Escape with nothing to shrink is simply not handled here.
  const responderId = useId();
  const { ResponderScope, responderRef } = useResponder({
    id: responderId,
    actions: {
      [TUG_ACTIONS.CANCEL_DIALOG]: () => {
        shrinkCardsState();
      },
      // The workspace header's four verbs ([P11]). They land here rather than
      // on the cell that opened the menu because everything they need outlives
      // a cell: the deck store, the rename in flight, and the card's one
      // confirm. Each reads its workspace out of the item's own payload, so a
      // verb acts on the row the right-click landed on rather than on wherever
      // the list cursor happens to be.
      [TUG_ACTIONS.NEW_SPACE]: () => {
        getDeckStore()?.createSpace();
      },
      [TUG_ACTIONS.RENAME_SPACE]: (event: ActionEvent) => {
        const payload = event.value as
          | { spaceId?: unknown; name?: unknown }
          | undefined;
        if (typeof payload?.spaceId !== "string") return;
        // With a name it commits; without one it opens the header's field.
        // The menu item sends no name, so the item IS the second form — the
        // first is there for anything that already knows what to call it.
        if (typeof payload.name === "string") {
          onCommitRename(payload.spaceId, payload.name);
          return;
        }
        setRenamingSpaceId(payload.spaceId);
      },
      [TUG_ACTIONS.DUPLICATE_SPACE]: (event: ActionEvent) => {
        const spaceId = (event.value as { spaceId?: unknown } | undefined)
          ?.spaceId;
        if (typeof spaceId !== "string") return;
        getDeckStore()?.duplicateSpace(spaceId);
      },
      [TUG_ACTIONS.DELETE_SPACE]: (event: ActionEvent) => {
        const spaceId = (event.value as { spaceId?: unknown } | undefined)
          ?.spaceId;
        if (typeof spaceId !== "string") return;
        const store = getDeckStore();
        if (store === null) return;
        // The confirm and the close loop read one definition of "holds live
        // sessions" ([P07]) — this call is that definition, asked here so the
        // number in the sentence is the number that will be closed.
        const sessions = store.spaceHoldsLiveSessions(spaceId);
        if (sessions > 0) {
          setPendingDelete({
            spaceId,
            name: spaceNameOf(spaceId),
            sessions,
            anchor: anchorForSpace(spaceId),
          });
          return;
        }
        store.deleteSpace(spaceId);
      },
    },
  });

  return (
    <ResponderScope>
    <div
      ref={responderRef as (el: HTMLDivElement | null) => void}
      className="cards-card"
      data-cards-card-id={cardId}
      // Focusable root so `transferFocusForActivation` → `applyBagFocus` has a
      // target to land the ring on when the card is focused.
      tabIndex={-1}
    >
      {/* The content element ([B01]): the toolbar and the list as one in-flow
          column. Its border-box height is what the rail measures, and nothing
          between it and the scroller stretches ([B02]). */}
      <div
        className="cards-card-content"
        ref={annotationRootRef}
        data-testid="cards-card-content"
        data-card-content=""
      >
      <div className="cards-toolbar" data-testid="cards-toolbar">
        <TugFilterField
          key={hasItems ? "live" : "inert"}
          delegate={filterDelegate}
          attachment={filter}
          placeholder="Filter Workspaces"
          defaultValue={filterQuery}
          disabled={!hasItems}
          data-testid="cards-filter"
          focusGroup={CARDS_FOCUS_GROUP}
          focusOrder={CARDS_FILTER_FOCUS_ORDER}
        />
      </div>
      {!hasContent ? (
        // Empty label instead of the list — an empty `flex: 1` list would grow
        // and open a gap under the toolbar. "No matches" is the distinct
        // filtered-to-zero face: there ARE cards, the filter is hiding them.
        <div
          className="cards-empty"
          data-testid="cards-empty"
        >
          {dataSource.unfilteredCount() > 0 ? "No matches" : "None"}
        </div>
      ) : (
        <div
          className="cards-list-wrap"
          ref={listWrapRef}
          data-filter-active={filtering ? "true" : undefined}
        >
          <BlockDropCaret ref={caretRef} />
          <CardsCellContext value={cellContext}>
            {/* `inline` is load-bearing, not a preference. `useBlockReorder`
                aborts a drag silently — no error, no log — if any key in the
                visible order has no MOUNTED element, so a windowed list would
                have working reorder above the fold and dead reorder below it. */}
            <TugListView<CardsDataSource>
              ref={listRef}
              dataSource={dataSource}
              delegate={delegate}
              cellRenderers={CARDS_CELL_RENDERERS}
              scrollKey="cards-card"
              inline
              rowLayout="flush"
              focusGroup={hasContent ? CARDS_FOCUS_GROUP : undefined}
              attachedFilter={filter}
              commitOnEnter="act"
              multiSelect={multiSelect}
              onCursorChange={publishCursor}
              initialSelectedIndex={initialSelectedIndex}
              {...RAIL_LIST_PRESENTATION}
              className="cards-list"
            />
          </CardsCellContext>
        </div>
      )}
      </div>
      {/* The card's one confirm, anchored to whichever workspace header armed
          it. `confirmRole="danger"` puts default focus on Cancel, so a
          reflexive Return can never take a workspace and its sessions. */}
      <TugConfirmPopover
        open={pendingDelete !== null}
        anchorEl={pendingDelete?.anchor ?? null}
        message={
          pendingDelete === null
            ? ""
            : `Delete ${pendingDelete.name} and close ${
                pendingDelete.sessions === 1
                  ? "1 session"
                  : `${pendingDelete.sessions} sessions`
              }?`
        }
        confirmLabel="Delete"
        confirmRole="danger"
        side="top"
        onConfirm={() => {
          const armed = pendingDelete;
          setPendingDelete(null);
          if (armed === null) return;
          getDeckStore()?.deleteSpace(armed.spaceId);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
    </ResponderScope>
  );
}
