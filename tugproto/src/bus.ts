/**
 * tugproto/bus — addressed envelopes between pages on the deck bus.
 *
 * `DECK_BUS` (0xD0) carries one JSON envelope per frame in both directions.
 * A page sends a {@link BusEnvelopeOut}. tugcast reads its `to` and `kind`
 * and nothing else: it resolves the target against the live pages and
 * delivers a {@link BusEnvelopeDelivered} on the page lane, adding `from`
 * from the sender's registered identity, so a page cannot speak as another
 * and a `from` it writes is dropped. Every other field passes through
 * verbatim; what it means is declared beside its codec in
 * `tugdeck/src/bus/declarations/` and validated by the receiving page. A
 * tool's bus frame is refused (`bus_refused`), an envelope with no target or
 * an unknown kind is `bus_malformed`, and a target no live page answers is
 * `bus_undeliverable`; each is a CONTROL error to the sender.
 *
 * The Rust side mirrors these shapes in
 * `tugrust/crates/tugcast-core/src/bus.rs`; both are held to
 * `__tests__/fixtures/bus-parity.json`.
 *
 * Pure types and constants — no React, no DOM, no Node/Bun API.
 *
 * @module tugproto/bus
 */

/** Whom a bus message is for: the newest shell, every body, one card's newest page, or one page. */
export type BusTarget = "shell" | "body" | { card: string } | { page: string };

/** The sender of a delivered message, as tugcast registered it. */
export interface BusFrom {
  pageId: string;
  role: "shell" | "body";
  cardId: string | null;
}

/** The kinds the bus library speaks. */
export const BUS_ENVELOPE_KINDS = ["hello", "state", "action", "request", "reply"] as const;

export type BusEnvelopeKind = (typeof BUS_ENVELOPE_KINDS)[number];

/** An envelope as a page sends it. tugcast reads `to` and `kind`; the rest is the receiver's. */
export interface BusEnvelopeOut {
  to: BusTarget;
  kind: BusEnvelopeKind;
  /** `state`: the store key. `action`/`request`/`reply`: the action or request id. */
  key?: string;
  /** `state` of a card-scoped store: which card's value this is. */
  card?: string;
  /** `state`: the owner's version of the value, rising on every change. */
  version?: number;
  /** `state`: the proposals this snapshot acknowledges, by replica page id. */
  ack?: Record<string, number>;
  /** `action` carrying a proposal to a store's owner: the replica's proposal number. */
  proposal?: number;
  /** `request`/`reply`: which request. */
  requestId?: string;
  /** `request`: the requester took the request down. */
  withdraw?: true;
  /** Opaque to tugcast. */
  payload?: unknown;
}

/** An envelope as tugcast delivers it. */
export interface BusEnvelopeDelivered extends BusEnvelopeOut {
  from: BusFrom;
}

