/**
 * spike-session-minimize.tsx — the minimized Session card, downselected.
 *
 * Minimized, a session keeps its masthead with the beat on two lines, its Z2
 * status row, and a full-width `Show Transcript` bar as the way back. The way
 * in is a Minimize button seated beside the submit in Z5. The point of the
 * control is a split slot showing many sessions at once — a wall of sessions
 * you are keeping an eye on, not talking to.
 *
 * Settled here (2026-09-09): the bar over the Z5 seat and the cluster toggle;
 * two lines for the beat over one; "Show Transcript" as the bar's word.
 *
 * Still to decide, drawn below: what happens when one card in a tall wall is
 * opened. The suggestion is that the opened card takes a READING SHARE of the
 * column — most of it, never all of it — the siblings keep their minimized
 * height and scroll, and opening a second card minimizes the first, so the
 * wall stays a wall.
 *
 * Not drawable here, but the thing the implementation has to do: the beat has
 * to carry more weight when minimized. A wall only works if the two lines say
 * enough that the reader is not forever opening cards to find out what is
 * going on.
 *
 * The masthead is drawn to the identity spike's recipe; the dot, the tape,
 * the Z2 cells, and every button are the real components.
 *
 * @module spikes/spike-session-minimize
 */

import "./spike.css";
import "./spike-session-minimize.css";

import React from "react";
import { ArrowUp, ChevronsDownUp, ChevronsUpDown, Ellipsis, Waves, X } from "lucide-react";

import { TugIconButton } from "@/components/tugways/tug-icon-button";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import {
  TUG_SESSION_ROW_SPARK_HEIGHT,
  TUG_SESSION_ROW_SPARK_WIDTH,
  TUG_SESSION_ROW_STACK_DOT_SIZE,
  TUG_SESSION_SPARK_CURVE,
  TUG_SESSION_SPARK_FULL_SCALE_CHARS,
} from "@/components/tugways/tug-session-row";
import { TugSlider } from "@/components/tugways/tug-slider";
import { TugSparkline } from "@/components/tugways/tug-sparkline";
import { useResponderForm } from "@/components/tugways/use-responder-form";
import { TugStatusCell } from "@/components/tugways/tug-status-cell";
import {
  SESSION_PHASE_LABELS,
  sessionSessionPhaseVisual,
  type SessionPhaseKey,
} from "@/lib/code-session-store/session-phase-visual";
import { IMPOSITION_GAP_PX } from "@/lib/layout-imposer";
import { ACTIVITY_BIN_MS } from "@/lib/session-activity-store";

import type { SpikeDef } from "./spike-registry";

// ---------------------------------------------------------------------------
// Fixtures — ten sessions
// ---------------------------------------------------------------------------

interface SessionFixture {
  name: string | null;
  project: string;
  callsign: string;
  description: string;
  beat: string;
  phase: SessionPhaseKey;
  time: string;
  context: string;
  tasks: string;
  jobs: string;
  seed: number;
}

const SESSIONS: readonly SessionFixture[] = [
  {
    name: "rail shadow",
    project: "tug",
    callsign: "kestrel",
    description: "Move the rail's gutter shadow off each member and onto the side",
    beat: "Editing tugdeck/src/components/chrome/deck-canvas.tsx to publish the strip's shadow as one property per side",
    phase: "tool_work",
    time: "12:41",
    context: "61k / 200k",
    tasks: "3/5",
    jobs: "1",
    seed: 11,
  },
  {
    name: null,
    project: "tug",
    callsign: "heron",
    description: "Give a text field exactly one focus mark",
    beat: "14 turns, 88k. Last updated: 9:02 AM. Ready.",
    phase: "idle",
    time: "1:05:17",
    context: "88k / 200k",
    tasks: "None",
    jobs: "None",
    seed: 23,
  },
  {
    name: "directional focus",
    project: "tug",
    callsign: "plover",
    description: "Arrow keys move card focus by direction across the deck",
    beat: "Running just app-test at0402-directional-card-focus.test.ts",
    phase: "tool_work",
    time: "3:12",
    context: "24k / 200k",
    tasks: "1/4",
    jobs: "2",
    seed: 31,
  },
  {
    name: null,
    project: "tugrust",
    callsign: "curlew",
    description: "Ledger retention for apptest_results.db",
    beat: "Waiting for permission to run cargo nextest run -p tugcore",
    phase: "awaiting_approval",
    time: "22:08",
    context: "133k / 200k",
    tasks: "6/7",
    jobs: "None",
    seed: 47,
  },
  {
    name: "reveal on arrival",
    project: "tug",
    callsign: "sandpiper",
    description: "Reveal a card that arrives, not just one raised",
    beat: "Writing the second commit of a card's arrival so the hold has a fixed beat rather than a zero-timeout, then re-running the arrival pin",
    phase: "streaming",
    time: "0:48",
    context: "41k / 200k",
    tasks: "2/2",
    jobs: "None",
    seed: 53,
  },
  {
    name: null,
    project: "tug",
    callsign: "godwit",
    description: "Created Sep 9, 2026 at 8:14 AM",
    beat: "0 turns, 0 bytes. Ready.",
    phase: "idle",
    time: "0:00",
    context: "0 / 200k",
    tasks: "None",
    jobs: "None",
    seed: 59,
  },
  {
    name: "theme contrast",
    project: "tugdeck",
    callsign: "avocet",
    description: "Bring vivace inside the brio accessibility budget",
    beat: "Error: bun run audit:theme-contrast exited 1 — two pairings over budget in vivace",
    phase: "errored",
    time: "8:33",
    context: "57k / 200k",
    tasks: "4/6",
    jobs: "None",
    seed: 67,
  },
  {
    name: null,
    project: "tugapp",
    callsign: "dunlin",
    description: "Window menu sidebar rows with a three-state mark",
    beat: "Reading tugapp/Sources/Tug/WindowMenu.swift",
    phase: "tool_work",
    time: "5:56",
    context: "19k / 200k",
    tasks: "0/3",
    jobs: "None",
    seed: 71,
  },
  {
    name: "standalone",
    project: "tugplug",
    callsign: "turnstone",
    description: "Drive the arc verbs from a scratch project with an empty PATH",
    beat: "Streaming",
    phase: "awaiting_first_token",
    time: "0:04",
    context: "72k / 200k",
    tasks: "None",
    jobs: "1",
    seed: 79,
  },
  {
    name: null,
    project: "tug",
    callsign: "whimbrel",
    description: "Field focus double ring brief",
    beat: "31 turns, 164k. Last updated: Yesterday at 6:40 PM. Ready.",
    phase: "idle",
    time: "2:14:09",
    context: "164k / 200k",
    tasks: "None",
    jobs: "None",
    seed: 83,
  },
];

function isRunning(f: SessionFixture): boolean {
  return (
    f.phase === "streaming" ||
    f.phase === "tool_work" ||
    f.phase === "awaiting_first_token" ||
    f.phase === "submitting"
  );
}

// ---------------------------------------------------------------------------
// The real instruments — the dot and the tape
// ---------------------------------------------------------------------------

function Dot({ phase, size }: { phase: SessionPhaseKey; size: number }): React.ReactElement {
  return (
    <TugProgressIndicator
      variant="pulsing-dot"
      size={size}
      phase={phase}
      phaseVisual={sessionSessionPhaseVisual}
      aria-hidden
    />
  );
}

function synthRate(bin: number, seed: number): number {
  const raw = Math.sin((bin + seed) * 12.9898) * 43758.5453;
  const r = raw - Math.floor(raw);
  return r > 0.6 ? r * TUG_SESSION_SPARK_FULL_SCALE_CHARS : r * 60;
}

const SYNTH_BINS = 40;

/** The real `TugSparkline` on a synthetic series; a quiet session gets an
 *  empty series and no wake, exactly as the real instrument sits. */
function Tape({ seed, active }: { seed: number; active: boolean }): React.ReactElement {
  const getSeries = React.useCallback(
    (nowMs: number): number[] => {
      if (!active) return [];
      const current = Math.floor(nowMs / ACTIVITY_BIN_MS);
      const out: number[] = [];
      for (let i = SYNTH_BINS - 1; i >= 0; i -= 1) out.push(synthRate(current - i, seed));
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

// ---------------------------------------------------------------------------
// The minimized card — masthead, Z2, Show Transcript
// ---------------------------------------------------------------------------

function Masthead({ f }: { f: SessionFixture }): React.ReactElement {
  const run = `${f.project}/${f.callsign}`;
  return (
    <div className="spm-masthead">
      <div className="spm-lead">
        <span className="spm-dot">
          <Dot phase={f.phase} size={TUG_SESSION_ROW_STACK_DOT_SIZE} />
        </span>
        <span className="spm-title">
          {f.name === null ? (
            <span className="spm-title-name">{run}</span>
          ) : (
            <>
              <span className="spm-title-name">{f.name}</span>
              <span className="spm-title-callsign">{` : ${run}`}</span>
            </>
          )}
        </span>
        <span className="spm-spacer" />
        <span className="spm-cluster">
          <span className="spm-widget" title="Telemetry">
            <Waves size={14} aria-hidden />
          </span>
          <span className="spm-slot-badge">2</span>
          <TugIconButton
            icon={<Ellipsis size={14} />}
            size="xs"
            emphasis="ghost"
            title="Section"
            aria-label="Section"
          />
          <TugIconButton icon={<X size={14} />} size="xs" emphasis="ghost" title="Close" aria-label="Close" />
        </span>
      </div>
      <div className="spm-description">{f.description}</div>
      <div className="spm-activity">
        <span className="spm-activity-run">{f.beat}</span>
        <span className="spm-tape">
          <Tape seed={f.seed} active={isRunning(f)} />
        </span>
      </div>
    </div>
  );
}

/** Z2: the five real cells on fixture values, the STATE cell wearing its
 *  two phase dots as the real one does. */
function StatusRow({ f }: { f: SessionFixture }): React.ReactElement {
  return (
    <div className="spm-z2">
      <TugStatusCell priority="state" label="STATE">
        <Dot phase={f.phase} size={12} />
        <span className="session-telemetry-status-value">{SESSION_PHASE_LABELS[f.phase]}</span>
        <Dot phase={f.phase} size={12} />
      </TugStatusCell>
      <TugStatusCell priority="time" label="TIME">
        <span className="session-telemetry-status-value">{f.time}</span>
      </TugStatusCell>
      <TugStatusCell priority="context" label="CONTEXT">
        <span className="session-telemetry-status-value">{f.context}</span>
      </TugStatusCell>
      <TugStatusCell priority="tasks" label="TASKS" valueEmpty={f.tasks === "None"}>
        <span className="session-telemetry-status-value">{f.tasks}</span>
      </TugStatusCell>
      <TugStatusCell priority="jobs" label="JOBS" valueEmpty={f.jobs === "None"}>
        <span className="session-telemetry-status-value">{f.jobs}</span>
      </TugStatusCell>
    </div>
  );
}

const MinimizedCard = React.forwardRef<HTMLDivElement, { f: SessionFixture }>(
  function MinimizedCard({ f }, ref) {
    return (
      <div className="spm-card" ref={ref}>
        <Masthead f={f} />
        <StatusRow f={f} />
        <div className="spm-bar">
          <TugPushButton
            className="spm-bar-button"
            emphasis="ghost"
            role="action"
            size="xs"
            subtype="icon-text"
            icon={<ChevronsUpDown size={14} />}
          >
            Show Transcript
          </TugPushButton>
        </div>
      </div>
    );
  },
);

// ---------------------------------------------------------------------------
// The way in — Z5 on the full card
// ---------------------------------------------------------------------------

function Z5Row(): React.ReactElement {
  return (
    <div className="spm-toolbar">
      <span className="spm-z4a">
        <span className="spm-route" data-on="true">
          Prompt
        </span>
        <span className="spm-route">Changes</span>
      </span>
      <span className="spm-z4b">
        <span className="spm-badge">tug</span>
        <span className="spm-badge">Claude Code 2.1.148</span>
      </span>
      <span className="spm-z5">
        <TugIconButton
          icon={<ChevronsDownUp size={16} />}
          size="sm"
          emphasis="outlined"
          title="Minimize"
          aria-label="Minimize"
        />
        <TugIconButton
          icon={<ArrowUp size={16} />}
          size="sm"
          emphasis="filled"
          title="Send"
          aria-label="Send"
        />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Opening one from the wall — the column miniatures
// ---------------------------------------------------------------------------

/** One member of a column miniature. `open` draws at the reading share. */
interface MiniMember {
  open?: boolean;
  faded?: boolean;
}

const MINI_COLUMN_HEIGHT = 300;
/** The share of the column an opened card takes. */
const READING_SHARE = 0.6;

/** A column at scale: `canvasPx` tall, members stacked at the imposition gap,
 *  the whole strip offset by `scrollPx` so an opened card can be shown scrolled
 *  into view. Members past the bottom edge are clipped, as a real overflow
 *  would be. */
function ColumnMini({
  members,
  minimizedPx,
  canvasPx,
  scrollPx = 0,
  label,
}: {
  members: readonly MiniMember[];
  minimizedPx: number;
  canvasPx: number;
  scrollPx?: number;
  label: string;
}): React.ReactElement {
  const scale = MINI_COLUMN_HEIGHT / canvasPx;
  let y = -scrollPx;
  const blocks = members.map((m, i) => {
    const h = m.open === true ? canvasPx * READING_SHARE : minimizedPx;
    const top = y;
    y += h + IMPOSITION_GAP_PX;
    return (
      <div
        key={i}
        className="spm-mini-card"
        data-open={m.open === true ? "true" : undefined}
        data-faded={m.faded === true ? "true" : undefined}
        style={{ top: top * scale, height: Math.max(2, h * scale - 1) }}
      />
    );
  });
  return (
    <div className="spm-mini-col">
      <div className="spm-mini" style={{ height: MINI_COLUMN_HEIGHT }}>
        {blocks}
      </div>
      <TugLabel size="xs" emphasis="calm" align="center">
        {label}
      </TugLabel>
    </div>
  );
}

function OpeningOne({ minimizedPx }: { minimizedPx: number }): React.ReactElement {
  const canvas = 900;
  const wall: MiniMember[] = Array.from({ length: 10 }, () => ({}));
  const oneOpen: MiniMember[] = wall.map((_, i) => (i === 3 ? { open: true } : {}));
  const secondOpen: MiniMember[] = wall.map((_, i) =>
    i === 7 ? { open: true } : i === 3 ? { faded: true } : {},
  );
  // Scroll so the opened card sits a little below the column's top, with its
  // neighbours above it still in view.
  const scrollTo = (index: number): number =>
    Math.max(0, index * (minimizedPx + IMPOSITION_GAP_PX) - minimizedPx - IMPOSITION_GAP_PX);
  return (
    <div className="spm-columns">
      <ColumnMini members={wall} minimizedPx={minimizedPx} canvasPx={canvas} label="The wall" />
      <ColumnMini
        members={oneOpen}
        minimizedPx={minimizedPx}
        canvasPx={canvas}
        scrollPx={scrollTo(3)}
        label="Open the fourth"
      />
      <ColumnMini
        members={secondOpen}
        minimizedPx={minimizedPx}
        canvasPx={canvas}
        scrollPx={scrollTo(7)}
        label="Then open the eighth"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The fit dial — how many fit
// ---------------------------------------------------------------------------

function fits(canvasPx: number, cardPx: number): number {
  if (cardPx <= 0) return 0;
  return Math.floor((canvasPx + IMPOSITION_GAP_PX) / (cardPx + IMPOSITION_GAP_PX));
}

const CANVAS_MIN = 600;
const CANVAS_MAX = 1600;
const CANVAS_DEFAULT = 900;

function FitDial({ cardPx }: { cardPx: number }): React.ReactElement {
  const [canvas, setCanvas] = React.useState(CANVAS_DEFAULT);
  const canvasId = React.useId();
  const { ResponderScope } = useResponderForm({
    setValueNumber: { [canvasId]: setCanvas },
  });
  const n = fits(canvas, cardPx);
  return (
    <ResponderScope>
      <div className="spm-dial">
        <TugSlider
          label="Canvas height"
          senderId={canvasId}
          value={canvas}
          min={CANVAS_MIN}
          max={CANVAS_MAX}
          step={20}
          size="sm"
          layout="inline"
        />
        <div className="spm-dial-readout">
          <span>
            Card <strong className="spm-num">{cardPx}px</strong>
          </span>
          <span>
            Gap <strong className="spm-num">{IMPOSITION_GAP_PX}px</strong>
          </span>
          <span>
            Fit at {canvas}px:{" "}
            <strong className="spm-num" data-goal={n >= 8 ? "true" : undefined}>
              {n}
            </strong>
          </span>
        </div>
      </div>
    </ResponderScope>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/** The minimized card's rendered height, read through a ResizeObserver — a
 *  readout, never a poll. */
function useMeasuredHeight(ref: React.RefObject<HTMLDivElement | null>): number {
  const [px, setPx] = React.useState(0);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const read = (): void => setPx(Math.round(el.offsetHeight));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return px;
}

function Caption({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <TugLabel size="xs" emphasis="calm" className="spm-caption">
      {children}
    </TugLabel>
  );
}

function SpikeSessionMinimize(): React.ReactElement {
  const firstRef = React.useRef<HTMLDivElement | null>(null);
  const cardPx = useMeasuredHeight(firstRef);

  return (
    <div className="sp-content spm-content">
      <section className="sp-section">
        <h2 className="sp-section-title">The wall — ten minimized sessions in one split slot</h2>
        <div className="spm-wall">
          {SESSIONS.map((f, i) => (
            <MinimizedCard key={f.callsign} f={f} ref={i === 0 ? firstRef : undefined} />
          ))}
        </div>
        <Caption>
          Masthead with the beat on two lines, Z2, and Show Transcript across the
          bottom. The tier is fixed: a short beat leaves its second line empty, so
          the wall never ripples as beats change.
        </Caption>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">The way in — Z5 on the full card</h2>
        <div className="spm-frame">
          <Z5Row />
        </div>
        <Caption>
          Minimize is a button beside the submit at Z5&apos;s trailing edge. The
          section menu and a chord are the other doors.
        </Caption>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">Opening one from the wall</h2>
        <OpeningOne minimizedPx={cardPx} />
        <Caption>
          Suggestion. An opened card takes a reading share of the column — six
          tenths here — never the whole column. The siblings keep their minimized
          height; what no longer fits scrolls, and the column scrolls to put the
          opened card just under its neighbour above. One open per split: opening
          another minimizes the first, so the wall stays a wall. A card that wants
          more than its share is the ordinary Session card, and gets it by leaving
          the split.
        </Caption>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">How many fit</h2>
        <FitDial cardPx={cardPx} />
        <Caption>
          Measured off the first card in the wall. This is the honest number for the
          shape as drawn: the masthead tier and Z2&apos;s two-line instrument are the
          floor, and eight needs a card under about 108px.
        </Caption>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">What the implementation has to do beyond this drawing</h2>
        <ul className="spm-list">
          <li>
            <strong>The beat carries more weight.</strong> A minimized session&apos;s two
            lines are written for a reader who will not open the card: what it is
            doing, what it is waiting on, what it last finished. That is a change to
            what the pulse says, not how it is drawn, and it is the thing that makes a
            wall work.
          </li>
          <li>
            Minimized is a fact about the card, stored with the layout, set by one
            action the button, the section menu, and a chord all dispatch.
          </li>
          <li>The composer folds, it does not unmount: a half-typed prompt survives.</li>
          <li>Return on a focused minimized card is Show Transcript. Z2 cells keep their placards.</li>
          <li>
            The minimized card&apos;s min height drops to the tier, or a split slot cannot
            pack them.
          </li>
        </ul>
      </section>
    </div>
  );
}

export const spike: SpikeDef = {
  name: "session-minimize",
  title: "Session Minimize",
  blurb:
    "The minimized Session card — masthead, Z2, Show Transcript — and how a wall of them behaves when one opens.",
  icon: "ChevronsDownUp",
  size: {
    min: { width: 720, height: 400 },
    preferred: { width: 760, height: 800 },
  },
  component: () => <SpikeSessionMinimize />,
};
