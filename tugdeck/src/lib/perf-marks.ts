/**
 * `perf-marks` — the one gate over every `tug:` performance mark.
 *
 * The settle's instruments grew one call site at a time, and each of them
 * wrote `performance.mark("tug:…")` straight onto the global timeline. That is
 * cheap per call and not free: the marks accumulate in the User Timing buffer
 * for the life of the page, every one of them on a release instance nobody is
 * measuring, and a bench leg reading `getEntriesByName` gets the marks of
 * every gesture since boot rather than the marks of the gesture it made.
 *
 * So there is one door, and two things are true of it.
 *
 * **It is closed unless somebody is reading.** A mark is written only when the
 * page is in test mode (`window.__tugTestMode`, injected by the DEBUG Swift
 * host and by nothing else) or when the deck trace is recording — the same two
 * audiences every other instrument on this deck answers to. A shipping
 * instance writes nothing, which is what [D1]'s settled-surface rule asks of a
 * measurement: a probe that arms itself on a shipping path has stopped being a
 * probe.
 *
 * **A reader can clear it.** {@link clearMarks} drops every standing mark, so
 * an arm can declare that the timeline from here belongs to the gesture in
 * hand. Without it a leg's `tug:react-notify` is the twelfth one since launch
 * and the leg has no way to know which.
 *
 * The gate is read per call rather than cached, because both inputs move at
 * runtime: a test flips `__tugTestMode` before the deck mounts, and
 * `deckTrace.enable(true)` arrives from an `/api/eval` in the middle of a
 * session. Both reads are property lookups; the thing being avoided is the
 * mark, not the branch.
 *
 * @module lib/perf-marks
 */

import { deckTrace } from "@/deck-trace";

/**
 * Whether anything is reading the timeline this instant.
 *
 * Exported as {@link marksEnabled} for the one call site that has to ask
 * rather than just write: `action-dispatch.ts` places two of its marks from a
 * microtask and a zero timer, and scheduling those inside the gesture's own
 * task for a mark that will be discarded is this module's own cost spent
 * again a layer up. Every other site writes the mark and lets the gate
 * decide.
 */
function marksOn(): boolean {
  return window.__tugTestMode === true || deckTrace.isEnabled();
}

/** {@link marksOn}, for a caller that must not schedule the work either. */
export function marksEnabled(): boolean {
  return marksOn();
}

/**
 * Write a `tug:` mark, if anyone is reading.
 *
 * Every `performance.mark("tug:…")` on this deck goes through here. A call
 * site that writes one directly is the defect this module exists to remove,
 * and as of this writing there is no direct call site left. **Nothing
 * enforces that.** A check was described here once — a grep in an app-test
 * step checkpoint — and it was never built, so the invariant holds by
 * convention and by review, which is what a reader should assume rather
 * than trusting a guard that is not there.
 */
export function mark(name: string): void {
  if (!marksOn()) return;
  performance.mark(name);
}

/**
 * Drop every standing performance mark.
 *
 * Called by `armSettleFrameProbe` (`test-surface.ts` ~3104) and by nothing
 * else, so that a reading taken after a gesture describes that gesture.
 *
 * **The settle's own `arm` deliberately does NOT call this, and must not.**
 * `arm` runs in the same task as the gesture that caused the commit, and the
 * marks written earlier in that task — `tug:set-pane-folded` lands ~3 ms
 * before `tug:arm-end` — are precisely the ones a fold reading depends on. A
 * clear at the arm's entry would destroy the reading one step after it was
 * built. The rule: a mark-clearing point must sit OUTSIDE the gesture's task,
 * and the settle's arm is inside it
 * (`briefs/deck-animation-pipeline-findings.md`, step 7).
 *
 * It clears the WHOLE buffer
 * rather than the `tug:` names alone: the buffer is ours in test mode, the
 * trace's own rows live elsewhere, and a selective clear would mean keeping a
 * list of names in sync with thirty call sites.
 *
 * Gated with the writer, so a shipping instance never touches the buffer at
 * all — clearing marks nobody wrote would be a second pointless cost in the
 * one window [D9] forbids main-thread work in.
 */
export function clearMarks(): void {
  if (!marksOn()) return;
  performance.clearMarks();
}
