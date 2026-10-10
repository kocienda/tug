/**
 * Layout persistence: the deck's tugbank write family and its boot read.
 *
 * Owns the debounced layout save, the test-mode-guarded `putLayout` /
 * `putCardState` writers, and the parse of the boot layout into spaces. It
 * holds no spaces of its own: the manager hands in the persistable snapshot
 * ({@link LayoutPersistenceDeps.spacesState}) on every save, and the boot read
 * returns what it found for the manager to seed — so the live spaces have one
 * owner and this module never reaches back for them.
 *
 * Batching stays with the manager: a `batchGesture` holds the save with the
 * notify and re-arms {@link LayoutPersistence.scheduleSave} once on the way
 * out, so the timer here only ever sees the gesture's final state.
 */

import type { CardStateBag, DeckState } from "./layout-tree";
import { buildDefaultLayout, serialize, deserialize } from "./serialization";
import { MAIN_SPACE_NAME, type SpaceRecord, type SpacesState } from "./spaces";
import { putLayout, putCardState } from "./settings-api";
import { preloadTheme, type ThemeName } from "./contexts/theme-provider";

/** Debounce delay for saving layout (ms) */
const SAVE_DEBOUNCE_MS = 500;

/**
 * Read the DEBUG-only `__tugPersistInTestMode` flag. When `true` AND
 * `__tugTestMode` is also `true`, the test-mode persistence bypass
 * in the guarded writers is skipped — writes go through.
 * Used by cold-boot harness tests that pair test-mode IPC with
 * per-test `TUGBANK_PATH` isolation. See
 * `tugapp/Sources/TestHarness/TestHarnessUserScript.swift`.
 */
function shouldPersistInTestMode(): boolean {
  return typeof window !== "undefined" && window.__tugPersistInTestMode === true;
}

export interface LayoutPersistenceDeps {
  /** Test mode suppresses every write unless `__tugPersistInTestMode` is set ([D02]). */
  readonly testMode: boolean;
  /** Every space as a persistable record, read at save time. */
  spacesState(): SpacesState;
}

/** What the boot layout read found, for the manager to seed its spaces from. */
export interface BootLayout {
  spaces: SpaceRecord[];
  activeSpaceId: string;
  /** The ACTIVE space's deck, already filtered — the manager's `deckState`. */
  deck: DeckState;
  /** True when no persisted layout was read and the factory default was built. */
  fresh: boolean;
}

export interface BootLayoutInput {
  /** The host-provided layout blob, or `null` when there is none to honour. */
  initialLayout: object | null;
  canvasWidth: number;
  canvasHeight: number;
  /** The theme the factory-default space wears. */
  initialTheme: ThemeName;
  /** What a loaded space that names no theme takes. */
  fallbackTheme: ThemeName | undefined;
  /** Drop unregistered cards (and the panes they empty) from a deck. */
  filterRegisteredCards(state: DeckState): DeckState;
}

/**
 * Read every space out of the boot layout and return them with the ACTIVE
 * space's deck — which the manager assigns to its `deckState`.
 *
 * `filterRegisteredCards` runs over every space's deck, not only the active
 * one: a parked space whose deck names a component this build no longer
 * registers would otherwise carry the bad card until the day it is activated
 * and then fail there, a long way from the boot that read it (brief [F09]).
 */
export function loadBootLayout(input: BootLayoutInput): BootLayout {
  const { filterRegisteredCards } = input;
  let loaded: SpacesState | null = null;

  if (input.initialLayout !== null) {
    try {
      const json = JSON.stringify(input.initialLayout);
      loaded = deserialize(
        json,
        input.canvasWidth,
        input.canvasHeight,
        input.fallbackTheme,
      );
    } catch (e) {
      console.warn("DeckManager: failed to deserialize initialLayout from API, falling back", e);
    }
  }

  if (loaded === null) {
    const id = crypto.randomUUID();
    return {
      spaces: [{ id, name: MAIN_SPACE_NAME, deck: null, theme: input.initialTheme }],
      activeSpaceId: id,
      deck: filterRegisteredCards(buildDefaultLayout()),
      fresh: true,
    };
  }

  const activeIndex = Math.max(
    0,
    loaded.spaces.findIndex((s) => s.id === loaded.activeSpaceId),
  );
  const spaces: SpaceRecord[] = loaded.spaces.map((space, i) => ({
    id: space.id,
    name: space.name,
    deck: i === activeIndex ? null : filterRegisteredCards(space.deck),
    ...(space.focusedCardId !== undefined
      ? { focusedCardId: space.focusedCardId }
      : {}),
    ...(space.theme !== undefined ? { theme: space.theme } : {}),
  }));
  // Every workspace's theme is loaded now, so that switching to one never
  // waits on a stylesheet.
  for (const space of spaces) {
    if (space.theme !== undefined) preloadTheme(space.theme);
  }

  return {
    spaces,
    activeSpaceId: spaces[activeIndex].id,
    deck: filterRegisteredCards(loaded.spaces[activeIndex].deck),
    fresh: false,
  };
}

export class LayoutPersistence {
  private readonly deps: LayoutPersistenceDeps;

  /** Debounce timer for layout saves */
  private saveTimer: number | null = null;

  constructor(deps: LayoutPersistenceDeps) {
    this.deps = deps;
  }

  /**
   * `putLayout` with a test-mode bypass. Resolves the write's success
   * flag, or `true` under the bypass — a suppressed write is not a
   * failed one, and teardown callers read this to decide whether the
   * layout actually landed. The `__tugPersistInTestMode` escape hatch
   * lets the cold-boot harness tests write through ([D02]).
   */
  putLayoutGuarded(layout: object): Promise<boolean> {
    if (this.deps.testMode && !shouldPersistInTestMode()) return Promise.resolve(true);
    return putLayout(layout);
  }

  /**
   * `putCardState` with a test-mode bypass. Resolves the write's
   * success flag, or `true` under the bypass so `flushDirtyCardStates`
   * can gather the batch without special-casing the empty-network
   * branch. See {@link putLayoutGuarded} for the escape hatch.
   */
  putCardStateGuarded(
    cardId: string,
    bag: CardStateBag,
    options?: { keepalive?: boolean; sync?: boolean },
  ): Promise<boolean> {
    if (this.deps.testMode && !shouldPersistInTestMode()) return Promise.resolve(true);
    return putCardState(cardId, bag, options);
  }

  /** Serialize every space and write it now. */
  saveLayout(): Promise<boolean> {
    const serialized = serialize(this.deps.spacesState());
    return this.putLayoutGuarded(serialized);
  }

  /** Arm (or re-arm) the debounced layout save. */
  scheduleSave(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
    }
    this.saveTimer = window.setTimeout(() => {
      this.saveLayout();
      this.saveTimer = null;
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Cancel a pending debounced save and report whether there was one. The
   * caller decides whether to write in its place — teardown writes when one
   * was pending or when asked to always.
   */
  takePendingSave(): boolean {
    if (this.saveTimer === null) return false;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    return true;
  }

  /** Write any pending debounced save now, so a destroyed deck loses nothing. */
  dispose(): void {
    if (this.takePendingSave()) this.saveLayout();
  }
}
