/**
 * TugListRow — presentational row chrome for list surfaces.
 *
 * The row counterpart to `TugListView`'s windowing primitive, modeled
 * on UIKit's `UITableViewCell`: `TugListView` owns enumeration,
 * windowing, scrolling, and selection state; `TugListRow` owns the
 * row's *presentation* — the leading / content / trailing layout, the
 * `flush` vs `pill` treatment, and the rest / hover / selected /
 * disabled visuals. A `TugListView` cell renderer composes a
 * `TugListRow`; any non-windowed list (a settings group, a static
 * inventory) can use it directly.
 *
 * Presentational only. `TugListRow` takes no `onClick` and owns no
 * selection logic — `selected` and `disabled` are inputs the consumer
 * feeds, reflected to `data-` attributes for CSS. Activation belongs
 * to the enclosing `TugListView` cell wrapper (or the consumer's own
 * wrapper). This mirrors `UITableViewCell`, which is told
 * `setSelected:` by its table view and never decides selection itself.
 *
 * Variants:
 *  - `flush` — edge-to-edge, no rounding, transparent rest. The
 *    iOS-`UITableView.plain` treatment. Row dividers are the
 *    enclosing container's job (a `TugListView` with
 *    `rowLayout="flush"` draws them); a `flush` row paints none of
 *    its own, since it cannot know whether it is the last row.
 *  - `pill` — a discrete bordered, rounded row. Its lineage is
 *    `TugDialogButton`'s outlined-action treatment, so the two
 *    primitives read as one family when stacked.
 *
 * Content:
 *  - `title` plus optional `description` render the common two-line
 *    column — the `UITableViewCellStyle.subtitle` shape. Both render
 *    through `TugLabel` (title at `titleSize`, default `md`; the
 *    description muted via `emphasis="calm"`, wrapping to
 *    `descriptionMaxLines`) so row text matches the rest of the app.
 *    Either slot accepts a `ReactNode` — a highlighted title or
 *    description (`renderFilterHighlight`) composes into the same
 *    `TugLabel` as a plain string, so a filtered list keeps the row's
 *    typography and truncation instead of reaching for `children`.
 *  - `children`, when provided, owns the content column outright and
 *    `title` / `description` are ignored — the escape hatch for rows
 *    whose content is not a plain title / description stack.
 *  - `mono` switches the content column to the monospace family at a
 *    compact, dense line — the standard row type for paths, ids, and
 *    code-ish text — applying to a title / description stack or `children`.
 *
 * Accessories:
 *  - `leading` / `trailing` are arbitrary nodes (UIKit's leading
 *    `imageView` / trailing `accessoryView`). `trailingReveal="engaged"`
 *    keeps the trailing accessory hidden until the row is engaged:
 *    hovered, holding focus within, selected, or under the keyboard
 *    movement cursor. `trailingReveal="claim"` does the same but
 *    reserves no width at rest — the accessory takes its space from the
 *    content column on engage.
 *  - `selectedGlyph="check"` reserves a fixed-width leading checkmark
 *    column (UIKit's `.checkmark` accessory) — shown when `selected`,
 *    empty otherwise so titles align. It sits leading-most and coexists
 *    with an independent `leading` accessory.
 *  - `selectionSurface="control"` moves selection off the row fill and onto
 *    that glyph: the radio / checkbox paints its own resting on-state and the
 *    row keeps the host surface's background and text color. A list of options
 *    then reads as a real radio / checkbox group.
 *
 * The default `variant` is read from the enclosing `TugListView`'s
 * `rowLayout` through `TugListRowLayoutContext` when present, so a
 * cell renderer need not repeat `variant` on every row; an explicit
 * `variant` prop overrides the context, and `flush` is the final
 * fallback.
 *
 * Laws: [L06] appearance via CSS / DOM attributes, never React state;
 *       [L15] token-driven state visuals; [L16] pairings declared;
 *       [L17] component-tier aliases resolve to base in one hop;
 *       [L19] component authoring guide; [L20] token sovereignty —
 *       composed accessory children keep their own tokens.
 */

import "./tug-list-row.css";
import type { TugDensity, TugRowState } from "./tug-vocabulary";

import React from "react";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";
import { TugLabel, type TugLabelProps, type TugLabelSize } from "./tug-label";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Row presentation. `flush` is edge-to-edge with no rounding; `pill`
 * is a discrete bordered, rounded row.
 */
export type TugListRowVariant = "flush" | "pill";

/** Reveal policy for the trailing accessory.
 *  - `"always"` — the accessory is present and holds its width.
 *  - `"engaged"` — hidden at rest but still holding its width, so the
 *    content column never reflows when it appears.
 *  - `"claim"` — hidden AND zero-width at rest; on engage it claims its
 *    width from the content column, truncating the title. The mode for
 *    dense one-line rows whose text should run the full row width until
 *    the pointer or the keyboard cursor arrives. */
export type TugListRowTrailingReveal = "always" | "engaged" | "claim";

/** Row density. `regular` is the comfortable default; `compact` collapses the
 *  block padding to a hairline — the treatment for long enumerations (a
 *  commit's file list) where vertical economy is the point. */
export type TugListRowDensity = TugDensity;

/** A row's standing among its neighbours — see `TugRowState`. */
export type TugListRowState = TugRowState;

/** Leading selection-indicator column mode.
 *  - `"check"` — a bare checkmark (shown when selected, blank otherwise);
 *  - `"radio"` — a radio dot matching `TugRadioGroup` (a hollow ring, filled with
 *    a center dot when selected — always visible);
 *  - `"checkbox"` — a checkbox box matching `TugCheckbox` (an outlined box, filled
 *    with a check when selected — always visible);
 *  - `"none"` — no column. */
export type TugListRowSelectedGlyph = "check" | "radio" | "checkbox" | "none";

export interface TugListRowProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "title"> {
  /**
   * Row presentation. When omitted, falls back to the enclosing
   * `TugListView`'s `rowLayout` (via `TugListRowLayoutContext`), then
   * to `flush`.
   * @selector [data-variant="flush"] | [data-variant="pill"]
   */
  variant?: TugListRowVariant;

  /**
   * Row density. When omitted, falls back to the enclosing
   * `TugListView`'s `rowDensity` (via `TugListRowLayoutContext`), then
   * to `regular`. `compact` collapses the block padding to a hairline for
   * long enumerations.
   * @selector [data-density="compact"]
   */
  density?: TugListRowDensity;

  /** Leading accessory — an icon, status glyph, or image. */
  leading?: React.ReactNode;

  /** Trailing accessory — a control or badge. */
  trailing?: React.ReactNode;


  /**
   * Reveal policy for `trailing`. `"engaged"` keeps the accessory
   * hidden until the row is engaged — hovered, holding focus within,
   * selected, or under the keyboard movement cursor.
   * @selector .tug-list-row-trailing[data-reveal="engaged"]
   * @default "always"
   */
  trailingReveal?: TugListRowTrailingReveal;

  /**
   * Primary row text — sentence-case, truncates with an ellipsis after
   * {@link titleMaxLines} lines (one by default). Rendered through
   * `TugLabel` so row text matches the rest of the app. Ignored when
   * `children` is provided.
   *
   * A `ReactNode` is accepted so a title can carry inline fragments —
   * filter-match `<mark>` spans — while keeping the row's typography.
   */
  title?: React.ReactNode;

  /**
   * Title size override. Defaults to `"md"` — the legible row title
   * size. Drop to `"sm"` (or smaller) for a denser row. Forwarded to
   * the title `TugLabel`.
   */
  titleSize?: TugLabelSize;

  /**
   * Maximum lines for the `title` before truncation. `1` (default)
   * keeps today's single-line ellipsis; a larger value lets the title
   * wrap before ellipsizing (e.g. a turn-picker row that shows two
   * lines of the prompt). Forwarded to the title `TugLabel`'s
   * `maxLines`.
   */
  titleMaxLines?: number;

  /**
   * Optional secondary text rendered muted below the title, through
   * the same `TugLabel` whether it is a string or a node. Ignored when
   * `children` is provided.
   */
  description?: React.ReactNode;

  /**
   * Maximum lines for the `description` before truncation. `1`
   * (default) keeps today's single-line ellipsis; a larger value lets
   * the description wrap to a multi-line description. Forwarded to the
   * description `TugLabel`'s `maxLines`.
   */
  descriptionMaxLines?: number;

  /**
   * Free-form content column. When provided it owns the content
   * column and `title` / `description` are ignored.
   */
  children?: React.ReactNode;

  /**
   * Selected state. Fed by the consumer; the row does not own
   * selection.
   * @selector [data-selected="true"]
   */
  selected?: boolean;

  /**
   * Disabled state — dimmed, `not-allowed` cursor.
   * @selector [data-disabled="true"]
   */
  disabled?: boolean;

  /**
   * Draw an accent-colored border around the row when it is selected.
   * `flush` paints an inset `box-shadow` (no box-model change, so
   * selection moving never reflows the list); `pill` swaps its border
   * color. When omitted, falls back to the enclosing `TugListView`'s
   * `selectedAccent` (via `TugListRowLayoutContext`), then to off.
   * Inert unless the row is also `selected`.
   * @selector [data-selected="true"][data-selected-accent="true"]
   */
  selectedAccent?: boolean;

  /**
   * Render the content column in the monospace family at a compact,
   * dense line (the standard row type for paths, ids, and code-ish
   * text). Applies to a `title` / `description` stack or free-form
   * `children` alike. `false` (default) keeps the comfortable sans row.
   * @selector [data-mono="true"]
   * @default false
   */
  mono?: boolean;

  /**
   * The row's standing among its neighbours. `struck` fades the row and
   * crosses out its title (spent, but still legible); `dimmed` quiets the
   * content column a step. Omitted ⇒ full strength.
   * @selector [data-row-state="struck"] | [data-row-state="dimmed"]
   */
  state?: TugListRowState;

  /**
   * Leading selection-indicator column. Reserves a fixed-width column on every
   * row so titles align whether or not a row carries the mark, and coexists with
   * an independent `leading` accessory (the indicator sits leading-most).
   *  - `"check"` — a checkmark shown when `selected`, blank (reserved) otherwise;
   *    inherits the row's text color. The multi-select idiom.
   *  - `"radio"` — a radio dot: a hollow ring always visible, filled with a
   *    center dot when `selected`. The single-select idiom.
   *  - `"none"` (default) — no column.
   * @selector .tug-list-row-check[data-state="shown"|"reserved"][data-glyph]
   * @default "none"
   */
  selectedGlyph?: TugListRowSelectedGlyph;

  /**
   * Which surface carries the row's selection.
   *  - `"fill"` (default) — the row's blue selection fill, with the leading
   *    glyph inverted to the selected-text tone so it stays legible on it.
   *    The picker idiom: the whole row is the chosen thing.
   *  - `"control"` — the leading radio / checkbox alone, painted in its own
   *    resting on-state (the filled blue a `TugRadioGroup` / `TugCheckbox`
   *    wears anywhere else). The row paints NO selection fill and keeps the
   *    host surface's text color, so the list reads as a real radio /
   *    checkbox group rather than a highlighted list. Hover graze and the
   *    list-view's keyboard cursor are unaffected — they are separate
   *    channels. Requires a `selectedGlyph`.
   *
   * Inherited from the enclosing `TugListView`'s `selectionSurface` when that
   * is set, so a list authored as a radio / checkbox group states the mode
   * once; an explicit prop here overrides it.
   * @selector [data-selection-surface="control"]
   * @default "fill"
   */
  selectionSurface?: TugListRowSelectionSurface;
}

/**
 * Which surface carries a row's selection — see
 * {@link TugListRowProps.selectionSurface}.
 */
export type TugListRowSelectionSurface = "fill" | "control";

// ---------------------------------------------------------------------------
// Layout context — published by TugListView's `rowLayout` / `selectedAccent`
// ---------------------------------------------------------------------------

/**
 * Row presentation published to a `TugListRow` by an enclosing
 * `TugListView`: the default `variant` (from `rowLayout`) and whether
 * selected rows draw an accent border (from `selectedAccent`). `null`
 * means "no list-view ancestor" — a standalone `TugListRow` then falls
 * back to its own props (`variant` defaulting to `flush`,
 * `selectedAccent` to off).
 *
 * Internal to the row/list-view pair; app code never reads it directly.
 * `TugListView` is the only provider.
 */
export interface TugListRowLayout {
  variant: TugListRowVariant | null;
  selectedAccent: boolean;
  density?: TugListRowDensity | null;
  selectionSurface?: TugListRowSelectionSurface | null;
}

const TugListRowLayoutContext = React.createContext<TugListRowLayout | null>(
  null,
);

/**
 * Provider for the row-layout context. `TugListView` wraps its
 * rendered window with this when `rowLayout` / `selectedAccent` is set,
 * so descendant `TugListRow`s inherit the variant and accent intent
 * without each cell repeating them.
 */
export const TugListRowLayoutProvider = TugListRowLayoutContext.Provider;

// ---------------------------------------------------------------------------
// Pure helpers — exported for the test suite
// ---------------------------------------------------------------------------

/** Variant used when neither a prop nor a layout context supplies one. */
export const DEFAULT_LIST_ROW_VARIANT: TugListRowVariant = "flush";

/**
 * Resolve the effective row variant. An explicit `variant` prop wins;
 * otherwise the enclosing `TugListView`'s `rowLayout` (via context);
 * otherwise {@link DEFAULT_LIST_ROW_VARIANT}. Pure; exported for tests.
 */
export function resolveListRowVariant(
  propVariant: TugListRowVariant | undefined,
  contextVariant: TugListRowVariant | null,
): TugListRowVariant {
  return propVariant ?? contextVariant ?? DEFAULT_LIST_ROW_VARIANT;
}

/**
 * Resolve the effective row density. An explicit `density` prop wins;
 * otherwise the enclosing `TugListView`'s `rowDensity` (via context);
 * otherwise `regular`. Pure; exported for tests.
 */
export function resolveListRowDensity(
  propDensity: TugListRowDensity | undefined,
  contextDensity: TugListRowDensity | null | undefined,
): TugListRowDensity {
  return propDensity ?? contextDensity ?? "regular";
}

/**
 * Render state of the leading checkmark column.
 *  - `"shown"` — `selectedGlyph="check"` and the row is selected; the
 *    check renders.
 *  - `"reserved"` — `selectedGlyph="check"` and the row is unselected;
 *    the column reserves its fixed width but renders empty, so titles
 *    align with the selected row.
 *  - `"none"` — no checkmark column at all.
 */
export type TugListRowGlyphState = "shown" | "reserved" | "none";

/**
 * Resolve the checkmark column's render state. Pure; exported for tests.
 */
export function resolveListRowSelectedGlyph(
  glyph: TugListRowSelectedGlyph | undefined,
  selected: boolean | undefined,
): TugListRowGlyphState {
  if (glyph !== "check" && glyph !== "radio" && glyph !== "checkbox") return "none";
  return selected === true ? "shown" : "reserved";
}

/**
 * Which content path the row renders.
 *  - `"children"` — `children` is non-empty; it owns the content
 *    column and `title` / `description` are ignored.
 *  - `"structured"` — no `children`, but a `title` or `description` is
 *    present; the title / description stack renders.
 *  - `"empty"` — no content at all (a degenerate but non-crashing
 *    case; the content column renders empty).
 */
export type TugListRowContentMode = "children" | "structured" | "empty";

/** True when a `ReactNode` slot carries something worth rendering. */
function isRenderable(node: React.ReactNode): boolean {
  return node !== undefined && node !== null && node !== false;
}

/**
 * True when a `title` / `description` slot carries text worth a `TugLabel`.
 * The empty string is renderable-but-blank: it must NOT promote a row out
 * of `"empty"` mode, or a caller passing `title=""` would gain a stray
 * label line.
 */
function hasRowText(node: React.ReactNode): boolean {
  return isRenderable(node) && node !== "";
}

/**
 * Resolve the content-rendering mode. `children` takes precedence
 * over `title` / `description` per the escape-hatch contract. Pure;
 * exported for tests.
 */
export function resolveListRowContentMode(
  children: React.ReactNode,
  title: React.ReactNode,
  description: React.ReactNode,
): TugListRowContentMode {
  if (isRenderable(children)) return "children";
  if (hasRowText(title) || hasRowText(description)) return "structured";
  return "empty";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Presentational list row. See the module docstring for the variant,
 * content, and accessory contracts.
 */
export const TugListRow = React.forwardRef<HTMLDivElement, TugListRowProps>(
  function TugListRow(
    {
      variant,
      density,
      leading,
      trailing,
      trailingReveal = "always",
      title,
      titleSize,
      titleMaxLines,
      description,
      descriptionMaxLines,
      selected,
      disabled,
      selectedAccent,
      selectedGlyph,
      selectionSurface,
      mono,
      state,
      children,
      className,
      ...rest
    },
    ref,
  ) {
    const layout = React.useContext(TugListRowLayoutContext);
    const resolvedVariant = resolveListRowVariant(variant, layout?.variant ?? null);
    const resolvedDensity = resolveListRowDensity(density, layout?.density);
    const contentMode = resolveListRowContentMode(children, title, description);
    // Accent border: explicit prop wins; otherwise inherit the
    // enclosing list view's `selectedAccent`; otherwise off.
    const resolvedAccent = selectedAccent ?? layout?.selectedAccent ?? false;
    // Selection surface: explicit prop wins; otherwise inherit the enclosing
    // list view's mode (a list authored as a radio / checkbox group publishes
    // it once for all its rows); otherwise the default fill.
    const resolvedSelectionSurface =
      selectionSurface ?? layout?.selectionSurface ?? "fill";
    const glyphState = resolveListRowSelectedGlyph(selectedGlyph, selected);

    const hasLeading = isRenderable(leading);
    const hasTrailing = isRenderable(trailing);

    return (
      <div
        ref={ref}
        data-slot="tug-list-row"
        data-variant={resolvedVariant}
        data-density={resolvedDensity === "compact" ? "compact" : undefined}
        data-selected={selected ? "true" : undefined}
        data-disabled={disabled ? "true" : undefined}
        data-selected-accent={resolvedAccent ? "true" : undefined}
        data-selection-surface={
          resolvedSelectionSurface === "control" ? "control" : undefined
        }
        data-mono={mono ? "true" : undefined}
        data-row-state={state}
        className={cn("tug-list-row", className)}
        {...rest}
      >
        {glyphState !== "none" ? (
          <span
            className="tug-list-row-check"
            data-slot="tug-list-row-check"
            data-state={glyphState}
            data-glyph={selectedGlyph}
            aria-hidden="true"
          >
            {selectedGlyph === "radio" ? (
              <span className="tug-list-row-radio">
                <span className="tug-list-row-radio-dot" />
              </span>
            ) : selectedGlyph === "checkbox" ? (
              <span className="tug-list-row-checkbox">
                <Check />
              </span>
            ) : glyphState === "shown" ? (
              <Check />
            ) : null}
          </span>
        ) : null}
        {hasLeading ? (
          <span
            className="tug-list-row-leading"
            data-slot="tug-list-row-leading"
          >
            {leading}
          </span>
        ) : null}
        <span className="tug-list-row-content">
          {contentMode === "children" ? (
            children
          ) : contentMode === "structured" ? (
            <>
              {hasRowText(title) ? (
                <TugLabel
                  className="tug-list-row-title"
                  size={titleSize ?? "md"}
                  maxLines={titleMaxLines ?? 1}
                >
                  {title}
                </TugLabel>
              ) : null}
              {hasRowText(description) ? (
                <TugLabel
                  className="tug-list-row-subtitle"
                  size="sm"
                  emphasis="calm"
                  maxLines={descriptionMaxLines ?? 1}
                >
                  {description}
                </TugLabel>
              ) : null}
            </>
          ) : null}
        </span>
        {hasTrailing ? (
          <span
            className="tug-list-row-trailing"
            data-slot="tug-list-row-trailing"
            data-reveal={trailingReveal}
          >
            {trailing}
          </span>
        ) : null}
      </div>
    );
  },
);

// ---------------------------------------------------------------------------
// TugListRowTitle — the title slot
// ---------------------------------------------------------------------------

/** Props for {@link TugListRowTitle}. */
export interface TugListRowTitleProps extends Omit<TugLabelProps, "size" | "maxLines"> {
  /** Title size. Defaults to `"sm"`, the rail rows' measure. */
  size?: TugLabelSize;
  /** Maximum lines before truncation. Defaults to `1`. */
  maxLines?: number;
}

/**
 * The row's title, for a row whose content column is free-form `children`.
 *
 * A row that composes its own content — a glyph beside the title, a count
 * inside it — still wants the title to read as the row's title: the row's
 * type, its ellipsis, and the list's `rowTextSize`. This is that title, so a
 * feature renders the slot rather than borrowing the row's class onto a label
 * of its own. A `className` is the feature's handle on its own title, styled
 * in its own CSS under its own name.
 */
export function TugListRowTitle({
  size = "sm",
  maxLines = 1,
  className,
  ...rest
}: TugListRowTitleProps): React.ReactElement {
  return (
    <TugLabel
      {...rest}
      className={cn("tug-list-row-title", className)}
      size={size}
      maxLines={maxLines}
    />
  );
}
