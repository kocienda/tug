/**
 * tug-text-editor/theme.ts — `EditorView.theme` extension binding CodeMirror 6
 * editor-internal selectors to the tug 7-element token system.
 *
 * The rules read CSS variables directly (`var(--tug7-…)`), so theme
 * switches at the application level (brio ↔ harmony) propagate to the
 * editor without remount and without explicit `subscribeThemeChange`
 * wiring [D06].
 *
 * Caret and selection rendering:
 *
 *   - **Caret**: a custom layer (`tug-text-editor/caret-layer.ts`) paints a
 *     single `tug-text-editor-caret` div at the head of the main selection
 *     when the editor is focused and the selection is collapsed.
 *     Native WebKit contentEditable caret is suppressed via
 *     `caret-color: transparent` on `.cm-content` because its paint
 *     cache stales across layout-shifting transitions (history-nav
 *     doc swap, typeahead deactivate, atom removal) and produced
 *     doubled-caret strokes.
 *   - **Selection**: a custom layer (`tug-text-editor/selection-layer.ts`)
 *     paints `.cm-selectionBackground` divs behind every non-empty
 *     range. These are real DOM nodes — they cover atom widgets
 *     cleanly and persist when the editor loses focus. Native
 *     `::selection` is suppressed below so it doesn't double-paint
 *     with the layer.
 *
 * This intentionally does NOT use `drawSelection` from
 * `@codemirror/view` — that bundles a styled `.cm-cursor` (which
 * wobbles between text and atom positions because it's sized by
 * `coordsAtPos`'s glyph rect) and a `Prec.highest` theme that
 * forces `caret-color: transparent !important` and `::selection:
 * transparent !important`. The latter collides with the
 * `.cm-content ::selection { color: ... }` glyph-recolor rule
 * declared below. The custom caret + selection layers together
 * cover what drawSelection would, without the precedence battle.
 *
 * Selectors covered:
 *
 *   `&`                            — editor root (.cm-editor)
 *   `.cm-content`                  — editable text surface; sets
 *                                    `caret-color: transparent` to
 *                                    suppress WebKit's native caret
 *                                    (the layer paints the visible
 *                                    one), `font-size`, and
 *                                    `line-height`
 *   `.cm-line`                     — per-line wrapper
 *   `.cm-line::before`             — zero-width, one-row-tall (`1lh`)
 *                                    ghost the caret layer reads to size
 *                                    the caret stroke per visual row
 *   `.cm-content img[data-atom-label]`
 *                                  — atom widgets — no rule; their
 *                                    inline `vertical-align` offset
 *                                    baseline-aligns the chip text with
 *                                    the prose. The chip is sized to fit
 *                                    inside the line box, so an atom
 *                                    never grows its line (atom lines ==
 *                                    text lines)
 *   `.cm-selectionBackground`      — custom selection-layer overlay;
 *                                    active / inactive variants split
 *                                    on `&.cm-focused`
 *   `.cm-content ::selection`      — native ::selection — bg
 *                                    transparent (overlay handles
 *                                    background) and fg recolored to
 *                                    the selection-text token so
 *                                    selected glyphs read clearly
 *                                    against the overlay
 *   `&.cm-readonly`                — readonly state surface + text
 *
 * Line metrics: `.cm-content` carries an explicit `font-size` and
 * `line-height` so the typographic baseline is prop-driven. The leading is
 * derived from the atom register (`editorLineHeightFor`) so the line box can
 * always seat an atom, and the chip is drawn to the register rather than to
 * the line — so an atom never grows its line and text-only and atom-bearing
 * rows stay the same height — no hop. The `.cm-line::before` ghost is a plain
 * `1lh` row used only as the caret layer's per-row height ruler.
 *
 * Host-wrapper styling (rest/hover/focus border, focus-style variants,
 * borderless modifier, disabled state) lives in `tug-text-editor.css` so it
 * participates in `audit-tokens lint`.
 *
 * Laws: [L06] appearance via CSS, [L15] token-driven control states,
 *        [L16] foreground-only rules — host wrapper rules in CSS carry
 *        @tug-renders-on annotations; the editor-internal rules in this
 *        file always pair element + surface together so they are
 *        self-documenting per L16, [L18] element/surface vocabulary,
 *        [L19] file structure, [L20] only own-scope tokens.
 */

import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

// ---------------------------------------------------------------------------
// Token references
// ---------------------------------------------------------------------------

/**
 * Token references used in the theme. Centralized so future swaps (e.g.
 * promoting to `--tugx-text-editor-*` aliases per [L17]) happen in one place.
 */
const TOKENS = {
  contentFg: "var(--tug7-element-field-text-normal-plain-rest)",
  contentBg: "var(--tug7-surface-field-primary-normal-plain-rest)",
  contentBgFocus: "var(--tug7-surface-field-primary-normal-plain-focus)",
  contentBgDisabled: "var(--tug7-surface-field-primary-normal-plain-disabled)",
  contentFgDisabled: "var(--tug7-element-field-text-normal-plain-disabled)",
  contentBgReadonly: "var(--tug7-surface-field-primary-normal-plain-readonly)",
  contentFgReadonly: "var(--tug7-element-field-text-normal-plain-readonly)",
  // Caret stroke color — applied to the `.tug-text-editor-caret` marker
  // painted by `caret-layer.ts`, NOT to `.cm-content`'s caret-color
  // (that's `transparent` to suppress the native caret).
  caret: "var(--tug7-element-field-border-normal-plain-active)",
  // Active selection bg / fg use the CSS `Highlight` / `HighlightText`
  // system colors directly (see `.cm-selectionBackground` and
  // `.cm-content ::selection` rules below). System colors give us
  // pixel-perfect parity with native `::selection` rendering on
  // focused fields without needing to declare them as tokens here.
  // Inactive variant — applied to the selection overlay when the
  // editor itself has lost focus (e.g., the user clicked a nearby
  // button) but the selection should remain visibly present.
  // Cross-*card* inactive paint is a separate mechanism: the host
  // card routes the engine selection through
  // `selectionGuard.cardRanges` and the
  // `::highlight(inactive-selection)` Custom Highlight rule declared
  // in `tug-pane.css` ([L23]).
  selectionBgInactive: "var(--tug7-surface-selection-primary-normal-plain-inactive)",
} as const;

// ---------------------------------------------------------------------------
// tugTheme
// ---------------------------------------------------------------------------

/**
 * The CodeMirror 6 theme extension for `TugTextEditor`.
 *
 * Each rule pairs an element token with its surface token (or sets only
 * appearance properties whose surface is established by an enclosing
 * rule), so [L16] is satisfied without separate `@tug-renders-on`
 * annotations — the surface is in the same rule.
 */
export const tugTheme: Extension = EditorView.theme({
  // Editor root — establishes the surface and base content text color.
  "&": {
    color: TOKENS.contentFg,
    backgroundColor: TOKENS.contentBg,
    height: "100%",
  },

  // Editable text surface. The native WebKit contentEditable caret
  // is suppressed (`caret-color: transparent`) because its paint
  // cache stales across layout-shifting transitions; the visible
  // caret is painted by `caret-layer.ts` instead. Explicit
  // font-size and line-height pin the line metrics so every line is
  // the same height regardless of contents — `caret-layer.ts` reads
  // `lineBlockAt(head).height` to size the caret stroke, so this
  // line-height directly controls caret height too.
  //
  // The four typography rules (`fontFamily`, `fontSize`,
  // `lineHeight`, `letterSpacing`) read CSS custom properties so the
  // React shell's `fontFamily` / `fontSize` / `lineHeight` /
  // `letterSpacing` props can override per-instance via inline
  // `style={{...}}` on the host wrapper without rebuilding the
  // theme. The variable names match `tug-prompt-input.css`'s tokens
  // so the same tokens drive both substrates; the inline fallbacks
  // here keep the rendered metrics stable when no token is set
  // (storybook, unit tests, or hosts that haven't loaded the theme
  // CSS).
  ".cm-content": {
    caretColor: "transparent",
    fontFamily: "var(--tug-font-family-editor, inherit)",
    fontSize: "var(--tug-font-size-editor, 14px)",
    lineHeight: "var(--tug-line-height-editor, 1.6)",
    letterSpacing: "var(--tug-letter-spacing-editor, normal)",
    padding: "8px 10px",
  },

  ".cm-line": {
    padding: "0",
  },

  // Soft-wrap with HANGING trailing spaces. `EditorView.lineWrapping`
  // applies CM6's `.cm-lineWrapping`, whose base theme sets
  // `white-space: break-spaces` — under which preserved spaces take up
  // width and do NOT hang, so a trailing space that overflows the line
  // edge wraps down to start the next visual row (most visible when a
  // wide atom fills the line right up to the edge). That breaks the
  // cardinal rule that trailing spaces hang at the end of a line. We
  // override just this content surface to `pre-wrap`, under which a
  // run of trailing spaces hangs past the edge instead of wrapping. The
  // `word-break` / `overflow-wrap` from `.cm-lineWrapping` are untouched,
  // so a single over-long token still breaks to avoid overflow. Scoped
  // to `.cm-lineWrapping` so the non-wrapping mode keeps CM6's `pre`.
  //
  // `overflow-x: clip` bounds the content's scrollable width to its own
  // box: the hung trailing spaces are clipped at the edge and — crucially
  // — do NOT inflate the scroller's `scrollWidth`. Without this the
  // scroller would stay horizontally scrollable and CM6's `scrollIntoView`
  // (e.g. Shift-Arrow extending the selection into a hung space) would
  // slide the whole view sideways. `clip` survives here (unlike on the
  // scroller) because `.cm-content`'s other axis is `visible` — `clip`
  // only degrades to `hidden` when paired with a scrolling overflow. The
  // caret and selection layers, the other two things that live in the
  // scroller, are clamped to the same edge in `caret-layer.ts` /
  // `selection-layer.ts`, so nothing extends `scrollWidth` past the
  // viewport and `scrollLeft` is structurally pinned at 0.
  // @tug-renders-on: --tug7-surface-field-primary-normal-plain-rest
  ".cm-content.cm-lineWrapping": {
    whiteSpace: "pre-wrap",
    overflowX: "clip",
  },

  // Atom-bind run (see `tug-text-editor/atom-bind.ts`): the maximal
  // non-whitespace run containing an atom is wrapped in this class so it
  // wraps as one unbreakable token. `nowrap` suppresses the break
  // opportunities the atom's replaced `<img>` would otherwise expose on
  // each edge, so abutting punctuation stays glued to the atom and the
  // pair breaks only at the spaces around the run — word semantics.
  ".cm-tug-atom-bind": {
    whiteSpace: "nowrap",
  },

  // A zero-width, one-line-tall ghost on every line. It exists as the
  // caret layer's per-row ruler: `caret-layer.ts` reads this pseudo's
  // computed height via `getComputedStyle(line, '::before')` to size the
  // caret stroke, and — because the pseudo is a single inline-block of
  // height `1lh` — that read returns *one* row's height even when
  // `EditorView.lineWrapping` makes a `.cm-line` span several visual rows
  // (the element's own rect would be the whole wrapped block).
  //
  // It is plain `1lh`: the editor's leading is derived to seat an atom
  // (`editorLineHeightFor`), so a chip never forces a row taller than the
  // line-height and the ghost needs no atom-height floor. Selection is
  // unaffected — the pseudo isn't in the document model, only in line
  // layout.
  ".cm-line::before": {
    content: '""',
    display: "inline-block",
    width: "0",
    height: "1lh",
  },

  // CM6's stock placeholder is `display: inline-block; vertical-align:
  // top`, which pins the hint text to the *top* of the line box. With
  // the `.cm-line::before` ghost above reserving a full `1lh` of
  // above-baseline extent on every line, that top sits well above the
  // text baseline — so the placeholder paints high and the first typed
  // glyph appears to "hop" down to the baseline where prose actually
  // lands. Baseline-aligning the placeholder lands its text on the same
  // baseline as typed text, so there is no jump on first keystroke.
  ".cm-placeholder": {
    verticalAlign: "baseline",
  },

  // Atom widgets render via `tug-atom-img.ts` as `<img>` elements carrying an
  // inline `vertical-align` offset (`atomBaselineOffsetFor`) that lands the
  // chip's internal text baseline on the surrounding text baseline. We let that
  // inline offset govern — no override here. The `.cm-line::before` ghost above
  // is anchored to the same offset, so it reserves the atom's above/below-
  // baseline extents on every line: the atom is baseline-aligned with the prose
  // AND atom-bearing and text-only lines are the exact same height. (Box-
  // centering with `vertical-align: middle` would keep heights uniform but
  // float the chip's text above the prose baseline — the two are reconciled by
  // anchoring the ghost, not by centering the atom.)

  // Selection overlay painted by `tug-text-editor/selection-layer.ts`.
  // The `.cm-selectionBackground` divs are layered behind the
  // editable surface, so they cover atom widgets cleanly and
  // persist when the editor loses focus.
  //
  // `--tugx-text-editor-selection-bg-rest` is a tug-text-editor-specific token
  // (defined in `brio.css` and `harmony.css`) that resolves to a
  // higher-chroma blue than the shared
  // `--tug7-surface-selection-primary-normal-plain-rest`. The
  // shared token is tuned for native `::selection` rendering,
  // where WebKit substitutes the OS system selection color on
  // focused fields and the literal CSS color is mostly cosmetic.
  // Our overlay is a `<div>` background — WebKit honors the
  // literal color verbatim, with no system substitution — so we
  // need a saturated source value to render as vivid blue
  // rather than the pale tint the shared token produces when
  // painted as a layer.
  // !important is required: CM6's base theme has a rule
  // `&light.cm-focused > .cm-scroller > .cm-selectionLayer
  // .cm-selectionBackground { background: #d7d4f0 }` (a pale lilac)
  // at specificity (0,6,0), which beats any plain selector we can
  // write. The shorthand `background` also resets `background-color`,
  // so a later longhand alone can't override it without an
  // `!important` win or matching specificity.
  ".cm-selectionBackground": {
    backgroundColor: "var(--tugx-text-editor-selection-bg-rest) !important",
  },

  // Dim the overlay to the tug "inactive" selection token when the
  // editor itself has lost focus (within a still-focused card,
  // e.g. the user clicked an adjacent button). Cross-card inactive
  // paint is handled at the pane level via `selectionGuard.cardRanges`
  // and the `::highlight(inactive-selection)` rule in `tug-pane.css`
  // ([L23]).
  "&:not(.cm-focused) .cm-selectionBackground": {
    backgroundColor: TOKENS.selectionBgInactive + " !important",
  },

  // Native ::selection paints the selected text glyphs themselves.
  // The overlay handles the background; setting `background:
  // transparent` here prevents a double-paint with the overlay,
  // and the `color` recolors the glyphs to the tug
  // selection-text token so they read clearly against the overlay.
  ".cm-content ::selection": {
    backgroundColor: "transparent",
    color: "var(--tug7-element-selection-text-normal-plain-rest)",
  },

  // Caret-overlay layer painted by `tug-text-editor/caret-layer.ts`. The
  // layer is non-interactive — pointer events fall through to the
  // editable surface so clicks land on the right offset.
  ".tug-text-editor-caret-layer": {
    pointerEvents: "none",
  },

  // Caret blink animation — hard on/off holds expressed as paired
  // keyframe stops with `linear` easing, never `steps()`. Core
  // Animation expresses a segment's easing as a cubic bezier; a step
  // timing function is not one, and WebKit answers by declining to
  // accelerate the animation — which puts an infinite loop on the
  // main thread, ticking style resolution (and the whole-tree
  // compositing walk behind it) on every otherwise-idle deck that has
  // a focused composer. Sampled hold stops are the same cadence by
  // construction and Core Animation runs them natively: each hold is
  // a constant segment, and the 0.1% ramps between them span ~1ms of
  // the cycle — a cut to the eye. Driven by the layer's own animation
  // declaration so the keyframes exist only while the editor is
  // focused: an unfocused editor's layer carries `animation-name:
  // none` and owns no animation object at all. The layer element
  // itself is stable across selection changes (CM6's `LayerView`
  // builds its `dom` once and diffs only the child markers), so the
  // blink's phase is reset by the drag and typing rules below, not by
  // a layer rebuild.
  "&.cm-focused > .cm-scroller > .tug-text-editor-caret-layer": {
    animation: "tug-text-editor-caret-blink 1.2s linear infinite",
  },

  "@keyframes tug-text-editor-caret-blink": {
    "0%, 49.9%": { opacity: 1 },
    "50%, 99.9%": { opacity: 0 },
    "100%": { opacity: 1 },
  },

  // The caret stroke itself. `caret-layer.ts` constructs each
  // marker with width=2, height=line-block — this rule colors it.
  ".tug-text-editor-caret": {
    backgroundColor: TOKENS.caret,
  },

  // While the user is mid mouse-drag (mousedown without mouseup
  // yet), suppress the caret entirely. The selection is in flux —
  // the moment `selectionSet` fires from the next mousemove, the
  // caret-layer would briefly paint a collapsed cursor at the
  // mousedown anchor before the range widens. Matches WebKit's
  // native behavior of hiding the caret during drag-selection.
  // Toggled by `tugCaretInteractionPlugin`'s mousedown / global
  // mouseup pair in `caret-layer.ts`.
  //
  // `display: none` also cancels the blink outright — the layer holds
  // zero animation objects for the duration of the drag, and the
  // restore on mouseup starts a fresh cycle at time 0, so the caret
  // reads solid at the newly clicked position.
  "&[data-tug-text-editor-dragging] .tug-text-editor-caret-layer": {
    display: "none",
  },

  // While the user is actively typing (any keydown within the last
  // ~500ms), freeze the blink animation and pin the caret to full
  // opacity. Standard text-editor behavior since the 1980s — the
  // caret stays solid during typing and resumes blinking after a
  // pause. Toggled by `tugCaretInteractionPlugin`'s keydown +
  // idle-timer in `caret-layer.ts`.
  "&[data-tug-text-editor-typing].cm-focused > .cm-scroller > .tug-text-editor-caret-layer": {
    animation: "none",
    opacity: 1,
  },

  // Focus-state surface — subtle background tint shift in the default
  // focus style. Host-wrapper variants (`data-focus-style="ring"`) live
  // in `tug-text-editor.css`; this rule covers the default ("background") path
  // for the inner editing surface.
  "&.cm-focused": {
    backgroundColor: TOKENS.contentBgFocus,
    outline: "none",
  },

  // Readonly surface + text.
  "&.cm-readonly": {
    backgroundColor: TOKENS.contentBgReadonly,
    color: TOKENS.contentFgReadonly,
  },

  // Disabled surface + text. CM6 toggles the editable contenteditable
  // attribute when `EditorState.readOnly` is set; we treat the host
  // wrapper's `data-disabled` as the source of truth for visual state
  // and color the inner surface to match.
  "&[data-disabled]": {
    backgroundColor: TOKENS.contentBgDisabled,
    color: TOKENS.contentFgDisabled,
    cursor: "not-allowed",
  },

  // Line-number gutter — rendered by `tugLineNumbersGutter`
  // (`tug-text-editor/line-numbers-gutter.ts`) when the substrate's
  // `lineNumbers` prop is true. Pairs the tug-text-editor-specific
  // alias tokens (defined in `tug-text-editor.css`'s component-scope
  // `body` block) with the editor's typography variables so the
  // gutter inherits any prop-driven font / size / line-height
  // changes.
  //
  // CM6's default gutter has no background and no separator — the
  // gutter sits flush against `.cm-content`. We carry our own
  // background + right-edge border to read as a distinct column.
  //
  // Typography rules:
  //   - **font-size** matches `.cm-content`'s. The cell's strut is
  //     therefore at the *content* font-size, which positions the
  //     cell's typographic baseline at the same place as the
  //     content row's baseline (CSS line-box rules: half-leading +
  //     ascent, applied to the same font metrics). The visibly
  //     smaller line-number text is achieved by wrapping the
  //     number in a `<span class="tug-text-editor-line-number-text">`
  //     (via `tug-text-editor/line-numbers-gutter.ts`'s
  //     `TugLineNumberMarker`) and shrinking just that span — the
  //     span's own baseline aligns to the cell strut's baseline by
  //     CSS default `vertical-align: baseline`, so the smaller
  //     numbers sit baseline-aligned with the content text on
  //     every font, every size. See the `line-numbers-gutter.ts`
  //     module docstring for the full rationale (why a static
  //     padding-top compensation drifts across fonts).
  //   - **line-height** matches `.cm-content`'s line-height exactly so
  //     gutter rows stay pixel-aligned with content rows. (An atom never
  //     forces a content row taller than the line-height now — chips are
  //     sized to fit inside the line box — so there's no atom floor to
  //     track here.)
  ".cm-gutters": {
    backgroundColor: "var(--tugx-text-editor-gutter-bg-rest)",
    color: "var(--tugx-text-editor-gutter-text-rest)",
    borderRight: "1px solid var(--tugx-text-editor-gutter-border-rest)",
    fontFamily: "var(--tug-font-family-editor, inherit)",
    fontSize: "var(--tug-font-size-editor, 14px)",
    lineHeight: "var(--tug-line-height-editor, 1.6)",
    letterSpacing: "var(--tug-letter-spacing-editor, normal)",
  },

  // Per-line cell inside the gutter.
  //
  // - **min-width** is wide enough for five digits (`99999`) at
  //   the cell's font-size (now content's) so the column doesn't
  //   reflow narrower→wider as the user types past line 9 / 99 /
  //   999. The `ch` unit is the advance width of the `0` glyph in
  //   the current font, so it scales with `--tug-font-size-editor`
  //   automatically. Documents past 99999 lines still grow the
  //   column past this floor — `min-width` is exactly that, a
  //   floor. (Note the cell font is content-size; the visible
  //   numeric text is rendered smaller via the inner span — so
  //   five `ch` here is generous, accommodating both the
  //   spacer-rendered digits and the actual rendered digits.)
  // - **text-align: right** mirrors the convention every code
  //   editor uses (VS Code, Sublime, Vim, IDEA): numbers
  //   right-align toward the gutter's right edge so the units
  //   column stays in place regardless of digit count. CM6's
  //   default is `text-align: right` already; we restate it here
  //   so the rule survives any future CM6 base-theme change.
  // - **padding** is horizontal-only. With the cell's strut at
  //   content font-size, baseline alignment is automatic — no
  //   padding-top compensation needed.
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "5ch",
    textAlign: "right",
    padding: "0 4px 0 5px",
  },

  // Line-number text inside the cell — wrapped in a `<span>` by
  // `TugLineNumberMarker` (`line-numbers-gutter.ts`) so the
  // visible numbers can be smaller than the content while
  // remaining baseline-aligned with it. `font-size: 0.85em` is
  // relative to the cell's own font-size (content's), so the
  // shrink ratio is constant regardless of the user's
  // `--tug-font-size-editor` value. The span's CSS default
  // `vertical-align: baseline` does the alignment automatically:
  // the span's baseline aligns to the cell strut's baseline,
  // which the cell's matching font-size establishes at the same
  // position as the content row's baseline.
  ".tug-text-editor-line-number-text": {
    fontSize: "0.85em",
  },
});
