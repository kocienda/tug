/**
 * cards-section.tsx — the Lens **Cards** section: a pane-first mirror of the
 * deck canvas. Every card on the deck has a row here, grouped by kind
 * (Sessions / Files / Tools).
 *
 * The list is two-level, and the second level is a fact of the deck's data
 * model rather than a folder the user opens:
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
 * Group headers are cursorable rows, not `TugListView`'s inert `"header"`
 * role: the arrow walk reaches them and Enter/Space toggles that group's
 * collapse. That choice is what makes the cursor-seed rule below necessary. To
 * the mouse the header is the group's drag handle and the chevron is the only
 * thing that folds — travel tells the two apart, so a press that goes nowhere
 * does nothing.
 *
 * The list is one Tab stop in the Lens; arrows rove the movement cursor,
 * Enter/click fronts the row's card (`focus-session-card`). Two things carry,
 * both on the shared `useBlockReorder` FLIP: a pane row within its own group
 * (committing `cardsRowOrder`), and a whole GROUP by its header — the header
 * and every row under it move as one block (committing `cardsGroupOrder`).
 *
 * Laws: [L02] the deck, the open registries, the bindings, and the persisted
 * arrangement all enter React through `useSyncExternalStore`; [L06] cursor,
 * selection, and the header's collapsed look are CSS on DOM attributes, never
 * React state; [L19]/[L20] every row composes a real Tug primitive; [L22] the
 * FocusManager owns the cursor; [L24] selection is the list's.
 *
 * @module components/lens/sections/cards-section
 */

import "./cards-section.css";

import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
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
import { BlockDropCaret } from "@/components/lens/block-drop-caret";
import { BlockFoldCue } from "@/components/tugways/body-kinds/affordances/block-fold-cue";
import { useBlockReorder } from "@/components/lens/block-reorder";
import {
  getFilterQuery,
  getFilterVersion,
  subscribeFilterQuery,
} from "@/components/lens/lens-filter-store";
import { LENS_LIST_PRESENTATION } from "@/components/lens/lens-list-presentation";
import {
  sectionAttachedFilter,
  setSectionAttachedList,
  setSectionContent,
} from "@/components/lens/lens-section-content";
import { lensSelectionStore } from "@/components/lens/lens-selection-store";
import { registerLensSection } from "@/components/lens/lens-section-registry";
import type { LensSectionHost } from "@/components/lens/lens-section-registry";
import { SlotPicker } from "@/components/lens/slot-picker";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { renderFilterHighlight } from "@/components/tugways/filter-highlight";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";
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
import { useFocusManager } from "@/components/tugways/use-focusable";
import { renderIcon } from "@/components/tugways/tug-tab-bar";
import { getCardCloseGuard } from "@/lib/card-close-guard";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import { useChangesetAll } from "@/lib/changeset-all-store";
import { classifyFileKind } from "@/lib/file-kinds";
import { lensStore } from "@/lib/lens-store/lens-store";
import { sessionNameStore } from "@/lib/session-name-store";
import { sessionTagStore } from "@/lib/session-tag-store";

import {
  displayPath,
  idOfRow,
  useLensCardsDataSource,
  type CardIdentity,
  type CardsRow,
  type LensCardsDataSource,
} from "./cards-data-source";
import { GROUP_TITLES, type LensCardsGroup } from "./cards-groups";
import { CardsSessionRow } from "./cards-session-cell";

/** This section's kind — the key its filter query lives under, and the kind
 *  its persisted collapse state is stored against. */
const SECTION_KIND = "cards";

// Pane rows are matched for reorder by their uniform order key. Deliberately
// NOT `data-card-id`: that attribute is the card HOST's, and a row carrying it
// would make `[data-card-id="…"]` resolve to a Lens row instead of the card's
// own pane.
const ROW_SELECTOR = ".lens-cards-row[data-lens-row-id]";
const ROW_KIND_ATTR = "data-lens-row-id";

// A group's run for the GROUP reorder: its header plus every row filed under
// it, all carrying the same group name. `useBlockReorder` treats elements
// sharing a key as one block, so matching the run here is the whole of what
// makes a group carry its rows with it.
const GROUP_RUN_SELECTOR = "[data-lens-group-run]";
const GROUP_RUN_ATTR = "data-lens-group-run";

/** Focus group for a row's close box. The rows render inside `TugListView`'s
 *  per-row `FocusModeContext`, so the button registers into its own row's
 *  descend scope — the mode scopes the walk, this constant is only the
 *  within-row ordering. ArrowRight on the cursor row descends onto it, ahead of
 *  the slot picker. */
const ROW_ACTION_FOCUS_GROUP = "lens-cards-row-actions";

// The section's remembered selection — the last-touched row id, mapped to a
// cursor seed on the next Cmd-L / Tab. Module-level so it outlives a collapse
// toggle; valid while the Lens is a singleton card.
let lastSelectedRowId: string | null = null;

/** Row verbs the section body hands the module-level cells. */
interface CardsCellContextValue {
  onRowPointerDown: (orderKey: string, event: React.PointerEvent) => void;
  onClose: (cardId: string) => void;
  onClosePane: (paneId: string, activeCardId: string) => void;
  onGroupPointerDown: (group: LensCardsGroup, event: React.PointerEvent) => void;
  onToggleGroup: (group: LensCardsGroup) => void;
  filterQuery: string;
}
const CardsCellContext = React.createContext<CardsCellContextValue | null>(null);

/**
 * Whether closing this card will stop and ask rather than just close — the
 * card's own close guard has unsaved work to raise a Save / Don't Save sheet
 * over. It is asked BEFORE the close is sent, because the answer decides
 * whether the Lens fronts the card first: only a close that puts a question on
 * screen needs the user looking at the card it appears on.
 *
 * The pane's `close-tab` handler consults exactly this guard and nothing else,
 * so the reading here and the behaviour there cannot disagree.
 */
function askedBeforeClosing(cardId: string): boolean {
  return getCardCloseGuard(cardId)?.needsDecision() === true;
}

/** The band's live filter query, read straight from the store ([L02]). */
function useCardsFilterQuery(): string {
  useSyncExternalStore(subscribeFilterQuery, getFilterVersion);
  return getFilterQuery(SECTION_KIND);
}

function useCellContext(): CardsCellContextValue {
  const ctx = React.useContext(CardsCellContext);
  if (ctx === null) throw new Error("Cards cell rendered outside its section");
  return ctx;
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
const GROUP_GLYPHS: Readonly<Record<LensCardsGroup, React.ReactElement>> = {
  sessions: <MessageSquareText size={12} />,
  files: <FileText size={12} />,
  tools: <Wrench size={12} />,
};

/** Any other card's glyph: its registration's icon, through the same resolver
 *  the tab bar uses, so a card looks the same in the Lens as on its tab. */
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
 *  the name line, which is what lines the pickers up down the Lens.
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
  const headline = <span className="lens-cards-row-headline">{children}</span>;
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
}: {
  identity: CardIdentity;
  glyph: React.ReactNode;
  disambiguator: string | null;
  /** The reorder key, on a pane row; absent on a subrow (subrows do not drag). */
  rowId: string | null;
  /** The group this row sits in — names the run a pane row belongs to. */
  group: LensCardsGroup;
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
          ? "lens-cards-oneline lens-cards-subrow"
          : "lens-cards-oneline lens-cards-row"
      }
      data-lens-group-run={group}
      {...(rowId !== null
        ? { "data-lens-row-id": rowId, "data-lens-row-group": group }
        : {})}
      {...(subrow ? { "data-lens-card-id": identity.cardId } : {})}
      leading={
        showClose ? (
          <TugIconButton
            className="lens-cards-row-close"
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
      // has no handle: reordering tabs from the Lens is not this section's job.
      onPointerDown={
        rowId !== null ? (e) => ctx.onRowPointerDown(rowId, e) : undefined
      }
    >
      {/* The path is the row's hover, in the house file tip — a row shows a
          card's title, and its path is the fact that title cannot carry.
          `TugListRow` owns the `title` prop as row text, so the hover rides
          the content column instead. */}
      <RowHeadlineHover path={hoverPath}>
        <span className="lens-cards-row-glyph" aria-hidden="true">
          {glyph}
        </span>
        <TugLabel className="tug-list-row-title" size="sm" maxLines={1}>
          {renderFilterHighlight(identity.title, ctx.filterQuery)}
          {identity.unsaved ? (
            <span
              className="lens-cards-row-unsaved"
              data-testid="lens-card-unsaved"
              title="Unsaved changes"
              aria-label="Unsaved changes"
            >
              •
            </span>
          ) : null}
        </TugLabel>
        {disambiguator !== null ? (
          <span className="lens-cards-row-where" data-testid="lens-card-where">
            {disambiguator}
          </span>
        ) : null}
        {trailing}
        {showSlots ? <SlotPicker cardId={identity.cardId} /> : null}
      </RowHeadlineHover>
    </TugListRow>
  );
}

// ---------------------------------------------------------------------------
// Cell renderers
// ---------------------------------------------------------------------------

/** The group header: a cursorable row whose Space toggles the group's collapse.
 *  It composes `TugListRow` like every other row, and its fold wears the SAME
 *  affordance the Lens section bands wear, at the same edge — a `BlockFoldCue`
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
const GroupHeaderCell: TugListViewCellRenderer<LensCardsDataSource> = ({
  index,
  dataSource,
}: TugListViewCellProps<LensCardsDataSource>) => {
  const row = dataSource.rowAt(index);
  const ctx = useCellContext();
  if (row.type !== "group-header") return null;
  const title = GROUP_TITLES[row.group];
  return (
    <TugListRow
      className="lens-cards-header"
      data-lens-group={row.group}
      data-lens-group-run={row.group}
      data-group-collapsed={row.collapsed ? "true" : "false"}
      data-testid="lens-cards-header"
      // The header IS the group's drag handle: a press arms the carry of the
      // whole run, and travel past the threshold engages it.
      onPointerDown={(e) => ctx.onGroupPointerDown(row.group, e)}
      // Below the threshold the press is still a click, and on a header a
      // click is nothing — the fold cue is the only thing that folds. Swallowed
      // so the cell wrapper never reads it as a pick.
      onClick={(e) => e.stopPropagation()}
      trailing={
        <BlockFoldCue
          className="lens-cards-header-fold"
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
      <span className="lens-cards-header-line">
        <span className="lens-cards-header-glyph" aria-hidden="true">
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
            className="lens-cards-header-count"
            data-testid="lens-cards-header-count"
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
const SessionPaneCell: TugListViewCellRenderer<LensCardsDataSource> = ({
  index,
  dataSource,
  selected,
}: TugListViewCellProps<LensCardsDataSource>) => {
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
    />
  );
};

/** A single-card file pane — the file row, unchanged from the section it came
 *  from. */
const FilePaneCell: TugListViewCellRenderer<LensCardsDataSource> = ({
  index,
  dataSource,
  selected,
}: TugListViewCellProps<LensCardsDataSource>) => {
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
      subrow={false}
      showSlots
      showClose={row.identity.closable}
    />
  );
};

/** Any other single-card pane — a Settings card, the About box, a gallery
 *  demo. Its registration's icon and title, the slot picker, and a close box
 *  when the card is closable. */
const ToolPaneCell: TugListViewCellRenderer<LensCardsDataSource> = ({
  index,
  dataSource,
  selected,
}: TugListViewCellProps<LensCardsDataSource>) => {
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
const StackPaneCell: TugListViewCellRenderer<LensCardsDataSource> = ({
  index,
  dataSource,
  selected,
}: TugListViewCellProps<LensCardsDataSource>) => {
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
      subrow={false}
      showSlots
      showClose={row.closable}
      closesPane={{ paneId: row.paneId, cardCount: row.cardCount }}
      trailing={
        <span className="lens-cards-row-tabs" data-testid="lens-cards-tab-count">
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
const SubcardCell: TugListViewCellRenderer<LensCardsDataSource> = ({
  index,
  dataSource,
  selected,
}: TugListViewCellProps<LensCardsDataSource>) => {
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
      subrow
      showSlots={false}
      showClose={row.identity.closable}
    />
  );
};

const CARDS_CELL_RENDERERS: Record<
  string,
  TugListViewCellRenderer<LensCardsDataSource>
> = {
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

/** Live collapsed summary: the per-group census, zero-count groups omitted. */
function CardsCollapsedSummary(): React.ReactElement {
  const { dataSource } = useCardsInputs("");
  const census = dataSource.censusByGroup();
  const parts: string[] = [];
  if (census.sessions > 0) {
    parts.push(`${census.sessions} session${census.sessions === 1 ? "" : "s"}`);
  }
  if (census.files > 0) {
    parts.push(`${census.files} file${census.files === 1 ? "" : "s"}`);
  }
  if (census.tools > 0) {
    parts.push(`${census.tools} tool${census.tools === 1 ? "" : "s"}`);
  }
  return <>{parts.length === 0 ? "No cards" : parts.join(" · ")}</>;
}

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

/** Feed the data source from every store the projection reads. Shared by the
 *  body and the collapsed summary so the two never disagree about what is on
 *  the deck. */
function useCardsInputs(filterQuery: string): {
  dataSource: LensCardsDataSource;
} {
  const bindings = useOpenBindings();
  const cardsRowOrder = useSyncExternalStore(
    lensStore.subscribe,
    useCallback(() => lensStore.getSnapshot().cardsRowOrder, []),
  );
  const groupOrder = useSyncExternalStore(
    lensStore.subscribe,
    useCallback(() => lensStore.getSnapshot().cardsGroupOrder, []),
  );
  const collapsedGroups = useSyncExternalStore(
    lensStore.subscribe,
    useCallback(() => lensStore.getSnapshot().collapsedCardGroups, []),
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
  // The account-global aggregate, for the dash sub-rows. A whole snapshot
  // rather than a version token: the projection needs the dash's facts, and the
  // index it builds from them is memoized on this snapshot's identity.
  const changesets = useChangesetAll();
  const dataSource = useLensCardsDataSource({
    cardsRowOrder,
    groupOrder,
    collapsedGroups,
    filterQuery,
    bindings,
    tagVersion,
    nameVersion,
    changesets,
  });
  return { dataSource };
}

function CardsSectionBody({
  host,
}: {
  host: LensSectionHost;
}): React.ReactElement {
  const filterQuery = useCardsFilterQuery();
  const { dataSource } = useCardsInputs(filterQuery);
  const focusManager = useFocusManager();
  const count = dataSource.numberOfItems();
  const filtering = dataSource.isFiltering();

  // Publish what this band holds: `navigable` so the Lens skips it for the
  // Cmd-L seed / Tab walk when the list shows nothing, `populated` (the count
  // BEFORE the filter) so the band knows whether there is anything to filter.
  const hasContent = count > 0;
  const hasItems = dataSource.unfilteredCount() > 0;
  useLayoutEffect(() => {
    setSectionContent(host.focusGroup, {
      navigable: hasContent,
      populated: hasItems,
    });
    return () =>
      setSectionContent(host.focusGroup, {
        navigable: false,
        populated: false,
      });
  }, [host.focusGroup, hasContent, hasItems]);

  // The cursor seeds onto the remembered row, else onto the first PANE row —
  // never left undefined. `TugListView` seeds an unset cursor to its first
  // cursorable row, and because group headers are cursorable that would be a
  // collapse toggle: every Cmd-L into a fresh Lens would land on a header
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
  // uniform `data-lens-row-id`; the FLIP animates the row, the store commit
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
  const caretRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<TugListViewHandle>(null);

  // Publish this list as the section's ATTACHED LIST ([P08]), so the band's
  // filter field — a sibling that cannot see this body — can drive its cursor
  // from its own caret. Withdrawn on unmount (a collapsed section), which is
  // what makes the band's lookup answer `null` rather than cursoring a list
  // that is not on screen.
  useLayoutEffect(() => {
    setSectionAttachedList(host.focusGroup, listRef.current);
    return () => setSectionAttachedList(host.focusGroup, null);
  }, [host.focusGroup]);
  const dragGroupRef = useRef<LensCardsGroup | null>(null);

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
        host.lensCardId,
        { kind: "focus-key", focusKey: `${host.focusGroup}:0` },
        { modality: "keyboard" },
      );
      listRef.current?.moveCursorTo(index);
    },
    [dataSource, focusManager, host.lensCardId, host.focusGroup],
  );
  const { onRowPointerDown: beginRowReorder } = useBlockReorder({
    containerRef: listWrapRef,
    caretRef,
    getVisibleOrder: () => {
      const group = dragGroupRef.current;
      if (group === null) return [];
      const groups = dataSource.groupByOrderKey();
      return dataSource.visibleOrder().filter((key) => groups.get(key) === group);
    },
    commit: (order) => {
      const group = dragGroupRef.current;
      if (group === null) return;
      lensStore.setCardsRowOrder(group, [...order]);
    },
    selector: ROW_SELECTOR,
    kindAttr: ROW_KIND_ATTR,
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
      dragGroupRef.current = dataSource.groupByOrderKey().get(orderKey) ?? null;
      beginRowReorder(orderKey, event);
    },
    [filtering, beginRowReorder, dataSource],
  );

  // Reorder the GROUPS themselves, by carrying a group header. The block the
  // hook carries is the whole run — the header and every row filed under it,
  // all wearing the same `data-lens-group-run` — so Sessions travels with its
  // sessions and lands as one thing. Same container, same caret, same FLIP;
  // only the granularity differs.
  const { onRowPointerDown: beginGroupReorder } = useBlockReorder({
    containerRef: listWrapRef,
    caretRef,
    getVisibleOrder: () => dataSource.visibleGroupOrder(),
    commit: (order) => lensStore.setCardsGroupOrder([...order]),
    selector: GROUP_RUN_SELECTOR,
    kindAttr: GROUP_RUN_ATTR,
    // The keyboard lands on the group's header — the block's own handle, and
    // the row the user was pointing at when they let go.
    landKeyboard: (group) => landCursorOn(dataSource.indexForGroup(group)),
  });
  // Unarmed while filtering, for the row reorder's reason: a group with no
  // surviving row emits no header, so the visible order is a partial one and
  // committing it would drop the missing group's place.
  const onGroupPointerDown = useCallback(
    (group: LensCardsGroup, event: React.PointerEvent): void => {
      if (filtering) return;
      beginGroupReorder(group, event);
    },
    [filtering, beginGroupReorder],
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

  const onToggleGroup = useCallback((group: LensCardsGroup): void => {
    const collapsed = lensStore.getSnapshot().collapsedCardGroups;
    lensStore.setCardGroupCollapsed(group, !collapsed.includes(group));
  }, []);

  const cellContext = useMemo<CardsCellContextValue>(
    () => ({
      onRowPointerDown,
      onClose,
      onClosePane,
      onGroupPointerDown,
      onToggleGroup,
      filterQuery,
    }),
    [
      onRowPointerDown,
      onClose,
      onClosePane,
      onGroupPointerDown,
      onToggleGroup,
      filterQuery,
    ],
  );

  // A card row has no "selected but not activated" state: Space/click
  // (`onSelect`) and Enter (`onActivate`) both act. On a card row that means
  // fronting it; on a group header it means toggling the group.
  const delegate = useMemo<TugListViewDelegate>(() => {
    const activate = (index: number): void => {
      const row: CardsRow | undefined = dataSource.rowAt(index);
      if (row === undefined) return;
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
  // `lensSelectionStore` because it outlives this section — the deck's slot and
  // width verbs resolve through it whether the Lens is open or collapsed.
  //
  // Two id spaces meet here and the section is the translator. The list speaks
  // row ids (`pane:…` / `card:…` / `header:…`, from `idOfRow`) because that is
  // what identifies a row; the store speaks CARD ids, because that is what a
  // layout verb acts on. A card shows as a pane row when it is its pane's
  // identity card and as a subrow when it is not, so the mapping has to be read
  // off the live rows rather than assumed from either spelling.
  const selection = useSyncExternalStore(
    lensSelectionStore.subscribe,
    lensSelectionStore.getSnapshot,
  );
  const { selectedRowIds, cardIdByRowId, visibleCardOrder } = useMemo(() => {
    const selected = new Set(selection.ids);
    const rowIds = new Set<string>();
    const byRowId = new Map<string, string>();
    const order: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < dataSource.numberOfItems(); i += 1) {
      const row = dataSource.rowAt(i);
      if (row === undefined || row.type === "group-header") continue;
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

  const multiSelect = useMemo(
    () => ({
      selectedIds: selectedRowIds,
      // A plain pick collapses the set to the row picked. The delegate's
      // `onSelect` fires alongside it and fronts the card — the two halves of
      // a plain click ([P06]).
      onPick: (rowId: string): void => {
        const cardId = cardIdByRowId.get(rowId);
        if (cardId !== undefined) lensSelectionStore.pickOnly(cardId);
      },
      onToggle: (rowId: string): void => {
        const cardId = cardIdByRowId.get(rowId);
        if (cardId !== undefined) lensSelectionStore.toggle(cardId);
      },
      onExtendTo: (rowId: string): void => {
        const cardId = cardIdByRowId.get(rowId);
        if (cardId !== undefined) {
          lensSelectionStore.extendTo(cardId, visibleCardOrder);
        }
      },
    }),
    [selectedRowIds, cardIdByRowId, visibleCardOrder],
  );

  return (
    <div className="lens-cards-section">
      {count === 0 ? (
        // Empty label instead of the list — an empty `flex: 1` list would grow
        // and open a gap under the band. "No matches" is the distinct
        // filtered-to-zero face: there ARE cards, the filter is hiding them.
        <div
          className="lens-section-empty lens-cards-empty"
          data-testid="lens-cards-empty"
        >
          {dataSource.unfilteredCount() > 0 ? "No matches" : "None"}
        </div>
      ) : (
        <div
          className="lens-cards-list-wrap"
          ref={listWrapRef}
          data-filter-active={filtering ? "true" : undefined}
        >
          <BlockDropCaret ref={caretRef} />
          <CardsCellContext value={cellContext}>
            {/* `inline` is load-bearing, not a preference. `useBlockReorder`
                aborts a drag silently — no error, no log — if any key in the
                visible order has no MOUNTED element, so a windowed list would
                have working reorder above the fold and dead reorder below it. */}
            <TugListView<LensCardsDataSource>
              ref={listRef}
              dataSource={dataSource}
              delegate={delegate}
              cellRenderers={CARDS_CELL_RENDERERS}
              scrollKey="lens-cards"
              inline
              rowLayout="flush"
              focusGroup={hasContent ? host.focusGroup : undefined}
              attachedFilter={sectionAttachedFilter(host.focusGroup)}
              commitOnEnter="act"
              multiSelect={multiSelect}
              initialSelectedIndex={initialSelectedIndex}
              {...LENS_LIST_PRESENTATION}
              className="lens-cards-list"
            />
          </CardsCellContext>
        </div>
      )}
    </div>
  );
}

/** Register the Cards section. Called once at boot from `main.tsx`. */
export function registerCardsSection(): void {
  registerLensSection({
    kind: SECTION_KIND,
    title: "Cards",
    filterable: true,
    glyph: <LayoutGrid size={14} />,
    collapsedSummary: () => <CardsCollapsedSummary />,
    body: (host) => <CardsSectionBody host={host} />,
  });
}
