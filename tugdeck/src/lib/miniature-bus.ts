/**
 * The Layout miniature's two seams with the deck, carried across pages by the
 * `miniature.*` declarations (`bus/declarations/relays.ts`).
 *
 * Under per-card web views the miniature is drawn in the Layout card's body,
 * while what it mirrors and drives is the shell's: the gauge channel's
 * publishers (`imposer-gauges.ts`) and the canvas's drop-zone host
 * (`drop-zone-host-registry.ts`). Both are module state per page, so in a
 * body each is silent unless carried.
 *
 * - **Gauges, shell → body.** A body with any gauge registration sets
 *   `miniature.demand`; while any body does, the shell sets
 *   `miniature.gauges` to every standing signal at most once per task — one
 *   message per frame while a drag or a slide runs — and the body applies
 *   each signal that moved into its own channel, which writes the custom
 *   properties and drag attributes onto its registered elements exactly as a
 *   publish in that page would ([L06]: no store, no render).
 * - **The drop-zone host, body → shell.** The body's {@link MiniatureDropHost}
 *   asks the shell's canvas for its zones (`miniature.zones`) and hands it
 *   the outline, the carrying stamp and the commit, whose refusal the shell
 *   flashes on the dragged card's pane.
 *
 * @module lib/miniature-bus
 */

import type { DeckState } from "../layout-tree";
import { pageBus, type PageBus } from "../bus/page-bus";
import {
  MINIATURE_ZONES_MS,
  miniatureCarry,
  miniatureCommit,
  miniatureDemand,
  miniatureGauges,
  miniatureOutline,
  miniatureZones,
  type GaugeEntry,
} from "../bus/declarations/relays";
import type { DropZoneHost } from "./drop-zones";
import type { MiniatureDropHost } from "./drop-zone-host-registry";
import {
  applyGaugeSignal,
  isGaugeSignal,
  observeGaugeDemand,
  standingGauges,
  tapGaugePublishes,
} from "./imposer-gauges";

function paneOfCard(state: DeckState, cardId: string): string | null {
  return state.panes.find((p) => p.cardIds.includes(cardId))?.id ?? null;
}

function standing(): GaugeEntry[] {
  return standingGauges().map(([signal, values]) => [signal, values === null ? null : Object.fromEntries(values)]);
}

// ---- The shell's half ----

export interface ShellMiniatureOptions {
  /** The shell's deck, read to find a card's pane. */
  getSnapshot: () => DeckState;
  /** The canvas's drop-zone host, read at each call. */
  getHost: () => DropZoneHost | null;
  /** Flash `cardId`'s pane: a refused drop's answer. */
  flashCard: (cardId: string) => void;
}

/**
 * Answer the miniature in the shell: publish the gauges while a body wants
 * them, and run its drop-zone verbs on the canvas. Returns the release.
 */
export function answerMiniature(options: ShellMiniatureOptions, bus: PageBus = pageBus()): () => void {
  const demand = miniatureDemand.on(bus);
  const gauges = miniatureGauges.on(bus);
  const wanted = (): boolean => [...bus.attachedCards()].some((cardId) => demand.getFor(cardId));

  let flushQueued = false;
  const flush = (): void => {
    flushQueued = false;
    if (wanted()) gauges.set(standing());
  };
  // A signal published twice in one task travels once, at its last value:
  // the body draws the frame the shell's task ended on.
  const untap = tapGaugePublishes(() => {
    if (flushQueued || !wanted()) return;
    flushQueued = true;
    queueMicrotask(flush);
  });
  // A body that starts wanting them is primed with every standing value.
  const unDemand = demand.subscribe(() => {
    if (wanted()) gauges.set(standing());
  });

  const releases = [
    untap,
    unDemand,
    miniatureZones.on(bus).handle(({ cardId }) => {
      const host = options.getHost();
      const paneId = paneOfCard(options.getSnapshot(), cardId);
      return host === null || paneId === null ? null : host.enumerateRemote(paneId);
    }),
    miniatureOutline.on(bus).handle(({ zone }) => options.getHost()?.outline(zone)),
    miniatureCarry.on(bus).handle(({ kind }) => options.getHost()?.carry(kind)),
    miniatureCommit.on(bus).handle(({ zone, cardId }) => {
      const host = options.getHost();
      const paneId = paneOfCard(options.getSnapshot(), cardId);
      if (host === null || paneId === null || !host.commit(zone, paneId)) options.flashCard(cardId);
    }),
  ];
  return () => {
    for (const release of releases) release();
  };
}

// ---- A body's half ----

/**
 * Draw the shell's gauges in this body: say whether this page has any gauge
 * registration, and apply each signal the shell's `miniature.gauges` moved.
 * Returns the release.
 */
export function followMiniatureGauges(bus: PageBus = pageBus()): () => void {
  const demand = miniatureDemand.on(bus);
  const gauges = miniatureGauges.on(bus);

  // A drawing that re-registers in one commit — its last registration off,
  // its first back on — says nothing: the shell would stop publishing between
  // the two and miss what was published there. So a `false` waits a task,
  // and a `true` inside it cancels it.
  let wantedNow = false;
  const unobserve = observeGaugeDemand((wanted) => {
    wantedNow = wanted;
    if (wanted) {
      demand.set(true);
      return;
    }
    queueMicrotask(() => {
      if (!wantedNow) demand.set(false);
    });
  });

  const applied = new Map<string, string>();
  const apply = (): void => {
    for (const [signal, values] of gauges.getSnapshot()) {
      if (!isGaugeSignal(signal)) continue;
      const json = JSON.stringify(values);
      if (applied.get(signal) === json) continue;
      applied.set(signal, json);
      applyGaugeSignal(signal, values === null ? null : new Map(Object.entries(values)));
    }
  };
  const unsubscribe = gauges.subscribe(apply);
  apply();

  return () => {
    unobserve();
    unsubscribe();
  };
}

/**
 * The host a miniature drag drives in a body: the shell's canvas, over the
 * bus. A pane is named to the shell by the card in front of it (`cardOfPane`),
 * since this card's own pane has another id in this page.
 */
export function bodyMiniatureHost(
  cardOfPane: (paneId: string) => string | null,
  bus: PageBus = pageBus(),
): MiniatureDropHost {
  return {
    async enumerateRemote(draggedPaneId) {
      const cardId = cardOfPane(draggedPaneId);
      if (cardId === null) return null;
      const result = await miniatureZones.on(bus).ask({ cardId }, { horizon: { ms: MINIATURE_ZONES_MS } });
      return result.ok ? result.value : null;
    },
    outline(zone) {
      miniatureOutline.on(bus).dispatch({ zone });
    },
    carry(kind) {
      miniatureCarry.on(bus).dispatch({ kind });
    },
    commit(zone, draggedPaneId) {
      const cardId = cardOfPane(draggedPaneId);
      if (cardId === null) return false;
      // Handed over: the shell commits, and flashes a refusal itself.
      miniatureCommit.on(bus).dispatch({ zone, cardId });
      return true;
    },
  };
}
