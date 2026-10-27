/**
 * arc-time — what an arc card's time went on, by the arc's own structure.
 *
 * The arc log says *when* (stage rotations, step spans, the marks between
 * them — {@link ArcTimeline}); the card's turns say *how much of that was the
 * machine working* (`activeMs`). This module places each turn inside the
 * windows and adds them up, so the TIME popup can say what each stage and
 * each step cost, and — while the arc is walking and has a pace to go by —
 * what is left.
 *
 * Placement rules, in order:
 *
 * - A turn belongs to the **last stage rotated at or before it ended**. A
 *   turn that ended before the first rotation is *before the arc* (the `/arc`
 *   conversation that opened it).
 * - Within its stage, a turn belongs to the **step whose spans it overlaps
 *   most**. The wheel asks for one step per turn, so a step is usually one
 *   turn; a re-ask or an answered question makes it two or more.
 * - A turn in a stage that overlaps no step sits **between steps** at its
 *   place in time; one ending within a minute of a compaction mark is that
 *   compaction's cost.
 * - The turn in flight belongs to the open step, else to the current stage.
 *
 * A step's cost is its turns' active time, or — for turns restored without
 * telemetry — its spans' wall time. Projection needs two finished steps and
 * an arc that is neither stopped nor done; an unstarted audit is projected
 * from the project's typical audit when the server sent one.
 *
 * Pure: no JSX, no clock of its own (`nowMs` is passed in), so it is a table
 * test.
 *
 * @module lib/arc-time
 */

import type { ArcStep, ArcTimeline, ArcTimelineMark, ArcTimelineStep } from "@/lib/changeset-types";

/** A turn of the card's transcript, as much of it as placement reads. */
export interface ArcTimeTurnInput {
  endedAt: number;
  wallClockMs: number;
  activeMs: number;
}

/** A turn placed in the arc: its transcript index, or `-1` for the turn in flight. */
export interface ArcTimeTurn {
  index: number;
  activeMs: number;
}

export type ArcStepState = "done" | "open" | "withdrawn" | "reset" | "pending";

export interface ArcTimeStep {
  n: number;
  title: string | null;
  commit: string | null;
  state: ArcStepState;
  /** The step's turns' active time — the step's cost. */
  activeMs: number;
  /** Its spans' wall time, an open span read to `nowMs`. `null` for a step
   *  the log has not opened. */
  wallMs: number | null;
  turns: ArcTimeTurn[];
  /** Whether the turn in flight is this step's. */
  live: boolean;
  /** For an open step, what is left at the median; for a pending one, the
   *  median. `null` when nothing is being projected. */
  projectedMs: number | null;
  /** Past 1.5× the arc's median finished step. */
  slow: boolean;
}

export interface ArcTimeMark {
  kind: "compact" | "stop" | "resume";
  note: string;
  atMs: number;
}

/** One row of a stage's walk, in time order. */
export type ArcTimeItem =
  | { kind: "step"; step: ArcTimeStep }
  | { kind: "mark"; mark: ArcTimeMark; turns: ArcTimeTurn[]; activeMs: number }
  | { kind: "between"; turns: ArcTimeTurn[]; activeMs: number };

export interface ArcTimeStage {
  stage: string;
  model: string | null;
  /** Every turn of the stage, steps' included, in transcript order. */
  turns: ArcTimeTurn[];
  activeMs: number;
  /** Steps, marks and between-step turns, in time order — empty for a stage
   *  that walked no steps and recorded no marks. */
  items: ArcTimeItem[];
  /** The stage the arc is in now (the last rotated, on an arc not done). */
  current: boolean;
  /** Whether the turn in flight is this stage's. */
  live: boolean;
  /** For a stage not yet started: its projected cost. */
  projectedMs: number | null;
  /** True for a stage the arc has not reached, drawn as a projection. */
  upcoming: boolean;
}

export interface ArcTimeReading {
  /** Turns before the first rotation, or null when there were none. */
  before: { turns: ArcTimeTurn[]; activeMs: number } | null;
  stages: ArcTimeStage[];
  /** Pending steps (never opened, or parked), in step order. */
  pending: ArcTimeStep[];
  stepsDone: number;
  /** The run's length when one was declared, else the plan's. */
  stepsTotal: number | null;
  medianStepMs: number | null;
  slowestStep: number | null;
  /** Active time since the first rotation, the turn in flight included. */
  soFarMs: number;
  /** Projected total, or null when nothing is projected. */
  projectedTotalMs: number | null;
  /** Why nothing is projected, when nothing is. */
  noProjection: "stopped" | "done" | "too-early" | null;
}

export interface ArcTimeInput {
  timeline: ArcTimeline;
  /** The plan's ledger rows, in source order (row `i` is step `i + 1`). */
  ledger: readonly ArcStep[];
  stopped: boolean;
  done: boolean;
  transcript: readonly ArcTimeTurnInput[];
  /** The turn in flight's active time so far, or null when idle. */
  inflightMs: number | null;
  nowMs: number;
}

/** A turn ending this close to a compaction mark is the compaction's cost. */
const COMPACTION_SLACK_MS = 60_000;
/** A step past this multiple of the median is called slow. */
const SLOW_FACTOR = 1.5;

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function spanWall(step: ArcTimelineStep, nowMs: number): number {
  return step.spans.reduce(
    (sum, s) => sum + Math.max(0, (s.end_ms ?? nowMs) - s.start_ms),
    0,
  );
}

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function stepState(step: ArcTimelineStep): ArcStepState {
  if (step.end === undefined) return "open";
  if (step.end === "done") return "done";
  if (step.end === "withdrawn") return "withdrawn";
  return "reset";
}

function markKind(kind: string): ArcTimeMark["kind"] | null {
  return kind === "compact" || kind === "stop" || kind === "resume" ? kind : null;
}

const sumActive = (turns: readonly ArcTimeTurn[]) => turns.reduce((s, t) => s + t.activeMs, 0);

/** A step's cost: its turns' active time, or its wall time when the turns
 *  carry none (restored without telemetry). */
function stepCost(step: ArcTimeStep): number {
  return step.activeMs > 0 ? step.activeMs : (step.wallMs ?? 0);
}

export function computeArcTime(input: ArcTimeInput): ArcTimeReading {
  const { timeline, ledger, stopped, done, transcript, inflightMs, nowMs } = input;
  const rotations = timeline.stages ?? [];
  const logSteps = timeline.steps ?? [];

  // Stage windows: each rotation to the next.
  const stageStart = rotations.map((r) => r.at_ms);
  const stageEnd = rotations.map((_, i) => rotations[i + 1]?.at_ms ?? Number.POSITIVE_INFINITY);
  const stageOf = (atMs: number): number => {
    let found = -1;
    for (let i = 0; i < stageStart.length; i++) if (stageStart[i] <= atMs) found = i;
    return found;
  };

  // Steps, each seated in the stage its first span opened in.
  const steps: ArcTimeStep[] = logSteps.map((s) => ({
    n: s.n,
    title: s.title ?? ledger[s.n - 1]?.title ?? null,
    commit: s.commit ?? null,
    state: stepState(s),
    activeMs: 0,
    wallMs: s.spans.length > 0 ? spanWall(s, nowMs) : null,
    turns: [],
    live: false,
    projectedMs: null,
    slow: false,
  }));
  const stepStage = logSteps.map((s) => (s.spans.length > 0 ? stageOf(s.spans[0].start_ms) : -1));

  const stageTurns: ArcTimeTurn[][] = rotations.map(() => []);
  const looseTurns: { turn: ArcTimeTurn; endedAt: number }[][] = rotations.map(() => []);
  const before: ArcTimeTurn[] = [];

  transcript.forEach((t, index) => {
    const turn: ArcTimeTurn = { index, activeMs: t.activeMs };
    const start = t.endedAt - t.wallClockMs;
    const stage = stageOf(t.endedAt);
    if (stage < 0) {
      before.push(turn);
      return;
    }
    stageTurns[stage].push(turn);
    let best = -1;
    let bestOverlap = 0;
    logSteps.forEach((s, i) => {
      if (stepStage[i] !== stage) return;
      const o = s.spans.reduce(
        (sum, span) => sum + overlap(start, t.endedAt, span.start_ms, span.end_ms ?? nowMs),
        0,
      );
      if (o > bestOverlap) {
        best = i;
        bestOverlap = o;
      }
    });
    if (best >= 0) steps[best].turns.push(turn);
    else looseTurns[stage].push({ turn, endedAt: t.endedAt });
  });

  const lastStage = rotations.length - 1;
  const currentStage = done ? -1 : lastStage;
  let liveStage = -1;
  if (inflightMs !== null) {
    const live: ArcTimeTurn = { index: -1, activeMs: inflightMs };
    const open = steps.findIndex((s) => s.state === "open");
    if (open >= 0 && stepStage[open] >= 0) {
      steps[open].turns.push(live);
      steps[open].live = true;
      liveStage = stepStage[open];
    } else if (lastStage >= 0) {
      liveStage = lastStage;
      looseTurns[lastStage].push({ turn: live, endedAt: nowMs });
    } else {
      before.push(live);
    }
    if (liveStage >= 0) stageTurns[liveStage].push(live);
  }

  for (const s of steps) s.activeMs = sumActive(s.turns);

  // Pace: the median finished step, once there are two to take it from.
  const finished = steps.filter((s) => s.state === "done").map(stepCost).filter((ms) => ms > 0);
  const medianStepMs = finished.length >= 2 ? median(finished) : null;
  if (medianStepMs !== null) {
    for (const s of steps) {
      if (s.state === "done" && stepCost(s) > medianStepMs * SLOW_FACTOR) s.slow = true;
    }
  }
  const slowest = steps
    .filter((s) => s.state === "done")
    .reduce<ArcTimeStep | null>((a, b) => (a === null || stepCost(b) > stepCost(a) ? b : a), null);

  const noProjection: ArcTimeReading["noProjection"] = done
    ? "done"
    : stopped
      ? "stopped"
      : medianStepMs === null
        ? "too-early"
        : null;
  const projecting = noProjection === null && medianStepMs !== null;

  for (const s of steps) {
    if (s.state === "open" && projecting) {
      s.projectedMs = Math.max(0, medianStepMs - stepCost(s));
    }
  }

  // Pending: every ledger row inside the run that the log has not closed or
  // opened — a parked step is owed again, so it is pending too.
  const through = timeline.run_through ?? null;
  // A run opens on its first logged step, so a run of 5–7 owes nothing for
  // steps 1–4, whatever the ledger says of them.
  const runStart = logSteps.length > 0 ? Math.min(...logSteps.map((s) => s.n)) : 1;
  const pending: ArcTimeStep[] = [];
  const seen = new Map(steps.map((s) => [s.n, s]));
  ledger.forEach((row, i) => {
    const n = i + 1;
    if (n < runStart || (through !== null && n > through)) return;
    const logged = seen.get(n);
    if (logged !== undefined && logged.state !== "reset") return;
    if (row.status === "done" || row.status === "withdrawn") return;
    pending.push({
      n,
      title: logged?.title ?? row.title,
      commit: null,
      state: "pending",
      activeMs: logged?.activeMs ?? 0,
      wallMs: logged?.wallMs ?? null,
      turns: logged?.turns ?? [],
      live: false,
      projectedMs: projecting ? medianStepMs : null,
      slow: false,
    });
  });
  const pendingSet = new Set(pending.map((p) => p.n));

  // Each stage's walk, in time order.
  const marks = (timeline.marks ?? [])
    .map((m: ArcTimelineMark) => {
      const kind = markKind(m.kind);
      return kind === null ? null : { kind, note: m.note, atMs: m.at_ms };
    })
    .filter((m): m is ArcTimeMark => m !== null);

  const stages: ArcTimeStage[] = rotations.map((r, si) => {
    type Timed = { at: number; item: ArcTimeItem };
    const timed: Timed[] = [];
    steps.forEach((s, i) => {
      if (stepStage[i] !== si || pendingSet.has(s.n)) return;
      timed.push({ at: logSteps[i].spans[0].start_ms, item: { kind: "step", step: s } });
    });
    const stageMarks = marks.filter((m) => m.atMs >= stageStart[si] && m.atMs < stageEnd[si]);
    const markItems = stageMarks.map((mark) => ({
      at: mark.atMs,
      item: { kind: "mark" as const, mark, turns: [] as ArcTimeTurn[], activeMs: 0 },
    }));
    const hasSteps = timed.length > 0;
    // Between-step turns only mean something in a stage that walks steps;
    // anywhere else they are simply the stage's turns.
    if (hasSteps) {
      let between: { at: number; item: Extract<ArcTimeItem, { kind: "between" }> } | null = null;
      for (const { turn, endedAt } of looseTurns[si]) {
        const compaction = markItems.find(
          (m) => m.item.mark.kind === "compact" && Math.abs(m.at - endedAt) <= COMPACTION_SLACK_MS,
        );
        if (compaction !== undefined) {
          compaction.item.turns.push(turn);
          compaction.item.activeMs += turn.activeMs;
          continue;
        }
        if (between === null || endedAt - between.at > COMPACTION_SLACK_MS * 10) {
          between = { at: endedAt, item: { kind: "between", turns: [], activeMs: 0 } };
          timed.push(between);
        }
        between.item.turns.push(turn);
        between.item.activeMs += turn.activeMs;
      }
    }
    timed.push(...markItems);
    timed.sort((a, b) => a.at - b.at);
    return {
      stage: r.stage,
      model: r.model ?? null,
      turns: stageTurns[si],
      activeMs: sumActive(stageTurns[si]),
      items: timed.map((t) => t.item),
      current: si === currentStage,
      live: si === liveStage,
      projectedMs: null,
      upcoming: false,
    };
  });

  // The audit, projected from the project's typical one, once the walk is
  // under way and the audit has not started.
  const typicalAudit = timeline.typical_audit_ms ?? null;
  const hasAudit = rotations.some((r) => r.stage === "audit");
  const walking = rotations.some((r) => r.stage === "implement");
  if (!hasAudit && walking && !done && !stopped && typicalAudit !== null) {
    stages.push({
      stage: "audit",
      model: null,
      turns: [],
      activeMs: 0,
      items: [],
      current: false,
      live: false,
      projectedMs: typicalAudit,
      upcoming: true,
    });
  }

  const soFarMs = stages.reduce((s, st) => s + st.activeMs, 0);
  const remainingSteps =
    steps.reduce((s, st) => s + (st.state === "open" ? (st.projectedMs ?? 0) : 0), 0) +
    pending.reduce((s, p) => s + (p.projectedMs ?? 0), 0);
  const remainingAudit = stages.reduce((s, st) => s + (st.upcoming ? (st.projectedMs ?? 0) : 0), 0);
  const runEnd = through ?? (ledger.length > 0 ? ledger.length : (logSteps[0]?.total ?? null));
  const runLength = runEnd === null ? null : Math.max(0, runEnd - runStart + 1);

  return {
    before: before.length > 0 ? { turns: before, activeMs: sumActive(before) } : null,
    stages,
    pending,
    stepsDone: steps.filter((s) => s.state === "done" || s.state === "withdrawn").length,
    stepsTotal: runLength,
    medianStepMs,
    slowestStep: slowest !== null && finished.length >= 2 ? slowest.n : null,
    soFarMs,
    projectedTotalMs: projecting ? soFarMs + remainingSteps + remainingAudit : null,
    noProjection,
  };
}

/** `397050 > 300000` → `397k > 300k`; any other note verbatim. */
export function compactNoteText(note: string): string {
  const m = /^(\d+)\s*>\s*(\d+)$/.exec(note.trim());
  if (m === null) return note;
  const k = (s: string) => `${Math.round(Number(s) / 1000)}k`;
  return `${k(m[1])} > ${k(m[2])}`;
}
