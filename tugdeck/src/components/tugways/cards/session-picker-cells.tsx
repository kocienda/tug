/**
 * session-picker-cells.tsx — cell renderers for the Dev picker's Sessions
 * `TugListView`.
 *
 * Each renderer is a `TugListViewCellRenderer<...>` that takes the
 * typed row payload from `dataSource.rowAt(p.index)` and paints the
 * visual treatment. **Cells are pure render functions** per
 * [tugplan-session-picker-redesign §D17](
 * ../../../arc/tugplan-session-picker-redesign.md#d17-pure-renderer-rule):
 * no `useState`, no `useRef`, no `useEffect` / `useLayoutEffect`, no
 * `useImperativeHandle`. Selection state and the confirmation flow live above
 * the list — in `SessionProjectPickerForm`, the chain responder. The cells read
 * what they need through `PickerCellContext`. (The recent project paths are no
 * longer a list here — they seed the path combo box's dropdown in
 * `session-card.tsx`.)
 *
 * Sessions cells:
 *  - `session-new` — single-row "New session". Selected when
 *    the picker's selection is `{ kind: "session-new" }`.
 *  - `session-resume` — rich row layout with snippet + subtitle +
 *    trailing trash `TugIconButton` (non-live) or live/failed
 *    badge. The row carries `data-session-id={session_id}` so the
 *    form's anchor-resolution layout effect can find this row's
 *    trash icon when the user requests to trash it.
 *  - `loading` — "checking…" placeholder. Inert.
 *
 * Click semantics:
 *  - All non-disabled cells route through the wrapper's onClick to
 *    `delegate.onSelect` (the form's delegate updates the session selection).
 *  - The trash control is a click-focus-refusing `TugIconButton` per
 *    [D16], authored into its row's focus scope
 *    (`PICKER_ROW_TRASH_FOCUS_GROUP`) so ArrowRight on the row
 *    descends onto it. Its activation dispatches
 *    `request-trash-session` with `{ sessionId }` payload via
 *    `useControlDispatch()` to the form responder. The form sets
 *    pending-id state which drives a single anchored
 *    `TugConfirmPopover`. The cell knows nothing about the
 *    confirmation UI.
 *
 * Laws:
 *  - [L02] external state via `useSyncExternalStore` — the data
 *    source supplies rows via `useSyncExternalStore` at the
 *    `TugListView` level; cells just render.
 *  - [L06] visual-state changes via DOM attributes (`data-selected`,
 *    `data-disabled`, `data-state`) and CSS, not React state on the
 *    cell side.
 *  - [L11] controls emit actions; the trash button dispatches a chain
 *    action (no callback into context).
 *  - [L19] component authoring guide.
 *  - [L20] tokens scoped under `.session-card-picker-list-view*` in
 *    `session-card.css`.
 *
 * Decisions:
 *  - tugplan-session-picker-redesign [D02] role-flat-list (cell-only —
 *    headers are JSX, footers are buttons),
 *    [D14] no per-cell floating surfaces,
 *    [D16] trailing in-list actions use TugIconButton,
 *    [D17] pure-renderer rule for cells.
 */

import React, { createContext, useContext } from "react";
import { Trash2 } from "lucide-react";

import { TugBadge } from "@/components/tugways/tug-badge";
import { TugIconButton } from "@/components/tugways/tug-icon-button";
import type {
  TugListViewCellProps,
  TugListViewCellRenderer,
} from "@/components/tugways/tug-list-view";
import { TugListRow } from "@/components/tugways/tug-list-row";
import { SessionIdentityRow } from "@/components/tugways/session-identity-row";
import { TUG_SESSION_ROW_STACK_DOT_SIZE } from "@/components/tugways/tug-session-row";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";

import type {
  SessionsRow,
  SessionsDataSource,
} from "@/lib/session-picker-data-source";
import { formatFailedRowSubtitle } from "./session-picker-format";
import {
  sessionIdentityContextFrom,
  useSessionIdentity,
} from "@/lib/session-identity";

// ---------------------------------------------------------------------------
// Row-accessory focus authoring
// ---------------------------------------------------------------------------

/**
 * Focus group for the per-row trash buttons. The cells render inside
 * `TugListView`'s per-row `FocusModeContext`, so each button registers
 * into its own row's descend scope — the mode, not this group, scopes
 * the walk; the shared constant is just the within-row ordering. The
 * buttons are reachable only by descending (ArrowRight) onto the row,
 * never via the picker's Tab cycle.
 */
const PICKER_ROW_TRASH_FOCUS_GROUP = "picker-row-trash";

// ---------------------------------------------------------------------------
// Selection type + context
// ---------------------------------------------------------------------------

/**
 * The picker's session selection. Owned by the picker form as
 * `useState<PickerSelection | null>`. The Recents list does NOT carry
 * a selection state here — it runs in `TugListView`'s
 * `selectionRequired` mode, so the list view owns the selected recent
 * and marks the row wrapper with `data-selected="true"`.
 */
export type PickerSelection =
  | { readonly kind: "session-new" }
  | { readonly kind: "session-resume"; readonly sessionId: string };

interface PickerCellContextValue {
  /** Current session selection. `null` when no session row is selected. */
  readonly selection: PickerSelection | null;
  /**
   * Session id whose trash-confirmation popover is currently open
   * (driven by the form's `pendingTrashSessionId` state). The
   * matching row marks itself with `data-pending-trash="true"` so
   * its trash icon stays visible AND highlighted while the popover
   * is up — Mac-menu-open style. `null` when no trash is pending.
   */
  readonly pendingTrashSessionId: string | null;
  /**
   * The live filter query, so a row can paint the spans that kept it. Empty
   * string when the surface has no filter field, or when its field is empty —
   * either way the rows render exactly as they did before filtering existed.
   */
  readonly filterQuery: string;
}

const NULL_CONTEXT: PickerCellContextValue = {
  selection: null,
  pendingTrashSessionId: null,
  filterQuery: "",
};

const PickerCellContext = createContext<PickerCellContextValue>(NULL_CONTEXT);

/** Provider component for the picker form to wrap its list views. */
export const PickerCellProvider = PickerCellContext.Provider;

function usePickerCellContext(): PickerCellContextValue {
  return useContext(PickerCellContext);
}

// ---------------------------------------------------------------------------
// Sessions cells — session-new, session-resume, loading
// ---------------------------------------------------------------------------

export const SessionNewCell: TugListViewCellRenderer<SessionsDataSource> =
  () => {
    const { selection } = usePickerCellContext();
    const isSelected = selection?.kind === "session-new";
    return (
      <TugListRow
        title="New session"
        selected={isSelected}
        data-testid="session-card-picker-session-new"
      />
    );
  };

export const SessionResumeCell: TugListViewCellRenderer<SessionsDataSource> = ({
  index,
  dataSource,
}: TugListViewCellProps<SessionsDataSource>) => {
  const { selection, pendingTrashSessionId, filterQuery } =
    usePickerCellContext();
  const data = dataSource.rowAt(index) as Extract<
    SessionsRow,
    { kind: "session-resume" }
  >;
  const row = data.row;
  const isLive = row.state === "live";
  const isFailed = row.state === "failed";
  // A session currently held by a live process outside this Tug — the
  // Claude Code terminal app, another instance. Unresumable and
  // untrashable until that process exits (the supervisor hard-refuses
  // both); the row renders disabled with an "in use" badge.
  const isTerminalLive = row.terminal_live !== null;
  const isSelected =
    selection?.kind === "session-resume" &&
    selection.sessionId === row.session_id;
  // While a trash-confirmation popover is pending FOR THIS ROW, the
  // row marks itself so CSS can keep the trash icon visible AND
  // highlighted (Mac-menu-open style). Pure render derivation from
  // the context value — no per-cell state.
  const isPendingTrash = pendingTrashSessionId === row.session_id;

  // The title leads with the user's own name when there is one, then the
  // callsign — the same grammar every other surface in the app shows for this
  // session. A legacy tagless row degrades to its short id, never the raw UUID.
  // Resolved here as well as inside the row because the trash control's labels
  // name the session by its short id; the row resolves its own from the same
  // hook and the same context, so the two cannot be two records.
  const identity = useSessionIdentity(
    row.session_id,
    sessionIdentityContextFrom(row),
  );

  // What the activity line says INSTEAD of anything the digest feed could
  // report. Both cases are rows this app cannot see into: a terminal holds no
  // feed, and a failed row's one fact is the failure. Everything else is the
  // shared row's ladder: for a row live in this app, what the Observer posted
  // during a turn and the ask before its first post; otherwise the rest
  // sentence. The digest's newest line is no rung of it on any surface — a
  // beat of the "Editing foo.ts, 37 lines" kind is too low-level to tell one
  // session from another, which is as true in a list to pick from as it is on
  // the masthead.
  const activityOverride = isTerminalLive
    ? row.terminal_live?.status === "busy"
      ? "In use in a terminal — busy"
      : row.terminal_live?.status === "idle"
        ? "In use in a terminal — idle"
        : "In use in a terminal"
    : isFailed
      ? formatFailedRowSubtitle(row)
      : null;

  const idShort = identity.shortId;

  // Trailing accessory: a live/in-use/failed status badge, a
  // provenance badge for terminal-created sessions, a trash action, or
  // a combination (a failed row can still be trashed). The trash
  // reveals on row engagement (hover, focus-within, selected, keyboard
  // cursor) for the plain case; when a badge is present the trailing
  // stays visible. An in-use row shows only the "in use" badge — the
  // subtitle already says where it's in use, so a second provenance
  // badge would be noise.
  const badge = isLive ? (
    <TugBadge emphasis="tinted" role="action">
      live
    </TugBadge>
  ) : isTerminalLive ? (
    <TugBadge emphasis="tinted" role="action">
      in use
    </TugBadge>
  ) : isFailed ? (
    <TugBadge emphasis="tinted" role="danger">
      failed
    </TugBadge>
  ) : row.origin === "external" ? (
    <TugBadge emphasis="tinted" role="data">
      terminal
    </TugBadge>
  ) : null;
  const trash = !isLive && !isTerminalLive ? (
    <TugIconButton
      icon={<Trash2 size={14} aria-hidden="true" />}
      aria-label={`Move session ${idShort} to Trash`}
      title={`Move session ${idShort} to Trash`}
      tone="danger"
      className="session-card-picker-session-trash"
      focusGroup={PICKER_ROW_TRASH_FOCUS_GROUP}
      focusOrder={0}
      dispatch={{
        action: TUG_ACTIONS.REQUEST_TRASH_SESSION,
        value: { sessionId: row.session_id },
        phase: "discrete",
      }}
    />
  ) : null;
  const trailing =
    badge !== null || trash !== null ? (
      <>
        {badge}
        {trash}
      </>
    ) : undefined;

  // The row carries `data-session-id` so the form's anchor-resolution
  // layout effect can locate this row's trash button (a descendant
  // `[data-slot="tug-icon-button"]`) when the user dispatches
  // `request-trash-session` — see `session-card.tsx` `pendingTrashAnchorEl`.
  // Highlights are computed against the strings this row actually RENDERS —
  // each already truncated and composed — so the paint lands on the right
  // characters. A row that matched on a field it does not display (its id, a
  // long prompt tail) shows no mark, which is correct.
  return (
    <SessionIdentityRow
      // Title, description, activity. The same component the Cards card and the
      // masthead wear — three surfaces showing the same thing had no business
      // showing it three ways.
      //
      // Every row gets a dot, including the closed ones — which is most of
      // them. A session whose live state cannot be reached reads idle, so the
      // dot is quiet rather than absent or red, and the column of marks says
      // which rows are working without saying anything false about the rest.
      className="session-card-picker-session-row"
      sessionId={row.session_id}
      identityContext={sessionIdentityContextFrom(row)}
      // The picker browses a whole workspace and already holds every row, so
      // the description's prompt rung and the activity's rest facts come off
      // the payload in hand rather than out of a second read by id.
      row={row}
      // The dense cut — this is a list to pick FROM, not a monitor, so it takes
      // the small dot, no tape, and its sub-lines flush with the title. A row
      // reserving width for a graph it does not draw is width taken from the
      // text for nothing. No `drift`: a picker's dots are read as a column, not
      // watched.
      dotSize={TUG_SESSION_ROW_STACK_DOT_SIZE}
      subAlign="title"
      tape={false}
      // A dense list's line is scanned, not read, so it takes the newest fact
      // rather than a paced one — and a `TugListView` cell may hold no state
      // anyway ([D17]).
      pace={false}
      // Only a row live in THIS app has a feed to read. `latestBeatForScope`
      // answers with app-wide ambience for any scope, so a closed session's row
      // would otherwise narrate whatever the app happened to be saying.
      beats={isLive}
      // A list to resume FROM has no turn in flight from its reader's point of
      // view, so the description keeps the through-line always ([B03]): what
      // a live row's turn is currently on would tell it apart from its
      // neighbours less well, not better.
      currency={false}
      activityOverride={activityOverride}
      // A browse list of external sessions is where a runaway first prompt
      // actually lands, so the description is bounded in text as well as by the
      // line's own ellipsis.
      descriptionMaxChars={96}
      highlight={filterQuery}
      selected={isSelected}
      disabled={isLive || isTerminalLive}
      trailing={trailing}
      trailingReveal={badge !== null ? "always" : "engaged"}
      data-testid="session-card-picker-session-resume"
      data-state={row.state}
      data-origin={row.origin}
      data-terminal-live={isTerminalLive ? "true" : undefined}
      data-session-id={row.session_id}
      data-pending-trash={isPendingTrash ? "true" : undefined}
    />
  );
};

export const LoadingCell: TugListViewCellRenderer<SessionsDataSource> = () => (
  <div
    className="session-card-picker-pending-placeholder"
    data-testid="session-card-picker-pending-placeholder"
    role="status"
    aria-live="polite"
  >
    checking…
  </div>
);

export const SESSIONS_CELL_RENDERERS: Record<
  string,
  TugListViewCellRenderer<SessionsDataSource>
> = {
  "session-new": SessionNewCell,
  "session-resume": SessionResumeCell,
  "loading": LoadingCell,
};
