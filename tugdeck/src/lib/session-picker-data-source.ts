/**
 * Dev picker — data source for the Sessions list.
 *
 * `SessionsDataSource` enumerates session-choice rows for the currently-typed
 * project path: `session-new` plus one `session-resume` per ledger row, in
 * newest-first order. When the path is empty, or the ledger is pending / idle /
 * errored, the data source emits zero rows; the picker form renders a
 * placeholder div in the empty state. The Trash-all button (visibility gated on
 * `nonLiveCount() > 0`) is rendered by the picker form OUTSIDE the list view.
 *
 * The recent project paths are no longer a separate list — they seed the path
 * field's own combo-box dropdown (see `session-card.tsx`), so this module owns
 * just the one data source now.
 *
 * Filtering is an INPUT, applied inside `recompute()`, so `rowAt` /
 * `enabledForIndex` / selection / cursor all live in one filtered coordinate
 * space — no index translation for the typed cell renderers. The `TugFilterField`
 * above the list reports the query; both filtered surfaces (the full picker and
 * the `/resume` overlay) share this one data source and differ only in whether
 * an active filter also hides the "New session" row.
 *
 * The data source exposes the standard `TugListViewDataSource` surface plus a
 * typed `rowAt(i)` accessor for cells, driven by a hook that mints a stable
 * instance per hook lifetime, absorbs identity-stable inputs as no-ops,
 * recomputes synchronously in render, and notifies subscribers via
 * `useLayoutEffect` (the same pattern as `useFilteredDataSource`).
 *
 * Laws:
 *  - [L02] external state via `useSyncExternalStore` — the data source is such
 *    a store (`subscribe` + `getVersion`).
 *  - [L03] event-dependent registrations in `useLayoutEffect` — the
 *    deferred-notify lives there.
 *  - [L19] component authoring guide — module docstring, exported types.
 *
 * Decisions:
 *  - tugplan-session-picker-redesign [D02] role-flat-list, [D11]
 *    notice-outside-list.
 */

import { useLayoutEffect, useRef } from "react";

import type { TugListViewDataSource } from "@/components/tugways/tug-list-view";
import { filterAndRank } from "./text-match";
import type { SessionRow } from "../protocol";
import type { WorkspaceSnapshot } from "./session-ledger-store";

// ---------------------------------------------------------------------------
// Public row types
// ---------------------------------------------------------------------------

/**
 * Sessions-list row kinds. The picker form's selection state
 * resolves submission to one of these rows per [Spec S02].
 */
export type SessionsRow =
  | { readonly kind: "session-new" }
  | { readonly kind: "session-resume"; readonly row: SessionRow }
  | { readonly kind: "loading" };

// ---------------------------------------------------------------------------
// SessionsDataSource
// ---------------------------------------------------------------------------

interface SessionsInputs {
  /** The typed project path. Empty → zero rows; also gates ready/pending. */
  readonly projectDir: string;
  readonly ledger: WorkspaceSnapshot;
  /**
   * The filter field's query. Empty / whitespace → no filtering. When
   * non-empty, a `session-resume` row survives only when every term matches
   * one of its name, callsign, last prompt, or id.
   */
  readonly filterQuery?: string;
  /**
   * Whether an active filter also drops the `session-new` row. The `/resume`
   * overlay passes `true`: a non-matching query yields a truly empty list that
   * fires no spawn. The full picker passes `false` — its Open falls to a new
   * session with or without the row, so keeping it is the honest rendering of
   * what Open will do, and it guarantees the filtered list is never empty.
   */
  readonly dropNewRowWhenFiltering?: boolean;
}

/**
 * The fields a filter term may match on a session row: its name, its callsign,
 * its last prompt, and its id. Every row carries a real minted callsign after
 * its first scan — external sessions are minted one at scan time, so there is
 * no derived stand-in to match against.
 */
function filterFieldsForRow(row: SessionRow): (string | null | undefined)[] {
  return [row.name, row.tag, row.last_user_prompt, row.session_id];
}

/**
 * Data source for the Sessions list.
 *
 *  - Empty path → zero rows. The picker form renders a "type or
 *    select a project path" placeholder.
 *  - Path + ledger pending → one `loading` row.
 *  - Path + ledger ready → `session-new` + one `session-resume` per
 *    ledger row in newest-first order. The Trash-all button
 *    (rendered by the picker form below the list view) reads
 *    `nonLiveCount()` to decide visibility.
 *  - Path + ledger idle / error → zero rows. The notice banner
 *    surfaces the error per [D11]; the picker form may render a
 *    placeholder for the idle case.
 */
export class SessionsDataSource implements TugListViewDataSource {
  private inputs: SessionsInputs;
  private rows: SessionsRow[] = [];
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(inputs: SessionsInputs) {
    this.inputs = inputs;
    this.recompute();
  }

  numberOfItems(): number {
    return this.rows.length;
  }

  idForIndex(index: number): string {
    const row = this.rows[index];
    switch (row.kind) {
      case "session-new":
        return "session:new";
      case "session-resume":
        return `session:resume:${row.row.session_id}`;
      case "loading":
        return "loading";
    }
  }

  kindForIndex(index: number): string {
    return this.rows[index].kind;
  }

  /**
   * A session is *enabled* (pickable) unless it is held by a live
   * process the user can't resume into from here: live in another Tug
   * card (`state === "live"`) or in use by an external terminal app
   * (`terminal_live !== null`). The `TugListView` skips disabled rows
   * during arrow navigation and refuses click / Space-Enter selection
   * on them, so these "Live in another card" / "In use in a terminal"
   * rows stay visible-for-context but unpickable. `session-new` and the
   * `loading` placeholder are always enabled (the latter is never
   * actually cursorable — it's the sole row while pending). Mirrors the
   * `disabled` appearance derived in `SessionResumeCell`.
   */
  enabledForIndex(index: number): boolean {
    const row = this.rows[index];
    if (row.kind !== "session-resume") return true;
    return row.row.state !== "live" && row.row.terminal_live === null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getVersion(): unknown {
    return this.version;
  }

  rowAt(index: number): SessionsRow {
    return this.rows[index];
  }

  /**
   * Count of non-live ledger rows that are visible in the picker. Used by
   * the picker form to gate the visibility of the Trash-all button.
   * Returns 0 when the ledger is not in `ready` status. Mirrors the
   * `recompute` visibility filter (content by file_size OR turn_count)
   * for non-live rows so the count agrees with what the user sees in the
   * SESSIONS list.
   */
  nonLiveCount(): number {
    const { ledger } = this.inputs;
    if (ledger.status !== "ready") return 0;
    let n = 0;
    for (const row of ledger.rows) {
      if (row.state === "live") continue;
      if ((row.file_size ?? 0) > 0 || row.turn_count > 0) n += 1;
    }
    return n;
  }

  /** Whether `projectDir.length > 0` AND `ledger.status === "ready"`. */
  isReady(): boolean {
    return (
      this.inputs.projectDir.length > 0 && this.inputs.ledger.status === "ready"
    );
  }

  /** Whether `projectDir.length > 0` AND `ledger.status === "pending"`. */
  isPending(): boolean {
    return (
      this.inputs.projectDir.length > 0 &&
      this.inputs.ledger.status === "pending"
    );
  }

  /**
   * Whether `sessionId` is one of the rows currently PROJECTED — i.e. it
   * survives the active filter. The picker's selection-invalidation effect
   * asks this rather than scanning the unfiltered ledger, so a selection that
   * the filter hid snaps back to a visible row instead of staying selected
   * off-screen.
   */
  hasVisibleSession(sessionId: string): boolean {
    return this.rows.some(
      (row) => row.kind === "session-resume" && row.row.session_id === sessionId,
    );
  }

  /**
   * Index of the first `session-resume` row in the projection, or `undefined`
   * when there is none. The picker seeds its cursor here while filtering, so
   * arrowing out of the filter field lands on the first match rather than on
   * "New session" (which a live-committing single-select list would select
   * outright, discarding the user's prior pick).
   */
  firstResumeIndex(): number | undefined {
    const index = this.rows.findIndex((row) => row.kind === "session-resume");
    return index < 0 ? undefined : index;
  }

  /**
   * Whether the queried `projectDir` is a directory that exists on the
   * tugcast host. `undefined` until the `list_sessions_ok` settle
   * carries the check; the picker form disables Open on an explicit
   * `false`.
   */
  dirExists(): boolean | undefined {
    return this.inputs.ledger.dirExists;
  }

  setInputsWithoutNotify(next: SessionsInputs): boolean {
    if (
      this.inputs.projectDir === next.projectDir &&
      this.inputs.ledger === next.ledger &&
      this.inputs.filterQuery === next.filterQuery &&
      this.inputs.dropNewRowWhenFiltering === next.dropNewRowWhenFiltering
    ) {
      return false;
    }
    this.inputs = next;
    this.recompute();
    return true;
  }

  notifyAll(): void {
    for (const listener of this.listeners) listener();
  }

  private recompute(): void {
    const { projectDir, ledger } = this.inputs;
    const filterQuery = this.inputs.filterQuery ?? "";
    const filtering = filterQuery.trim().length > 0;
    // The "New session" row is a spawn affordance, not a searchable session.
    // Whether an active filter hides it is the consumer's policy.
    const dropNewRow = filtering && this.inputs.dropNewRowWhenFiltering === true;
    const next: SessionsRow[] = [];
    if (projectDir.length > 0) {
      if (ledger.status === "ready") {
        if (!dropNewRow) next.push({ kind: "session-new" });
        // Visibility is decoupled from the (canonically strict) turn
        // count so a real session never vanishes because its count is
        // low ([P09]/[R06]). A row is shown when it has resumable
        // content by ANY signal: on-disk JSONL bytes (`file_size > 0`,
        // the count-independent content signal for scanned external
        // rows — `null` for tug/live rows and `session_updated`
        // pushes), a canonical turn (`turn_count > 0`, the live truth
        // for tug rows), or a currently-live process. Only a truly
        // empty row — no bytes, no turn, not live (an opened-and-closed
        // card with nothing in it) — is hidden.
        const withContent = ledger.rows.filter(
          (row) =>
            (row.file_size ?? 0) > 0 || row.turn_count > 0 || row.state === "live",
        );
        // The filter ranks as it trims, so the best matches lead; with no
        // query the ledger's newest-first order is returned untouched. The
        // "New session" row is never ranked — it stays at the top as the
        // list's fixed affordance.
        for (const row of filterAndRank(withContent, filterQuery, filterFieldsForRow)) {
          next.push({ kind: "session-resume", row });
        }
      } else if (ledger.status === "pending") {
        next.push({ kind: "loading" });
      }
      // "idle" and "error" → zero rows; the form's placeholder
      // ("type or select…") and the notice banner cover those.
    }
    this.rows = next;
    this.version += 1;
  }
}

/**
 * Hook — mint a stable `SessionsDataSource` per hook lifetime
 * and feed it the latest `(projectDir, ledger, filterQuery)` snapshot each
 * render.
 */
export function useSessionsDataSource(
  projectDir: string,
  ledger: WorkspaceSnapshot,
  filterQuery = "",
  dropNewRowWhenFiltering = false,
): SessionsDataSource {
  const ref = useRef<SessionsDataSource | null>(null);
  const inputs = {
    projectDir,
    ledger,
    filterQuery,
    dropNewRowWhenFiltering,
  };
  if (ref.current === null) {
    ref.current = new SessionsDataSource(inputs);
  }
  const ds = ref.current;
  const didChange = ds.setInputsWithoutNotify(inputs);

  useLayoutEffect(() => {
    if (didChange) ds.notifyAll();
    // didChange is captured per render; intentional.
  });

  return ds;
}
