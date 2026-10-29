/**
 * join-offer-reveal — whether an *unbidden* Changes reveal may fire.
 *
 * A finished arc raises a standing join offer, and the Session card answers it
 * by opening the Changes room armed — the entry the user would have made by
 * hand. That entry is unbidden, so it is fenced: it fires only at a quiet
 * moment, only once per thing the arc needs, and only into a form that can
 * show what it opens.
 *
 * **What it reveals on is the board's attention fact ([B04]).** The board
 * publishes one per ready arc, and the one reason it has is a standing offer:
 * the arc's audit stands on the live base, so the decision is the user's.
 * The gate and the memory key on the attention key, so an offer seen once is
 * not shown again until new work makes a new one.
 *
 * The predicate lives here, apart from the card, because it is the decision
 * rather than the plumbing. Every condition is a *dependency* of the effect
 * that calls it, never a peek at a ref — a deferral has to re-run on its own
 * when the turn settles, the shade closes, or the user unfolds the card. Read
 * as refs they would defer forever, since nothing would wake the effect once
 * the attention stopped changing. A half-typed composer is not a hold ([B05]):
 * text in the composer is not a reason to keep a ready join out of sight, and
 * the effect had no reliable re-arm on it.
 *
 * **Folded is the condition this module was written for ([B06]).** The Changes
 * shade is a view swap over the top column, and on a settled folded card that
 * column is the Z2 instrument row — so a shade raised there covers the fold
 * control with a scrim that keeps pointer events, and the act it offers lives
 * in Z5, which the fold has made zero-height and inert. The room would be open
 * behind a door nobody can reach. Deferring instead costs nothing, because
 * `folded` is a dependency: the user's own unfold re-runs the effect and the
 * room opens armed, exactly as it would have on an open card.
 *
 * **Never over this card's own landing.** A Join press parks the join, exits
 * the mode and hides the shade, and in the very next commit every other
 * condition reads clear: no landing up, the shade down, the composer restored
 * to an empty prompt. Without a hold of its own the reveal re-entered the mode
 * there and raised the shade back over the join the user had just pressed,
 * which took the register's subject with it. So a landing in flight defers
 * like the rest, and because it is a dependency the deferral re-runs when the
 * join settles — by which point a landed arc no longer carries an offer.
 *
 * **Every door spends, not only this one.** What the memory records is that
 * the reader has been shown this work in this room, and the room is the same
 * room whichever door opened it — the Z4A segment, ⌃⌘C, the Session menu,
 * `/arc-join`, an Arcs card row, or the passive reveal itself. So the work is
 * spent by join mode becoming active for the offered arc
 * ({@link JoinOfferMemory.spendOnEntry}), the one place all of them pass
 * through, and not by the reveal that happened to fire. A room opened by hand
 * while the gate was holding no longer leaves its work unspent for the reveal
 * to re-open the moment the user closes it.
 *
 * The work must **not** be spent on a refusal. Spending it is what says "the
 * reader has seen this work", and a reveal that never happened showed them
 * nothing.
 *
 * **The key is the board's attention key, never the arc head.** It is minted
 * from the server's work id — the rounds' count and messages, which a base
 * move's replay keeps, so a neighbour's join does not read here as new work
 * and a new round still does.
 *
 * @module lib/join-offer-reveal
 */

/** The three readings that together say a join from this card is running. */
export interface LandingInFlightInput {
  /** The join mode's register is narrating a press this composer made. */
  readonly narrating: boolean;
  /** The join store's last beat for the offered arc, or null when none is. */
  readonly landProgress: { readonly terminal?: boolean } | null;
  /** The verb store's join phase for this card's entry key. */
  readonly joinPhase: string;
}

/**
 * Whether this card has a landing in flight for the offered arc.
 *
 * Any one reading is enough, because each covers a different stretch of the
 * press: the narration is aimed at the press itself, the store's beat is
 * seeded at the press and runs until the terminal frame, and the verb's
 * `pending` spans the request and its reply. A gap between any two of them is
 * a commit the reveal could have fired in.
 *
 * **A terminal beat outranks the narration.** The register keeps narrating
 * after its join has settled — a success rests on its sentence, a failure
 * keeps it indefinitely as the standing surface for the one outcome that still
 * wants an act — so a narration alone is not a join running. Read as one, a
 * failed join would hold the reveal for the rest of the mount, and the dot
 * would say the room opens "when this join settles" over a join that had.
 * The narration counts only where there is no beat to read.
 */
export function isLandingInFlight(input: LandingInFlightInput): boolean {
  if (input.joinPhase === "pending") return true;
  if (input.landProgress !== null) return input.landProgress.terminal !== true;
  return input.narrating;
}

/** Everything the gate reads. All of it is passed; nothing is fetched. */
export interface JoinOfferRevealInput {
  /** Whether this work has already been revealed on this mount. */
  readonly alreadyRevealed: boolean;
  /** Whether this card's own landing of the offered arc is in flight. */
  readonly landingInFlight: boolean;
  /** Whether a turn is in flight — entering would cover what is being read. */
  readonly turnInFlight: boolean;
  /** Whether any landing is already up. */
  readonly anyLandingActive: boolean;
  /** Whether a shade is already showing. */
  readonly shadeShowing: boolean;
  /** Whether the card wears the folded form ([P01], [P03]). */
  readonly folded: boolean;
}

/** Why the passive reveal is not firing — the gate's first failing input. */
export type JoinOfferRevealHold =
  | "already-shown"
  | "landing-in-flight"
  | "folded"
  | "turn-in-flight"
  | "landing-active"
  | "shade-showing";

/**
 * The gate's first failing reason, or `null` when the reveal may fire now.
 *
 * Every reason but `already-shown` is a *deferral* rather than a refusal:
 * every input is a dependency of the calling effect, so the answer is asked
 * again the moment any of them moves. `already-shown` is the room's memory
 * saying it has nothing new to show.
 */
export function joinOfferRevealHold(input: JoinOfferRevealInput): JoinOfferRevealHold | null {
  if (input.alreadyRevealed) return "already-shown";
  if (input.landingInFlight) return "landing-in-flight";
  if (input.folded) return "folded";
  if (input.turnInFlight) return "turn-in-flight";
  if (input.anyLandingActive) return "landing-active";
  if (input.shadeShowing) return "shade-showing";
  return null;
}

/** Whether the passive reveal may fire now — {@link joinOfferRevealHold} is null. */
export function shouldRevealJoinOffer(input: JoinOfferRevealInput): boolean {
  return joinOfferRevealHold(input) === null;
}

/**
 * The gate's reason in its own words, for the Changes segment's dot — or null
 * when there is nothing to wait for.
 *
 * The dot marks a standing offer on a closed room; this says what the room is
 * waiting on, so a deferral is quiet rather than silent. `already-shown` has no
 * sentence: the room is not waiting for anything, it simply showed this work
 * already and the segment opens it on a click.
 */
export function joinOfferRevealHoldSentence(hold: JoinOfferRevealHold | null): string | null {
  switch (hold) {
    case "landing-in-flight":
      return "opens when this join settles";
    case "folded":
      return "unfold to open";
    case "turn-in-flight":
      return "opens when the turn finishes";
    case "landing-active":
      return "opens when this landing closes";
    case "shade-showing":
      return "opens when the shade closes";
    case "already-shown":
    case null:
      return null;
  }
}

/** One reveal receipt: what the gate decided for a key, and why. */
export interface JoinOfferRevealReceipt {
  readonly key: string;
  readonly verdict: "revealed" | "deferred";
  readonly reason: JoinOfferRevealHold | null;
}

/**
 * Once-per-change cadence for reveal receipts.
 *
 * The reveal effect runs on every dependency move, and most runs repeat the
 * last answer. A receipt per run would bury the one line that matters, so a
 * receipt is due only the first time a `(key, verdict, reason)` is seen.
 * `already-shown` is due like the others ([B05]): it is the one answer that
 * was silent, and "the shade did not reveal" has to be readable from the log
 * when the reason is that the room showed this work already.
 */
export class JoinOfferRevealReceipts {
  private readonly seen = new Set<string>();

  /** Whether this receipt is new and should be sent. Records it if so. */
  due(receipt: JoinOfferRevealReceipt): boolean {
    const id = `${receipt.key}|${receipt.verdict}|${receipt.reason ?? "-"}`;
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    return true;
  }
}

/** The attention standing for the bound arc: whose it is, and the key it is remembered by. */
export interface StandingOffer {
  readonly ownerId: string;
  readonly key: string;
}

/**
 * What this room has shown — the reveal's mount-local memory.
 *
 * Spent on **entry**, never on a reveal: join mode being active for the arc an
 * offer stands for is what says the reader is looking at that work. A key that
 * moves while the room is open is spent by the same rule, because the reader
 * is already looking at the work the new key names.
 */
export class JoinOfferMemory {
  private readonly shown = new Set<string>();

  /** Whether the work this key names has been shown in this room. */
  has(key: string): boolean {
    return this.shown.has(key);
  }

  /**
   * Spend `offer` if join mode is active on its arc. Returns whether it did.
   *
   * `activeOwnerId` is the owner id join mode is aimed at, or null when the
   * mode is down. Join mode on some other arc spends nothing: the reader has
   * not been shown this one.
   */
  spendOnEntry(activeOwnerId: string | null, offer: StandingOffer | null): boolean {
    if (activeOwnerId === null || offer === null) return false;
    if (activeOwnerId !== offer.ownerId) return false;
    this.shown.add(offer.key);
    return true;
  }

  /** Forget everything shown — a cleared block makes the same work new to show. */
  forget(): void {
    this.shown.clear();
  }
}
