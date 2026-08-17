/**
 * gallery-pulse-display.tsx — the PULSE's design surface.
 *
 * The PULSE is a two-level feed. INTENT is the headline: the model's reading
 * of the goal. ACTIVITY is the detail: the operation running now in service
 * of it. Both levels, both layouts, and every typographic proposal on this
 * card are rendered by the REAL {@link TugPulse} — the same component the Z2
 * strip and the Lens row mount. There is no gallery copy of the type rules,
 * so what is tuned here is what ships, and rolling a decision out is changing
 * `TUG_PULSE_DEFAULT_PRESET`.
 *
 * The open question this card is asking: the activity run has been set in
 * mono, which spends more width per character than any other face we ship on
 * the one line where width is the scarce resource. The presets audition Plex
 * Sans Condensed in its place, across a ladder of sizes, and the bake-off
 * measures them rather than asserting. A preset changes the SECOND run only —
 * the headline is Plex Sans Condensed medium 12px throughout.
 *
 * The card's other question is the Lens session row's PACKING — how one
 * rail's width is divided between the phase indicator, the session name, the
 * layout slots, and the PULSE's three parts. Those frames mount the real
 * {@link TugSessionRow} with the real indicator, slots, and tape inside it, one
 * frame per {@link TugSessionRowFit}, and the fit meter measures what each
 * proposal actually hands the two runs rather than arguing it. Rolling a fit
 * out is changing `TUG_SESSION_ROW_DEFAULT_FIT`.
 *
 * The row carries no reorder handle: a Lens row is carried by its own surface
 * (`block-reorder`), so there is no trailing column of furniture and every fit
 * below is auditioned with the row's content running out to the rail's edge.
 *
 * Fixtures are hand-authored; the sparklines are the real `TugSparkline` fed
 * a deterministic synthetic series so the frames read live without a session
 * behind them.
 *
 * @module components/tugways/cards/gallery-pulse-display
 */

import "./gallery-pulse-display.css";

import React, { useCallback, useEffect, useRef } from "react";

import {
  sparklineCurves,
  TugSparkline,
} from "@/components/tugways/tug-sparkline";
import { TugSeparator } from "@/components/tugways/tug-separator";
import { whenFaceLoaded } from "@/lib/font-metrics";
import { TugChartGlyph } from "@/components/tugways/tug-chart-glyph";
import {
  TUG_PULSE_PRESETS,
  TugPulse,
  type TugPulsePreset,
} from "@/components/tugways/tug-pulse";
import {
  TUG_SESSION_ROW_INDICATOR_SIZE,
  TUG_SESSION_ROW_SPARK_HEIGHT,
  TUG_SESSION_ROW_SPARK_WIDTH,
  TugSessionRow,
} from "@/components/tugways/tug-session-row";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugSlotLayout } from "@/components/tugways/tug-slot-layout";
import type { TugSlotState } from "@/components/tugways/tug-slot";
import { sessionSessionPhaseVisual } from "@/lib/code-session-store/session-phase-visual";

// ---------------------------------------------------------------------------
// Fixtures — intent in headline register: no articles, no needless words.
// ---------------------------------------------------------------------------

interface PulsePair {
  intent: string;
  activity: string;
}

const PAIRS: readonly PulsePair[] = [
  {
    intent: "Hunting ⌘L focus drift in Lens",
    activity: "Read focus-manager.ts",
  },
  {
    intent: "Wiring overview emitter cadence gate",
    activity: "cargo nextest run session_synopsis",
  },
  {
    intent: "Pinning slot-assign focus via app-test",
    activity: "Edit at0278-lens-cmdl-focus-stability.test.ts",
  },
  {
    intent: "Chasing flaky shell-restore test",
    activity: "just app-test at0261-shell-restore.test.ts",
  },
  {
    intent: "Mapping theme token fallbacks",
    activity: "Grep styles/themes for accent tokens",
  },
  {
    intent: "Drafting release-gesture roadmap",
    activity: "Edit roadmap/app-release-recipes.md",
  },
  {
    intent: "Tracing capture blackout root cause",
    activity: "Read tugcast/src/feeds/pulse.rs",
  },
  {
    intent: "Bundling static tmux from source",
    activity: "bash scripts/fetch-tmux.sh --verify",
  },
];

/** Overflow fixture — headline-brief intent, oversized activity. */
const LONG_PAIR: PulsePair = {
  intent: "Fixing download resume restart-from-zero",
  activity:
    "curl --range 4194304- https://huggingface.co/mlx-community/weights-00002-of-00009.safetensors",
};

/** The rewrite rule in action: flabby prose → headline register. */
const DOCTRINE: ReadonlyArray<{ before: string; after: string }> = [
  {
    before: "Investigating the Cmd-L focus drift in the Lens card",
    after: "Hunting ⌘L focus drift in Lens",
  },
  {
    before: "Working on wiring up the overview emitter's cadence gate",
    after: "Wiring overview cadence gate",
  },
  {
    before: "Trying to figure out why the download resume path restarts from zero",
    after: "Fixing download resume restart-from-zero",
  },
  {
    before: "Running the test suite for the session synopsis module",
    after: "Testing session synopsis",
  },
  {
    before: "Making some updates to the release recipes roadmap document",
    after: "Drafting release-recipe roadmap",
  },
];

/**
 * The Lens rows the fit audition sets. Each fit is shown twice: once on an
 * everyday session, once on the one that does not fit. The pair is the SAME in
 * every fit, so what differs between two frames is only how the row packs.
 */
const FIT_CALM: SessionFixture = {
  name: "tugtool/lens-xp",
  intent: PAIRS[0].intent,
  activity: PAIRS[0].activity,
  phase: "streaming",
};

const FIT_PRESSURE: SessionFixture = {
  name: "tugtool/local-model-bringup",
  intent: LONG_PAIR.intent,
  activity: LONG_PAIR.activity,
  phase: "tool_work",
};

/** One session's row content, as the Lens would supply it. */
interface SessionFixture {
  name: string;
  intent?: string;
  activity?: string;
  phase: string;
}

/** The lifecycle, as four rows: both levels live, no intent yet, intent held
 *  with nothing running, and a session before its first beat. */
const LIFECYCLE_ROWS: readonly SessionFixture[] = [
  {
    name: "tugtool/lens-xp",
    intent: PAIRS[2].intent,
    activity: PAIRS[2].activity,
    phase: "streaming",
  },
  {
    name: "tugtool/local-model-bringup",
    activity: "Grep tugdeck/src for pulse",
    phase: "tool_work",
  },
  {
    name: "tugtool/release-recipes",
    intent: PAIRS[1].intent,
    phase: "idle",
  },
  { name: "tugtool/bonsai-eval", phase: "idle" },
];

/**
 * What each preset proposes, in one line, beside the thing it proposes.
 *
 * A condensed rung sets both runs at ONE size and lets weight do the
 * separating, so each blurb names both runs and the rung is read as a single
 * decision — how big is the PULSE.
 */
const PRESET_BLURB: Record<TugPulsePreset, string> = {
  machine:
    "Condensed medium 12px › Mono regular 11px — the old setting, kept only to be measured against.",
  "condensed-sm":
    "Condensed medium 11px › Condensed regular 11px — the quiet rung.",
  condensed:
    "Condensed medium 12px › Condensed regular 12px — the shipping rung, and the app's default.",
  "condensed-lg":
    "Condensed medium 13px › Condensed regular 13px — the loud rung.",
};

/**
 * The condensed weights we ship, for the second run. The ladder above sets
 * regular; this is the column that shows what the other cuts cost in color,
 * so the weight can be chosen on sight rather than by name.
 */
const ACTIVITY_WEIGHTS: ReadonlyArray<{ weight: number; name: string }> = [
  { weight: 100, name: "thin" },
  { weight: 200, name: "extralight" },
  { weight: 300, name: "light" },
  { weight: 400, name: "regular" },
];

// Sparkline shape — the strip's own constants, so the demos read at the
// shipping weight.
const SPARK_FULL_SCALE = 1200;
const SPARK_CURVE = sparklineCurves.gamma(0.6);
const DEMO_BIN_MS = 250;

// The session row's own metrics, imported rather than restated: an audition
// whose dot or tape is a different size than the Lens's is an audition of a row
// nobody ships.
const ROW_PHASE_DOT_SIZE = TUG_SESSION_ROW_INDICATOR_SIZE;
const SPARK_ROW_WIDTH = TUG_SESSION_ROW_SPARK_WIDTH;
const SPARK_ROW_HEIGHT = TUG_SESSION_ROW_SPARK_HEIGHT;

// The slot layout as a row wears it while its card holds the second slot and is
// the one on top of it — the everyday look, so the furniture is auditioned at
// the width it actually has.
const SLOT_STATES: readonly TugSlotState[] = ["rest", "filled", "rest"];

/**
 * The real sparkline over a deterministic synthetic series — a phased
 * wave with bursts, derived from wall-clock bins so the tape scrolls
 * live. `phase` decorrelates the frames so no two demos pulse in step.
 */
function DemoSpark({
  phase,
  width = 64,
  height = 22,
}: {
  phase: number;
  width?: number;
  height?: number;
}): React.ReactElement {
  const getSeries = useCallback(
    (nowMs: number): number[] => {
      const bins = 48;
      const head = Math.floor(nowMs / DEMO_BIN_MS);
      const out: number[] = [];
      for (let i = 0; i < bins; i++) {
        const t = head - (bins - 1) + i + phase * 17;
        const wave = Math.sin(t / 5) * 0.5 + 0.5;
        const burst = Math.sin(t / 23) > 0.55 ? 1 : 0.22;
        out.push(wave * burst * 900);
      }
      return out;
    },
    [phase],
  );
  // The demo's data is synthesized from the wall clock, so its data-event
  // clock is an explicit driver ticking at the bin cadence — the gallery
  // stands in for the store here, generator and clock alike. Confined to
  // this audition card; product tapes ride the activity store's events.
  const subscribeActivity = useCallback((wake: () => void): (() => void) => {
    const timer = window.setInterval(wake, DEMO_BIN_MS);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <TugSparkline
      getSeries={getSeries}
      subscribeActivity={subscribeActivity}
      binMs={DEMO_BIN_MS}
      fullScale={SPARK_FULL_SCALE}
      curve={SPARK_CURVE}
      width={width}
      height={height}
      title="Synthetic activity (demo)"
    />
  );
}

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

function Section({
  title,
  blurb,
  children,
}: {
  title: string;
  blurb?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="gpd-section">
      <h3 className="gpd-section-title">{title}</h3>
      {blurb !== undefined ? <p className="gpd-blurb">{blurb}</p> : null}
      {children}
    </section>
  );
}

/** The strip's legend pill, as a plain label — the shipping one is a popover
 *  trigger, and its behavior is the strip's business, not the type's. */
function Legend(): React.ReactElement {
  return <span className="gpd-legend">PULSE</span>;
}

/** One demo band on the strip's own surface, carrying a real `TugPulse`. */
function Band({
  preset,
  pair,
  phase,
  legendAlign,
  truncate,
  activityWeight,
  rules,
  tight,
}: {
  preset?: TugPulsePreset;
  pair: Partial<PulsePair>;
  phase: number;
  legendAlign?: "cap-center" | "baseline";
  truncate?: "middle" | "end";
  /** Override the activity's weight — the knob, set at the mount site. */
  activityWeight?: number;
  /** Draw the declared baseline and the headline's visual middle. */
  rules?: boolean;
  /** Narrow the band so the activity has to give way. */
  tight?: boolean;
}): React.ReactElement {
  return (
    <div
      className={[
        "gpd-band",
        rules === true ? "gpd-band-ruled" : "",
        tight === true ? "gpd-band-tight" : "",
      ]
        .filter((c) => c.length > 0)
        .join(" ")}
    >
      <TugPulse
        preset={preset}
        legendAlign={legendAlign}
        truncate={truncate}
        style={
          activityWeight !== undefined
            ? ({
                "--tugx-pulse-activity-weight": activityWeight,
              } as React.CSSProperties)
            : undefined
        }
        legend={<Legend />}
        headline={pair.intent}
        activity={pair.activity}
        trailing={<DemoSpark phase={phase} />}
      />
    </div>
  );
}

/**
 * A Lens session row — the REAL {@link TugSessionRow}, with every part it
 * carries supplied by the real component the Lens supplies: the phase
 * indicator, the slot layout, and a sparkline. Only the strings and the series
 * are fixtures. So a row judged here is the row that ships; there is no gallery
 * drawing of one.
 *
 * The frame is the Lens rail at its usual width, and it declares the row knobs
 * `lens-cards-list` declares — the reading inset, the zeroed indicator
 * gutter, and the rail's trailing edge — so widths read here are widths the
 * Lens has.
 *
 * The row's own knobs are set to the Lens's answers for the same reason, and
 * they have to be set EXPLICITLY: the row defaults to the dense stack's
 * settings, which is right for the two surfaces that mount it through
 * `SessionIdentityRow` and wrong for the rail this frame is drawing. A gallery
 * specimen that took the defaults would be indented 28px where the Lens indents
 * 10, and the one surface that exists to keep the row from drifting would be
 * the drifted one.
 */
function SessionFrame({
  fixture,
  phase,
}: {
  fixture: SessionFixture;
  phase: number;
}): React.ReactElement {
  return (
    <div className="gpd-rail">
      <TugSessionRow
        indicator={
          <TugProgressIndicator
            variant="pulsing-dot"
            size={ROW_PHASE_DOT_SIZE}
            phase={fixture.phase}
            phaseVisual={sessionSessionPhaseVisual}
            aria-hidden
          />
        }
        // The size the indicator above was BUILT at, which is what the row
        // measures the title's leading by. Two numbers that have to agree —
        // the mount that ships states it once through `SessionIdentityRow`'s
        // `dotSize`; a direct mount states it twice or reads a title inset
        // corrected for a dot it isn't drawing.
        indicatorSize={ROW_PHASE_DOT_SIZE}
        // The rail's answer: outdented from the title, not flush with it. A
        // title inset measured off this 28px glyph is a wide indent to spend on
        // a column this narrow — which is the whole reason the knob exists.
        subAlign="edge"
        name={fixture.name}
        slots={<TugSlotLayout count={3} states={SLOT_STATES} size="sm" />}
        activity={fixture.activity}
        sparkline={
          <DemoSpark
            phase={phase}
            width={SPARK_ROW_WIDTH}
            height={SPARK_ROW_HEIGHT}
          />
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The density bake-off — measured, not asserted
// ---------------------------------------------------------------------------

/**
 * Sets the SAME machine string in every preset and measures the natural
 * width each one takes, reporting it against the mono baseline. The measure
 * runs after `document.fonts.ready`, because a face that has not loaded
 * measures as its fallback and would report a confident wrong number.
 *
 * Measurement writes straight to the DOM ([L06]): the readout is appearance
 * derived from layout, and routing it through React state would re-render
 * the very rows being measured.
 */
interface Specimen {
  /** Row label, and the measurement key. */
  key: string;
  preset: TugPulsePreset;
  /** Activity weight override, when the row is auditioning a cut. */
  weight?: number;
}

function DensityMeter({
  sample,
  specimens,
  baselineKey,
}: {
  sample: string;
  specimens: readonly Specimen[];
  /** The row every other row is reported against. */
  baselineKey: string;
}): React.ReactElement {
  const rowRefs = useRef(new Map<string, HTMLSpanElement>());
  const outRefs = useRef(new Map<string, HTMLSpanElement>());

  useEffect(() => {
    let live = true;
    const measure = (): void => {
      if (!live) return;
      const widths = new Map<string, number>();
      for (const [key, el] of rowRefs.current) {
        widths.set(key, el.getBoundingClientRect().width);
      }
      const base = widths.get(baselineKey);
      if (base === undefined || base === 0) return;
      for (const [key, width] of widths) {
        const out = outRefs.current.get(key);
        if (out === undefined) continue;
        const saved = Math.round((1 - width / base) * 100);
        out.textContent =
          key === baselineKey
            ? `${Math.round(width)}px — the baseline`
            : `${Math.round(width)}px — ${
                saved > 0 ? `${saved}% narrower` : `${-saved}% wider`
              }`;
      }
    };
    // Every specimen's OWN face, requested and awaited. `document.fonts.ready`
    // was the bug here: it resolved before any condensed face had been asked
    // for, so every condensed row reported the width of the Plex Sans fallback
    // — a uniform ~11% too wide, which read as a plausible-looking table and
    // was wrong in every cell.
    void Promise.all(
      [...rowRefs.current.values()].map((el) =>
        whenFaceLoaded(el, el.textContent ?? ""),
      ),
    ).then(measure);
    return () => {
      live = false;
    };
  }, [sample, baselineKey]);

  return (
    <div className="gpd-meter">
      {specimens.map(({ key, preset, weight }) => (
        <div className="gpd-meter-row" key={key}>
          <span className="gpd-preset-name">{key}</span>
          {/* Measured, so it must not be shortened: middle truncation would
              have this row reporting the width of a string it just cut down
              rather than the width the type actually asks for. */}
          <TugPulse
            className="gpd-meter-specimen"
            preset={preset}
            truncate="end"
            style={
              weight !== undefined
                ? ({
                    "--tugx-pulse-activity-weight": weight,
                  } as React.CSSProperties)
                : undefined
            }
            activity={
              <span
                ref={(el) => {
                  if (el !== null) rowRefs.current.set(key, el);
                }}
              >
                {sample}
              </span>
            }
          />
          <span
            className="gpd-meter-readout"
            ref={(el) => {
              if (el !== null) outRefs.current.set(key, el);
            }}
          />
        </div>
      ))}
    </div>
  );
}

/** The size ladder, all in regular — the axis the presets encode. */
const SIZE_SPECIMENS: readonly Specimen[] = TUG_PULSE_PRESETS.map((preset) => ({
  key: preset,
  preset,
}));

/** The weight axis at one size, measured through the same rig so the two
 *  tables can be read against each other. */
const WEIGHT_SPECIMENS: readonly Specimen[] = [
  { key: "machine", preset: "machine" },
  ...ACTIVITY_WEIGHTS.map(({ weight, name }) => ({
    key: name,
    preset: "condensed-sm" as TugPulsePreset,
    weight,
  })),
];

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export function GalleryPulseDisplay(): React.ReactElement {
  return (
    <div className="gpd-root" data-slot="gallery-pulse-display">
      <p className="gpd-blurb">
        The PULSE as a two-level feed: <strong>INTENT</strong> — the headline —
        over <strong>ACTIVITY</strong> — the operation running now. Every frame
        below is the real <code>TugPulse</code>, the same component the Z2 strip
        and the Lens row mount; the type rules live in <code>tug-pulse.css</code>{" "}
        and nowhere else, so tuning here is tuning what ships.
      </p>

      <TugSeparator />

      <Section
        title="Headline register — the copy doctrine"
        blurb="The intent is a newspaper headline. Drop definite and indefinite articles, cut filler verbs, omit needless words. The rewrite rule, applied:"
      >
        <div className="gpd-doctrine">
          {DOCTRINE.map((d) => (
            <div className="gpd-doctrine-row" key={d.after}>
              <span className="gpd-doctrine-before">{d.before}</span>
              <span className="gpd-doctrine-arrow" aria-hidden="true">
                →
              </span>
              <span className="gpd-doctrine-after">{d.after}</span>
            </div>
          ))}
        </div>
      </Section>

      <TugSeparator />

      <Section
        title="Density — the same string, measured in each proposal"
        blurb="Set width is the whole argument, so it is measured rather than claimed: one real machine string, set in every preset, reported against the mono baseline. Measured after the faces load."
      >
        <DensityMeter
          sample={LONG_PAIR.activity}
          specimens={SIZE_SPECIMENS}
          baselineKey="machine"
        />
      </Section>

      <TugSeparator />

      <Section
        title="Session card — the presets on the strip"
        blurb="Today's band geometry. The intent leads bright and layout-pinned; the activity trails past the › and is the run that gives way. A condensed rung sets BOTH runs at one size — 11, 12, or 13px — and separates them by weight and tone alone. The bar height, the baseline, and the legend hold across every rung."
      >
        {TUG_PULSE_PRESETS.map((preset, i) => (
          <div className="gpd-preset" key={preset}>
            <span className="gpd-preset-label">
              <span className="gpd-preset-name">{preset}</span>
              <span className="gpd-preset-blurb">{PRESET_BLURB[preset]}</span>
            </span>
            <Band preset={preset} pair={PAIRS[i]} phase={i + 1} />
          </div>
        ))}
      </Section>

      <TugSeparator />

      <Section
        title="Weight — the second run's cut, at one size"
        blurb={
          <>
            The ladder above sets the activity in Condensed{" "}
            <strong>regular</strong>. This is what the lighter cuts cost, all at
            11px under an 11px headline, so the weight is chosen on sight.
            Weight is doing the whole job of separating the two runs now that
            they share a face and a size — which is why the medium/regular pair
            has to carry, and does.
          </>
        }
      >
        <DensityMeter
          sample={LONG_PAIR.activity}
          specimens={WEIGHT_SPECIMENS}
          baselineKey="machine"
        />
        {ACTIVITY_WEIGHTS.map(({ weight, name }, i) => (
          <div className="gpd-preset" key={weight}>
            <span className="gpd-preset-label">
              <span className="gpd-preset-name">{name}</span>
              <span className="gpd-preset-blurb">
                {`Condensed medium 11px › Condensed ${name} 11px`}
              </span>
            </span>
            <Band
              preset="condensed-sm"
              activityWeight={weight}
              pair={PAIRS[i]}
              phase={i + 60}
            />
          </div>
        ))}
      </Section>

      <TugSeparator />

      <Section
        title="Overflow — the presets under pressure"
        blurb="One overlong activity, one width. The headline never truncates; where each preset's ellipsis falls is how much of the operation the reader actually gets."
      >
        {TUG_PULSE_PRESETS.map((preset, i) => (
          <div className="gpd-preset" key={preset}>
            <span className="gpd-preset-name">{preset}</span>
            <Band preset={preset} pair={LONG_PAIR} phase={i + 30} />
          </div>
        ))}
      </Section>

      <TugSeparator />

      <Section
        title="Lens — how the session row packs"
        blurb={
          <>
            A session row carries four things and has one rail&apos;s width to
            spend on them: the phase dot, the session&apos;s title, the layout
            slots, and the activity with its tape. The two text parts would
            rather not be cut; the rest is fixed-width furniture that takes its
            width off the top before the text gets any. There is no reorder
            handle among them — the row is carried by its own surface — so the
            content runs out to the rail&apos;s edge.
            <br />
            <br />
            The <code>inset</code> fit is what ships and the only one left: the
            dot rides the title line, so the lines beneath it start at the
            row&apos;s own inset and gain the whole leading column. Four other
            fits were auditioned here — <code>gutter</code>, <code>reveal</code>,{" "}
            <code>wash</code>, <code>duplex</code> — and retired with the
            audition. Both rows below are the real <code>TugSessionRow</code>:
            an everyday session, then the one that does not fit.
          </>
        }
      >
        <div className="gpd-lens-stack">
          <SessionFrame fixture={FIT_CALM} phase={10} />
          <SessionFrame fixture={FIT_PRESSURE} phase={70} />
        </div>
      </Section>

      <TugSeparator />

      <Section
        title="Stacked, two levels"
        blurb={
          <>
            The <code>stacked</code> layout renders a headline line above the
            activity when — and only when — its caller supplies one, and the two
            baselines are exactly{" "}
            <code>--tugx-pulse-stacked-baseline-step</code> apart. No session
            surface passes a headline: the description above the activity already
            says what a session is for, and a standing goal beside it read as an
            echo. The shape stays because it is the component&apos;s, not the
            row&apos;s — and this is where it is documented and measured.
          </>
        }
      >
        <div className="gpd-state">
          <span className="gpd-state-label">
            two levels, one declared step
          </span>
          <div className="gpd-rail">
            <TugPulse
              layout="stacked"
              headline={PAIRS[0].intent}
              activity={PAIRS[0].activity}
              trailing={<DemoSpark phase={44} />}
            />
          </div>
        </div>
        <div className="gpd-state">
          <span className="gpd-state-label">
            one level — no headline supplied, so no headline line and no
            reserved height (what every session surface wears)
          </span>
          <div className="gpd-rail">
            <TugPulse
              layout="stacked"
              activity={PAIRS[0].activity}
              trailing={<DemoSpark phase={45} />}
            />
          </div>
        </div>
      </Section>

      <TugSeparator />

      <Section
        title="The legend against the line"
        blurb={
          <>
            The general rule for a label sharing a line with text is the
            baseline. The PULSE is an exception to it: <code>PULSE</code> is an
            all-caps word beside a mixed-case headline nearly half again its
            size, and on the shared baseline its cap band hangs low — it reads
            as sitting <em>under</em> the line rather than on it. What the eye
            wants matched is the two glyph bands&apos; VISUAL CENTERS. The blue
            hairline is the declared baseline; the amber one is the headline&apos;s
            visual middle.
          </>
        }
      >
        <div className="gpd-state">
          <span className="gpd-state-label">
            cap-center — the label&apos;s middle on the headline&apos;s middle (the
            PULSE&apos;s rule, and the default)
          </span>
          <Band pair={PAIRS[4]} phase={40} legendAlign="cap-center" rules />
        </div>
        <div className="gpd-state">
          <span className="gpd-state-label">
            baseline — the general rule, shown so the exception can be seen as
            one
          </span>
          <Band pair={PAIRS[4]} phase={41} legendAlign="baseline" rules />
        </div>
      </Section>

      <TugSeparator />

      <Section
        title="Truncation — where the activity gives way"
        blurb={
          <>
            An activity is a command or a path, and both carry the part that
            identifies them at the END — the file being read, the test being
            run, the weights being fetched. An end ellipsis throws exactly that
            away and leaves a row of <code>https://huggingf…</code> that says
            nothing the next row does not also say. Cutting the middle keeps
            both: what is running, and what it is running on. The full string
            stays in the DOM either way, so a copy and a screen reader still get
            all of it.
          </>
        }
      >
        {[
          { label: "end — the CSS ellipsis", mode: "end" as const },
          { label: "middle — both ends survive (the default)", mode: "middle" as const },
        ].map(({ label, mode }) => (
          <div className="gpd-state" key={mode}>
            <span className="gpd-state-label">{label}</span>
            <Band pair={LONG_PAIR} phase={50} truncate={mode} tight />
            <Band
              pair={{ activity: PAIRS[2].activity }}
              phase={51}
              truncate={mode}
              tight
            />
          </div>
        ))}
      </Section>

      <TugSeparator />

      <Section
        title="States — the lifecycle in both layouts"
        blurb={
          <>
            <strong>Neither level is ever absent.</strong> A level with nothing
            to say holds its space and says so: the headline stands in with{" "}
            <code>PULSE</code>, the activity with <code>None</code>. So a
            stacked PULSE is always exactly two baseline steps tall, and a Lens
            row never changes height as its session comes and goes quiet.
            Inline, the legend is already saying <code>PULSE</code> beside the
            run, so the run stays empty rather than printing the word twice —
            the bar is a fixed height either way. Every stand-in is set exactly
            like the level it stands in for; there is no placeholder voice.
          </>
        }
      >
        <div className="gpd-state">
          <span className="gpd-state-label">Both levels live</span>
          <Band pair={PAIRS[2]} phase={20} />
        </div>
        <div className="gpd-state">
          <span className="gpd-state-label">
            No intent yet — turn just started, first overview pending
          </span>
          <Band pair={{ activity: "Grep tugdeck/src for pulse" }} phase={21} />
        </div>
        <div className="gpd-state">
          <span className="gpd-state-label">
            Intent held, activity idle — between operations
          </span>
          <Band pair={{ intent: PAIRS[1].intent }} phase={22} />
        </div>
        <div className="gpd-state">
          <span className="gpd-state-label">
            Before the session&apos;s first beat
          </span>
          <Band pair={{ intent: PAIRS[3].intent, activity: "None" }} phase={23} />
        </div>
        <div className="gpd-state">
          <span className="gpd-state-label">Turn done</span>
          <Band pair={{ intent: PAIRS[3].intent, activity: "Done" }} phase={24} />
        </div>
        <div className="gpd-state">
          <span className="gpd-state-label">
            Lens: the same row height whatever the session is doing — shown in
            the shipping fit
          </span>
          <div className="gpd-lens-stack">
            {LIFECYCLE_ROWS.map((fixture, i) => (
              <SessionFrame
                key={fixture.name}
                fixture={fixture}
                phase={i + 25}
              />
            ))}
          </div>
        </div>
      </Section>

      <TugSeparator />

      <Section
        title="Datatype — a chart as a glyph"
        blurb={
          <>
            Datatype&apos;s ligatures substitute a literal expression with a
            drawn mark: <code>{"{p:75}"}</code> is a pie, <code>{"{b:…}"}</code>{" "}
            a bar row, <code>{"{l:…}"}</code> a static sparkline. A mark costs
            what a word costs, so it fits where a chart cannot — but it cannot
            animate, which is why the activity tape stays{" "}
            <code>TugSparkline</code> and this is for quantities that stand
            still.
          </>
        }
      >
        <div className="gpd-chart-row">
          {[0, 12, 25, 40, 50, 66, 75, 88, 100].map((v) => (
            <span className="gpd-chart-cell" key={v}>
              <TugChartGlyph kind="pie" values={[v]} label={`${v} percent`} />
              <span className="gpd-chart-caption">{v}%</span>
            </span>
          ))}
        </div>

        <p className="gpd-blurb">
          The proposal: a work item&apos;s completion, inline in its own row —
          the quantity sits with the words instead of in a column beside them.
        </p>
        <div className="gpd-worklist">
          {[
            { name: "Pulse componentization", done: 5, total: 6 },
            { name: "Proportional activity run", done: 3, total: 4 },
            { name: "Condensed weights vendored", done: 2, total: 2 },
            { name: "Lens rollout", done: 1, total: 5 },
          ].map((w) => {
            const pct = Math.round((w.done / w.total) * 100);
            return (
              <div className="gpd-work-row" key={w.name}>
                <TugChartGlyph
                  kind="pie"
                  values={[pct]}
                  label={`${w.done} of ${w.total} done`}
                />
                <span className="gpd-work-name">{w.name}</span>
                <span className="gpd-work-count">
                  {w.done}/{w.total}
                </span>
              </div>
            );
          })}
        </div>

        <p className="gpd-blurb">
          The other two marks, for reference. The bar row reads a distribution;
          the line is a frozen series — a shape to compare against, not a live
          one.
        </p>
        <div className="gpd-chart-row">
          <span className="gpd-chart-cell">
            <TugChartGlyph
              kind="bar"
              values={[15, 45, 80, 30, 60, 90, 20]}
              label="Bar chart of seven values"
            />
            <span className="gpd-chart-caption">bar</span>
          </span>
          <span className="gpd-chart-cell">
            <TugChartGlyph
              kind="line"
              values={[20, 45, 60, 55, 80, 95, 70, 88]}
              label="Sparkline of eight values"
            />
            <span className="gpd-chart-caption">line</span>
          </span>
        </div>
      </Section>
    </div>
  );
}
