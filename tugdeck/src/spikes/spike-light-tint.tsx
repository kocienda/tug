/**
 * spike-light-tint.tsx — how should a LIGHT theme be colored and tinted so
 * that it looks good without looking like an explosion in a candy factory?
 *
 * ── The fault ────────────────────────────────────────────────────────────
 * The tints are fine in the dark themes and horrid in the light ones, and the
 * theme files say why. Each light theme paints its sidebar rail on the
 * `sunken` surface at `l: 910, c: 40` — OKLCH C 0.02 at L 0.91 — which is
 * DOUBLE the chroma the dark themes give the same surface (`c: 20`), at a
 * lightness where the eye reads chroma far more readily (the gamut and the
 * eye both narrow toward white, so the same C is louder at L 0.9 than at
 * L 0.3). It is also the darkest light surface on screen, so the rail is
 * the thing that pulls the eye. Beside it, the focused card lid, the Z2
 * status rung, the Z0 control band, the atoms, and the tinted badges each
 * carry their own pale wash of the KEY hue — and in every light theme the
 * Key hue is 30–35° from the neutral tint hue (vivace: cyan 200° neutrals,
 * seafoam 165° Key; harmony: indigo 260°, blue 230°), so one screen shows
 * two different greens, or a lavender and a sky. That is the candy factory:
 * many fields, each wearing a little color, in two hues.
 *
 * ── What the well-regarded light UIs do instead ──────────────────────────
 * The same answer everywhere, once you look:
 *
 *   - The canvas is white or near-white and the sidebar is the SAME neutral
 *     one step down: GitHub `#ffffff` → `#f6f8fa`, Notion `#ffffff` →
 *     `#f7f6f3`, One Light `#fafafa` → `#eaeaeb`. ΔL of 2–5 points, no accent.
 *   - A "tinted neutral" is C ≈ 0.003–0.007 at L 0.97–0.98 (Tailwind slate-50
 *     `oklch(98.4% 0.003 248)`, slate-100 `0.968 0.007`; Radix slate-2
 *     `#f9f9fb`). A COLORED surface starts at C ≈ 0.014 (Tailwind blue-50) —
 *     and Tug's rail body is at 0.02, its lid at 0.0325 (Tailwind blue-100).
 *   - Accent tint on a surface is a semantic FLAG, not ambient chrome: Primer
 *     `accent-muted #ddf4ff` marks flagged content; Radix step 3 is a
 *     component's hover, not a panel. Radix says outright: use white for the
 *     app background in light mode.
 *   - The accent hue lives in marks: selection, focus, icons, primary buttons
 *     (Apple HIG "touches of color"; Linear's light refresh pulled chrome
 *     toward neutral; Things keeps its blue for the button and the checkbox).
 *   - Chroma must FALL as lightness rises (Evil Martians' scale: C 0.011 at
 *     L 0.978, 0.032 at 0.936, peaking mid-scale) — the numeric form of the
 *     light-mode tint problem.
 *
 * ── The proposal ─────────────────────────────────────────────────────────
 * In a light theme, color is a MARK, not a FIELD. Three rules:
 *
 *   1. Fields are neutral. Every surface larger than a control — canvas,
 *      content, rail body, lids, Z0, Z2, tool blocks, wells — is a tinted
 *      neutral: c ≤ 14 authored (C ≤ 0.007) at L ≥ 0.9, in ONE hue, the
 *      theme's tint hue.
 *   2. Elevation is lightness, and the ladder is short. Content near white,
 *      rail one step down, wells one more; steps of ~2 L points.
 *   3. Color is spent on marks at full chroma: the card-type glyph, the
 *      selected row, the filled slot badge, the pulsing dot, the focus ring —
 *      and, once the lid has gone neutral, a thin Key rule along the focused
 *      lid's top edge, which is where focus goes when chroma no longer
 *      carries it.
 *
 * `paper` is the GitHub shape, and it is the treatment that was chosen; the
 * shipping look stays in the picker as the thing to compare against. (Two
 * others — a chroma-capped version of today's ladder, and paper with one
 * Key-tinted masthead — were drawn, looked at, and dropped.) The sliders tune
 * paper, and the readout is the declaration to paste.
 *
 * ── The inactive card ────────────────────────────────────────────────────
 * Once the lid is neutral, chroma no longer tells a focused card from an
 * unfocused one, so the second half of the preview is the same two cards
 * unfocused, under the deck's real recede (the fixtures stand inside a
 * `.tug-pane-chrome`, so the two blend layers apply as they do on the deck).
 * What carries focus in paper: the Key rule on the lid, full ink on the
 * title, and — the knob under tune here — DIMMED ink on the inactive title
 * bar and masthead. `Inactive ink L` is the lightness of that ink; the
 * masthead's own ladder (85% / 65%) steps down from it.
 *
 * Every override is written as `oklch(from <hue source> L C h)` — the theme's
 * own hue with the treatment's lightness and chroma substituted — so a
 * setting judged in `vivace` is the same setting in `harmony` and `aria`.
 * The two hue sources are tokens no treatment touches, so the writes cannot
 * cycle: the muted text ink carries the tint hue, the focused card-type glyph
 * carries the Key hue.
 *
 * ── What the preview does not do ─────────────────────────────────────────
 * The deck dims an unfocused pane with two blend layers on `.tug-pane-chrome`.
 * This card does not apply that wash, so the unfocused fixture shows slightly
 * MORE than the deck would. And a fixture cannot genuinely be unfocused
 * inside a focused card — see the stylesheet for the alias trick.
 *
 * @module spikes/spike-light-tint
 */

import "./spike.css";
import "./spike-light-tint.css";

import React, { useId, useLayoutEffect, useRef, useState } from "react";
import {
  CircleDot,
  FileDiff,
  LayoutGrid,
  MoveHorizontal,
  Wrench,
  X,
} from "lucide-react";

import { TugBadge } from "@/components/tugways/tug-badge";
import { TugButton } from "@/components/tugways/internal/tug-button";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugRadioGroup, TugRadioItem } from "@/components/tugways/tug-radio-group";
import { TugSlider } from "@/components/tugways/tug-slider";
import {
  TugSessionRow,
  TUG_SESSION_ROW_STACK_DOT_SIZE,
} from "@/components/tugways/tug-session-row";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import { sessionSessionPhaseVisual } from "@/lib/code-session-store/session-phase-visual";
import { useOptionalThemeContext } from "@/contexts/theme-provider";
import { getTokenValue } from "@/theme-tokens";

import type { SpikeDef } from "./spike-registry";

// ---------------------------------------------------------------------------
// The theme's two hues, by name — the readout needs the names
// ---------------------------------------------------------------------------

/**
 * Each light theme's neutral TINT hue and KEY hue, as `--tug-color()` names
 * them. Source: the `sunken` surface and the `--tugx-chrome-key-surface`
 * declarations in `styles/themes/<theme>.css`. A theme absent from this map
 * still previews correctly (the overrides are built from the computed hue
 * sources, not from this map); only the readout names the source token
 * instead of the hue.
 */
const HUES_BY_THEME: Record<string, { tint: string; key: string }> = {
  harmony: { tint: "indigo", key: "blue" },
  aria: { tint: "orchid", key: "iris" },
  vivace: { tint: "cyan", key: "seafoam" },
};

/**
 * `--tug-color()`'s chroma ceiling: authored `c` runs 0–1000 onto oklch C
 * 0–0.5, so an authored unit is `C * 2000`. Mirrors `MAX_CHROMA` in
 * `tugcolor.ts`, which is where the number is decided.
 */
const CHROMA_UNITS_PER_OKLCH = 2000;

const DOT_SIZE = TUG_SESSION_ROW_STACK_DOT_SIZE;

// ---------------------------------------------------------------------------
// Treatments — data, so the DOM writes and the readout come from one place
// ---------------------------------------------------------------------------

/** Which hue a field borrows. `gray` is achromatic and ignores `c`. */
type HueSource = "tint" | "key" | "gray";

/** One surface token at an authored lightness and chroma (0–1000 each). */
interface Field {
  token: string;
  hue: HueSource;
  l: number;
  c: number;
  /** Which slider, if any, owns this field's lightness. */
  knobL?: "rail" | "content" | "inactive";
  /** True for the focused lid, whose chroma the `Lid c` slider owns. */
  lid?: boolean;
  /**
   * True for the selected row's surface, whose chroma the `Selection c`
   * slider owns. A mark, so the field cap never touches it.
   */
  sel?: boolean;
}

interface Treatment {
  id: string;
  title: string;
  blurb: string;
  fields: readonly Field[];
  /** Height of the Key rule along the focused lid's top edge, in px. */
  lidRule: number;
  /** Width of the Key rule along the selected row's leading edge, in px. */
  selRule: number;
}

const T = {
  content: "--tug7-surface-global-primary-normal-content-rest",
  default: "--tug7-surface-global-primary-normal-default-rest",
  raised: "--tug7-surface-global-primary-normal-raised-rest",
  overlay: "--tug7-surface-global-primary-normal-overlay-rest",
  sunken: "--tug7-surface-global-primary-normal-sunken-rest",
  lid: "--tugx-chrome-key-surface",
  lidOff: "--tug7-surface-card-primary-normal-titlebar-inactive",
  status: "--tug7-surface-card-primary-normal-status-rest",
  controlbar: "--tug7-surface-card-primary-normal-controlbar-rest",
  block: "--tug7-surface-card-primary-normal-block-rest",
  well: "--tug7-surface-card-primary-normal-well-rest",
  frame: "--tug7-element-card-border-normal-frame-rest",
  border: "--tug7-element-global-border-normal-default-rest",
  borderStrong: "--tug7-element-global-border-normal-strong-rest",
  divider: "--tug7-element-global-divider-normal-default-rest",
  selection: "--tug7-surface-selection-primary-normal-selected-rest",
  selectionText: "--tug7-element-selection-text-normal-selected-rest",
  titleInactive: "--tug7-element-card-text-normal-title-inactive",
  iconInactive: "--tug7-element-card-icon-normal-title-inactive",
  controlInactive: "--tug7-element-card-control-normal-muted-rest",
} as const;

/**
 * The shipping values, restated here only so the sliders can seed from them
 * and the readout can show the diff. Source: `styles/themes/vivace.css`; all
 * three light themes carry the same numbers at their own hues.
 */
const SHIPPING: Treatment = {
  id: "shipping",
  title: "Shipping",
  blurb: "What the light themes paint today. Nothing overridden.",
  lidRule: 0,
  selRule: 0,
  fields: [],
};

const PAPER: Treatment = {
  id: "paper",
  title: "Paper",
  blurb:
    "The GitHub shape. Near-white content, the rail one step down, every field neutral; Key lives in marks and a rule on the focused lid. Selection is a pale Key wash under dark ink with a Key rule on its leading edge.",
  lidRule: 2,
  selRule: 3,
  fields: [
    // Selection: a MARK, but a mark the size of a row. A solid vivid fill is
    // the loudest thing on a light screen, so it becomes a pale wash of the
    // Key hue under the theme's own dark ink, and the leading-edge rule says
    // "selected" at full chroma in three pixels.
    { token: T.selection, hue: "key", l: 930, c: 50, sel: true },
    { token: T.selectionText, hue: "gray", l: 150, c: 0 },
    // The inactive card's ink. On the deck an unfocused card is already
    // washed by the recede; on a neutral lid that wash is nearly all there
    // is, so the title, glyph, and controls step down in lightness as well.
    // One slider, one lightness, three tokens.
    { token: T.titleInactive, hue: "tint", l: 640, c: 20, knobL: "inactive" },
    { token: T.iconInactive, hue: "tint", l: 640, c: 20, knobL: "inactive" },
    { token: T.controlInactive, hue: "tint", l: 640, c: 20, knobL: "inactive" },
    { token: T.content, hue: "tint", l: 985, c: 4, knobL: "content" },
    { token: T.default, hue: "tint", l: 985, c: 4 },
    { token: T.raised, hue: "tint", l: 985, c: 4 },
    { token: T.overlay, hue: "tint", l: 985, c: 4 },
    { token: T.sunken, hue: "tint", l: 965, c: 6, knobL: "rail" },
    { token: T.lid, hue: "tint", l: 965, c: 6, lid: true },
    { token: T.lidOff, hue: "gray", l: 970, c: 0 },
    { token: T.status, hue: "tint", l: 965, c: 6 },
    { token: T.controlbar, hue: "tint", l: 955, c: 6 },
    { token: T.block, hue: "tint", l: 965, c: 4 },
    { token: T.well, hue: "tint", l: 985, c: 4 },
    { token: T.frame, hue: "tint", l: 850, c: 8 },
    { token: T.border, hue: "tint", l: 860, c: 8 },
    { token: T.borderStrong, hue: "tint", l: 800, c: 10 },
    { token: T.divider, hue: "tint", l: 880, c: 8 },
  ],
};

const TREATMENTS: readonly Treatment[] = [SHIPPING, PAPER];

// ---------------------------------------------------------------------------
// Resolution — knobs applied over a treatment
// ---------------------------------------------------------------------------

interface Knobs {
  railL: number;
  contentL: number;
  lidC: number;
  /** The selected row's chroma. */
  selC: number;
  /** The inactive title bar's ink lightness. */
  inactiveL: number;
  /** Every field's chroma is clamped to this. */
  cap: number;
}

function seedKnobs(t: Treatment): Knobs {
  const rail = t.fields.find((f) => f.knobL === "rail");
  const content = t.fields.find((f) => f.knobL === "content");
  const lid = t.fields.find((f) => f.lid === true);
  const sel = t.fields.find((f) => f.sel === true);
  const inactive = t.fields.find((f) => f.knobL === "inactive");
  return {
    inactiveL: inactive?.l ?? 480,
    railL: rail?.l ?? 910,
    contentL: content?.l ?? 960,
    lidC: lid?.c ?? 65,
    selC: sel?.c ?? 360,
    cap:
      t.fields.filter((f) => f.sel !== true).reduce((m, f) => Math.max(m, f.c), 0) ||
      40,
  };
}

function resolveFields(t: Treatment, k: Knobs): Field[] {
  return t.fields.map((f) => {
    const l =
      f.knobL === "rail"
        ? k.railL
        : f.knobL === "content"
          ? k.contentL
          : f.knobL === "inactive"
            ? k.inactiveL
            : f.l;
    const c =
      f.lid === true ? k.lidC : f.sel === true ? k.selC : Math.min(f.c, k.cap);
    return { ...f, l, c };
  });
}

/** The CSS value written to the DOM: the theme's hue, this L and C. */
function cssValue(f: Omit<Field, "token">): string {
  const L = (f.l / 1000).toFixed(3);
  if (f.hue === "gray") return `oklch(${L} 0 0)`;
  const C = (f.c / CHROMA_UNITS_PER_OKLCH).toFixed(4);
  const source = f.hue === "key" ? "--sp-lt-key" : "--sp-lt-tint";
  return `oklch(from var(${source}) ${L} ${C} h)`;
}

/** The declaration to paste into the theme file. */
function declaration(
  f: Omit<Field, "token"> & { token: string },
  hues: { tint: string; key: string } | undefined,
): string {
  if (f.hue === "gray") return `${f.token}: --tug-color(gray, l: ${f.l});`;
  const name = hues === undefined ? undefined : f.hue === "key" ? hues.key : hues.tint;
  const value =
    name === undefined
      ? cssValue(f)
      : `--tug-color(${name}, l: ${f.l}, c: ${f.c})`;
  return `${f.token}: ${value};`;
}

// ---------------------------------------------------------------------------
// The fixtures — real pane classes, so the tune is token-only
// ---------------------------------------------------------------------------

function Cluster(): React.ReactElement {
  return (
    <div className="tug-pane-title-bar-controls">
      <TugButton
        subtype="icon"
        emphasis="ghost"
        role="action"
        size="sm"
        icon={<MoveHorizontal />}
        aria-label="Card width"
        onClick={() => {}}
      />
      <TugButton
        subtype="icon"
        emphasis="ghost"
        role="action"
        size="sm"
        icon={<CircleDot />}
        aria-label="Bullseye"
        onClick={() => {}}
      />
      <TugButton
        subtype="icon"
        emphasis="ghost"
        role="action"
        size="sm"
        icon={<X />}
        aria-label="Close"
        onClick={() => {}}
      />
    </div>
  );
}

/** A rail row — a session or a file, at the rail's own density. */
function Row({
  name,
  description,
  selected,
  badge,
}: {
  name: React.ReactNode;
  description: string;
  selected?: boolean;
  badge?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="sp-lt-row" {...(selected === true ? { "data-selected": "true" } : {})}>
      <TugSessionRow
        subAlign="title"
        indicator={
          <TugProgressIndicator
            variant="pulsing-dot"
            size={DOT_SIZE}
            phase="idle"
            phaseVisual={sessionSessionPhaseVisual}
            aria-hidden
          />
        }
        indicatorSize={DOT_SIZE}
        name={name}
        description={description}
        slots={badge}
      />
    </div>
  );
}

/**
 * The rail: the pane markup the rail tier is keyed on (`data-role="sidebar"`
 * on the pane and the bar), so the stripes, the label, and the ground are the
 * shipping rules — painted on the sunken surface the treatment is tuning.
 */
function Rail(): React.ReactElement {
  return (
    <div className="tug-pane sp-lt-pane sp-lt-rail" data-role="sidebar" data-focused="true">
      <div className="tug-pane-title-bar sp-lt-bar" data-role="sidebar">
        <span className="tug-pane-icon">
          <LayoutGrid size={13} />
        </span>
        <span className="tug-pane-title">Cards</span>
        <Cluster />
      </div>
      <div className="sp-lt-band">Sessions</div>
      <div className="sp-lt-rows">
        <Row
          name="session-fold"
          description="Trace follow-bottom scrolling and fold behavior"
          badge={
            <TugBadge emphasis="filled" role="action" size="sm">
              1
            </TugBadge>
          }
        />
        <Row
          name={
            <>
              tug/frilly-prize<span className="sp-lt-callsign">^session-narration</span>
            </>
          }
          description="Implement session-narration Step 2 and honor the seat"
          badge={
            <TugBadge emphasis="tinted" role="action" size="sm">
              2/12
            </TugBadge>
          }
        />
        <Row
          name="tug/happy-drill"
          description="No turns. Ready."
          selected
          badge={
            <TugBadge emphasis="filled" role="action" size="sm">
              3
            </TugBadge>
          }
        />
      </div>
      <div className="sp-lt-band">Files</div>
      <div className="sp-lt-rows">
        <Row name="sidebar-rail-issues.md" description="briefs" />
        <Row name="session-fold-issues.md" description="briefs" />
      </div>
    </div>
  );
}

/**
 * A Session card: masthead, Z0, a transcript with a block, Z2. The body
 * stands inside a real `.tug-pane-chrome`, so an unfocused one takes the
 * deck's own two recede layers.
 */
function SessionCard({ focused }: { focused: boolean }): React.ReactElement {
  return (
    <div
      className="tug-pane sp-lt-pane"
      {...(focused ? { "data-focused": "true" } : {})}
    >
      <div className="tug-pane-chrome sp-lt-chrome">
      <div className="tug-pane-title-bar sp-lt-bar sp-lt-bar-masthead" data-masthead="true">
        <div className="tug-masthead-frame">
          <TugSessionRow
            className="tug-masthead-frame-row"
            subAlign="title"
            indicator={
              <TugProgressIndicator
                variant="pulsing-dot"
                size={DOT_SIZE}
                phase={focused ? "streaming" : "idle"}
                phaseVisual={sessionSessionPhaseVisual}
                aria-hidden
              />
            }
            indicatorSize={DOT_SIZE}
            name="tug/happy-drill"
            description="Created Sep 11, 3:55 PM"
            activity="No turns. Ready."
          />
        </div>
        <Cluster />
      </div>
      <div className="sp-lt-z0">
        <TugBadge emphasis="tinted" role="action" size="sm">
          Prompt
        </TugBadge>
        <TugBadge emphasis="ghost" role="action" size="sm">
          Changes
        </TugBadge>
      </div>
      <div className="sp-lt-transcript">
        <div>
          The rail is painted on the <code>sunken</code> surface; the lid on the Key
          surface; this block on <code>block</code> and <code>well</code>.
        </div>
        <div className="sp-lt-block">
          <div className="sp-lt-block-head">
            <Wrench size={12} />
            <span>Edit</span>
            <span>tugdeck/styles/themes/vivace.css</span>
          </div>
          <div className="sp-lt-block-well">
            {`- --tug7-surface-global-primary-normal-sunken-rest: --tug-color(cyan, l: 910, c: 40);\n+ --tug7-surface-global-primary-normal-sunken-rest: --tug-color(cyan, l: 965, c: 6);`}
          </div>
        </div>
      </div>
      <div className="sp-lt-z2">
        <div className="sp-lt-z2-cell">
          <span className="sp-lt-z2-label">State</span>
          <span className="sp-lt-z2-value">Idle</span>
        </div>
        <div className="sp-lt-z2-cell">
          <span className="sp-lt-z2-label">Context</span>
          <span className="sp-lt-z2-value">17.6K / 1M</span>
        </div>
        <div className="sp-lt-z2-cell">
          <span className="sp-lt-z2-label">Tasks</span>
          <span className="sp-lt-z2-value">None</span>
        </div>
      </div>
      </div>
    </div>
  );
}

/** A utility card, one-line lid. */
function DiffCard({ focused }: { focused: boolean }): React.ReactElement {
  return (
    <div
      className="tug-pane sp-lt-pane"
      {...(focused ? { "data-focused": "true" } : {})}
    >
      <div className="tug-pane-chrome sp-lt-chrome">
        <div className="tug-pane-title-bar sp-lt-bar">
          <span className="tug-pane-icon">
            <FileDiff size={13} />
          </span>
          <span className="tug-pane-title">session-fold-issues.md</span>
          <Cluster />
        </div>
        <div className="sp-lt-body">
          {focused ? "a focused" : "an unfocused"} card&rsquo;s content ground
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

function SpikeLightTint(): React.ReactElement {
  const theme = useOptionalThemeContext()?.theme ?? "";
  const hues = HUES_BY_THEME[theme];
  // Light is read off the theme's own appearance token, not off the name, so
  // a re-hued or custom light theme still gets the treatments (with the
  // readout in relative-color form) and a dark one gets none: the overrides
  // are near-white surfaces, and under a dark theme's near-white ink they
  // would paint white on white and prove nothing.
  const isLight = getTokenValue("--tugx-theme-appearance") === "light";

  const [treatmentId, setTreatmentId] = useState<string>(PAPER.id);
  const treatment = TREATMENTS.find((t) => t.id === treatmentId) ?? SHIPPING;
  const [knobs, setKnobs] = useState<Knobs>(() => seedKnobs(PAPER));

  // Re-seed the sliders when the treatment changes: each treatment opens on
  // its own numbers rather than inheriting the last one's.
  const seededFor = useRef(treatmentId);
  useLayoutEffect(() => {
    if (seededFor.current === treatmentId) return;
    seededFor.current = treatmentId;
    setKnobs(seedKnobs(treatment));
  }, [treatmentId, treatment]);

  const pickerId = useId();
  const railLId = useId();
  const contentLId = useId();
  const lidCId = useId();
  const selCId = useId();
  const inactiveLId = useId();
  const capId = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    selectValue: {
      [pickerId]: (v) => setTreatmentId(v),
    },
    setValueNumber: {
      [railLId]: (v) => setKnobs((k) => ({ ...k, railL: v })),
      [contentLId]: (v) => setKnobs((k) => ({ ...k, contentL: v })),
      [lidCId]: (v) => setKnobs((k) => ({ ...k, lidC: v })),
      [selCId]: (v) => setKnobs((k) => ({ ...k, selC: v })),
      [inactiveLId]: (v) => setKnobs((k) => ({ ...k, inactiveL: v })),
      [capId]: (v) => setKnobs((k) => ({ ...k, cap: v })),
    },
  });

  const fields = isLight ? resolveFields(treatment, knobs) : [];

  // The overrides reach the preview as CUSTOM PROPERTIES on its root, not as
  // React-rendered style props on each fixture ([L06]). Every token any
  // treatment can set is cleared first, so switching to a treatment that
  // does not set a token returns that token to the theme's own value.
  const previewRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = previewRef.current;
    if (el === null) return;
    for (const token of Object.values(T)) el.style.removeProperty(token);
    for (const f of fields) el.style.setProperty(f.token, cssValue(f));
    el.style.setProperty("--sp-lt-lid-rule", `${treatment.lidRule}px`);
    el.style.setProperty("--sp-lt-sel-rule", `${treatment.selRule}px`);
  }, [fields, treatment]);

  const readout =
    fields.length === 0
      ? "/* as shipped — nothing overridden */"
      : [
          ...fields.map((f) => declaration(f, hues)),
          ...(treatment.lidRule > 0
            ? [`/* focused lid: ${treatment.lidRule}px Key rule along the top edge, at the glyph's own color */`]
            : []),
          ...(treatment.selRule > 0
            ? [`/* selected row: ${treatment.selRule}px Key rule along the leading edge, at the glyph's own color */`]
            : []),
        ].join("\n");

  return (
    <ResponderScope>
      <div
        className="sp-content"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        {!isLight && (
          <div className="sp-lt-notice">
            This tunes the LIGHT themes&rsquo; fields. You are on{" "}
            <strong>{theme || "an unknown theme"}</strong> — switch to Harmony,
            Aria, or Vivace. The complaint is about chroma at high lightness,
            and a dark ground has none to show.
          </div>
        )}

        <section className="sp-section">
          <h2 className="sp-section-title">The proposal</h2>
          <p className="sp-lt-thesis">
            In a light theme, color is a <strong>mark</strong>, not a{" "}
            <strong>field</strong>. Fields — canvas, content, rail, lids, Z0,
            Z2, blocks, wells — are tinted neutrals in one hue at c ≤ 14.
            Elevation is lightness, in steps of two or three points. Color is
            spent at full chroma on the glyph, the selection, the filled badge,
            the dot, the focus ring, and a rule on the focused lid.
          </p>
        </section>

        <section className="sp-section">
          <h2 className="sp-section-title">Tune</h2>
          <div className="sp-lt-tuner">
            <TugRadioGroup
              senderId={pickerId}
              value={treatmentId}
              size="sm"
              orientation="vertical"
              aria-label="Treatment"
            >
              {TREATMENTS.map((t) => (
                <TugRadioItem key={t.id} value={t.id} description={t.blurb}>
                  {t.title}
                </TugRadioItem>
              ))}
            </TugRadioGroup>
            <div className="sp-lt-sliders">
              <TugSlider
                label="Rail L"
                senderId={railLId}
                value={knobs.railL}
                min={880}
                max={1000}
                step={5}
                size="sm"
                disabled={fields.length === 0}
              />
              <TugSlider
                label="Content L"
                senderId={contentLId}
                value={knobs.contentL}
                min={900}
                max={1000}
                step={5}
                size="sm"
                disabled={fields.length === 0}
              />
              <TugSlider
                label="Lid c"
                senderId={lidCId}
                value={knobs.lidC}
                min={0}
                max={80}
                step={2}
                size="sm"
                disabled={fields.length === 0}
              />
              <TugSlider
                label="Selection c"
                senderId={selCId}
                value={knobs.selC}
                min={0}
                max={200}
                step={5}
                size="sm"
                disabled={fields.length === 0}
              />
              <TugSlider
                label="Inactive ink L"
                senderId={inactiveLId}
                value={knobs.inactiveL}
                min={400}
                max={850}
                step={10}
                size="sm"
                disabled={fields.length === 0}
              />
              <TugSlider
                label="Field c cap"
                senderId={capId}
                value={knobs.cap}
                min={0}
                max={40}
                step={2}
                size="sm"
                disabled={fields.length === 0}
              />
            </div>
          </div>
          <pre className="sp-lt-readout">{readout}</pre>
        </section>

        <section className="sp-section">
          <h2 className="sp-section-title">Preview</h2>
          <div className="sp-lt-preview" ref={previewRef}>
            <Rail />
            <div className="sp-lt-grid">
              <SessionCard focused />
              <SessionCard focused={false} />
              <DiffCard focused />
              <DiffCard focused={false} />
            </div>
          </div>
        </section>

        <section className="sp-section">
          <h2 className="sp-section-title">What the light UIs we admire do</h2>
          <ul className="sp-lt-sources">
            <li>
              <strong>Canvas white, sidebar one neutral step down.</strong> GitHub
              Primer <code>#ffffff</code> → <code>#f6f8fa</code>; Notion{" "}
              <code>#ffffff</code> → <code>#f7f6f3</code>; One Light{" "}
              <code>#fafafa</code> → <code>#eaeaeb</code>; Solarized Light{" "}
              <code>#fdf6e3</code> → <code>#eee8d5</code>. Same hue family, ΔL 2–5
              points, no accent in the panel.
            </li>
            <li>
              <strong>A tinted neutral is C 0.003–0.007.</strong> Tailwind slate-50{" "}
              <code>oklch(98.4% 0.003 248)</code>, slate-100{" "}
              <code>oklch(96.8% 0.007 248)</code>; Radix slate-2 <code>#f9f9fb</code>.
              A colored surface begins at C 0.014 (Tailwind blue-50). Tug&rsquo;s rail
              body is C 0.02 at L 0.91; its focused lid is C 0.0325 — Tailwind
              blue-100.
            </li>
            <li>
              <strong>Accent tint on a surface is a flag, not chrome.</strong> Primer{" "}
              <code>accent-muted #ddf4ff</code> marks flagged content only; Radix step 3
              is a component&rsquo;s hover, never a panel, and Radix says to use white
              for the light-mode app background.
            </li>
            <li>
              <strong>The accent lives in marks.</strong> Apple HIG: &ldquo;touches of
              color&rdquo; — selection, sidebar glyphs, buttons; the sidebar itself is
              gray material. Linear&rsquo;s light refresh pulled chrome to neutral.
              Things keeps its blue for the button, the checkbox, and the selection.
            </li>
            <li>
              <strong>Chroma falls as lightness rises.</strong> The gamut and the eye
              narrow toward white. Evil Martians&rsquo; OKLCH scale runs C 0.011 at L
              0.978, 0.032 at 0.936, peaking mid-scale — the numeric form of the
              light-mode tint problem.
            </li>
            <li>
              <strong>What Tug does today, and why it reads as candy.</strong> Every
              light theme paints the rail at <code>c: 40</code> (double the dark
              themes&rsquo; <code>c: 20</code>) at the darkest light lightness on
              screen, then washes the lid, Z0, Z2, atoms, and badges in a Key hue
              30–35° away from the neutral tint hue — two greens in vivace, a
              lavender and a sky in harmony.
            </li>
          </ul>
        </section>
      </div>
    </ResponderScope>
  );
}

export const spike: SpikeDef = {
  name: "light-tint",
  title: "Light Tint",
  blurb:
    "The light themes' sidebars and lids wear too much color. Compare four ways to tint a light theme so it looks good, not like a candy factory.",
  icon: "Palette",
  size: {
    min: { width: 560, height: 420 },
    preferred: { width: 860, height: 720 },
  },
  component: () => <SpikeLightTint />,
};
