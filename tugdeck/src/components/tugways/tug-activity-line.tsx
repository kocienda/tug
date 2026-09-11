/**
 * TugActivityLine — the beat's ACTIVITY reading: the operation running now, set on
 * its own line with a trailing accessory past it.
 *
 * The component owns the typography and the geometry — face, size, weight,
 * tracking, the declared baseline, the stacked leading — and nothing else.
 * Mount sites supply content: the string and a trailing accessory (the
 * activity sparkline). They contribute no type rules of their own, so the
 * masthead and the Cards card row cannot drift apart, and a change made once
 * in `tug-activity-line.css` lands on both.
 *
 * One level, one layout. The HEADLINE level — the session's standing goal,
 * with its `›` separator, its pinned/give-way widths and its `inline` bar —
 * is gone: [D132] retired the headline chain, the written sentence above the
 * line replaced it, and no surface rendered either. The preset ladder went
 * with them; its shipping rung is the CSS's own numbers now.
 *
 * The component's one typographic rule of its own is an exception to a
 * general one: the activity truncates in the MIDDLE, not at the end — a
 * command identifies itself at the head and names what it acts on at the
 * tail, and an end ellipsis throws the second away (see
 * {@link useMiddleTruncation}).
 *
 * Laws: [L06] appearance is CSS and data attributes, never React state;
 *       [L16] every color rule declares its rendering surface;
 *       [L19] `.tsx`/`.css` pair, `data-slot="tug-activity-line"`;
 *       [L20] the accessory is the caller's own component, and keeps its own
 *       tokens.
 *
 * @module components/tugways/tug-activity-line
 */

import "./tug-activity-line.css";

import React from "react";

import { textMeasurer, whenFaceLoaded } from "@/lib/font-metrics";
import { cn } from "@/lib/utils";

/**
 * What the activity level says when it has nothing to say. The level ALWAYS
 * renders, so the band occupies the same space whether or not the session it
 * reports on has an operation running yet.
 *
 * Ordinary content, set exactly like the run it stands in for: a lifecycle word
 * wearing its own weight or tone would be the reader's one inconsistent run.
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

export interface TugActivityLineProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children"> {
  /**
   * Where the activity gives way when it does not fit. `middle` keeps both
   * ends of the string — what is running and what it is running on; `end` is
   * the plain CSS ellipsis.
   * @selector [data-truncated="true"]
   * @default "middle"
   */
  truncate?: "middle" | "end";
  /**
   * The operation running now. Omitting it does not drop the level — the run
   * reads `None`, set exactly like any other activity string.
   */
  activity?: React.ReactNode;
  /** Trailing accessory — the activity sparkline, or its popover trigger. */
  trailing?: React.ReactNode;
  /**
   * Props for the element wrapping the run. The gesture surface for anything
   * that acts on the reading as a whole — a right-click copy hangs its ref and
   * handler here, so the copy target is the text and not the sparkline beside
   * it.
   */
  stageProps?: React.ComponentProps<"span">;
}

export const TugActivityLine = React.forwardRef<HTMLDivElement, TugActivityLineProps>(
  function TugActivityLine(
    {
      truncate = "middle",
      activity,
      trailing,
      stageProps,
      className,
      ...rest
    },
    ref,
  ) {
    // The ACTIVITY level is never absent: a line with nothing to say holds its
    // space and says so, because an activity line that drops it changes the height of the
    // row carrying it — and rows must not resize themselves midstream as
    // sessions come and go quiet.
    const activityNode =
      activity !== undefined && activity !== null ? activity : ACTIVITY_FALLBACK;
    return (
      <div
        ref={ref}
        data-slot="tug-activity-line"
        className={cn("tug-activity-line", className)}
        {...rest}
      >
        <span className="tug-activity-line-line">
          <Run activity={activityNode} truncate={truncate} stageProps={stageProps} />
          <span className="tug-activity-line-trailing">{trailing}</span>
        </span>
      </div>
    );
  },
);

/* ---------------------------------------------------------------------------
 * Run — the activity on its line
 * ---------------------------------------------------------------------------*/

/** The activity, in the stage element the caller hangs its gestures on. */
function Run({
  activity,
  truncate,
  stageProps,
}: {
  activity: React.ReactNode;
  truncate: "middle" | "end";
  stageProps?: React.ComponentProps<"span">;
}): React.ReactElement {
  const { className: stageClassName, ...stageRest } = stageProps ?? {};
  return (
    <span className={cn("tug-activity-line-stage", stageClassName)} {...stageRest}>
      <ActivityRun truncate={truncate}>{activity}</ActivityRun>
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
      className="tug-activity-line-run tug-activity-line-activity"
      data-slot="tug-activity-line-activity"
    >
      <span className="tug-activity-line-activity-full">{children}</span>
      <span className="tug-activity-line-activity-clipped" aria-hidden="true" />
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
    const full = run.querySelector<HTMLElement>(".tug-activity-line-activity-full");
    const clipped = run.querySelector<HTMLElement>(
      ".tug-activity-line-activity-clipped",
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
      run.querySelector<HTMLElement>(".tug-activity-line-activity-full")?.textContent ??
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
