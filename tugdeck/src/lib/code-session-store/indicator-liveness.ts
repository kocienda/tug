/**
 * indicator-liveness.ts — the one vocabulary every {@link
 * TugProgressIndicator} call site derives its `state` from.
 *
 * **The rule: motion means the machine is doing something right now.**
 * The indicator's `running` state is the only one that breathes, and a
 * breathing glyph is a claim about the present tense. Everything else is
 * a pose:
 *
 *  - `running`   — work is executing this instant. Breathes.
 *  - `paused`    — blocked, and cannot proceed until something outside the
 *                  runtime arrives. Still, full-size, and substantial on
 *                  the presence ladder (0.7). Nothing maps to it today:
 *                  the waits this app actually has are waits on the USER,
 *                  and those pulse — see below.
 *  - `stopped`   — not executing. Covers "never started", "deferred to a
 *                  clock", and "no longer relevant" alike. Recedes.
 *  - `completed` — finished, successfully.
 *  - `aborted`   — finished, badly.
 *
 * The distinction this module exists to hold is between *executing* and
 * *pending*, which are not the same thing and were conflated at four
 * independent call sites before this module existed. A question waiting
 * a cron scheduled for tomorrow and a goal set an hour ago are pending;
 * neither is executing; neither may breathe. They rest at `stopped`,
 * because what they are waiting on is a clock or an occasion — nothing a
 * person can walk over and answer.
 *
 * **Waiting on the USER is the exception, and it moves.** A turn parked on
 * an approval is open — submitted, not committed, resuming the instant the
 * user answers — and so is the tool call that dialog is blocked on. That is
 * not pending in the sense above: the work is underway and the user is
 * standing in it. It is also the one condition in the app whose entire
 * purpose is to be noticed, from a Cards card rail across the room, so it takes
 * the caution tone AND the pulse. Every yellow dot in the app says the same
 * thing the same way: answer me.
 *
 * Deriving `state` anywhere but here is how that conflation happened the
 * first time. New indicator surfaces add a function to this module rather
 * than an inline ternary at the call site, and `indicator-liveness.test.ts`
 * holds every derivation to the rule above.
 *
 * @module lib/code-session-store/indicator-liveness
 */

import type { TugProgressIndicatorState } from "@/components/tugways/tug-progress-indicator";

import type { GoalState } from "./select-goal";
import type { JobStatus } from "./select-jobs";
import type { TaskStatus } from "./select-task-list";

/**
 * The states that breathe. Exported so the guard test can assert the rule
 * from the outside rather than restating it.
 */
export const LIVE_INDICATOR_STATES: ReadonlySet<TugProgressIndicatorState> =
  new Set<TugProgressIndicatorState>(["running"]);

/**
 * A task row's state — the task's own status, gated on the session
 * actually working.
 *
 * `in_progress` is a claim the assistant wrote into its checklist, not an
 * observation of the runtime: a session that stops mid-turn leaves the row
 * saying `in_progress` forever. The `idle` gate is what keeps the glyph
 * honest — the checklist still reads "in progress", the dot does not
 * claim it is happening.
 */
export function taskRowState(
  status: TaskStatus,
  idle: boolean,
): TugProgressIndicatorState {
  if (status === "completed") return "completed";
  if (status === "in_progress") return idle ? "stopped" : "running";
  return "stopped";
}

/**
 * A job row's state.
 *
 * `scheduled` is `stopped`, not `running`: a wakeup promised for tomorrow
 * is not work in flight, and a glyph that breathes all night on its behalf
 * is describing something that is not happening. The row label's countdown
 * already carries the "later, not now" reading, and carries it better than
 * motion can — it says *when*.
 */
export function jobRowState(status: JobStatus): TugProgressIndicatorState {
  switch (status) {
    case "running":
      return "running";
    case "scheduled":
      return "stopped";
    case "completed":
      return "completed";
    case "failed":
      return "aborted";
    case "stopped":
      return "stopped";
  }
}

/**
 * A plan-ledger row's state — the arc's own step list, gated on the arc.
 *
 * `in progress` is a cell a step verb wrote into a document, not an
 * observation of anything running: a run that stopped mid-step leaves the row
 * saying `in progress` for as long as the plan sits on disk. So the cell alone
 * may not breathe — something has to say the walk is still under way.
 *
 * **For a ledger row that something is the arc, not the card.** A task row's
 * gate is its session's turn state, because a checklist has no other witness;
 * an arc has its own record, and a wheel that holds it between rotations. A
 * card sits idle for the seconds between the round it just finished and the
 * one the wheel is about to seat, and gating on the card made every dot rest
 * through those seconds while the track beside them painted the same step
 * `active`. `live` is {@link ArcTrackModel.live} — the arc is running, or a
 * holder is working — which is the fact the ticks are already drawn from, so
 * the two readings of one ledger cannot disagree.
 *
 * `withdrawn` is a step the run decided not to walk, and it reads `completed`
 * for the same reason every other closed-count does: the row is over. Resting
 * it at `stopped` instead would make it indistinguishable from `pending`,
 * which is also where an unstarted row rests.
 *
 * Every other spelling rests at `stopped`, the conservative reading and the
 * one the plan-doc scan takes for the same cell.
 */
export function ledgerRowState(
  status: string,
  live: boolean,
): TugProgressIndicatorState {
  if (status === "done" || status === "withdrawn") return "completed";
  if (status === "in progress") return live ? "running" : "stopped";
  return "stopped";
}

/**
 * The goal row's state.
 *
 * A goal is not work — it is a standing condition on the session, set once
 * and evaluated at the end of turns that happen for their own reasons.
 * `active` therefore means "still set", never "executing", so it rests at
 * `stopped`; the evaluator's rounds are visible in the row's own text.
 */
export function goalRowState(goal: GoalState): TugProgressIndicatorState {
  if (goal.status === "achieved") return "completed";
  return "stopped";
}
