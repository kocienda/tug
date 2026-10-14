/**
 * tugproto/bus — addressed messages between pages on the deck bus.
 *
 * `DECK_BUS` (0xD0) carries one JSON envelope per frame in both directions.
 * A page sends a {@link BusOutbound}: a target and a message. tugcast resolves
 * the target against the live pages and delivers a {@link BusDelivered} on
 * the page lane, adding `from` from the sender's registered identity, so a
 * page cannot speak as another and a `from` it writes is ignored. A tool's
 * bus frame is refused (`bus_refused`), one outside this vocabulary is
 * `bus_malformed`, and a target no live page answers is `bus_undeliverable`;
 * each is a CONTROL error to the sender.
 *
 * Each kind's direction (`card-facts` body → shell, `card-command` shell →
 * body, `card-advice` body → shell, `deck-facts` shell → bodies,
 * `card-context` shell → one body) is its documented use; tugcast does not
 * enforce it.
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

/**
 * A card's masthead request, as the bus carries it: the deck's
 * `CardMastheadPayload` (`tugdeck/src/lib/card-title-store.ts`), which this
 * package cannot import and tugcast never reads. The deck narrows it.
 */
export type BusMasthead = { kind: string } & Record<string, unknown>;

/** `card-facts`: what a card shows the chrome about itself. */
export interface CardFacts {
  title: string;
  masthead: BusMasthead | null;
  /** The session phase key `useSessionPhase` computes (`SessionPhaseKey`). */
  activity: string | null;
  /** `canInterrupt` and `compacted`, each 0 or 1. */
  telemetry: Record<string, number>;
}

/** What a `card-command` asks a card to do. */
export type CardCommandKind =
  | "find"
  | "focus-prompt"
  | "interrupt"
  | "turn-previous"
  | "turn-next"
  | "chord"
  | "dispatch";

/** `card-command`: the chrome asking a card to act. */
export interface CardCommand {
  command: CardCommandKind;
  query?: string;
  chord?: { key: string; modifiers: string[] };
  /** The action id a `dispatch` carries: a card-scoped menu command. */
  id?: string;
  /** The action's payload, for a `dispatch` that has one. */
  payload?: Record<string, unknown>;
}

/** `card-advice`: what a card tells the chrome about how to treat it, tagged by `advice`. */
export type CardAdvice =
  | { advice: "fold-guard"; guarded: boolean }
  | { advice: "close-advice"; waive: boolean }
  | { advice: "sheet-reservation"; heightPx: number | null }
  | { advice: "opening-bid"; heightPx: number | null }
  | { advice: "activate" }
  | { advice: "close-request" }
  /**
   * A command the body's own chain did not handle — a chord its funnel
   * matched, or a `dispatch` the shell forwarded — handed to the shell to
   * dispatch in its own chain, where the pane and the deck answer.
   */
  | { advice: "dispatch"; id: string; payload?: Record<string, unknown> };

/** `deck-facts`: what the chrome tells every card about the deck. */
export interface DeckFacts {
  theme: string;
  zoom: number;
  keyboardAccess: boolean;
  modifierLatch: string[];
  appActive: boolean;
}

/** `card-context`: what the chrome tells one body about its own card. */
export interface CardContext {
  folded: boolean;
  arriving: boolean;
  firstResponderCardId: string | null;
  layerShown: boolean;
  spaceId: string | null;
}

/** One bus message: a `kind` and its `payload`. */
export type BusMessage =
  | { kind: "card-facts"; payload: CardFacts }
  | { kind: "card-command"; payload: CardCommand }
  | { kind: "card-advice"; payload: CardAdvice }
  | { kind: "deck-facts"; payload: DeckFacts }
  | { kind: "card-context"; payload: CardContext };

/** A message as a page sends it. */
export type BusOutbound = { to: BusTarget } & BusMessage;

/** A message as tugcast delivers it. */
export type BusDelivered = { from: BusFrom; to: BusTarget } & BusMessage;

/** Every bus kind, one literal per line. */
export const BUS_KINDS = [
  "card-facts",
  "card-command",
  "card-advice",
  "deck-facts",
  "card-context",
] as const satisfies readonly BusMessage["kind"][];

export type BusKind = (typeof BUS_KINDS)[number];

// The `satisfies` clause rejects a listed kind the union lacks; this rejects
// a union kind the list lacks.
type MissingBusKind = Exclude<BusMessage["kind"], BusKind>;
const _busKindsComplete: [MissingBusKind] extends [never] ? true : MissingBusKind = true;
void _busKindsComplete;
