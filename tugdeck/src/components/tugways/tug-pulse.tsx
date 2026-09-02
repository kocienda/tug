/**
 * TugPulse — the PULSE's two-level reading: a HEADLINE (the session's
 * standing goal) over an ACTIVITY (the operation running now).
 *
 * The component owns the typography and the geometry — face, size, weight,
 * tracking, the one shared baseline, the stacked leading — and nothing
 * else. Mount sites supply content: the legend node, the two strings, and a
 * trailing accessory (the activity sparkline). They contribute no type
 * rules of their own, so the Z2 strip and the Cards card row cannot drift apart,
 * and a change made once in `tug-pulse.css` lands on both.
 *
 * Two layouts, one contract:
 *  - `inline` — the Z2 strip: legend, headline, `›`, activity, accessory,
 *    on one fixed-height bar. The headline is pinned; the activity is the
 *    run that ellipsizes.
 *  - `stacked` — the session row: the activity on its own line with the
 *    accessory past it, and a headline line above it only when the caller
 *    supplies one. The session surfaces supply none.
 *
 * Presets ({@link TugPulsePreset}) are complete typographic proposals for
 * the pair, differing only in the knobs `tug-pulse.css` declares. Adopting
 * one everywhere is a one-word change to {@link TUG_PULSE_DEFAULT_PRESET}.
 *
 * Two of the component's rules are the PULSE's own, and both are exceptions
 * to a general one:
 *  - the legend is aligned by VISUAL CENTER, not by baseline — an all-caps
 *    label beside a much larger mixed-case headline reads low on the shared
 *    baseline (see the `cap-center` rules in the CSS);
 *  - the activity truncates in the MIDDLE, not at the end — a command
 *    identifies itself at the head and names what it acts on at the tail,
 *    and an end ellipsis throws the second away (see
 *    {@link useMiddleTruncation}).
 *
 * Laws: [L06] appearance is CSS and data attributes, never React state;
 *       [L16] every color rule declares its rendering surface;
 *       [L19] `.tsx`/`.css` pair, `data-slot="tug-pulse"`;
 *       [L20] the legend and the accessory are the caller's own components,
 *       and keep their own tokens.
 *
 * @module components/tugways/tug-pulse
 */

import "./tug-pulse.css";

import React from "react";

import { textMeasurer, whenFaceLoaded } from "@/lib/font-metrics";
import { cn } from "@/lib/utils";

/** Which arrangement of the pair to render. */
export type TugPulseLayout = "inline" | "stacked";

/**
 * How the legend sits against the runs beside it. `cap-center` matches the
 * label's visual middle to the headline's — the PULSE's own rule, and a
 * deliberate exception to the general one, which is `baseline`.
 */
export type TugPulseLegendAlign = "cap-center" | "baseline";

/**
 * A complete typographic proposal for the pair: `machine` (the mono
 * baseline, kept to measure against) and the condensed ladder, which is one
 * face at one size per rung — 11, 12, 13px — with the two runs separating by
 * weight rather than by measure. See the preset blocks in `tug-pulse.css`.
 */
export type TugPulsePreset =
  | "machine"
  | "condensed-sm"
  | "condensed"
  | "condensed-lg";

/** Every preset, in the order the gallery auditions them. */
export const TUG_PULSE_PRESETS: readonly TugPulsePreset[] = [
  "machine",
  "condensed-sm",
  "condensed",
  "condensed-lg",
];

/**
 * The preset every PULSE wears unless its mount site says otherwise.
 * Changing this line changes the Z2 strip and the Cards card together.
 */
export const TUG_PULSE_DEFAULT_PRESET: TugPulsePreset = "condensed";

/** The divider between the two levels — directional, reading "into detail". */
const SEPARATOR = "›";

/**
 * What the activity level says when it has nothing to say. The level ALWAYS
 * renders, so the band occupies the same space whether or not the session it
 * reports on has an operation running yet.
 *
 * Ordinary content, set exactly like the run it stands in for: a lifecycle word
 * wearing its own weight or tone would be the reader's one inconsistent run.
 *
 * The HEADLINE level has no stand-in. It used to print the word `PULSE` where no
 * goal had been composed — a placeholder holding a line's height, which is a job
 * that no longer exists: the level renders only when a caller supplies one, and
 * no session surface does. `PULSE` is an internal name now, never ink a reader
 * sees ([D132]); `lib/__tests__/pulse-ink-gate.test.ts` is what keeps it out.
 */
const ACTIVITY_FALLBACK = "None";

/** What a middle truncation puts between the two surviving ends. */
const ELLIPSIS = "…";

/**
 * How much of a middle-truncated activity goes to the head. A command reads
 * left to right and identifies itself early, but the thing it acts on — the
 * file, the test, the artifact — is at the tail, so the split leans only
 * slightly toward the head rather than halving.
 */
const HEAD_FRACTION = 0.55;

/**
 * The fewest characters an ellipsis may stand in for. Standing in for one is
 * not a truncation — it is a stray mark dropped mid-word to buy a pixel. Below
 * this the run keeps its full text and lets the CSS ellipsis handle the
 * overrun, which at that margin is a character or two off the end.
 */
const MIN_ELIDED = 3;

export interface TugPulseProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children"> {
  /**
   * Arrangement of the pair.
   * @selector [data-layout="inline"] | [data-layout="stacked"]
   * @default "inline"
   */
  layout?: TugPulseLayout;
  /**
   * Typographic preset.
   * @selector [data-preset="<preset>"]
   * @default TUG_PULSE_DEFAULT_PRESET
   */
  preset?: TugPulsePreset;
  /**
   * How the legend sits against the runs.
   * @selector [data-legend-align="cap-center"] | [data-legend-align="baseline"]
   * @default "cap-center"
   */
  legendAlign?: TugPulseLegendAlign;
  /**
   * Where the activity gives way when it does not fit. `middle` keeps both
   * ends of the string — what is running and what it is running on; `end` is
   * the plain CSS ellipsis.
   * @selector [data-truncated="true"]
   * @default "middle"
   */
  truncate?: "middle" | "end";
  /**
   * WHICH run gives way on a short `inline` bar.
   *
   *  - `activity` — the headline is pinned and the activity is the only run
   *    that shortens. Right where the bar is the width of a card: the goal is
   *    the reading, and it is never worth cutting.
   *  - `both` — the headline yields too, up to a share of the bar. The mode
   *    for a bar as narrow as a list row, where a pinned headline can eat the
   *    line and leave the activity a few pixels: a run that has been shortened
   *    to nothing says less than a shortened run of each.
   *
   * Inert in the `stacked` layout, where the runs are on separate lines and
   * never compete.
   * @selector [data-give-way="activity"] | [data-give-way="both"]
   * @default "activity"
   */
  giveWay?: "activity" | "both";
  /**
   * The label that names the band. Rendered in the `inline` layout only.
   * Supplied whole by the caller, which owns its behavior (popover trigger,
   * focus registration) and its own tokens.
   *
   * No production surface passes one: the Z2 strip it belonged to is retired, and
   * a band that names itself is furniture where a sentence belongs ([D132]). The
   * shape stays because it is the component's, and the gallery is where it is
   * documented and where its cap-center alignment rule is measured.
   */
  legend?: React.ReactNode;
  /**
   * The standing goal. In the `stacked` layout, omitting it drops the level
   * entirely — a mount either has a goal to state or it does not, and no mount's
   * height varies with whether one arrived. The `inline` bar is a fixed height
   * either way and keeps the run's place.
   */
  headline?: React.ReactNode;
  /**
   * The operation running now. Omitting it does not drop the level either —
   * the run reads `None`, set exactly like any other activity string.
   */
  activity?: React.ReactNode;
  /** Trailing accessory — the activity sparkline, or its popover trigger. */
  trailing?: React.ReactNode;
  /**
   * Props for the element wrapping the two runs. The gesture surface for
   * anything that acts on the reading as a whole — the strip's right-click
   * copy hangs its ref and handler here, so the copy target is the text and
   * not the legend or the sparkline beside it.
   */
  stageProps?: React.ComponentProps<"span">;
}

export const TugPulse = React.forwardRef<HTMLDivElement, TugPulseProps>(
  function TugPulse(
    {
      layout = "inline",
      preset = TUG_PULSE_DEFAULT_PRESET,
      legendAlign = "cap-center",
      truncate = "middle",
      giveWay = "activity",
      legend,
      headline,
      activity,
      trailing,
      stageProps,
      className,
      ...rest
    },
    ref,
  ) {
    // The ACTIVITY level is never absent: a line with nothing to say holds its
    // space and says so, because a PULSE that drops it changes the height of the
    // row carrying it — and rows must not resize themselves midstream as
    // sessions come and go quiet.
    //
    // The HEADLINE level is the caller's choice. A mount that passes one always
    // passes one, and a mount that does not never does, so no mount's height
    // varies with its content either way. The stacked mounts pass none: the
    // description above the activity already says what a session is for, and a
    // standing goal beside it read as an echo ([D132]).
    const hasHeadline = headline !== undefined && headline !== null;
    const activityNode =
      activity !== undefined && activity !== null ? activity : ACTIVITY_FALLBACK;
    const root = (
      children: React.ReactNode,
    ): React.ReactElement => (
      <div
        ref={ref}
        data-slot="tug-pulse"
        className={cn("tug-pulse", className)}
        data-layout={layout}
        data-preset={preset}
        data-legend-align={legendAlign}
        data-give-way={giveWay}
        {...rest}
      >
        {children}
      </div>
    );

    if (layout === "stacked") {
      // One baseline step per level the caller asked for. The accessory rides
      // the activity line, which is always the last one.
      return root(
        <>
          {hasHeadline ? (
            <span className="tug-pulse-line">
              <Runs
                headline={headline}
                activity={undefined}
                truncate={truncate}
              />
            </span>
          ) : null}
          <span className="tug-pulse-line">
            <Runs
              headline={undefined}
              activity={activityNode}
              truncate={truncate}
              stageProps={stageProps}
            />
            <span className="tug-pulse-trailing">{trailing}</span>
          </span>
        </>,
      );
    }

    return root(
      <>
        <span className="tug-pulse-lead">
          {legend !== undefined && legend !== null ? (
            <span className="tug-pulse-legend">{legend}</span>
          ) : null}
          <Runs
            headline={headline}
            activity={activityNode}
            truncate={truncate}
            stageProps={stageProps}
          />
        </span>
        {trailing !== undefined && trailing !== null ? (
          <span className="tug-pulse-trailing">{trailing}</span>
        ) : null}
      </>,
    );
  },
);

/* ---------------------------------------------------------------------------
 * Runs — the two levels on one baseline
 * ---------------------------------------------------------------------------*/

/** The headline, the separator, and the activity — whichever exist. The
 *  separator appears only between two present runs. */
function Runs({
  headline,
  activity,
  truncate,
  stageProps,
}: {
  headline: React.ReactNode;
  activity: React.ReactNode;
  truncate: "middle" | "end";
  stageProps?: React.ComponentProps<"span">;
}): React.ReactElement {
  const hasHeadline = headline !== undefined && headline !== null;
  const hasActivity = activity !== undefined && activity !== null;
  const { className: stageClassName, ...stageRest } = stageProps ?? {};
  return (
    <span
      className={cn("tug-pulse-stage", stageClassName)}
      {...stageRest}
    >
      {hasHeadline ? (
        <span
          className="tug-pulse-run tug-pulse-headline"
          data-slot="tug-pulse-headline"
        >
          {headline}
        </span>
      ) : null}
      {hasHeadline && hasActivity ? (
        <span className="tug-pulse-sep" aria-hidden="true">
          {SEPARATOR}
        </span>
      ) : null}
      {hasActivity ? (
        <ActivityRun truncate={truncate}>{activity}</ActivityRun>
      ) : null}
    </span>
  );
}

/* ---------------------------------------------------------------------------
 * ActivityRun — the run that gives way, and how
 * ---------------------------------------------------------------------------*/

/**
 * The activity, carrying both readings of itself: the full one as given
 * (markup and all), and a shortened one written by {@link useMiddleTruncation}
 * when the full one does not fit. Which is visible is a data attribute; both
 * stay in the DOM, so the accessibility tree and a text copy always see the
 * whole string.
 */
function ActivityRun({
  truncate,
  children,
}: {
  truncate: "middle" | "end";
  children: React.ReactNode;
}): React.ReactElement {
  const runRef = React.useRef<HTMLSpanElement | null>(null);
  useMiddleTruncation(runRef, truncate === "middle");
  return (
    <span
      ref={runRef}
      className="tug-pulse-run tug-pulse-activity"
      data-slot="tug-pulse-activity"
    >
      <span className="tug-pulse-activity-full">{children}</span>
      <span className="tug-pulse-activity-clipped" aria-hidden="true" />
    </span>
  );
}

/**
 * Measures the activity against the width it was given and, when it overruns,
 * writes a middle-truncated version of its text into the clipped span and
 * flips `data-truncated` — the run's appearance changes by attribute and CSS
 * ([L06]), never through React state.
 *
 * The measurement runs on the real face via a canvas, not by trial layout, so
 * the binary search costs nothing in reflow. It re-runs when the text changes
 * and when the width does (a `ResizeObserver` on the run's parent — the
 * parent, because the run itself shrinks to whatever it was just given and
 * would observe its own answer).
 *
 * Order matters at both ends: nothing is measured until the run's OWN face has
 * loaded — an unloaded face measures as its fallback and would truncate to the
 * wrong length, and `document.fonts.ready` does not promise that (see
 * `lib/font-metrics.ts`) — and every pass restores the full text before
 * reading, so the width it reads is the space available rather than the space
 * last taken.
 */
function useMiddleTruncation(
  runRef: React.RefObject<HTMLSpanElement | null>,
  enabled: boolean,
): void {
  const lastTextRef = React.useRef<string | null>(null);

  const measure = React.useCallback((): void => {
    const run = runRef.current;
    if (run === null) return;
    const full = run.querySelector<HTMLElement>(".tug-pulse-activity-full");
    const clipped = run.querySelector<HTMLElement>(
      ".tug-pulse-activity-clipped",
    );
    if (full === null || clipped === null) return;

    const text = full.textContent ?? "";
    lastTextRef.current = text;
    if (!enabled || text.length === 0) {
      delete run.dataset.truncated;
      return;
    }

    // Read the budget with the FULL text showing: the run is a shrinkable
    // flex item, so in that state it occupies exactly the width it can have.
    delete run.dataset.truncated;
    const budget = run.clientWidth;
    if (budget === 0 || run.scrollWidth <= budget + 0.5) return;

    const width = textMeasurer(run);
    if (width === null) return;
    const keep = longestFit(text, budget, width);
    if (keep === null || text.length - keep < MIN_ELIDED) return;
    clipped.textContent = compose(text, keep);
    run.dataset.truncated = "true";
  }, [runRef, enabled]);

  // Text changes arrive as renders; width changes arrive from the observer.
  // Comparing the text first keeps an unrelated re-render from forcing the
  // synchronous layout `measure` reads.
  React.useEffect(() => {
    const run = runRef.current;
    if (run === null) return;
    const text =
      run.querySelector<HTMLElement>(".tug-pulse-activity-full")?.textContent ??
      "";
    if (text === lastTextRef.current) return;
    void whenFaceLoaded(run, text).then(measure);
  });

  React.useEffect(() => {
    const run = runRef.current;
    const parent = run?.parentElement;
    if (run === undefined || run === null) return;
    if (parent === undefined || parent === null) return;
    const observer = new ResizeObserver(() => {
      measure();
    });
    observer.observe(parent);
    void whenFaceLoaded(run, run.textContent ?? "").then(measure);
    return () => {
      observer.disconnect();
    };
  }, [runRef, measure]);
}

/** `keep` of `text`'s characters around an ellipsis, split by head fraction. */
function compose(text: string, keep: number): string {
  const head = Math.ceil(keep * HEAD_FRACTION);
  return (
    text.slice(0, head) + ELLIPSIS + text.slice(text.length - (keep - head))
  );
}

/**
 * How many of `text`'s characters can survive around an ellipsis within
 * `budget`, or null if even the bare ellipsis will not fit. Binary search —
 * the width function is a canvas measure, so a probe costs no layout.
 */
function longestFit(
  text: string,
  budget: number,
  width: (s: string) => number,
): number | null {
  if (width(ELLIPSIS) > budget) return null;
  let lo = 0;
  let hi = text.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (width(compose(text, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
