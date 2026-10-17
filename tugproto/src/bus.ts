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
  /**
   * What the card holds, as its own page's live identity resolver answers
   * (the deck's `CardIdentityFacts`), or null when it answers nothing.
   * Opaque to tugcast.
   */
  identity?: Record<string, unknown> | null;
  /**
   * The controls the card contributes to its pane's title bar (the deck's
   * `PaneTitleBarItem`s), each with `enabled` as the card's own chain
   * answers, or null when it contributes none. Opaque to tugcast.
   */
  titleBar?: Record<string, unknown>[] | null;
}

/** What a `card-command` asks a card to do. */
export type CardCommandKind =
  | "find"
  | "focus-prompt"
  | "interrupt"
  | "turn-previous"
  | "turn-next"
  | "chord"
  | "dispatch"
  | "focus-enter"
  | "surface-activate"
  | "surface-dismissed"
  /** The shell asks the card's own close guard to decide; the card answers `close-decision` advice. */
  | "close-decision"
  /** Start (`on: true`) or stop publishing the card's session inspection for a devtools card. */
  | "inspect"
  /** A followed card's inspection, relayed to the devtools card that follows it. */
  | "inspection"
  /** A chain action, by `id`, sent to the card's content responder. */
  | "content-action"
  /** Reveal a line of the card's file; `payload` carries `line`, and `endLine` and `columns` when given. */
  | "reveal-line"
  /** Show a section of the Settings card; `payload` carries `section`. */
  | "reveal-settings"
  /** The shell's dev log, for the devtools card: `payload` carries `entries`, opaque to the bus. */
  | "dev-log"
  /** A session the shell decided for a card already in its body: `payload` is the intent, opaque to the bus. */
  | "intent"
  /** Capture a jot in the Jots card: create an empty one and open its editor, the shell's ⌘J. */
  | "new-jot";

/** `card-command`: the chrome asking a card to act. */
export interface CardCommand {
  command: CardCommandKind;
  query?: string;
  chord?: { key: string; modifiers: string[] };
  /** The action id a `dispatch` carries (a card-scoped menu command), or a `content-action`'s chain action. */
  id?: string;
  /** The action's payload, for a `dispatch` that has one. */
  payload?: Record<string, unknown>;
  /**
   * Where a `focus-enter` lands the keyboard: the card's first stop or its
   * last, by the direction the walk arrived in.
   */
  edge?: "first" | "last";
  /**
   * The element a `surface-activate` presses: its child-index path from the
   * root of the content the shell draws for the card.
   */
  path?: number[];
  /** Whether an `inspect` starts the card's inspection or stops it. */
  on?: boolean;
  /** The inspection an `inspection` relays, opaque to the bus. */
  inspection?: unknown;
}

/**
 * A surface a body asks the shell to draw over the deck: one that stands
 * outside its card's content box, which is all a body's viewport is. The
 * body keeps rendering it, hidden, and the shell draws `html` — the
 * surface's content as the body rendered it — in a panel of `className`
 * hung off the line at `lineY`, centred on `anchorX`. Coordinates are the
 * body's viewport points. `scroll` is where each scroller in the content
 * stood when it was first drawn, by its child-index path.
 */
export interface ShellSurface {
  title: string;
  className: string;
  growth: "up" | "down";
  anchorX: number;
  lineY: number;
  html: string;
  scroll: Array<{ path: number[]; top: number }>;
}

/** `card-advice`: what a card tells the chrome about how to treat it, tagged by `advice`. */
export type CardAdvice =
  | { advice: "fold-guard"; guarded: boolean }
  | { advice: "close-advice"; waive: boolean }
  | { advice: "sheet-reservation"; heightPx: number | null }
  | { advice: "opening-bid"; heightPx: number | null }
  | { advice: "activate" }
  /**
   * The card's first frame of content has gone to the compositor, said on
   * the bus behind every `card-facts` that frame was drawn with; the shell
   * shows the body once it has this and the host's own `painted`.
   */
  | { advice: "painted" }
  | { advice: "close-request" }
  /**
   * Add a card of `componentId` to the pane this card stands in — the
   * pane's `ADD_TAB` currency, which is not a command and so cannot ride
   * `dispatch`; the Spikes index's rows say it.
   */
  | { advice: "add-card"; componentId: string }
  /**
   * A command the body's own chain did not handle — a chord its funnel
   * matched, or a `dispatch` the shell forwarded — handed to the shell to
   * dispatch in its own chain, where the pane and the deck answer.
   */
  | { advice: "dispatch"; id: string; payload?: Record<string, unknown> }
  /**
   * The card's Tab walk reached its edge going `direction`: the next stop is
   * the shell's to choose. `empty` says the card answered a `focus-enter`
   * with no stop to take, so the shell must not hand the walk back.
   */
  | { advice: "focus-exit"; direction: "next" | "previous"; empty?: boolean }
  /** Draw the card's deck-scope surface in the shell, or stop drawing it (`null`). */
  | { advice: "surface"; surface: ShellSurface | null }
  /** The card asked to log out, which is the app's to confirm and run. */
  | { advice: "logout" }
  /**
   * A deck method an arrangement card called (`setFlowOffset`, …), for the
   * shell to run against its deck when the method is one it lets a body call.
   */
  | { advice: "deck-call"; method: string; args: unknown[] }
  /** Whether the card's own close guard would ask before the card closes. */
  | { advice: "close-guard"; asks: boolean }
  /** The card's close guard decided, in answer to a `close-decision` command. */
  | { advice: "close-decision"; answer: "close" | "cancel" }
  /**
   * The card's chord capture armed (`true`) or disarmed. The host parks every
   * menu key equivalent while a capture records, and the menu state is the
   * shell's to push, so a body says when its capture arms.
   */
  | { advice: "capture-armed"; armed: boolean }
  /** The card's session inspection, for the devtools card that follows it. Opaque to the bus. */
  | { advice: "inspection"; inspection: unknown };

/** `deck-facts`: what the chrome tells every card about the deck. */
export interface DeckFacts {
  theme: string;
  zoom: number;
  keyboardAccess: boolean;
  modifierLatch: string[];
  /**
   * The app's focus-ring modality, `keyboard` or `pointer`: a body follows
   * the shell's rather than reading its own at boot, and persists nothing.
   */
  focusRingModality: "keyboard" | "pointer";
  appActive: boolean;
  /**
   * The shell's own menu facts for its bodies — the deck's arrangement
   * projected the way the shell's menu publisher projects it, and the focus
   * family's travel per direction. A body's one-card deck cannot say how
   * many panes stand, which slot is where, or whether a card lies to the
   * right, so the gates it posts for the key card's menu items read these
   * instead. Absent on a shell that has not projected yet.
   */
  menu?: DeckMenuFacts;
  /**
   * The deck's frontmost bound card's session binding, under `binding`
   * (null when no card is bound): the project a card with no session of its
   * own, the Jots card, resolves a relative path against. A body's one-card
   * deck cannot say which card stands in front. The binding is opaque to the
   * bus: `lib/frontmost-project.ts` writes and reads it.
   */
  frontmostProject?: { binding: unknown };
  /**
   * Whether the shell's motion breaker is demoting the deck: the hand switch
   * (`tugtool deck motion demote`) is the deck's, and a body's loops are
   * stilled by its own page's root attribute, which only this fact reaches.
   * Absent on a shell that predates it.
   */
  motionDemoted?: boolean;
}

/** The shell's menu projection, opaque to the bus: `host-menu-state.ts` writes and reads it. */
export interface DeckMenuFacts {
  projection: unknown;
  focusTravel: unknown;
}

/** `card-context`: what the chrome tells one body about its own card. */
export interface CardContext {
  folded: boolean;
  arriving: boolean;
  firstResponderCardId: string | null;
  layerShown: boolean;
  spaceId: string | null;
  /**
   * The shell's arrangement — its deck, its workspaces, and the per-card
   * facts a card listing them reads — for a kind whose registration says
   * `bodyDeck: "arrangement"`. Opaque to the bus: `lib/body-arrangement.ts`
   * writes and reads it.
   */
  arrangement?: unknown;
  /** The card a `bodyFollows` kind follows, and its binding, or null. Opaque to the bus. */
  followed?: unknown;
  /**
   * The app's build identity, for the About card: what the host sent the
   * shell with its `show-card`, which only the shell hears. Opaque to the bus.
   */
  appInfo?: unknown;
  /**
   * The deck edge a rail card stands pinned to. Absent for a card that is not
   * a pinned rail — a content card, or a rail dragged loose — which paints
   * the content surface; a pinned rail paints the rail's own.
   */
  railSide?: "left" | "right";
  /**
   * The crossing the card's pane stands under — a fold, a settle's height
   * tween, a sash drag — for the body to hold its card root through, as the
   * shell holds an in-document card's. Absent when none stands. Opaque to the
   * bus: `lib/fold-crossing.ts` reads and writes it.
   */
  crossing?: unknown;
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
