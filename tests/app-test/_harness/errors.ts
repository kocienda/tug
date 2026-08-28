/**
 * errors.ts — Harness error classes.
 *
 * Structured errors for the in-app harness RPC client.
 * Structured errors let test authors `catch (e) { if (e instanceof
 * TimeoutError) ... }` without string-matching on messages.
 *
 * Error translation rule: the Swift side serializes errors as
 * `{ ok: false, error: { name, message, stack? } }`. The harness's RPC
 * client (see `./rpc.ts`) reads `error.name` and throws the matching
 * class. Unknown names fall back to a plain `Error` with the server's
 * message preserved.
 *
 * Classes here are intentionally minimal — just the fields tests will
 * actually branch on. `name` is a readonly literal so `switch` on
 * `e.name` works for codegen-generated clients that can't use
 * `instanceof` across bundle boundaries.
 */

/**
 * Thrown when the Swift bridge reports that an `evalJS` or
 * `waitForCondition` exceeded its budget. `script` is the original
 * script body if available; `timeoutMs` is the budget that was exceeded.
 */
export class TimeoutError extends Error {
  readonly name = "TimeoutError" as const;
  readonly script: string | undefined;
  readonly timeoutMs: number | undefined;

  constructor(message: string, script?: string, timeoutMs?: number) {
    super(message);
    this.script = script;
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

/**
 * Thrown when the Tug.app subprocess exits unexpectedly (the Swift
 * bridge closes the socket or the process dies). `exitCode` /
 * `signal` come from the Bun subprocess handle when available.
 */
export class AppCrashedError extends Error {
  readonly name = "AppCrashedError" as const;
  readonly exitCode: number | null | undefined;
  readonly signal: string | null | undefined;

  constructor(
    message: string,
    exitCode?: number | null,
    signal?: string | null,
  ) {
    super(message);
    this.exitCode = exitCode;
    this.signal = signal;
    Object.setPrototypeOf(this, AppCrashedError.prototype);
  }
}

/**
 * Thrown when the `version` handshake reports a major version the
 * harness client does not understand. `expected` is the harness's
 * compiled-in expected version; `actual` is what the Swift/JS side
 * reported over the wire.
 */
export class VersionSkewError extends Error {
  readonly name = "VersionSkewError" as const;
  readonly expected: string;
  readonly actual: string;

  constructor(message: string, expected: string, actual: string) {
    super(message);
    this.expected = expected;
    this.actual = actual;
    Object.setPrototypeOf(this, VersionSkewError.prototype);
  }
}

/**
 * Thrown when a native gesture verb (nativeClick, nativeDrag, etc.)
 * resolves a viewport point that falls outside the WKWebView's
 * visible frame. The Swift side
 * reports this as `CoordinateOutOfBoundsError` and the harness
 * translates to this class.
 *
 * The `viewportPoint` field preserves the out-of-bounds input for
 * actionable test failures: "you asked for (1000, 50) but the
 * WKWebView is only 800px wide."
 */
export class CoordinateOutOfBoundsError extends Error {
  readonly name = "CoordinateOutOfBoundsError" as const;

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, CoordinateOutOfBoundsError.prototype);
  }
}

/**
 * Thrown when `nativeType(text)` receives non-ASCII input. Phase C
 * scope per the 2026-04-24 user call is US-English ASCII only; IME
 * / non-ASCII text is out of envelope. Tests that want to exercise
 * Unicode paths use the dispatch-over-DOM mechanism instead.
 */
export class NativeTypeAsciiOnlyError extends Error {
  readonly name = "NativeTypeAsciiOnlyError" as const;

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, NativeTypeAsciiOnlyError.prototype);
  }
}

/**
 * Thrown when `launchTugApp`'s accessibility-permission preflight
 * (Step 3) finds that the Tug.app binary does not have macOS
 * Accessibility permission granted. Without the grant, every
 * `CGEvent.post` silently no-ops — so tests that depend on native
 * gestures would timeout mysteriously. Surfacing this as a typed
 * error up-front gives the user actionable guidance: which binary
 * path to add in System Settings → Privacy & Security → Accessibility.
 *
 * See [D14]: the stable-signing workflow (`just setup-dev-signing`)
 * ensures that ONE grant persists across rebuilds, so this error
 * only fires on the very first run per machine (or after a
 * `tccutil reset`).
 */
export class AccessibilityPermissionMissingError extends Error {
  readonly name = "AccessibilityPermissionMissingError" as const;

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, AccessibilityPermissionMissingError.prototype);
  }
}

/**
 * Thrown when a key-name passed to `nativeKey(key, ...)` or
 * `nativeType(text)` doesn't appear in the Swift-side
 * `VirtualKeyMap` (US-English table). The error message includes
 * the offending name so test authors can pick an alternative or
 * spell it correctly (e.g. `"Enter"` not `"Return"` — though
 * "Return" is aliased in the table, plenty of DOM names are not).
 */
export class UnknownKeyError extends Error {
  readonly name = "UnknownKeyError" as const;

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, UnknownKeyError.prototype);
  }
}

/**
 * Thrown when a `nativeClick(..., { activateFirst: false })` cannot reach the
 * app's own window, because another application's window is in front of it at
 * that point.
 *
 * A click into a BACKGROUNDED app is routed by WindowServer to whatever window
 * is actually frontmost at the cursor, so an obstructed one is not a slow
 * click — it is a click another window received. Without this the app simply
 * never comes forward and the test fails some seconds later on whatever the
 * click was supposed to cause, which says nothing about the real cause.
 */
export class ActivationClickObstructedError extends Error {
  readonly name = "ActivationClickObstructedError" as const;

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, ActivationClickObstructedError.prototype);
  }
}

/**
 * Thrown when `startTugcode` fails — either because the binary
 * path is missing/invalid, the `Process.run()` call errored, the
 * stdout/stderr log file could not be opened, the stub-mode
 * transcript could not be written, or a tugcode child is already
 * running on this connection. The wire `name` is
 * `TugcodeLaunchError`; `message` carries the actionable detail
 * (e.g. "tugcode binary not found at <path>").
 */
export class TugcodeLaunchError extends Error {
  readonly name = "TugcodeLaunchError" as const;

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, TugcodeLaunchError.prototype);
  }
}

/**
 * Thrown when a transcript's `tugcodeVersion` does not match the
 * binary version the harness expects. Reserved for the long-term
 * transcript-stability story [D06]; the
 * runtime emit-and-throw path is not yet wired (deferred to a
 * follow-up). Class is defined here so test code can reference it
 * once the wiring lands.
 */
export class TugcodeVersionSkewError extends Error {
  readonly name = "TugcodeVersionSkewError" as const;
  readonly expected: string;
  readonly actual: string;

  constructor(message: string, expected: string, actual: string) {
    super(message);
    this.expected = expected;
    this.actual = actual;
    Object.setPrototypeOf(this, TugcodeVersionSkewError.prototype);
  }
}

/**
 * Thrown by the transcript loader (`tests/app-test/_harness/transcript.ts`)
 * when a transcript file's content does not match its `.sha256`
 * sidecar. The capture / reapprove scripts produce sidecar files
 * for committed transcripts; runtime test code calling
 * `loadTranscriptWithSidecar` gets this error if the transcript
 * has been edited without rerunning `reapprove-transcript.ts`.
 */
export class TugcodeTranscriptMismatchError extends Error {
  readonly name = "TugcodeTranscriptMismatchError" as const;
  readonly transcriptPath: string;
  readonly expectedHash: string;
  readonly actualHash: string;

  constructor(
    message: string,
    transcriptPath: string,
    expectedHash: string,
    actualHash: string,
  ) {
    super(message);
    this.transcriptPath = transcriptPath;
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
    Object.setPrototypeOf(this, TugcodeTranscriptMismatchError.prototype);
  }
}

/**
 * Thrown when one of the `simulateApp*` verbs invokes its NSApp
 * primitive but the matching `NSApplication.did...Notification`
 * does not fire within the bounded wait window (default 1000ms).
 *
 * The most common cause is calling a verb when the app is already
 * in the requested state — e.g. `simulateAppHide` when the app is
 * already hidden. NSApp short-circuits the request and posts no
 * notification.
 *
 * `event` is the notification name the Swift bridge was waiting
 * for ("didResignActive", "didBecomeActive", "didHide",
 * "didUnhide"); useful for branching in tests that exercise
 * deliberate-timeout paths.
 */
export class AppLifecycleTimeoutError extends Error {
  readonly name = "AppLifecycleTimeoutError" as const;
  readonly event: string;

  constructor(message: string, event: string) {
    super(message);
    this.event = event;
    Object.setPrototypeOf(this, AppLifecycleTimeoutError.prototype);
  }
}
