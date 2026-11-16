/**
 * session-notify.ts — ask for the user when a session card they are not
 * watching finishes or needs them.
 *
 * Two moments, each set on its own in Settings › General (`settings-api.ts`,
 * `SESSION_NOTIFY_*`):
 *
 * - **complete** — a working session goes idle: its card's phase falls from a
 *   live turn (`submitting` … `tool_work`, `waking`, or a dialog held open in
 *   one) to a resting key (`idle`, `done`, `ready`). An interrupt is not a
 *   completion — the user asked for it, and its card passes through
 *   `interrupting` — and neither is a replay settling or a wire coming back,
 *   which pass through `replaying` and `restoring`.
 * - **input** — a working session raises a question or a permission request:
 *   its phase key becomes `awaiting_approval` from a live turn. A dialog that
 *   was already standing when the shell first saw the card, or that comes
 *   back with a reconnect, asked once already and does not ask again.
 *
 * Each answers with a dock bounce (Repeat, Once or Never) and, if the user
 * turned it on, a macOS notification. The host decides whether to act: both
 * are for a user who is somewhere else, so the host does nothing while Tug is
 * the frontmost app — where the card's own dot and dialog already say it.
 *
 * The rule is {@link notifyEventFor}, pure over two phase keys. The watcher
 * ({@link installSessionNotify}) reads every session card's phase on each
 * change, remembers the last key per card, and posts on an edge. A card's
 * first reading only sets the baseline, so a launch, a reload or a restored
 * workspace never asks for anyone.
 *
 * The phase is read the way `sessionPhaseNow` reads it: from the card's own
 * session store when this page holds one (the shell's own document, bodies
 * off), else from what the card's body reported — or what the shell followed
 * for it while that body sleeps (`bodiless-facts-store.ts`).
 *
 * Installed once, by the deck manager, in the shell: the one page that sees
 * every card, so no event is posted twice. Laws: [L22] its sources are
 * subscribed to directly, never through React; [L27] the install returns its
 * release.
 *
 * @module lib/session-notify
 */

import { cardServicesStore } from "@/lib/card-services-store";
import { cardSessionBindingStore, ledgerSegmentForCard } from "@/lib/card-session-binding-store";
import { bodyFactsStore } from "@/lib/body-facts-store";
import { bodilessFactsStore } from "@/lib/bodiless-facts-store";
import { getSessionLedgerStore } from "@/lib/session-ledger-store";
import { getTugbankClient } from "@/lib/tugbank-singleton";
import { reportedPhaseOf, sessionPhaseFromSnapshot } from "@/lib/code-session-store/use-session-phase";
import type { CodeSessionStore } from "@/lib/code-session-store";
import {
  SESSION_NOTIFY_BANNER_KEYS,
  SESSION_NOTIFY_BOUNCE_KEYS,
  SESSION_NOTIFY_DOMAIN,
  parseDockBounce,
  parseNotifyBanner,
  type DockBounce,
  type SessionNotifyEvent,
} from "@/settings-api";

/** The phase keys of a live turn: a session doing work, or parked on a dialog inside one. */
const LIVE_TURN: ReadonlySet<string> = new Set([
  "submitting",
  "awaiting_first_token",
  "streaming",
  "tool_work",
  "waking",
  "awaiting_approval",
]);

/** The phase keys of a session at rest with its turn handed back. */
const RESTING: ReadonlySet<string> = new Set(["idle", "done", "ready"]);

/** The phase key of a session waiting on the user's answer. */
const AWAITING_INPUT = "awaiting_approval";

/**
 * Which event, if any, a card's move from `prev` to `next` is. `prev` is
 * `null` on the card's first reading, which is a baseline and never an event.
 * Pure, so the rule is a unit test rather than a claim about a running app.
 */
export function notifyEventFor(prev: string | null, next: string): SessionNotifyEvent | null {
  if (prev === null || prev === next || !LIVE_TURN.has(prev)) return null;
  if (next === AWAITING_INPUT) return "input";
  if (RESTING.has(next)) return "complete";
  return null;
}

/** What the watcher hands the host for one event. */
export interface SessionNotifyPost {
  event: SessionNotifyEvent;
  bounce: DockBounce;
  notification: boolean;
  cardId: string;
  title: string;
  body: string;
}

/** What the watcher reads from the page it is installed on. */
export interface SessionNotifySources {
  /** Every card bound to a session. */
  cardIds(): Iterable<string>;
  /** The card's phase key, as its dot reads it. */
  phaseOf(cardId: string): string;
  /** Be told whenever any card's phase may have moved; returns the release. */
  subscribe(listener: () => void): () => void;
  /** The user's choices for `event`, read at the moment it happens. */
  settingsFor(event: SessionNotifyEvent): { bounce: DockBounce; notification: boolean };
  /** The notification's words for `cardId`'s `event`. */
  describe(cardId: string, event: SessionNotifyEvent): { title: string; body: string };
  /** Hand one event to the host. */
  post(note: SessionNotifyPost): void;
}

/** Install the watcher. Returns the release ([L27]). */
export function installSessionNotify(sources: SessionNotifySources): () => void {
  const last = new Map<string, string>();

  const read = (): void => {
    const seen = new Set<string>();
    for (const cardId of sources.cardIds()) {
      seen.add(cardId);
      const next = sources.phaseOf(cardId);
      const prev = last.get(cardId) ?? null;
      if (prev === next) continue;
      last.set(cardId, next);
      const event = notifyEventFor(prev, next);
      if (event === null) continue;
      const { bounce, notification } = sources.settingsFor(event);
      if (bounce === "never" && !notification) continue;
      sources.post({ event, bounce, notification, cardId, ...sources.describe(cardId, event) });
    }
    for (const cardId of [...last.keys()]) {
      if (!seen.has(cardId)) last.delete(cardId);
    }
  };

  const release = sources.subscribe(read);
  read();
  return release;
}

/** The last path component of `dir`, or `""`. */
function leafOf(dir: string): string {
  return dir.replace(/\/+$/, "").split("/").pop() ?? "";
}

/**
 * The shell's sources, posting through `post`. Each card's session store is
 * subscribed to while the card holds one, and let go when it does not.
 */
export function deckSessionNotifySources(post: (note: SessionNotifyPost) => void): SessionNotifySources {
  return {
    cardIds: () => cardSessionBindingStore.getSnapshot().keys(),
    phaseOf: (cardId) => {
      const store = cardServicesStore.getServices(cardId)?.codeSessionStore ?? null;
      return store !== null ? sessionPhaseFromSnapshot(store.getSnapshot()) : reportedPhaseOf(cardId);
    },
    subscribe: (listener) => {
      const stores = new Map<CodeSessionStore, () => void>();
      const followStores = (): void => {
        const live = new Set<CodeSessionStore>();
        cardServicesStore.forEachCodeSessionStore((store) => {
          live.add(store);
          if (!stores.has(store)) stores.set(store, store.subscribe(listener));
        });
        for (const [store, release] of stores) {
          if (!live.has(store)) {
            release();
            stores.delete(store);
          }
        }
      };
      followStores();
      const releases = [
        cardServicesStore.subscribe(() => {
          followStores();
          listener();
        }),
        cardSessionBindingStore.subscribe(listener),
        bodyFactsStore.subscribe(listener),
        bodilessFactsStore.subscribe(listener),
      ];
      return () => {
        for (const release of releases) release();
        for (const release of stores.values()) release();
        stores.clear();
      };
    },
    settingsFor: (event) => {
      const client = getTugbankClient();
      return {
        bounce: parseDockBounce(client?.get(SESSION_NOTIFY_DOMAIN, SESSION_NOTIFY_BOUNCE_KEYS[event])),
        notification: parseNotifyBanner(client?.get(SESSION_NOTIFY_DOMAIN, SESSION_NOTIFY_BANNER_KEYS[event])),
      };
    },
    describe: (cardId, event) => {
      const binding = cardSessionBindingStore.getBinding(cardId);
      const row =
        binding === undefined
          ? null
          : (getSessionLedgerStore()?.findRow(ledgerSegmentForCard(cardId, binding.tugSessionId)) ?? null);
      const name = row?.name ?? row?.tag ?? "A session";
      const project = leafOf(row?.project_dir ?? binding?.projectDir ?? "");
      const where = project === "" ? "" : ` in ${project}`;
      return event === "complete"
        ? { title: "Session finished", body: `${name}${where} is done and waiting for you.` }
        : { title: "Session needs your input", body: `${name}${where} is waiting for your answer.` };
    },
    post,
  };
}
