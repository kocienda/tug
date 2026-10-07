/**
 * spike-progress-glyph.tsx — what glyph should lead a running Bash block's
 * live progress line?
 *
 * Today `BashLiveBand` borrows the notice band's `info` tone, so the line
 * leads with lucide's (i) in the theme's warm accent — a "here is a note"
 * mark, in a color that fights the header's blue running dot. The proposal
 * is a glyph that says what the line is: a 14px `TugProgressIndicator` ring
 * in the running dot's own role (`action`), filled to `done / total`, falling
 * back to a spinner when the report carries no total.
 *
 * Every glyph here rides the real `BlockNoticeBand` through its `icon`
 * override, inside a real `BlockChrome`, so the column, the line box, and
 * the hairline are production's. The ticks come from a small external
 * store read through `useSyncExternalStore` ([L02]).
 */

import "./spike.css";
import "./spike-progress-glyph.css";

import React, { useSyncExternalStore } from "react";

import { BlockChrome } from "@/components/tugways/blocks/block-chrome";
import { BlockNoticeBand } from "@/components/tugways/blocks/block-notice";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { formatRunProgressLine, type RunProgress } from "@/lib/run-progress-store";

import type { SpikeDef } from "./spike-registry";

/** The header lifecycle dot's diameter — the glyph shares its column. */
const GLYPH_SIZE = 14;

/** The run the screenshot caught: a nextest sweep near its end. */
const TOTAL = 4516;
const TEST_NAMES = [
  "tugtool::bin/tugtool arc::commit::records_round",
  "tugcore::ledger_db::opens_read_only",
  "tugcast::session_index::writes_on_spawn",
  "tugchanges_core::shell_ops::heredoc_unreadable",
  "tugarc_core::worktree::join_removes_branch",
];

// ---------------------------------------------------------------------------
// A ticking store — one interval, live only while something subscribes.
// ---------------------------------------------------------------------------

function createTicker(periodMs: number) {
  let tick = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (timer === null) {
        timer = setInterval(() => {
          tick += 1;
          for (const l of listeners) l();
        }, periodMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    getSnapshot(): number {
      return tick;
    },
  };
}

const ticker = createTicker(120);

function useTick(): number {
  return useSyncExternalStore(ticker.subscribe, ticker.getSnapshot);
}

/** A simulated report: climbs to `TOTAL` in ~12 s, holds a beat, restarts. */
function simulatedProgress(tick: number, withTotal: boolean): RunProgress {
  const cycle = 110;
  const step = tick % cycle;
  const done = Math.min(TOTAL, Math.round((step / (cycle - 10)) * TOTAL));
  return {
    toolUseId: null,
    label: "rust",
    done,
    ...(withTotal ? { total: TOTAL } : {}),
    text: TEST_NAMES[Math.floor(tick / 6) % TEST_NAMES.length],
  };
}

// ---------------------------------------------------------------------------
// The glyphs under comparison
// ---------------------------------------------------------------------------

type GlyphKind = "today" | "ring" | "spinner" | "ring-indeterminate" | "pie";

function Glyph({
  kind,
  progress,
}: {
  kind: GlyphKind;
  progress: RunProgress;
}): React.ReactElement | undefined {
  switch (kind) {
    case "today":
      return undefined; // the band's own default for `tone="info"`
    case "ring":
    case "pie":
      return (
        <TugProgressIndicator
          variant={kind}
          size={GLYPH_SIZE}
          role="action"
          state="running"
          value={progress.done}
          max={progress.total}
          aria-label="Progress"
        />
      );
    case "ring-indeterminate":
      return (
        <TugProgressIndicator
          variant="ring"
          size={GLYPH_SIZE}
          role="action"
          state="running"
          aria-label="Running"
        />
      );
    case "spinner":
      return (
        <TugProgressIndicator
          variant="spinner"
          size={GLYPH_SIZE}
          role="action"
          state="running"
          aria-label="Running"
        />
      );
  }
}

/** The proposal: a ring when the report has a total, a spinner when not. */
function proposedKind(progress: RunProgress): GlyphKind {
  return progress.total !== undefined ? "ring" : "spinner";
}

function LiveBlock({
  command,
  kind,
  withTotal,
}: {
  command: string;
  kind: GlyphKind | "proposed";
  withTotal: boolean;
}): React.ReactElement {
  const tick = useTick();
  const progress = simulatedProgress(tick, withTotal);
  const resolved = kind === "proposed" ? proposedKind(progress) : kind;
  return (
    <BlockChrome
      toolName="Bash"
      argsSummary={<code>{command}</code>}
      status="streaming"
      liveBand={
        <BlockNoticeBand
          tone="info"
          maxLines={1}
          icon={<Glyph kind={resolved} progress={progress} />}
          text={formatRunProgressLine(progress)}
        />
      }
    >
      {null}
    </BlockChrome>
  );
}

function Caption({ tag, children }: { tag: string; children: React.ReactNode }) {
  return (
    <p className="sp-pg-caption">
      <span className="sp-pg-tag">{tag}</span> {children}
    </p>
  );
}

// ---------------------------------------------------------------------------
// The fill census — every step the ring will be seen at, side by side.
// ---------------------------------------------------------------------------

const FRACTIONS = [0, 0.02, 0.1, 0.25, 0.5, 0.75, 0.945, 1];

function FillCensus({ size }: { size: number }): React.ReactElement {
  return (
    <div className="sp-pg-census">
      {FRACTIONS.map((f) => (
        <div key={f} className="sp-pg-census-cell">
          <TugProgressIndicator
            variant="ring"
            size={size}
            role="action"
            state="running"
            value={f}
            max={1}
            aria-label={`${Math.round(f * 100)}%`}
          />
          <span className="sp-pg-census-label">
            {f === 0 ? "0 (indet.)" : `${Math.round(f * 1000) / 10}%`}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

function SpikeProgressGlyph(): React.ReactElement {
  return (
    <div className="sp-content">
      <p className="sp-pg-intro">
        The line under a running Bash block is the command reporting its own
        progress. These are the glyphs that could lead it, each one inside the
        real chrome and notice band.
      </p>

      <section className="sp-section">
        <h2 className="sp-section-title">The proposal: ring with a total, spinner without</h2>
        <div className="sp-pg-stack">
          <Caption tag="With a total">The ring fills to done / total, in the running dot&rsquo;s blue.</Caption>
          <LiveBlock command="just ci 2>&1 | tail -60" kind="proposed" withTotal />
          <Caption tag="No total">The report gives only a count, so a spinner says it&rsquo;s still running.</Caption>
          <LiveBlock command="cargo build 2>&1 | tail -40" kind="proposed" withTotal={false} />
        </div>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">Today, for contrast</h2>
        <div className="sp-pg-stack">
          <LiveBlock command="just ci 2>&1 | tail -60" kind="today" withTotal />
        </div>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">Fallback alternatives: spinner vs. indeterminate ring</h2>
        <div className="sp-pg-stack">
          <Caption tag="Spinner">A different glyph from the ring: you can tell &ldquo;count only&rdquo; from &ldquo;fraction known&rdquo; at a glance.</Caption>
          <LiveBlock command="cargo build 2>&1 | tail -40" kind="spinner" withTotal={false} />
          <Caption tag="Indeterminate ring">The same glyph turning, so it doesn&rsquo;t change shape when a total shows up mid-run.</Caption>
          <LiveBlock command="cargo build 2>&1 | tail -40" kind="ring-indeterminate" withTotal={false} />
        </div>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">Determinate alternative: pie</h2>
        <div className="sp-pg-stack">
          <Caption tag="Pie">A filled wedge instead of a stroke. Easier to read at 14px, but heavier.</Caption>
          <LiveBlock command="just ci 2>&1 | tail -60" kind="pie" withTotal />
        </div>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">Fill census at 14px (actual) and 28px</h2>
        <FillCensus size={GLYPH_SIZE} />
        <FillCensus size={28} />
        <p className="sp-pg-note">
          A value of 0 runs the ring&rsquo;s indeterminate motion rather than
          showing an empty 0%, so a run that has just started looks the same as
          one with no total.
        </p>
      </section>
    </div>
  );
}

export const spike: SpikeDef = {
  name: "progress-glyph",
  title: "Progress Glyph",
  blurb: "What should lead a running Bash block's progress line — a ring filled to done/total, a spinner, or today's (i)?",
  icon: "LoaderCircle",
  component: () => <SpikeProgressGlyph />,
};
