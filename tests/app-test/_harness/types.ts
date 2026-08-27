/**
 * types.ts — RPC wire types for the in-app test harness.
 *
 * Mirrors the in-app bridge RPC protocol (handshake + NDJSON framing).
 * This file is types-only — no tugdeck runtime imports, no side effects.
 * The Swift side implements the same shape informally; drift is caught
 * at handshake via `VersionSkewError`.
 *
 * Framing: newline-delimited JSON (NDJSON). Every request carries a
 * numeric `id`; the response shares it. See `./rpc.ts` for the
 * correlator and framing implementation.
 */

/**
 * Method names the harness can invoke over the bridge. Kept as a
 * string-literal union so callers get type narrowing in `switch`.
 */
export type RpcMethod =
  | "evalJS"
  | "waitForCondition"
  | "version"
  | "getHostPid"
  | "checkAccessibilityPermission"
  | "getElementScreenBounds"
  | "menuSnapshot"
  | "menuItemState"
  | "screenshot"
  | "nativeClick"
  | "nativeDoubleClick"
  | "nativeRightClick"
  | "nativeDrag"
  | "nativeDragWithoutRelease"
  | "nativeMouseDown"
  | "nativeMouseUp"
  | "nativeKey"
  | "nativeType"
  | "holdModifier"
  | "pressHeldModifiers"
  | "releaseHeldModifiers"
  | "simulateAppResign"
  | "simulateAppBecomeActive"
  | "simulateAppHide"
  | "simulateAppUnhide"
  | "startTugcode"
  | "stopTugcode"
  | "writeTugcodeStdin";

/**
 * Viewport-space point passed to the native-gesture verbs. `{x, y}` is
 * in CSS viewport coords (Y-down, origin top-left of the WKWebView).
 * Swift-side `CoordMapping.viewportToScreen` does the conversion to
 * screen CG before `CGEvent.post`.
 */
export interface ViewportPoint {
  x: number;
  y: number;
}

/**
 * Accepted button-string values on the wire. The Swift side decodes
 * via `MouseButton(rawValue:)`.
 */
export type NativeMouseButton = "left" | "right";

/**
 * Accepted modifier-string values on the wire. The Swift side decodes
 * via `ModifierKey(rawValue:)`.
 */
export type NativeModifier = "cmd" | "shift" | "alt" | "ctrl";

/**
 * Inner verb envelopes nested inside a `holdModifier` request.
 * Identical to the top-level native verbs (minus `id` / `timeoutMs`)
 * since the Swift-side `executeHoldModifier` dispatches each inner
 * verb through `executeNativeVerb(_, handlers:)`.
 */
export type InnerNativeVerb =
  | {
      method: "nativeClick";
      viewportPoint: ViewportPoint;
      button?: NativeMouseButton;
      clickCount?: number;
      mouseDownDelayMs?: number;
      mouseUpDelayMs?: number;
    }
  | {
      method: "nativeDoubleClick";
      viewportPoint: ViewportPoint;
      button?: NativeMouseButton;
    }
  | {
      method: "nativeRightClick";
      viewportPoint: ViewportPoint;
    }
  | {
      method: "nativeDrag";
      from: ViewportPoint;
      to: ViewportPoint;
      button?: NativeMouseButton;
      mouseDownDelayMs?: number;
      mouseUpDelayMs?: number;
    }
  | {
      method: "nativeMouseDown";
      viewportPoint: ViewportPoint;
      button?: NativeMouseButton;
    }
  | {
      method: "nativeMouseUp";
      viewportPoint: ViewportPoint;
      button?: NativeMouseButton;
    }
  | {
      method: "nativeKey";
      key: string;
      modifiers?: readonly NativeModifier[];
    }
  | {
      method: "nativeType";
      text: string;
    };

/**
 * Screen-space rect returned by `getElementScreenBounds`. All values
 * in CG screen coords (Y-down, primary-screen-relative) — suitable
 * for passing directly to CGEvent.post via `nativeClick`'s underlying
 * machinery (tests rarely need to; prefer `app.nativeClickAtElement`
 * which routes through viewport-space internally).
 */
export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One node in a native-menu snapshot (`menuSnapshot` / `menuItemState`).
 * `enabled` is the *validated* state — what AppKit computes through
 * `NSMenuItemValidation` at open / key-equivalent time, not a stale
 * stored flag. `submenu` is present only on parent items.
 */
export interface MenuItemSnapshot {
  title: string;
  enabled: boolean;
  hidden: boolean;
  separator: boolean;
  keyEquivalent: string;
  modifierMask: number;
  /**
   * Raw `NSControl.StateValue` — 1 = checked (`.on`), 0 = `.off`.
   * Captured after the validation sweep, so radio checkmarks that
   * validators refresh (the permission-mode submenu) are current.
   */
  state: number;
  identifier?: string;
  action?: string;
  submenu?: MenuItemSnapshot[];
}

/**
 * Result of `menuItemState`: the matched item's snapshot fields plus a
 * `found` discriminator. When `found` is `false`, the other fields are
 * absent.
 */
export type MenuItemState =
  | ({ found: true } & Omit<MenuItemSnapshot, "submenu">)
  | { found: false };

/**
 * Result of `checkAccessibilityPermission`.
 */
export interface AccessibilityStatus {
  trusted: boolean;
  bundlePath: string;
  bundleId: string;
}

/**
 * The request shape sent from harness → Swift, NDJSON-framed. Every
 * variant carries `id` (numeric, unique per connection) and a
 * discriminating `method` string.
 */
export type Request =
  | {
      id: number;
      method: "evalJS";
      script: string;
      timeoutMs?: number;
    }
  | {
      id: number;
      method: "waitForCondition";
      script: string;
      timeoutMs?: number;
      pollMs?: number;
    }
  | {
      id: number;
      method: "version";
    }
  | {
      id: number;
      method: "getHostPid";
    }
  | {
      id: number;
      method: "checkAccessibilityPermission";
      /**
       * Whether macOS should show the "grant in System Settings"
       * dialog when the bit is missing. Default true on the first
       * call; explicit `false` allows silent re-probe after a grant.
       */
      prompt?: boolean;
    }
  | {
      id: number;
      method: "getElementScreenBounds";
      selector: string;
    }
  | {
      id: number;
      method: "menuSnapshot";
    }
  | {
      id: number;
      method: "menuItemState";
      identifier: string;
    }
  | {
      id: number;
      method: "screenshot";
    }
  | {
      id: number;
      method: "nativeClick";
      viewportPoint: ViewportPoint;
      button?: NativeMouseButton;
      clickCount?: number;
      mouseDownDelayMs?: number;
      mouseUpDelayMs?: number;
    }
  | {
      id: number;
      method: "nativeDoubleClick";
      viewportPoint: ViewportPoint;
      button?: NativeMouseButton;
    }
  | {
      id: number;
      method: "nativeRightClick";
      viewportPoint: ViewportPoint;
    }
  | {
      id: number;
      method: "nativeDrag";
      from: ViewportPoint;
      to: ViewportPoint;
      button?: NativeMouseButton;
      mouseDownDelayMs?: number;
      mouseUpDelayMs?: number;
    }
  | {
      id: number;
      method: "nativeDragWithoutRelease";
      from: ViewportPoint;
      to: ViewportPoint;
      button?: NativeMouseButton;
      mouseDownDelayMs?: number;
      mouseUpDelayMs?: number;
    }
  | {
      id: number;
      method: "nativeMouseDown";
      viewportPoint: ViewportPoint;
      button?: NativeMouseButton;
    }
  | {
      id: number;
      method: "nativeMouseUp";
      viewportPoint: ViewportPoint;
      button?: NativeMouseButton;
    }
  | {
      id: number;
      method: "nativeKey";
      key: string;
      modifiers?: readonly NativeModifier[];
    }
  | {
      id: number;
      method: "nativeType";
      text: string;
    }
  | {
      id: number;
      method: "holdModifier";
      modifiers: readonly NativeModifier[];
      innerVerbs: readonly InnerNativeVerb[];
    }
  | {
      id: number;
      method: "pressHeldModifiers";
      modifiers: readonly NativeModifier[];
    }
  | {
      id: number;
      method: "releaseHeldModifiers";
      modifiers: readonly NativeModifier[];
    }
  | {
      id: number;
      method: "simulateAppResign";
      timeoutMs?: number;
    }
  | {
      id: number;
      method: "simulateAppBecomeActive";
      timeoutMs?: number;
    }
  | {
      id: number;
      method: "simulateAppHide";
      timeoutMs?: number;
    }
  | {
      id: number;
      method: "simulateAppUnhide";
      timeoutMs?: number;
    }
  | {
      id: number;
      method: "startTugcode";
      /**
       * "stub" or "live". Stub mode requires a `transcript`;
       * Swift writes it to a temp file and passes
       * `--stub-transcript=<path>` to tugcode.
       */
      mode: "stub" | "live";
      /**
       * Absolute path to the tugcode executable. When omitted,
       * Swift falls back to the `TUGAPP_TUGCODE_BINARY` env var.
       */
      binaryPath?: string;
      /**
       * Absolute path that tugcode's stdout + stderr stream into.
       * When omitted, output goes to `/dev/null`.
       */
      logFilePath?: string;
      /**
       * Stub-replay transcript document. Required when
       * `mode === "stub"`. Shape mirrors
       * `tugcode/src/stub-replay.ts::TugcodeTranscript` — the
       * field is opaque on the wire because Swift round-trips it
       * through `JSONSerialization` straight to the temp file.
       */
      transcript?: Record<string, unknown>;
      /**
       * Project directory; passed to tugcode as `--dir <path>`.
       * Mostly relevant in live mode (tugcode hands it to claude
       * as the cwd for tool execution). Stub mode ignores it.
       */
      dir?: string;
    }
  | {
      id: number;
      method: "stopTugcode";
    }
  | {
      id: number;
      method: "writeTugcodeStdin";
      /** A single JSON IPC frame; Swift appends a newline. */
      line: string;
    };

/**
 * Generic response shape. Discriminated on `ok`. Swift-side script
 * throws and non-serializable return values both serialize into the
 * `ok: false` branch.
 */
export type Response<T> =
  | {
      id: number;
      ok: true;
      value: T;
    }
  | {
      id: number;
      ok: false;
      error: {
        name: string;
        message: string;
        stack?: string;
      };
    };

/**
 * Options for a single `evalJS` call.
 */
export interface EvalJsOptions {
  /** Server-side hard timeout in milliseconds. Default 5000. */
  timeoutMs?: number;
}

/**
 * Options for a single `waitForCondition` call.
 */
export interface WaitForConditionOptions {
  /** Server-side overall timeout in milliseconds. Default 2000. */
  timeoutMs?: number;
  /** Poll interval in milliseconds. Default 16. */
  pollMs?: number;
}

/**
 * Options for `launchTugApp`.
 */
/** One live session row to seed — mirrors the ledger's `record_spawn`. */
export interface LedgerSeedSession {
  /** The id the card will bind to, so the entry and the card agree. */
  session_id: string;
  /** The registry's workspace key — the canonical project dir. */
  workspace_key: string;
  /** The canonical project dir the entry composes under. */
  project_dir: string;
  card_id?: string;
  /** The entry's display title; falls back to the id prefix without one. */
  name?: string;
  /**
   * The session's callsign, written the way the real spawn path writes it.
   *
   * Seed it whenever the test asks the ledger to answer for the session by
   * NAME rather than by id — a session atom carries `project/callsign` and no
   * id, so its chip resolves through `resolve_sessions`' callsign arm.
   */
  tag?: string;
  /**
   * The dash this session is mated to — its **owner key**, applied through the
   * same `set_dash_binding` a real `bind_dash` uses.
   *
   * Seed it to stand up "another live session is holding this dash", which is
   * what the shade's release-reach rule refuses on. `bound_sessions` is
   * computed from these rows, so a client-side `bind_dash_ok` cannot fake it.
   */
  dash_id?: string;
  /** The dash's short name; defaults to `dash_id` when omitted. */
  dash_name?: string;
  /**
   * The session this one was rewind-forked from, written through the same
   * `set_fork_provenance` the fork arc uses.
   *
   * Seed it to stand up the post-fork ledger state a relaunch binds to: the
   * fork is the live row a card resumes onto, and every durable ink read
   * resolves along this edge to find the line of work's receipts. A real fork
   * needs a live `claude` process, which an app-test has no way to drive.
   */
  forked_from_session_id?: string;
  /** The rewind point's prompt uuid; a placeholder is fine. */
  fork_point?: string;
  /**
   * The line of work this session is a **segment** of ([P01]).
   *
   * Two seeded sessions sharing a `line_id` are two segments of one line,
   * which is how a test stands up a card that has rotated through several
   * claude ids — the callsign, the name and the durable ink are the line's,
   * and a relaunch seats whichever segment the resume rule picks. Defaults to
   * the session's own id, i.e. a line of one.
   */
  line_id?: string;
  /**
   * What a rotation seated this session as, written through the same
   * `set_stage_provenance` a real rotation uses.
   */
  stage_label?: string;
  stage_model?: string;
  /**
   * The row's lifecycle state. The seed writes `live`; `"closed"` marks the
   * row closed afterwards, which is how a test seeds a line whose older
   * segments are done and whose newest one is not.
   */
  state?: "live" | "closed";
}

/**
 * One `file_events` row — the evidence that makes a session own a file.
 * Field names are the ledger's, so the spec is the row.
 */
export interface LedgerSeedFileEvent {
  tug_session_id: string;
  tool_use_id: string;
  /** Absolute or repo-relative; the read side reconciles both. */
  file_path: string;
  tool_name: string;
  op: string;
  /** `exact`/`replay` make an owner; `bash`/`turn` are bracket hints only. */
  origin: string;
  ambiguous: boolean;
  parent_tool_use_id?: string | null;
  project_dir: string;
  /** Epoch ms. Must post-date the path's last commit to stay live. */
  at: number;
  /**
   * Sub-file evidence ([P11]) — what this call wrote *inside* the file, which
   * is what decides whether two owners of the path contend ([P12]). Omit for
   * a span-less row, which claims the whole file exactly as it did before
   * spans existed.
   */
  spans?: LedgerSeedSpan[];
}

/** One content anchor on a seeded file event (Spec S04). */
export interface LedgerSeedSpan {
  /** Ordinal within the row, from 0. */
  seq: number;
  /** `whole` | `insert` | `replace` | `hunk`. */
  kind: string;
  /** JSON anchor: `{"new_hash","new_head","new_len"}` for insert/replace,
   *  `{"hunk_id"}` for hunk, `{}` for whole. */
  anchor: string;
}

/** See {@link LaunchTugAppOptions.seedLedger}. */
export interface LedgerSeedSpec {
  sessions?: LedgerSeedSession[];
  file_events?: LedgerSeedFileEvent[];
}

export interface LaunchTugAppOptions {
  /**
   * Absolute path to the Tug.app binary to launch. If unset, the
   * harness resolves a default debug build via `Tug.app/Contents/
   * MacOS/Tug` under `tugapp/` build products.
   */
  appPath?: string;

  /**
   * Socket path the harness will tell Tug.app to listen on. If unset,
   * a per-invocation uuid path under `/tmp/tugapp-test-<uuid>.sock` is
   * generated.
   */
  socketPath?: string;

  /**
   * Maximum wall-clock time to wait for the Unix socket to become
   * connectable, in milliseconds. Default 10000.
   */
  connectTimeoutMs?: number;

  /**
   * Poll interval for connect retries in milliseconds. Default 100.
   */
  connectPollMs?: number;

  /**
   * Additional environment variables to pass to the Tug.app
   * subprocess. Merged on top of the current `process.env`.
   */
  env?: Record<string, string>;

  /**
   * Test name; used for the `logs/<test-name>.log` capture path when
   * stdout/stderr redirection is enabled. Optional. When set, the
   * harness opens `tests/app-test/logs/<testName>.log` and pipes the
   * subprocess's stdout/stderr into it; `app.logPath` is populated so
   * tests can call `app.tailLog()` on failure.
   */
  testName?: string;

  /**
   * Override the harness-expected surface version for the handshake.
   * Defaults to `EXPECTED_SURFACE_VERSION` (the compile-time constant
   * in `_harness/index.ts`). Tests that want to exercise the
   * version-skew code path pass a deliberately-wrong value here; in
   * production test code this is never set.
   */
  expectedSurfaceVersion?: string;

  /**
   * Skip the `checkAccessibilityPermission` preflight during launch.
   * Defaults to false (strict) so native-gesture tests get a crisp
   * failure when the grant is missing. Tests that use only `evalJS` /
   * `waitForCondition` — e.g. the existing version-handshake /
   * double-connect / wait-for-condition harness tests — pass `true`
   * to avoid coupling those suites to the AX grant state.
   */
  skipAccessibilityPreflight?: boolean;

  /**
   * Launch the app frontmost and route native events through the
   * session event tap, the way a user's input arrives.
   *
   * Defaults to false: an app-test launches in the background and the
   * in-app harness addresses events to its own process, so a run never
   * takes the developer's focus, cursor, or key window.
   *
   * Pass `true` only for tests whose SUBJECT is activation — key-window
   * status, app resign / become-active, responder-chain routing that
   * AppKit gates on being active. Those cannot be observed in an
   * inactive app. A foreground launch takes the screen for its
   * duration, so it is the marked, minority case.
   */
  foreground?: boolean;

  /**
   * Disable test-mode's persistence-bypass so tugbank writes from
   * `deck-manager`'s `put*Guarded` wrappers actually go through.
   * Used by cold-boot harness tests ([AT0014] scroll / focus round-trips)
   * paired with a per-test `TUGBANK_PATH` so pollution of the
   * developer's real `~/.tugbank.db` is impossible.
   *
   * Sets `TUGAPP_PERSIST_IN_TEST_MODE=1` on the launched Tug.app's
   * environment; Swift's `TestHarnessUserScript` then injects
   * `window.__tugPersistInTestMode = true` alongside `__tugTestMode`,
   * which `deck-manager` reads to skip the bypass.
   *
   * Defaults to false. Ordinary in-app tests should leave it unset
   * to keep the bypass active and writes silent.
   */
  persistInTestMode?: boolean;

  /**
   * Restore the deck from tugbank at boot instead of starting empty.
   * Test mode normally discards the tugbank-sourced boot arguments so
   * `seedDeckState` is the sole source of state; this flag makes the
   * `DeckManager` constructor honor the persisted layout, card-state
   * bags, and focused-card id — the production cold-boot restore
   * channel (constructor deck restore → CardHost mount-time
   * `applyBagFocus`), which `seedDeckState`'s cache-merge cannot
   * drive. Pair with `persistInTestMode` and a per-test
   * `TUGBANK_PATH`: a prior launch persists on quit, this launch
   * restores from the same file with no seeding.
   *
   * Sets `TUGAPP_RESTORE_IN_TEST_MODE=1` on the launched Tug.app's
   * environment; Swift's `TestHarnessUserScript` injects
   * `window.__tugRestoreInTestMode = true`, which `deck-manager`
   * reads in its constructor.
   */
  restoreInTestMode?: boolean;

  /**
   * Override the harness-minted instance ID. When unset, the harness
   * generates `apptest-<uuid>` per launch — each `launchTugApp` call
   * gets its own per-instance data dir, tugbank, and tmux session.
   * When set, the harness uses the caller-provided ID verbatim. Use
   * this to share an instance across the Phase A / Phase B launches
   * of a cross-launch test (e.g. cold-boot tests that want broader-
   * than-tugbank continuity).
   *
   * Sets `TUG_INSTANCE_ID` on the launched app's environment;
   * tugcore::instance and Swift InstanceConfig both read it.
   */
  instanceId?: string;

  /**
   * Keep the ConfigureTug wizard live in this launch. By default the harness
   * suppresses it: every app-test instance boots a fresh per-instance
   * tugbank, which reads as a first run, and the blocking wizard would
   * steal focus from every focus/selection-driven test. tugcast seeds a
   * `suppress-setup` tugbank default when it sees the harness marker;
   * setting `keepSetup: true` sets `TUGAPP_TEST_KEEP_SETUP=1` so the
   * seed flips to `false` — for tests that explicitly test ConfigureTug.
   */
  keepSetup?: boolean;
}
