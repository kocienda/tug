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
 * @module components/tugways/cards/session-picker-form
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { AlertTriangle, Trash2 } from "lucide-react";

import { TugFileChooser } from "../tug-file-chooser";
import type { TugComboBoxItem } from "../tug-combo-box";
import { TugIconButton } from "../tug-icon-button";
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
import { caseInsensitiveSubstring } from "@/lib/text-match";
import { logSessionLifecycle } from "@/lib/session-lifecycle-log";
import type { PickerNotice } from "@/lib/picker-notice-store";
import type { CardSessionMode } from "@/lib/card-session-binding-store";
import type { ResumeDisplayMetadata } from "@/lib/session-restore";
import { getTugbankClient } from "@/lib/tugbank-singleton";
import { useTugbankValue } from "@/lib/use-tugbank-value";
import { useHostFacts } from "@/lib/host-facts-store";
import { probeDirExistence } from "@/lib/dir-existence";
import {
  putSessionRecentProjects,
  DEFAULT_PROJECT_PATH_DOMAIN,
  DEFAULT_PROJECT_PATH_KEY,
} from "@/settings-api";
import {
  useSessionLedger,
  getSessionLedgerStore,
} from "@/lib/session-ledger-store";
import { useSessionsDataSource } from "@/lib/session-picker-data-source";
import {
  PickerCellProvider,
  SESSIONS_CELL_RENDERERS,
  type PickerSelection,
} from "./session-picker-cells";
import { parseRecents, parseString, seedPathFrom } from "./session-picker-seed";
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

/** One entry in the sessions record. */
interface SessionRecord {
  sessionId: string;
  projectDir: string;
  createdAt: number;
}

/** Stable `[]` reference — useTugbankValue's `fallback` must be reference-stable. */
const EMPTY_STRING_ARRAY: ReadonlyArray<string> = [];

/** Stable empty set — the initial / no-missing-recents value. */
const EMPTY_STRING_SET: ReadonlySet<string> = new Set<string>();

/** `formatValue` for the picker's scan-progress bar — "465 of 1,022". */
function formatScanProgressValue(value: number, max: number): string {
  return `${value.toLocaleString()} of ${max.toLocaleString()}`;
}


/**
 * Persistent-cycling focus group for the session picker ([P13] persistent —
 * [#step-picker-keys]). The picker lives inside a `TugSheet`, which already
 * pushes a trapped engine focus mode (`useFocusTrap`); authoring the picker's
 * controls into this one group makes them stops in that mode's Tab walk, read
 * top-to-bottom: path combo box → Sessions → Move-all-to-Trash → Cancel → Open.
 * There is no toggle — the sheet's mode IS the picker's base mode (unlike the
 * connected card's toggleable ⌥⇥ cycle). A not-ready Sessions list and a
 * disabled stop (Move-all-to-Trash with nothing to trash, Open with no valid
 * path) simply drop out of the walk via the engine's rendered/interactive
 * filters; the order leaves a gap the walk skips. Order `1` — vacated when the
 * Recents list folded into the path combo box's own dropdown — is now the
 * Sessions filter field, which sits between the path field and the list in
 * reading order; the stops below keep their authored focus-keys.
 */
const PICKER_CYCLE_GROUP = "session-picker-cycle";
const PICKER_ORDER_PATH = 0;
// The native "Browse…" folder button leads the path field in reading order, so
// it takes a negative order to slot BEFORE PATH (0) in the Tab walk — Tab from
// the browse button lands on the path field, then the Sessions list, keeping the
// button out from between the field and the list. Its fractional order also
// avoids renumbering the stops below — their authored focus-keys
// (`session-picker-cycle:2…5`) are a stable contract the app-tests and a baked
// corpus snapshot address by string, so they must not shift.
const PICKER_ORDER_BROWSE = -0.5;
// The path combo box's chevron sits at the field's right edge, between the
// field and the filter in reading order — fractional for the same
// stable-focus-key reason as Browse above.
const PICKER_ORDER_CHEVRON = 0.5;
const PICKER_ORDER_FILTER = 1;
const PICKER_ORDER_SESSIONS = 2;
const PICKER_ORDER_TRASH_ALL = 3;
const PICKER_ORDER_CANCEL = 4;
const PICKER_ORDER_OPEN = 5;
/**
 * Stable focus-key (`group:order`) of a picker stop. The smart-latch seed lands
 * the ring on a specific stop by this key via a keyboard `place()` — the picker's
 * commit-home (Open) is LAST in reading order, so the session-card "seed = first
 * stop" convention (`focusFirstInMode`) doesn't fit; seeding by key does.
 */
const pickerFocusKey = (order: number): string =>
  `${PICKER_CYCLE_GROUP}:${order}`;

/**
 * The Choose Session sheet's arrow order — the sheet's stops laid out as the
 * rows they read as on screen. Without it the sheet is served by the liveliness
 * net alone, which walks the linear order; a sheet is exactly the surface the
 * focus language asks to be authored, so Cancel / Open get a real horizontal
 * ring (Left/Right swap, wrapping) instead of two more stops in a column.
 *
 * The Sessions list is a single-node row, so it takes no ring: the engine
 * injects its live cursor handle as the group, interior arrows rove its rows,
 * and only an arrow off the cursor's edge crosses the seam to the row above or
 * below. Every key is a module constant, so the order is too — nothing to
 * memoize.
 */
const PICKER_SPATIAL_ORDER: SpatialOrder = rowGridOrder([
  [
    pickerFocusKey(PICKER_ORDER_BROWSE),
    pickerFocusKey(PICKER_ORDER_PATH),
    pickerFocusKey(PICKER_ORDER_CHEVRON),
  ],
  [pickerFocusKey(PICKER_ORDER_FILTER)],
  [pickerFocusKey(PICKER_ORDER_SESSIONS)],
  [pickerFocusKey(PICKER_ORDER_TRASH_ALL)],
  [pickerFocusKey(PICKER_ORDER_CANCEL), pickerFocusKey(PICKER_ORDER_OPEN)],
]);

/**
 * Render `text` with `<mark>` highlights at `matches` (UTF-16 code-unit
 * half-open ranges) — the recents dropdown's substring emphasis. Empty
 * `matches` → the text unmarked.
 */
function renderRecentHighlight(
  text: string,
  matches: ReadonlyArray<readonly [number, number]>,
): React.ReactNode {
  if (matches.length === 0) return text;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of matches) {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark key={`m-${start}`} className="session-card-picker-match">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

export function SessionProjectPickerForm({
  notice,
  onOpen,
  onCancel,
  onRetryRestore,
}: SessionProjectPickerFormProps) {
  const focusManager = useFocusManager();
  // Declared against the sheet's own trap, which `TugSheet` owns — hence the
  // context form, read from the enclosing `FocusModeScope`. This body renders
  // inside that trap; if the order ever landed on the base mode instead (the
  // context form no-ops there), that is the signal the call has drifted outside
  // the trap.
  useSpatialOrder(PICKER_SPATIAL_ORDER);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Per-state default focus for the picker ([P12] Picker → Open). The Open
  // button is the destination so Return opens the seeded path — but Open is
  // `disabled` until a valid path settles, and the path seed is async, so the
  // placement is a deliberate smart latch (below) that seeds the engine key view
  // by focus-key once Open settles enabled, else the path field; never yanked
  // once the user has engaged the field. Both stops are addressed by their stable
  // `group:order`, so no element ref is needed for the seed.
  const defaultFocusPlacedRef = useRef(false);
  const userTouchedFieldRef = useRef(false);
  // Form's outer DOM node — used to scope the anchor querySelector for
  // the form-owned trash-confirmation popover so the lookup never
  // walks outside the picker form's own subtree.
  const formRootRef = useRef<HTMLDivElement | null>(null);
  const formResponderId = useId();

  // External state via `useSyncExternalStore` per [L02]. Recents
  // ride on tugbank; sessions flow through the tugcast-side
  // `SessionLedgerStore` keyed on the user-typed path.
  const recents = useTugbankValue(
    "dev.tugapp.dev",
    "recent-projects",
    parseRecents,
    EMPTY_STRING_ARRAY as string[],
  );

  // Recent paths whose directory the last `/api/fs/stat` probe reported as
  // gone (deleted / moved since it was recorded). Opening one dead-ends at the
  // "Can't open project" screen, so we drop them from the dropdown seed up
  // front. Best-effort and additive: only paths explicitly reported missing
  // are hidden; a probe failure leaves the set empty and every recent shows.
  const [missingRecents, setMissingRecents] =
    useState<ReadonlySet<string>>(EMPTY_STRING_SET);
  useEffect(() => {
    let cancelled = false;
    if (recents.length === 0) {
      setMissingRecents((prev) => (prev.size === 0 ? prev : EMPTY_STRING_SET));
      return;
    }
    void probeDirExistence(recents).then((existsMap) => {
      if (cancelled) return;
      const gone = new Set<string>();
      for (const recentPath of recents) {
        if (existsMap[recentPath] === false) gone.add(recentPath);
      }
      setMissingRecents((prev) =>
        prev.size === gone.size && [...gone].every((p) => prev.has(p))
          ? prev
          : gone,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [recents]);

  // Suggested project path the Swift host refreshes at every launch
  // (the repo source tree for debug builds, `$HOME` for release).
  // Used to seed the input when the user has no Recent Project Paths
  // yet so first launch isn't a dead-end.
  const initialProjectPath = useTugbankValue(
    "dev.tugapp.app",
    "initial-project-path",
    parseString,
    "",
  );

  // The user's chosen default project directory (Settings ▸ General, or the
  // ConfigureTug step). Outranks the Swift hint in the seed chain below.
  const defaultProjectPath = useTugbankValue(
    DEFAULT_PROJECT_PATH_DOMAIN,
    DEFAULT_PROJECT_PATH_KEY,
    parseString,
    "",
  );

  // Reliable fallback for the seed when there is no Swift hint: the backend
  // home directory (the browser can't know it). See `seedPathFrom`.
  const hostFacts = useHostFacts();

  // The field's value is a DERIVATION, not a mirror: `userPath` is null until
  // the user edits, and until then the path is read from the stores at RENDER
  // ([P10], [L02]) rather than written into state by an effect a tick later.
  // The picker's first render has to carry the path the picker will be drawn
  // with, because the height a Session card bids at arrival is read off it.
  //
  // `seededPathRef` is the old one-shot seed's latch, kept: the FIRST non-empty
  // seed wins and later tugbank / host-facts ticks cannot move it. Without it
  // the field would follow the stores — a recents list arriving after the
  // picker opened would yank the path out from under a ledger already loading
  // for the seed, which is the behaviour at0141 pins. It is written during
  // render because a latch an effect sets is a latch the first render does not
  // have; the write is idempotent, so a double render lands the same value.
  const [userPath, setUserPath] = useState<string | null>(null);
  const seededPathRef = useRef<string | null>(null);
  const seededPath = seedPathFrom(
    recents,
    defaultProjectPath,
    initialProjectPath,
    hostFacts?.home,
  );
  if (seededPathRef.current === null && seededPath !== "") {
    seededPathRef.current = seededPath;
  }
  const path = userPath ?? seededPathRef.current ?? "";
  const trimmedPath = path.trim();
  const sessionLedger = useSessionLedger(trimmedPath);

  // Re-validate the session list once per picker open. The ledger
  // store's snapshot is fetched once per connection, but terminal
  // sessions and other out-of-band JSONL writers never push
  // `session_updated` — without this the list freezes at whatever the
  // first open saw. Stale-while-revalidate: cached rows stay on screen
  // while the refresh scan runs ([L02] — the store owns the state; this
  // is an event kick, not a state mirror).
  const didRefreshLedgerRef = useRef(false);
  useLayoutEffect(() => {
    if (didRefreshLedgerRef.current || trimmedPath === "") return;
    didRefreshLedgerRef.current = true;
    getSessionLedgerStore()?.refresh(trimmedPath);
  }, [trimmedPath]);

  // The filter field's query — transient local UI state, never persisted, and
  // meaningless across project paths (the field remounts per path, below).
  const [filterQuery, setFilterQuery] = useState("");

  // The Sessions list for the currently-typed project path (always visible —
  // placeholder when no path / ledger pending), narrowed by the filter field.
  // "New session" stays in the list under any query: Open falls to a new
  // session with or without the row, so hiding it would misrepresent what Open
  // does — and keeping it means the filtered list is never empty.
  // Recents are no longer a separate list: they seed the path combo box's own
  // dropdown (below).
  const sessionsDataSource = useSessionsDataSource(
    trimmedPath,
    sessionLedger,
    filterQuery,
  );
  // The projection's version, so the selection-invalidation effect below re-runs
  // on every filter recompute and not just on a ledger tick ([L02]).
  const sessionsVersion = useSyncExternalStore(
    useCallback(
      (cb: () => void) => sessionsDataSource.subscribe(cb),
      [sessionsDataSource],
    ),
    useCallback(() => sessionsDataSource.getVersion(), [sessionsDataSource]),
  );

  // Session selection. Owned here, read by cells via context. Open
  // resolves submission per [Spec S02].
  const [selection, setSelection] = useState<PickerSelection | null>(null);

  // [Spec S03] selection invalidation — sessions only. Auto-default
  // to `session-new` on first SESSIONS visibility per [D06]; clear
  // when sessions go away; snap-back when the selected resume row
  // vanishes from the ledger.
  const sessionsReady = sessionsDataSource.isReady();
  const ledgerRows = sessionLedger.rows;
  useLayoutEffect(() => {
    if (!sessionsReady) {
      if (selection !== null) setSelection(null);
      return;
    }
    if (selection === null) {
      setSelection({ kind: "session-new" });
      return;
    }
    if (selection.kind === "session-resume") {
      // Visibility is asked of the PROJECTION, not the raw ledger: a row the
      // filter hid is not selectable, and leaving it selected would let Open
      // resume a session the user can no longer see.
      if (!sessionsDataSource.hasVisibleSession(selection.sessionId)) {
        setSelection({ kind: "session-new" });
      }
    }
    // `sessionsVersion` is the projection's change token — the effect must
    // re-run per filter recompute, not only per ledger tick.
  }, [sessionsReady, sessionsVersion, sessionsDataSource, selection]);

  // Trash actions — the picker form owns the confirmation flow per
  // [tugplan-session-picker-redesign §D14] (no per-cell popovers).
  //
  // Per-row trash: the trash `TugIconButton` in `SessionResumeCell`
  // dispatches `request-trash-session` with `{ sessionId }` payload.
  // The chain handler below populates `pendingTrashSessionId`. A
  // single anchored `TugConfirmPopover` rendered at the form level
  // confirms, and its `onConfirm` callback unconditionally moves the
  // session to trash.
  //
  // Trash-all: the picker-level button uses the imperative-mode
  // `TugConfirmPopover` API (legacy). It does not need the chain-
  // dispatch path because the button is always visible at a fixed
  // location, not anchored to a specific row.

  const trashSession = useCallback(
    (sessionId: string): void => {
      const store = getSessionLedgerStore();
      if (store === null) return;
      const row = ledgerRows.find((r) => r.session_id === sessionId);
      // Live-in-Tug and terminal-live rows are untrashable (the cell
      // hides the control; this is the defensive backstop — the
      // supervisor refuses both anyway).
      if (
        row === undefined ||
        row.state === "live" ||
        row.terminal_live !== null
      )
        return;
      // Always pass the project dir: external rows (no ledger row
      // server-side) need it to locate the JSONL; ledger rows ignore it.
      void store.trashSession(sessionId, row.project_dir);
      setSelection((prev) =>
        prev?.kind === "session-resume" && prev.sessionId === sessionId
          ? { kind: "session-new" }
          : prev,
      );
    },
    [ledgerRows],
  );

  // ---- Form-owned trash confirmation ----
  //
  // `pendingTrashSessionId` is `null` when no trash is in flight.
  // The chain handler for `request-trash-session` (registered below)
  // sets it; the popover's `onConfirm` and `onCancel` both clear it.
  // The anchor is resolved in a layout effect by querying the trash
  // icon's DOM node within this form's own subtree — the cell's
  // `data-session-id="<id>"` attribute on the row + the
  // `data-slot="tug-icon-button"` on the trash button form a stable
  // selector that survives row reordering and virtualization recycle.
  const [pendingTrashSessionId, setPendingTrashSessionId] = useState<
    string | null
  >(null);
  const [pendingTrashAnchorEl, setPendingTrashAnchorEl] =
    useState<HTMLElement | null>(null);

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
    const el = root.querySelector<HTMLElement>(selector);
    setPendingTrashAnchorEl(el ?? null);
  }, [pendingTrashSessionId]);

  // Chain handler for `request-trash-session` dispatched by the per-
  // row trash button. The cell carries the sessionId on the event's
  // `value`; we narrow defensively per [L07] and ignore malformed
  // payloads. Setting `pendingTrashSessionId` triggers the layout
  // effect above (anchor resolution) and the popover render below.
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

  // Recents-trash pending state. The recents now live in the path combo box's
  // dropdown, which portals outside this form's DOM subtree — so a chain
  // dispatch (which walks the DOM for a responder) can't route from there. The
  // trash button uses a direct `onClick` instead, setting this state and
  // capturing the button element as the confirm popover's anchor (below).
  const [pendingTrashRecentPath, setPendingTrashRecentPath] = useState<
    string | null
  >(null);

  // The TOLERANT form ([P09]). The picker renders live inside the deck's
  // `ResponderChainProvider`, where the two hooks are the same hook; the
  // tolerant one is kept so a render outside the chain — a fixture, a gallery
  // — draws the picker rather than throwing out of it.
  const {
    ResponderScope: PickerFormResponderScope,
    responderRef: pickerFormResponderRef,
  } = useOptionalResponder({
    id: formResponderId,
    actions: {
      [TUG_ACTIONS.REQUEST_TRASH_SESSION]: handleRequestTrashSession,
    },
  });

  // Merged ref: the form's root div carries BOTH the form responder's
  // `data-responder-id` (so the chain DOM walk lands here) AND our
  // own `formRootRef` (so the anchor querySelector is scoped to the
  // form's subtree). React calls function refs with the element on
  // mount and `null` on unmount, so the merge mirrors the same
  // calling shape both ways.
  const setFormRootRef = useCallback(
    (el: HTMLDivElement | null): void => {
      formRootRef.current = el;
      pickerFormResponderRef(el);
    },
    [pickerFormResponderRef],
  );

  // Confirm / cancel callbacks for the form-owned popover. Both
  // unconditionally clear `pendingTrashSessionId`, which flips the
  // popover's controlled `open` to `false`. Confirm additionally runs
  // the move-to-trash via the existing `trashSession` helper.
  const handleConfirmTrash = useCallback(() => {
    if (pendingTrashSessionId !== null) {
      trashSession(pendingTrashSessionId);
    }
    setPendingTrashSessionId(null);
  }, [pendingTrashSessionId, trashSession]);

  const handleCancelTrash = useCallback(() => {
    setPendingTrashSessionId(null);
  }, []);

  // The pending row's prompt would compose a richer message here, but
  // the picker UX uses the short, generic prompt "Move to Trash?" for
  // both single-row and bottom-button paths.
  const pendingTrashMessage = "Move to Trash?";

  // ---- Recent Project Paths trash ----
  //
  // `pendingTrashRecentPath` is declared above (next to `useResponder`). The
  // dropdown trash button captures its own element as the confirm popover's
  // anchor directly on click (see the combo-box seed builder), since the
  // portaled dropdown is outside this form's DOM subtree. Here: the remove
  // action and the confirm/cancel callbacks.
  const [pendingTrashRecentAnchorEl, setPendingTrashRecentAnchorEl] =
    useState<HTMLElement | null>(null);

  // Remove one path from the recents list. Optimistically updates the tugbank
  // cache (so the list re-renders immediately) then persists via PUT.
  const trashRecent = useCallback(
    (path: string): void => {
      const next = recents.filter((p) => p !== path);
      const client = getTugbankClient();
      client?.setLocalValue("dev.tugapp.dev", "recent-projects", {
        kind: "json",
        value: { paths: next },
      });
      putSessionRecentProjects(next);
    },
    [recents],
  );

  const handleConfirmTrashRecent = useCallback(() => {
    if (pendingTrashRecentPath !== null) {
      trashRecent(pendingTrashRecentPath);
    }
    setPendingTrashRecentPath(null);
    setPendingTrashRecentAnchorEl(null);
  }, [pendingTrashRecentPath, trashRecent]);

  const handleCancelTrashRecent = useCallback(() => {
    setPendingTrashRecentPath(null);
    setPendingTrashRecentAnchorEl(null);
  }, []);

  const trashAll = useCallback((): void => {
    const store = getSessionLedgerStore();
    if (store === null) return;
    let any = false;
    for (const row of ledgerRows) {
      if (row.state === "live") continue;
      void store.trashSession(row.session_id);
      any = true;
    }
    if (any) setSelection({ kind: "session-new" });
  }, [ledgerRows]);

  // Imperative handle for the trash-all confirm popover anchored to
  // the Move-all-to-Trash button. Click flow: open popover → await
  // confirmation → run `trashAll`.
  const trashAllConfirmRef = useRef<TugConfirmPopoverHandle>(null);
  const handleTrashAllClick = useCallback(async (): Promise<void> => {
    const ok = await trashAllConfirmRef.current?.confirm();
    if (ok === true) trashAll();
  }, [trashAll]);

  // Submit per [Spec S02] — resolves `(mode, sessionId)` from the
  // effective selection. The override parameter lets the form-level
  // Enter handler pass a synchronously-resolved selection from a
  // focused cell wrapper, since `setSelection` calls in the same
  // event don't reach state until the next render.
  const submitWith = useCallback(
    (effectiveSelection: PickerSelection | null): void => {
      const trimmed = inputRef.current?.value.trim() ?? "";
      if (!trimmed) return;

      let mode: CardSessionMode;
      let sessionId: string;
      let resumeCandidateId: string | null = null;
      let display: ResumeDisplayMetadata | undefined;

      if (effectiveSelection?.kind === "session-resume") {
        resumeCandidateId = effectiveSelection.sessionId;
        const row = ledgerRows.find(
          (r) => r.session_id === effectiveSelection.sessionId,
        );
        if (row !== undefined && row.state !== "live") {
          mode = "resume";
          sessionId = row.session_id;
          display = {
            title: row.name ?? row.last_user_prompt ?? null,
            turnCount: row.turn_count,
          };
        } else {
          mode = "new";
          sessionId = crypto.randomUUID();
        }
      } else {
        mode = "new";
        sessionId = crypto.randomUUID();
      }

      logSessionLifecycle("picker.submit", {
        project_dir: trimmed,
        session_mode: mode,
        session_id: sessionId,
        resume_candidate_id: resumeCandidateId,
      });
      onOpen(trimmed, mode, sessionId, display);
    },
    [onOpen, ledgerRows],
  );

  const submit = useCallback((): void => {
    submitWith(selection);
  }, [submitWith, selection]);

  // Open the recent-path trash confirmation. Anchored to the path field (a
  // stable element that never unmounts), so the dropdown is free to close when
  // the confirm takes focus without stranding the popover. Shared by the mouse
  // click and the Shift+Delete keyboard path.
  const requestTrashRecent = useCallback((recentPath: string): void => {
    setPendingTrashRecentPath(recentPath);
    setPendingTrashRecentAnchorEl(inputRef.current);
  }, []);

  // Seed source for the path combo box's dropdown: the recent project paths,
  // filtered to those matching the typed query (all when the query is empty, so
  // the dropdown opens like a menu), each rendered with `<mark>` highlights on
  // the matched substring. Choosing a row fills the input (the combo box's own
  // commit); the trailing trash — or Shift+Delete on the highlighted row —
  // removes the recent. The confirm popover anchors to the trash button element
  // (captured from the click, or resolved by path for the keyboard path), since
  // the dropdown portals outside this form and a form-scoped lookup wouldn't
  // find it.
  const buildRecentsSeed = useCallback(
    (query: string): TugComboBoxItem[] => {
      const q = query.trim();
      const items: TugComboBoxItem[] = [];
      for (const recentPath of recents) {
        // Don't offer a directory we already know is gone — opening it would
        // just dead-end at "Can't open project".
        if (missingRecents.has(recentPath)) continue;
        const match = caseInsensitiveSubstring(q, recentPath);
        if (q !== "" && match === null) continue;
        const matches = match?.matches ?? [];
        const pathShort =
          recentPath.split("/").filter(Boolean).slice(-1)[0] ?? recentPath;
        items.push({
          value: recentPath,
          label: (
            <span
              className="session-card-picker-path-recent"
              data-testid="session-card-picker-path-recent"
              title={recentPath}
              aria-label={recentPath}
            >
              {renderRecentHighlight(recentPath, matches)}
            </span>
          ),
          rowData: {
            "data-recent-path": recentPath,
            "data-pending-trash":
              pendingTrashRecentPath === recentPath ? "true" : undefined,
          },
          onRemove: () => requestTrashRecent(recentPath),
          trailing: (
            <TugIconButton
              icon={<Trash2 size={14} aria-hidden="true" />}
              aria-label={`Remove ${pathShort} from recent paths`}
              title={`Remove ${pathShort} from recent paths`}
              tone="danger"
              className="session-card-picker-recent-trash"
              onClick={() => requestTrashRecent(recentPath)}
            />
          ),
        });
      }
      return items;
    },
    [recents, missingRecents, pendingTrashRecentPath, requestTrashRecent],
  );

  // Sessions list delegate — onSelect updates the session selection
  // (or no-ops on live / loading rows).
  const sessionsDelegate = useMemo<TugListViewDelegate>(
    () => ({
      onSelect: (index) => {
        const row = sessionsDataSource.rowAt(index);
        switch (row.kind) {
          case "session-new":
            setSelection({ kind: "session-new" });
            return;
          case "session-resume":
            if (row.row.state === "live") return;
            setSelection({
              kind: "session-resume",
              sessionId: row.row.session_id,
            });
            return;
          case "loading":
            return;
        }
      },
    }),
    [sessionsDataSource],
  );

  // Arrow navigation over the Sessions list is owned by the focus engine: the
  // `TugListView` is authored as one single-select cycle stop, so ↑/↓ move the
  // cursor within it AND select the landed row — the session selection follows
  // the cursor (no separate Space step). A single-select list does not consume
  // Return: it falls through to the picker's default action (Open, which keeps
  // its ring the whole time via `persistentDefaultRing`), so arrowing to a row
  // and pressing Return opens it. Per-row trash stays mouse-driven (the row
  // trash icons are focus-refusing pointer affordances); keyboard users trash
  // via the Move-all-to-Trash stop.

  // Cell-context value for the Sessions list: `selection` drives session cells'
  // selection state; `pendingTrashSessionId` drives the matching row's
  // `data-pending-trash="true"` marker so its trash icon stays visible +
  // highlighted while the form-owned confirm popover is up. The per-row trash
  // flow dispatches `request-trash-session` through the chain, and the form's
  // chain handler above owns the response.
  const cellContextValue = useMemo(
    () => ({
      selection,
      pendingTrashSessionId,
      filterQuery,
    }),
    [selection, pendingTrashSessionId, filterQuery],
  );

  // The filter field's contract: report each keystroke, and hand the key view
  // down to the Sessions list on ArrowDown. Escape is the field's own (it
  // clears in place while non-empty); an empty field's Escape falls through to
  // the sheet's dismiss, so no `filterFieldDidRequestDismiss` here. Enter stays
  // with the picker's default action (Open), so no submit either.
  const pickerListRef = useRef<TugListViewHandle>(null);
  const pickerFilter = useAttachedFilter(() => pickerListRef.current);
  const filterDelegate = useMemo(
    () => ({
      filterFieldDidChangeQuery: setFilterQuery,
      // ↑/↓ cursor the Sessions list from the caret ([P08]) instead of handing
      // the key view down to it, so narrowing and choosing stay one gesture.
      ...pickerFilter.delegate,
    }),
    [focusManager, pickerFilter],
  );

  // Master/detail layout: project-path input → Recents list →
  // Sessions list (+ Move-all-to-Trash button) → Cancel/Open.
  const sessionsPending = sessionsDataSource.isPending();
  const nonLiveCount = sessionsDataSource.nonLiveCount();
  // The list omits prompt-free sessions, but the trash sweep takes every
  // session on the path — so the tooltip names both halves rather than
  // implying the visible count is the whole of it.
  const trashAllTooltip =
    nonLiveCount > 0
      ? `${nonLiveCount} ${nonLiveCount === 1 ? "session" : "sessions"}, plus all empty sessions`
      : "All empty sessions";
  // The `list_sessions` round-trip carries a filesystem existence check
  // for the typed path. An explicit `false` (path confirmed missing)
  // disables Open so a doomed `spawn_session` is never sent; `undefined`
  // (still checking) leaves Open enabled — the spawn-error banner is the
  // backstop for the race window.
  const dirMissing = sessionsDataSource.dirExists() === false;
  const openDisabled = trimmedPath.length === 0 || dirMissing;

  // Smart-latch default focus ([P12] Picker → New session). Re-evaluated as the
  // async path seed settles `openDisabled` and the sessions list becomes ready:
  //   - Open enabled + sessions ready → seed the Sessions list, which rests its
  //     cursor on the "New session" row (the selection defaults to
  //     `session-new`). A single-select list does not consume Return, so it
  //     falls through to the persistent-default Open: one Return spawns a new
  //     session at the seeded (most-recent) path. Latch.
  //   - Open enabled but sessions not ready yet → keep the caret in the path
  //     field so a still-loading picker is never ringless; do NOT latch, so the
  //     seed promotes to the Sessions list the moment the list mounts.
  //   - Open disabled → keep the ring/caret in the path field so typing starts
  //     immediately; do NOT latch, so a seed that later enables Open
  //     (before the user types) promotes the ring on the next run.
  //   - The user has touched the field → that field is the default;
  //     latch without moving so typing is never interrupted.
  // The picker is persistent-cycling ([P13]) — the seed is the engine KEY VIEW
  // (ring + DOM focus), not a bare `.focus()`, so the focus engine stays the
  // single owner and the ring rests on the seed at open. The keyboard `place()`
  // resolves the stop by its stable focus-key now (the field is already
  // registered) or re-lights it the instant it mounts. [L03] layout effect
  // (seed before paint).
  useLayoutEffect(() => {
    if (focusManager === null) return;
    if (defaultFocusPlacedRef.current) return;
    if (userTouchedFieldRef.current) {
      defaultFocusPlacedRef.current = true;
      return;
    }
    if (openDisabled || !sessionsReady) {
      focusManager.place(
        null,
        { kind: "focus-key", focusKey: pickerFocusKey(PICKER_ORDER_PATH) },
        { modality: "keyboard" },
      );
      return;
    }
    defaultFocusPlacedRef.current = true;
    focusManager.place(
      null,
      { kind: "focus-key", focusKey: pickerFocusKey(PICKER_ORDER_SESSIONS) },
      { modality: "keyboard" },
    );
  }, [openDisabled, sessionsReady, focusManager]);

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
        <label className="session-card-picker-field">
          <span className="session-card-picker-label">Project path</span>
          {/*
          The path field is a combo box: typing filters the recent projects
          (its seed) AND completes filesystem paths, both in one dropdown; a
          click / chevron / ArrowDown opens the recents as a menu; the Browse
          button is the native-picker escape hatch.
        */}
          <TugFileChooser
            ref={inputRef}
            value={path}
            onChange={(next) => {
              // A user edit — typing, a completion pick, or a selection from
              // the recents dropdown — claims the field as the default focus so
              // the smart latch never yanks it to Open, and pins the value:
              // from here the seed derivation is not consulted again.
              userTouchedFieldRef.current = true;
              setUserPath(next);
            }}
            base={path !== "" ? path : "/"}
            kind="directory"
            onSubmit={submit}
            seed={buildRecentsSeed}
            menuMode
            placeholder="/path/to/project"
            focusGroup={PICKER_CYCLE_GROUP}
            focusOrder={PICKER_ORDER_PATH}
            browseFocusOrder={PICKER_ORDER_BROWSE}
            chevronFocusOrder={PICKER_ORDER_CHEVRON}
          />
        </label>
        <PickerCellProvider value={cellContextValue}>
          <div className="session-card-picker-section">
            <span className="session-card-picker-label">
              Sessions
              {sessionsReady && sessionLedger.scanning === true ? (
                <span
                  className="session-card-picker-scanning"
                  role="status"
                  aria-live="polite"
                  data-testid="session-card-picker-scanning"
                >
                  {sessionLedger.scanProgress !== undefined &&
                  sessionLedger.scanProgress.total > 0 ? (
                    // Determinate ticks from the host's scan: the same
                    // labeled-bar recipe as the restore strip, sized for
                    // the section header.
                    <TugProgressIndicator
                      variant="bar"
                      size={6}
                      role="action"
                      state="running"
                      label="Scanning…"
                      glyphPosition="right"
                      value={Math.min(
                        sessionLedger.scanProgress.parsed,
                        sessionLedger.scanProgress.total,
                      )}
                      max={sessionLedger.scanProgress.total}
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
              {/* The filter trims a path's session list — hundreds of rows on a
                busy project. Keyed on the path so switching projects clears a
                filter that meant something only for the previous one. */}
              <TugFilterField
                key={trimmedPath}
                className="session-card-picker-filter"
                delegate={filterDelegate}
                attachment={pickerFilter}
                placeholder="Filter sessions"
                data-testid="session-card-picker-filter"
                focusGroup={PICKER_CYCLE_GROUP}
                focusOrder={PICKER_ORDER_FILTER}
              />
            </span>
            <div className="session-card-picker-sessions-host">
              {sessionsReady ? (
                <TugListView
                  ref={pickerListRef}
                  dataSource={sessionsDataSource}
                  delegate={sessionsDelegate}
                  cellRenderers={SESSIONS_CELL_RENDERERS}
                  scrollKey="session-card-picker-sessions"
                  rowLayout="flush"
                  className="session-card-picker-sessions-list session-card-picker-list-view"
                  focusGroup={PICKER_CYCLE_GROUP}
                  focusOrder={PICKER_ORDER_SESSIONS}
                  attachedFilter={pickerFilter}
                  singleSelect
                  // Arrowing out of a non-empty filter field should land on the
                  // first MATCH. A single-select list commits as its cursor
                  // lands, so without this seed the first Down would select
                  // "New session" and silently discard the user's prior pick.
                  initialSelectedIndex={
                    filterQuery === ""
                      ? undefined
                      : sessionsDataSource.firstResumeIndex()
                  }
                />
              ) : sessionsPending ? (
                <div
                  className="session-card-picker-empty"
                  role="status"
                  aria-live="polite"
                  data-testid="session-card-picker-pending-placeholder"
                >
                  checking…
                </div>
              ) : (
                <div
                  className="session-card-picker-empty"
                  data-testid="session-card-picker-sessions-empty"
                >
                  Type or select a project path to see sessions
                </div>
              )}
            </div>
            <div
              className="session-card-picker-trash-all"
              data-disabled={nonLiveCount === 0 ? "true" : undefined}
              title={trashAllTooltip}
            >
              <TugLabel
                emphasis="proposal"
                data-testid="session-card-picker-trash-all-label"
              >
                Move all sessions to Trash for this path
              </TugLabel>
              <TugConfirmPopover
                ref={trashAllConfirmRef}
                message={
                  nonLiveCount > 1
                    ? "Move all sessions to Trash?"
                    : "Move to Trash?"
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
                  disabled={nonLiveCount === 0}
                  aria-label="Move all sessions to Trash for this path"
                  data-testid="session-card-picker-trash-all"
                  focusGroup={PICKER_CYCLE_GROUP}
                  focusOrder={PICKER_ORDER_TRASH_ALL}
                />
              </TugConfirmPopover>
            </div>
          </div>
        </PickerCellProvider>
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
          >
            Open
          </TugPushButton>
        </div>
        {/*
        Form-owned trash-session confirmation popover. Driven by
        `pendingTrashSessionId` state set by the chain handler on
        `request-trash-session`. Anchored to the requesting row's
        trash icon via a virtualRef populated in the layout effect.
        One instance, N anchor targets — see [D14] / [D15].
      */}
        <TugConfirmPopover
          open={pendingTrashSessionId !== null}
          anchorEl={pendingTrashAnchorEl}
          message={pendingTrashMessage}
          confirmLabel="Trash"
          confirmRole="danger"
          side="left"
          onConfirm={handleConfirmTrash}
          onCancel={handleCancelTrash}
        />
        {/* Form-owned confirm popover for removing a Recent Project Path,
          anchored to the (stable) path field. The message names the path since
          the anchor is the field, not the specific dropdown row. */}
        <TugConfirmPopover
          open={pendingTrashRecentPath !== null}
          anchorEl={pendingTrashRecentAnchorEl}
          message={
            pendingTrashRecentPath !== null
              ? `Remove ${pendingTrashRecentPath} from recent paths?`
              : "Remove from recent paths?"
          }
          confirmLabel="Remove"
          confirmRole="danger"
          side="bottom"
          onConfirm={handleConfirmTrashRecent}
          onCancel={handleCancelTrashRecent}
        />
      </div>
    </PickerFormResponderScope>
  );
}
