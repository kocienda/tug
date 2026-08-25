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
 * ## The anchor is a baseline, and it travels with the font
 *
 * `showDefinition` does not merely position a panel: it redraws the string
 * itself as a yellow callout over the word, and it needs to land that callout
 * exactly on top of the text the user selected. Two facts decide whether it
 * does.
 *
 * **`at:` is the baseline origin of the first character**, not the top-left
 * and not the bottom of the line box. A range's client rect is a box around
 * the glyphs; the baseline sits an ascent below its top, with any leading
 * split above and below. Handing over the rect's bottom edge drops the
 * callout by a descent plus half the leading — visibly low, which is what
 * this module used to do.
 *
 * **The font rides along.** AppKit measures the callout from the attributed
 * string's own attributes, so a string with no font attribute is drawn at the
 * default system size and lands at the wrong ascent no matter how exact the
 * origin is. The selection's computed font crosses the bridge with it, and
 * the host resolves what it can of the family list.
 *
 * The first client rect is the one that matters — a selection wrapped across
 * lines has a union rect spanning all of them, and the first character lives
 * on the first line.
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
  /** Viewport (CSS) x of the first character's baseline origin. */
  x: number;
  /** Viewport (CSS) y of that baseline. */
  y: number;
  /** The selection's computed `font-family` list, for the host to resolve. */
  fontFamily: string;
  /** The selection's computed font size, in CSS px. */
  fontSize: number;
  /** True when the selection is bold enough to change the callout's metrics. */
  bold: boolean;
  /** True when the selection is italic or oblique. */
  italic: boolean;
}

/**
 * The longest selection worth sending. The definition panel resolves a word
 * or a short phrase; past that there is nothing to look up, and the cap keeps
 * a stray Select All from pushing a whole document across the bridge.
 */
const MAX_LOOKUP_LENGTH = 256;

/**
 * Where the baseline sits inside a client rect when the font's own metrics
 * are unavailable — a rough ascent fraction, only ever reached on an engine
 * with no `fontBoundingBoxAscent`.
 */
const FALLBACK_ASCENT_RATIO = 0.8;

/** One canvas for every measurement; `measureText` needs no fresh context. */
let measuringContext: CanvasRenderingContext2D | null | undefined;

function measuringCtx(): CanvasRenderingContext2D | null {
  if (measuringContext === undefined) {
    measuringContext = document.createElement("canvas").getContext("2d");
  }
  return measuringContext;
}

/** The element whose computed style governs `range`'s first character. */
function styleAtStart(range: Range): CSSStyleDeclaration | null {
  const node = range.startContainer;
  const element =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  return element === null ? null : window.getComputedStyle(element);
}

/**
 * The rect of the range's first line — the one the first character is on.
 * A selection that wrapped has one rect per line; the bounding rect is their
 * union and would put the baseline somewhere in the middle of the block.
 */
function firstLineRect(range: Range): DOMRect | null {
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width > 0 || rect.height > 0) return rect;
  }
  const bounds = range.getBoundingClientRect();
  return bounds.width > 0 || bounds.height > 0 ? bounds : null;
}

/**
 * The same range with any leading or trailing whitespace left outside it.
 *
 * WebKit's contextual word-select reaches past the word it landed on, so a
 * bare right-click hands back `"shared "` where the reader sees `shared`. The
 * callout is drawn around whatever range this measures, so an untrimmed one
 * paints a box wider than the word with a bite of the space beside it — the
 * only visible difference between this and a native text view's Look Up.
 *
 * Trimming is a pure narrowing of the offsets, so it is only attempted where
 * the whitespace is provably inside a text node the range already names.
 * Anything else keeps the original range: a slightly wide callout beats a
 * thrown range error.
 */
function trimmedRange(range: Range): Range {
  const raw = range.toString();
  const lead = raw.length - raw.trimStart().length;
  const trail = raw.length - raw.trimEnd().length;
  if (lead === 0 && trail === 0) return range;
  if (raw.trim() === "") return range;
  const trimmed = range.cloneRange();
  try {
    const start = trimmed.startContainer;
    if (
      lead > 0 &&
      start.nodeType === Node.TEXT_NODE &&
      trimmed.startOffset + lead <= (start.nodeValue?.length ?? 0)
    ) {
      trimmed.setStart(start, trimmed.startOffset + lead);
    }
    const end = trimmed.endContainer;
    if (
      trail > 0 &&
      end.nodeType === Node.TEXT_NODE &&
      trimmed.endOffset - trail >= 0
    ) {
      trimmed.setEnd(end, trimmed.endOffset - trail);
    }
  } catch {
    return range;
  }
  return trimmed.collapsed ? range : trimmed;
}

/**
 * Build the payload for defining `text`, whose glyphs `range` covers.
 *
 * `fallback` is the viewport point to anchor at when the range has no
 * measurable box — a native `<input>` or `<textarea>` holds its selection
 * outside the DOM's, so there is a selection to define but no glyph box to
 * find it by. The callout then lands under the pointer instead of on the
 * word, which is a small compromise where the alternative is refusing to
 * define a word the user plainly selected.
 */
export function dictionaryLookupFor(
  range: Range,
  text: string,
  fallback?: { x: number; y: number },
): DictionaryLookupRequest | null {
  const defined = text.trim();
  if (defined === "") return null;

  range = trimmedRange(range);
  const rect = firstLineRect(range);
  if (rect === null) {
    return fallback === undefined
      ? null
      : {
          text: defined,
          x: fallback.x,
          y: fallback.y,
          fontFamily: "",
          fontSize: 0,
          bold: false,
          italic: false,
        };
  }

  const style = styleAtStart(range);
  const fontSize = style === null ? 0 : Number.parseFloat(style.fontSize);
  const fontFamily = style?.fontFamily ?? "";
  const weight = style === null ? 400 : Number.parseInt(style.fontWeight, 10);
  const bold = Number.isNaN(weight) ? false : weight >= 600;
  const italic = style !== null && style.fontStyle !== "normal";

  // The baseline: an ascent below the glyph box's top, with whatever leading
  // the rect carries split evenly above and below the font's own em box.
  let baseline = rect.top + rect.height * FALLBACK_ASCENT_RATIO;
  const ctx = measuringCtx();
  if (ctx !== null && style !== null) {
    ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${fontFamily}`;
    const metrics = ctx.measureText(defined);
    const ascent = metrics.fontBoundingBoxAscent;
    const descent = metrics.fontBoundingBoxDescent;
    if (typeof ascent === "number" && typeof descent === "number") {
      baseline = rect.top + (rect.height - (ascent + descent)) / 2 + ascent;
    }
  }

  return {
    text: defined,
    x: rect.left,
    y: baseline,
    fontFamily,
    fontSize: Number.isNaN(fontSize) ? 0 : fontSize,
    bold,
    italic,
  };
}

/** True when `value` is a well-formed {@link DictionaryLookupRequest}. */
export function isDictionaryLookupRequest(
  value: unknown,
): value is DictionaryLookupRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.text === "string" &&
    typeof candidate.x === "number" &&
    typeof candidate.y === "number" &&
    typeof candidate.fontFamily === "string" &&
    typeof candidate.fontSize === "number" &&
    typeof candidate.bold === "boolean" &&
    typeof candidate.italic === "boolean"
  );
}

/**
 * Ask the host to show the system definition panel for `request.text`,
 * anchored at the request's baseline origin. A blank selection is a no-op.
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
    handler.postMessage({ ...request, text });
  } else {
    console.info(
      `dictionary-lookup: host bridge unavailable, cannot define "${text}"`,
    );
  }
}
