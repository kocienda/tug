/**
 * spike-workspace-session-row.tsx — how tall does a session row in the
 * Workspaces card have to be before it stops cutting off what it is there to
 * say?
 *
 * The shipped row is three lines, always, and at a rail's width every one of
 * them elides. The title line carries six things — the dot, the name, the
 * `^<arc>` run, the arc's pill-glyph-word-count cluster, the slot picker and
 * the slot badge — so the name gives way to `live…` and the phase word to
 * `E..`. The description and the activity each get one line, and both stop
 * short of the tape, so the two sentences the row exists to show are cut
 * mid-clause.
 *
 * The bench sets the shipped row beside two taller proposals at the same rail
 * width, over the same fixtures:
 *
 *  - **Today** is the real `TugSessionRow`, packed the way the Cards card
 *    packs it (large dot, `edge` sub-alignment, the rail's own knobs).
 *  - **Four lines** gives the arc a standing line of its own under the name.
 *    The name line is then the name and the slots and nothing else; the
 *    description runs the row's whole width; the tape rides the activity. A
 *    session on no arc keeps the line and says its standing facts there, so
 *    every row is the same height whether or not an arc is bound.
 *  - **Wrapped** is the same row with the description and the activity
 *    allowed to wrap, to the number of lines the slider sets.
 *
 * What is real and what is a drawing: the dot, the identity runs, the arc
 * sigil, the arc lifecycle mark, the slot badges and the tape are the shipped
 * components over fixture data. The two proposals' PACKING is spike-local CSS
 * — that packing is the question — and the strings are fixtures written to
 * reproduce the rail's hard cases.
 *
 * @module spikes/spike-workspace-session-row
 */

import "./spike.css";
import "./spike-workspace-session-row.css";
// The title run's gaps on the shipped row. The stylesheet belongs to
// `SessionIdentityRow`, which this bench cannot mount (it resolves a live
// session); the "Today" column rebuilds that row's title run from the same
// parts and needs the same rules to be an honest picture of it.
import "@/components/tugways/session-identity-row.css";

import React, { useId, useLayoutEffect, useRef, useState } from "react";

import { ArcLifecycleMark } from "@/components/tugways/arc-lifecycle-mark";
import { ArcSigil } from "@/components/tugways/arc-sigil";
import { CardSlotBadge } from "@/components/tugways/card-slot-badge";
import { SessionIdentityView } from "@/components/tugways/cards/session-identity";
import {
  arcTrackModel,
  type ArcTrackModel,
} from "@/components/tugways/tug-arc-track";
import { TugListRow, TugListRowTitle } from "@/components/tugways/tug-list-row";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import {
  TUG_SESSION_ROW_INDICATOR_SIZE,
  TUG_SESSION_ROW_SPARK_HEIGHT,
  TUG_SESSION_ROW_SPARK_WIDTH,
  TUG_SESSION_SPARK_CURVE,
  TUG_SESSION_SPARK_FULL_SCALE_CHARS,
  TugSessionRow,
} from "@/components/tugways/tug-session-row";
import { TugSlider } from "@/components/tugways/tug-slider";
import { TugSlotBadge } from "@/components/tugways/tug-slot-badge";
import { TugSparkline } from "@/components/tugways/tug-sparkline";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import { sessionSessionPhaseVisual } from "@/lib/code-session-store/session-phase-visual";
import { ACTIVITY_BIN_MS } from "@/lib/session-activity-store";
import {
  composeSessionIdentity,
  type SessionIdentity,
} from "@/lib/session-identity";

import type { SpikeDef } from "./spike-registry";

// ---------------------------------------------------------------------------
// Fixtures — the rail's hard cases
// ---------------------------------------------------------------------------

interface ArcFixture {
  name: string;
  model: ArcTrackModel;
}

interface RowFixture {
  key: string;
  identity: SessionIdentity;
  /** Phase key for the dot (`session-phase-visual` vocabulary). */
  phase: string;
  arc: ArcFixture | null;
  description: string;
  /** The description is a fact standing in for one nobody has written. */
  standIn?: boolean;
  /** The activity line as the shipped row says it. */
  activity: string;
  /** The standing facts, for a row on no arc: turns, size, last update. */
  facts: string;
  /** The activity line once the standing facts have a line of their own. */
  activityWithoutFacts: string;
  /** The slot the card holds, and how deep the stack there is. */
  slot: { count: number; held: number; depth: number } | null;
  selected?: boolean;
}

const ROOT = "/Users/tester/src/tug";

function identity(
  seed: string,
  name: string | null,
  tag: string,
  synopsis: string | null,
): SessionIdentity {
  return composeSessionIdentity({
    sessionId: `${seed}-0000-4000-8000-000000000000`,
    name,
    synopsis,
    tag,
    projectDir: ROOT,
  });
}

/** A planned arc `current` steps into a plan of `total`, or under audit. */
function arcAt(
  name: string,
  current: number,
  total: number,
  stage: "implement" | "audit",
): ArcFixture {
  const auditing = stage === "audit";
  return {
    name,
    model: arcTrackModel({
      documents: {
        brief: `${ROOT}/.tug/arcs/${name}/brief.md`,
        plan: `${ROOT}/.tug/arcs/${name}/plan.md`,
      },
      arcKind: "planned",
      arc: { stage },
      stage: "implementing",
      steps: Array.from({ length: total }, (_, i) => ({
        title: `Step ${i + 1}`,
        status: auditing || i + 1 < current
          ? "done"
          : i + 1 === current
            ? "in progress"
            : "pending",
      })),
    }),
  };
}

const ROWS: readonly RowFixture[] = [
  {
    key: "rest",
    identity: identity("a1c40e77", null, "odd-kiln", null),
    phase: "idle",
    arc: null,
    description:
      "Reworking the session row in the Workspaces card so it stops truncating",
    activity: "2 turns, 1.2 MB. Last updated: Nov 23, 9:49 AM. Ready.",
    facts: "2 turns, 1.2 MB. Last updated: Nov 23, 9:49 AM.",
    activityWithoutFacts: "Ready.",
    slot: { count: 3, held: 1, depth: 2 },
  },
  {
    key: "arc-walking",
    identity: identity(
      "5d2e9b10",
      "liven the bingo seeing",
      "mighty-cabin",
      null,
    ),
    phase: "streaming",
    arc: arcAt("liven-bingo-seeing", 3, 6, "implement"),
    description:
      "Implement the liven-bingo-seeing arc: verify each step against its checkpoint and commit the round",
    activity:
      "Step 3 of 6 of liven-bingo-seeing: the row tests went red and it is looking at them.",
    facts: "",
    activityWithoutFacts:
      "Step 3 of 6 of liven-bingo-seeing: the row tests went red and it is looking at them.",
    slot: { count: 3, held: 2, depth: 3 },
    selected: true,
  },
  {
    key: "named-working",
    identity: identity(
      "f6e43925",
      "speech engine integration",
      "curly-apple",
      null,
    ),
    phase: "streaming",
    arc: null,
    description:
      "Letting a user supply their own speech engine for dictation in the Text card",
    activity:
      "Reading how the dictation mic hands audio to the recognizer before proposing where a second engine plugs in.",
    facts: "14 turns, 6.8 MB. Last updated: Nov 23, 10:02 AM.",
    activityWithoutFacts:
      "Reading how the dictation mic hands audio to the recognizer before proposing where a second engine plugs in.",
    slot: { count: 3, held: 0, depth: 1 },
  },
  {
    key: "arc-audit",
    identity: identity(
      "0f3c1e5a",
      "docket one card",
      "stocky-pixie",
      null,
    ),
    phase: "streaming",
    arc: arcAt("docket-one-card-membership-spelling", 6, 6, "audit"),
    description:
      "Make a docket one line of work in its own card, named after its members",
    activity:
      "Auditing the join: every round is committed and the membership spelling test is the last check outstanding.",
    facts: "",
    activityWithoutFacts:
      "Auditing the join: every round is committed and the membership spelling test is the last check outstanding.",
    slot: { count: 3, held: 2, depth: 3 },
  },
  {
    key: "fresh",
    identity: identity("7c21d3aa", null, "bendy-sweet", null),
    phase: "idle",
    arc: null,
    description: "Created Nov 23, 9:41 AM",
    standIn: true,
    activity: "0 turns, 8 KB. Ready.",
    facts: "0 turns, 8 KB.",
    activityWithoutFacts: "Ready.",
    slot: null,
  },
];

// ---------------------------------------------------------------------------
// The shipped parts, over fixtures
// ---------------------------------------------------------------------------

/** A deterministic burst pattern, so each row's tape is its own and repeats. */
function synthRate(bin: number, seed: number): number {
  const r = Math.abs(Math.sin(bin * 12.9898 + seed * 78.233) * 43758.5453) % 1;
  return r > 0.6 ? r * TUG_SESSION_SPARK_FULL_SCALE_CHARS : r * 60;
}

const SYNTH_BINS = 40;

/** The real tape on a synthetic series; a resting session reads a flatline. */
function FixtureTape({
  seed,
  active,
}: {
  seed: number;
  active: boolean;
}): React.ReactElement {
  const getSeries = React.useCallback(
    (nowMs: number): number[] => {
      if (!active) return [];
      const current = Math.floor(nowMs / ACTIVITY_BIN_MS);
      const out: number[] = [];
      for (let i = SYNTH_BINS - 1; i >= 0; i -= 1) {
        out.push(synthRate(current - i, seed));
      }
      return out;
    },
    [seed, active],
  );
  const subscribeActivity = React.useCallback(
    (wake: () => void): (() => void) => {
      if (!active) return () => {};
      const timer = window.setInterval(wake, 400);
      return () => window.clearInterval(timer);
    },
    [active],
  );
  return (
    <TugSparkline
      getSeries={getSeries}
      subscribeActivity={subscribeActivity}
      binMs={ACTIVITY_BIN_MS}
      fullScale={TUG_SESSION_SPARK_FULL_SCALE_CHARS}
      curve={TUG_SESSION_SPARK_CURVE}
      width={TUG_SESSION_ROW_SPARK_WIDTH}
      height={TUG_SESSION_ROW_SPARK_HEIGHT}
      title="Session activity (fixture series)"
    />
  );
}

function Dot({ phase }: { phase: string }): React.ReactElement {
  return (
    <TugProgressIndicator
      variant="pulsing-dot"
      size={TUG_SESSION_ROW_INDICATOR_SIZE}
      phase={phase}
      phaseVisual={sessionSessionPhaseVisual}
      aria-hidden
    />
  );
}

const NO_ASSIGN = (): void => {};

/** The rail's trailing furniture: the slot the card holds, then its stack. */
function Slots({ row }: { row: RowFixture }): React.ReactElement | null {
  if (row.slot === null) return null;
  return (
    <>
      <CardSlotBadge
        cardId={`spike-workspace-session-row-${row.key}`}
        facts={{ count: row.slot.count, held: row.slot.held }}
        onAssign={NO_ASSIGN}
      />
      {row.slot.depth > 1 ? (
        <TugSlotBadge kind="stack" count={row.slot.depth} index={0} />
      ) : null}
    </>
  );
}

function fraction(arc: ArcFixture): { current: number; total: number } | null {
  const steps = arc.model.steps;
  if (steps === null || steps.current === null) return null;
  return { current: steps.current, total: steps.total };
}

function isWorking(row: RowFixture): boolean {
  return row.phase !== "idle";
}

// ---------------------------------------------------------------------------
// Today — the shipped row
// ---------------------------------------------------------------------------

/**
 * The row as the Cards card mounts it: the real `TugSessionRow`, with the
 * title run `SessionIdentityRow` builds — identity, `^<arc>`, then the worded
 * arc mark — all on the name line.
 */
function TodayRow({
  row,
  seed,
}: {
  row: RowFixture;
  seed: number;
}): React.ReactElement {
  const runs = (
    <SessionIdentityView
      identity={row.identity}
      tier="line"
      dot={false}
      arc={row.arc !== null ? { name: row.arc.name } : false}
      tooltip={false}
    />
  );
  const name =
    row.arc !== null ? (
      <span className="session-identity-row-title-run">
        {runs}
        <span className="session-identity-row-progress" data-worded="true">
          <ArcLifecycleMark
            model={row.arc.model}
            size="read"
            name={row.arc.name}
            fraction={fraction(row.arc)}
            showWord
          />
        </span>
      </span>
    ) : (
      runs
    );
  return (
    <TugSessionRow
      selected={row.selected === true}
      subAlign="edge"
      indicator={<Dot phase={row.phase} />}
      indicatorSize={TUG_SESSION_ROW_INDICATOR_SIZE}
      name={name}
      description={row.description}
      descriptionFull={row.description}
      descriptionStandIn={row.standIn === true}
      activity={row.activity}
      sparkline={<FixtureTape seed={seed} active={isWorking(row)} />}
      slots={<Slots row={row} />}
    />
  );
}

// ---------------------------------------------------------------------------
// The proposals — one packing, with the prose clamp as its only difference
// ---------------------------------------------------------------------------

/**
 * The taller row.
 *
 *   [dot] <name>                              <slots>
 *   ^<arc> <pill> <glyph> <word> <n/N>     — or the standing facts
 *   <description, the row's whole width>
 *   <activity>                                  <tape>
 *
 * `wrap` lets the description and the activity run to the bench's line count
 * instead of one line each; nothing else differs between the two proposals.
 */
function TallRow({
  row,
  seed,
  wrap,
}: {
  row: RowFixture;
  seed: number;
  wrap: boolean;
}): React.ReactElement {
  return (
    <TugListRow
      className="sp-wsr-row"
      selected={row.selected === true}
      data-wrap={wrap ? "true" : "false"}
    >
      <span className="sp-wsr-lines">
        <span className="sp-wsr-name-line">
          <span className="sp-wsr-dot">
            <Dot phase={row.phase} />
          </span>
          <TugListRowTitle>
            <SessionIdentityView
              identity={row.identity}
              tier="line"
              dot={false}
              arc={false}
              tooltip={false}
            />
          </TugListRowTitle>
          <span className="sp-wsr-slots">
            <Slots row={row} />
          </span>
        </span>
        <span
          className="sp-wsr-standing"
          data-kind={row.arc !== null ? "arc" : "facts"}
        >
          {row.arc !== null ? (
            <>
              <span className="sp-wsr-arc-name">
                <ArcSigil
                  name={row.arc.name}
                  slot="spike-session-row-arc"
                  ariaLabel={`Worked by arc ${row.arc.name}`}
                />
              </span>
              <span className="sp-wsr-arc-mark">
                <ArcLifecycleMark
                  model={row.arc.model}
                  size="read"
                  name={row.arc.name}
                  fraction={fraction(row.arc)}
                  showWord
                />
              </span>
            </>
          ) : (
            <span className="sp-wsr-facts">{row.facts}</span>
          )}
        </span>
        <span
          className="sp-wsr-description"
          data-stamp={row.standIn === true ? "true" : undefined}
        >
          {row.description}
        </span>
        <span className="sp-wsr-activity-line">
          <span className="sp-wsr-activity">
            {row.arc !== null ? row.activity : row.activityWithoutFacts}
          </span>
          <span className="sp-wsr-tape">
            <FixtureTape seed={seed} active={isWorking(row)} />
          </span>
        </span>
      </span>
    </TugListRow>
  );
}

// ---------------------------------------------------------------------------
// The bench
// ---------------------------------------------------------------------------

function Rail({
  title,
  caption,
  children,
}: {
  title: string;
  caption: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="sp-wsr-column">
      <div className="sp-wsr-column-title">{title}</div>
      <div className="sp-wsr-rail">{children}</div>
      <p className="sp-wsr-caption">{caption}</p>
    </div>
  );
}

const DEFAULT_RAIL_WIDTH = 310;
const DEFAULT_PROSE_LINES = 2;

function SpikeWorkspaceSessionRow(): React.ReactElement {
  const [railWidth, setRailWidth] = useState(DEFAULT_RAIL_WIDTH);
  const [proseLines, setProseLines] = useState(DEFAULT_PROSE_LINES);

  const railWidthId = useId();
  const proseLinesId = useId();
  const { ResponderScope, responderRef } = useResponderForm({
    setValueNumber: {
      [railWidthId]: setRailWidth,
      [proseLinesId]: setProseLines,
    },
  });

  // The two numbers reach the bench as custom properties on its root ([L06]):
  // one write per drag frame, and the rows never learn a number changed.
  const benchRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = benchRef.current;
    if (el === null) return;
    el.style.setProperty("--sp-wsr-rail-width", `${railWidth}px`);
    el.style.setProperty("--sp-wsr-prose-lines", String(proseLines));
  }, [railWidth, proseLines]);

  return (
    <ResponderScope>
      <div
        className="sp-content"
        ref={responderRef as (el: HTMLDivElement | null) => void}
      >
        <section className="sp-section">
          <h2 className="sp-section-title">Tune</h2>
          <div className="sp-wsr-tuner">
            <TugSlider
              label="Rail width"
              senderId={railWidthId}
              value={railWidth}
              min={240}
              max={460}
              step={10}
              size="sm"
            />
            <TugSlider
              label="Prose lines (Wrapped)"
              senderId={proseLinesId}
              value={proseLines}
              min={1}
              max={4}
              step={1}
              size="sm"
            />
          </div>
        </section>

        <section className="sp-section">
          <h2 className="sp-section-title">The row, three ways</h2>
          <div className="sp-wsr-bench" ref={benchRef}>
            <Rail
              title="Today"
              caption="Three lines. The name line holds six things, so the name and the phase word both elide; the description and the activity each stop short of the tape."
            >
              {ROWS.map((row, i) => (
                <TodayRow key={row.key} row={row} seed={i + 1} />
              ))}
            </Rail>
            <Rail
              title="Four lines"
              caption="The arc takes a standing line of its own, so the name line is the name and the slots. A row on no arc says its standing facts there, which keeps every row one height. The description runs the whole width."
            >
              {ROWS.map((row, i) => (
                <TallRow key={row.key} row={row} seed={i + 1} wrap={false} />
              ))}
            </Rail>
            <Rail
              title="Wrapped"
              caption="The same row with the description and the activity allowed to wrap to the slider's line count. A row is as tall as what it has to say, up to the cap."
            >
              {ROWS.map((row, i) => (
                <TallRow key={row.key} row={row} seed={i + 1} wrap />
              ))}
            </Rail>
          </div>
        </section>
      </div>
    </ResponderScope>
  );
}

export const spike: SpikeDef = {
  name: "workspace-session-row",
  title: "Workspace Session Row",
  blurb:
    "How tall does a session row in the Workspaces card have to be before it stops cutting off what it is there to say?",
  icon: "Rows3",
  size: {
    min: { width: 400, height: 350 },
    preferred: { width: 1080, height: 760 },
  },
  component: () => <SpikeWorkspaceSessionRow />,
};
