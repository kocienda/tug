/**
 * session-line-store.ts — the deck's map from a claude session id to the
 * **line of work** it is a segment of ([P12]).
 *
 * A card accumulates a session id per rotation, per rewind, per respawn. The
 * callsign, the user's `/rename`, the rolling synopsis, the staged context and
 * the `/btw` history all belong to the conversation rather than to whichever id
 * is seated right now — so every one of those caches is keyed by **line id**,
 * and this store is the one place a session id turns into one.
 *
 * Two directions, and they answer different questions:
 *
 * - {@link SessionLineStore.lineOf} — "whose line is this segment?" Every frame
 *   that carries a `(session_id, line_id)` pair records it, so a citation
 *   naming a segment nobody is seated on still resolves to the right identity.
 * - {@link SessionLineStore.seatOf} — "which segment does this line address
 *   right now?" A callsign is the line's, but `/resume stocky-pixie` has to
 *   hand a *session id* to the spawn, and a session-phase read has to name the
 *   segment whose process is running. Only frames that say where a line is
 *   seated — the spawn ack, the card bindings, the picker's per-line rows, a
 *   rebind — move the seat.
 *
 * Both maps are pure cache: a line no frame has mentioned this run is unknown
 * here even though the ledger holds it, and the callers say so rather than
 * guessing. The server is authoritative for both directions.
 *
 * **Laws:** [L02] — external state enters React through `useSyncExternalStore`,
 * and the version token is the whole-store snapshot for a consumer that derives
 * from many entries at once.
 *
 * @module lib/session-line-store
 */

class SessionLineStore {
  private lineBySession = new Map<string, string>();
  private seatByLine = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** A monotonic token that bumps on every change — the whole-store snapshot. */
  getVersion = (): number => this.version;

  /**
   * The line `sessionId` is a segment of, or `null` when no frame this run has
   * said.
   *
   * Callers that need a key rather than an answer should use
   * {@link identityKeyForSession}, which falls back to the session id itself so
   * an optimistic write made before the pair arrives still finds its way home.
   */
  lineOf = (sessionId: string): string | null =>
    this.lineBySession.get(sessionId) ?? null;

  /** The segment `lineId` is currently seated on, or `null` when unknown. */
  seatOf = (lineId: string): string | null => this.seatByLine.get(lineId) ?? null;

  /**
   * Record that `sessionId` is a segment of `lineId`, without moving the seat.
   *
   * For frames that merely *mention* a segment — a citation resolution, a push
   * about a row that is not the line's tip.
   */
  bind(sessionId: string, lineId: string): void {
    this.write(sessionId, lineId, false);
  }

  /**
   * Record the pair **and** seat the line on `sessionId` — for a frame that
   * says where the line is: the spawn ack, a card binding, a picker row (whose
   * `session_id` is the resume segment), a rebind after a fresh line was born.
   */
  seat(sessionId: string, lineId: string): void {
    this.write(sessionId, lineId, true);
  }

  /**
   * Forget a segment — a trashed session. The line's seat is dropped only when
   * this segment was the one holding it, so trashing an old segment does not
   * unseat the line the user is working in.
   */
  forgetSession(sessionId: string): void {
    const lineId = this.lineBySession.get(sessionId);
    if (lineId === undefined) return;
    this.lineBySession.delete(sessionId);
    if (this.seatByLine.get(lineId) === sessionId) this.seatByLine.delete(lineId);
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  private write(sessionId: string, lineId: string, seat: boolean): void {
    const session = sessionId.trim();
    const line = lineId.trim();
    if (session.length === 0 || line.length === 0) return;
    const boundAlready = this.lineBySession.get(session) === line;
    const seatedAlready = !seat || this.seatByLine.get(line) === session;
    if (boundAlready && seatedAlready) return;
    this.lineBySession.set(session, line);
    if (seat) this.seatByLine.set(line, session);
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

/** Module-scope singleton — mirrors the other per-session stores' usage shape. */
export const sessionLineStore = new SessionLineStore();

/**
 * The key the identity caches (name / tag / synopsis) hold a session's values
 * under: its line when one is known, else the session id itself.
 *
 * The fallback is what makes an optimistic write safe. A spawn seeds the
 * callsign the instant the drop lands, and the pair reaches this store in the
 * same breath — but a session the deck learned about from a bare push, before
 * any frame carried its line, would otherwise have nowhere to put what it
 * knows. Keying it under its own id is a line of one, which is exactly what a
 * session with no recorded line is.
 */
export function identityKeyForSession(sessionId: string): string {
  return sessionLineStore.lineOf(sessionId) ?? sessionId;
}
