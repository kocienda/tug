/**
 * resting-line.ts — what the PULSE's activity level says when the session
 * is not saying anything.
 *
 * A session at rest has two ways of getting there, and they are different
 * readings:
 *
 *  - it finished a turn. The voice's last beat is the bare marker `Done`
 *    ({@link TURN_DONE_MARKER}, written by `tugcode/src/pulse/voice.ts`'s
 *    `onTurnEnd`), which is a good wire marker and a poor thing to read off
 *    a rail — it says the run ended and nothing about when, and it sits
 *    there unchanged for however long the session stays quiet.
 *  - it has never spoken at all. Nothing has happened since it was made.
 *
 * Both become a sentence with a date and a time in it and the same closing
 * word: `Completed at Jul 30, 7:15 PM. Ready.` / `Created at Jun 17, 6:11 AM.
 * Ready.` The stamp is what turns a stale-looking line into a fact — a row
 * that says `Done` reads the same after five seconds and five hours — and
 * `Ready.` is what the state actually is, said in the same breath.
 *
 * The DAY is always there, never dropped for a timestamp that happens to be
 * today's. A rail of resting rows is read by comparing them to each other, and
 * a column where some rows carry a day and some do not is a column the eye has
 * to sort before it can compare — and the one row that stayed short is exactly
 * the one whose day the reader then has to infer.
 *
 * @module lib/pulse-line/resting-line
 */

/**
 * The turn-end beat, verbatim as the voice emits it. Recognized here rather
 * than rewritten upstream: the marker is what the ledger, the history
 * popover, and a copied line carry, and only the resting reading changes.
 */
export const TURN_DONE_MARKER = "Done";

/** The word every resting line closes on — the state, not the history. */
const READY = "Ready.";

/**
 * Wall stamp for a resting line: `Jun 17, 6:11 AM`. Locale-formatted, so a
 * 24-hour locale gets its own clock and a locale that writes the day first
 * gets that.
 *
 * The day and the clock are formatted separately and joined here rather than
 * asked for in one call: a single `toLocaleString` for both writes its own
 * connective — `Jun 17 at 6:11 AM` — and the sentence around this already
 * supplies one, which lands as `Created at Jun 17 at 6:11 AM`.
 */
export function formatRestingStamp(atMs: number): string {
  const at = new Date(atMs);
  const day = at.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const clock = at.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${day}, ${clock}`;
}

/**
 * The resting reading for a session whose last beat was the turn-end marker.
 * `atMs` is that beat's own timestamp, so the sentence dates the completion
 * rather than the render.
 */
export function completedRestingLine(atMs: number): string {
  return `Completed at ${formatRestingStamp(atMs)}. ${READY}`;
}

/**
 * The same reading with the turn's own goal in front of it:
 * `Finished: <intent>. Completed at Jul 30, 7:15 PM. Ready.`
 *
 * The voice keeps the retained intent across the turn-end marker ([P09].2),
 * and this is what that costs nothing to say: a card at rest can name what it
 * last finished rather than only when it stopped. Read on the wall register,
 * where a session is being WATCHED and "what did that one just do" is the
 * question the row is being asked; the one-line register keeps
 * {@link completedRestingLine}, which is what fits there.
 */
export function completedWithIntentRestingLine(
  intent: string,
  atMs: number,
): string {
  return `Finished: ${intent}. ${completedRestingLine(atMs)}`;
}

/**
 * The resting reading for a session that has said nothing yet — the state
 * the Cards card shows for the whole life of a session nobody has prompted.
 *
 * A null `createdAtMs` is the window before the session ledger answers. The
 * line still reads as the state it is; it just cannot date it yet.
 */
export function createdRestingLine(createdAtMs: number | null): string {
  if (createdAtMs === null) return READY;
  return `Created at ${formatRestingStamp(createdAtMs)}. ${READY}`;
}

/**
 * The activity string a row should show, given the latest beat's text and
 * timestamp (both null when the session has never spoken) and the session's
 * creation time.
 *
 * Every beat but the turn-end marker passes through untouched: the resting
 * reading replaces the two lines that describe an absence, and nothing the
 * voice actually said.
 */
export function restingActivityText(
  latest: { text: string; atMs: number; intent?: string } | null,
  createdAtMs: number | null,
): string {
  if (latest === null) return createdRestingLine(createdAtMs);
  if (latest.text === TURN_DONE_MARKER) {
    return latest.intent !== undefined && latest.intent.length > 0
      ? completedWithIntentRestingLine(latest.intent, latest.atMs)
      : completedRestingLine(latest.atMs);
  }
  return latest.text;
}
