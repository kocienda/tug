/**
 * Release CONTROL verbs — the Release shade's app-level round-trip store.
 *
 * Three verbs ride here, all keyed by the workspace key the deck sends as
 * `project_dir` and the server echoes back verbatim (Spec S03), which is the
 * same correlation `changeset-verb-store.ts` uses and for the same reason: the
 * reply names the project, never the card.
 *
 *   - `release_check { project_dir }` runs the project's declared check
 *     command and replies `release_check_ok { rows, passed, exit_code, raw }`
 *     or `release_check_err { detail }`. `passed` is the command's exit code,
 *     never a count of the rows — a check that prints nothing and exits 0 is
 *     blessed, and one that prints only `ok` lines and exits 1 is not.
 *   - `release_dispatch { project_dir, force }` queues the release. Its
 *     refusal carries `rows` when the server's own re-check is what refused,
 *     and that presence is how the sheet knows to show a checklist rather
 *     than a sentence.
 *   - `release_watch { project_dir, run_id }` (re)starts the watch for a run
 *     id this side already has — a reloaded deck rejoining a run still going.
 *     It has no `_ok`: the answer is the `release_run_state` frames.
 *
 * `release_run_state` frames are unsolicited — the server watches the run and
 * broadcasts, so a frame can arrive for a workspace this store has never sent
 * a verb for (a dispatch from one window, a second window watching). Such a
 * frame is kept rather than dropped: the run is real whoever asked for it, and
 * the sheet that opens next should find it already there.
 *
 * **There is no timer in this module.** The one poll in the whole release
 * feature is the server's ([L33], [P11]); the sheet's elapsed counter is a DOM
 * tick in the view, and neither is a licence for another here.
 *
 * @module lib/release-store
 */

import { useSyncExternalStore } from "react";

import type { TugConnection } from "../connection";
import { FeedId } from "../protocol";

/** A check row's mark — the three the check grammar recognizes (Spec S02). */
export type CheckMark = "ok" | "fail" | "note";

/** One line the check command printed that the grammar claimed. */
export interface CheckRow {
  mark: CheckMark;
  text: string;
}

/** Where the check round trip is. `done` means it ran, not that it passed. */
export type CheckPhase = "idle" | "running" | "done" | "error";

/** The check's outcome. `passed` is the exit code's verdict, not the rows'. */
export interface CheckState {
  phase: CheckPhase;
  rows: readonly CheckRow[];
  /** The command exited 0. Meaningless unless `phase === "done"`. */
  passed: boolean;
  /** The command's exit code; null when it was killed or never ran. */
  exitCode: number | null;
  /** The whole merged transcript, so the un-marked lines stay readable. */
  raw: string | null;
  error: string | null;
}

/** Where the dispatch round trip is. */
export type DispatchPhase = "idle" | "pending" | "done" | "error";

/** The dispatch's outcome, including the refusal's own check rows. */
export interface DispatchState {
  phase: DispatchPhase;
  runId: string | null;
  url: string | null;
  error: string | null;
  /** Present when the server's re-check is what refused the dispatch. */
  rows: readonly CheckRow[];
}

/** One step of the watched run, as `gh run view` reports it. */
export interface RunStep {
  name: string;
  status: string;
  conclusion: string;
  startedAtMs: number | null;
  completedAtMs: number | null;
}

/**
 * The watched run. `status` is GitHub's (`queued`, `in_progress`,
 * `completed`) plus tugcast's two: `unreachable` while `gh` cannot be reached,
 * and `abandoned` on the watch ceiling — the frame that says the watcher
 * stopped looking rather than that the run stopped running.
 */
export interface RunState {
  runId: string;
  url: string;
  status: string;
  conclusion: string;
  steps: readonly RunStep[];
  /** Epoch ms the watch began — the sheet's "watched for …" reads from it. */
  watchedSinceMs: number;
  failedLog: string | null;
}

/** Everything the Release shade knows about one workspace. */
export interface ReleaseState {
  check: CheckState;
  dispatch: DispatchState;
  run: RunState | null;
}

const CHECK_IDLE: CheckState = Object.freeze({
  phase: "idle",
  rows: Object.freeze([]) as readonly CheckRow[],
  passed: false,
  exitCode: null,
  raw: null,
  error: null,
});

const DISPATCH_IDLE: DispatchState = Object.freeze({
  phase: "idle",
  runId: null,
  url: null,
  error: null,
  rows: Object.freeze([]) as readonly CheckRow[],
});

/**
 * The one idle snapshot every unknown workspace reads. Frozen and shared so
 * `useSyncExternalStore` sees a referentially stable value across renders —
 * a fresh object per read would re-render every subscriber on every commit.
 */
const RELEASE_IDLE: ReleaseState = Object.freeze({
  check: CHECK_IDLE,
  dispatch: DISPATCH_IDLE,
  run: null,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function readOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Claim the rows a `_ok`/`_err` carried, dropping anything malformed. */
function readCheckRows(value: unknown): readonly CheckRow[] {
  if (!Array.isArray(value)) return CHECK_IDLE.rows;
  const rows: CheckRow[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const mark = raw.mark;
    if (mark !== "ok" && mark !== "fail" && mark !== "note") continue;
    rows.push({ mark, text: readString(raw.text) });
  }
  return rows;
}

function readRunSteps(value: unknown): readonly RunStep[] {
  if (!Array.isArray(value)) return [];
  const steps: RunStep[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    steps.push({
      name: readString(raw.name),
      status: readString(raw.status),
      conclusion: readString(raw.conclusion),
      startedAtMs: readOptionalNumber(raw.started_at_ms),
      completedAtMs: readOptionalNumber(raw.completed_at_ms),
    });
  }
  return steps;
}

/**
 * Per-workspace release state, fed by CONTROL replies. One instance per
 * connection, attached at mount by {@link attachReleaseStore}.
 */
export class ReleaseStore {
  private readonly _connection: TugConnection;
  private readonly _unsubscribe: () => void;
  private readonly _listeners = new Set<() => void>();
  /** workspace key → its state. Absent ⇒ {@link RELEASE_IDLE}. */
  private readonly _states = new Map<string, ReleaseState>();
  private readonly _decoder = new TextDecoder();

  constructor(connection: TugConnection) {
    this._connection = connection;
    this._unsubscribe = connection.onFrame(FeedId.CONTROL, (payload) =>
      this._onControl(payload),
    );
  }

  private _onControl(payload: Uint8Array): void {
    let body: unknown;
    try {
      body = JSON.parse(this._decoder.decode(payload));
    } catch {
      return;
    }
    if (!isRecord(body) || typeof body.action !== "string") return;
    const dir = typeof body.project_dir === "string" ? body.project_dir : null;
    if (dir === null) return;

    switch (body.action) {
      case "release_check_ok":
        this._patch(dir, (prev) => ({
          ...prev,
          check: {
            phase: "done",
            rows: readCheckRows(body.rows),
            passed: body.passed === true,
            exitCode: readOptionalNumber(body.exit_code),
            raw: readString(body.raw),
            error: null,
          },
        }));
        break;
      case "release_check_err":
        this._patch(dir, (prev) => ({
          ...prev,
          check: {
            ...CHECK_IDLE,
            phase: "error",
            error: readString(body.detail, "the release check failed to run"),
          },
        }));
        break;
      case "release_dispatch_ok":
        this._patch(dir, (prev) => ({
          ...prev,
          dispatch: {
            phase: "done",
            runId: readString(body.run_id),
            url: readString(body.url),
            error: null,
            rows: DISPATCH_IDLE.rows,
          },
        }));
        break;
      case "release_dispatch_err":
        this._patch(dir, (prev) => ({
          ...prev,
          dispatch: {
            phase: "error",
            runId: null,
            url: null,
            error: readString(body.detail, "the dispatch was refused"),
            rows: readCheckRows(body.rows),
          },
        }));
        break;
      case "release_run_state":
        this._patch(dir, (prev) => {
          const url = readString(body.url);
          const steps = readRunSteps(body.steps);
          const status = readString(body.status);
          // The watcher's two own statuses — `unreachable` and `abandoned` —
          // are reports about the WATCH, and they carry no url and no steps
          // because the watcher has none to report. Taking them literally
          // would blank the step rows every time `gh` hiccups, so a frame that
          // brought neither keeps what the last real frame said. The status is
          // always the incoming one: that is the part such a frame is for.
          const carry = url.length === 0 && steps.length === 0;
          return {
            ...prev,
            run: {
              runId: readString(body.run_id),
              url: carry ? (prev.run?.url ?? "") : url,
              status,
              conclusion: readString(body.conclusion),
              steps: carry ? (prev.run?.steps ?? []) : steps,
              watchedSinceMs: readOptionalNumber(body.watched_since_ms) ?? 0,
              failedLog:
                typeof body.failed_log === "string"
                  ? body.failed_log
                  : (prev.run?.failedLog ?? null),
            },
          };
        });
        break;
      default:
        break;
    }
  }

  /** Run the project's declared check and show what it printed. */
  check(workspaceKey: string): void {
    this._patch(workspaceKey, (prev) => ({
      ...prev,
      check: { ...CHECK_IDLE, phase: "running" },
    }));
    this._connection.sendControlFrame("release_check", {
      project_dir: workspaceKey,
    });
  }

  /**
   * Queue the release. `force` skips the server's re-check — the confirmed
   * override, and the only way past a check that did not pass.
   */
  dispatch(workspaceKey: string, force: boolean): void {
    this._patch(workspaceKey, (prev) => ({
      ...prev,
      dispatch: { ...DISPATCH_IDLE, phase: "pending" },
    }));
    this._connection.sendControlFrame("release_dispatch", {
      project_dir: workspaceKey,
      force,
    });
  }

  /**
   * (Re)start the watch for a run id already in hand. Idempotent per
   * `(project_dir, run_id)` on the server, so asking twice costs one watcher.
   */
  watch(workspaceKey: string, runId: string): void {
    this._connection.sendControlFrame("release_watch", {
      project_dir: workspaceKey,
      run_id: runId,
    });
  }

  /** This workspace's state — the shared idle snapshot when it has none. */
  getSnapshot(workspaceKey: string): ReleaseState {
    return this._states.get(workspaceKey) ?? RELEASE_IDLE;
  }

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  };

  dispose(): void {
    this._unsubscribe();
    this._listeners.clear();
  }

  private _patch(
    workspaceKey: string,
    next: (prev: ReleaseState) => ReleaseState,
  ): void {
    this._states.set(workspaceKey, next(this.getSnapshot(workspaceKey)));
    for (const listener of [...this._listeners]) listener();
  }
}

// ---------------------------------------------------------------------------
// Singleton + hook
// ---------------------------------------------------------------------------

let _activeStore: ReleaseStore | null = null;

export function attachReleaseStore(conn: TugConnection): ReleaseStore {
  if (_activeStore !== null) return _activeStore;
  _activeStore = new ReleaseStore(conn);
  return _activeStore;
}

export function getReleaseStore(): ReleaseStore | null {
  return _activeStore;
}

/** Test-only: detach the singleton between cases. */
export function _resetReleaseStoreForTest(): void {
  _activeStore?.dispose();
  _activeStore = null;
}

/**
 * React hook: one workspace's release state plus its three triggers. Returns
 * the idle snapshot and no-op triggers when no store is attached (gallery /
 * fixtures), the same contract every verb hook in `changeset-verb-store.ts`
 * keeps.
 *
 * The triggers are named `runCheck` / `runDispatch` / `startWatch` rather than
 * after the verbs, because `check` and `dispatch` are already the names of the
 * two state objects on `ReleaseState` — spreading the state and then adding a
 * function under either name would shadow the state the view needs to read.
 */
export function useReleaseState(workspaceKey: string): ReleaseState & {
  runCheck: () => void;
  runDispatch: (force: boolean) => void;
  startWatch: (runId: string) => void;
} {
  const state = useSyncExternalStore(
    (listener) => {
      const store = _activeStore;
      if (store === null) return () => {};
      return store.subscribe(listener);
    },
    () => _activeStore?.getSnapshot(workspaceKey) ?? RELEASE_IDLE,
    () => RELEASE_IDLE,
  );
  return {
    ...state,
    runCheck: () => _activeStore?.check(workspaceKey),
    runDispatch: (force: boolean) => _activeStore?.dispatch(workspaceKey, force),
    startWatch: (runId: string) => _activeStore?.watch(workspaceKey, runId),
  };
}
