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
 *   F. **The arc.** A card bound to an arc reads its time by the arc's
 *      structure: a stage strip with its projection, then devise / review /
 *      implement / audit, with implement's steps as rows barred against the
 *      arc's own median and turns as the drill-down. F′ is the Z2 cell's
 *      glance during implement: `6/10 · 0:02:14`.
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

function RowBar({
  ms,
  max,
  tone,
  projected,
}: {
  ms: number;
  max: number;
  tone: "default" | "caution" | "danger" | "live";
  /** F's pending steps: the bar is a forecast, drawn faint. */
  projected?: boolean;
}): React.ReactElement {
  const pct = max > 0 ? Math.min(100, (ms / max) * 100) : 0;
  return (
    <span className="sp-tp-rowbar" data-tone={tone} data-projected={projected ? "true" : undefined} aria-hidden>
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
 * F — the arc. A card bound to an arc reads its time by the arc's own
 * structure: stages, then steps, with turns as the drill-down.
 *
 * The mock is `resolve-ledger-rollout` as its arc log read on 2026-10-27,
 * with step 6 in flight: real titles, real shas, real start → done spans.
 * Turn active times are invented a few seconds under each span, and step 4's
 * second turn — a question answered — is invented to show a step that took
 * two. The audit projection is the last arc's audit, `moved-call-is-a-job`.
 * ---------------------------------------------------------------------------*/

interface ArcTurn {
  n: number;
  preview: string;
  end: TurnEndReason;
  activeMs: number;
}

interface ArcStep {
  n: number;
  title: string;
  /** The step's commit — absent until it lands. */
  commit?: string;
  /** `step-start` → `step-done` on the arc log. */
  wallMs?: number;
  turns: readonly ArcTurn[];
  /** A compaction the wheel ran at the boundary after this step. */
  compactAfter?: { note: string; ms: number };
}

const ARC_STEP_TOTAL = 10;

const ARC_DEVISE: readonly ArcTurn[] = [
  { n: 1, preview: "/tugplug:arc-devise a plan for .tug/arcs/resolve-ledger-rollout/brief.md…", end: "complete", activeMs: 15 * MIN + 21 * SEC },
];
const ARC_REVIEW: readonly ArcTurn[] = [
  { n: 2, preview: "/tugplug:arc-review resolve-ledger-rollout", end: "complete", activeMs: 11 * MIN + 2 * SEC },
];

const ARC_STEPS: readonly ArcStep[] = [
  { n: 1, title: "Sheets, register and DOCUMENTS", commit: "315f607", wallMs: 7 * MIN + 48 * SEC,
    turns: [{ n: 3, preview: "resolve-ledger-rollout implement step 1 and end the turn…", end: "complete", activeMs: 7 * MIN + 41 * SEC }] },
  { n: 2, title: "The fold receipt, answered", commit: "c58caa0", wallMs: 6 * MIN + 20 * SEC,
    turns: [{ n: 4, preview: "resolve-ledger-rollout implement step 2 and end the turn…", end: "complete", activeMs: 6 * MIN + 14 * SEC }] },
  { n: 3, title: "REPORT as a ledger of blocks", commit: "1415922", wallMs: 7 * MIN + 32 * SEC,
    turns: [{ n: 5, preview: "resolve-ledger-rollout implement step 3 and end the turn…", end: "complete", activeMs: 7 * MIN + 27 * SEC }],
    compactAfter: { note: "compacted at 397k > 300k", ms: 1 * MIN + 6 * SEC } },
  { n: 4, title: "Every rung reports", commit: "f6c778d", wallMs: 14 * MIN + 2 * SEC,
    turns: [
      { n: 6, preview: "resolve-ledger-rollout implement step 4 and end the turn…", end: "complete", activeMs: 9 * MIN + 20 * SEC },
      { n: 7, preview: "Split the call — keep the gate strict.", end: "complete", activeMs: 3 * MIN + 24 * SEC },
    ] },
  { n: 5, title: "The resolver's stream is relayed", commit: "86ce45a", wallMs: 7 * MIN + 7 * SEC,
    turns: [{ n: 8, preview: "resolve-ledger-rollout implement step 5 and end the turn…", end: "complete", activeMs: 7 * MIN + 2 * SEC }],
    compactAfter: { note: "compacted at 382k > 300k", ms: 1 * MIN + 5 * SEC } },
];

const ARC_CURRENT = { n: 6, title: "Resolve again", turn: 9, preview: "resolve-ledger-rollout implement step 6 and end the turn…", baseMs: 2 * MIN + 14 * SEC };

const ARC_PENDING: readonly { n: number; title: string }[] = [
  { n: 7, title: "The durable ledger" },
  { n: 8, title: "The base-motion receipt" },
  { n: 9, title: "Migrate the spike's CSS and delete the spike" },
  { n: 10, title: "Integration Checkpoint" },
];

/** The last arc's audit, start → `arc-done`, as the only history the mock has. */
const LAST_AUDIT_MS = 19 * MIN + 42 * SEC;

const sumActive = (turns: readonly ArcTurn[]) => turns.reduce((s, t) => s + t.activeMs, 0);
const stepActive = (s: ArcStep) => sumActive(s.turns);

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

interface ArcReadings {
  running: boolean;
  /** Elapsed of the step in flight (frozen when the arc is stopped). */
  currentMs: number;
  deviseMs: number;
  reviewMs: number;
  /** Steps, compactions and the step in flight. */
  implementMs: number;
  medianStepMs: number;
  slowest: ArcStep;
  /** What is left of the step in flight, at the median. */
  currentLeftMs: number;
  pendingMs: number;
  auditMs: number;
  soFarMs: number;
  waitingMs: number;
}

function arcReadings(r: Readings): ArcReadings {
  const running = r.inflight;
  const currentMs = ARC_CURRENT.baseMs + r.currentMs;
  const medianStepMs = median(ARC_STEPS.map(stepActive));
  const implementMs =
    ARC_STEPS.reduce((s, st) => s + stepActive(st) + (st.compactAfter?.ms ?? 0), 0) + currentMs;
  const deviseMs = sumActive(ARC_DEVISE);
  const reviewMs = sumActive(ARC_REVIEW);
  return {
    running,
    currentMs,
    deviseMs,
    reviewMs,
    implementMs,
    medianStepMs,
    slowest: ARC_STEPS.reduce((a, b) => (stepActive(b) > stepActive(a) ? b : a)),
    currentLeftMs: running ? Math.max(0, medianStepMs - currentMs) : 0,
    pendingMs: running ? ARC_PENDING.length * medianStepMs : 0,
    auditMs: running ? LAST_AUDIT_MS : 0,
    soFarMs: deviseMs + reviewMs + implementMs,
    waitingMs: ARC_STEPS.reduce((s, st) => s + Math.max(0, (st.wallMs ?? 0) - stepActive(st)), 0),
  };
}

/** `~0:07:32` — a projection says it is one. */
const approx = (ms: number) => `~${formatTimeAlwaysHours(ms)}`;

/** The step bar: against twice the arc's median, caution past 1.5×. */
function StepBar({ ms, a, tone }: { ms: number; a: ArcReadings; tone?: "live" | "projected" }): React.ReactElement {
  const max = Math.max(1, a.medianStepMs * 2);
  const t = tone ?? (ms > a.medianStepMs * 1.5 ? "caution" : "default");
  return <RowBar ms={ms} max={max} tone={t === "projected" ? "default" : t} projected={t === "projected"} />;
}

function StageLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  return <span className="sp-tp-stage">{children}</span>;
}

function TurnAddr({ n }: { n: number }): React.ReactElement {
  return (
    <span className="sp-tp-pair">
      <span className="sp-tp-addr">#u{n}</span>
      <span className="sp-tp-pair-sep" aria-hidden>/</span>
      <span className="sp-tp-addr">#a{n}</span>
    </span>
  );
}

function ArcTurnRow({ t, nested }: { t: ArcTurn; nested?: boolean }): React.ReactElement {
  return (
    <TugPopupListRow
      label={<span className={nested ? "sp-tp-nested" : undefined}><TurnAddr n={t.n} /></span>}
      preview={<span className="sp-tp-preview-text">{t.preview}</span>}
      badge={<EndBadge t={{ n: t.n, preview: t.preview, end: t.end, activeMs: t.activeMs, awaitingMs: 0, downtimeMs: 0 }} />}
      value={formatTimeAlwaysHours(t.activeMs)}
    />
  );
}

function Commit({ sha }: { sha: string }): React.ReactElement {
  return <span className="sp-tp-commit">{sha}</span>;
}

function arcRows(
  a: ArcReadings,
  open: ReadonlySet<number>,
  toggle: (n: number) => void,
): React.ReactElement[] {
  const rows: React.ReactElement[] = [];
  const stageRow = (id: string, label: string, meta: string, value: string, hint?: string) =>
    rows.push(
      <TugPopupListRow
        key={`stage-${id}`}
        label={<StageLabel>{label}</StageLabel>}
        preview={<span className="sp-tp-stage-meta">{meta}</span>}
        hint={hint}
        value={value}
      />,
    );

  stageRow("devise", "DEVISE", "opus · 1 turn", formatTimeAlwaysHours(a.deviseMs));
  stageRow("review", "REVIEW", "opus · 1 round", formatTimeAlwaysHours(a.reviewMs));
  stageRow(
    "implement",
    "IMPLEMENT",
    `opus · ${ARC_STEPS.length} of ${ARC_STEP_TOTAL} done`,
    formatTimeAlwaysHours(a.implementMs),
    a.running ? "incl. current" : undefined,
  );

  for (const s of ARC_STEPS) {
    const active = stepActive(s);
    const many = s.turns.length > 1;
    const isOpen = open.has(s.n);
    const waited = (s.wallMs ?? active) - active;
    const meta = many
      ? `${s.turns.length} turns · wall ${formatTimeAlwaysHours(s.wallMs ?? active)}${waited > 30 * SEC ? ` · ${formatTimeAlwaysHours(waited)} on you` : ""}`
      : null;
    rows.push(
      <TugPopupListRow
        key={`step-${s.n}`}
        label={
          <span className="sp-tp-stepnum">
            {many ? (
              <button
                type="button"
                className="sp-tp-disclose"
                aria-expanded={isOpen}
                aria-label={`${isOpen ? "Hide" : "Show"} step ${s.n}'s turns`}
                onClick={() => toggle(s.n)}
              >
                {isOpen ? "▾" : "▸"}
              </button>
            ) : (
              <span className="sp-tp-disclose-gap" aria-hidden />
            )}
            {s.n}
          </span>
        }
        preview={
          <span className="sp-tp-preview-stack">
            <span className="sp-tp-preview-text">
              {s.title}
              {!many ? <span className="sp-tp-step-addr"> <TurnAddr n={s.turns[0].n} /></span> : null}
            </span>
            <StepBar ms={active} a={a} />
            {meta !== null ? <span className="sp-tp-step-meta">{meta}</span> : null}
          </span>
        }
        badge={s.commit !== undefined ? <Commit sha={s.commit} /> : undefined}
        value={formatTimeAlwaysHours(active)}
      />,
    );
    if (many && isOpen) {
      for (const t of s.turns) rows.push(<ArcTurnRow key={`turn-${t.n}`} t={t} nested />);
    }
    if (s.compactAfter !== undefined) {
      rows.push(
        <TugPopupListRow
          key={`compact-${s.n}`}
          label=""
          preview={<span className="sp-tp-mark">⟳ {s.compactAfter.note}</span>}
          value={formatTimeAlwaysHours(s.compactAfter.ms)}
        />,
      );
    }
  }

  rows.push(
    <TugPopupListRow
      key="step-current"
      label={<span className="sp-tp-stepnum"><span className="sp-tp-disclose-gap" aria-hidden />{ARC_CURRENT.n}</span>}
      preview={
        <span className="sp-tp-preview-stack">
          <span className="sp-tp-preview-text">
            {ARC_CURRENT.title}
            <span className="sp-tp-step-addr"> <span className="sp-tp-pair"><span className="sp-tp-addr">#u{ARC_CURRENT.turn}</span></span></span>
          </span>
          <StepBar ms={a.currentMs} a={a} tone={a.running ? "live" : undefined} />
          {a.running && a.currentLeftMs > 0 ? (
            <span className="sp-tp-step-meta">{approx(a.currentLeftMs)} left at the median</span>
          ) : null}
        </span>
      }
      badge={
        a.running ? (
          <LiveBadge />
        ) : (
          <TugBadge emphasis="ghost" role="caution" size="sm">stopped</TugBadge>
        )
      }
      value={formatTimeAlwaysHours(a.currentMs)}
    />,
  );

  for (const p of ARC_PENDING) {
    rows.push(
      <TugPopupListRow
        key={`step-${p.n}`}
        label={<span className="sp-tp-stepnum" data-pending="true"><span className="sp-tp-disclose-gap" aria-hidden />{p.n}</span>}
        preview={
          <span className="sp-tp-preview-stack" data-pending="true">
            <span className="sp-tp-preview-text">{p.title}</span>
            {a.running ? <StepBar ms={a.medianStepMs} a={a} tone="projected" /> : null}
          </span>
        }
        hint={a.running ? "projected" : undefined}
        value={a.running ? approx(a.medianStepMs) : "—"}
      />,
    );
  }

  stageRow(
    "audit",
    "AUDIT",
    "not started",
    a.running ? approx(a.auditMs) : "—",
    a.running ? "as last audit" : undefined,
  );
  return rows;
}

function arcSummary(a: ArcReadings): React.ReactElement[] {
  const rows = [
    <TugPopupListRow
      key="steps"
      label="steps"
      hint={`median ${formatTimeAlwaysHours(a.medianStepMs)} · slowest #${a.slowest.n}`}
      value={`${ARC_STEPS.length}/${ARC_STEP_TOTAL}`}
    />,
    <TugPopupListRow
      key="sofar"
      label="arc"
      hint={a.running ? "so far, incl. current" : "so far"}
      value={formatTimeAlwaysHours(a.soFarMs)}
    />,
    <TugPopupListRow
      key="waiting"
      label="waiting on you"
      hint="inside steps"
      value={formatTimeAlwaysHours(a.waitingMs)}
    />,
  ];
  rows.push(
    a.running ? (
      <TugPopupListRow
        key="projected"
        label="projected"
        hint="at this arc's pace"
        value={approx(a.soFarMs + a.currentLeftMs + a.pendingMs + a.auditMs)}
      />
    ) : (
      <TugPopupListRow key="projected" label="projected" hint="none while stopped" value="—" />
    ),
  );
  return rows;
}

/** Stage strip: actual time solid, projected time faint, one legend row per stage. */
function StageStrip({ a }: { a: ArcReadings }): React.ReactElement {
  const parts: { id: string; label: string; ms: number; projected?: boolean }[] = [
    { id: "devise", label: "devise", ms: a.deviseMs },
    { id: "review", label: "review", ms: a.reviewMs },
    { id: "implement", label: "implement", ms: a.implementMs },
    { id: "implement", label: "implement, to come", ms: a.currentLeftMs + a.pendingMs, projected: true },
    { id: "audit", label: "audit, to come", ms: a.auditMs, projected: true },
  ];
  const whole = parts.reduce((s, p) => s + p.ms, 0);
  const pct = (ms: number) => (whole > 0 ? (ms / whole) * 100 : 0);
  const shown = parts.filter((p) => p.ms > 0);
  return (
    <div className="sp-tp-comp">
      <div className="sp-tp-strip" role="img" aria-label="Arc time by stage, with what is projected">
        {shown.map((p) => (
          <span
            key={p.label}
            className="sp-tp-strip-seg"
            data-part={p.id}
            data-projected={p.projected ? "true" : undefined}
            style={{ flexBasis: `${pct(p.ms)}%` }}
          />
        ))}
      </div>
      <div className="sp-tp-legend">
        {shown.map((p) => (
          <React.Fragment key={p.label}>
            <span className="sp-tp-legend-label">
              <span className="sp-tp-swatch" data-part={p.id} data-projected={p.projected ? "true" : undefined} />
              {p.label}
            </span>
            <span className="sp-tp-legend-pct">{pct(p.ms).toFixed(1)}%</span>
            <span className="sp-tp-legend-value">{p.projected ? approx(p.ms) : formatTimeAlwaysHours(p.ms)}</span>
          </React.Fragment>
        ))}
        <div className="sp-tp-legend-divider" />
        <span className="sp-tp-legend-label">{a.running ? "arc, projected" : "arc, so far"}</span>
        <span />
        <span className="sp-tp-legend-value">{a.running ? approx(whole) : formatTimeAlwaysHours(whole)}</span>
      </div>
    </div>
  );
}

function ProposalF({ r }: { r: Readings }): React.ReactElement {
  const a = arcReadings(r);
  // Step 4 opens by default: it is the one step that took two turns, and the
  // drill-down is what is being shown.
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set([4]));
  const toggle = (n: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  return (
    <Placard>
      <TugPopupListFrame kind="log">
        <StageStrip a={a} />
        <div className="sp-tp-arc-log">
          <TugPopupListGrid rows={arcRows(a, open, toggle)} summary={arcSummary(a)} />
        </div>
      </TugPopupListFrame>
    </Placard>
  );
}

/** F′ — the Z2 cell, today's session total beside an arc's glance. */
function ArcGlance({ r }: { r: Readings }): React.ReactElement {
  const a = arcReadings(r);
  return (
    <div className="sp-tp-glance-row">
      <span className="sp-tp-glance">
        <span className="sp-tp-glance-key">TIME</span>
        <span className="sp-tp-glance-value">{formatTimeAlwaysHours(a.soFarMs)}</span>
      </span>
      <span className="sp-tp-glance-vs">vs</span>
      <span className="sp-tp-glance" data-live={a.running ? "true" : undefined}>
        <span className="sp-tp-glance-key">TIME</span>
        <span className="sp-tp-glance-value">
          {ARC_CURRENT.n}/{ARC_STEP_TOTAL} · {formatTimeAlwaysHours(a.currentMs)}
        </span>
      </span>
    </div>
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

      <section className="sp-section">
        <h2 className="sp-section-title">F · The arc</h2>
        <Proposal
          tag="Stages, then steps; turns are the drill-down"
          note="resolve-ledger-rollout as its arc log read today, step 6 in flight. Each step is a row: its active time, its commit, and a bar against twice the arc's median step, tinted caution past 1.5×, so step 4 stands out. A step that took more than one turn opens to its turns and says how much of its wall clock was waiting on you. Compactions sit inline as marks with their cost. Pending steps and the audit are projections, faint and marked ~. Parked, the arc reads as stopped and projects nothing."
        >
          <ProposalF r={r} />
        </Proposal>
      </section>

      <section className="sp-section">
        <h2 className="sp-section-title">F′ · The glance</h2>
        <Proposal
          tag="What the Z2 cell says during an arc"
          note="Today the cell shows the arc's running total. During implement, the step and its elapsed time answer the question a reader is actually asking."
        >
          <ArcGlance r={r} />
        </Proposal>
      </section>
    </div>
  );
}

export const spike: SpikeDef = {
  name: "time-popup",
  title: "Time Popup",
  blurb: "Treatments that make the Z2 TIME popup tick everywhere, give it a picture, and read an arc by its stages and steps",
  icon: "Timer",
  size: { min: { width: 560, height: 420 }, preferred: { width: 760, height: 900 } },
  component: () => <SpikeTimePopup />,
};
