/**
 * index.ts — In-app test harness entry point.
 *
 * Exports `launchTugApp` (spawn + connect + handshake) and the `App`
 * class (thin wrappers over the RPC client's `call`). The surface
 * grows over time; this module tracks the current RPC + evalJS facade.
 *
 * Boot sequence (Swift test harness / Tug.app):
 *   1. Generate `TUGAPP_TEST_SOCKET=$TMPDIR/tugapp-test-<uuid>.sock`.
 *   2. Spawn Tug.app via `Bun.spawn` with that env var set.
 *   3. Retry `Bun.connect({ unix: <path> })` on `ECONNREFUSED` until
 *      `connectTimeoutMs` elapses.
 *   4. Issue the `version` RPC; throw `VersionSkewError` on major
 *      mismatch.
 *   5. Return an `App` handle with `evalJS` / `waitForCondition` /
 *      `close` ready for test use.
 *
 * Cleanup: `app.close()` sends SIGTERM, waits up to 5s for exit, then
 * SIGKILL. The socket file is unlinked on close; `process.on("exit")`
 * installs a last-resort synchronous unlink so crashed runs do not
 * leak socket files.
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  AccessibilityPermissionMissingError,
  AppCrashedError,
  VersionSkewError,
} from "./errors";
import { shortToken, tmuxSocketLabel } from "./fnv1a";
import { onTestRunEnd } from "./test-cleanup";
import { RpcClient, type RpcTransport } from "./rpc";
import type {
  AccessibilityStatus,
  EvalJsOptions,
  LaunchTugAppOptions,
  LedgerSeedSpec,
  MenuItemSnapshot,
  MenuItemState,
  NativeModifier,
  NativeMouseButton,
  ScreenRect,
  ViewportPoint,
  WaitForConditionOptions,
} from "./types";
import * as client from "./client";
import type {
  ActiveElementInfo,
  CaretState,
  ClickOptions,
  DeckTraceEvent,
  ElementBounds,
  ElementStateSnapshot,
  HarnessCaller,
  NativeClickOptions,
  NativeDragOptions,
  ResetOptions,
  SeedDeckStateArgs,
  SelectionSnapshot,
} from "./client";

// Re-export the client-side helpers and matcher for test authors.
// Tests import `{ launchTugApp, toContainOrderedSubset }` from
// `@/_harness` and use `app.<method>` for everything else.
export {
  toContainOrderedSubset,
  registerSubsetMatcher,
  type ExpectedEntry,
  type MatcherResult,
} from "./matchers";
export { enforcedTimeout, TIMEOUT_SCALE } from "./rpc";
export type {
  ActiveElementInfo,
  AppLifecycleOptions,
  CaretState,
  ClickOptions,
  ClientMethodNames,
  DeckTraceEvent,
  ElementBounds,
  ElementStateSnapshot,
  EmCardState,
  HarnessCaller,
  NativeClickOptions,
  NativeDragOptions,
  ResetOptions,
  SeedDeckStateArgs,
  SelectionSnapshot,
  StartTugcodeOptions,
  StartTugcodeResult,
  SessionDriveAction,
  TugcodeTranscript,
  TugcodeTranscriptTurn,
} from "./client";
export { TUGCODE_TRANSCRIPT_SCHEMA_VERSION } from "./client";
export type {
  AccessibilityStatus,
  MenuItemState,
  LedgerSeedFileEvent,
  LedgerSeedSession,
  LedgerSeedSpec,
  NativeModifier,
  NativeMouseButton,
  ScreenRect,
  ViewportPoint,
} from "./types";

/**
 * The harness's compile-time expected surface version. Must match the
 * `surfaceVersion` constant in `tugapp/Sources/TestHarness/TestHarnessConnection.swift`
 * exactly (some harness tests assert exact equality, not major-only).
 *
 * `1.1.0`: adds the Phase A native-gesture and keyboard verb family
 * (`nativeClick`, `nativeDoubleClick`, `nativeRightClick`, `nativeDrag`,
 * `nativeMouseDown`, `nativeMouseUp`, `nativeKey`, `nativeType`,
 * `holdModifier`). Additive; major stays `1`. (Tugdeck `SURFACE_VERSION`
 * tracks the page-side `__tug` methods separately.)
 *
 * `1.2.0`: adds the four app-lifecycle simulation verbs
 * (`simulateAppResign`, `simulateAppBecomeActive`, `simulateAppHide`,
 * `simulateAppUnhide`). Additive; major stays `1` — these are pure RPC
 * verbs on the Swift bridge, not new `__tug` methods.
 *
 * `1.3.0`: adds `startTugcode` / `stopTugcode` (spawn/kill base).
 *
 * `1.4.0`: `startTugcode` gains optional in-memory `transcript` for stub
 * replay; Swift writes bytes to a temp file and passes
 * `--stub-transcript=<path>`. Additive; major stays `1`.
 *
 * `1.5.0`: adds the
 * `quitGracefully` verb. Schedules `NSApp.terminate(nil)` on
 * main so the full `applicationShouldTerminate` path runs —
 * including `window.tugdeck.saveState()` — before the OS exits
 * the process. Tests use this to gate cold-boot scenarios that
 * need the save side to actually reach tugbank disk.
 * Additive; major stays `1`.
 *
 * `1.6.0`: adds native-menu introspection verbs (`menuSnapshot`,
 * `menuItemState`), reporting each item's validated enabled state
 * via `NSMenuItemValidation`. Additive; major stays `1`.
 *
 * `1.7.0`: menu snapshot nodes gain `state` (raw
 * `NSControl.StateValue`, 1 = checked), captured after the
 * validation sweep so validator-refreshed radio checkmarks are
 * current. Additive; major stays `1`.
 *
 * `1.8.0`: adds the `screenshot` verb — renders the WKWebView to a
 * PNG temp file (via `WKWebView.takeSnapshot`) and returns its path.
 * Additive; major stays `1`.
 */
export const EXPECTED_SURFACE_VERSION = "1.8.0" as const;

/**
 * Directory (relative to this file) where per-test subprocess logs
 * are captured when `testName` is set. Tug.app stdout/stderr routes
 * to `tests/app-test/logs/<test>.log`.
 */
const LOGS_DIR = pathResolve(import.meta.dir, "..", "logs");

/**
 * Human-cadence settle after EVERY synthetic gesture, enforced at the
 * harness choke point so no test can blast events faster than a person
 * could produce them. CGEvent posts return as soon as the event is in the
 * window server's queue — long before the app has dispatched, handled, and
 * repainted — and back-to-back posts routinely outrun focus transitions,
 * scroll settles, and animation frames in ways no real user ever does. A
 * deliberate test tour runs at roughly two gestures a second, not twenty.
 * Override per run with `TUGAPP_GESTURE_SETTLE_MS` (0 disables).
 */
const GESTURE_SETTLE_MS = (() => {
  const raw = Number(process.env.TUGAPP_GESTURE_SETTLE_MS ?? "200");
  return Number.isFinite(raw) && raw >= 0 ? raw : 200;
})();

/**
 * Settle after the big state transitions — launch handshake,
 * `seedDeckState`, `bindSession` — before the harness lets ANY further
 * driving happen. A person cannot act on an app that is still painting its
 * first frame; a test must not either (keys posted into the launch window
 * land nowhere and beep). Override with `TUGAPP_STATE_SETTLE_MS`.
 */
const STATE_SETTLE_MS = (() => {
  const raw = Number(process.env.TUGAPP_STATE_SETTLE_MS ?? "500");
  return Number.isFinite(raw) && raw >= 0 ? raw : 500;
})();

/** Dwell `STATE_SETTLE_MS` after a state transition resolves. */
async function settleAfterStateChange<T>(p: Promise<T>): Promise<T> {
  const v = await p;
  if (STATE_SETTLE_MS > 0) {
    await new Promise<void>((r) => setTimeoutNative(r, STATE_SETTLE_MS));
  }
  return v;
}

/** Await the gesture RPC, then dwell `GESTURE_SETTLE_MS` before returning. */
async function settleAfterGesture<T>(p: Promise<T>): Promise<T> {
  const v = await p;
  if (GESTURE_SETTLE_MS > 0) {
    await new Promise<void>((r) => setTimeoutNative(r, GESTURE_SETTLE_MS));
  }
  return v;
}

/**
 * Resolved per-run paths for a Tug.app launch.
 */
interface ResolvedLaunch {
  appPath: string;
  socketPath: string;
  connectTimeoutMs: number;
  connectPollMs: number;
  env: Record<string, string | undefined>;
  logPath: string | null;
  expectedSurfaceVersion: string;
  skipAccessibilityPreflight: boolean;
  instanceId: string;
  /**
   * True when `instanceId` was auto-minted (`<prefix>-<uuid>`) rather
   * than supplied by the caller. An auto-minted id is single-use — no
   * later launch reuses it — so teardown can reclaim its data dir
   * immediately. A caller-supplied id (cold-boot / continuity tests
   * that relaunch with the same id) must NOT have its data dir wiped
   * between launches, so those are left for `tugutil host instance prune`.
   */
  ephemeralInstanceId: boolean;
}

/**
 * The `tug-quiesce` teardown deadline: how long the harness gives a whole
 * Tug.app teardown before it escalates to SIGKILL. Mirror of
 * `tugcore::quiesce::TEARDOWN_DEADLINE_MS` (the source of truth; its
 * `quiesce_constants_are_mirrored` test fails the Rust build if this
 * drifts). It sits above the app's own 4 s process-group drain deadline,
 * which in turn sits above each service's 2 s self-enforced flush budget
 * — so in a healthy teardown nothing here ever fires.
 */
const QUIESCE_TEARDOWN_DEADLINE_MS = 8000;

/**
 * The shutdown supervisor's process-group drain deadline, as tests assert it in
 * `quiesce-report.json`. Mirror of `tugcore::quiesce::DRAIN_DEADLINE_MS`,
 * pinned by the same build-failing Rust mirror test.
 */
export const QUIESCE_DRAIN_DEADLINE_MS = 4000;

/**
 * Filename of the per-shutdown quiesce report Tug.app writes into its
 * instance data dir. Mirror of
 * `tugcore::quiesce::QUIESCE_REPORT_FILENAME`.
 */
export const QUIESCE_REPORT_NAME = "quiesce-report.json";

/** One forced kill the app had to fire during teardown. */
export interface QuiesceEscalation {
  target: string;
  pid: number;
  afterMs: number;
}

/** The app's report on its own shutdown. */
export interface QuiesceReport {
  at: string;
  drainDeadlineMs: number;
  /** Empty in a healthy teardown — anything here is a defect. */
  sigkills: QuiesceEscalation[];
}

/**
 * Prefix of the diagnostic sentinel `note()` writes to stdout. The
 * `app-test` recipe scans each file's captured output for these lines and
 * renders them under `Diagnostics:` in the summary. Same house pattern as
 * `TUG-FILE-RECEIPT`.
 */
export const NOTE_MARKER = "TUG-NOTE: ";

/**
 * Report a value from inside a test into the run's summary.
 *
 * A `console.log` lands in the per-file output, which is suppressed unless
 * `TUG_APPTEST_STREAM=1`. A `note()` survives into the summary — for passing
 * files as well as failing ones, which is the point: a probe's value is most
 * often read off a green run.
 *
 * `value` is JSON-serialized; a value that will not serialize is stringified.
 */
export function note(label: string, ...value: [unknown] | []): void {
  let encoded: string;
  // Label-only is a legitimate note — a probe that already formatted its
  // finding into the label has no separate value, and the summary renders it
  // without a trailing `: null`. Rest-tuple rather than an optional parameter
  // so "omitted" and "explicitly undefined" stay distinguishable here.
  if (value.length === 0) {
    encoded = JSON.stringify({ label });
  } else {
    try {
      encoded = JSON.stringify({ label, value: value[0] });
    } catch {
      encoded = JSON.stringify({ label, value: String(value[0]) });
    }
  }
  console.log(`${NOTE_MARKER}${encoded}`);
}

/**
 * A live connection to a launched Tug.app. Returned by
 * `launchTugApp`; tests interact with this object only.
 */
/**
 * One gesture's motion cost, as {@link App.motionCensus} reads it from
 * `deck-trace`. `byCaller` names each notifying method with its count, so
 * a release that notifies three times reports which three.
 *
 * The bar a drop-zone release is held to: `notifies === 1`, `arms <= 1`,
 * `retargets.snap === 0`.
 */
export interface MotionCensusReading {
  notifies: number;
  byCaller: Record<string, number>;
  arms: number;
  /** Arms that saw a changed signature but animated nothing. */
  armsUnarmed: number;
  retargets: { snap: number; matched: number };
}

/**
 * Render a census reading as one diagnostic line for `note()`.
 */
export function summarizeMotionCensus(
  label: string,
  c: MotionCensusReading,
): string {
  const callers = Object.entries(c.byCaller)
    .map(([k, n]) => `${k}×${n}`)
    .join(", ");
  return (
    `${label}: ${c.notifies} notify(s) [${callers}], ` +
    `${c.arms} settle arm(s) (${c.armsUnarmed} unarmed), ` +
    `retargets snap=${c.retargets.snap} matched=${c.retargets.matched}`
  );
}

export class App {
  readonly version: string;
  readonly socketPath: string;
  /**
   * Absolute path to the log file capturing this subprocess's
   * stdout/stderr, or `null` when `testName` was not provided. Tests
   * print the tail of this file on failure via `app.tailLog()`.
   */
  readonly logPath: string | null;
  private readonly rpc: RpcClient;
  private readonly subprocess: { kill: (signal?: string) => void; exited: Promise<number> };
  private readonly onUnlink: () => void;
  private readonly logStream: WriteStream | null;
  private readonly detachSignals: () => void;
  /**
   * PID of the GUI Tug.app process, reported by the app over RPC at
   * launch (`getHostPid`). `0` if the app predates that verb. `close()`
   * signals this PID directly — the app is launched via `open -n -W`,
   * so `subprocess` is the `open` wrapper, not the app; killing the
   * app by PID is the only teardown that reliably makes the window go
   * away, and unlike the registry it has no registration race.
   *
   * Public because it is also the only sound way for a test to address
   * the app process itself — e.g. a `vmmap` read of UI-side compositing
   * backing. Identifying it by arrival instead races the bundle's helper
   * executables, and `pgrep` cannot see this process at all (neither by
   * argv nor by name), so both fallbacks are traps.
   */
  readonly hostPid: number;
  /** Per-instance identity this launch ran under (`TUG_INSTANCE_ID`). */
  readonly instanceId: string;
  /** This launch's resolved options — the bundle path and instance env
   *  {@link App.seedLedger} needs to address the same ledger. */
  private readonly resolvedLaunch: ResolvedLaunch;
  private closed = false;
  /** Every screenshot path handed out, pending reclamation. */
  private readonly screenshots: string[] = [];
  /** Drops this app's pending run-end reclamation. */
  private readonly disposeRunEndReclaim: () => void;

  constructor(args: {
    rpc: RpcClient;
    version: string;
    socketPath: string;
    subprocess: { kill: (signal?: string) => void; exited: Promise<number> };
    onUnlink: () => void;
    logPath: string | null;
    logStream: WriteStream | null;
    detachSignals: () => void;
    hostPid?: number;
    instanceId: string;
    resolvedLaunch: ResolvedLaunch;
  }) {
    this.rpc = args.rpc;
    this.version = args.version;
    this.socketPath = args.socketPath;
    this.subprocess = args.subprocess;
    this.onUnlink = args.onUnlink;
    this.logPath = args.logPath;
    this.logStream = args.logStream;
    this.detachSignals = args.detachSignals;
    this.hostPid = args.hostPid ?? 0;
    this.instanceId = args.instanceId;
    this.resolvedLaunch = args.resolvedLaunch;
    // A test that never reaches `close()` (a thrown assertion, a
    // timeout) still gives its screenshots back at the end of the run.
    this.disposeRunEndReclaim = onTestRunEnd(() => this.reclaimScreenshots());
  }

  /**
   * Read this instance's quiesce report — the app's own account of its
   * last shutdown, written by `ProcessManager.stop()`. Returns `null`
   * when the app has not torn down yet (no report on disk).
   *
   * The assertion worth making on it is `sigkills.length === 0`: every
   * Tug service flushes and exits inside its own budget, so a healthy
   * teardown never escalates.
   */
  /**
   * Write rows into this instance's ledger — the way an app-test reaches a
   * **session entry** in the Changes shade.
   *
   * A `sessions` row is written by exactly one path in the product,
   * `session_init` arriving from a live tugcode subprocess, and
   * `bindSession` is a client-side binding the ledger knows nothing
   * about. Without this, an app-test can compose *unattributed* changeset
   * rows but never a session entry, which left the hunk-election
   * checkboxes, the `N of M hunks` badge, and per-row Disclaim
   * unreachable — at0253 and at0332 both record it as a wall.
   *
   * Call it **after** the app is up: tugcast demotes every `live` row to
   * `closed` once at startup (a live row with no running subprocess is
   * stale), so a row seeded before launch is swept before the first
   * compose and its files surface as `orphaned` instead.
   *
   * The aggregate recomposes on git-status movement, so touch a file
   * afterwards if nothing else in the test does.
   *
   * A `file_events` row only makes a session *own* a file when the path is
   * dirty in git, the `origin` is proof-class (`exact`/`replay` — a `bash`
   * row is a bracket hint and never an owner), and `at` post-dates the
   * path's liveness cut (its last commit).
   */
  seedLedger(spec: LedgerSeedSpec): void {
    seedLedgerForLaunch(this.resolvedLaunch, spec);
  }

  quiesceReport(): QuiesceReport | null {
    const path = join(
      homedir(),
      "Library/Application Support/Tug/instances",
      this.instanceId,
      QUIESCE_REPORT_NAME,
    );
    try {
      return JSON.parse(readFileSync(path, "utf8")) as QuiesceReport;
    } catch {
      return null;
    }
  }

  /**
   * Evaluate a JS script in Tug.app's WKWebView and return the value.
   * Server-side hard timeout default 5000ms.
   *
   * Throws:
   * - `TimeoutError` — server-side timer fired
   * - `AppCrashedError` — transport closed mid-call
   * - generic `Error` (name preserved) — script threw inside the page
   */
  evalJS<T = unknown>(script: string, opts?: EvalJsOptions): Promise<T> {
    return this.rpc.call<T>({
      method: "evalJS",
      script,
      timeoutMs: opts?.timeoutMs,
    });
  }

  /**
   * Run `gesture` and report what it cost the deck's motion machinery:
   * how many times the store notified and which methods did it, how many
   * settle arms those notifies provoked, and how each arm that landed on
   * a running tween ended it.
   *
   * The instrument is `deck-trace`'s motion census. A gesture is meant to
   * cost one notify; a release that costs three re-runs the arrangement
   * signature three times, and an arm landing mid-tween retargets it —
   * which is what flashing and hopping are made of. Recording is opt-in,
   * so the bracket enables the ring and marks it before running.
   *
   * `settleMs` is how long to let the settle land before reading; it must
   * outlast the settle window or the census reports a gesture still in
   * flight.
   */
  async motionCensus(
    gesture: () => Promise<void>,
    settleMs = 900,
  ): Promise<MotionCensusReading> {
    const mark = await this.evalJS<number>(
      `(window.__deckTrace.enable(true), window.__deckTrace.mark())`,
    );
    await gesture();
    await new Promise<void>((r) => setTimeout(r, settleMs));
    return this.evalJS<MotionCensusReading>(
      `window.__deckTrace.census(${mark})`,
    );
  }

  /**
   * Poll a JS expression on the server until it returns truthy, then
   * return that truthy value. Default poll 16ms; default overall
   * timeout 2000ms.
   *
   * Throws `TimeoutError` on budget exceeded. Prefer this over
   * `evalJS` + `setTimeout` — `setTimeout`-based waiting is banned in
   * harness / test code ([D12]).
   */
  waitForCondition<T = unknown>(
    script: string,
    opts?: WaitForConditionOptions,
  ): Promise<T> {
    return this.rpc.call<T>({
      method: "waitForCondition",
      script,
      timeoutMs: opts?.timeoutMs,
      pollMs: opts?.pollMs,
    });
  }

  /**
   * Untyped RPC call — passes `method` + `params` straight through to
   * the RPC transport. Used by `./client.ts` for the verb family that
   * doesn't round-trip JS (native gestures, AX preflight,
   * `getElementScreenBounds`). Tests should reach for the typed
   * wrappers on `App` below instead of calling this directly.
   */
  rpcCall<T = unknown>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    // Build the request object with method + params. The RPC client
    // attaches `id` and serializes. We cast to the Request union's
    // shape here — client helpers (the only callers) have already
    // validated the method/params pair against their typed signature.
    return this.rpc.call<T>({
      method,
      ...params,
    } as unknown as Parameters<RpcClient["call"]>[0]);
  }

  // -------------------------------------------------------------------
  // Typed wrappers (`TugTestSurface` / `client.ts`)
  //
  // Every method below is a thin delegate to `./client.ts`. The
  // wrapper logic — script serialization, `window.__tug` access
  // guards — lives there so the App class stays a readable facade
  // and the wire-format is unit-testable against a mock caller.
  // -------------------------------------------------------------------

  /**
   * Dispatch a full pointerdown → mousedown → pointerup → mouseup →
   * click sequence on the element matched by `selector`. Prefer this
   * over raw DOM clicks — production handlers condition on the whole
   * full synthetic click sequence.
   */
  click(selector: string, opts?: ClickOptions): Promise<void> {
    return client.click(this as HarnessCaller, selector, opts);
  }

  /**
   * Type `text` into an `<input>` / `<textarea>` using the
   * native-setter pattern.
   */
  type(selector: string, text: string): Promise<void> {
    return client.type_(this as HarnessCaller, selector, text);
  }

  /**
   * Direct `.focus()` on the element matched by `selector`. Escape
   * hatch for browser paths where synthesized pointerdown cannot
   * drive default focus ([D09] fidelity limits).
   */
  focusElement(selector: string): Promise<void> {
    return client.focusElement(this as HarnessCaller, selector);
  }

  /**
   * Granular per-axis reset ([D01]). Every axis defaults to false;
   * opt in exactly what a test case needs.
   */
  reset(opts: ResetOptions): Promise<void> {
    return client.reset(this as HarnessCaller, opts);
  }

  /**
   * Replace `DeckState` atomically and optionally merge card-state
   * bags or drive cold-boot focus restore.
   */
  /**
   * Dispatch a registered control action (`window.__tug.dispatchControlAction`)
   * and settle like any other state transition — a control action typically
   * opens / focuses / rearranges a surface, and the next gesture must not
   * land while that surface is still appearing.
   */
  dispatchControlAction(
    action: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const args =
      payload === undefined
        ? JSON.stringify(action)
        : `${JSON.stringify(action)}, ${JSON.stringify(payload)}`;
    return settleAfterStateChange(
      this.evalJS<void>(`window.__tug.dispatchControlAction(${args})`),
    );
  }

  seedDeckState(args: SeedDeckStateArgs): Promise<void> {
    return settleAfterStateChange(
      client.seedDeckState(this as HarnessCaller, args),
    );
  }

  /** Read the deck's current active card (first-responder). */
  getActiveCardId(): Promise<string | null> {
    return client.getActiveCardId(this as HarnessCaller);
  }

  /** Read the deck's current focused card id. */
  getFocusedCardId(): Promise<string | null> {
    return client.getFocusedCardId(this as HarnessCaller);
  }

  /** Read the caret / selection snapshot for `cardId`. */
  getCaretState(cardId: string): Promise<CaretState | null> {
    return client.getCaretState(this as HarnessCaller, cardId);
  }

  /** Read a persisted form-control's value by its persist key. */
  getFormControlValue(
    cardId: string,
    componentStatePreservationKey: string,
  ): Promise<string | null> {
    return client.getFormControlValue(this as HarnessCaller, cardId, componentStatePreservationKey);
  }

  /** `true` iff the deck has registered a card-host root for `cardId`. */
  assertHostRootRegistered(cardId: string): Promise<boolean> {
    return client.assertHostRootRegistered(this as HarnessCaller, cardId);
  }

  /** Pull the DeckTrace ring; `since` filters by `seq > that`. */
  getDeckTrace(opts?: { since?: number }): Promise<readonly DeckTraceEvent[]> {
    return client.getDeckTrace(this as HarnessCaller, opts);
  }

  /** Stamp the trace sequence counter; pair with `getDeckTrace({ since })`. */
  markDeckTrace(): Promise<number> {
    return client.markDeckTrace(this as HarnessCaller);
  }

  /** Drop all buffered trace events. Preserves the enable flag. */
  clearDeckTrace(): Promise<void> {
    return client.clearDeckTrace(this as HarnessCaller);
  }

  /** Toggle trace recording on / off. */
  enableDeckTrace(flag: boolean): Promise<void> {
    return client.enableDeckTrace(this as HarnessCaller, flag);
  }

  /**
   * Block until `getFocusedCardId() === cardId`. Wraps
   * `waitForCondition`; default budget 2000ms (override via `opts`).
   * Throws `TimeoutError` on budget exceeded.
   */
  expectFocusedCard(
    cardId: string,
    opts?: WaitForConditionOptions,
  ): Promise<void> {
    return client.expectFocusedCard(this as HarnessCaller, cardId, opts);
  }

  /**
   * Block until `getCaretState(cardId)` deep-equals `expected`
   * (compared via server-side `JSON.stringify`). Wraps
   * `waitForCondition`; throws `TimeoutError` on budget exceeded.
   */
  expectCaret(
    cardId: string,
    expected: CaretState,
    opts?: WaitForConditionOptions,
  ): Promise<void> {
    return client.expectCaret(this as HarnessCaller, cardId, expected, opts);
  }

  // -------------------------------------------------------------------
  // Introspection (SURFACE_VERSION 1.1.0)
  // -------------------------------------------------------------------

  /** Read `textContent` (or `.value` for form controls) of `selector`. */
  getElementText(selector: string): Promise<string> {
    return client.getElementText(this as HarnessCaller, selector);
  }

  /** Read `.value` of an `<input>` / `<textarea>` / `<select>`. */
  getElementValue(selector: string): Promise<string> {
    return client.getElementValue(this as HarnessCaller, selector);
  }

  /** Read an attribute; `null` when unset. */
  getElementAttribute(
    selector: string,
    name: string,
  ): Promise<string | null> {
    return client.getElementAttribute(this as HarnessCaller, selector, name);
  }

  /** Viewport-relative bounds for `selector`. */
  getElementBounds(selector: string): Promise<ElementBounds> {
    return client.getElementBounds(this as HarnessCaller, selector);
  }

  /**
   * Screen-CG bounds for `selector` — computed Swift-side via
   * `CoordMapping`. Use when a test wants to name an exact pixel in
   * screen space (e.g. for a subsequent `nativeClick`); prefer
   * `nativeClickAtElement(selector)` when you only need "click this".
   */
  getElementScreenBounds(selector: string): Promise<ScreenRect> {
    return client.getElementScreenBounds(this as HarnessCaller, selector);
  }

  /**
   * Full recursive snapshot of the native main menu, each item carrying
   * its *validated* enabled state (the `NSMenuItemValidation` outcome
   * AppKit computes at open / key-equivalent time).
   */
  menuSnapshot(): Promise<MenuItemSnapshot[]> {
    return client.menuSnapshot(this as HarnessCaller);
  }

  /**
   * Validated state of one native menu item by its
   * `NSUserInterfaceItemIdentifier` (e.g. `"file.closeCard"`,
   * `"file.closeAllCardTabs"`). Returns `{ found: false }` when absent.
   */
  menuItemState(identifier: string): Promise<MenuItemState> {
    return client.menuItemState(this as HarnessCaller, identifier);
  }

  /**
   * Capture the app's WKWebView as a PNG (written to a temp file) and
   * return its path. Uses `WKWebView.takeSnapshot` — captures rendered
   * web content directly, no Screen Recording permission.
   *
   * The harness owns the file: every shot is unlinked when the app
   * closes, and again at the end of the run. Swift wrote these and
   * nobody deleted them, which is how 121 MB of PNGs accumulated. A
   * test that wants to keep a shot must read or copy it before
   * `close()` — or the whole run can be told to keep them with
   * `TUGAPP_KEEP_SCREENSHOTS=1`, which is what to set when a logged
   * shot path is meant to be opened by a human afterwards.
   */
  async screenshot(): Promise<{ path: string }> {
    const shot = await client.screenshot(this as HarnessCaller);
    this.screenshots.push(shot.path);
    return shot;
  }

  /** Unlink every screenshot this app handed out. Idempotent. */
  private reclaimScreenshots(): void {
    const paths = this.screenshots.splice(0);
    if (process.env.TUGAPP_KEEP_SCREENSHOTS === "1") {
      for (const path of paths) console.log(`[harness] kept screenshot: ${path}`);
      return;
    }
    for (const path of paths) {
      try {
        unlinkSync(path);
      } catch {
        // already gone
      }
    }
  }

  /** Compact state bundle: tagName, disabled, readOnly, checked, visible, isFocused. */
  getElementState(selector: string): Promise<ElementStateSnapshot> {
    return client.getElementState(this as HarnessCaller, selector);
  }

  /** Describe `document.activeElement`; `null` when `body` is active. */
  getActiveElement(): Promise<ActiveElementInfo | null> {
    return client.getActiveElement(this as HarnessCaller);
  }

  /**
   * Read the current selection. With `cardId`, scoped to that card's
   * host subtree (matches `getCaretState` shape but adds
   * contentEditable ranges). Without, page-wide.
   */
  getSelection(cardId?: string): Promise<SelectionSnapshot | null> {
    return client.getSelection(this as HarnessCaller, cardId);
  }

  /** Resolved CSS value for `property` on `selector`. */
  getComputedStyleValue(
    selector: string,
    property: string,
  ): Promise<string> {
    return client.getComputedStyleValue(
      this as HarnessCaller,
      selector,
      property,
    );
  }

  /**
   * Register `selector` as a selection boundary under `cardId`.
   * Mirrors what a real card does via `useSelectionBoundary` on
   * mount. Tests that inject ad-hoc fixture overlays outside of a
   * real card need this so tugdeck's `selectionGuard.handleSelectStart`
   * doesn't preventDefault their drag-selections.
   */
  registerSelectionBoundary(
    cardId: string,
    selector: string,
  ): Promise<void> {
    return client.registerSelectionBoundary(
      this as HarnessCaller,
      cardId,
      selector,
    );
  }

  /** Inverse of {@link App.registerSelectionBoundary}. */
  unregisterSelectionBoundary(cardId: string): Promise<void> {
    return client.unregisterSelectionBoundary(this as HarnessCaller, cardId);
  }

  // -------------------------------------------------------------------
  // EM-card observation (tugdeck SURFACE_VERSION 1.2.0)
  // -------------------------------------------------------------------

  /**
   * Read an EM card's engine state. `null` when the card is
   * unknown or is not an EM card (no `bag.content` from an
   * onSave-returning-engine-state factory). The page-side surface
   * forces a save before reading, so the returned state reflects
   * current engine content rather than a stale debounced save.
   */
  getEmCardState(cardId: string): Promise<client.EmCardState | null> {
    return client.getEmCardState(this as HarnessCaller, cardId);
  }

  /** Synchronous probe: has `engine-ready` been recorded for `cardId`? */
  isEngineReady(cardId: string): Promise<boolean> {
    return client.isEngineReady(this as HarnessCaller, cardId);
  }

  /**
   * Block until the engine for `cardId` has emitted `engine-ready`,
   * or until `timeoutMs` (default 2000ms) elapses. Throws
   * `TimeoutError` on budget exceeded.
   */
  awaitEngineReady(
    cardId: string,
    opts?: WaitForConditionOptions,
  ): Promise<void> {
    return client.awaitEngineReady(this as HarnessCaller, cardId, opts);
  }

  /**
   * Bind a fake session for a session-card so its content factory
   * renders SessionCardBody (the editor) instead of the project-picker.
   * Production binds via `spawn_session_ok` from a live
   * tugcast/tugcode/Claude pipeline; the harness writes synthetic
   * values directly into the binding store. Use whenever a test
   * needs to interact with a session-card's editor (focus, selection,
   * typing) — the AI-facing stores stay empty, but the editor
   * mounts and accepts user-shaped gestures.
   */
  bindSession(
    cardId: string,
    options?: {
      tugSessionId?: string;
      /**
       * The line of work the card is seated on ([P01]). Defaults to
       * `tugSessionId` — a line of one, the same fallback the identity stores
       * take. Pass it when the ledger holds several segments on one line and
       * the test needs the card bound to the line they share.
       */
      lineId?: string;
      workspaceKey?: string;
      projectDir?: string;
      /**
       * `"new" | "resume"` — defaults to `"new"`. Threaded through
       * to `cardSessionBindingStore.setBinding` and onward to
       * `CodeSessionSnapshot.sessionMode`. Pass `"resume"` for tests
       * that exercise resume-path behavior (preflight banner,
       * replay-loading copy, etc.).
       */
      sessionMode?: "new" | "resume";
    },
  ): Promise<void> {
    return settleAfterStateChange(
      client.bindSession(this as HarnessCaller, cardId, options),
    );
  }

  /**
   * Fire a REAL `spawn_session(mode=resume)` over the live connection so
   * tugcast spawns a genuine tugcode `--resume` that replays the on-disk
   * JSONL through the `CODE_OUTPUT → SESSION_METADATA` fan-out into the
   * card's `SessionMetadataStore`. The only verb that drives the true
   * cold-replay delivery chain (vs. `bindSession`'s synthetic binding or
   * `ingestSessionMetadata`'s injected frame). Place the fixture JSONL at
   * `~/.claude/projects/<encode(projectDir)>/<tugSessionId>.jsonl` first.
   */
  spawnSessionResume(
    cardId: string,
    opts: { tugSessionId: string; projectDir: string },
  ): Promise<void> {
    return client.spawnSessionResume(this as HarnessCaller, cardId, opts);
  }

  /**
   * Drive a bound session card's `CodeSessionStore` one step through the
   * lifecycle matrix — `send` a user message, `ingestFrame` a decoded
   * wire frame, `interrupt`, or drive the transport overlay. The card
   * must be bound first (`bindSession`). Frames flow through the
   * store's real `frameToEvent` → `dispatch` path.
   */
  driveSession(
    cardId: string,
    action: client.SessionDriveAction,
    opts?: EvalJsOptions,
  ): Promise<void> {
    return client.driveSession(this as HarnessCaller, cardId, action, opts);
  }

  /**
   * Drop the real WebSocket and let the app recover on its own.
   *
   * Unlike `driveSession(..., {op: "transportClose"})` — which only
   * dispatches into one card's reducer — this runs the whole path the
   * user experiences: the close, the reconnect backoff, the disposal
   * of every card's services bag, and the restore that rebuilds them.
   */
  connectionClose(opts?: EvalJsOptions): Promise<boolean> {
    return client.connectionClose(this as HarnessCaller, opts);
  }

  /**
   * Drive the app-level, account-global rate-limit store — mounts / clears
   * the single deck-wide rate-limit banner ([#step-3.5]).
   */
  ingestRateLimit(info: client.RateLimitInfo): Promise<void> {
    return client.ingestRateLimit(this as HarnessCaller, info);
  }

  /**
   * Drive a session card's `SessionMetadataStore` with a decoded
   * `session_capabilities` / `system_metadata` payload ([#step-4]) — mounts
   * the Z4B effort chip and flips its model gate without a live claude
   * handshake. Requires a prior `bindSession(cardId)`.
   */
  ingestSessionMetadata(cardId: string, payload: unknown): Promise<void> {
    return client.ingestSessionMetadata(this as HarnessCaller, cardId, payload);
  }

  /**
   * Settle a session card's `SideQuestionStore` with a decoded
   * `side_question_answer` payload so the `/btw` overlay renders its answer
   * without a live claude round-trip (and the transcript can be asserted
   * clean). The payload `request_id` must match a pending ask. Requires a
   * prior `bindSession(cardId)`.
   */
  ingestSideQuestionAnswer(cardId: string, payload: unknown): Promise<void> {
    return client.ingestSideQuestionAnswer(this as HarnessCaller, cardId, payload);
  }

  // -------------------------------------------------------------------
  // Accessibility preflight ([D03])
  // -------------------------------------------------------------------

  /**
   * Probe TCC for the Accessibility grant on the launched Tug.app
   * binary. Returns `{ trusted, bundlePath, bundleId }`.
   *
   * `launchTugApp` calls this automatically as the last step of the
   * handshake and throws `AccessibilityPermissionMissingError` on
   * denial — tests rarely need to invoke it directly. Expose it here
   * so a test that toggles the grant mid-run (via `tccutil reset`
   * + re-grant through System Settings) can re-check without
   * re-spawning.
   */
  checkAccessibilityPermission(opts?: {
    prompt?: boolean;
  }): Promise<AccessibilityStatus> {
    return client.checkAccessibilityPermission(this as HarnessCaller, opts);
  }

  // -------------------------------------------------------------------
  // Native gestures (Phase A, [D02] trusted CGEvent posts)
  // -------------------------------------------------------------------

  /** Single trusted click at a viewport point. */
  nativeClick(
    viewportPoint: ViewportPoint,
    opts?: NativeClickOptions,
  ): Promise<void> {
    return client.nativeClick(this as HarnessCaller, viewportPoint, opts);
  }

  /** Single trusted click at the center of `selector`. */
  nativeClickAtElement(
    selector: string,
    opts?: NativeClickOptions,
  ): Promise<void> {
    return client.nativeClickAtElement(this as HarnessCaller, selector, opts);
  }

  /**
   * Reveal a pane's rollup — the `⋯` row holding the card's own verbs, the
   * assorted-commands menu, bullseye and the width control.
   *
   * Those controls rest hidden and reveal when the pointer enters the title
   * bar, so a test that clicks one directly clicks through a
   * `pointer-events: none` overlay and lands a drag on the bar instead.
   *
   * This dispatches the same `pointerenter` a real pointer raises, at the bar
   * the product listens on. It is not a test-only door: the product reads
   * `pointerenter`/`pointerleave` rather than the `:hover` pseudo-class for
   * exactly this reason — a pseudo-class is decided by WebKit's hit-testing
   * against the physical cursor, which a background app-test has no business
   * moving and, in a non-key window, cannot usefully move anyway.
   *
   * The reveal SURVIVES what a test does next: `pointerleave` fires only when
   * the pointer exits the bar and every descendant, and the revealed row is a
   * descendant. Use {@link concealPaneControls} to end it deliberately.
   *
   * `paneSelector` scopes it to one pane; omitted, it takes the first title
   * bar in the document. A pane with no rollup resolves to a no-op.
   */
  async revealPaneControls(paneSelector = ""): Promise<void> {
    const scope = paneSelector === "" ? "" : `${paneSelector} `;
    const bar = `${scope}[data-testid="tug-pane-title-bar"]`;
    const rollup = `${scope}[data-testid="tug-pane-title-bar-rollup"]`;
    const present = await this.evalJS<boolean>(
      `document.querySelector(${JSON.stringify(rollup)}) !== null`,
    );
    if (!present) return;
    await this.evalJS<null>(
      `(function(){
         var bar=document.querySelector(${JSON.stringify(bar)});
         if(bar===null) throw new Error("no title bar at " + ${JSON.stringify(bar)});
         bar.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
         return null;
       })()`,
    );
    await this.waitForCondition(
      `(function(){
         var r=document.querySelector(${JSON.stringify(rollup)});
         if(r===null) return false;
         var row=r.querySelector('[data-testid="tug-pane-title-bar-rollup-row"]');
         return row!==null && window.getComputedStyle(row).pointerEvents!=='none';
       })()`,
      { timeoutMs: 4_000 },
    );
  }

  /**
   * Take the pointer back off a pane's title bar — the other half of
   * {@link revealPaneControls}, for asserting what holds the row open once
   * the hover is gone.
   */
  async concealPaneControls(paneSelector = ""): Promise<void> {
    const scope = paneSelector === "" ? "" : `${paneSelector} `;
    const bar = `${scope}[data-testid="tug-pane-title-bar"]`;
    await this.evalJS<null>(
      `(function(){
         var bar=document.querySelector(${JSON.stringify(bar)});
         if(bar!==null) bar.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false }));
         return null;
       })()`,
    );
  }

  /** Double click at a viewport point (pinned inter-click interval). */
  nativeDoubleClick(
    viewportPoint: ViewportPoint,
    opts?: { button?: NativeMouseButton },
  ): Promise<void> {
    return client.nativeDoubleClick(this as HarnessCaller, viewportPoint, opts);
  }

  /** Double click at the center of `selector`. */
  nativeDoubleClickAtElement(
    selector: string,
    opts?: { button?: NativeMouseButton },
  ): Promise<void> {
    return client.nativeDoubleClickAtElement(
      this as HarnessCaller,
      selector,
      opts,
    );
  }

  /** Right-button single click at a viewport point. */
  nativeRightClick(viewportPoint: ViewportPoint): Promise<void> {
    return client.nativeRightClick(this as HarnessCaller, viewportPoint);
  }

  /** Right-button single click at the center of `selector`. */
  nativeRightClickAtElement(selector: string): Promise<void> {
    return client.nativeRightClickAtElement(this as HarnessCaller, selector);
  }

  /** Endpoint-only drag (mouseDown → one drag → mouseUp). */
  nativeDrag(
    from: ViewportPoint,
    to: ViewportPoint,
    opts?: NativeDragOptions,
  ): Promise<void> {
    return client.nativeDrag(this as HarnessCaller, from, to, opts);
  }

  /**
   * Element-anchored drag. `to` may be a viewport point or another
   * selector — handy for card-to-card drag assertions.
   */
  nativeDragElement(
    fromSelector: string,
    to: ViewportPoint | { selector: string },
    opts?: NativeDragOptions,
  ): Promise<void> {
    return client.nativeDragElement(
      this as HarnessCaller,
      fromSelector,
      to,
      opts,
    );
  }

  /**
   * Trail-only drag — same trail as {@link nativeDrag}, no terminal
   * `mouseUp`. Pair with {@link nativeMouseUp} to release. See
   * `client.nativeDragWithoutRelease` for the canonical
   * mid-drag-Escape compose pattern.
   */
  nativeDragWithoutRelease(
    from: ViewportPoint,
    to: ViewportPoint,
    opts?: NativeDragOptions,
  ): Promise<void> {
    return client.nativeDragWithoutRelease(
      this as HarnessCaller,
      from,
      to,
      opts,
    );
  }

  /** Element-anchored variant of {@link nativeDragWithoutRelease}. */
  nativeDragElementWithoutRelease(
    fromSelector: string,
    to: ViewportPoint | { selector: string },
    opts?: NativeDragOptions,
  ): Promise<void> {
    return client.nativeDragElementWithoutRelease(
      this as HarnessCaller,
      fromSelector,
      to,
      opts,
    );
  }

  /** Bare mouseDown primitive — for unusual sequences. Prefer `nativeClick`. */
  nativeMouseDown(
    viewportPoint: ViewportPoint,
    opts?: { button?: NativeMouseButton },
  ): Promise<void> {
    return client.nativeMouseDown(this as HarnessCaller, viewportPoint, opts);
  }

  /** Bare mouseUp primitive — for unusual sequences. */
  nativeMouseUp(
    viewportPoint: ViewportPoint,
    opts?: { button?: NativeMouseButton },
  ): Promise<void> {
    return client.nativeMouseUp(this as HarnessCaller, viewportPoint, opts);
  }

  // -------------------------------------------------------------------
  // Native keyboard
  // -------------------------------------------------------------------

  /** Post a single keystroke with optional modifiers. */
  nativeKey(
    key: string,
    modifiers?: readonly NativeModifier[],
  ): Promise<void> {
    return client.nativeKey(this as HarnessCaller, key, modifiers);
  }

  /** Type ASCII text (non-ASCII is rejected with a typed error). */
  nativeType(text: string): Promise<void> {
    return client.nativeType(this as HarnessCaller, text);
  }

  /**
   * Hold `modifiers` down for the duration of `body`, which CAN introspect
   * the app (unlike `holdModifier`'s buffered thunk). For assertions about
   * what a held modifier looks like — the chord ring's dashed→solid flip.
   */
  withModifiersHeld(
    modifiers: readonly NativeModifier[],
    body: () => Promise<void>,
  ): Promise<void> {
    return client.withModifiersHeld(this as HarnessCaller, modifiers, body);
  }

  // -------------------------------------------------------------------
  // App-lifecycle simulation ([D07])
  //
  // Each method invokes the matching `NSApp` primitive on Tug.app's
  // main thread and awaits the corresponding
  // `NSApplication.did...Notification`. The real `AppDelegate`
  // forwards the lifecycle event to tugdeck via an `app-lifecycle`
  // control frame, so observers downstream (selection guard,
  // deck.saveAndFlush, etc.) see exactly what they would in a manual
  // run. On miss, throws `AppLifecycleTimeoutError`.
  // -------------------------------------------------------------------

  /** `NSApp.deactivate()`; awaits `applicationDidResignActive:`. */
  simulateAppResign(opts?: client.AppLifecycleOptions): Promise<void> {
    return client.simulateAppResign(this as HarnessCaller, opts);
  }

  /**
   * `NSApp.activate(ignoringOtherApps: true)`; awaits
   * `applicationDidBecomeActive:`. Useful as the second half of a
   * resign/return cycle to verify post-activation reactivation.
   */
  simulateAppBecomeActive(opts?: client.AppLifecycleOptions): Promise<void> {
    return client.simulateAppBecomeActive(this as HarnessCaller, opts);
  }

  /** `NSApp.hide(nil)`; awaits `applicationDidHide:`. */
  simulateAppHide(opts?: client.AppLifecycleOptions): Promise<void> {
    return client.simulateAppHide(this as HarnessCaller, opts);
  }

  /** `NSApp.unhide(nil)`; awaits `applicationDidUnhide:`. */
  simulateAppUnhide(opts?: client.AppLifecycleOptions): Promise<void> {
    return client.simulateAppUnhide(this as HarnessCaller, opts);
  }

  /**
   * Quit Tug.app via the full `applicationShouldTerminate` path
   * (so `window.tugdeck.saveState()` fires + tugcast PUTs flush to
   * tugbank disk before the process exits). Distinct from
   * {@link App.close} which SIGTERMs immediately and bypasses the
   * save trigger.
   *
   * The Swift handler schedules `NSApp.terminate(nil)` on main and
   * returns; we await `subprocess.exited` for the actual signal
   * that the OS killed the process. The default exit window is
   * 10s — long enough for a slow tugcast PUT chain, short enough
   * that a stuck quit fails loudly.
   *
   * After this call resolves, the `App` instance is closed; further
   * RPCs will throw `AppCrashedError`. Calling `close()` afterward
   * is a no-op.
   */
  async quitGracefully(opts?: { timeoutMs?: number }): Promise<void> {
    if (this.closed) return;
    // Fire the RPC. The Swift handler writes its `ok` response BEFORE
    // scheduling the terminate, so under normal flow the call resolves
    // cleanly. If the kernel buffer hasn't drained the response by the
    // time `testHarnessBridge.close()` runs, the rpc client surfaces
    // `AppCrashedError` instead — both outcomes mean "quit was
    // accepted", so we treat them identically.
    const params: Record<string, unknown> = {};
    if (opts?.timeoutMs !== undefined) params.timeoutMs = opts.timeoutMs;
    void this.rpcCall<void>("quitGracefully", params).catch(() => {
      // Swallow — the connection drops mid-quit by design.
    });
    // Bound on the actual process exit. The graceful path runs
    // saveAndFlushSync (sync XHR per card) + processManager.stop's
    // 5s tugcast grace; 10s is comfortably above that.
    const timeoutMs = opts?.timeoutMs ?? 10000;
    const exitedPromise = this.subprocess.exited.then(() => "exited" as const);
    const timeoutPromise = new Promise<"timeout">((resolve) =>
      setTimeoutNative(() => resolve("timeout"), timeoutMs),
    );
    const winner = await Promise.race([exitedPromise, timeoutPromise]);
    if (winner === "timeout") {
      // App didn't exit on its own. Fall back to the SIGKILL teardown
      // in close() and surface a clear error.
      await this.close();
      throw new Error(
        `quitGracefully: subprocess did not exit within ${timeoutMs}ms`,
      );
    }
    // Process exited cleanly. Run the same teardown close() does so
    // log streams + signal handlers + socket file all unwind.
    this.closed = true;
    try { this.onUnlink(); } catch { /* socket already gone */ }
    this.reclaimScreenshots();
    this.disposeRunEndReclaim();
    try { this.logStream?.end(); } catch { /* best-effort */ }
    try { this.detachSignals(); } catch { /* best-effort */ }
  }

  /**
   * Soft-reload Tug.app — same code path as the `Maker > Reload`
   * menu, exercising the in-process save-flush + WKWebView reload
   * (Tug.app and tugcast both survive). Distinct from
   * {@link App.quitGracefully} which terminates the entire process.
   *
   * Sequence:
   *   1. Read the current `__tug.getReadyGen()` value (a counter
   *      `attachTugTestSurface` bumps on every page boot, persisted
   *      across reload via `sessionStorage`).
   *   2. Fire `__tug.appReload()` — invokes
   *      `dispatchAction({action:"reload"})`, which routes through
   *      the `action-dispatch.ts:registerAction("reload",...)` handler
   *      that calls `prepareForReload` (synchronous flush via XHR to
   *      tugcast) before `location.reload()`. This `evalJS` may
   *      resolve cleanly OR error mid-navigation; both outcomes mean
   *      the reload is in flight.
   *   3. Poll `getReadyGen()` until it returns a value strictly
   *      greater than the pre-reload read — the deterministic "new
   *      page is up and `__tug` is online again" signal. The poll is
   *      tolerant of transient `evalJS` errors during navigation.
   *
   * Default timeout 8000ms — covers a slow tugcast PUT chain plus
   * WKWebView reload + `main.tsx` boot. Throws on timeout with the
   * captured pre-reload generation in the message so flake
   * triage can distinguish "trigger never landed" (gen never
   * advanced) from "appReload completed but late" (timeout race).
   *
   * The reload trigger uses the `prepareForReload` path: every save
   * callback drains and flushes synchronously to tugbank before navigation.
   */
  async appReload(opts?: { timeoutMs?: number }): Promise<void> {
    const timeoutMs = opts?.timeoutMs ?? 8000;
    const pollMs = 100;

    // Read the pre-reload generation. Fall back to 0 when `__tug` /
    // `getReadyGen` aren't present so old surface versions surface
    // as a clean "fresh attach" rather than a thrown EvalError.
    const prev = await this.evalJS<number>(
      `((typeof window.__tug !== "undefined" && typeof window.__tug.getReadyGen === "function") ? window.__tug.getReadyGen() : 0)`,
    );

    // Fire the reload. The script runs synchronously (just calls
    // `dispatchAction`), but `prepareForReload` runs in a microtask
    // chain that completes BEFORE the actual `location.reload()`.
    // Either evaluation completes cleanly OR errors when navigation
    // invalidates the page; both outcomes are "reload in flight".
    await this.evalJS<unknown>(
      `((window.__tug && typeof window.__tug.appReload === "function") ? (window.__tug.appReload(), null) : null)`,
    ).catch(() => {
      // Mid-navigation evalJS may surface as EvalError or
      // AppCrashedError. The reload itself is what we want; swallow.
    });

    // Custom poll loop — `waitForCondition`'s server-side polling
    // treats `evaluateJavaScript` errors as fatal, but transient
    // errors are EXPECTED here as the page navigates. Bun-side
    // polling lets us tolerate them.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const gen = await this.evalJS<number>(
          `((typeof window.__tug !== "undefined" && typeof window.__tug.getReadyGen === "function") ? window.__tug.getReadyGen() : 0)`,
        );
        if (gen > prev) return;
      } catch {
        // Page in mid-navigation — keep polling.
      }
      await new Promise<void>((resolve) =>
        setTimeoutNative(() => resolve(), pollMs),
      );
    }
    throw new Error(
      `appReload: __tug did not re-attach within ${timeoutMs}ms (pre-reload gen=${prev})`,
    );
  }

  // -------------------------------------------------------------------
  // Tugcode subprocess lifecycle ([D04])
  //
  // Spawn and kill a harness-owned tugcode child. At most one tugcode
  // child per harness
  // connection; a second `startTugcode` while one is running
  // throws `TugcodeLaunchError`.
  // -------------------------------------------------------------------

  /**
   * Spawn a tugcode subprocess. Returns `{ pid }`. The Swift handler
   * resolves the binary path from `opts.binaryPath` first, then the
   * `TUGAPP_TUGCODE_BINARY` env var; missing both throws
   * `TugcodeLaunchError`.
   *
   * Stdout/stderr go to `opts.logFilePath` (truncated on open) or
   * `/dev/null` when unset. Tests that want to inspect tugcode's
   * output should pass an absolute log path under
   * `tests/app-test/logs/`.
   */
  startTugcode(opts: client.StartTugcodeOptions): Promise<client.StartTugcodeResult> {
    return client.startTugcode(this as HarnessCaller, opts);
  }

  /**
   * SIGTERM the tugcode child, wait up to 2000ms for graceful exit,
   * SIGKILL on timeout. Idempotent — calling on a non-running
   * harness is a no-op.
   */
  stopTugcode(): Promise<void> {
    return client.stopTugcode(this as HarnessCaller);
  }

  /**
   * Append a single JSON IPC frame to tugcode's stdin. The Swift
   * handler tacks on the newline. Use this to drive the tugcode
   * IPC loop directly in stub-replay tests (`protocol_init`,
   * `user_message`, etc.). Caller `JSON.stringify`s the object
   * client-side; the wire-passed string is forwarded as-is.
   */
  writeTugcodeStdin(line: string): Promise<void> {
    return client.writeTugcodeStdin(this as HarnessCaller, line);
  }

  /**
   * Run `thunk` with `modifiers` held down. Inner `app.native*` calls
   * inside the thunk buffer into a single atomic `holdModifier` RPC
   * — Swift presses modifiers, dispatches inner verbs, releases.
   * See `client.holdModifier` for constraints (no `evalJS` or
   * `waitForCondition` inside the thunk; no nested scopes).
   */
  holdModifier(
    modifiers: readonly NativeModifier[],
    thunk: (inner: HarnessCaller) => Promise<void>,
  ): Promise<void> {
    return client.holdModifier(this as HarnessCaller, modifiers, thunk);
  }

  /**
   * Return the last `lines` lines of the captured log file. Returns
   * an empty string when log capture is disabled (i.e. `testName`
   * was not provided). Convenience for `catch` blocks:
   *
   *     try { ... } catch (e) {
   *       console.error(await app.tailLog(50));
   *       throw e;
   *     }
   *
   * `lines` defaults to 50.
   * The file is read synchronously because this is a failure path —
   * we'd rather block the test teardown than lose output to a race.
   */
  tailLog(lines = 50): string {
    if (!this.logPath) return "";
    let content: string;
    try {
      content = readFileSync(this.logPath, "utf8");
    } catch {
      return "";
    }
    const all = content.split("\n");
    // If the file ends with a newline, split yields a trailing "" we
    // want to drop; otherwise the last element is the final partial line.
    const withoutTrailingEmpty =
      all.length > 0 && all[all.length - 1] === ""
        ? all.slice(0, -1)
        : all;
    const tail = withoutTrailingEmpty.slice(-lines);
    return tail.join("\n");
  }

  /**
   * Dump the full deck trace to `path` as pretty-printed JSON. For
   * use in `catch` blocks that need the trace as a post-mortem
   * artifact — most useful when a test fails before its main
   * assertion can read and pretty-print the trace inline (e.g.
   * `TimeoutError` from `waitForCondition` has nothing to print).
   *
   *     try { ... } catch (e) {
   *       await app.dumpTraceToFile(`tests/app-test/logs/${testName}-trace.json`);
   *       throw e;
   *     }
   *
   * Swallows I/O and RPC errors — this is a failure path, and a
   * secondary error from the dump must not mask the primary
   * assertion failure. Returns the path on success, null on
   * failure. Parent directories are created as needed.
   */
  async dumpTraceToFile(path: string): Promise<string | null> {
    try {
      const trace = await client.getDeckTrace(this as HarnessCaller, {});
      mkdirSync(dirname(pathResolve(path)), { recursive: true });
      writeFileSync(pathResolve(path), JSON.stringify(trace, null, 2));
      return path;
    } catch {
      return null;
    }
  }

  /**
   * SIGTERM the subprocess, wait out the shared `tug-quiesce` teardown
   * deadline for exit, SIGKILL on timeout. Unlinks the socket file,
   * flushes the log stream, and detaches process-level signal handlers.
   * Idempotent.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Primary teardown: signal the GUI Tug.app process by PID. The app
    // has no SIGTERM handler, so SIGTERM ends it promptly, and its
    // tugcast child then self-exits via its parent-watch. Killing the
    // app (the parent) — not tugcast (the child) — is what actually
    // makes the window disappear. Doing it by PID is race-free: it
    // works even before tugcast has registered in the instance
    // registry, which the registry-based `tugutil host instance stop` path
    // (below) can miss for a fast test.
    if (this.hostPid > 0) {
      try {
        processKillNative(this.hostPid, "SIGTERM");
      } catch {
        // already dead
      }
    }
    // Belt-and-suspenders: the wrapped kill runs `tugutil host instance
    // stop` (clears any stale registry entry + tugcast) and SIGTERMs
    // the `open -W` wrapper so its `.exited` resolves.
    try {
      this.subprocess.kill("SIGTERM");
    } catch {
      // already exited; fall through to unlink
    }
    const exitPromise = this.subprocess.exited.catch(() => 0);
    const timeout = new Promise<"timeout">((resolve) =>
      setTimeoutNative(() => resolve("timeout"), QUIESCE_TEARDOWN_DEADLINE_MS),
    );
    const winner = await Promise.race([exitPromise, timeout]);
    if (winner === "timeout") {
      if (this.hostPid > 0) {
        try {
          processKillNative(this.hostPid, "SIGKILL");
        } catch {
          // already dead
        }
      }
      try {
        this.subprocess.kill("SIGKILL");
      } catch {
        // already dead
      }
      await exitPromise;
    }
    try {
      this.onUnlink();
    } catch {
      // already gone; ignore
    }
    this.reclaimScreenshots();
    this.disposeRunEndReclaim();
    // Close the log stream after the subprocess has exited; its pipe
    // writer will have flushed whatever tail it produced by then.
    try {
      this.logStream?.end();
    } catch {
      // best-effort
    }
    // Detach signal handlers — closing a specific App must not leak
    // SIGINT/SIGTERM listeners past its lifetime.
    try {
      this.detachSignals();
    } catch {
      // best-effort
    }
  }
}

/**
 * Spawn a Tug.app debug build, connect to its test harness socket,
 * handshake on version, return an `App` handle.
 *
 * The `setTimeout` / `setInterval` ban ([D12]) applies to test files
 * and to wrappers we expose over the RPC surface; the harness itself
 * owns timing for subprocess lifecycle (connect backoff, SIGTERM
 * grace window). We use the native scheduler here because there is
 * no truthy-polling primitive available yet.
 */
export async function launchTugApp(
  opts: LaunchTugAppOptions = {},
): Promise<App> {
  const resolved = resolveLaunchOptions(opts);

  // Open the per-test log file BEFORE spawn so the writer is ready
  // when the first subprocess bytes arrive. `null` when testName is
  // unset — stdout/stderr are then piped but not tee'd to disk.
  const logStream = openLogStream(resolved.logPath);

  // Spawn Tug.app. Bun's subprocess API is awaited for `.exited`.
  const subprocess = spawnTugApp(resolved);

  // Pipe subprocess stdout/stderr into the log file. The Bun.spawn
  // configuration asks for "pipe" on both streams so they return
  // `ReadableStream<Uint8Array>`; we drain them asynchronously.
  if (logStream) {
    void pumpToLog(subprocess.stdout, logStream);
    void pumpToLog(subprocess.stderr, logStream);
  }

  // Register a last-resort unlink in case the harness is killed
  // before `app.close()` runs. Both hooks: `process.on("exit")` covers
  // a non-test-runner host, and `onTestRunEnd` is the one that actually
  // fires under `bun test` — where the exit event never does, which is
  // why 45 of these sockets were sitting in `$TMPDIR`.
  let disposeSocketUnlink: (() => void) | undefined;
  const onExitUnlink = () => {
    try {
      unlinkSync(resolved.socketPath);
    } catch {
      // already gone
    }
    // Once the socket is reclaimed the pending task is dead weight —
    // drop it so a test file with many launches doesn't accumulate one
    // per launch.
    disposeSocketUnlink?.();
    disposeSocketUnlink = undefined;
    process.off("exit", onExitUnlink);
  };
  process.on("exit", onExitUnlink);
  disposeSocketUnlink = onTestRunEnd(onExitUnlink);

  // Install SIGINT / SIGTERM / exit handlers so a Ctrl-C at the
  // runner or an unexpected exit cleans up the subprocess instead
  // of leaving it orphaned. `detachSignals` is called by
  // `App.close()` so these handlers do not accumulate across
  // sequential `launchTugApp` calls within one test file.
  const detachSignals = installSignalHandlers(subprocess);

  // Retry Bun.connect until ECONNREFUSED resolves or the window elapses.
  let socket;
  try {
    socket = await connectWithRetry(
      resolved.socketPath,
      resolved.connectTimeoutMs,
      resolved.connectPollMs,
      subprocess,
    );
  } catch (err) {
    // The socket never came up, so we never learned the GUI `hostPid`.
    // Kill the spawned wrapper; if the app did spawn but hung before
    // opening its test socket (rare — the socket binds early in boot),
    // the recipe's per-run `apptest-*` instance-registry teardown is the
    // backstop. Killing the wrapper here at least prevents an orphaned
    // `open -n -W` from lingering.
    try {
      subprocess.kill("SIGKILL");
    } catch {
      // already dead
    }
    detachSignals();
    try {
      logStream?.end();
    } catch {
      // best-effort
    }
    throw err;
  }

  // Bridge Bun.Socket to RpcTransport. `socket.write` accepts strings.
  const transport: RpcTransport = makeSocketTransport(socket, subprocess);
  const rpc = new RpcClient(transport);

  // Handshake: first RPC is always `version`. Mismatch → throw.
  // `expectedSurfaceVersion` override lets the version-skew test
  // deliberately mismatch without requiring a Swift rebuild.
  const expectedVersion =
    resolved.expectedSurfaceVersion ?? EXPECTED_SURFACE_VERSION;
  const serverVersion = await rpc.call<string>({ method: "version" });

  // Learn the GUI app's PID over RPC, right after the first handshake
  // call, so every teardown path below (including the version-skew
  // throw) can signal the app directly. Killing the app by PID is
  // race-free — it works before tugcast has registered in the instance
  // registry, which the registry-based `tugutil host instance stop` can
  // miss for a fast test. Best-effort: an app build without the
  // `getHostPid` verb leaves `hostPid` at 0 and teardown falls back to
  // the registry path.
  let hostPid = 0;
  try {
    const reportedPid = await rpc.call<number>({ method: "getHostPid" });
    if (typeof reportedPid === "number" && reportedPid > 0) {
      hostPid = reportedPid;
    }
  } catch {
    // Older app without getHostPid; registry teardown still applies.
  }

  const expectedMajor = expectedVersion.split(".")[0];
  const actualMajor = String(serverVersion).split(".")[0];
  if (expectedMajor !== actualMajor) {
    if (hostPid > 0) {
      try { processKillNative(hostPid, "SIGKILL"); } catch { /* already dead */ }
    }
    try {
      subprocess.kill("SIGTERM");
    } catch {
      // already dead
    }
    detachSignals();
    try {
      logStream?.end();
    } catch {
      // best-effort
    }
    throw new VersionSkewError(
      `surface version mismatch: expected=${expectedVersion} actual=${serverVersion}`,
      expectedVersion,
      String(serverVersion),
    );
  }

  // Version handshake answers from a Swift constant — it passes even
  // while the WKWebView is still at about:blank. Wait for tugdeck's
  // main.tsx to execute and attach `window.__tug` before returning,
  // so the first post-launch RPC doesn't race the page load. Wire
  // params are flat; no `params` envelope. On failure we tear down the
  // app ourselves — the caller never received an App and therefore has
  // no `close()` path. The app is launched via `open -n -W`, so
  // `subprocess` is the wrapper, NOT the GUI process; killing only the
  // wrapper would orphan Tug.app (and its tugcast / tugcode children).
  // So kill the captured `hostPid` first, mirroring the version-skew
  // teardown above.
  try {
    await rpc.call<boolean>({
      method: "waitForCondition",
      script: "typeof window.__tug !== 'undefined'",
      timeoutMs: resolved.connectTimeoutMs,
    });
  } catch (err) {
    if (hostPid > 0) {
      try { processKillNative(hostPid, "SIGKILL"); } catch { /* already dead */ }
    }
    try {
      subprocess.kill("SIGKILL");
    } catch {
      // already dead
    }
    detachSignals();
    try {
      logStream?.end();
    } catch {
      // best-effort
    }
    try {
      onExitUnlink();
    } catch {
      // already gone
    }
    throw err;
  }

  // Accessibility preflight ([D03]). The launched Tug.app binary
  // needs the macOS Accessibility grant for `CGEvent.post` to deliver
  // trusted events — without it, every native-gesture verb silently
  // no-ops, producing confusing test timeouts. Probe up-front and
  // throw a typed error with actionable guidance (which bundle to
  // add in System Settings) so the failure attribution is crisp.
  //
  // Tests that are known to use only `evalJS` / `waitForCondition`
  // (no native gestures) can opt out by passing
  // `skipAccessibilityPreflight: true` in launchTugAppOptions; the
  // default is strict.
  if (!resolved.skipAccessibilityPreflight) {
    let ax: AccessibilityStatus;
    try {
      ax = await rpc.call<AccessibilityStatus>({
        method: "checkAccessibilityPermission",
        // Let macOS show the System Settings dialog on the first
        // probe per process — it's the most actionable guidance.
        prompt: true,
      });
    } catch (err) {
      if (hostPid > 0) {
        try { processKillNative(hostPid, "SIGKILL"); } catch { /* already dead */ }
      }
      try {
        subprocess.kill("SIGKILL");
      } catch {
        // already dead
      }
      detachSignals();
      try {
        logStream?.end();
      } catch {
        // best-effort
      }
      try {
        onExitUnlink();
      } catch {
        // already gone
      }
      throw err;
    }
    if (!ax.trusted) {
      if (hostPid > 0) {
        try { processKillNative(hostPid, "SIGKILL"); } catch { /* already dead */ }
      }
      try {
        subprocess.kill("SIGKILL");
      } catch {
        // already dead
      }
      detachSignals();
      try {
        logStream?.end();
      } catch {
        // best-effort
      }
      try {
        onExitUnlink();
      } catch {
        // already gone
      }
      throw new AccessibilityPermissionMissingError(
        [
          "Tug.app is missing macOS Accessibility permission — native-event tests cannot proceed.",
          "Grant the permission in System Settings → Privacy & Security → Accessibility and re-run.",
          `    Bundle path: ${ax.bundlePath}`,
          `    Bundle id:   ${ax.bundleId}`,
          "",
          "If the bundle is already in the list but the grant is stale",
          "(common after a re-sign), toggle it off + on, or run:",
          "    tccutil reset Accessibility " + ax.bundleId,
          "and re-run the test suite.",
        ].join("\n"),
      );
    }
  }

  // The app just finished its boot handshake; give it a human beat to
  // finish launching (first paint, focus establishment) before any test
  // code can drive it.
  if (STATE_SETTLE_MS > 0) {
    await new Promise<void>((r) => setTimeoutNative(r, STATE_SETTLE_MS));
  }

  return new App({
    rpc,
    version: String(serverVersion),
    socketPath: resolved.socketPath,
    subprocess,
    onUnlink: onExitUnlink,
    logPath: resolved.logPath,
    logStream,
    detachSignals,
    hostPid,
    instanceId: resolved.instanceId,
    resolvedLaunch: resolved,
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Narrow, typed shim for the globalThis scheduler. We import this
 * rather than using `setTimeout` directly so a grep for
 * `setTimeout` in `tests/app-test/` only hits `./_harness/*` (harness
 * internals), not test files.
 */
const setTimeoutNative = (
  globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => unknown }
).setTimeout;

/**
 * Narrow shim for `process.kill`, used to signal the GUI Tug.app
 * process directly by PID. Wrapped here so a grep for `process.kill`
 * in `tests/app-test/` only hits harness internals.
 */
const processKillNative = (
  globalThis as unknown as {
    process: { kill: (pid: number, signal?: string) => void };
  }
).process.kill;

/**
 * Validate the recipe-provided instance-id prefix. Must be the
 * `apptest` family (the dedicated port windows and tugcast's tmux
 * self-reap both key on the `apptest-` prefix) and slug-shaped after
 * it. Anything else falls back to the bare `apptest` family rather
 * than minting an id outside the app-test namespace.
 */
/**
 * The multiplier the parallel runner asks launch budgets to travel with, from
 * `TUG_APPTEST_TIMEOUT_SCALE`. Mirrors the RPC transport's own scale (`rpc.ts`);
 * unset or below 1 means a serial run, which is left exactly as it was.
 */
function launchTimeoutScale(): number {
  const raw = Number(process.env.TUG_APPTEST_TIMEOUT_SCALE);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(raw, 10);
}

function validatedIdPrefix(raw: string | undefined): string {
  if (raw && /^apptest-[a-z0-9-]+$/.test(raw)) return raw;
  return "apptest";
}

function resolveLaunchOptions(opts: LaunchTugAppOptions): ResolvedLaunch {
  // macOS `/tmp` is root-owned; the Swift bridge's parent-dir-owner
  // check ([D06]) rejects sockets there. `os.tmpdir()` returns the
  // user-owned `$TMPDIR` (`/var/folders/.../T/` on macOS).
  const socketPath =
    opts.socketPath ?? `${tmpdir()}/tugapp-test-${randomUUID()}.sock`;
  const appPath = opts.appPath ?? resolveDefaultAppPath();
  const logPath = opts.testName
    ? pathResolve(LOGS_DIR, `${sanitizeTestName(opts.testName)}.log`)
    : null;
  // Per-launch instance identity. Defaults to `<prefix>-<uuid>` so each
  // launchTugApp call gets its own per-instance data dir, tugbank,
  // tmux session, and registry entry — concurrent app-tests don't
  // collide, and a separately-running `just app-dev` is untouched by
  // the harness's targeted teardown. Tests that need cross-launch
  // continuity (e.g. cold-boot) pass `opts.instanceId` explicitly.
  //
  // The prefix is worktree-scoped when the recipe provides it
  // (`TUG_APPTEST_ID_PREFIX=apptest-<wtslug>`), so one worktree's
  // recipe sweeps can never match another worktree's live instances.
  // Outside the recipe (bare `bun test`, discouraged) it falls back
  // to the bare `apptest` family.
  const idPrefix = validatedIdPrefix(process.env.TUG_APPTEST_ID_PREFIX);
  const ephemeralInstanceId = opts.instanceId == null;
  const instanceId = opts.instanceId ?? `${idPrefix}-${randomUUID()}`;
  return {
    appPath,
    socketPath,
    // Scaled with the runner's concurrency: a launch under contention reaches
    // its handshake later than one that had the machine to itself, and that is
    // slowness, not failure. Unset (serial) leaves the original 10s exactly.
    connectTimeoutMs: opts.connectTimeoutMs ?? 10000 * launchTimeoutScale(),
    connectPollMs: opts.connectPollMs ?? 100,
    env: {
      ...forwardableEnv(),
      TUGAPP_NATIVE_EVENT_MODE: opts.foreground ? "session" : "pid",
      ...(opts.persistInTestMode ? { TUGAPP_PERSIST_IN_TEST_MODE: "1" } : {}),
      ...(opts.restoreInTestMode ? { TUGAPP_RESTORE_IN_TEST_MODE: "1" } : {}),
      ...(opts.keepSetup ? { TUGAPP_TEST_KEEP_SETUP: "1" } : {}),
      ...(opts.env ?? {}),
      TUGAPP_TEST_SOCKET: socketPath,
      TUG_INSTANCE_ID: instanceId,
      // Point the machine-global changes ledger into this launch's
      // per-instance data dir: harness runs must never write attribution
      // rows into the developer's real ~/Library/Application Support/Tug/
      // changes.db (the same dir the teardown below reclaims).
      TUG_CHANGES_DB: `${homedir()}/Library/Application Support/Tug/instances/${instanceId}/changes.db`,
      // Same isolation for the machine-global prompt ledger: a test that
      // submits prompts must not append them to the developer's real corpus,
      // and — since nothing ever trims that file — must not be able to.
      TUG_PROMPT_HISTORY_DB: `${homedir()}/Library/Application Support/Tug/instances/${instanceId}/prompt_history.db`,
      // And the third shared ledger. A test that lays a wire must not arm one
      // on the developer's machine: a tripwire is a standing thing that fires
      // later, so an un-isolated one would outlive the run that made it.
      TUG_TRIPWIRES_DB: `${homedir()}/Library/Application Support/Tug/instances/${instanceId}/tripwires.db`,
    },
    logPath,
    expectedSurfaceVersion: opts.expectedSurfaceVersion ?? EXPECTED_SURFACE_VERSION,
    skipAccessibilityPreflight: opts.skipAccessibilityPreflight ?? false,
    instanceId,
    ephemeralInstanceId,
  };
}

/**
 * Non-`TUG*` environment variables Tug.app needs at launch. Everything
 * else in the harness process's environment stays out.
 */
const FORWARDED_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "NODE_ENV",
] as const;

/**
 * The subset of the harness process's environment handed to Tug.app:
 * every `TUG*` variable plus {@link FORWARDED_ENV_KEYS}.
 *
 * Deliberately NOT `...process.env`. These variables reach the app as
 * `open --env KEY=VALUE` arguments, which puts every one of them in the
 * launcher's argv where any process on the machine can read it via `ps`
 * — a developer environment routinely carries API keys and tokens that
 * have no business in a test launch.
 */
function forwardableEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (k.startsWith("TUG") || (FORWARDED_ENV_KEYS as readonly string[]).includes(k)) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Collapse characters that are awkward on a filesystem into `-`. Keeps
 * the log filename predictable — a test named "foo bar / baz" becomes
 * `foo-bar---baz.log`.
 */
function sanitizeTestName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "-");
}

/**
 * Open a write stream at the given log path (creating the parent dir
 * if missing). `null` in → `null` out, which disables log capture.
 */
function openLogStream(logPath: string | null): WriteStream | null {
  if (!logPath) return null;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {
    // Directory already exists, or we can't create it. If creation
    // fails, `createWriteStream` will surface the real error.
  }
  // Truncate on open — each test run gets a fresh log. Callers that
  // want to aggregate across runs should manage their own filename.
  return createWriteStream(logPath, { flags: "w" });
}

/**
 * Drain a Bun-style ReadableStream<Uint8Array> into the log stream.
 * Swallows errors — log capture must not influence test outcomes.
 * Returns when the source stream ends.
 */
async function pumpToLog(
  source: ReadableStream<Uint8Array> | null | undefined,
  sink: WriteStream,
): Promise<void> {
  if (!source) return;
  const reader = source.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) {
        try {
          sink.write(value);
        } catch {
          // drop; we don't want writer backpressure to kill the test
        }
      }
    }
  } catch {
    // source errored; give up cleanly
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // best-effort
    }
  }
}

/**
 * Register per-launch SIGINT / SIGTERM / exit listeners that terminate
 * the subprocess if the runner is interrupted or exits unexpectedly.
 * Returns a detach function that removes these listeners — `App.close()`
 * calls it so handler counts do not grow across sequential launches.
 *
 * Contract:
 *   - `SIGINT` / `SIGTERM`: kill the subprocess (SIGTERM; SIGKILL if
 *     it refuses to die after a short grace window), unlink the
 *     socket, then re-emit the signal via `process.exit(128 + sig)`.
 *   - `exit`: last-resort synchronous `kill("SIGKILL")` for pathological
 *     exits where the subprocess is still alive.
 */
function installSignalHandlers(subprocess: SpawnedTugApp): () => void {
  const onSignal = (signal: NodeJS.Signals) => {
    // Best-effort terminate; we cannot await here because signal
    // handlers on Node/Bun run synchronously before the default
    // action. The process.on("exit") handler below catches the
    // pathological case where the subprocess is still alive when
    // the runner is on its way out.
    try {
      subprocess.kill("SIGTERM");
    } catch {
      // already dead
    }
    // Use the default exit code convention: 128 + signal number. We
    // don't know the signal number reliably from the name, so fall
    // back to a simple 1/0 exit. Tests treat the runner's exit code
    // as opaque; the subprocess cleanup is what matters.
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const onExit = () => {
    try {
      subprocess.kill("SIGKILL");
    } catch {
      // already gone
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("exit", onExit);
  // `exit` does not fire under `bun test`, so the run-end hook is what
  // actually catches a subprocess still alive at the end of a run.
  const disposeRunEnd = onTestRunEnd(onExit);
  return () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("exit", onExit);
    disposeRunEnd();
  };
}

function resolveDefaultAppPath(): string {
  // Default: the xcodebuild Debug build product. Tests can override
  // via opts.appPath. We do NOT probe the filesystem here — that is
  // the caller's concern; a missing binary surfaces as Bun.spawn ENOENT.
  const fromEnv = process.env.TUGAPP_DEBUG_PATH;
  if (fromEnv) return fromEnv;
  return "/Applications/Tug.app/Contents/MacOS/Tug";
}

interface SpawnedTugApp {
  kill: (signal?: string) => void;
  exited: Promise<number>;
  stdout?: ReadableStream<Uint8Array> | null;
  stderr?: ReadableStream<Uint8Array> | null;
}

/**
 * Write ledger rows for a running launch.
 *
 * Runs the `tugcast` shipped inside the bundle under test with this
 * launch's instance environment, so the rows land in the same
 * per-instance `sessions.db` / `changes.db` the app is reading and are
 * written by the same `SessionLedger` the server uses — real schema, real
 * journal. `--seed-ledger` refuses a non-app-test instance id, so this
 * cannot reach a developer's ledger even if the env were wrong.
 *
 * **This must run after the app is up, not before.** tugcast calls
 * `demote_live_to_closed` once at startup, which flips every `live` row to
 * `closed` — the crash-recovery rule that a live row with no running
 * subprocess is stale. A pre-launch seed is exactly that shape, so it gets
 * demoted before the first compose and its files surface as `orphaned`
 * rather than under a session entry. Seeding after startup lands the row
 * behind the sweep.
 */
function seedLedgerForLaunch(
  resolved: ResolvedLaunch,
  spec: LedgerSeedSpec,
): void {
  const spawnSync = (globalThis as unknown as {
    Bun?: {
      spawnSync: (opts: Record<string, unknown>) => {
        exitCode: number;
        stdout: Uint8Array;
        stderr: Uint8Array;
      };
    };
  }).Bun?.spawnSync;
  if (!spawnSync) {
    throw new Error("seedLedger: Bun.spawnSync is unavailable (run via `bun test`)");
  }

  const bundlePath = resolved.appPath.replace(/\/Contents\/MacOS\/[^/]+$/, "");
  const tugcast = `${bundlePath}/Contents/MacOS/tugcast`;
  if (!existsSync(tugcast)) {
    throw new Error(
      `seedLedger: no tugcast in the bundle under test at ${tugcast}. ` +
        "The seeding hook runs the binary that ships with the app so the " +
        "ledger schema cannot drift from the server's.",
    );
  }

  const specPath = `${tmpdir()}/tug-ledger-seed-${randomUUID()}.json`;
  writeFileSync(specPath, JSON.stringify(spec));
  try {
    const out = spawnSync({
      cmd: [tugcast, "--seed-ledger", specPath],
      env: { ...process.env, ...resolved.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (out.exitCode !== 0) {
      throw new Error(
        `seedLedger: tugcast --seed-ledger exited ${out.exitCode}: ` +
          new TextDecoder().decode(out.stderr).trim(),
      );
    }
  } finally {
    rmSync(specPath, { force: true });
  }
}

function spawnTugApp(resolved: ResolvedLaunch): SpawnedTugApp {
  // Bun.spawn is typed on `Bun.spawn`; we use a narrow cast so this
  // file still compiles under non-Bun `tsc` checks if the types
  // haven't loaded.
  const spawnFn = (globalThis as unknown as {
    Bun?: { spawn: (opts: Record<string, unknown>) => SpawnedTugApp };
  }).Bun?.spawn;
  if (!spawnFn) {
    throw new Error("launchTugApp: Bun.spawn is unavailable (run via `bun test`)");
  }

  // Launch via `/usr/bin/open` (LaunchServices) instead of spawning
  // the Mach-O binary directly.
  //
  // ## Why this detour exists
  //
  // macOS TCC (the Accessibility-permissions daemon) needs the target
  // process to be attached to the user's GUI launchd session so the
  // user-level `tccd` is reachable. A `Bun.spawn` of the bare Mach-O
  // exec inherits bun's session, which doesn't have that attachment —
  // the spawned Tug.app's WebKit helpers log
  // `user tccd unavailable, XPC_ERROR_CONNECTION_INVALID` and every
  // `AXIsProcessTrusted()` returns false regardless of the user grant.
  //
  // `open` goes through LaunchServices, which bootstraps the launched
  // app into the proper GUI session where tccd is reachable — so
  // TCC can actually evaluate the grant against the binary's code
  // signature. Once in that session, `CGEvent.post` works.
  //
  // ## Lifecycle
  //
  // `open -W` blocks until the launched app exits, so the Bun
  // subprocess handle's `.exited` promise resolves exactly when Tug.app
  // quits. `open --stdout` / `--stderr` route the app's output to the
  // per-test log file directly; the harness's `pumpToLog` on the
  // Bun pipes is a no-op in this mode (streams are empty) and is kept
  // only so the caller path doesn't need two branches.
  //
  // ## Kill semantics
  //
  // SIGTERM to the `open -W` wrapper doesn't reliably propagate to the
  // launched app. We instead use `tugutil host instance stop <id>` (via
  // wrappedKill below) which signals only the apptest-* PID for this
  // launch — safe under multi-instance, untouched developer sessions.
  const bundlePath = resolved.appPath.replace(/\/Contents\/MacOS\/[^/]+$/, "");
  const envArgs: string[] = [];
  for (const [k, v] of Object.entries(resolved.env)) {
    if (typeof v !== "string") continue;
    envArgs.push("--env", `${k}=${v}`);
  }
  const logPathForRedirect = resolved.logPath ?? "/dev/null";

  const subprocess = spawnFn({
    cmd: [
      "/usr/bin/open",
      "-n",              // new instance
      "-W",              // wait-apps (blocks until Tug.app quits)
      // NO -g by default: Tug.app MUST be foreground so CGEvent.post
      // mouse events hit its window. CGEvent events route through
      // windowserver by screen coord → window-on-top; a backgrounded
      // Tug.app sits behind whatever was active (terminal, IDE) and
      // the clicks land on the wrong app.
      //
      // In pid mode — the default — that routing is bypassed: the
      // in-app harness addresses keyboard events to its own pid and
      // dispatches mouse events straight into the window, so the app
      // launches WITHOUT activation (-g) and the user keeps focus,
      // cursor, and key window for the whole run. `foreground: true`
      // tests opt back into the activating launch.
      ...(resolved.env.TUGAPP_NATIVE_EVENT_MODE === "pid" ? ["-g"] : []),
      "--stdout", logPathForRedirect,
      "--stderr", logPathForRedirect,
      ...envArgs,
      bundlePath,
    ],
    // `open` itself doesn't need the TUGAPP_* env vars (they go to
    // the app via --env); forwarding PATH is enough.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      USER: process.env.USER ?? "",
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  // Wrap `.kill` so SIGTERM reliably reaches the Tug.app process and
  // its tugcast child — targeted to THIS instance, not all Tug
  // processes on the machine.
  // its tugcast child. Without the tugcast kill, `app.close()`
  // (SIGTERM-to-Tug-only) leaks tugcast: it lives in its own process
  // group (Tug's `ProcessManager` only kills the group from the
  // graceful `applicationShouldTerminate` path; bare SIGTERM bypasses
  // that). The next launch then races port-55255 reclamation, which
  // surfaces as flakes in tests that run back-to-back.
  const originalKill = subprocess.kill.bind(subprocess);
  const instanceId = resolved.instanceId;
  const ephemeralInstanceId = resolved.ephemeralInstanceId;
  const wrappedKill = (signal?: string): void => {
    const sig = signal ?? "SIGTERM";
    const spawnSync = (
      globalThis as unknown as {
        Bun?: {
          spawnSync: (opts: Record<string, unknown>) => { exitCode: number };
        };
      }
    ).Bun?.spawnSync;
    // Targeted teardown via `tugutil host instance stop <id>`. The bare
    // `pkill -x Tug` approach is unsafe under multi-instance: it
    // would kill a developer's separately-running `just app-dev`
    // session. `tugutil host instance stop` looks up the PID for this
    // specific apptest-<uuid> in the registry and signals only it.
    // `--timeout` keeps the call short — we send SIGTERM then a
    // fast escalation to SIGKILL.
    //
    // Bare name (PATH-resolved). A linked dash worktree creates no
    // ~/.local/bin/tugutil symlink, so in-dash this spawn throws and the
    // SIGTERM+tmux fallback below reclaims the instance; real coverage
    // of this path comes from the post-join main run (where the symlink
    // exists).
    try {
      spawnSync?.({
        cmd: [
          "tugutil",
          "host",
          "instance",
          "stop",
          instanceId,
          "--timeout",
          sig === "SIGKILL" ? "0" : "2",
        ],
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
    } catch {
      // ignore — the fallback below still runs
    }
    // Reclaim the instance's tmux server. tugcast hosts each instance's
    // session as `cc-<instanceId>` on a PRIVATE server addressed by
    // `-L tug-<token>`; it is NOT a child of Tug.app, so killing the app
    // (via `instance stop` above) leaves the whole server — and the PTY
    // it pins — alive. Across many runs these accumulate and exhaust the
    // macOS pseudo-terminal pool, which then surfaces as `fork failed:
    // Device not configured` and a launch that restart-storms forever.
    //
    // This must name the private server. A bare `tmux kill-session`
    // addresses the DEFAULT server, where no current instance's session
    // lives, so it reclaimed nothing — and this fallback is exactly what
    // runs when the `tugutil` spawn above is unavailable (a dash
    // worktree has no `~/.local/bin/tugutil` symlink), which is when it
    // matters most. `kill-server` rather than `kill-session`: the server
    // is per-instance, so nothing else is on it.
    try {
      spawnSync?.({
        cmd: ["tmux", "-L", tmuxSocketLabel(instanceId), "kill-server"],
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
    } catch {
      // no such server — nothing to reclaim
    }
    // Pre-isolation builds put `cc-<id>` on the shared default server.
    // Cheap to also ask, and it costs nothing when there is no server.
    try {
      spawnSync?.({
        cmd: ["tmux", "kill-session", "-t", `cc-${instanceId}`],
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
    } catch {
      // no such session / no tmux server — nothing to reclaim
    }
    // This launch's sockets. Each owner unlinks its own on a graceful
    // close, but this path exists precisely because the close was not
    // graceful.
    for (const sock of [
      resolved.socketPath,
      `${tmpdir()}/tugbank-notify-${shortToken(instanceId)}.sock`,
    ]) {
      try {
        unlinkSync(sock);
      } catch {
        // already gone
      }
    }
    // Reclaim this launch's per-instance data dir. Each auto-minted
    // `apptest-<uuid>` is single-use, so once we've stopped the process
    // its `~/Library/Application Support/Tug/instances/<id>/` dir
    // (tugbank.db, sessions.db, Logs) is pure garbage. Nothing else
    // reclaims it: `instance prune` skips it while the shared
    // `Tug-apptest.app` bundle still exists, so without this step the
    // dirs accumulate unboundedly across runs. `--data-only` leaves
    // that shared bundle (and its TCC grant) intact, and the call
    // re-stops first, so removing a still-live instance's dir is
    // impossible. SKIPPED for caller-supplied ids: cold-boot /
    // continuity tests relaunch with the same id and need the data dir
    // to survive between launches — `instance prune` collects those.
    if (ephemeralInstanceId) {
      try {
        spawnSync?.({
          cmd: [
            "tugutil",
            "host",
            "instance",
            "remove",
            instanceId,
            "--data-only",
            "--yes",
          ],
          stdout: "ignore",
          stderr: "ignore",
          stdin: "ignore",
        });
      } catch {
        // best-effort — `instance prune` is the catch-all
      }
    }
    // Also signal the `open -W` wrapper so its `.exited` resolves
    // promptly on the harness side.
    try {
      originalKill(sig);
    } catch {
      // already dead
    }
  };

  return {
    kill: wrappedKill,
    exited: subprocess.exited,
    stdout: subprocess.stdout,
    stderr: subprocess.stderr,
  };
}

interface BunSocketLike {
  write(data: string | Uint8Array): number;
  end(): void;
  data?: { onData?: (chunk: string) => void; onClose?: (reason: unknown) => void };
}

async function connectWithRetry(
  socketPath: string,
  timeoutMs: number,
  pollMs: number,
  subprocess: SpawnedTugApp,
): Promise<BunSocketLike> {
  const connect = (globalThis as unknown as {
    Bun?: { connect: (opts: Record<string, unknown>) => Promise<BunSocketLike> };
  }).Bun?.connect;
  if (!connect) {
    throw new Error("connectWithRetry: Bun.connect is unavailable");
  }

  const start = Date.now();
  let lastErr: unknown = null;

  // Per-connection state for the socket-transport glue. We install a
  // callback-style handler set here so `makeSocketTransport` can
  // receive pushes before the transport object is constructed.
  const sharedState: { onData?: (chunk: string) => void; onClose?: (reason: unknown) => void } = {};

  while (Date.now() - start < timeoutMs) {
    try {
      const sock = await connect({
        unix: socketPath,
        socket: {
          data(_s: unknown, buf: Buffer | Uint8Array | string) {
            if (!sharedState.onData) return;
            sharedState.onData(
              typeof buf === "string"
                ? buf
                : new TextDecoder().decode(buf as Uint8Array),
            );
          },
          end() {
            sharedState.onClose?.({ exitCode: null, signal: null });
          },
          error(_s: unknown, err: Error) {
            sharedState.onClose?.({ exitCode: null, signal: String(err.message) });
          },
          close() {
            sharedState.onClose?.({ exitCode: null, signal: null });
          },
        },
      });
      (sock as { data?: typeof sharedState }).data = sharedState;
      return sock;
    } catch (err) {
      lastErr = err;
      // Check if the subprocess died early — no point in retrying.
      const raced = await Promise.race([
        subprocess.exited.then((code) => ({ dead: true, code })),
        new Promise<{ dead: false }>((resolve) =>
          setTimeoutNative(() => resolve({ dead: false }), pollMs),
        ),
      ]);
      if (raced.dead) {
        throw new AppCrashedError(
          `Tug.app exited before test harness socket could connect (exitCode=${raced.code})`,
          raced.code,
          null,
        );
      }
    }
  }
  throw new Error(
    `connectWithRetry: exceeded ${timeoutMs}ms waiting for ${socketPath} (lastErr=${String(lastErr)})`,
  );
}

function makeSocketTransport(
  socket: BunSocketLike,
  subprocess: SpawnedTugApp,
): RpcTransport {
  // The shared state established in connectWithRetry carries the
  // data/close callbacks. Reading them here completes the bridge.
  const sharedState = (socket as { data?: { onData?: (chunk: string) => void; onClose?: (reason: unknown) => void } }).data;
  if (!sharedState) {
    throw new Error("makeSocketTransport: socket was connected without sharedState");
  }

  // Also propagate subprocess exit into transport close.
  void subprocess.exited.then((code) => {
    sharedState.onClose?.({ exitCode: code, signal: null });
  });

  return {
    write(data: string): void {
      socket.write(data);
    },
    onData(handler: (chunk: string) => void): void {
      sharedState.onData = handler;
    },
    onClose(handler: (reason: { exitCode?: number | null; signal?: string | null }) => void): void {
      sharedState.onClose = (reason: unknown) => {
        const r = reason as { exitCode?: number | null; signal?: string | null } | undefined;
        handler({ exitCode: r?.exitCode ?? null, signal: r?.signal ?? null });
      };
    },
  };
}
