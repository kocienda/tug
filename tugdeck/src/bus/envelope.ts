/**
 * The envelope every `DECK_BUS` frame carries between the shell page and
 * its body pages.
 *
 * tugcast reads `to` and `kind` and nothing else: it resolves the target,
 * stamps `from` from the sender's registered identity, and passes every
 * other field through. What a field means is the receiving page's business —
 * a store snapshot's codec, an action's handler — so the vocabulary lives in
 * the declarations under `src/bus/declarations/`, not here.
 *
 * Five kinds carry the library's three primitives: `hello` (liveness),
 * `state` (a shared store's snapshot), `action` (a routed action, or a
 * proposal to a store's owner), `request` and `reply`. tugcast refuses any
 * other kind.
 *
 * Pure types and constants.
 *
 * @module bus/envelope
 */

import {
  BUS_ENVELOPE_KINDS,
  type BusEnvelopeDelivered,
  type BusEnvelopeKind,
  type BusEnvelopeOut,
  type BusFrom,
  type BusTarget,
} from "@tugproto/bus";

export type { BusFrom, BusTarget };

/** The kinds the library speaks. */
export type EnvelopeKind = BusEnvelopeKind;

export const ENVELOPE_KINDS: readonly EnvelopeKind[] = BUS_ENVELOPE_KINDS;

/** What a page sends: `@tugproto/bus`'s envelope. */
export type EnvelopeOut = BusEnvelopeOut;

/** What a page receives: the envelope as sent, with `from` as tugcast registered the sender. */
export type EnvelopeIn = BusEnvelopeDelivered;

/**
 * A `hello`'s payload. A body names its card and component; the shell names
 * only its role. `answer` marks a hello sent in reply to another, which is
 * never itself answered.
 */
export interface HelloPayload {
  role: "shell" | "body";
  cardId?: string;
  componentId?: string;
  answer?: true;
}

export function isEnvelopeKind(kind: unknown): kind is EnvelopeKind {
  return typeof kind === "string" && (ENVELOPE_KINDS as readonly string[]).includes(kind);
}

/** A target as one readable word, for logs and the census: `shell`, `body`, `card:<id>`, `page:<id>`. */
export function describeTarget(to: BusTarget): string {
  if (typeof to === "string") return to;
  return "card" in to ? `card:${to.card}` : `page:${to.page}`;
}
