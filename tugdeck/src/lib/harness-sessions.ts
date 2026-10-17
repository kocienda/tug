/**
 * The sessions the app-test harness bound by hand (`window.__tug.bindSession`),
 * on this page.
 *
 * A harness bind seats a card on a session tugcast never spawned: the test
 * drives its transcript by injecting frames, and nothing answers on the wire.
 * A real session's `CODE_INPUT` is sent, and a bound
 * card's page is allowed to send it because the deck reports the card seated
 * on the session; for a session with no ledger entry the supervisor then
 * answers `session_unknown`, and the card errors out of the very turn the
 * test is driving. So a harness session's store keeps its input off the wire
 * (`offWire` on the session's open). Its CONTROL frames still go, and the deck
 * still reports the seating, which the changeset's orphan lift reads.
 *
 * Marked only under the harness; in the product the set stays empty.
 *
 * @module lib/harness-sessions
 */

const marked = new Set<string>();

/** Mark `tugSessionId` as bound by the harness, on this page. A no-op outside the harness. */
export function markHarnessSession(tugSessionId: string): void {
  if (typeof window === "undefined" || window.__tugTestMode !== true) return;
  marked.add(tugSessionId);
}

/** Whether the harness bound `tugSessionId` by hand on this page. */
export function isHarnessSession(tugSessionId: string): boolean {
  return marked.has(tugSessionId);
}
