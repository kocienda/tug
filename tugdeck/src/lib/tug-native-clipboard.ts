/**
 * tug-native-clipboard — native clipboard bridge for Tug.app (WKWebView).
 *
 * ## Why this exists
 *
 * Safari's JavaScript Clipboard API (`navigator.clipboard.readText` / `.read`)
 * triggers a floating "Paste" permission popup on every invocation, and in
 * Safari 16.4+ `document.execCommand("paste")` on contentEditable elements
 * triggers the same popup. There is no JavaScript-only path to read the
 * system clipboard from a WKWebView-hosted web page without the popup.
 *
 * The only way to supply clipboard data to JavaScript without the popup in
 * this context is to delegate to the native side: read `NSPasteboard.general`
 * from Swift and pass the contents back via `evaluateJavaScript`. Tug.app
 * (macOS host, `tugapp/Sources/MainWindow.swift`) exposes a
 * `WKScriptMessageHandler` named `clipboardRead` that does exactly this.
 * This module wraps the asynchronous message roundtrip in a Promise.
 *
 * ## Protocol
 *
 * 1. JS calls `readClipboardViaNative()`.
 * 2. This module generates a unique `requestId`, stores the promise's
 *    `resolve` in a pending-callbacks map keyed by that id, and posts
 *    `{ requestId }` to the Swift handler.
 * 3. Swift reads `NSPasteboard.general.string(forType: .string)` and
 *    `.html`, JSON-encodes them, and calls
 *    `window.__tugNativeClipboardCallback({ requestId, text, html })`.
 * 4. This module's callback looks up the resolver by `requestId`, deletes
 *    the entry, and resolves with `{ text, html }`.
 *
 * A safety timeout (1 second) guards against the Swift side never calling
 * back — the continuation would otherwise hang forever. On timeout the
 * promise resolves with empty strings.
 *
 * ## When to use
 *
 * In paste handlers that need clipboard access from a non-native gesture
 * (e.g. our custom context menu's Paste item). Check
 * `hasNativeClipboardBridge()` before calling: when the bridge is absent
 * (browser-only development, tests, standalone previews), fall back to the
 * JS Clipboard API. The native bridge is strictly a production-in-Tug.app
 * optimization — the JS fallback still works elsewhere, just with the
 * Safari popup if the user is on Safari.
 */

/** Shape of the clipboard payload returned by the native bridge. */
export interface NativeClipboardReadResult {
  /** Plain text contents of NSPasteboard (.string type). Empty string if none. */
  text: string;
  /** HTML contents of NSPasteboard (.html type). Empty string if none. */
  html: string;
  /**
   * Tug-private atom sidecar JSON read from NSPasteboard's
   * `dev.tugapp.prompt-atoms` type. Non-empty only when the clipboard was
   * last written by a Tug copy/cut via {@link writeClipboardViaNative};
   * empty for external-app clipboards. This is the robust Tug-to-Tug
   * channel — it bypasses WebKit's HTML sanitizer and custom-MIME
   * repacking entirely. Parse with `parseClipboardSidecar`.
   */
  atoms: string;
}

interface ClipboardBridgeMessageHandlers {
  clipboardRead?: { postMessage: (v: unknown) => void };
  clipboardWrite?: { postMessage: (v: unknown) => void };
  clipboardWriteImage?: { postMessage: (v: unknown) => void };
}

interface ClipboardWebkit {
  messageHandlers?: ClipboardBridgeMessageHandlers;
}

/** Map of pending requestId → resolver. */
const pendingCallbacks = new Map<string, (result: NativeClipboardReadResult) => void>();

let callbackInstalled = false;

/**
 * Install the JS callback that Swift invokes via evaluateJavaScript.
 * Idempotent — safe to call multiple times.
 */
function installCallback(): void {
  if (callbackInstalled) return;
  callbackInstalled = true;
  (globalThis as Record<string, unknown>).__tugNativeClipboardCallback = (
    data: { requestId: string; text: string; html: string; atoms?: string },
  ) => {
    if (!data || typeof data.requestId !== "string") return;
    const resolver = pendingCallbacks.get(data.requestId);
    if (resolver) {
      pendingCallbacks.delete(data.requestId);
      resolver({
        text: typeof data.text === "string" ? data.text : "",
        html: typeof data.html === "string" ? data.html : "",
        atoms: typeof data.atoms === "string" ? data.atoms : "",
      });
    }
  };
}

/**
 * True if the native clipboard bridge is available — i.e. the page is
 * running inside Tug.app's WKWebView and the Swift side has registered
 * the `clipboardRead` message handler. False in a normal browser.
 *
 * Callers should branch on this: prefer the native bridge when it's
 * present (no Safari permission popup), fall back to the JS Clipboard
 * API when it's absent (normal browser development).
 */
export function hasNativeClipboardBridge(): boolean {
  const webkit = (globalThis as unknown as { webkit?: ClipboardWebkit }).webkit;
  return typeof webkit?.messageHandlers?.clipboardRead?.postMessage === "function";
}

/**
 * True if the page is running inside a WKWebView, independent of
 * whether the clipboard bridge is installed.
 *
 * Detects WKWebView by checking for `window.webkit.messageHandlers`
 * — a surface that only exists in WKWebView contexts, never in plain
 * Safari web content. Used to distinguish "no native bridge because
 * we're in a normal browser" (legitimate — fall through to JS APIs
 * silently) from "no native bridge because the Swift side hasn't
 * installed the `clipboardRead` handler yet" (a race — worth warning
 * about at the point of actual fall-through).
 *
 * Pair with {@link hasNativeClipboardBridge} at paste-handler
 * fall-through sites: if the bridge is missing AND we're inside a
 * WKWebView, it's the race condition the audit identified — call
 * {@link warnIfWKWebViewRace} to make it audible.
 */
export function isInsideWKWebView(): boolean {
  const webkit = (globalThis as unknown as { webkit?: { messageHandlers?: unknown } }).webkit;
  return webkit?.messageHandlers !== undefined;
}

// ---- WKWebView race diagnostic ----
//
// Single-shot warning flag. Flipped on the first fall-through that
// matches "inside WKWebView but native clipboard bridge missing" so
// the console isn't spammed across many paste attempts during the
// same page load. Reset by `__resetWKWebViewRaceWarningForTest` for
// test isolation.
let wkWebViewRaceWarningFired = false;

/**
 * Emit a one-shot console warning if a paste handler has just fallen
 * through to the JS clipboard path while running inside a WKWebView
 * — the race condition from the audit.
 *
 * Called from the paste fall-through site (not from a React effect).
 * This is a **causal** diagnostic, not a speculative one: the warning
 * fires at the exact moment the wrong branch was taken, not at mount
 * time as a pre-emptive assertion. That means it requires zero React
 * lifecycle involvement, holds no state beyond a module-level
 * "already fired" flag, and stays silent in every environment where
 * the race does not actually happen (plain browser development,
 * Tug.app production with the bridge correctly installed).
 *
 * The warning fires at most once per page load. Subsequent paste
 * fall-throughs are silent — the point has been made, further
 * warnings would just be noise. A fresh page load (or a test that
 * calls `__resetWKWebViewRaceWarningForTest`) resets the flag.
 */
export function warnIfWKWebViewRace(): void {
  if (wkWebViewRaceWarningFired) return;
  if (!isInsideWKWebView()) return;
  wkWebViewRaceWarningFired = true;
  console.warn(
    "[tug-native-clipboard] Paste fell through to JS Clipboard API, " +
      "but the page is running inside a WKWebView. The Swift-side " +
      "`clipboardRead` message handler was not installed at dispatch " +
      "time — a paste that fires before `MainWindow.swift` registers " +
      "the handler takes the JS fallback path and may trigger Safari's " +
      "permission popup. Check `MainWindow.swift`'s WKScriptMessageHandler " +
      "setup; expected install order is before the first JS evaluation.",
  );
}

/**
 * Test-only reset of the WKWebView race warning flag. Exported so
 * unit tests can exercise `warnIfWKWebViewRace` without bleeding state
 * across test cases. Not part of the public runtime API — the name
 * starts with `__` so it's clearly private-by-convention.
 */
export function __resetWKWebViewRaceWarningForTest(): void {
  wkWebViewRaceWarningFired = false;
}

/**
 * Write image bytes to the system clipboard via the native NSPasteboard
 * bridge. `base64` is the raw image bytes (PNG/JPEG/…), base64-encoded —
 * the host decodes it into an `NSImage` and writes that to the general
 * pasteboard so any app can paste it.
 *
 * Fire-and-forget: NSPasteboard writes synchronously on the Swift side, so
 * there's no callback to await. Returns `true` when the bridge is present
 * and the message was posted (the dependable path inside Tug.app), `false`
 * when it's absent (normal browser dev) so callers can fall back to the JS
 * Clipboard API. Mirrors {@link hasNativeClipboardBridge}'s detection.
 */
export function writeImageToNativeClipboard(base64: string): boolean {
  const webkit = (globalThis as unknown as { webkit?: ClipboardWebkit }).webkit;
  const handler = webkit?.messageHandlers?.clipboardWriteImage;
  if (!handler || typeof handler.postMessage !== "function") return false;
  if (base64.length === 0) return false;
  handler.postMessage({ base64 });
  return true;
}

/**
 * Write a Tug prompt selection to the system clipboard via the native
 * NSPasteboard bridge. `text` is the readable plain-text fallback
 * (atom labels substituted for U+FFFC) written to `.string` so external
 * apps paste meaningful text; `atoms` is the atom sidecar JSON written
 * to the Tug-private `dev.tugapp.prompt-atoms` type, or `""` when the
 * selection carried no atoms.
 *
 * This is the copy counterpart to {@link readClipboardViaNative}: inside
 * Tug.app the web layer must NOT write atom-bearing selections through
 * the DOM `copy` event, because WebKit's pasteboard normalization
 * swallows custom MIME types (into the undocumented
 * `com.apple.WebKit.custom-pasteboard-data` blob) and sanitizes HTML —
 * both of which drop atom data. Owning the whole write natively avoids
 * that round-trip entirely, and avoids the race where WebKit's own
 * post-event pasteboard write would clobber a native write.
 *
 * `html`, when supplied, is written to `.html` beside the other two. A
 * surface that renders its text — the transcript — has a rich-text flavor
 * worth carrying, and once it owns the whole write to carry a sidecar it has
 * to carry that flavor too or an external paste silently loses its formatting.
 * Omit it and only `.string` is declared, which is the prompt entry's case.
 *
 * Fire-and-forget: NSPasteboard writes synchronously on the Swift side.
 * Returns `true` when the bridge is present and the message was posted,
 * `false` when it's absent (normal browser dev) so callers fall back to
 * the DOM `copy` path. Mirrors {@link hasNativeClipboardBridge}'s
 * detection.
 */
export function writeClipboardViaNative(
  text: string,
  atoms: string,
  html?: string,
): boolean {
  const webkit = (globalThis as unknown as { webkit?: ClipboardWebkit }).webkit;
  const handler = webkit?.messageHandlers?.clipboardWrite;
  if (!handler || typeof handler.postMessage !== "function") return false;
  handler.postMessage({ text, atoms, html: html ?? "" });
  return true;
}

/** How long to wait for the Swift callback before giving up. */
const NATIVE_CLIPBOARD_TIMEOUT_MS = 1000;

/**
 * Read the system clipboard via the native NSPasteboard bridge.
 *
 * Returns a Promise that resolves with `{ text, html }` once the Swift
 * side has called back. If the bridge is not installed, resolves
 * immediately with empty strings — callers should check
 * `hasNativeClipboardBridge()` first and take the JS fallback path when
 * it returns false.
 *
 * If the Swift side fails to respond within `NATIVE_CLIPBOARD_TIMEOUT_MS`,
 * resolves with empty strings so dependent continuations don't hang
 * forever.
 */
export function readClipboardViaNative(): Promise<NativeClipboardReadResult> {
  const webkit = (globalThis as unknown as { webkit?: ClipboardWebkit }).webkit;
  const handler = webkit?.messageHandlers?.clipboardRead;
  if (!handler || typeof handler.postMessage !== "function") {
    return Promise.resolve({ text: "", html: "", atoms: "" });
  }
  installCallback();
  const requestId = `tug-clip-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise<NativeClipboardReadResult>((resolve) => {
    // Single settlement path: the first of {Swift callback, timeout} wins.
    // `settled` guards against the race where both paths fire.
    let settled = false;
    const settle = (result: NativeClipboardReadResult) => {
      if (settled) return;
      settled = true;
      pendingCallbacks.delete(requestId);
      clearTimeout(timeoutHandle);
      resolve(result);
    };
    pendingCallbacks.set(requestId, settle);
    const timeoutHandle = setTimeout(() => {
      if (!settled) {
        console.warn(
          `tug-native-clipboard: Swift callback timed out after ${NATIVE_CLIPBOARD_TIMEOUT_MS}ms`,
        );
        settle({ text: "", html: "", atoms: "" });
      }
    }, NATIVE_CLIPBOARD_TIMEOUT_MS);
    handler.postMessage({ requestId });
  });
}
