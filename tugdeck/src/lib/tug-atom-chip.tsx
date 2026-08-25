/**
 * tug-atom-chip.tsx — React component that renders an atom chip as
 * inline `<svg>` with CSS-variable-driven `fill` / `stroke` and
 * font-family inherited from the surrounding text.
 *
 * Companion to `tug-atom-img.ts`'s {@link bakeAtomChipDataUri}, which
 * paints the chip with Canvas 2D — resolved colors, the editor's own
 * document fonts — and bakes it to a `data:image/png,…` URI for the
 * editor's CM6 widget (an `<img>` can't reach the host CSS cascade).
 * This component is the React-side path — `TugAtomTextBody`
 * (transcript chips) and the four tool-block path renderers consume
 * it.
 *
 * Why inline `<svg>` instead of `<img src="data:…">`:
 *  - The chip becomes part of the host DOM, so theme tokens defined
 *    on `:root` / `body` cascade in. A theme switch repaints the
 *    chip for free — no React re-render, no SVG re-bake, no
 *    `getComputedStyle` calls per chip [L06].
 *  - The chip's font-family also flows from the surrounding CSS,
 *    so chips read as part of the transcript prose rather than as
 *    code-surface text borrowed from the editor.
 *  - Layout still uses the shared `.tug-atom-chip` CSS class —
 *    `display: inline-block; vertical-align: middle; margin: 0 2px`
 *    apply equally to `<img>` and `<svg>` inline-level elements.
 *
 * Font policy: chips track the *transcript* font, not the editor's.
 * Earlier drafts subscribed to {@link setAtomFont} so chips would
 * match the user's editor font preference, but with inline-SVG the
 * SVG inherits CSS naturally and the editor's custom face isn't
 * loaded on the body anyway — the subscription was pulling on a
 * thread that didn't end anywhere useful. We resolve the body's
 * font-family once via `getComputedStyle` for Canvas measurement;
 * the SVG `<text>` element inherits the same value through CSS
 * cascade for rendering, so measurement and render agree.
 *
 * Layout math comes from {@link computeAtomChipGeometry} so this
 * component and the editor's data-URI path produce pixel-identical
 * chips at the same font frame.
 *
 * Laws:
 *  - [L06] all chip *colors* flow from CSS variables; the chip
 *    *font* flows from CSS inheritance. React state never drives
 *    appearance. Geometry (width/height) is derived from a memoized
 *    pure computation, not from state.
 *  - [L19] file pair (this `.tsx` + sibling `.css`), exported props
 *    interface, `data-slot` on the root `<svg>`.
 *
 * @module lib/tug-atom-chip
 */

import "./tug-atom-chip.css";

import * as React from "react";

import {
  TRANSCRIPT_CHIP_BASE_FONT_SIZE,
  computeAtomChipGeometry,
  ATOM_RECESS,
} from "./tug-atom-img";
import { chipStyle, chipDisplayLabel, ATOM_KEY_WASH } from "./command-atom";

/**
 * Lazy-resolved transcript chip font family.
 *
 * Read from `document.body.fontFamily` the first time a chip needs
 * to measure label width. `globals.css` sets the body's font to
 * `var(--tug-font-family-sans)`; `getComputedStyle` resolves that
 * to the actual font-family stack (e.g.
 * `"Inter, system-ui, sans-serif"`). Canvas's `measureText` needs
 * the resolved stack as a string; the SVG `<text>` element inherits
 * the same value through CSS cascade for rendering, so measurement
 * matches what the browser actually paints.
 *
 * Cached at module scope because the body font doesn't change in
 * this app — theme tokens change colors, not the body font. Falls
 * back to a sane system stack if the read fails (test environments
 * without a DOM, etc.).
 */
let _chipFontFamily: string | null = null;
function getChipFontFamily(): string {
  if (_chipFontFamily !== null) return _chipFontFamily;
  try {
    _chipFontFamily =
      getComputedStyle(document.body).fontFamily ||
      "system-ui, sans-serif";
  } catch {
    _chipFontFamily = "system-ui, sans-serif";
  }
  return _chipFontFamily;
}

export interface TugAtomChipProps {
  /** Icon family — `"file"`, `"image"`, `"command"`, `"doc"`, `"link"`. */
  type: string;
  /** Display label rendered inside the chip. */
  label: string;
  /** Raw atom value — surfaced as the native hover tooltip via SVG `<title>`. */
  value: string;
  /** Optional max width in px — labels longer than this truncate with `…`. */
  maxLabelWidth?: number;
  /**
   * Override the chip's pixel font size. Defaults to
   * {@link TRANSCRIPT_CHIP_BASE_FONT_SIZE} (12px); the Swift host's
   * `WKWebView.pageZoom` scales the SVG uniformly with the rest of
   * the page, so the baked size stays fixed.
   */
  fontSize?: number;
  className?: string;
  "data-slot"?: string;
  "data-testid"?: string;
}

/**
 * Render an atom chip as inline `<svg>`. See module docstring for the
 * design rationale and laws.
 */
export const TugAtomChip = React.forwardRef<SVGSVGElement, TugAtomChipProps>(
  function TugAtomChip(props, ref) {
    const {
      type,
      label,
      value,
      maxLabelWidth,
      fontSize: fontSizeOverride,
      className,
      "data-slot": dataSlot,
      "data-testid": dataTestid,
    } = props;
    const fontSize = fontSizeOverride ?? TRANSCRIPT_CHIP_BASE_FONT_SIZE;
    const chipFontFamily = getChipFontFamily();
    // A slash command shows its leading slash; other types show their stored
    // label. Same helper the editor path uses, so the text matches.
    const displayLabel = chipDisplayLabel(type, label, value);
    const geom = React.useMemo(
      () =>
        computeAtomChipGeometry(type, displayLabel, {
          fontFamily: chipFontFamily,
          fontSize,
          maxLabelWidth,
        }),
      [type, displayLabel, chipFontFamily, fontSize, maxLabelWidth],
    );
    // Shared chip token names, referenced as `var(--…)` so a theme switch
    // or a token edit re-paints via CSS cascade — no SVG re-bake [L06].
    const tokens = chipStyle().tokens;
    // Per-instance id for the recess top-shade gradient, so multiple chips in
    // one document don't collide on a shared `<linearGradient>` id.
    const gradId = `tug-atom-recess-${React.useId()}`;
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={geom.width}
        height={geom.height}
        viewBox={`0 0 ${geom.width} ${geom.height}`}
        className={className}
        // Baseline-align the chip via its computed offset (the same offset the
        // editor's `<img>` path uses) so the chip's internal text baseline lands
        // on the surrounding prose baseline — the hard atom/text baseline
        // invariant. NEVER `vertical-align: middle` here: middle centres on
        // x-height and floats the chip text off the prose baseline.
        style={{ verticalAlign: `${geom.baselineOffset}px` }}
        data-slot={dataSlot}
        data-testid={dataTestid}
        // The atom's identity, in the same three attributes the editor's
        // `<img>` chips carry. A copy that crosses this chip reads them to put
        // the atom on the clipboard, so a paste back into Tug gets the chip
        // rather than the label it drew ([L06] — attributes, not state).
        data-atom-type={type}
        data-atom-label={label}
        data-atom-value={value}
        aria-label={displayLabel}
        role="img"
      >
        {/* Recess top-shade gradient — `border` colour fading to transparent
            down the top of the box. Colours stay `var(--…)` so a theme switch
            re-paints via cascade. */}
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset={0} stopColor={`var(${tokens.border})`} stopOpacity={ATOM_RECESS.shadeOpacity} />
            <stop offset={ATOM_RECESS.shadeStop} stopColor={`var(${tokens.border})`} stopOpacity={0} />
          </linearGradient>
        </defs>
        {/* Base surface (opaque), then the Key wash overlay — together the
            9% key wash, no hard stroke. Both keep `var(--…)` fills so a theme
            switch re-paints via cascade. */}
        <rect x={0} y={0} width={geom.width} height={geom.height} rx={geom.radius} fill={`var(${tokens.surface})`} />
        <rect
          x={0}
          y={0}
          width={geom.width}
          height={geom.height}
          rx={geom.radius}
          fill={`var(${tokens.key})`}
          fillOpacity={ATOM_KEY_WASH}
        />
        {/* Recess: top inner shade, then a faint inset hairline — the bounded
            "indivisible unit" edge, softer than a 1px stroke. */}
        <rect x={0} y={0} width={geom.width} height={geom.height} rx={geom.radius} fill={`url(#${gradId})`} />
        <rect
          x={0.5}
          y={0.5}
          width={geom.width - 1}
          height={geom.height - 1}
          rx={Math.max(0, geom.radius - 0.5)}
          fill="none"
          stroke={`var(${tokens.border})`}
          strokeOpacity={ATOM_RECESS.hairlineOpacity}
          strokeWidth={1}
        />
        {/* Icon paths are static module-local SVG markup strings
            (see ATOM_ICON_PATHS in tug-atom-img.ts) — using
            dangerouslySetInnerHTML on this <g> is the simplest way
            to splice them in without duplicating each icon as JSX.
            The strings carry no user input; XSS is not a concern.
            A slash command has no icon (its `/` is the marker), so the
            element is skipped. */}
        {geom.hasIcon && (
          <g
            transform={geom.iconTransform}
            fill="none"
            stroke={`var(${tokens.icon})`}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dangerouslySetInnerHTML={{ __html: geom.iconPath }}
          />
        )}
        {/* Pin the font-family to the same value the Canvas
            measurement used. Letting the SVG `<text>` inherit via
            CSS cascade caused a clipping bug inside tool-block
            containers whose ambient font is monospace — the SVG
            inherited mono, glyphs grew, but the chip width had
            already been measured with sans. Explicit `fontFamily`
            here guarantees measurement and render agree across
            every surface, regardless of the parent's CSS. */}
        <text
          x={geom.textX}
          y={geom.textY}
          fontSize={geom.fontSize}
          fontFamily={geom.fontFamily}
          fill={`var(${tokens.text})`}
        >
          {geom.displayLabel}
        </text>
        <title>{value}</title>
      </svg>
    );
  },
);
