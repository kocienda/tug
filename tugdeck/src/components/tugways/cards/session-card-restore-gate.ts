/**
 * `session-card-restore-gate` — the pure predicate behind the Session card's
 * cold-restore window.
 *
 * On a cold relaunch a session card with a persisted session walks
 * pre-services → transport-restoring → replay preflight →
 * `phase === "replaying"` → `replay_complete`. `deriveColdRestoreActive`
 * is true for the whole of that walk and false outside it.
 *
 * It is read by three surfaces. `SessionCardServicesGate` reads it only
 * to settle the restore bookkeeping — the body mounts THROUGH the replay
 * window and paints progressively, and the one window that still routes
 * to the `SessionRestoring` placeholder is `transportState ===
 * "restoring"`, which this predicate has nothing to do with. The `Z0`
 * load-control bar's restore strip (`session-load-control-bar.tsx`)
 * reads it as its restore arm, so while `deriveColdRestoreActive` is true
 * the card is visibly restoring. And `restore-gate-store.ts` folds it
 * across every live card for `TugRestoreGate`, the app-wide blocking
 * modal at the deck root.
 *
 * ## The app-modal, and why it stands
 *
 * A cold restore's reveal — mounting, laying out and measuring a whole
 * reconstructed transcript — is one uninterruptible task on the single
 * main thread every card in the one `WKWebView` shares. While it runs
 * the app answers nothing: not the restoring card, not its neighbours,
 * not the composer you are typing into. The chrome goes on painting its
 * last frame throughout, so the app *looks* live while it drops every
 * keystroke on the floor. Chunking the reveal so input could interleave
 * was tried and rejected — a transcript filling in behind the user
 * flashes and hops. Saying "busy" for exactly as long as the app is busy
 * costs the user nothing they actually had, and it is true.
 *
 * The gate has no dismiss and its close is `replay_complete`, a frame
 * nothing on a wire guarantees, so a relay that dies mid-bracket could
 * once hold the whole app behind it on every launch. The replay silence
 * deadline (`REPLAY_SILENCE_DEADLINE_MS`, `code-session-store/reducer.ts`)
 * bounds that: a card that hears nothing for the deadline raises an error
 * on itself, which drops it out of the fold and shows the failure on that
 * card alone. The gate was deleted once under [L33] in favour of the
 * per-card strip alone, and then a deck-owned reveal cover; both left the
 * deck looking blank or live while it was neither, and the gate was
 * brought back by decision on 2026-10-07. See the note at the permitted
 * shape in `tuglaws/no-wait-without-a-horizon.md`.
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
