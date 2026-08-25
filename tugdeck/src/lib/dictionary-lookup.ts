/**
 * dictionary-lookup.ts — hand a text selection to the system dictionary.
 *
 * The Tug.app host registers a `lookUpInDictionary` `WKScriptMessageHandler`
 * (`MainWindow.swift`) that calls AppKit's `showDefinition(for:at:)` on the
 * web view. That is the same call every native text view makes for Look Up in
 * Dictionary, so what appears is the system definition panel — Dictionary,
 * Thesaurus, Wikipedia, and whatever else the user has enabled — not a
 * Tug-drawn imitation of one.
 *
 * The anchor point travels with the text. `showDefinition` wants the baseline
 * origin of the string's first character in the view's coordinates; a
 * WKWebView's coordinate system is Y-down with its origin at the top-left,
 * which is the viewport (CSS) space the web layer already speaks, so a
 * viewport point crosses the bridge unconverted.
 *
 * Outside the host (browser dev / tests) the `webkit` bridge is absent and
 * this no-ops after a debug log — the caller needs no capability check.
 *
 * @module lib/dictionary-lookup
 */

/**
 * The payload a Look Up in Dictionary menu item carries as its
 * `ActionEvent.value`, sampled at menu-open time.
 */
export interface DictionaryLookupRequest {
  /** The selected text to define. */
  text: string;
  /** Viewport (CSS) x of the panel's anchor. */
  x: number;
  /** Viewport (CSS) y of the panel's anchor. */
  y: number;
}

/**
 * The longest selection worth sending. The definition panel resolves a word
 * or a short phrase; past that there is nothing to look up, and the cap keeps
 * a stray Select All from pushing a whole document across the bridge.
 */
const MAX_LOOKUP_LENGTH = 256;

/** True when `value` is a well-formed {@link DictionaryLookupRequest}. */
export function isDictionaryLookupRequest(
  value: unknown,
): value is DictionaryLookupRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.text === "string" &&
    typeof candidate.x === "number" &&
    typeof candidate.y === "number"
  );
}

/**
 * Ask the host to show the system definition panel for `request.text`,
 * anchored at the request's viewport point. A blank selection is a no-op.
 */
export function lookUpInDictionary(request: DictionaryLookupRequest): void {
  const text = request.text.trim().slice(0, MAX_LOOKUP_LENGTH);
  if (text === "") return;
  const webkit = (globalThis as unknown as Record<string, unknown>).webkit as
    | Record<string, unknown>
    | undefined;
  const handlers = webkit?.messageHandlers as Record<string, unknown> | undefined;
  const handler = handlers?.lookUpInDictionary as
    | { postMessage: (v: unknown) => void }
    | undefined;
  if (handler) {
    handler.postMessage({ text, x: request.x, y: request.y });
  } else {
    console.info(
      `dictionary-lookup: host bridge unavailable, cannot define "${text}"`,
    );
  }
}
