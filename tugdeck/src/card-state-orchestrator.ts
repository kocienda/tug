/**
 * CardStateOrchestrator — the framework's single entry point for
 * capturing a card's full state bag ([D13], [A9c]).
 *
 * Before this module, every save trigger (will-phase subscribers,
 * close-before-destroy flush, `saveState` RPC) dispatched to a card's
 * own save callback ad hoc. Each callback built its own bag from
 * framework-owned axes; component-level state had no place to land.
 * The orchestrator routes every trigger through a single call:
 *
 *   - `captureCardState(cardId)` — invokes the card's registered
 *     assembler (framework axes + `bag.content`) and walks the per-card
 *     `ComponentStatePreservationRegistry` parent-first, merging
 *     harvested component state into `bag.components`.
 *
 * Restore is NOT the orchestrator's responsibility. Components mount
 * in their saved state via `useSavedComponentState`
 * inside a `useState` initializer; imperative renderers (TerminalBlock's
 * virtualized scroller, FileBlock's CM6 mount) read saved scroll via
 * `useSavedRegionScroll` and write it at creation. The orchestrator is
 * capture-only.
 *
 * An **assembler** is the per-card capture closure CardHost supplies —
 * the code that today lives in `saveCurrentCardStateRef.current` but
 * without the `store.setCardState` write and without `bag.components`.
 * Registering it with the orchestrator is the moral equivalent of
 * `registerSaveCallback`: the orchestrator owns the reference so any
 * trigger can invoke the assembler's `capture()` uniformly.
 *
 * The orchestrator is instance-scoped (not a module-level singleton)
 * so tests can construct their own without polluting other tests, and
 * DeckManager owns the production instance.
 */

import type { CardStateBag } from "./layout-tree";
import type { ComponentStatePreservationRegistry } from "./components/tugways/component-state-preservation-registry";
import type { SaveCallbackSource } from "./deck-trace";
import { isDevEnv } from "./lib/dev-env";

/**
 * Per-card assembler handle. Supplied by `CardHost` on mount and
 * discarded on unmount. `capture` returns the framework-axes bag (every
 * axis except `components`, which the orchestrator layers on top).
 */
export interface CardAssembler {
  /**
   * `source` is the triggering save path, forwarded from
   * `invokeSaveCallback`. Optional so an assembler that captures the
   * same way for every trigger can ignore it entirely.
   */
  capture: (source?: SaveCallbackSource) => CardStateBag;
}

/**
 * Minimal shape the orchestrator needs for registry lookups. Keeping
 * this to a function parameter keeps the orchestrator free of a
 * concrete `CardDeck` dependency so tests can inject a plain
 * `Map`-backed lookup.
 */
export type ComponentStatePreservationRegistryLookup = (
  cardId: string,
) => ComponentStatePreservationRegistry | undefined;

/**
 * Harvest every registered component's `captureState` output in
 * parent-first tree order. Returns `undefined` when the registry is
 * absent or empty so `bag.components` stays `undefined` on cards that
 * do not participate — no empty objects in the round-trip.
 *
 * Dev-only: a throwing `captureState` is logged and skipped. Production
 * swallows silently; the component's slot is missing from the bag,
 * which is the best outcome when the alternative is a full-card save
 * failure.
 */
function harvestComponents(
  registry: ComponentStatePreservationRegistry | undefined,
): Record<string, unknown> | undefined {
  if (!registry) return undefined;
  const entries = registry.entriesInTreeOrder();
  if (entries.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of entries) {
    const capture = entry.captureRef.current;
    if (!capture) continue;
    try {
      out[key] = capture();
    } catch (e) {
      if (isDevEnv()) {
        console.warn(`[A9c] captureState threw for "${key}":`, e);
      }
    }
  }
  return out;
}

/**
 * Framework orchestrator for per-card capture. Owns the map of
 * card-level assemblers; defers component-level state to the
 * caller-injected registry lookup.
 */
export class CardStateOrchestrator {
  private readonly assemblers: Map<string, CardAssembler> = new Map();
  private readonly getRegistry: ComponentStatePreservationRegistryLookup;

  constructor(getRegistry: ComponentStatePreservationRegistryLookup) {
    this.getRegistry = getRegistry;
  }

  /**
   * Register a card's assembler. Returns an unregister function so the
   * caller can wire cleanup into a `useLayoutEffect` return.
   *
   * A second register for the same `cardId` replaces the first — this
   * mirrors `registerSaveCallback`'s behavior and lets `CardHost`
   * re-register across renders without explicit unregister calls.
   */
  registerAssembler(cardId: string, assembler: CardAssembler): () => void {
    this.assemblers.set(cardId, assembler);
    return () => {
      if (this.assemblers.get(cardId) === assembler) {
        this.assemblers.delete(cardId);
      }
    };
  }

  /**
   * Assemble the full bag for `cardId`. If the card has no registered
   * assembler, returns the component-harvest alone (an empty bag when
   * no components are registered either). Callers that care about the
   * "card not known" case should check the registry themselves.
   */
  captureCardState(cardId: string, source?: SaveCallbackSource): CardStateBag {
    const assembler = this.assemblers.get(cardId);
    const base: CardStateBag = assembler ? assembler.capture(source) : {};
    const components = harvestComponents(this.getRegistry(cardId));
    if (components === undefined) return base;
    return { ...base, components };
  }
}
