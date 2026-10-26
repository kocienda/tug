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
  | "windowState"
  | "sessionTapProbe"
  | "checkAccessibilityPermission"
  | "getElementScreenBounds"
  | "menuSnapshot"
  | "menuItemState"
  | "screenshot"
  | "captureWindow"
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
  | "writeTugcodeStdin"
  | "stopTugcast"
  | "startTugcast"
  | "hostFrames"
  | "spikeBody"
  | "bodies"
  | "simulateMemoryPressure";

/** A memory-pressure level, as the host's dispatch source reports one. */
export type MemoryPressureLevel = "normal" | "warning" | "critical";

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
 * Result of `windowState`: what the keyboard would find in the app.
 * `isKeyWindow` is the harness window's own key status; `appKeyWindow` is
 * whether `NSApp.keyWindow` names any window; `firstResponder` is the class
 * name of the window's first responder, or `null`. In pid mode the host's
 * `TugApplication` has the app believe it is active, so the window is really
 * key and all three read as a foreground app's would — with no activation.
 * `frontmostAtLaunch` / `frontmostNow` are the user's frontmost app by bundle
 * id, read before the host's `run()` and read now; `inputSourceAtLaunch` /
 * `inputSourceNow` are the keyboard input source the same way. A background
 * launch must leave both pairs equal.
 */
export interface WindowState {
  isKeyWindow: boolean;
  appKeyWindow: boolean;
  isActive: boolean;
  firstResponder: string | null;
  frontmostAtLaunch: string | null;
  frontmostNow: string | null;
  inputSourceAtLaunch: string | null;
  inputSourceNow: string | null;
}

/**
 * Result of `sessionTapProbe` (pid mode only): the host posted a Shift
 * down/up to the session event tap — the user's keyboard, as WindowServer
 * routes it — and `received` lists what its own local event monitor saw
 * (`"<NSEvent type>:<keyCode>"`), which must be empty: a real key window in
 * an inactive app must not pull the user's keyboard. `trusted` is whether the
 * post could be delivered at all (Accessibility); a probe that is not
 * trusted has proven nothing. `frontmost` is the user's frontmost app
 * afterwards.
 */
export interface SessionTapProbe {
  trusted: boolean;
  received: string[];
  frontmost: string | null;
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
 * Result of `performMenuItem`: whether the identifier named an item, whether
 * AppKit's validation left it enabled, and whether its action was sent.
 * `performed` is `NSApp.sendAction`'s answer — true when a responder took
 * the action — and is always false for a disabled item, which a menu would
 * not perform either. When `found` is `false`, the other fields are absent.
 */
export type MenuItemPerformed =
  | { found: true; identifier: string; title: string; enabled: boolean; performed: boolean }
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
//
// The view verbs — `evalJS`, `waitForCondition`, `getElementScreenBounds`,
// `screenshot` and the native verbs — carry an optional `card`: present, the
// verb runs in that card's body view; absent, in the shell. A card with no
// body answers `NoSuchBody`.
export type Request =
  | {
      id: number;
      method: "evalJS";
      card?: string;
      script: string;
      timeoutMs?: number;
    }
  | {
      id: number;
      method: "waitForCondition";
      card?: string;
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
      method: "windowState";
    }
  | {
      id: number;
      method: "sessionTapProbe";
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
      card?: string;
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
      card?: string;
    }
  | {
      id: number;
      method: "captureWindow";
    }
  | {
      id: number;
      method: "bodies";
    }
  | {
      id: number;
      method: "simulateMemoryPressure";
      level: MemoryPressureLevel;
    }
  | {
      id: number;
      method: "nativeClick";
      card?: string;
      viewportPoint: ViewportPoint;
      button?: NativeMouseButton;
      clickCount?: number;
      mouseDownDelayMs?: number;
      mouseUpDelayMs?: number;
    }
  | {
      id: number;
      method: "nativeDoubleClick";
      card?: string;
      viewportPoint: ViewportPoint;
      button?: NativeMouseButton;
    }
  | {
      id: number;
      method: "nativeRightClick";
      card?: string;
      viewportPoint: ViewportPoint;
    }
  | {
      id: number;
      method: "nativeDrag";
      card?: string;
      from: ViewportPoint;
      to: ViewportPoint;
      button?: NativeMouseButton;
      mouseDownDelayMs?: number;
      mouseUpDelayMs?: number;
    }
  | {
      id: number;
      method: "nativeDragWithoutRelease";
      card?: string;
      from: ViewportPoint;
      to: ViewportPoint;
      button?: NativeMouseButton;
      mouseDownDelayMs?: number;
      mouseUpDelayMs?: number;
    }
  | {
      id: number;
      method: "nativeMouseDown";
      card?: string;
      viewportPoint: ViewportPoint;
      button?: NativeMouseButton;
    }
  | {
      id: number;
      method: "nativeMouseUp";
      card?: string;
      viewportPoint: ViewportPoint;
      button?: NativeMouseButton;
    }
  | {
      id: number;
      method: "nativeKey";
      card?: string;
      key: string;
      modifiers?: readonly NativeModifier[];
    }
  | {
      id: number;
      method: "nativeType";
      card?: string;
      text: string;
    }
  | {
      id: number;
      method: "holdModifier";
      card?: string;
      modifiers: readonly NativeModifier[];
      innerVerbs: readonly InnerNativeVerb[];
    }
  | {
      id: number;
      method: "pressHeldModifiers";
      card?: string;
      modifiers: readonly NativeModifier[];
    }
  | {
      id: number;
      method: "releaseHeldModifiers";
      card?: string;
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
    }
  | {
      id: number;
      /**
       * Put this instance's tugcast down and keep it down. Answers only
       * once the child is gone, so whatever the test does next happens
       * with nothing watching.
       */
      method: "stopTugcast";
    }
  | {
      id: number;
      /** Bring tugcast back after `stopTugcast`. */
      method: "startTugcast";
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
   * The arc this session is mated to — its **owner key**, applied through the
   * same `set_arc_binding` a real `bind_arc` uses.
   *
   * Seed it to stand up "another live session is holding this arc", which is
   * what the shade's release-reach rule refuses on. `bound_session` is
   * computed from these rows, so a client-side `bind_arc_ok` cannot fake it.
   */
  arc_id?: string;
  /** The arc's short name; defaults to `arc_id` when omitted. */
  arc_name?: string;
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
  /** What the wheel is to be recorded as having put on the wire (Spec: the
   *  wheel's own record; see `tuglaws/wheel.md`). A replay attributes a
   *  submission whose sent text one of these holds to the wheel. */
  wheel_prompts?: LedgerSeedWheelPrompt[];
  /** Posts on the Overview channel, persisted as the Observer's are, so a
   *  page that asks tugcast for the channel's tail — the shell's or the
   *  Overview's body — is answered with them. */
  overview_posts?: LedgerSeedOverviewPost[];
}

/** One Overview post. See {@link LedgerSeedSpec.overview_posts}. */
export interface LedgerSeedOverviewPost {
  at_ms: number;
  author: "observer" | "operator" | "user";
  body: string;
  refs?: unknown[];
  session_id?: string;
  /** The root the post's refs and mentions resolve against. */
  project_dir?: string;
}

/** One prompt the wheel sent. See {@link LedgerSeedSpec.wheel_prompts}. */
export interface LedgerSeedWheelPrompt {
  /** A session on the line the prompt belongs to. */
  session_id: string;
  /** The prompt as it went on the wire — NOT claude's `<command-*>` envelope. */
  text: string;
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
   * takes the developer's focus, cursor, or key window. The host has the
   * app believe it is active and the harness window really key
   * (`TugApplication`), so AppKit's own routing holds: each ⌘ chord is
   * offered to the window's views before the main menu, and the Edit
   * menu's nil-target actions resolve from the key window's first
   * responder. A chord, a menu command or a pasteboard read is therefore a
   * background test.
   *
   * Pass `true` only for a test whose events can reach nothing but the
   * really active app: keys WindowServer delivers to another process (the
   * host's remote open panel), or a drag that moves the user's cursor.
   * Key-window status, focus, the caret and the app's resign / become-active
   * / hide cycle are all background tests — pid mode's window is really key
   * and the lifecycle verbs move the app's believed activation in-process. A
   * foreground launch takes the screen for its duration, so it is the
   * marked, minority case, declared on the file as `@foreground activation`.
   */
  foreground?: boolean;

  /**
   * Launch in the background, as every test does, but keep the web views
   * rendering while the harness window is covered.
   *
   * WebKit suspends `requestAnimationFrame` in an occluded window, and the
   * background launch puts the window a level below normal, so a reading
   * of frames, paint or motion would hang there rather than read. Every
   * background launch turns the WKWebViews' occlusion detection off in the
   * app (WebKit's `_windowOcclusionDetectionEnabled` SPI), so the window
   * stays where it was left and still renders; this tier matters only where
   * that SPI is absent, when the app orders the window front at normal
   * level without activating, so the user keeps keyboard, cursor and key
   * window and only sees a window. Declared on the file with `@visible`. A
   * test whose events reach only the really active app is `foreground`,
   * never this.
   */
  visible?: boolean;

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
   * Launch the page under clip mode, for a site clip recording: `--tug-timing`
   * pinned to 1 on every page and the composer's caret blink stilled, so the
   * two cuts of a scene — one per theme mode — have the same frames.
   *
   * Sets `TUGAPP_CLIP_MODE=1` on the launched Tug.app's environment; Swift's
   * `TestHarnessUserScript` injects `window.__tugClipMode = true`, which
   * `lib/clip-mode.ts` reads once at boot in the shell and in every body.
   */
  clipMode?: boolean;

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
