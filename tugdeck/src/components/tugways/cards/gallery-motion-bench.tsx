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
 */

import "./gallery-motion-bench.css";

import React from "react";
import { createPortal } from "react-dom";

import {
  TugProgressIndicator,
  type TugProgressIndicatorVariant,
} from "@/components/tugways/tug-progress-indicator";

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
 * Chosen so the shipped pulsing dot — four `@keyframes` loops per running
 * glyph — puts 400 long-running animations on the page, comfortably above the
 * noise floor of a `sample` run while still laying out inside one card. The
 * absolute number does not matter; holding it still across runs is the whole
 * point of the file.
 */
const BENCH_COUNT = 100;

/** The size the Cards card actually asks for, so the bench measures a real glyph. */
const BENCH_SIZE = 28;

/** Which glyph the bench populates — one variant at a time, by design. */
const BENCH_VARIANT: TugProgressIndicatorVariant = "bar";

const CELLS = Array.from({ length: BENCH_COUNT }, (_, i) => i);

export function GalleryMotionBench(): React.ReactElement {
  const dots = (
    <div className={ESCAPE_THE_CARD ? "gmb-content gmb-escaped" : "gmb-content"}>
      {CELLS.map((i) => (
        <TugProgressIndicator
          key={i}
          variant={BENCH_VARIANT}
          size={BENCH_SIZE}
          state="running"
        />
      ))}
    </div>
  );
  return ESCAPE_THE_CARD ? createPortal(dots, document.body) : dots;
}
