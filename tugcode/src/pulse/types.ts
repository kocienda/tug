/**
 * Wire types for the PULSE facility — the line frames the commentator
 * daemon answers with. (The daemon's INPUT is spliced tugcode
 * outbound frames, typed by `../types`; see `pulse/intake.ts`.)
 *
 * @module pulse/types
 */

/** One commentator line, broadcast on the PULSE feed and ledgered. */
export interface PulseLine {
  type: "pulse";
  /**
   * The single-line commentary text. Bounded only by the daemon's transport
   * guards (`PHRASE_GUARD` / `LINE_CLIP` in `voice.ts`), which sit far above
   * any display width on purpose: how much of a line fits is the DECK's to
   * decide, at the width the surface actually has.
   */
  text: string;
  /**
   * The retained high-level thought behind a low-level `text` beat —
   * the assistant's last substantive monologue line, carried while a
   * tool chain runs so the deck can render "intent • action". Absent
   * when `text` is itself the monologue or a turn-boundary marker.
   */
  intent?: string;
  /** Scopes the source beat covered — always one session id in the
   *  per-scope beat design; an array on the wire for compatibility. */
  scopes: string[];
  /** Monotonic beat counter within the daemon's lifetime. */
  beat: number;
  /** Daemon wall-clock ms at emission. */
  at: number;
}
