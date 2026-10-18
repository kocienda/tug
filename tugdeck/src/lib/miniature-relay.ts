/**
 * The Layout miniature's two seams with the deck, carried across pages.
 *
 * Under per-card web views the miniature is drawn in the Layout card's body,
 * while what it mirrors and drives is the shell's: the gauge channel's
 * publishers (`imposer-gauges.ts` — the deck's flow offset, the canvas's
 * column slides, drag frame and drop zone) and the canvas's drop-zone host
 * (`drop-zone-host-registry.ts`). Both are module state per page, so in a
 * body each was silent: no `--gauge-*` property ever arrived, and a drag
 * started on the picture latched nothing. This module is the crossing.
 *
 * - **Gauges, shell → body.** A body with any gauge registration says so
 *   (`subscribeGauges`); the shell primes it with every standing value and
 *   then forwards each publish, batched to one bus message per task — one
 *   per frame while a drag or a slide runs — and the body applies each
 *   signal into its own channel, which writes the custom properties and the
 *   drag attributes onto its registered elements exactly as a publish in
 *   that page would ([L06]: no store, no render).
 * - **The drop-zone host, body → shell.** The body registers a
 *   {@link MiniatureDropHost} whose verbs go to the shell as `deck-call`
 *   advice and are answered there by the canvas's host: the zones it would
 *   offer a card (answered back to the asking body), the outline, the
 *   carrying stamp, and the commit, whose refusal the shell flashes on the
 *   dragged card's pane.
 *
 * Both directions ride the bus's existing vocabulary — `card-advice`
 * `deck-call` up, a `card-command` `dispatch` under {@link MINIATURE_RELAY_ID}
 * down — so tugcast, which re-serializes every bus frame through its own
 * typed mirror, carries them unchanged.
 *
 * @module lib/miniature-relay
 */

import type { CardCommand } from "@tugproto/bus";
import type { DeckState } from "../layout-tree";
import type { DropZone, DropZoneHost, DropZoneSet } from "./drop-zones";
import type { MiniatureDropHost } from "./drop-zone-host-registry";
import {
  applyGaugeSignal,
  isGaugeSignal,
  observeGaugeDemand,
  standingGauges,
  tapGaugePublishes,
  type GaugeSignal,
} from "./imposer-gauges";

/** The `dispatch` id the shell's relay messages to a body travel under. */
export const MINIATURE_RELAY_ID = "miniature-relay";

/** The `deck-call` methods a body's relay sends; the shell's relay answers them. */
export const MINIATURE_RELAY_CALLS = [
  "subscribeGauges",
  "miniatureZones",
  "miniatureOutline",
  "miniatureCarry",
  "miniatureCommit",
] as const;

type GaugeEntry = [string, Record<string, string> | null];

/** What the shell's relay sends a body, as the `dispatch`'s payload. */
export type MiniatureRelayMessage =
  | { relay: "gauges"; signals: GaugeEntry[] }
  | { relay: "zones"; requestId: number; set: DropZoneSet | null };

function plain(values: ReadonlyMap<string, string> | null): Record<string, string> | null {
  return values === null ? null : Object.fromEntries(values);
}

function paneOfCard(state: DeckState, cardId: string): string | null {
  return state.panes.find((p) => p.cardIds.includes(cardId))?.id ?? null;
}

function isZone(value: unknown): value is DropZone {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "slot" || kind === "column-index" || kind === "rail-index" || kind === "tab-bar";
}

// ---- The shell's half ----

export interface ShellMiniatureRelayOptions {
  /** Send `command` to `cardId`'s body. */
  send: (cardId: string, command: CardCommand) => void;
  /** The shell's deck, read to find a card's pane. */
  getSnapshot: () => DeckState;
  /** The canvas's drop-zone host, read at each call. */
  getHost: () => DropZoneHost | null;
  /** Flash `cardId`'s pane: a refused drop's answer. */
  flashCard: (cardId: string) => void;
}

export interface ShellMiniatureRelay {
  /** Answer a body's `deck-call` if it is one of the relay's. Whether it was. */
  handle(cardId: string, method: string, args: readonly unknown[]): boolean;
  /** The card's page went away: stop sending it gauges. */
  forget(cardId: string): void;
  dispose(): void;
}

export function createShellMiniatureRelay(options: ShellMiniatureRelayOptions): ShellMiniatureRelay {
  const subscribed = new Set<string>();
  const pending = new Map<GaugeSignal, ReadonlyMap<string, string> | null>();
  let flushQueued = false;

  const sendTo = (cardId: string, message: MiniatureRelayMessage): void => {
    options.send(cardId, {
      command: "dispatch",
      id: MINIATURE_RELAY_ID,
      payload: message as unknown as Record<string, unknown>,
    });
  };

  const flush = (): void => {
    flushQueued = false;
    if (pending.size === 0 || subscribed.size === 0) {
      pending.clear();
      return;
    }
    const signals: GaugeEntry[] = [...pending].map(([signal, values]) => [signal, plain(values)]);
    pending.clear();
    for (const cardId of subscribed) sendTo(cardId, { relay: "gauges", signals });
  };

  const untap = tapGaugePublishes((signal, values) => {
    if (subscribed.size === 0) return;
    // A signal published twice in one task travels once, at its last value:
    // the body draws the frame the shell's task ended on.
    pending.delete(signal);
    pending.set(signal, values);
    if (!flushQueued) {
      flushQueued = true;
      queueMicrotask(flush);
    }
  });

  const handle = (cardId: string, method: string, args: readonly unknown[]): boolean => {
    switch (method) {
      case "subscribeGauges": {
        if (args[0] === true) {
          subscribed.add(cardId);
          const signals: GaugeEntry[] = standingGauges().map(([signal, values]) => [signal, plain(values)]);
          sendTo(cardId, { relay: "gauges", signals });
        } else {
          subscribed.delete(cardId);
        }
        return true;
      }
      case "miniatureZones": {
        const [requestId, draggedCardId] = args;
        if (typeof requestId !== "number") return true;
        const host = options.getHost();
        const paneId =
          typeof draggedCardId === "string" ? paneOfCard(options.getSnapshot(), draggedCardId) : null;
        const set = host === null || paneId === null ? null : host.enumerateRemote(paneId);
        sendTo(cardId, { relay: "zones", requestId, set });
        return true;
      }
      case "miniatureOutline": {
        const zone = args[0];
        options.getHost()?.outline(isZone(zone) ? zone : null);
        return true;
      }
      case "miniatureCarry": {
        const kind = args[0];
        options.getHost()?.carry(kind === "rail" || kind === "card" ? kind : null);
        return true;
      }
      case "miniatureCommit": {
        const [zone, draggedCardId] = args;
        if (!isZone(zone) || typeof draggedCardId !== "string") return true;
        const host = options.getHost();
        const paneId = paneOfCard(options.getSnapshot(), draggedCardId);
        if (host === null || paneId === null || !host.commit(zone, paneId)) {
          options.flashCard(draggedCardId);
        }
        return true;
      }
      default:
        return false;
    }
  };

  return {
    handle,
    forget: (cardId) => {
      subscribed.delete(cardId);
    },
    dispose: () => {
      untap();
      subscribed.clear();
      pending.clear();
    },
  };
}

// ---- A body's half ----

/** How long a body waits on the shell's zones before the drag stays inert. */
const ZONES_ANSWER_MS = 2000;

export interface BodyMiniatureRelayOptions {
  /** Send a `deck-call` to the shell. */
  call: (method: (typeof MINIATURE_RELAY_CALLS)[number], args: unknown[]) => void;
  /** The card a pane of this page's deck holds in front — what names the
   *  pane to the shell, whose ids for this card's own pane differ. */
  cardOfPane: (paneId: string) => string | null;
}

export interface BodyMiniatureRelay {
  /** The host the miniature's gesture drives in this page. */
  host: MiniatureDropHost;
  /** Take a `dispatch` the shell sent; whether it was the relay's. */
  receive(command: CardCommand): boolean;
  dispose(): void;
}

export function createBodyMiniatureRelay(options: BodyMiniatureRelayOptions): BodyMiniatureRelay {
  let nextRequest = 0;
  const answers = new Map<number, (set: DropZoneSet | null) => void>();

  // A drawing that re-registers in one commit — its last registration off,
  // its first back on — says nothing: the shell would stop sending between
  // the two and miss what was published there. So a `false` waits a task,
  // and a `true` inside it cancels it.
  let said = false;
  let wantedNow = false;
  const unobserve = observeGaugeDemand((wanted) => {
    wantedNow = wanted;
    if (wanted) {
      if (!said) options.call("subscribeGauges", [true]);
      said = true;
      return;
    }
    queueMicrotask(() => {
      if (wantedNow || !said) return;
      said = false;
      options.call("subscribeGauges", [false]);
    });
  });

  const host: MiniatureDropHost = {
    enumerateRemote(draggedPaneId) {
      const cardId = options.cardOfPane(draggedPaneId);
      if (cardId === null) return Promise.resolve(null);
      nextRequest += 1;
      const requestId = nextRequest;
      return new Promise<DropZoneSet | null>((resolve) => {
        const timer = setTimeout(() => {
          answers.delete(requestId);
          resolve(null);
        }, ZONES_ANSWER_MS);
        answers.set(requestId, (set) => {
          clearTimeout(timer);
          answers.delete(requestId);
          resolve(set);
        });
        options.call("miniatureZones", [requestId, cardId]);
      });
    },
    outline(zone) {
      options.call("miniatureOutline", [zone]);
    },
    carry(kind) {
      options.call("miniatureCarry", [kind]);
    },
    commit(zone, draggedPaneId) {
      const cardId = options.cardOfPane(draggedPaneId);
      if (cardId === null) return false;
      // Handed over: the shell commits, and flashes a refusal itself.
      options.call("miniatureCommit", [zone, cardId]);
      return true;
    },
  };

  const receive = (command: CardCommand): boolean => {
    if (command.command !== "dispatch" || command.id !== MINIATURE_RELAY_ID) return false;
    const message = command.payload as MiniatureRelayMessage | undefined;
    if (message?.relay === "gauges" && Array.isArray(message.signals)) {
      for (const entry of message.signals) {
        if (!Array.isArray(entry)) continue;
        const [signal, values] = entry;
        if (typeof signal !== "string" || !isGaugeSignal(signal)) continue;
        applyGaugeSignal(
          signal,
          values === null || typeof values !== "object" ? null : new Map(Object.entries(values)),
        );
      }
    } else if (message?.relay === "zones" && typeof message.requestId === "number") {
      answers.get(message.requestId)?.(message.set ?? null);
    }
    return true;
  };

  return {
    host,
    receive,
    dispose: () => {
      unobserve();
      for (const answer of [...answers.values()]) answer(null);
    },
  };
}
