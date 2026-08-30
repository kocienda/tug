/**
 * gallery-tug-progress-indicator.tsx — TugProgressIndicator showcase.
 *
 * Replaces three earlier galleries (gallery-progress, gallery-tug-
 * state-indicator, gallery-tug-thinking-indicator) — the unified
 * indicator subsumes all three predecessors.
 *
 * Layout:
 *  - Variants  — six glyphs in a wrapping card grid
 *  - pulsing-dot — the whole bench for the breathing dot in one section: the
 *                size ladder under a live state picker, the Lens-row
 *                destination, and the two knobs still worth benching.
 *                The ladder and the picker are one grid because they were
 *                always one question — every size the app asks for, crossing
 *                to whatever state you name. A still frame cannot show a
 *                crossing, and a size ladder frozen in `running` cannot show
 *                the settled poses most of these sizes spend their life in.
 *  - Roles     — eight role tones in a wrapping card grid (ring variant)
 *  - States    — a 4 × 5 matrix (variant rows × state columns)
 *  - Determinate — a 3 × 5 matrix (variant rows × value columns)
 *  - Value readout — showValue percentage on bar / ring / pie + labeled bar
 *  - Phase     — phase picker + live indicator using phaseLabels/phaseVisual
 *  - Layout    — glyphPosition picker + labelAlign="center" demo with
 *                width-stabilize so phase changes don't shift layout
 *
 * @module components/tugways/cards/gallery-tug-progress-indicator
 */

import "./gallery-tug-progress-indicator.css";

import React, { useId, useState } from "react";
import { ArrowUp } from "lucide-react";

import { TugLabel } from "@/components/tugways/tug-label";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugSeparator } from "@/components/tugways/tug-separator";
import { TugChoiceGroup } from "@/components/tugways/tug-choice-group";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import {
  breathKeyframes,
  sizeGeometry,
  DEFAULT_BREATH_TURN,
  DEFAULT_PULSE_WEIGHT,
} from "@/components/tugways/internal/tug-progress-pulsing-dot";
import {
  TugProgressIndicator,
  type TugProgressIndicatorRole,
  type TugProgressIndicatorState,
  type TugProgressIndicatorVariant,
  type TugProgressIndicatorPhaseVisual,
} from "@/components/tugways/tug-progress-indicator";

const VARIANTS: ReadonlyArray<TugProgressIndicatorVariant> = [
  "ring",
  "bar",
  "spinner",
  "pulsing-dot",
  "wave",
  "pie",
];

const ROLES: ReadonlyArray<TugProgressIndicatorRole> = [
  "inherit",
  "action",
  "agent",
  "data",
  "option",
  "success",
  "caution",
  "danger",
];

const STATE_DEMO_VARIANTS: ReadonlyArray<TugProgressIndicatorVariant> = [
  "ring",
  "pulsing-dot",
  "wave",
];

const STATES: ReadonlyArray<TugProgressIndicatorState> = [
  "running",
  "paused",
  "stopped",
  "completed",
  "aborted",
];

const DETERMINATE_VARIANTS: ReadonlyArray<TugProgressIndicatorVariant> = [
  "ring",
  "bar",
  "pie",
];

const DETERMINATE_VALUES = [0, 0.25, 0.5, 0.75, 1] as const;

const DEMO_PHASES: Record<string, string> = {
  idle: "Idle",
  streaming: "Streaming",
  awaiting_approval: "Awaiting",
  offline: "Disconnected",
};
const DEMO_PHASE_KEYS = Object.keys(DEMO_PHASES);

function demoPhaseVisual(phase: string): TugProgressIndicatorPhaseVisual {
  switch (phase) {
    case "offline":
      return { role: "danger", state: "aborted" };
    case "awaiting_approval":
      return { role: "caution", state: "running" };
    case "streaming":
      return { role: "success", state: "running" };
    case "idle":
    default:
      return { role: "inherit", state: "stopped" };
  }
}

// ---------------------------------------------------------------------------
// Cell — one labeled glyph card. The bar variant fills the cell's width.
// ---------------------------------------------------------------------------

interface GalleryCellProps {
  caption: string;
  children: React.ReactNode;
  /** Wide cell — used for the bar variant. */
  wide?: boolean;
}

function GalleryCell({
  caption,
  children,
  wide,
}: GalleryCellProps): React.ReactElement {
  return (
    <div className={wide ? "gpi-cell gpi-cell-wide" : "gpi-cell"}>
      <div className="gpi-cell-glyph">{children}</div>
      <div className="gpi-cell-caption">{caption}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GalleryTugProgressIndicator
// ---------------------------------------------------------------------------

/**
 * Where the glyph is going, and the size it goes there at — the leading slot
 * of a Lens Sessions row.
 */
const LENS_SIZE = 28;

/** The size the envelope is judged at, and the size it was authored at. */
const BENCH_SIZE = 32;

/**
 * The size ladder — every size the app actually asks this glyph for, with the
 * surface that asks for it.
 *
 * This is the bench that matters now. The breathing dot was designed at 32px
 * and judged there; making it the only dot means it also has to serve a status
 * cell at 10. It does that by being two treatments rather than one figure
 * scaled: a big one for the Lens, where there are enough pixels for relative
 * size to encode state, and a small one that is the previous glyph's geometry
 * exactly — same dot ratio, same full-box ring, same hairline — carrying the
 * new motion and nothing else.
 *
 * Note where the band sits. Every size the app really asks for is 16 and under
 * or 28 and over, so nothing ships as a blend; the two middle cells are here to
 * show that the crossing is a ramp and not a cliff.
 */
const LADDER: ReadonlyArray<{ size: number; where: string }> = [
  { size: 10, where: "WORK cell" },
  { size: 12, where: "Z2 status · jobs · goals" },
  { size: 14, where: "tool header · setup · todo" },
  { size: 16, where: "indicator default" },
  { size: 20, where: "—" },
  { size: 24, where: "—" },
  { size: 28, where: "Lens session row" },
  { size: 32, where: "authored size" },
];

/** "12px · Z2 status · small". Which treatment this rung is getting. */
function ladderCaption(size: number, where: string): string {
  const { ratio } = sizeGeometry(size);
  // Recovered from the ratio rather than re-derived, so the caption cannot
  // disagree with what the glyph beside it is actually doing.
  const small = Math.round(((0.6 - ratio) / 0.1) * 100);
  const treatment =
    small === 100 ? "small" : small === 0 ? "big" : `${small}% small`;
  return `${size}px · ${where} · ${treatment}`;
}

/**
 * The two knobs still worth a side-by-side, each as the shipped value against
 * the one alternative that makes the argument.
 *
 * **Turn** is where in the cycle the dot reaches full size, so it is also the
 * split between the legs: 0.3 means the dot rises over 600ms of the 2s cycle
 * and sinks over the remaining 1400ms. The comparison that carries the
 * decision is against 0.5 — the symmetric breath this variant shipped with
 * first, the one that reads as a mechanism cycling rather than something
 * alive. Cuts between the two only interpolate between those two readings, and
 * a bench of them asks the eye to grade a continuum instead of judging a
 * choice. Everything else about the envelope follows from the turn: the ring's
 * ignition sits 3% of the cycle ahead of it, at whatever radius the dot's edge
 * measures there.
 *
 * **Stroke** is where the pulse's stroke arrives by the end of its travel;
 * every cell is born at the same 1px hairline. ×1 is a pulse that barely opens
 * at all, leaving as thin as the ring it settles into, and it is the reading
 * the shipped ×1.6 was chosen against. Expect a coarse difference rather than
 * a fine one — borders resolve to device pixels, so the knob is continuous and
 * the screen is not, which is also why the intermediate weights were never
 * distinguishable here.
 */
/** Keyframe prefix for the one alternative envelope the bench shows. */
const SYMMETRIC_PREFIX = "gpi-symmetric";

/**
 * Point a glyph at a different envelope.
 *
 * The turn is no longer a variable the stylesheet reads — the shape lives in
 * the keyframe stops, because an easing that carries it cannot be accelerated.
 * So an alternative cut is an alternative `@keyframes` block, injected once
 * below, and the override is its NAME.
 */
function envelopeNamed(prefix: string): React.CSSProperties {
  return {
    ["--tugx-progress-pulsing-dot-breathe-name" as string]: `${prefix}-breathe`,
    ["--tugx-progress-pulsing-dot-emit-expand-name" as string]: `${prefix}-emit-expand`,
    ["--tugx-progress-pulsing-dot-emit-fade-name" as string]: `${prefix}-emit-fade`,
  } as React.CSSProperties;
}

const KNOBS: ReadonlyArray<{
  key: string;
  caption: string;
  style: React.CSSProperties;
}> = [
  {
    key: "turn-symmetric",
    caption: "turn 50 / 50 — symmetric",
    style: envelopeNamed(SYMMETRIC_PREFIX),
  },
  {
    key: "turn-shipped",
    caption: `turn ${Math.round(DEFAULT_BREATH_TURN * 100)} / ${Math.round(
      (1 - DEFAULT_BREATH_TURN) * 100,
    )} — shipped`,
    style: {},
  },
  {
    key: "stroke-flat",
    caption: "stroke ×1 — barely opens",
    style: {
      ["--tugx-progress-pulsing-dot-pulse-weight" as string]: "1",
    } as React.CSSProperties,
  },
  {
    key: "stroke-shipped",
    caption: `stroke ×${DEFAULT_PULSE_WEIGHT} — shipped`,
    style: {
      ["--tugx-progress-pulsing-dot-pulse-weight" as string]: String(
        DEFAULT_PULSE_WEIGHT,
      ),
    } as React.CSSProperties,
  },
];

const CROSSING_ITEMS = STATES.map((s) => ({ value: s, label: s }));

const PHASE_ITEMS = DEMO_PHASE_KEYS.map((p) => ({ value: p, label: p }));
const GLYPH_POSITION_ITEMS = [
  { value: "left", label: "left" },
  { value: "right", label: "right" },
  { value: "both", label: "both" },
];

export function GalleryTugProgressIndicator(): React.ReactElement {
  const [phase, setPhase] = useState<string>("streaming");
  const [glyphPosition, setGlyphPosition] = useState<"left" | "right" | "both">(
    "both",
  );
  const [crossingState, setCrossingState] =
    useState<TugProgressIndicatorState>("running");

  const phaseGroupId = useId();
  const layoutPhaseGroupId = useId();
  const glyphPositionGroupId = useId();
  const crossingGroupId = useId();

  const { ResponderScope, responderRef } = useResponderForm({
    selectValue: {
      [phaseGroupId]: setPhase,
      [layoutPhaseGroupId]: setPhase,
      [glyphPositionGroupId]: (v: string) =>
        setGlyphPosition(v as "left" | "right" | "both"),
      [crossingGroupId]: (v: string) =>
        setCrossingState(v as TugProgressIndicatorState),
    },
  });

  return (
    <ResponderScope>
      <div
        className="cg-content"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        {/* The one alternative envelope the knob bench compares against. */}
        <style>{breathKeyframes(0.5, SYMMETRIC_PREFIX)}</style>

        {/* Variants ---------------------------------------------------- */}
        <section className="cg-section">
          <TugLabel className="cg-section-title">
            Variants — seven glyphs, default role, running
          </TugLabel>
          <div className="gpi-grid">
            {VARIANTS.map((v) => (
              <GalleryCell key={v} caption={v} wide={v === "bar"}>
                <TugProgressIndicator
                  variant={v}
                  size={v === "bar" ? 6 : 20}
                  state="running"
                />
              </GalleryCell>
            ))}
          </div>
        </section>

        <TugSeparator />

        {/* Large pulsing dot — the workshop bench --------------------- */}
        <section className="cg-section">
          <TugLabel className="cg-section-title">
            pulsing-dot — breathing dot, ring on the fall
          </TugLabel>
          <TugLabel size="2xs" emphasis="calm">
            The inner dot eases between 0.35 and full size over a 2s cycle,
            traveling the whole swing every time. The ring is not on its own
            clock: it is lit a few degrees before top dead center — 27% of the
            cycle, ~10.8° BTDC — flush with the dot's edge, so it is already
            moving when the dot turns over it. It then widens to the glyph box
            and fades across the exhale. Its stroke is born a 1px hairline and
            holds there through most of the travel before opening to the full
            pulse weight — sharp for long enough to be read as sharp, soft by
            the time it is leaving.
          </TugLabel>
          <TugLabel size="2xs" emphasis="calm">
            **One variant, two treatments.** Below is every size the app asks
            this glyph for, with the surface that asks. At 16px and under it is
            the previous glyph's geometry exactly — same 0.5 dot ratio, same
            full-box static ring, same hairline — picking up the new motion and
            nothing else, so a settled dot in a Z2 cell or a tool-call header
            paints the pixels it always painted. From 28px up it is the Lens
            figure, where the extra size buys a 0.6 dot ratio, a ring held
            inside the box, and the PRESENCE ladder: running owns the whole box,
            paused and aborted draw in to 0.7, stopped and completed recede to
            0.5. The box itself never changes, so nothing reflows — only the
            figure inside it does. Two numbers move on the way down: the ring's
            reach, let out past the box to 1.75× because 2.5px of radius reads
            as a twitch rather than a pulse, and the breath's depth, which
            narrows to a 0.7 trough because a 6px dot cannot spend half its
            diameter every cycle. The two middle rungs are here to show that the
            crossing between treatments is a ramp and not a cliff.
          </TugLabel>
          {/* The state picker drives the whole ladder at once, so one click
              crosses both treatments together. Scoped as the crossing bench —
              AT0276 asserts that NO glyph inside this subtree is left emitting
              after a settled crossing, so every glyph in here must be one the
              picker drives. The previews and knob cells below run `running`
              permanently and are deliberately outside it. */}
          <div data-bench="crossing">
            <TugChoiceGroup
              size="sm"
              value={crossingState}
              senderId={crossingGroupId}
              items={CROSSING_ITEMS}
              aria-label="Crossing state"
            />
            <div className="gpi-grid">
              {LADDER.map(({ size, where }) => (
                <GalleryCell key={size} caption={ladderCaption(size, where)}>
                  <TugProgressIndicator
                    variant="pulsing-dot"
                    size={size}
                    state={crossingState}
                  />
                </GalleryCell>
              ))}
            </div>
          </div>
          <TugLabel size="2xs" emphasis="calm">
            **Every state change is a transition, never a cut.** A real one
            lands on a frame nobody chose — a tool call finishes mid-breath,
            with a ring halfway through its travel — and the glyph has to arrive
            without tearing. A lit pulse always finishes: it was shed, it is
            travelling outward under its own momentum, and the work ending is no
            business of its, so the emitter is released on the pulse's clock
            rather than the state's. A ring that was never lit is simply never
            lit. The dot is caught where it stands — its live scale is pinned,
            the loop dropped against that pin so the removal changes nothing,
            and a transition carries it from there. Going back into running is
            the same idea inverted: the breath starts at the phase whose pose the
            dot already holds, and picks it up mid-stride.
          </TugLabel>
          <TugLabel size="2xs" emphasis="calm">
            The destination, at the {LENS_SIZE}px the Lens actually asks for:
            the leading slot of a Sessions row, over the row's own two-line
            type. Beside it the scale reference — the real Z5 submit button, a
            36px square, which is the legibility this variant is aiming at and
            runs a little under, since motion carries some of the load size
            alone carries for a static control.
          </TugLabel>
          <div className="gpi-demo-frame">
            <div className="gpi-row-preview">
              <TugPushButton
                subtype="icon"
                size="lg"
                emphasis="filled"
                role="action"
                aria-label="Z5 submit button, for scale"
                icon={<ArrowUp size={16} strokeWidth={2.5} />}
              />
              <TugProgressIndicator
                variant="pulsing-dot"
                size={LENS_SIZE}
                state="running"
              />
            </div>
          </div>
          <div className="gpi-demo-frame">
            <div className="gpi-row-preview">
              <TugProgressIndicator
                variant="pulsing-dot"
                size={LENS_SIZE}
                state="running"
              />
              <div className="gpi-row-preview-text">
                <div className="gpi-row-preview-title">tugtool/coral-clip</div>
                <div className="gpi-row-preview-pulse">
                  Read select-tests.ts…
                </div>
              </div>
            </div>
          </div>
          <TugLabel size="2xs" emphasis="calm">
            The shape axis. Both marks are the same glyph on the same breath —
            the diamond is the whole glyph TURNED, mark and pulse together.
            Same FIGURE is the rule, and it is geometry rather than taste: the
            pulse is born on the mark's own radius, so a mark of some other
            shape gets sawn across by its own pulse for the whole travel
            instead of shedding it. Same TONE is not the rule, and the diamond
            spends that freedom: its mark keeps the working cobalt while its
            pulse takes the idle ink, so the glyph reads as a working core
            inside a shell at rest — which is exactly what a session whose
            turn has committed and whose agents have not is. A session IN a
            turn is the dot, cobalt throughout.
          </TugLabel>
          <div className="gpi-grid">
            <GalleryCell caption="dot — a turn in flight">
              <TugProgressIndicator
                variant="pulsing-dot"
                size={BENCH_SIZE}
                role="action"
                state="running"
              />
            </GalleryCell>
            <GalleryCell caption="diamond — background work">
              <TugProgressIndicator
                variant="pulsing-dot"
                size={BENCH_SIZE}
                role="action"
                state="running"
                shape="diamond"
              />
            </GalleryCell>
            <GalleryCell caption={`diamond, at the Lens's ${LENS_SIZE}px`}>
              <TugProgressIndicator
                variant="pulsing-dot"
                size={LENS_SIZE}
                role="action"
                state="running"
                shape="diamond"
              />
            </GalleryCell>
            <GalleryCell caption="idle — the quiet tone, still">
              <TugProgressIndicator
                variant="pulsing-dot"
                size={BENCH_SIZE}
                role="inherit"
                state="stopped"
              />
            </GalleryCell>
          </div>
          <TugLabel size="2xs" emphasis="calm">
            The knobs, each shown as the shipped value against the one
            alternative that makes the case for it. The turn cell IS a separate
            keyframe block — the envelope's shape lives in the stops, since an
            easing that carries it cannot be handed to the compositor, so a
            different cut is a different `@keyframes` and the override is its
            name. The stroke cells set `--…-pulse-weight`, which is still an
            ordinary variable. The period is not pinned either — dots run the
            nominal 2s unless a caller opts into the jitter, and the only caller
            that does is the Lens.
          </TugLabel>
          <div className="gpi-grid">
            {KNOBS.map(({ key, caption, style }) => (
              <GalleryCell key={key} caption={caption}>
                <TugProgressIndicator
                  variant="pulsing-dot"
                  size={BENCH_SIZE}
                  state="running"
                  style={style}
                />
              </GalleryCell>
            ))}
          </div>
        </section>

        <TugSeparator />

        {/* Roles ------------------------------------------------------- */}
        <section className="cg-section">
          <TugLabel className="cg-section-title">
            Roles — eight role tones (ring variant)
          </TugLabel>
          <div className="gpi-grid">
            {ROLES.map((r) => (
              <GalleryCell key={r} caption={r}>
                <TugProgressIndicator
                  variant="ring"
                  size={20}
                  role={r}
                  state="running"
                />
              </GalleryCell>
            ))}
          </div>
        </section>

        <TugSeparator />

        {/* States matrix ---------------------------------------------- */}
        <section className="cg-section">
          <TugLabel className="cg-section-title">
            States — three variants × five states
          </TugLabel>
          <div
            className="gpi-matrix"
            style={{
              gridTemplateColumns: `auto repeat(${STATES.length}, minmax(80px, 1fr))`,
            }}
          >
            {/* header row */}
            <div className="gpi-matrix-corner" />
            {STATES.map((s) => (
              <div key={s} className="gpi-matrix-col-head">
                {s}
              </div>
            ))}
            {STATE_DEMO_VARIANTS.map((variant) => (
              <React.Fragment key={variant}>
                <div className="gpi-matrix-row-head">{variant}</div>
                {STATES.map((s) => (
                  <div key={s} className="gpi-matrix-cell">
                    {/* No explicit `role` — each state's default role
                      shows through (running→action, paused→caution,
                      stopped→inherit, completed→success, aborted→danger). */}
                    <TugProgressIndicator
                      variant={variant}
                      size={20}
                      state={s}
                    />
                  </div>
                ))}
              </React.Fragment>
            ))}
          </div>
        </section>

        <TugSeparator />

        {/* Determinate matrix ----------------------------------------- */}
        <section className="cg-section">
          <TugLabel className="cg-section-title">
            Determinate — three variants × five fill values
          </TugLabel>
          <div
            className="gpi-matrix"
            style={{
              gridTemplateColumns: `auto repeat(${DETERMINATE_VALUES.length}, minmax(80px, 1fr))`,
            }}
          >
            <div className="gpi-matrix-corner" />
            {DETERMINATE_VALUES.map((v) => (
              <div key={v} className="gpi-matrix-col-head">
                {Math.round(v * 100)}%
              </div>
            ))}
            {DETERMINATE_VARIANTS.map((variant) => (
              <React.Fragment key={variant}>
                <div className="gpi-matrix-row-head">{variant}</div>
                {DETERMINATE_VALUES.map((v) => (
                  <div key={v} className="gpi-matrix-cell">
                    <TugProgressIndicator
                      variant={variant}
                      size={variant === "bar" ? 6 : 22}
                      role="action"
                      value={v}
                    />
                  </div>
                ))}
              </React.Fragment>
            ))}
          </div>
        </section>

        <TugSeparator />

        {/* Value readout ---------------------------------------------- */}
        <section className="cg-section">
          <TugLabel className="cg-section-title">
            Value readout — showValue (determinate)
          </TugLabel>
          <TugLabel size="2xs" emphasis="calm">
            `showValue` renders the determinate value as a muted percentage at
            the trailing end of the row. For the bar it sits to the right of the
            flexing track; pair with `label` for the canonical labeled bar.
            Override the text via `formatValue`.
          </TugLabel>
          <div className="gpi-readout-frame">
            <TugProgressIndicator
              variant="bar"
              size={8}
              role="action"
              value={0.42}
              showValue
            />
            <TugProgressIndicator
              variant="bar"
              size={8}
              role="action"
              value={0.42}
              showValue
              label="Summarizing…"
              glyphPosition="right"
            />
            <div className="gpi-readout-glyphs">
              <TugProgressIndicator
                variant="ring"
                size={22}
                role="action"
                value={0.42}
                showValue
              />
              <TugProgressIndicator
                variant="pie"
                size={22}
                role="action"
                value={0.75}
                showValue
              />
            </div>
          </div>
        </section>

        <TugSeparator />

        {/* Phase ------------------------------------------------------- */}
        <section className="cg-section">
          <TugLabel className="cg-section-title">
            Phase — phaseLabels + phaseVisual
          </TugLabel>
          <TugLabel size="2xs" emphasis="calm">
            The caller passes a free-form `phase` plus a `phaseLabels` map and a
            `phaseVisual` mapper; explicit `role` / `state` props override the
            mapper's return.
          </TugLabel>
          <TugChoiceGroup
            size="sm"
            value={phase}
            senderId={phaseGroupId}
            items={PHASE_ITEMS}
            aria-label="Phase picker"
          />
          <div className="gpi-demo-frame">
            <TugProgressIndicator
              variant="pulsing-dot"
              size={16}
              phase={phase}
              phaseLabels={DEMO_PHASES}
              phaseVisual={demoPhaseVisual}
            />
          </div>
        </section>

        <TugSeparator />

        {/* Layout ------------------------------------------------------ */}
        <section className="cg-section">
          <TugLabel className="cg-section-title">
            Layout — glyphPosition × labelAlign="center" width-stabilize
          </TugLabel>
          <TugLabel size="2xs" emphasis="calm">
            The label cell sizes to the widest `phaseLabels` entry
            ("Disconnected"); the active label centers within that width — no
            layout jitter when the phase flips.
          </TugLabel>
          <TugChoiceGroup
            size="sm"
            value={glyphPosition}
            senderId={glyphPositionGroupId}
            items={GLYPH_POSITION_ITEMS}
            aria-label="Glyph position"
          />
          <TugChoiceGroup
            size="sm"
            value={phase}
            senderId={layoutPhaseGroupId}
            items={PHASE_ITEMS}
            aria-label="Phase picker"
          />
          <div className="gpi-demo-frame">
            <TugProgressIndicator
              variant="pulsing-dot"
              size={12}
              phase={phase}
              phaseLabels={DEMO_PHASES}
              phaseVisual={demoPhaseVisual}
              glyphPosition={glyphPosition}
              labelAlign="center"
            />
          </div>
        </section>
      </div>
    </ResponderScope>
  );
}
