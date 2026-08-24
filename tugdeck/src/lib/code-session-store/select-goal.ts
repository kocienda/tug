/**
 * Goal-state model + pure reducers for the `/goal` command.
 *
 * A `/goal <condition>` run is ONE result cycle on the wire: claude's
 * Stop-hook evaluator injects synthetic user events into the same cycle to
 * keep the assistant working, and tugcode translates each into a
 * `goal_feedback` IPC frame (condition + the evaluator's latest reason).
 * There is no dedicated goal-state wire event, so everything the deck knows
 * about a goal is reduced from three signals (probe-pinned in
 * `tugcode/probes/goal-loop/FINDINGS.md#q01-goal`):
 *
 *   1. the user's own `/goal …` submission (set / clear / status),
 *   2. `goal_feedback` frames while the run is live,
 *   3. the goal cycle's terminal `turn_complete` (achieved).
 *
 * Lifetime rules (plan S04, `dash/slash-command-plan.md`):
 *   - live-only — replay never populates goal state (`add_user_message`
 *     frames are not reduced here, and tugcode's replay translator skips
 *     `isSynthetic` entries), so a reloaded card starts with `goal: null`;
 *   - a goal survives a respawn in-memory as possibly-active — the next
 *     observed signal settles it;
 *   - residual feedback after a clear never resurrects (the evaluator can
 *     trail a `/goal clear` by a round or two).
 */

/** The deck's view of the session's one goal (claude allows one per session). */
export interface GoalState {
  /** The condition text, verbatim as submitted / echoed by the evaluator. */
  readonly condition: string;
  readonly status: "active" | "achieved" | "cleared";
  /** Evaluator rounds observed (`goal_feedback` frames). */
  readonly turnsEvaluated: number;
  /** The evaluator's most recent "not met because …" explanation. */
  readonly latestReason: string | null;
  /** Submit wall-clock; null when the goal was recovered from a feedback frame. */
  readonly setAtMs: number | null;
  /**
   * The turnKey of the result cycle the goal is running in — the goal-set
   * submission's pendingTurn (or the in-flight turn a recovered goal was
   * first observed in). `handleTurnComplete` flips `active → achieved` when
   * THIS cycle commits successfully; null when unknown.
   */
  readonly cycleTurnKey: string | null;
}

/**
 * Upstream's accepted clear aliases (`/goal clear|stop|off|reset|none|cancel`),
 * per the Claude Code commands reference.
 */
const GOAL_CLEAR_ALIASES: ReadonlySet<string> = new Set([
  "clear",
  "stop",
  "off",
  "reset",
  "none",
  "cancel",
]);

/** What a `/goal …` submission asks for. */
export type GoalCommand =
  | { kind: "set"; condition: string }
  | { kind: "clear" }
  | { kind: "status" };

/**
 * Parse a plain `/goal …` command line. Returns null for any line that is
 * not a `/goal` command. Alias matching is case-insensitive and exact-word
 * (a condition that merely *starts* with "stop the server…" is a set).
 */
export function parseGoalCommand(line: string): GoalCommand | null {
  const m = /^\/goal(?:\s+([\s\S]*))?$/.exec(line.trim());
  if (m === null) return null;
  const args = (m[1] ?? "").trim();
  if (args.length === 0) return { kind: "status" };
  if (GOAL_CLEAR_ALIASES.has(args.toLowerCase())) return { kind: "clear" };
  return { kind: "set", condition: args };
}

/**
 * Reconstruct a plain command line from the send action's synthesized
 * substrate: `text` carries `U+FFFC` at each atom position, `atoms` in
 * order. A command atom renders as `/<value>`, an image atom drops, any
 * other atom contributes its value — the same rendering contract as
 * `buildSlashCommandLine`, restated over the ordered-substitution shape
 * the reducer receives (no per-atom positions on the wire event).
 */
export function commandLineFromSend(
  text: string,
  atoms: ReadonlyArray<{ readonly type: string; readonly value: string }>,
  atomChar: string,
): string {
  if (atoms.length === 0) return text;
  let out = "";
  let atomIndex = 0;
  for (const ch of text) {
    if (ch !== atomChar) {
      out += ch;
      continue;
    }
    const atom = atoms[atomIndex];
    atomIndex += 1;
    if (atom === undefined) continue;
    if (atom.type === "command") out += `/${atom.value}`;
    else if (atom.type === "image") continue;
    else out += atom.value;
  }
  return out;
}

/**
 * Fold a user submission into the goal state. A set replaces any prior
 * goal (upstream: one goal per session, a new one replaces it); a clear
 * flips an existing goal to `cleared` (and is a no-op with nothing set);
 * a bare status query never mutates.
 */
export function reduceGoalOnSend(
  goal: GoalState | null,
  commandLine: string,
  submitAtMs: number,
  turnKey: string,
): GoalState | null {
  const cmd = parseGoalCommand(commandLine);
  if (cmd === null || cmd.kind === "status") return goal;
  if (cmd.kind === "clear") {
    return goal === null || goal.status !== "active"
      ? goal
      : { ...goal, status: "cleared" };
  }
  return {
    condition: cmd.condition,
    status: "active",
    turnsEvaluated: 0,
    latestReason: null,
    setAtMs: submitAtMs,
    cycleTurnKey: turnKey,
  };
}

/**
 * Fold a `goal_feedback` frame into the goal state. Bumps the active
 * goal's round count and latest reason; recovers a possibly-active goal
 * from the frame when the deck has none (e.g. the card bound mid-run);
 * never resurrects a cleared/achieved goal (residual evaluator rounds
 * trail a clear).
 */
export function reduceGoalOnFeedback(
  goal: GoalState | null,
  condition: string,
  reason: string,
  currentTurnKey: string | null,
): GoalState | null {
  if (goal === null) {
    return {
      condition,
      status: "active",
      turnsEvaluated: 1,
      latestReason: reason,
      setAtMs: null,
      cycleTurnKey: currentTurnKey,
    };
  }
  if (goal.status !== "active") return goal;
  return {
    ...goal,
    condition,
    turnsEvaluated: goal.turnsEvaluated + 1,
    latestReason: reason,
    // Adopt the cycle when the goal was set before its turn opened.
    cycleTurnKey: goal.cycleTurnKey ?? currentTurnKey,
  };
}

/**
 * Settle the goal at its cycle's commit: a successful `turn_complete` of
 * the goal's own result cycle means the evaluator passed — the run ended
 * with the condition met. An errored/interrupted cycle leaves the goal
 * `active` (possibly-active): claude-side goal state may survive the
 * abort, and the next signal (feedback, clear, new set) settles it.
 */
export function settleGoalOnCycleCommit(
  goal: GoalState | null,
  committedTurnKey: string | null,
  success: boolean,
): GoalState | null {
  if (
    goal === null ||
    goal.status !== "active" ||
    !success ||
    committedTurnKey === null ||
    goal.cycleTurnKey !== committedTurnKey
  ) {
    return goal;
  }
  return { ...goal, status: "achieved" };
}

/** True while a goal is live — the WORK cell's "active goal" signal. */
export function goalIsActive(goal: GoalState | null): boolean {
  return goal !== null && goal.status === "active";
}
