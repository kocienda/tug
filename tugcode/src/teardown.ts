/**
 * Why tugcode is tearing a claude process down.
 *
 * Every teardown names its reason, because the teardown — not its caller —
 * decides what happens to a turn that is still running: an open turn with no
 * result is ended as a recovery cancel, so the stream's EOF closes it as
 * `turn_cancelled` rather than as the `error` the deck draws as the Protocol
 * error banner. That banner is for Claude dying on its own, and nothing else.
 *
 * The reasons are of two kinds. A reason that **may end a turn** is a
 * deliberate act that retires the process whatever it was doing. A reason
 * that **must not end a turn** is refused or deferred by its caller while a
 * turn runs; one that reaches the teardown with a turn open anyway is a bug in
 * that guard, which the teardown logs and still answers with a clean cancel.
 */
export type TeardownReason =
  // May end a turn.
  | "rotation"
  | "new"
  | "fork"
  | "continue"
  | "shutdown"
  | "force_terminate"
  | "stop_all"
  | "reattach"
  // Must not end a turn.
  | "effort"
  | "directory"
  | "rewind"
  | "retraction";

const MUST_NOT_END_A_TURN: ReadonlySet<TeardownReason> = new Set([
  "effort",
  "directory",
  "rewind",
  "retraction",
]);

/** Whether a teardown for `reason` is one that must never meet an open turn. */
export function mustNotEndATurn(reason: TeardownReason): boolean {
  return MUST_NOT_END_A_TURN.has(reason);
}
