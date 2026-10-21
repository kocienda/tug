/**
 * session-picker-form — the Choose Session panel's component.
 *
 * Moved out of `session-card.tsx` so the dependency runs one way: the card and
 * its registration reach the picker through `session-picker-panel.tsx`'s
 * factory, and nothing here reaches back.
 *
 * Component-only on purpose — it is a Fast Refresh boundary, and the picker is
 * a surface people edit. The factory that builds it, and the notice mapper it
 * uses, are their own modules for that reason.
 *
 * There is no project step. The panel is one list of sessions grouped by
 * project — the workspace's own projects first and unfolded, the recents after
 * them folded — and the project a session opens in is a consequence of the row
 * picked, never a prior decision: each group carries its own "New session in
 * X" row, and Open names the project it is about to use. A folder the list does
 * not know is the exception, behind one row at the end, which shows a path
 * field while it is chosen. Which groups, which rows, and where a stale
 * selection falls back to are pure functions in `session-picker-groups.ts` and
 * `session-picker-rows.ts`; this component holds the user's choices and draws.
 *
 * Under limited height the list is the one thing that gives: the sheet lays
 * its body out as a column ([`bodyScroll`]), and the list's cap is the room
 * left rather than a fixed height, down to a floor of three rows.
 *
 * @module components/tugways/cards/session-picker-form
 */

import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Trash2 } from "lucide-react";

import { TugFileChooser } from "../tug-file-chooser";
import { TugPushButton } from "../tug-push-button";
import { TugInlineAlert } from "../tug-inline-alert";
import { TugLabel } from "../tug-label";
import {
  TugConfirmPopover,
  type TugConfirmPopoverHandle,
} from "../tug-confirm-popover";
import {
  TugListView,
  type TugListViewDelegate,
  type TugListViewHandle,
} from "../tug-list-view";
import { TugProgressIndicator } from "../tug-progress-indicator";
import { TugFilterField } from "@/components/tugways/tug-filter-field";
import { useAttachedFilter } from "@/components/tugways/attached-filter";
import { useOptionalResponder } from "../use-responder";
import { useFocusManager } from "../use-focusable";
import { rowGridOrder, type SpatialOrder } from "../spatial-order";
import { useSpatialOrder } from "../use-spatial-order";
import type { ActionEvent } from "../responder-chain";
import { TUG_ACTIONS } from "../action-vocabulary";
import { basename } from "@/lib/display-path";
import { logSessionLifecycle } from "@/lib/session-lifecycle-log";
import type { PickerNotice } from "@/lib/picker-notice-store";
import type { CardSessionMode } from "@/lib/card-session-binding-store";
import type { ResumeDisplayMetadata } from "@/lib/session-restore";
import { getTugbankClient } from "@/lib/tugbank-singleton";
import { putSessionRecentProjects } from "@/settings-api";
import { getSessionLedgerStore } from "@/lib/session-ledger-store";
import {
  GROUPED_CELL_RENDERERS,
  GroupedPickerCellProvider,
} from "./session-picker-cells";
import {
  defaultOpenDirs,
  isLiveSessionRow,
  usePickerGroups,
} from "./session-picker-groups";
import {
  effectiveSelection,
  groupOfSelection,
  pickerRowsFrom,
  pickerSelectionOf,
  pickerSelectionRowId,
  usePickerRowsDataSource,
  type PickerSelection,
} from "./session-picker-rows";
import {
  RECENT_PROJECTS_DOMAIN,
  RECENT_PROJECTS_KEY,
  useRecents,
} from "./session-picker-seed";
import { notifyPickerDrawn } from "./session-picker-quiet";
import { notifySheetContentChanged } from "@/components/tugways/tug-sheet";
import { noticeContent } from "./session-picker-notice-content";

export interface SessionProjectPickerFormProps {
  /**
   * Notice surfaced above the form when the picker is re-presented
   * after a session failure (e.g. a resume that didn't take, a
   * canceled restore, or a restore timeout). The notice carries the
   * reason so the user sees it in the same picker that lets them
   * choose what to do next. `null` when the picker is opening fresh.
   */
  notice: PickerNotice | null;
  onOpen: (
    projectDir: string,
    sessionMode: CardSessionMode,
    sessionId: string,
    /**
     * Resume display metadata from the selected ledger row (Spec S03
     * of the resume-performance plan) — what the replay progress
     * affordance can say from t=0. `undefined` for new-mode opens.
     */
    display?: ResumeDisplayMetadata,
  ) => void;
  onCancel: () => void;
  /**
   * Invoked when the user clicks Retry on a notice that carries
   * `staleTugSessionId` + `staleProjectDir`. Re-fires the restore via
   * `fireRestore` — the card flips from picker back to
   * `SessionRestoring` and the whole cycle runs again. `null` on a
   * fresh-picker notice that doesn't carry retry context.
   */
  onRetryRestore: (() => void) | null;
}

/** Stable empty set — the no-groups-toggled value. */
const EMPTY_STRING_SET: ReadonlySet<string> = new Set<string>();

/** The one key a band takes from the picker's default action: Enter folds it. */
const BAND_CAPTURE_KEYS: readonly string[] = ["Enter"];

/**
 * The rows the Sessions list's height floor holds under limited height — a
 * band, a New session row and one session. A list with fewer is shorter than
 * that floor, so it takes none and stands at its own height.
 */
const LIST_FLOOR_ROWS = 3;

/** `formatValue` for the picker's scan-progress bar — "465 of 1,022". */
function formatScanProgressValue(value: number, max: number): string {
  return `${value.toLocaleString()} of ${max.toLocaleString()}`;
}

/**
 * Persistent-cycling focus group for the session picker ([P13] persistent).
 * The picker lives inside a `TugSheet`, which already pushes a trapped engine
 * focus mode (`useFocusTrap`); authoring the picker's controls into this one
 * group makes them stops in that mode's Tab walk, read top to bottom: filter →
 * Sessions → (the other-folder field, while it shows) → Move-all-to-Trash →
 * Cancel → Open. A disabled stop drops out of the walk via the engine's
 * interactive filter.
 *
 * The orders are the stops' focus-keys (`session-picker-cycle:<order>`), a
 * contract the app-tests address by string, so the stops kept from the
 * single-project sheet keep their numbers. The other-folder field sits between
 * Sessions and Trash on screen, so it takes fractional orders there: Browse
 * leads the field, as it does on the line.
 */
const PICKER_CYCLE_GROUP = "session-picker-cycle";
const PICKER_ORDER_FILTER = 1;
const PICKER_ORDER_SESSIONS = 2;
const PICKER_ORDER_BROWSE = 2.25;
const PICKER_ORDER_PATH = 2.5;
const PICKER_ORDER_CHEVRON = 2.75;
const PICKER_ORDER_TRASH_ALL = 3;
const PICKER_ORDER_CANCEL = 4;
const PICKER_ORDER_OPEN = 5;
/** Stable focus-key (`group:order`) of a picker stop. */
const pickerFocusKey = (order: number): string =>
  `${PICKER_CYCLE_GROUP}:${order}`;

/**
 * The Choose Session sheet's arrow order — the sheet's stops laid out as the
 * rows they read as on screen, so Cancel / Open get a real horizontal ring and
 * the list's interior arrows rove its rows, crossing to the row above or below
 * only off the cursor's edge. Every key is a module constant, so the order is
 * too.
 */
const PICKER_SPATIAL_ORDER: SpatialOrder = rowGridOrder([
  [pickerFocusKey(PICKER_ORDER_FILTER)],
  [pickerFocusKey(PICKER_ORDER_SESSIONS)],
  [
    pickerFocusKey(PICKER_ORDER_BROWSE),
    pickerFocusKey(PICKER_ORDER_PATH),
    pickerFocusKey(PICKER_ORDER_CHEVRON),
  ],
  [pickerFocusKey(PICKER_ORDER_TRASH_ALL)],
  [pickerFocusKey(PICKER_ORDER_CANCEL), pickerFocusKey(PICKER_ORDER_OPEN)],
]);

export function SessionProjectPickerForm({
  notice,
  onOpen,
  onCancel,
  onRetryRestore,
}: SessionProjectPickerFormProps) {
  const focusManager = useFocusManager();
  // Declared against the sheet's own trap, read from the enclosing
  // `FocusModeScope`.
  useSpatialOrder(PICKER_SPATIAL_ORDER);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const defaultFocusPlacedRef = useRef(false);
  // The form's outer DOM node — scopes the trash popover's anchor lookup to
  // the picker's own subtree.
  const formRootRef = useRef<HTMLDivElement | null>(null);
  const formResponderId = useId();

  // The folder typed behind the other-folder row. While it is non-empty it is
  // a group of its own, last in the list and unfolded, so what it already
  // holds is in view before a session is started there.
  const [typedPath, setTypedPath] = useState("");
  const typedDir = typedPath.trim();

  // External state via `useSyncExternalStore` ([L02]): the workspace's bound
  // projects, the recents, and every group's listing.
  const groups = usePickerGroups(typedDir);
  const recents = useRecents();

  // Which groups are unfolded: the workspace's (or the first group, when no
  // card is bound) and the typed folder, each flipped by the user's toggles.
  // Derived at render rather than seeded into state, so the first render — the
  // one the arriving card measures — already has the right groups open.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(EMPTY_STRING_SET);
  const defaultOpen = useMemo(() => new Set(defaultOpenDirs(groups)), [groups]);
  const isExpanded = useCallback(
    (dir: string): boolean =>
      (defaultOpen.has(dir) || dir === typedDir) !== toggled.has(dir),
    [defaultOpen, typedDir, toggled],
  );
  const toggleGroup = useCallback((dir: string): void => {
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  }, []);

  // The filter field's query — transient local UI state, never persisted.
  const [filterQuery, setFilterQuery] = useState("");

  const rows = useMemo(
    () => pickerRowsFrom(groups, isExpanded, filterQuery),
    [groups, isExpanded, filterQuery],
  );
  const dataSource = usePickerRowsDataSource(rows);

  // The user's pick, and the one Open acts on: the pick while the list still
  // shows it, else the nearest row that it does ([Spec S03]'s snap-back, as a
  // derivation rather than an effect writing state back).
  const [chosen, setChosen] = useState<PickerSelection | null>(null);
  const selection = effectiveSelection(rows, chosen);
  const selectedRowId = selection === null ? null : pickerSelectionRowId(selection);
  const selectedGroup = groupOfSelection(groups, selection);
  const typedGroup = groups.find((g) => g.projectDir === typedDir) ?? null;

  // The listing frame this render drew is in the DOM once this runs, and
  // nothing before it can say so: the store's tick precedes the render, and the
  // sheet's `ResizeObserver` follows it by a frame. So this is where the sheet
  // is asked to re-measure and the deck is told the picker has drawn — the
  // ready callback of [L04] ([L03]: a layout effect, so it lands before paint).
  //
  // The list's ROWS are the exception: the data source is told of new rows
  // from a layout effect, so the list redraws them in the commit after this
  // one. The list says when it has — `onRenderedRangeChange` fires from its
  // own layout effect once the new window is in the DOM, and the row count is
  // part of what it compares — so the same two calls ride that too. Without
  // it the sheet measures the rows the list has not drawn yet, and once the
  // panel stands at its cap no box moves when they land: the claim sticks at
  // the capped height, short of what the picker wants.
  const pickerDrew = useCallback((): void => {
    const root = formRootRef.current;
    if (root !== null) notifySheetContentChanged(root);
    notifyPickerDrawn();
  }, []);
  useLayoutEffect(() => {
    pickerDrew();
  }, [rows, pickerDrew]);

  // Re-validate each group's listing once per picker open. The ledger store
  // fetches a path once per connection, and terminal sessions and other
  // out-of-band JSONL writers push nothing — without this a list freezes at
  // whatever the first open saw. Stale-while-revalidate: cached rows stay on
  // screen while the scan runs ([L02] — the store owns the state; this is an
  // event kick, not a state mirror).
  const refreshedDirsRef = useRef<Set<string>>(new Set());
  useLayoutEffect(() => {
    const store = getSessionLedgerStore();
    if (store === null) return;
    for (const group of groups) {
      if (refreshedDirsRef.current.has(group.projectDir)) continue;
      refreshedDirsRef.current.add(group.projectDir);
      store.refresh(group.projectDir);
    }
  }, [groups]);

  // ---- Trash: one session ----
  //
  // The per-row trash button dispatches `request-trash-session` with
  // `{ sessionId }` through the chain; the handler below sets the pending id,
  // and one anchored `TugConfirmPopover` confirms ([D14]).
  const findSessionRow = useCallback(
    (sessionId: string) => {
      for (const group of groups) {
        const row = group.listed.find((r) => r.session_id === sessionId);
        if (row !== undefined) return { group, row };
      }
      return null;
    },
    [groups],
  );

  const trashSession = useCallback(
    (sessionId: string): void => {
      const store = getSessionLedgerStore();
      if (store === null) return;
      const found = findSessionRow(sessionId);
      // Live-in-Tug and terminal-live rows are untrashable (the cell hides the
      // control; this is the defensive backstop — the supervisor refuses both).
      if (found === null || isLiveSessionRow(found.row)) return;
      // Always pass the project dir: external rows (no ledger row server-side)
      // need it to locate the JSONL; ledger rows ignore it.
      void store.trashSession(sessionId, found.row.project_dir);
      setChosen((prev) =>
        prev?.kind === "session-resume" && prev.sessionId === sessionId
          ? { kind: "session-new", projectDir: found.group.projectDir }
          : prev,
      );
    },
    [findSessionRow],
  );

  const [pendingTrashSessionId, setPendingTrashSessionId] = useState<
    string | null
  >(null);
  const [pendingTrashAnchorEl, setPendingTrashAnchorEl] =
    useState<HTMLElement | null>(null);

  // Resolve the pending row's trash button as the popover's anchor, inside
  // this form's own subtree: the row's `data-session-id` plus the button's
  // `data-slot` survive reordering and virtualization recycle.
  useLayoutEffect(() => {
    if (pendingTrashSessionId === null) {
      setPendingTrashAnchorEl(null);
      return;
    }
    const root = formRootRef.current;
    if (root === null) return;
    const escaped =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(pendingTrashSessionId)
        : pendingTrashSessionId;
    const selector = `[data-session-id="${escaped}"] [data-slot="tug-icon-button"]`;
    setPendingTrashAnchorEl(root.querySelector<HTMLElement>(selector) ?? null);
  }, [pendingTrashSessionId]);

  // The chain's `request-trash-session`, narrowed defensively ([L07]).
  const handleRequestTrashSession = useCallback((event: ActionEvent) => {
    const v = event.value;
    if (
      v !== null &&
      typeof v === "object" &&
      "sessionId" in v &&
      typeof (v as { sessionId: unknown }).sessionId === "string"
    ) {
      setPendingTrashSessionId((v as { sessionId: string }).sessionId);
    }
  }, []);

  // The TOLERANT form ([P09]): a render outside the chain — a fixture, a
  // gallery — draws the picker rather than throwing out of it.
  const {
    ResponderScope: PickerFormResponderScope,
    responderRef: pickerFormResponderRef,
  } = useOptionalResponder({
    id: formResponderId,
    actions: {
      [TUG_ACTIONS.REQUEST_TRASH_SESSION]: handleRequestTrashSession,
    },
  });

  // The form's root carries both the responder's `data-responder-id` and our
  // own `formRootRef`.
  const setFormRootRef = useCallback(
    (el: HTMLDivElement | null): void => {
      formRootRef.current = el;
      pickerFormResponderRef(el);
    },
    [pickerFormResponderRef],
  );

  const handleConfirmTrash = useCallback(() => {
    if (pendingTrashSessionId !== null) trashSession(pendingTrashSessionId);
    setPendingTrashSessionId(null);
  }, [pendingTrashSessionId, trashSession]);

  const handleCancelTrash = useCallback(() => {
    setPendingTrashSessionId(null);
  }, []);

  // ---- Remove a recent project ----
  //
  // A recent project's band carries a remove button; its click hands this form
  // the button as the confirm's anchor, through the cell context.
  const [pendingRemoveDir, setPendingRemoveDir] = useState<string | null>(null);
  const [pendingRemoveAnchorEl, setPendingRemoveAnchorEl] =
    useState<HTMLElement | null>(null);

  const requestRemoveRecent = useCallback(
    (dir: string, anchor: HTMLElement): void => {
      setPendingRemoveDir(dir);
      setPendingRemoveAnchorEl(anchor);
    },
    [],
  );

  // Optimistically update the tugbank cache (so the list re-renders at once),
  // then persist.
  const removeRecent = useCallback(
    (dir: string): void => {
      const next = recents.filter((p) => p !== dir);
      getTugbankClient()?.setLocalValue(RECENT_PROJECTS_DOMAIN, RECENT_PROJECTS_KEY, {
        kind: "json",
        value: { paths: next },
      });
      putSessionRecentProjects(next);
    },
    [recents],
  );

  const handleConfirmRemove = useCallback(() => {
    if (pendingRemoveDir !== null) removeRecent(pendingRemoveDir);
    setPendingRemoveDir(null);
    setPendingRemoveAnchorEl(null);
  }, [pendingRemoveDir, removeRecent]);

  const handleCancelRemove = useCallback(() => {
    setPendingRemoveDir(null);
    setPendingRemoveAnchorEl(null);
  }, []);

  // ---- Trash: every session in the selection's project ----
  const trashAll = useCallback((): void => {
    const store = getSessionLedgerStore();
    if (store === null || selectedGroup === null) return;
    let any = false;
    for (const row of selectedGroup.listed) {
      if (isLiveSessionRow(row)) continue;
      void store.trashSession(row.session_id, selectedGroup.projectDir);
      any = true;
    }
    if (any) {
      setChosen({ kind: "session-new", projectDir: selectedGroup.projectDir });
    }
  }, [selectedGroup]);

  const trashAllConfirmRef = useRef<TugConfirmPopoverHandle>(null);
  const handleTrashAllClick = useCallback(async (): Promise<void> => {
    const ok = await trashAllConfirmRef.current?.confirm();
    if (ok === true) trashAll();
  }, [trashAll]);

  // ---- Where Open goes ----
  const openDir =
    selection === null
      ? ""
      : selection.kind === "other"
        ? typedDir
        : selection.projectDir;
  const openGroup = selection?.kind === "other" ? typedGroup : selectedGroup;
  const dirMissing = openGroup?.status === "missing";
  const openDisabled = openDir === "" || dirMissing;
  const openName = openDir === "" ? "" : (openGroup?.name ?? basename(openDir));

  const submit = useCallback((): void => {
    if (selection === null || openDisabled) return;
    let mode: CardSessionMode = "new";
    let sessionId: string = crypto.randomUUID();
    let resumeCandidateId: string | null = null;
    let display: ResumeDisplayMetadata | undefined;
    if (selection.kind === "session-resume") {
      resumeCandidateId = selection.sessionId;
      const found = findSessionRow(selection.sessionId);
      if (found !== null && !isLiveSessionRow(found.row)) {
        mode = "resume";
        sessionId = found.row.session_id;
        display = {
          title: found.row.name ?? found.row.last_user_prompt ?? null,
          turnCount: found.row.turn_count,
        };
      }
    }
    logSessionLifecycle("picker.submit", {
      project_dir: openDir,
      session_mode: mode,
      session_id: sessionId,
      resume_candidate_id: resumeCandidateId,
    });
    onOpen(openDir, mode, sessionId, display);
  }, [selection, openDisabled, openDir, findSessionRow, onOpen]);

  // ---- The list ----
  const delegate = useMemo<TugListViewDelegate>(
    () => ({
      // A single-select list commits as its cursor lands, so this is both the
      // click and the arrow. A band's click never reaches here — the band
      // swallows it to fold — so a band is picked only by the cursor resting
      // on it, which reads as "this project".
      onSelect: (index) => {
        const next = pickerSelectionOf(dataSource.rowAt(index));
        if (next !== null) setChosen(next);
      },
    }),
    [dataSource],
  );

  // Enter on a band folds or unfolds it, as a disclosure row's does. The list
  // captures Enter only while a band is the selection; on every other row it
  // falls through to the picker's default action, Open.
  const onBand = selection?.kind === "group";
  const handleListKey = useCallback(
    (event: KeyboardEvent): boolean => {
      if (event.key !== "Enter" || selection?.kind !== "group") return false;
      toggleGroup(selection.projectDir);
      return true;
    },
    [selection, toggleGroup],
  );

  const cellContextValue = useMemo(
    () => ({
      selectedRowId,
      pendingTrashSessionId,
      pendingRemoveDir,
      filterQuery,
      onToggleGroup: toggleGroup,
      onRemoveRecent: requestRemoveRecent,
    }),
    [
      selectedRowId,
      pendingTrashSessionId,
      pendingRemoveDir,
      filterQuery,
      toggleGroup,
      requestRemoveRecent,
    ],
  );

  // The filter field reports each keystroke and cursors the list from the caret
  // ([P08]); Escape and Enter are the field's and the picker's own.
  const pickerListRef = useRef<TugListViewHandle>(null);
  const pickerFilter = useAttachedFilter(() => pickerListRef.current);
  const filterDelegate = useMemo(
    () => ({
      filterFieldDidChangeQuery: setFilterQuery,
      ...pickerFilter.delegate,
    }),
    [pickerFilter],
  );

  // The scan hint speaks for the groups that are open: a folded group's scan
  // changes its count, not what the reader is looking at.
  const scanningGroup =
    groups.find((g) => g.scanning && isExpanded(g.projectDir)) ?? null;

  const trashable = selectedGroup?.trashable ?? 0;
  const trashAllLabel =
    selectedGroup === null
      ? "Move all sessions to Trash"
      : `Move all sessions in ${selectedGroup.name} to Trash`;
  // The list omits prompt-free sessions, but the sweep takes every session in
  // the project — so the tooltip names both halves.
  const trashAllTooltip =
    trashable > 0
      ? `${trashable} ${trashable === 1 ? "session" : "sessions"}, plus all empty sessions`
      : "All empty sessions";

  // Default focus ([P12]): the key view rests on the Sessions list the moment
  // it has a row, its cursor on the selection — the first group's New session
  // row — so one Return opens a new session in the workspace's project. The
  // seed is the engine KEY VIEW, not a bare `.focus()`, so the focus engine
  // stays the single owner ([P13]); placed once ([L03]: before paint).
  const hasRows = rows.length > 0;
  useLayoutEffect(() => {
    if (focusManager === null || defaultFocusPlacedRef.current || !hasRows) return;
    defaultFocusPlacedRef.current = true;
    focusManager.place(
      null,
      { kind: "focus-key", focusKey: pickerFocusKey(PICKER_ORDER_SESSIONS) },
      { modality: "keyboard" },
    );
  }, [hasRows, focusManager]);

  return (
    <PickerFormResponderScope>
      <div ref={setFormRootRef} className="session-card-picker-form">
        {notice !== null &&
          (() => {
            const content = noticeContent(notice);
            return (
              <div
                data-testid="session-card-picker-notice"
                data-notice-category={notice.category}
              >
                <TugInlineAlert
                  title={content.title}
                  message={content.message}
                  tone={content.tone}
                  icon={content.icon}
                  live="alert"
                  actions={
                    onRetryRestore !== null ? (
                      <TugPushButton
                        emphasis="outlined"
                        role={content.tone === "danger" ? "danger" : "action"}
                        onClick={onRetryRestore}
                        data-testid="session-card-picker-notice-retry"
                      >
                        Retry
                      </TugPushButton>
                    ) : undefined
                  }
                />
              </div>
            );
          })()}
        <GroupedPickerCellProvider value={cellContextValue}>
          <div className="session-card-picker-section">
            <span className="session-card-picker-label">
              Sessions
              {scanningGroup !== null ? (
                <span
                  className="session-card-picker-scanning"
                  role="status"
                  aria-live="polite"
                  data-testid="session-card-picker-scanning"
                >
                  {scanningGroup.scanProgress !== undefined &&
                  scanningGroup.scanProgress.total > 0 ? (
                    <TugProgressIndicator
                      variant="bar"
                      size={6}
                      role="action"
                      state="running"
                      label="Scanning…"
                      glyphPosition="right"
                      value={Math.min(
                        scanningGroup.scanProgress.parsed,
                        scanningGroup.scanProgress.total,
                      )}
                      max={scanningGroup.scanProgress.total}
                      showValue
                      formatValue={formatScanProgressValue}
                      className="session-card-picker-scanning-bar"
                      aria-label="Scanning sessions"
                    />
                  ) : (
                    "scanning sessions…"
                  )}
                </span>
              ) : null}
              <TugFilterField
                className="session-card-picker-filter"
                delegate={filterDelegate}
                attachment={pickerFilter}
                placeholder="Filter sessions"
                data-testid="session-card-picker-filter"
                focusGroup={PICKER_CYCLE_GROUP}
                focusOrder={PICKER_ORDER_FILTER}
              />
            </span>
            <div
              className="session-card-picker-sessions-host"
              data-sparse={rows.length < LIST_FLOOR_ROWS ? "true" : undefined}
            >
              {hasRows ? (
                <TugListView
                  ref={pickerListRef}
                  dataSource={dataSource}
                  delegate={delegate}
                  cellRenderers={GROUPED_CELL_RENDERERS}
                  scrollKey="session-card-picker-sessions"
                  rowLayout="flush"
                  className="session-card-picker-sessions-list session-card-picker-list-view"
                  focusGroup={PICKER_CYCLE_GROUP}
                  focusOrder={PICKER_ORDER_SESSIONS}
                  attachedFilter={pickerFilter}
                  singleSelect
                  initialSelectedIndex={
                    selectedRowId === null
                      ? undefined
                      : dataSource.indexOfId(selectedRowId)
                  }
                  captureKeys={onBand ? BAND_CAPTURE_KEYS : undefined}
                  onKeyViewKey={handleListKey}
                  onRenderedRangeChange={pickerDrew}
                />
              ) : (
                <div
                  className="session-card-picker-empty"
                  data-testid="session-card-picker-sessions-empty"
                >
                  No sessions match
                </div>
              )}
            </div>
            {selection?.kind === "other" ? (
              <label className="session-card-picker-field">
                <span className="session-card-picker-label">Folder</span>
                <TugFileChooser
                  ref={inputRef}
                  value={typedPath}
                  onChange={setTypedPath}
                  base={typedDir !== "" ? typedDir : "/"}
                  kind="directory"
                  onSubmit={submit}
                  placeholder="/path/to/project"
                  focusGroup={PICKER_CYCLE_GROUP}
                  focusOrder={PICKER_ORDER_PATH}
                  browseFocusOrder={PICKER_ORDER_BROWSE}
                  chevronFocusOrder={PICKER_ORDER_CHEVRON}
                />
              </label>
            ) : null}
            <div
              className="session-card-picker-trash-all"
              data-disabled={trashable === 0 ? "true" : undefined}
              title={trashAllTooltip}
            >
              <TugLabel
                emphasis="proposal"
                data-testid="session-card-picker-trash-all-label"
              >
                {trashAllLabel}
              </TugLabel>
              <TugConfirmPopover
                ref={trashAllConfirmRef}
                message={
                  trashable > 1 ? "Move all sessions to Trash?" : "Move to Trash?"
                }
                confirmLabel="Trash"
                confirmRole="danger"
                side="top"
              >
                <TugPushButton
                  subtype="icon"
                  emphasis="ghost"
                  role="danger"
                  icon={<Trash2 size={16} aria-hidden="true" />}
                  onClick={handleTrashAllClick}
                  disabled={trashable === 0}
                  aria-label={trashAllLabel}
                  data-testid="session-card-picker-trash-all"
                  focusGroup={PICKER_CYCLE_GROUP}
                  focusOrder={PICKER_ORDER_TRASH_ALL}
                />
              </TugConfirmPopover>
            </div>
          </div>
        </GroupedPickerCellProvider>
        <div className="tug-sheet-actions">
          {dirMissing && (
            <TugLabel
              className="session-card-picker-dir-warning"
              emphasis="calm"
              data-testid="session-card-picker-dir-warning"
            >
              {"Directory doesn't exist"}
            </TugLabel>
          )}
          <TugPushButton
            size="sm"
            emphasis="outlined"
            role="action"
            onClick={onCancel}
            focusGroup={PICKER_CYCLE_GROUP}
            focusOrder={PICKER_ORDER_CANCEL}
          >
            Cancel
          </TugPushButton>
          <TugPushButton
            size="sm"
            emphasis="primary"
            role="action"
            onClick={submit}
            disabled={openDisabled}
            focusGroup={PICKER_CYCLE_GROUP}
            focusOrder={PICKER_ORDER_OPEN}
            persistentDefaultRing
            data-testid="session-card-picker-open"
          >
            {openName === "" ? "Open" : `Open in ${openName}`}
          </TugPushButton>
        </div>
        {/* One confirm for the per-row trash, anchored to the requesting row's
            trash button ([D14]). */}
        <TugConfirmPopover
          open={pendingTrashSessionId !== null}
          anchorEl={pendingTrashAnchorEl}
          message="Move to Trash?"
          confirmLabel="Trash"
          confirmRole="danger"
          side="left"
          onConfirm={handleConfirmTrash}
          onCancel={handleCancelTrash}
        />
        {/* One confirm for removing a recent project, anchored to its band's
            remove button. */}
        <TugConfirmPopover
          open={pendingRemoveDir !== null}
          anchorEl={pendingRemoveAnchorEl}
          message={
            pendingRemoveDir !== null
              ? `Remove ${pendingRemoveDir} from recent projects?`
              : "Remove from recent projects?"
          }
          confirmLabel="Remove"
          confirmRole="danger"
          side="left"
          onConfirm={handleConfirmRemove}
          onCancel={handleCancelRemove}
        />
      </div>
    </PickerFormResponderScope>
  );
}
