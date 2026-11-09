/**
 * session-attention.ts — tell tugcast when the user attends a session.
 *
 * A session that finished a turn while the user was looking elsewhere reads
 * `done` until the user looks at it ([B01]). "Looks at it" is activating the
 * session's card, by any door, while the app is active ([B04]): a click on a
 * Workspaces row, ⌘-digit, the picker, a citation chip, and the app coming
 * back to the front onto that card (the lifecycle cascade re-fires the
 * activation then). An active card in a background app is not being read, so
 * nothing is reported while the deck does not have focus. Scrolling past a
 * row, hovering it, or seeing its dot are not activations and report nothing.
 *
 * The other half is the attended completion ([B03]): a turn that completes
 * while its card is the one the user is attending must never raise the mark.
 * So every move of the attended session is reported — to another session,
 * and to none when the app goes to the background — and tugcast stamps
 * attention in the same write that ends a turn on it. The mark is never
 * raised, so no page ever draws it, including a body page that has no way to
 * know which card is attended. tugcast holds the attended session in memory
 * only, so the reporter names it again every time the wire opens: a restarted
 * tugcast learns it before any turn can end there. Should a turn end reach the
 * deck unseen on the attended card anyway, the reporter answers the push at
 * once.
 *
 * tugcast owns the stamp ([B06]): this module only sends `attend_session`,
 * and the row that comes back is what every surface reads. Submitting a
 * prompt needs no report from here, because tugcast stamps attention where
 * the prompt lands.
 *
 * @module lib/session-attention
 */

import {
  encodeAttendSession,
  sessionTurnEndUnseen,
  type Frame,
  type SessionRow,
} from "@/protocol";
import {
  cardSessionBindingStore,
  ledgerSegmentForCard,
} from "@/lib/card-session-binding-store";
import {
  getSessionLedgerStore,
  subscribeSessionLedger,
} from "@/lib/session-ledger-store";

/**
 * Whether to report that the user attended `sessionId`, given what the deck
 * holds of its ledger row.
 *
 * - No session (the card holds none, or the app is not active): nothing.
 * - A row the deck has not seen yet: report — the server's row may carry a
 *   mark the deck has not been told of, and the stamp is idempotent there.
 * - A row that reads seen: nothing; there is no mark to spend, and every
 *   click on an already-read session would otherwise cost a ledger write.
 * - A row that reads unseen: report, unless this exact turn end was already
 *   reported and its push has not come back yet.
 *
 * Either report is skipped when it is the one already sent, so the ledger
 * ticks that arrive before the answering push cannot repeat it.
 *
 * Returns the key to remember as reported, or `null` for no report. Pure, so
 * the rule is a unit test rather than a claim about a running app.
 */
export function attentionReportKey(
  sessionId: string | null,
  row: Pick<SessionRow, "last_turn_end_at" | "last_attended_at"> | null,
  lastReported: string | null,
): string | null {
  if (sessionId === null) return null;
  if (row !== null && !sessionTurnEndUnseen(row)) return null;
  const key = row === null ? `${sessionId}:unknown` : `${sessionId}:${row.last_turn_end_at ?? 0}`;
  return key === lastReported ? null : key;
}

/**
 * What to send when the deck's view of the attended session is re-read: the
 * session the user is attending now (`null` for none), the report key last
 * sent for an unseen mark, and the session last named to tugcast
 * (`undefined` before the first report).
 *
 * A move of the attended session is always sent — it is what lets tugcast
 * see a turn end as it happens — and it carries the mark's spending with it.
 * Otherwise only an unseen mark on the attended session is answered, by
 * {@link attentionReportKey}'s rule.
 *
 * Returns `null` for nothing to send, else the report and the state to keep.
 */
export function nextAttendReport(
  attending: string | null,
  row: Pick<SessionRow, "last_turn_end_at" | "last_attended_at"> | null,
  lastReported: string | null,
  lastNamed: string | null | undefined,
): { readonly send: string | null; readonly lastReported: string | null } | null {
  const key = attentionReportKey(attending, row, lastReported);
  if (attending !== lastNamed) return { send: attending, lastReported: key ?? lastReported };
  if (key === null) return null;
  return { send: attending, lastReported: key };
}

/** What the reporter reads from the deck it is installed on. */
export interface SessionAttentionDeck {
  /** Whether the app is active — the deck's `hasFocus` bit. */
  isAppActive(): boolean;
  /** The card the user is attending: the active window's active card. */
  getFirstResponderCardId(): string | null;
  /** Be told of every card activation; initial-syncs on subscribe. */
  observeCardDidActivate(cb: (cardId: string) => void): () => void;
  /** Be told whenever the deck's state moves, the app's activity included. */
  observeDeck(cb: () => void): () => void;
  /** Be told every time the wire to tugcast opens, a reconnect included. */
  observeWireOpen(cb: () => void): () => void;
  /** Send one CONTROL frame to tugcast. */
  send(frame: Frame): void;
}

/** The ledger row id that speaks for `cardId`'s session, or `null`. */
function sessionForCard(cardId: string | null): string | null {
  if (cardId === null) return null;
  const binding = cardSessionBindingStore.getBinding(cardId);
  if (binding === undefined) return null;
  return ledgerSegmentForCard(cardId, binding.tugSessionId);
}

/**
 * Install the reporter on the shell's deck. Returns the release ([L27]).
 *
 * Installed once, by the deck manager, beside the app → card lifecycle
 * cascade: the shell is the one page that sees every card's activation, so
 * a body page never reports and no activation is reported twice.
 */
export function installSessionAttention(deck: SessionAttentionDeck): () => void {
  let lastReported: string | null = null;
  let lastNamed: string | null | undefined = undefined;

  const report = (cardId: string | null): void => {
    const attending = deck.isAppActive() ? sessionForCard(cardId) : null;
    const row = attending === null ? null : (getSessionLedgerStore()?.findRow(attending) ?? null);
    const next = nextAttendReport(attending, row, lastReported, lastNamed);
    if (next === null) return;
    lastReported = next.lastReported;
    lastNamed = next.send;
    deck.send(encodeAttendSession(next.send));
  };

  // The attended card, re-read whenever a row, a binding or the deck moves:
  // the app going to the background, a card whose binding lands after it was
  // activated (a launch restore), and a turn end that reached the deck unseen
  // are all answered here.
  const reviewAttended = (): void => {
    report(deck.getFirstResponderCardId());
  };

  const releases = [
    deck.observeCardDidActivate((cardId) => report(cardId)),
    deck.observeDeck(reviewAttended),
    // A reconnect may be to a tugcast that restarted and forgot who is being
    // attended, so what was last sent no longer stands: name it again.
    deck.observeWireOpen(() => {
      lastReported = null;
      lastNamed = undefined;
      reviewAttended();
    }),
    subscribeSessionLedger(reviewAttended),
    cardSessionBindingStore.subscribe(reviewAttended),
  ];
  return () => {
    for (const release of releases) release();
  };
}
