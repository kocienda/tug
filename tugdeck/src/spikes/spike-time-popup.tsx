/**
 * spike-time-popup.tsx — up-levelling the Z2 TIME popup.
 *
 * Two complaints drove this, both against the popup as it ships:
 *
 * 1. **It is not lively.** Only the `current turn` row ticks. `total` and
 *    `avg` are computed from committed turns alone, so while a turn is in
 *    flight the popup shows a total that is already wrong and an average
 *    that excludes the one turn the reader is watching.
 *
 * 2. **It has no picture.** The CONTEXT popup pairs a segmented dial with a
 *    legend and reads as one object; TIME is a table and a footer.
 *
 * Every proposal below renders the same mock session — eight committed turns
 * plus one in flight, ticking at 1 Hz from the moment the spike mounts — in a
 * mock of the placard chrome, so the treatments can be compared at the size
 * they would ship. A switch at the top parks the session idle, which is the
 * state every proposal also has to look right in.
 *
 * The proposals, in the order a reader should weigh them:
 *
 *   A. **Live summary.** Same table; `total`, `avg` and `current` all tick,
 *      and the in-flight turn appears as its own row at the foot of the log.
 *   B. **Bars in the rows.** Each row carries a thin bar sized to its
 *      `activeMs` against the longest turn, toned by its end state. The
 *      in-flight row's bar grows live.
 *   C. **Composition strip.** Wall clock = active + waiting on you +
 *      offline. A stacked strip with a legend, which is the form a
 *      part-to-whole takes; a dial would misread it as a fill level.
 *   D. **Live-turn dial.** A single-value arc with a meaningful max — the
 *      longest turn so far — so the sweep answers "is this turn running
 *      long?" with caution past the average and danger near the record.
 *   E. **The CONTEXT twin.** D's dial on the left, A's summary and C's
 *      legend on the right, B's log below — one object, like CONTEXT.
 *
 * Nothing here ships. The dial reuses `TugArcGauge`; the strip and row
 * bars are plain token-painted divs because no `Tug*` primitive draws a
 * stacked or inline bar yet, and whether one should exist is part of what
 * the spike is asking.
 *
 * @module spikes/spike-time-popup
 */

import "./spike.css";
import "./spike-time-popup.css";

import React, { useState } from "react";

import { TugArcGauge } from "@/components/tugways/tug-arc-gauge";
import { TugBadge } from "@/components/tugways/tug-badge";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import {
  TugPopupListFrame,
  TugPopupListGrid,
  TugPopupListRow,
} from "@/components/tugways/tug-popup-list";
import { formatTimeAlwaysHours } from "@/components/tugways/cards/session-card-telemetry-renderers";
import { endStateBadgeFor } from "@/lib/code-session-store/end-state";
import { useLifecycleTick } from "@/lib/code-session-store/hooks/use-lifecycle-tick";
import { useMotionHold } from "@/lib/motion-guard";
import type { TurnEndReason } from "@/lib/code-session-store/types";

import type { SpikeDef } from "./spike-registry";

/* ---------------------------------------------------------------------------
 * The mock session
 * ---------------------------------------------------------------------------*/

interface MockTurn {
  /** The turn's canonical number — `#u{n}` / `#a{n}`. */
  n: number;
  /** Wake turns have no user half. */
  wake?: boolean;
  preview: string;
  end: TurnEndReason;
  /** Machine-doing-work ms. */
  activeMs: number;
  /** Blocked on a permission or question dialog. */
  awaitingMs: number;
  /** Transport offline or restoring. */
  downtimeMs: number;
}

const MIN = 60_000;
const SEC = 1_000;

/** Eight committed turns, shaped like the screenshot that prompted this. */
const TURNS: readonly MockTurn[] = [
  { n: 1, preview: "Look at the abandoned project described there. It turns out…", end: "complete", activeMs: 1 * MIN + 26 * SEC, awaitingMs: 0, downtimeMs: 0 },
  { n: 2, preview: "1. **App-tests** ↑ fix the app-tests. 2. **Do we honour** …", end: "complete", activeMs: 57 * SEC, awaitingMs: 12 * SEC, downtimeMs: 0 },
  { n: 3, preview: "claude-home", end: "complete", activeMs: 24 * SEC, awaitingMs: 0, downtimeMs: 0 },
  { n: 4, wake: true, preview: "", end: "complete", activeMs: 0, awaitingMs: 0, downtimeMs: 0 },
  { n: 5, preview: "claude-home implement one step and end the turn where: wo…", end: "complete", activeMs: 15 * MIN + 2 * SEC, awaitingMs: 48 * SEC, downtimeMs: 0 },
  { n: 6, preview: "Run the selection again, alone, and read the history line.", end: "interrupted", activeMs: 3 * MIN + 41 * SEC, awaitingMs: 0, downtimeMs: 0 },
  { n: 7, preview: "Now the real fix: the picker's showSheet collector.", end: "complete", activeMs: 6 * MIN + 18 * SEC, awaitingMs: 1 * MIN + 5 * SEC, downtimeMs: 22 * SEC },
  { n: 8, preview: "Write the brief.", end: "error", activeMs: 44 * SEC, awaitingMs: 0, downtimeMs: 0 },
];

const INFLIGHT_PREVIEW = "I'd like to *up-level* the Z2 TIME popup.";

interface Readings {
  turns: readonly MockTurn[];
  inflight: boolean;
  /** Live elapsed of the in-flight turn, 0 when idle. */
  currentMs: number;
  count: number;
  committedTotalMs: number;
  /** Committed total plus the in-flight elapsed. */
  liveTotalMs: number;
  /** Over committed turns only — today's figure. */
  committedAvgMs: number;
  /** Over committed turns plus the one in flight. */
  liveAvgMs: number;
  longestMs: number;
  awaitingMs: number;
  downtimeMs: number;
}

function hasTiming(t: MockTurn): boolean {
  return t.activeMs > 0;
}

/**
 * Derive every number the proposals show from the mock turns plus the
 * tick. Mirrors `computeTimeSummary` for the committed figures and adds
 * the live variants the proposals argue for.
 */
function useReadings(inflight: boolean): Readings {
  // The tick hook is the production 1 Hz heartbeat; a non-terminal phase
  // keeps it alive. `startedAt` is pinned at the moment the session went
  // in flight so the elapsed reads from zero rather than from mount.
  const tickAt = useLifecycleTick(inflight ? "streaming" : "idle");
  const [startedAt, setStartedAt] = useState<number>(() => Date.now());
  const [wasInflight, setWasInflight] = useState(inflight);
  if (wasInflight !== inflight) {
    setWasInflight(inflight);
    if (inflight) setStartedAt(Date.now());
  }
  const currentMs = inflight && tickAt > 0 ? Math.max(0, tickAt - startedAt) : 0;
  const timed = TURNS.filter(hasTiming);
  const count = TURNS.length;
  const committedTotalMs = timed.reduce((s, t) => s + t.activeMs, 0);
  const liveTotalMs = committedTotalMs + currentMs;
  const liveCount = count + (inflight ? 1 : 0);
  return {
    turns: TURNS,
    inflight,
    currentMs,
    count,
    committedTotalMs,
    liveTotalMs,
    committedAvgMs: Math.round(committedTotalMs / count),
    liveAvgMs: Math.round(liveTotalMs / liveCount),
    longestMs: Math.max(currentMs, ...timed.map((t) => t.activeMs)),
    awaitingMs: TURNS.reduce((s, t) => s + t.awaitingMs, 0),
    downtimeMs: TURNS.reduce((s, t) => s + t.downtimeMs, 0),
  };
}

/* ---------------------------------------------------------------------------
 * Shared pieces
 * ---------------------------------------------------------------------------*/

/** The placard chrome the real popup wears — restated, not imported. */
function Placard({ children, wide }: { children: React.ReactNode; wide?: boolean }): React.ReactElement {
  return (
    <div className="sp-tp-placard" data-wide={wide ? "true" : undefined}>
      <div className="sp-tp-placard-title">TIME</div>
      {children}
    </div>
  );
}

function Address({ t }: { t: MockTurn }): React.ReactElement {
  if (t.wake) {
    return (
      <span className="sp-tp-pair">
        <span className="sp-tp-addr">#a{t.n}</span>
      </span>
    );
  }
  return (
    <span className="sp-tp-pair">
      <span className="sp-tp-addr">#u{t.n}</span>
      <span className="sp-tp-pair-sep" aria-hidden>/</span>
      <span className="sp-tp-addr">#a{t.n}</span>
    </span>
  );
}

function EndBadge({ t }: { t: MockTurn }): React.ReactElement {
  const b = endStateBadgeFor(t.end);
  return (
    <TugBadge emphasis="ghost" role={b.role} size="sm">
      {b.text}
    </TugBadge>
  );
}

/** A dot-and-badge the in-flight row wears in place of an end state. */
function LiveBadge(): React.ReactElement {
  useMotionHold(true);
  return (
    <span className="sp-tp-live-hint">
      <span className="sp-tp-live-dot" aria-hidden />
      in flight
    </span>
  );
}

/** Value text that is ticking — same figure, with a `data-live` hook. */
function liveText(ms: number): string {
  return formatTimeAlwaysHours(ms);
}

/* ---------------------------------------------------------------------------
 * Row bars (B) — a thin bar under the preview, sized against the longest turn
 * ---------------------------------------------------------------------------*/

function RowBar({ ms, max, tone }: { ms: number; max: number; tone: "default" | "caution" | "danger" | "live" }): React.ReactElement {
  const pct = max > 0 ? Math.min(100, (ms / max) * 100) : 0;
  return (
    <span className="sp-tp-rowbar" data-tone={tone} aria-hidden>
      <span className="sp-tp-rowbar-fill" style={{ width: `${pct}%` }} />
    </span>
  );
}

function toneFor(t: MockTurn): "default" | "caution" | "danger" {
  const role = endStateBadgeFor(t.end).role;
  return role === "caution" || role === "danger" ? role : "default";
}

/* ---------------------------------------------------------------------------
 * The log rows and summary rows every proposal composes
 * ---------------------------------------------------------------------------*/

function logRows(r: Readings, bars: boolean): React.ReactElement[] {
  const rows = r.turns.map((t) => (
    <TugPopupListRow
      key={t.n}
      label={<Address t={t} />}
      preview={
        bars ? (
          <span className="sp-tp-preview-stack">
            <span className="sp-tp-preview-text">{t.preview}</span>
            {hasTiming(t) ? <RowBar ms={t.activeMs} max={r.longestMs} tone={toneFor(t)} /> : null}
          </span>
        ) : (
          <span className="sp-tp-preview-text">{t.preview}</span>
        )
      }
      badge={<EndBadge t={t} />}
      value={hasTiming(t) ? formatTimeAlwaysHours(t.activeMs) : "—"}
    />
  ));
  if (r.inflight) {
    rows.push(
      <TugPopupListRow
        key="inflight"
        label={<span className="sp-tp-pair"><span className="sp-tp-addr">#u{r.count + 1}</span></span>}
        preview={
          bars ? (
            <span className="sp-tp-preview-stack">
              <span className="sp-tp-preview-text">{INFLIGHT_PREVIEW}</span>
              <RowBar ms={r.currentMs} max={r.longestMs} tone="live" />
            </span>
          ) : (
            <span className="sp-tp-preview-text">{INFLIGHT_PREVIEW}</span>
          )
        }
        badge={<LiveBadge />}
        value={liveText(r.currentMs)}
      />,
    );
  }
  return rows;
}

/** Today's footer: committed-only total and avg, current turn tacked on. */
function staleSummary(r: Readings): React.ReactElement[] {
  const rows = [
    <TugPopupListRow key="turns" label="turns" value={String(r.count)} />,
    <TugPopupListRow key="total" label="total" value={formatTimeAlwaysHours(r.committedTotalMs)} />,
    <TugPopupListRow key="avg" label="avg" hint="per turn" value={formatTimeAlwaysHours(r.committedAvgMs)} />,
  ];
  if (r.inflight) {
    rows.push(<TugPopupListRow key="cur" label="current turn" hint="in flight" value={liveText(r.currentMs)} />);
  }
  return rows;
}

/** Proposal A's footer: everything that can tick, ticks. */
function liveSummary(r: Readings): React.ReactElement[] {
  const rows = [
    <TugPopupListRow
      key="turns"
      label="turns"
      hint={r.inflight ? "+1 in flight" : undefined}
      value={String(r.count)}
    />,
    <TugPopupListRow
      key="total"
      label="total"
      hint={r.inflight ? "incl. current" : undefined}
      value={liveText(r.liveTotalMs)}
    />,
    <TugPopupListRow
      key="avg"
      label="avg"
      hint="per turn"
      value={liveText(r.liveAvgMs)}
    />,
  ];
  if (r.inflight) {
    rows.push(<TugPopupListRow key="cur" label="current turn" hint="in flight" value={liveText(r.currentMs)} />);
  }
  return rows;
}

/* ---------------------------------------------------------------------------
 * Composition strip (C)
 * ---------------------------------------------------------------------------*/

function CompositionStrip({ r }: { r: Readings }): React.ReactElement {
  const wall = r.liveTotalMs + r.awaitingMs + r.downtimeMs;
  const pct = (ms: number) => (wall > 0 ? (ms / wall) * 100 : 0);
  const parts = [
    { id: "active", label: "working", ms: r.liveTotalMs },
    { id: "awaiting", label: "waiting on you", ms: r.awaitingMs },
    { id: "offline", label: "offline", ms: r.downtimeMs },
  ];
  return (
    <div className="sp-tp-comp">
      <div className="sp-tp-strip" role="img" aria-label="Session wall clock by kind">
        {parts.map((p) => (
          <span key={p.id} className="sp-tp-strip-seg" data-part={p.id} style={{ flexBasis: `${pct(p.ms)}%` }} />
        ))}
      </div>
      <div className="sp-tp-legend">
        {parts.map((p) => (
          <React.Fragment key={p.id}>
            <span className="sp-tp-legend-label">
              <span className="sp-tp-swatch" data-part={p.id} />
              {p.label}
            </span>
            <span className="sp-tp-legend-pct">{pct(p.ms).toFixed(1)}%</span>
            <span className="sp-tp-legend-value">{formatTimeAlwaysHours(p.ms)}</span>
          </React.Fragment>
        ))}
        <div className="sp-tp-legend-divider" />
        <span className="sp-tp-legend-label">wall clock</span>
        <span />
        <span className="sp-tp-legend-value">{formatTimeAlwaysHours(wall)}</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Live-turn dial (D)
 * ---------------------------------------------------------------------------*/

function TurnDial({ r }: { r: Readings }): React.ReactElement {
  // Max is the longest turn so far — the one bound that means something
  // for an open-ended duration. Caution begins at the session average.
  const timed = r.turns.filter(hasTiming);
  const last = timed[timed.length - 1];
  const value = r.inflight ? r.currentMs : (last?.activeMs ?? 0);
  const max = Math.max(r.longestMs, 1);
  const caution = Math.min(0.95, r.liveAvgMs / max);
  return (
    <div className="sp-tp-dial" data-live={r.inflight ? "true" : undefined}>
      <TugArcGauge
        min={0}
        max={max}
        value={value}
        density="detailed"
        formatValue={formatTimeAlwaysHours}
        label={r.inflight ? "this turn" : "last turn"}
        thresholds={{ caution, danger: 0.9 }}
      />
      <div className="sp-tp-dial-foot">
        <span>vs longest</span>
        <span>{formatTimeAlwaysHours(r.longestMs)}</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * The proposals
 * ---------------------------------------------------------------------------*/

function Proposal({ tag, note, children }: { tag: string; note: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="sp-tp-proposal">
      <div className="sp-tp-tag">{tag}</div>
      {children}
      <p className="sp-tp-note">{note}</p>
    </div>
  );
}

function Today({ r }: { r: Readings }): React.ReactElement {
  return (
    <Placard>
      <TugPopupListFrame kind="log">
        <TugPopupListGrid rows={logRows({ ...r, inflight: false }, false)} summary={staleSummary(r)} stickToBottom />
      </TugPopupListFrame>
    </Placard>
  );
}

function ProposalA({ r }: { r: Readings }): React.ReactElement {
  return (
    <Placard>
      <TugPopupListFrame kind="log">
        <TugPopupListGrid rows={logRows(r, false)} summary={liveSummary(r)} stickToBottom />
      </TugPopupListFrame>
    </Placard>
  );
}

function ProposalB({ r }: { r: Readings }): React.ReactElement {
  return (
    <Placard>
      <TugPopupListFrame kind="log">
        <TugPopupListGrid rows={logRows(r, true)} summary={liveSummary(r)} stickToBottom />
      </TugPopupListFrame>
    </Placard>
  );
}

function ProposalC({ r }: { r: Readings }): React.ReactElement {
  return (
    <Placard>
      <TugPopupListFrame kind="log">
        <CompositionStrip r={r} />
        <TugPopupListGrid rows={logRows(r, false)} summary={liveSummary(r)} stickToBottom />
      </TugPopupListFrame>
    </Placard>
  );
}

function ProposalD({ r }: { r: Readings }): React.ReactElement {
  return (
    <Placard wide>
      <TugPopupListFrame kind="wide">
        <div className="sp-tp-twin">
          <TurnDial r={r} />
          <div className="sp-tp-twin-grid">
            <TugPopupListGrid rows={[]} summary={liveSummary(r)} />
          </div>
        </div>
      </TugPopupListFrame>
    </Placard>
  );
}

function ProposalE({ r }: { r: Readings }): React.ReactElement {
  return (
    <Placard wide>
      <TugPopupListFrame kind="wide">
        <div className="sp-tp-twin">
          <TurnDial r={r} />
          <div className="sp-tp-twin-grid">
            <TugPopupListGrid rows={[]} summary={liveSummary(r)} />
            <CompositionStrip r={r} />
          </div>
        </div>
        <div className="sp-tp-twin-log">
          <TugPopupListGrid rows={logRows(r, true)} stickToBottom />
        </div>
      </TugPopupListFrame>
    </Placard>
  );
}

/* ---------------------------------------------------------------------------
 * The spike
 * ---------------------------------------------------------------------------*/

function SpikeTimePopup(): React.ReactElement {
  const [inflight, setInflight] = useState(true);
  const r = useReadings(inflight);
  return (
    <div className="sp-content">
      <section className="sp-section">
        <h2 className="sp-section-title">The session</h2>
        <p className="sp-tp-intro">
          Eight committed turns and, with the switch on, a ninth in flight that
          started when you flipped it. Every proposal below reads the same
          numbers, so what differs is only how much of them moves and what
          picture they make.
        </p>
        <div className="sp-tp-controls">
          <TugPushButton size="sm" onClick={() => setInflight((v) => !v)}>
            {inflight ? "Park the session idle" : "Start a turn"}
          </TugPushButton>
        </div>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">Today</h2>
        <Proposal
          tag="As shipped"
          note="Only the current-turn row ticks. Total and average are committed-only, so while a turn runs the total is already behind and the average excludes the one turn being watched."
        >
          <Today r={r} />
        </Proposal>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">A · Live summary</h2>
        <Proposal
          tag="Everything that can tick, ticks"
          note="The in-flight turn becomes a row at the foot of the log with a live badge; total includes it; avg divides by count + 1. Hints say what changed. Zero new drawing — this is the floor every other proposal stands on."
        >
          <ProposalA r={r} />
        </Proposal>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">B · Bars in the rows</h2>
        <Proposal
          tag="Per-turn magnitude, in place"
          note="A thin bar under each preview, sized against the longest turn and toned by end state. The in-flight bar grows. Ordered magnitudes want a bar chart, and the log already is the axis — no legend needed, the row is its own label."
        >
          <ProposalB r={r} />
        </Proposal>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">C · Composition strip</h2>
        <Proposal
          tag="Where the wall clock went"
          note="Wall clock = working + waiting on you + offline, which is a true part-to-whole; a stacked strip with a legend is the honest form (a dial would read it as a fill level). The numbers already exist on every TurnEntry; nobody shows them."
        >
          <ProposalC r={r} />
        </Proposal>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">D · Live-turn dial</h2>
        <Proposal
          tag="Is this turn running long?"
          note="TugArcGauge with a max that means something — the longest turn so far — so the sweep is a comparison, not a decoration. Caution starts at the session average, danger near the record. Idle, it shows the last turn. This is the CONTEXT silhouette with the summary beside it."
        >
          <ProposalD r={r} />
        </Proposal>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">E · The CONTEXT twin</h2>
        <Proposal
          tag="D + A + C above, B below"
          note="One object: dial, live summary and composition legend in the wide layout CONTEXT uses, with the barred log underneath. The recommended target if the popup is allowed to grow; A alone if it is not."
        >
          <ProposalE r={r} />
        </Proposal>
      </section>
    </div>
  );
}

export const spike: SpikeDef = {
  name: "time-popup",
  title: "Time Popup",
  blurb: "Five treatments that make the Z2 TIME popup tick everywhere and give it a picture",
  icon: "Timer",
  size: { min: { width: 560, height: 420 }, preferred: { width: 760, height: 900 } },
  component: () => <SpikeTimePopup />,
};
