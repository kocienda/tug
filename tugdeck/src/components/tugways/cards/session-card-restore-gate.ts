/**
 * `session-card-restore-gate` — the pure predicate behind the Session card's
 * cold-restore window.
 *
 * On a cold relaunch a session card with a persisted session walks
 * pre-services → transport-restoring → replay preflight →
 * `phase === "replaying"` → `replay_complete`. `deriveColdRestoreActive`
 * is true for the whole of that walk and false outside it.
 *
 * It is read by two surfaces, and neither of them is a gate over the
 * card anymore. `SessionCardServicesGate` reads it only to settle the
 * restore bookkeeping — the body mounts THROUGH the replay window and
 * paints progressively, and the one window that still routes to the
 * `SessionRestoring` placeholder is `transportState === "restoring"`,
 * which this predicate has nothing to do with. What the user sees
 * during a replay is the `Z0` load-control bar's restore strip
 * (`session-load-control-bar.tsx`), whose restore arm is this predicate
 * alone. So while `deriveColdRestoreActive` is true the card is visibly
 * restoring, and the deck around it is untouched.
 *
 * ## The app-modal this replaced, and why it is not coming back
 *
 * There used to be a second reader of this predicate: `TugRestoreGate`,
 * an app-wide blocking modal at the deck root, folded across every live
 * card by `restore-gate-store.ts`. Its argument was real and is worth
 * keeping. A cold restore's reveal — mounting, laying out and measuring
 * a whole reconstructed transcript — is one uninterruptible task on the
 * single main thread every card in the one `WKWebView` shares. While it
 * runs the app answers nothing: not the restoring card, not its
 * neighbours, not the composer you are typing into. The chrome goes on
 * painting its last frame throughout, so the app *looks* live while it
 * drops every keystroke on the floor. Chunking the reveal so input could
 * interleave was tried and rejected — a transcript filling in behind the
 * user flashes and hops. Saying "busy" for exactly as long as the app is
 * busy costs the user nothing they actually had, and it is true.
 *
 * It was removed anyway, because the modal had no dismiss and its only
 * close was `replay_complete` — a frame nothing guarantees. A relay that
 * died mid-bracket left the whole app behind an undismissable panel with
 * the offending card unreachable behind it, on every launch. A silence
 * deadline was added to bound that, and a modal whose safety rests on a
 * timer is the wrong construction rather than a mis-tuned one: one card's
 * lost frame must not be able to hold the entire app, however briefly.
 * So `replaying` is now a state of one card, shown by that card's own
 * `Z0` restore strip over a body that stays mounted and usable — and a
 * card that gives up says so in its own pane banner. Neither costs the
 * deck around it anything.
 *
 * What the modal was *right* about is the reveal, and the reveal alone.
 * An honest successor would not key off this predicate at all: it would
 * be armed immediately before the body's first paint and disarmed on the
 * commit after it, bounding a task whose length the deck can see for
 * itself rather than one that waits on a wire. Nothing today needs that,
 * because the window it covers is the one the reveal takes and not the
 * one the relay takes. If a hang is ever reported *inside* the reveal,
 * that is the shape to build, and it belongs to the reveal, not here.
 *
 * Pure module — no DOM, no React, no time source.
 *
 * @module components/tugways/cards/session-card-restore-gate
 */

import type { CodeSessionSnapshot } from "@/lib/code-session-store";

/**
 * The matrix-relevant subset of `CodeSessionSnapshot` the gate reads.
 * The full snapshot structurally satisfies this — declaring the narrow
 * shape keeps the dependency surface explicit and lets a pure test
 * supply a literal without fabricating the snapshot's unrelated fields.
 */
export interface ColdRestoreSignals {
  phase: CodeSessionSnapshot["phase"];
  sessionMode: CodeSessionSnapshot["sessionMode"];
  replayPreflightActive: boolean;
  lastError: CodeSessionSnapshot["lastError"];
}

/**
 * True while a cold restore's replay window is still in progress —
 * the window the `SessionRestoring` placeholder holds across.
 *
 * It spans the cold-boot preflight beat (`replayPreflightActive`,
 * opened by `notifyResumeBindingLanded` and cleared by the first
 * `replay_started` / outcome / 12s tick) and the `phase === "replaying"`
 * window that follows (closed by `replay_complete`, or by the silence
 * deadline below), gated to `sessionMode === "resume"` so a fresh
 * new-mode binding's brief JSONL-missing round-trip is not gated.
 *
 * A non-null `lastError` forces the predicate false: any error must
 * mount the body so its error banner shows and `useSessionCardObserver`
 * can route a `resume_failed` back to the picker — the placeholder
 * never swallows a failure.
 *
 * That clause is also what bounds the `replaying` window. Nothing on the
 * wire is guaranteed to end it, so the store ends it on silence: past
 * `REPLAY_SILENCE_DEADLINE_MS` with no frame it raises a `replay_stalled`
 * `lastError`, and the predicate falls here.
 */
export function deriveColdRestoreActive(s: ColdRestoreSignals): boolean {
  if (s.lastError !== null) return false;
  if (s.replayPreflightActive) return true;
  return s.phase === "replaying" && s.sessionMode === "resume";
}
