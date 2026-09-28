/**
 * gallery-motion-bench.tsx — a pinned population of one glyph, for the profiler.
 *
 * This card is an instrument, not a showcase. Every other gallery is edited for
 * what it teaches, which means the number of moving things on it changes
 * whenever someone improves the prose — and a profile taken against a moving
 * population cannot be compared to the one before it. Consolidating the
 * TugProgressIndicator gallery took its pulsing-dot count from 40 to 15 in a
 * single commit, which silently invalidated every number measured against it.
 *
 * So the population here is a constant. {@link BENCH_COUNT} dots, all
 * `running`, all one size, no drift, and nothing else on the card that moves —
 * no captions that transition, no pickers, no separators carrying a shimmer.
 * A/B one thing in the glyph, re-profile, and the delta means what it says.
 *
 * Usage:
 *
 *     just app-debug                      # or leave the debug instance running
 *     tugtool host tell show-card -p component=gallery-motion-bench …
 *     just perf-resize-profile idle 6
 *
 * Read `applyKeyframeEffects` and `Style::TreeResolver::resolve` from the
 * verdict. Those are the frames that scale with the count of animations
 * WebKit is blending on the main thread; if the glyph's motion were
 * compositor-resident they would not move when {@link BENCH_COUNT} does.
 * The window must be raised — an occluded window throttles to a flat 0%.
 *
 * ## Two hosts
 *
 * The population can be laid out two ways, and the difference is the whole
 * subject of the off-screen rule. The **flow** host is the original: a
 * wrapping flex row inside the card, clipped by the pane's own `overflow`.
 * The **list** host stands the same population one glyph to a row inside a
 * `TugListView` scroller — the primitive every transcript and picker in the
 * deck scrolls in — so nearly all of it is out of the scroller's view at
 * rest. That is the placement the Overview card's session marks were found in
 * (hundreds of dots under a scroller's fold, each dirtying style every frame),
 * and it is the placement the mechanism bench reads. The list host can
 * additionally ask the primitive for `offscreenSkip` (`content-visibility:
 * auto` on every measured row), which is the declarative candidate for the
 * same rule, so the two mechanisms can be read against one population.
 */

import "./gallery-motion-bench.css";

import React from "react";
import { createPortal } from "react-dom";

import {
  TugProgressIndicator,
  type TugProgressIndicatorVariant,
} from "@/components/tugways/tug-progress-indicator";
import {
  TugListView,
  type TugListViewCellProps,
  type TugListViewCellRenderer,
  type TugListViewDataSource,
} from "@/components/tugways/tug-list-view";

/**
 * Render the population OUTSIDE the card, in a fixed layer parented to
 * `<body>`.
 *
 * A diagnostic switch, not a feature. Every card in the deck sits inside
 * `.tug-pane`, which carries `border-radius` + `overflow: clip` — a rounded
 * clip. The question this answers is whether that clip is what keeps the
 * glyph's animations off the compositor, by measuring the identical population
 * with the identical glyph and only the ancestor chain changed.
 */
const ESCAPE_THE_CARD = false;

/**
 * How many glyphs the bench runs.
 *
 * Chosen so the shipped pulsing dot — three `@keyframes` loops per running
 * glyph — puts 900 long-running animations on the page, comfortably above the
 * noise floor of a `sample` run. The absolute number does not matter; holding
 * it still across runs is the whole point of the file.
 *
 * It was 100 until the render-cost budget was calibrated against it. At that
 * population the deliberately-broken reading (`__tugMotion.__force`, a
 * per-frame inline transform write) came in at a p50 of 6 ms against a quiet
 * p95 of 5 — a gap the gauge could not be trusted to discriminate, and the one
 * finding that says the bench was too small to calibrate against rather than
 * that the budget was wrong. Tripling it separates the two readings, because
 * the forced frame pays for a whole-page compositing walk that scales with the
 * population and the quiet frame pays for nothing that does.
 */
const BENCH_COUNT = 300;

/** The size the Cards card actually asks for, so the bench measures a real glyph. */
const BENCH_SIZE = 28;

/**
 * Which glyph the bench populates by default — one variant at a time, by
 * design. A caller names another with the `variant` prop; the registry mounts
 * a `pulsing-dot` bench under its own component id, which is the population
 * the motion tripwire measures against.
 */
const BENCH_VARIANT: TugProgressIndicatorVariant = "bar";

/** How the population is laid out. See the file header. */
export type GalleryMotionBenchHost = "flow" | "list";

export interface GalleryMotionBenchProps {
  /** @default {@link BENCH_VARIANT} */
  variant?: TugProgressIndicatorVariant;
  /** @default "flow" */
  host?: GalleryMotionBenchHost;
  /**
   * Under the `list` host, ask the primitive to skip rows out of view with
   * `content-visibility: auto` (`TugListView.offscreenSkip`). Ignored by the
   * `flow` host.
   *
   * @default false
   */
  offscreenSkip?: boolean;
}

const CELLS = Array.from({ length: BENCH_COUNT }, (_, i) => i);

/**
 * The list host's rows: one glyph each, nothing that changes. A static data
 * source — the version never moves, so the list never re-windows.
 */
class BenchDataSource implements TugListViewDataSource {
  numberOfItems(): number {
    return BENCH_COUNT;
  }
  idForIndex(index: number): string {
    return `dot-${index}`;
  }
  kindForIndex(): string {
    return "dot";
  }
  subscribe(): () => void {
    return () => {};
  }
  getVersion(): unknown {
    return BENCH_COUNT;
  }
}

const BENCH_DATA_SOURCE = new BenchDataSource();

function makeCell(
  variant: TugProgressIndicatorVariant,
): TugListViewCellRenderer<BenchDataSource> {
  return function BenchCell(_props: TugListViewCellProps<BenchDataSource>) {
    return (
      <div className="gmb-row">
        <TugProgressIndicator
          variant={variant}
          size={BENCH_SIZE}
          state="running"
        />
      </div>
    );
  };
}

export function GalleryMotionBench({
  variant = BENCH_VARIANT,
  host = "flow",
  offscreenSkip = false,
}: GalleryMotionBenchProps = {}): React.ReactElement {
  const cellRenderers = React.useMemo(
    () => ({ dot: makeCell(variant) }),
    [variant],
  );
  if (host === "list") {
    return (
      <div className="gmb-list" data-offscreen-skip={offscreenSkip || undefined}>
        <TugListView<BenchDataSource>
          dataSource={BENCH_DATA_SOURCE}
          cellRenderers={cellRenderers}
          scrollKey="gallery-motion-bench"
          inline
          offscreenSkip={offscreenSkip}
          interactive={false}
        />
      </div>
    );
  }
  const dots = (
    <div className={ESCAPE_THE_CARD ? "gmb-content gmb-escaped" : "gmb-content"}>
      {CELLS.map((i) => (
        <TugProgressIndicator
          key={i}
          variant={variant}
          size={BENCH_SIZE}
          state="running"
        />
      ))}
    </div>
  );
  return ESCAPE_THE_CARD ? createPortal(dots, document.body) : dots;
}
