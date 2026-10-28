/**
 * `restore-gate-round` — the pure fold behind the restore gate's session
 * count.
 *
 * `TugRestoreGate` tells the user how many of the sessions being restored
 * have finished: "2 of 5 sessions". That sentence is only honest if its
 * total never moves and its count never falls, and neither falls out of
 * reading the cards that hold the gate right now — a finished card stops
 * holding, so a total read off the holders shrinks as the restore
 * progresses, and pages arrive a couple at a time, so it grows as well.
 * This module decides the count instead, over **rounds**.
 *
 * ## A round's total is fixed when it opens
 *
 * A round opens when the first card holds the gate. Its members are every
 * card holding at that moment plus every card a restore pass named that
 * is still pending, and its total is the member count, which never
 * changes. The restore pass knows its shown resumed cards before any page
 * exists, so the total neither shrinks as cards finish nor grows as staged
 * pages arrive; taking the holders too covers a restore no pass named.
 *
 * A card that begins holding while a round is open, and is not a member,
 * leaves the total alone. When every member is done and it still holds, a
 * new round opens with it as a member. A round survives the gate closing
 * while any member is still pending, so a gate that drops between staged
 * pages and comes back continues the same count instead of restarting it.
 *
 * ## A session is done when its wait ends, by any exit
 *
 * A member is done once it has held and no longer holds — settled, past
 * its settle bound, past its silence deadline, or failed; the fold cannot
 * tell those apart and does not try, because each one ends the user's
 * wait. A member that never held is done once it has ended: it left the
 * deck, its page failed or was never made, or its body stopped reporting
 * that its restore is still to come. The done set only grows.
 *
 * ## Purity
 *
 * No DOM, no React, no bus, no clock. Every horizon a pending member
 * waits on belongs to the caller's facts — the restore registry's timeout,
 * the host lane's deadline, the arrival reveal — so the fold adds none.
 * It never mutates the state it is handed; every set it returns is new.
 */

/** What the fold reads of one card, fresh on every call. */
export interface RestoreCardFacts {
  /** The card holds the gate now: a body's "holding", or a shell-hosted store's deriveRestoreGateHold. */
  holding: boolean;
  /** The card's body reports "waiting": its restore is still to come. */
  waiting: boolean;
  /** The card is still a live candidate: in the deck as a body card whose state is not failed, evicted or unmade. */
  live: boolean;
  /** The card's page has painted. */
  painted: boolean;
}

export interface RestoreRound {
  readonly members: ReadonlySet<string>;
  readonly held: ReadonlySet<string>;
  readonly done: ReadonlySet<string>;
}

export interface RestoreGateFoldState {
  readonly round: RestoreRound | null;
  /** Cards a restore pass named that no round has taken yet. */
  readonly expected: ReadonlySet<string>;
  /** Cards (expected or member) that have ever reported waiting or holding. */
  readonly seen: ReadonlySet<string>;
}

export const INITIAL_FOLD: RestoreGateFoldState = {
  round: null,
  expected: new Set(),
  seen: new Set(),
};

export interface RestoreGateReading {
  open: boolean;
  sessionsDone: number;
  sessionsTotal: number;
}

export const CLOSED_READING: RestoreGateReading = {
  open: false,
  sessionsDone: 0,
  sessionsTotal: 0,
};

export function foldRestoreGate(
  prev: RestoreGateFoldState,
  input: {
    /** Every card holding the gate now. */
    holding: ReadonlySet<string>;
    /** Cards a restore pass has named since the last fold. */
    arrived: readonly string[];
    facts: (cardId: string) => RestoreCardFacts;
  },
): { state: RestoreGateFoldState; reading: RestoreGateReading } {
  const { holding, arrived } = input;

  // Facts are read at most once per card per fold.
  const cache = new Map<string, RestoreCardFacts>();
  const facts = (id: string): RestoreCardFacts => {
    let f = cache.get(id);
    if (f === undefined) {
      f = input.facts(id);
      cache.set(id, f);
    }
    return f;
  };

  // 1. Take the pass's names in, and note every card that has reported.
  let expected = new Set<string>(prev.expected);
  for (const id of arrived) expected.add(id);
  const prevMembers: ReadonlySet<string> = prev.round?.members ?? new Set();
  let seen = new Set<string>(prev.seen);
  for (const id of [...expected, ...prevMembers]) {
    const f = facts(id);
    if (f.waiting || f.holding) seen.add(id);
  }

  // 2. A card's wait has ended: it held and let go, or it left, or it
  //    stopped saying its restore is still to come.
  const ended = (id: string, held: ReadonlySet<string>): boolean => {
    const f = facts(id);
    if (f.holding) return false;
    if (held.has(id)) return true;
    if (!f.live) return true;
    return !f.waiting && (seen.has(id) || f.painted);
  };

  let round: RestoreRound | null = null;

  // 3. Advance the open round; a round whose members are all done is over.
  if (prev.round !== null) {
    const held = new Set<string>(prev.round.held);
    for (const m of prev.round.members) if (holding.has(m)) held.add(m);
    const done = new Set<string>(prev.round.done);
    for (const m of prev.round.members) if (ended(m, held)) done.add(m);
    round = done.size === prev.round.members.size
      ? null
      : { members: prev.round.members, held, done };
  }

  if (round === null) {
    if (holding.size > 0) {
      // 4. Open a new round over the holders and the pass's pending names.
      const none: ReadonlySet<string> = new Set();
      const members = new Set<string>(holding);
      for (const e of expected) if (!ended(e, none)) members.add(e);
      const held = new Set<string>();
      for (const m of members) if (holding.has(m)) held.add(m);
      round = { members, held, done: new Set() };
      expected = new Set();
    } else {
      // 5. No round and nothing holding: drop names whose wait already ended.
      const none: ReadonlySet<string> = new Set();
      const kept = new Set<string>();
      for (const e of expected) if (!ended(e, none)) kept.add(e);
      expected = kept;
    }
  }

  // 6. Remember reports only for cards still in play.
  const inPlay = new Set<string>([...expected, ...(round?.members ?? [])]);
  seen = new Set([...seen].filter((id) => inPlay.has(id)));

  // 7. The gate reads open only while something holds it.
  const state: RestoreGateFoldState = { round, expected, seen };
  if (holding.size === 0 || round === null) return { state, reading: CLOSED_READING };
  return {
    state,
    reading: {
      open: true,
      sessionsDone: round.done.size,
      sessionsTotal: round.members.size,
    },
  };
}
