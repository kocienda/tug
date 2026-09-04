/**
 * tug-atom-img.ts — Atom rendering as <img> elements with PNG data URIs.
 *
 * Atoms are replaced elements — WebKit treats them as atomic inline units.
 * Caret navigation, selection, undo, and clipboard all work natively.
 * No contentEditable="false", no ZWSP, no caret fixup.
 *
 * Each atom is an <img> with data attributes:
 *   data-atom-type, data-atom-label, data-atom-value
 *
 * The chip is painted with Canvas 2D and baked to a PNG data URL. The
 * paint is SYNCHRONOUS and uses the parent document's already-loaded
 * fonts — the pixels in the data URL are final before the `<img>` ever
 * enters the DOM, so the first raster is the correct raster. (The
 * previous bake was an SVG data URI with the editor font embedded as a
 * base64 `@font-face` inside the image's own document; WebKit loads
 * such fonts asynchronously and does not reliably re-rasterize the
 * image when they land, so a chip could paint its label in a fallback
 * font — or not at all — until an unrelated repaint invalidated it.)
 *
 * Colors read from theme tokens via getTokenValue. The bake is
 * regenerated on theme change (see TugTextEngine.regenerateAtoms).
 */

import { getTokenValue } from "@/theme-tokens";
import {
  chipStyle,
  chipDisplayLabel,
  chipHasIcon,
  ATOM_KEY_WASH,
  PILL_CHIP_BORDER_ALPHA,
  PILL_CHIP_GEOMETRY,
  PILL_CHIP_INK_TOKEN,
  isPillAtomType,
  chipMark,
} from "./command-atom";
import type { ChipVariant } from "./command-atom";
import { progressRoleFillToken } from "@/components/tugways/tug-progress-indicator";
import { sessionSessionPhaseVisual } from "@/lib/code-session-store/session-phase-visual";
import { sessionPhaseNow } from "@/lib/code-session-store/use-session-phase";
import {
  isSessionAtomType,
  sessionAtomCallsign,
  sessionAtomProject,
} from "@/lib/session-atom-shape";
import {
  resolveSessionIdentity,
  sessionDisplayTitle,
} from "@/lib/session-identity";
import { sessionTagStore } from "@/lib/session-tag-store";
import { sessionLineStore } from "@/lib/session-line-store";
import { arcForSessionNow } from "@/lib/arc-session-index";
import { withArcSigil } from "@/lib/arc-sigil-text";
import {
  atomBaselineOffsetPx,
  atomEditorLineBoxFloorPx,
  atomRegisterMetrics,
} from "@/lib/atom-register";

/**
 * Recess-edge geometry shared by both renderers so the inline-`<svg>` chip
 * (`TugAtomChip`) and the baked data-URI chip paint an identical recess. The
 * edge is two soft layers in place of a hard stroke:
 *  - a top inner shade (the `inset 0 1px …` of a recess) — a vertical gradient
 *    from `border @ shadeOpacity` fading to transparent by `shadeStop` of the
 *    height, painted over the rounded shape;
 *  - a faint all-round inset hairline (`inset 0 0 0 1px`) — a stroked rounded
 *    rect at `hairlineOpacity`, inset half a pixel so it reads as an inner
 *    bound rather than an outline.
 */
export const ATOM_RECESS = {
  hairlineOpacity: 0.32,
  // A thin soft shade hugging the top edge — the SVG analogue of the spike's
  // `inset 0 1px 2px`, not a half-height band. Low peak opacity, fading out
  // within the top ~12% of the box.
  shadeOpacity: 0.14,
  shadeStop: 0.12,
} as const;

// ---- Types ----

/** U+FFFC — Object Replacement Character representing an atom in the text flow. */
export const TUG_ATOM_CHAR = "\uFFFC";

/**
 * Segment type used by TugTextEngine.
 *
 * The optional `id` field is a UUID minted at drop / paste time for
 * image atoms that have associated bytes in the per-card
 * `AtomBytesStore`. Atoms inserted via `@`-completion / typing /
 * legacy paths do not carry an id. The reducer-side substrate, state
 * preservation, and clipboard sidecar all round-trip the field
 * verbatim — present-when-known, absent otherwise.
 *
 * The id pairs an atom (display surface) with its bytes (storage
 * surface). At submit time, `buildWirePayload` consults the
 * bytes-store by id; at transcript-commit time, the same id moves
 * onto `AttachmentRecord.id` for click-to-enlarge lookup. Per
 * [D03](arc/dev-atoms.md#d03-atom-bytes-store).
 */
export interface AtomSegment {
  kind: "atom";
  type: string;
  label: string;
  value: string;
  /** UUID minted at drop / paste; pairs the atom with its byte payload. */
  id?: string;
}

/** Label display mode for file paths. */
export type AtomLabelMode = "filename" | "relative" | "absolute";

/** Options for createAtomImgElement. */
export interface AtomImgOptions {
  /** Maximum label width in pixels before truncation with ellipsis. */
  maxLabelWidth?: number;
  /**
   * Atom id (UUID minted at drop / paste). When present, the rendered
   * `<img>` carries a `data-atom-id` attribute the pending-sync
   * `ViewPlugin` keys off when mutating `data-pending` after bytes
   * arrive. Atoms without an id (legacy completion atoms, link /
   * command atoms) don't get this attribute.
   */
  id?: string;
  /**
   * When `true`, the rendered `<img>` carries a `data-pending="true"`
   * attribute. CSS in `atom-decoration.ts`'s `baseTheme` block
   * applies a dimmed + pulsing appearance so the user sees the atom
   * is mid-processing. The pending-sync `ViewPlugin` toggles this
   * attribute via direct DOM mutation when the bytes-store's matching
   * id transitions to "has bytes" — no CM6 widget rebuild, no React.
   * [L06].
   */
  pending?: boolean;
}

/** Lucide-style icon paths (24x24 viewBox) for atom types. */
const ATOM_ICON_PATHS: Record<string, string> = {
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  directory: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  doc: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  // MessageSquareText — the app's session mark, the same glyph the identity
  // component paints in both of its registers.
  session:
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M13 8H7"/><path d="M17 12H7"/>',
};

// ---- Layout constants ----

/** Font family stack for Canvas measurement AND Canvas label painting —
 *  the same string drives both, so measured bounds always fit the
 *  painted glyphs. Custom faces resolve from the parent document's
 *  own @font-face rules (the Canvas shares the document's font set). */
let _measureFamily = "system-ui, sans-serif";
/**
 * The editor's line-height, as a multiple of its own font size.
 *
 * Derived rather than pinned, and that is the point: an editor line has to be
 * able to seat an atom, and an atom's height is its register's rather than a
 * function of the type the line happens to be set in. So the leading is
 * whatever seats a `prose` atom over the editor's current font size, floored at
 * the leading a line of code wants when no atom is on it. Before this the
 * editor pinned 1.5 and the bake sized its chips to fit *that*, which is how
 * one atom came to be 18px in the composer and 20px in the transcript it was
 * sent to.
 *
 * Lives here rather than in `editor-settings-store` (which imports
 * {@link setAtomFont} from this module) so the bake and the store cannot
 * disagree about it; the store publishes it as `--tug-line-height-editor`.
 */
export function editorLineHeightFor(fontSizePx: number): number {
  const seated = atomEditorLineBoxFloorPx() / Math.max(1, fontSizePx);
  return Math.max(EDITOR_MIN_LINE_HEIGHT, Math.ceil(seated * 100) / 100);
}

/** The leading a line of editor text wants with no atom on it. */
const EDITOR_MIN_LINE_HEIGHT = 1.5;

function iconSizeFor(size: number): number { return size; }

/**
 * Set the font FAMILY used for the editor's atom-chip rendering AND
 * measurement. `family` is the full CSS font-family stack
 * (e.g. `"IBM Plex Mono", monospace`). The editor settings store calls this
 * when the user's font preference changes (and at cold-boot
 * construction time).
 *
 * The family only. An atom's type size is its register's, not its host's:
 * chips that grew and shrank with the editor's font size surprised users, and
 * the same coupling is what made an atom change size the moment it was sent.
 *
 * This drives the *editor*'s data-URI chip path only. React-side
 * surfaces (`TugAtomChip`) intentionally do NOT track this — they
 * use the surrounding transcript font instead, so chips read as
 * part of the prose rather than as borrowed editor-surface text.
 * The editor still calls `regenerateAtoms()` separately to bust
 * CM6's widget cache.
 */
export function setAtomFont(family: string): void {
  _measureFamily = family;
}

// ---- Text measurement ----

/** Shared canvas for text measurement. */
let _measureCanvas: HTMLCanvasElement | null = null;

/** Measure text width using Canvas 2D API. */
function measureTextWidth(text: string, font: string): number {
  if (!_measureCanvas) _measureCanvas = document.createElement("canvas");
  const ctx = _measureCanvas.getContext("2d")!;
  ctx.font = font;
  return ctx.measureText(text).width;
}

/** Construct a CSS font shorthand for Canvas measurement. */
function atomFontFor(family: string, size: number): string {
  return `${size}px ${family}`;
}
/** Current atom font as a CSS font shorthand, at the default register. */
function atomFont(): string {
  return atomFontFor(_measureFamily, atomRegisterMetrics().fontSize);
}

/** Truncate text to fit within maxWidth, appending "…" if needed. */
function truncateLabel(label: string, maxWidth: number, fontShorthand: string = atomFont()): string {
  if (measureTextWidth(label, fontShorthand) <= maxWidth) return label;
  const ellipsis = "…";
  const font = fontShorthand;
  const ellipsisW = measureTextWidth(ellipsis, font);
  let lo = 1, hi = label.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (measureTextWidth(label.slice(0, mid), font) + ellipsisW <= maxWidth) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return label.slice(0, best) + ellipsis;
}

// ---- Chip geometry (shared between data-URI and inline-SVG renderers) ----

/**
 * Pure layout description for an atom chip. Produced by
 * {@link computeAtomChipGeometry}; consumed by both the editor's
 * data-URI baker ({@link bakeAtomChipDataUri}) and the React-side
 * inline-`<svg>` component (`TugAtomChip`). Carries everything a
 * renderer needs to paint the chip *except* the four theme colors —
 * those are baked as pixels by the data-URI path (an `<img
 * src="data:...">` can't reach the host cascade) and resolved as CSS
 * variables by the inline-`<svg>` path (so a theme switch re-paints
 * for free).
 */
export interface AtomChipGeometry {
  /** Raw `<path>`/`<rect>`/`<circle>` SVG markup for the icon shape. */
  iconPath: string;
  /** Label after `maxLabelWidth` truncation (with `…` suffix if applied). */
  displayLabel: string;
  /** Chip width in px. */
  width: number;
  /** Chip height in px. */
  height: number;
  /** Corner radius (`rx`) of the chip rect, in px — from {@link chipStyle}. */
  radius: number;
  /** Whether the chip draws its leading icon glyph. A slash command has no
   *  icon (its `/` is the marker); renderers skip the icon element and the
   *  geometry reserves no icon space. */
  hasIcon: boolean;
  /** `transform` attribute for the icon `<g>` (translate + scale). */
  iconTransform: string;
  /** Icon origin (px) — the numeric pieces of {@link iconTransform},
   *  for renderers that place the icon via Canvas transforms. */
  iconX: number;
  iconY: number;
  /** Scale factor from the icon's 24×24 viewBox to its rendered size. */
  iconScale: number;
  /** `x` for the label text. */
  textX: number;
  /** `y` for the label text (baseline). */
  textY: number;
  /** Effective font size in px. */
  fontSize: number;
  /** The font-family stack used for label measurement. Renderers MUST
   *  paint with the same stack or the measured bounds won't fit. */
  fontFamily: string;
  /** The session dot's painted diameter, in px — the register's. */
  dotSize: number;
  /** Vertical-align offset (px) for `<img>`-based renderers — see
   *  {@link atomBaselineOffsetPx}. Inline-`<svg>` renderers ignore
   *  this and align via the shared `.tug-atom-chip` CSS rule. */
  baselineOffset: number;
}

/**
 * Compute the geometry for an atom chip. Pure on the inputs, the register
 * table, and the module-state `_measureFamily` default. Two calls in the same
 * font frame return value-equal geometry.
 *
 * The vertical — type size and box height — comes from the register and from
 * nowhere else, which is what makes this function and the CSS pill draw the
 * same box. The horizontal is measured from the label, as it always was.
 */
export function computeAtomChipGeometry(
  type: string,
  label: string,
  options?: {
    maxLabelWidth?: number;
    fontFamily?: string;
  },
): AtomChipGeometry {
  const family = options?.fontFamily ?? _measureFamily;
  const metrics = atomRegisterMetrics();
  const size = metrics.fontSize;
  const font = atomFontFor(family, size);
  const displayLabel = options?.maxLabelWidth != null
    ? truncateLabel(label, options.maxLabelWidth, font)
    : label;
  const textWidth = measureTextWidth(displayLabel, font);
  const icon_px = iconSizeFor(size);
  const height_px = metrics.height;
  // Padding / gap / corner radius come from the shared chip style — one place
  // (not duplicated in the two renderers). Every atom type shares this layout;
  // a slash command differs only in that it has no icon (its `/` is the
  // marker), so it reserves no icon span.
  const { paddingX, gap, radius } = isPillAtomType(type)
    ? PILL_CHIP_GEOMETRY
    : chipStyle().geometry;
  const hasIcon = chipHasIcon(type);
  const iconSpan = hasIcon ? icon_px + gap : 0;
  const width = paddingX + iconSpan + Math.ceil(textWidth) + paddingX;
  const iconX = paddingX;
  const iconY = (height_px - icon_px) / 2;
  const iconScale = icon_px / 24;
  return {
    iconPath: ATOM_ICON_PATHS[type] ?? ATOM_ICON_PATHS.file,
    displayLabel,
    width,
    height: height_px,
    radius,
    hasIcon,
    iconTransform: `translate(${iconX},${iconY}) scale(${iconScale})`,
    iconX,
    iconY,
    iconScale,
    textX: paddingX + iconSpan,
    textY: height_px / 2 + size * 0.32,
    fontSize: size,
    fontFamily: family,
    dotSize: metrics.dotSize,
    baselineOffset: atomBaselineOffsetPx(),
  };
}

// ---- Canvas painting helpers ----

/**
 * Raster scale for the PNG bake, in device pixels per CSS px. Uses the
 * screen's own density with 2× headroom so the chip stays crisp when
 * the Swift host's `WKWebView.pageZoom` scales the page up — the baked
 * bitmap is displayed at CSS size via the `<img width/height>`
 * attributes, so extra resolution costs only a few KB per chip.
 */
function bakeScale(): number {
  const dpr =
    typeof window !== "undefined" && window.devicePixelRatio
      ? window.devicePixelRatio
      : 1;
  return Math.min(6, Math.max(2, dpr * 2));
}

/** Trace a rounded-rect path (the Canvas analogue of `<rect rx>`). */
function traceRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * Stroke the elements of an {@link ATOM_ICON_PATHS} markup string onto
 * a Canvas whose transform already maps the icon's 24×24 viewBox to
 * its rendered box. The icon set uses exactly three element kinds —
 * `<path d>`, `<rect x y width height rx ry>`, `<circle cx cy r>` — so
 * a targeted parse covers it; an unrecognized element would simply not
 * draw, which the gallery smoke would catch on the next icon addition.
 */
function strokeIconMarkup(ctx: CanvasRenderingContext2D, markup: string): void {
  const elementRe = /<(path|rect|circle)\b([^>]*?)\/>/g;
  for (const el of markup.matchAll(elementRe)) {
    const attrs: Record<string, string> = {};
    for (const a of el[2]!.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
      attrs[a[1]!] = a[2]!;
    }
    switch (el[1]) {
      case "path":
        ctx.stroke(new Path2D(attrs.d ?? ""));
        break;
      case "rect":
        traceRoundedRect(
          ctx,
          Number(attrs.x ?? 0),
          Number(attrs.y ?? 0),
          Number(attrs.width ?? 0),
          Number(attrs.height ?? 0),
          Number(attrs.rx ?? 0),
        );
        ctx.stroke();
        break;
      case "circle":
        ctx.beginPath();
        ctx.arc(
          Number(attrs.cx ?? 0),
          Number(attrs.cy ?? 0),
          Number(attrs.r ?? 0),
          0,
          Math.PI * 2,
        );
        ctx.stroke();
        break;
    }
  }
}

/**
 * Paint the recess top shade: `border` color fading from
 * `shadeOpacity` at the top edge to transparent by `shadeStop` of the
 * height, clipped to the chip's rounded shape. Painted through an
 * offscreen alpha mask because Canvas gradient stops need their alpha
 * inline in the color string, and the resolved theme token can be any
 * CSS color format — `destination-in` applies a pure alpha ramp to the
 * already-filled shape without ever parsing the color.
 */
function paintRecessShade(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  radius: number,
  borderColor: string,
  scale: number,
): void {
  const off = document.createElement("canvas");
  off.width = Math.max(1, Math.round(width * scale));
  off.height = Math.max(1, Math.round(height * scale));
  const octx = off.getContext("2d");
  if (octx === null) return;
  octx.scale(off.width / width, off.height / height);
  octx.fillStyle = borderColor;
  traceRoundedRect(octx, 0, 0, width, height, radius);
  octx.fill();
  octx.globalCompositeOperation = "destination-in";
  const ramp = octx.createLinearGradient(0, 0, 0, height);
  ramp.addColorStop(0, `rgba(0,0,0,${ATOM_RECESS.shadeOpacity})`);
  ramp.addColorStop(ATOM_RECESS.shadeStop, "rgba(0,0,0,0)");
  ramp.addColorStop(1, "rgba(0,0,0,0)");
  octx.fillStyle = ramp;
  octx.fillRect(0, 0, width, height);
  ctx.drawImage(off, 0, 0, width, height);
}

/**
 * The color a session atom's dot paints, for the session its value names.
 *
 * A **snapshot**, and the only honest one available here: the chip is a Canvas
 * bake inside an `<img>`, which can neither subscribe nor cascade ([P14]). The
 * callsign is resolved through the tag index this run has built — a session
 * nothing has mentioned yet is unknown, which reads `idle` exactly as an
 * unreachable one does ([P02]: doubt is quiet, never red).
 *
 * `null` means the phase paints in the chip's own ink (the `inherit` role) —
 * the quiet mark for a session with no turn in flight.
 */
/**
 * The text a session chip draws — the identity's display title ([D141]), not
 * the reference the atom stores.
 *
 * The atom's `label` and `value` are both `<project>/<callsign>` and both stay
 * that: the value is the wire marker and the clipboard sidecar, and the label
 * is what an unresolvable chip falls back to. What a *reader* sees is the same
 * thing the masthead and the Cards card show them — a session they have named reads
 * as that name here too, and the callsign returns only under a collision.
 *
 * A **snapshot**, and the only honest one available here, exactly as
 * {@link sessionDotToken} is: the chip is a Canvas bake inside an `<img>`,
 * which can neither subscribe nor cascade ([P14]). A `/rename` therefore
 * reaches an already-baked chip through the widget regeneration in
 * `atom-decoration.ts`, the same door a theme switch comes through.
 *
 * This is one of the sanctioned non-React callers of `resolveSessionIdentity`
 * — there is no render to subscribe from, which is the whole point of the
 * regeneration path above.
 *
 * A session this run's tag index has never heard of keeps the stored label. An
 * unresolvable reference showing what it recorded is the honest rendering, and
 * it is what the transcript's live chip does with the same fact.
 *
 * **The bound arc rides the label**, because a session on an arc is never
 * named without it — the rule the identity runs follow everywhere ([D167]),
 * and the one this chip could not follow while its text came from
 * `sessionDisplayTitle` alone. There the sigil is a composed-in leaf
 * subscription; here there is nothing to subscribe with, so it is resolved at
 * bake time beside the title and reaches a bound-since chip through the same
 * widget regeneration a rename does.
 *
 * The atom's `value` is untouched by any of this. It stays
 * `<project>/<callsign>` — the wire marker and the resolution key — so a chip
 * showing an arc still resolves through the callsign the ledger answers on.
 */
function sessionChipLabel(label: string, value: string): string {
  const lineId = sessionTagStore.lineWearing(sessionAtomCallsign(value));
  const sessionId = lineId === null ? null : sessionLineStore.seatOf(lineId);
  if (sessionId === null) return label;
  const title = sessionDisplayTitle(
    resolveSessionIdentity(sessionId, {
      recordedProject: sessionAtomProject(value),
    }),
  );
  return withArcSigil(title, arcForSessionNow(sessionId)?.name ?? null);
}

function sessionDotToken(value: string): string | null {
  const lineId = sessionTagStore.lineWearing(sessionAtomCallsign(value));
  const sessionId = lineId === null ? null : sessionLineStore.seatOf(lineId);
  if (sessionId === null) return null;
  const { role } = sessionSessionPhaseVisual(sessionPhaseNow(sessionId));
  return progressRoleFillToken(role ?? "inherit");
}

/**
 * Paint a PILL atom: a transparent pill in text ink, hairline-bounded, led by
 * its mark. No ground, no Key wash, no recess — the family's treatment says
 * "inline reference", and this chip's shape says it instead (Spec S05).
 *
 * Two types reach here and they differ in one stroke, which is why this is one
 * painter rather than two. A **session** leads with a filled dot in its phase
 * colour: the mark says what the session is *doing*, and colour is the only
 * channel that can. A **commit** leads with a ring in the chip's own ink: a
 * commit cannot change after it exists, so there is no state to report and no
 * colour to report it in. Same centre, same diameter — the register's — so the
 * two marks are one size standing in one line, and neither can drift from the
 * live pill's, which reads the same table as CSS.
 */
function paintPillChip(
  ctx: CanvasRenderingContext2D,
  g: AtomChipGeometry,
  type: string,
  value: string,
  variant: ChipVariant,
): void {
  // Under the editor's selection the chip takes the family's selected text
  // token — the one the theme authors to stay legible over the blue wash. A
  // transparent pill has no ground to swap, so the ink is the whole swap.
  const ink = getTokenValue(
    variant === "selected"
      ? chipStyle("selected").tokens.text
      : PILL_CHIP_INK_TOKEN,
  );
  const mark = chipMark(type);
  // Only a session has a phase to ask about; a commit's ring is the ink.
  const dotToken = mark === "dot" ? sessionDotToken(value) : null;

  ctx.globalAlpha = PILL_CHIP_BORDER_ALPHA;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1;
  traceRoundedRect(
    ctx,
    0.5,
    0.5,
    g.width - 1,
    g.height - 1,
    Math.max(0, g.radius - 0.5),
  );
  ctx.stroke();
  ctx.globalAlpha = 1;

  if (g.hasIcon) {
    // The mark's painted diameter is the register's, so this circle and the
    // live pill's are the same mark rather than two sizes of one.
    const box = g.fontSize;
    const cx = g.iconX + box / 2;
    const cy = g.height / 2;
    if (mark === "ring") {
      // A ring, not a disc, and stroked INSIDE its diameter: the live node is
      // a `box-sizing: border-box` element whose 1.5px border eats into the
      // register's dot size rather than growing past it, so the stroke is
      // centred half a width in and the two marks occupy the same circle.
      const w = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(0, (g.dotSize - w) / 2), 0, Math.PI * 2);
      ctx.strokeStyle = ink;
      ctx.lineWidth = w;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy, g.dotSize / 2, 0, Math.PI * 2);
      ctx.fillStyle = dotToken === null ? ink : getTokenValue(dotToken);
      ctx.fill();
    }
  }

  ctx.font = `${g.fontSize}px ${g.fontFamily}`;
  ctx.fillStyle = ink;
  ctx.fillText(g.displayLabel, g.textX, g.textY);
}

// ---- Public API ----

/**
 * Result of {@link bakeAtomChipDataUri}: a self-describing chip bitmap
 * the caller can apply to an `<img>` (the editor's CM6 widget) or
 * a React-rendered `<img>` (the transcript walker), without either
 * surface re-implementing the paint / theme-token / baseline math.
 *
 * Pure data — no DOM references. Both numeric fields are in px.
 */
export interface AtomChipBake {
  /** `data:image/png;base64,…` URI ready for `<img src=...>`. */
  dataUri: string;
  /** Chip width in CSS px — set on `<img width=...>` for layout stability. */
  width: number;
  /** Chip height in CSS px — set on `<img height=...>`. */
  height: number;
  /**
   * Vertical-align offset in px (typically negative). Apply as
   * `verticalAlign: \`${baselineOffset}px\`` so the chip's internal
   * text baseline lines up with the surrounding line's baseline.
   */
  baselineOffset: number;
  /**
   * The text the bake actually PAINTED — after the type's own display rule
   * (a session chip resolves its own; a slash command wears its `/`) and
   * after any truncation to `maxLabelWidth`.
   *
   * The chip is pixels, so this is the only reading of it a caller has: it is
   * what `createAtomImgElement` gives the `<img>` as its `alt`, which is the
   * chip's whole accessible name, and what a test asserts on rather than
   * inferring the text from the bitmap's width.
   */
  displayLabel: string;
}

/**
 * Paint an atom chip with Canvas 2D and bake it to a PNG data URI.
 * Used by the editor's `createAtomImgElement` (imperative `<img>` for
 * CM6 widgets) — colors are baked as pixels because the `<img>` can't
 * reach the host CSS cascade. React-side surfaces use `TugAtomChip`
 * (inline `<svg>`) instead, which re-paints for free on theme switch
 * via CSS-variable cascading.
 *
 * The bake is synchronous and final: the label is drawn with the
 * parent document's fonts (already loaded — the same faces the Canvas
 * measurement used), so the `<img>`'s first raster shows the finished
 * chip. No font resolution happens inside the image.
 *
 * Reads theme tokens via `getTokenValue` at call time. The CM6
 * widget's regeneration counter ({@link AtomWidget} in
 * `atom-decoration.ts`) busts the reconciliation cache so the editor
 * refreshes after a theme switch.
 */
export function bakeAtomChipDataUri(
  type: string,
  label: string,
  value: string,
  options?: {
    maxLabelWidth?: number;
    /**
     * Override the font family used for label painting AND label
     * measurement (the two must match or the chip's bounds won't fit
     * the rendered text). When omitted, the chip uses the
     * module-state `_measureFamily` last set via {@link setAtomFont}
     * — which the editor settings store calls when the user's font
     * preference changes.
     */
    fontFamily?: string;
    /**
     * Which appearance to bake. `"selected"` resolves the
     * `-selected-rest` chip tokens so a chip covered by the editor
     * selection reads forward of the blue selection wash. Defaults to
     * `"default"`. Geometry is variant-independent, so the selected and
     * default bakes are pixel-identical in size.
     */
    variant?: ChipVariant;
  },
): AtomChipBake {
  // A slash command displays its leading slash (`/tugplug:commit`); every
  // other type shows its stored label. Both renderers route through
  // `chipDisplayLabel` so the text is identical across editor and transcript.
  //
  // The session atom is the exception, and only here: the transcript renders
  // one as the live `TugSessionCitation` rather than as a chip, so this bake
  // is the only session chip there is and it resolves its own text. The
  // substitution happens BEFORE the geometry, because the string it returns is
  // what the chip has to be wide enough to hold.
  const displayLabel = isSessionAtomType(type)
    ? sessionChipLabel(label, value)
    : chipDisplayLabel(type, label, value);
  const g = computeAtomChipGeometry(type, displayLabel, {
    ...(options?.maxLabelWidth !== undefined ? { maxLabelWidth: options.maxLabelWidth } : {}),
    ...(options?.fontFamily !== undefined ? { fontFamily: options.fontFamily } : {}),
  });
  const scale = bakeScale();
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(g.width * scale));
  canvas.height = Math.max(1, Math.round(g.height * scale));
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    // No 2D context (should not happen in WebKit) — a blank chip of the
    // right size beats a thrown widget render.
    return {
      dataUri: canvas.toDataURL("image/png"),
      width: g.width,
      height: g.height,
      baselineOffset: g.baselineOffset,
      displayLabel: g.displayLabel,
    };
  }
  ctx.scale(canvas.width / g.width, canvas.height / g.height);

  // The pills are the types outside the shared family: their own paint, their
  // own tokens, and a mark where the others carry a glyph.
  if (isPillAtomType(type)) {
    paintPillChip(ctx, g, type, value, options?.variant ?? "default");
    return {
      dataUri: canvas.toDataURL("image/png"),
      width: g.width,
      height: g.height,
      baselineOffset: g.baselineOffset,
      displayLabel: g.displayLabel,
    };
  }

  // Colors come from the shared chip style, resolved to concrete values
  // at bake time.
  const tokens = chipStyle(options?.variant).tokens;
  const surfaceColor = getTokenValue(tokens.surface);
  const keyColor = getTokenValue(tokens.key);
  const borderColor = getTokenValue(tokens.border);
  const iconColor = getTokenValue(tokens.icon);
  const textColor = getTokenValue(tokens.text);

  // Base surface (opaque), then the Key wash overlay — together a 9%
  // wash, no hard stroke.
  ctx.fillStyle = surfaceColor;
  traceRoundedRect(ctx, 0, 0, g.width, g.height, g.radius);
  ctx.fill();
  ctx.globalAlpha = ATOM_KEY_WASH;
  ctx.fillStyle = keyColor;
  traceRoundedRect(ctx, 0, 0, g.width, g.height, g.radius);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Recess: top inner shade, then a faint inset hairline.
  paintRecessShade(ctx, g.width, g.height, g.radius, borderColor, scale);
  ctx.globalAlpha = ATOM_RECESS.hairlineOpacity;
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 1;
  traceRoundedRect(
    ctx,
    0.5,
    0.5,
    g.width - 1,
    g.height - 1,
    Math.max(0, g.radius - 0.5),
  );
  ctx.stroke();
  ctx.globalAlpha = 1;

  if (g.hasIcon) {
    ctx.save();
    ctx.translate(g.iconX, g.iconY);
    ctx.scale(g.iconScale, g.iconScale);
    ctx.strokeStyle = iconColor;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    strokeIconMarkup(ctx, g.iconPath);
    ctx.restore();
  }

  ctx.font = `${g.fontSize}px ${g.fontFamily}`;
  ctx.fillStyle = textColor;
  ctx.fillText(g.displayLabel, g.textX, g.textY);

  return {
    dataUri: canvas.toDataURL("image/png"),
    width: g.width,
    height: g.height,
    baselineOffset: g.baselineOffset,
    displayLabel: g.displayLabel,
  };
}

/** Create an atom <img> element with a baked PNG data URI. */
export function createAtomImgElement(
  type: string,
  label: string,
  value: string,
  options?: AtomImgOptions,
): HTMLImageElement {
  const { dataUri, width, height, baselineOffset, displayLabel } =
    bakeAtomChipDataUri(
      type,
      label,
      value,
      options?.maxLabelWidth !== undefined
        ? { maxLabelWidth: options.maxLabelWidth }
        : undefined,
    );

  const img = document.createElement("img");
  img.src = dataUri;
  img.width = width;
  img.height = height;
  img.style.verticalAlign = `${baselineOffset}px`;
  img.style.margin = "0 2px";
  img.dataset.atomType = type;
  img.dataset.atomLabel = label;
  img.dataset.atomValue = value;
  img.title = value;
  // The chip's accessible name, and the only reading of its text there is:
  // everything else about it is pixels. It is the PAINTED label, not the
  // stored one — a renamed session, or one on an arc, reads here as what the
  // reader sees rather than as what the atom recorded.
  img.alt = displayLabel;

  // Optional: pair this widget with its bytes-store entry. Set only
  // when the caller has an id to attach. The pending-sync ViewPlugin
  // queries `[data-atom-id]` to toggle `data-pending` after bytes
  // arrive (skeleton → ready transition).
  if (options?.id !== undefined) {
    img.dataset.atomId = options.id;
  }
  if (options?.pending === true) {
    img.dataset.pending = "true";
  }

  return img;
}

/** Create atom img as HTML string (for execCommand insertHTML). */
export function atomImgHTML(type: string, label: string, value?: string): string {
  const el = createAtomImgElement(type, label, value ?? label);
  const wrapper = document.createElement("div");
  wrapper.appendChild(el);
  return wrapper.innerHTML;
}

// ---- Label formatting ----

/**
 * Format an atom value for display as a label.
 *
 * - "filename": last path component (e.g., "main.ts")
 * - "relative": project-relative path (e.g., "src/main.ts")
 * - "absolute": full path as-is
 *
 * For non-path values (URLs, commands), returns the value unchanged.
 */
export function formatAtomLabel(value: string, mode: AtomLabelMode): string {
  if (mode === "absolute") return value;

  // URLs — return as-is for filename mode, or strip protocol for relative
  if (value.startsWith("http://") || value.startsWith("https://")) {
    if (mode === "filename") {
      const url = value.split("?")[0].split("#")[0];
      const lastSlash = url.lastIndexOf("/");
      const filename = lastSlash >= 0 ? url.slice(lastSlash + 1) : url;
      return filename || value;
    }
    return value;
  }

  // Commands — return as-is
  if (value.startsWith("/")) {
    if (mode === "filename") {
      const lastSlash = value.lastIndexOf("/");
      return lastSlash >= 0 && lastSlash < value.length - 1
        ? value.slice(lastSlash + 1)
        : value;
    }
  }

  // File paths
  if (mode === "filename") {
    const lastSlash = value.lastIndexOf("/");
    return lastSlash >= 0 ? value.slice(lastSlash + 1) : value;
  }

  // "relative" — strip leading slash if present
  return value.startsWith("/") ? value.slice(1) : value;
}

