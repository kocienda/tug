/**
 * A real `DeckManager` mounted into a jsdom container, for the chrome layer's
 * fast tests (`deck-canvas`, `tug-sheet`, `card-host`).
 *
 * {@link installJsdom} must run before any deck module loads — React DOM and
 * the deck read `window` / `document` and construct events from the globals at
 * import — so a test file calls it at module scope and imports the deck
 * dynamically afterwards ({@link mountDeck} does). Bun ships its own `Event`
 * family, and a Bun `Event` dispatched at a jsdom target is refused, so jsdom's
 * classes replace Bun's while installed; {@link JsdomSubstrate.restore} puts
 * every replaced global back, because test files share one process.
 *
 * The jsdom window itself is made ONCE per process and shared by every file
 * that installs it; each install gets a fresh container. Deck modules are
 * loaded once per process too, and capture `window` objects at import, so a
 * second window would leave them holding the first.
 *
 * jsdom lacks what the deck reads for layout and motion, so those are stubbed
 * to their resting answers: `ResizeObserver` observes nothing, `matchMedia`
 * matches nothing, `CSS.supports` is false, nothing is ever animating, and
 * `fetch` (tugbank) answers "ok" and drops the write.
 */

import { JSDOM } from "jsdom";

import type { DeckManager } from "../deck-manager";
import type { SeedDeckStateArgs } from "../deck-manager-test-seed";
import type { DeckState } from "../layout-tree";

export interface JsdomSubstrate {
  win: Window & Record<string, unknown>;
  /** The element the deck mounts into. */
  container: HTMLElement;
  /** Put back every global this substrate replaced. */
  restore(): void;
}

/** Event classes Bun ships natively, which jsdom's must replace. */
const REPLACED_CLASSES = [
  "Event",
  "CustomEvent",
  "EventTarget",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
  "FocusEvent",
  "UIEvent",
  "InputEvent",
  "DOMParser",
  "Node",
  "Element",
  "HTMLElement",
];

let sharedWindow: (Window & Record<string, unknown>) | null = null;

/**
 * What each global key held before any install wrote it, captured once per
 * process — `undefined` for a key Bun never had. A key in here is ours on
 * every later install too.
 */
const originals = new Map<string, unknown>();

function processWindow(): Window & Record<string, unknown> {
  if (sharedWindow === null) {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      pretendToBeVisual: true,
      url: "http://localhost/",
    });
    sharedWindow = dom.window as unknown as Window & Record<string, unknown>;
  }
  return sharedWindow;
}

export function installJsdom(): JsdomSubstrate {
  const win = processWindow();
  const g = globalThis as unknown as Record<string, unknown>;
  const replaced = new Set<string>();
  const install = (key: string, value: unknown): void => {
    if (!originals.has(key)) originals.set(key, g[key]);
    replaced.add(key);
    g[key] = value;
  };

  for (const key of Object.getOwnPropertyNames(win)) {
    if (key in g && !originals.has(key)) continue;
    try {
      install(key, win[key]);
    } catch {
      // A getter jsdom refuses outside its own realm; nothing here needs it.
    }
  }
  for (const key of REPLACED_CLASSES) {
    if (win[key] !== undefined) install(key, win[key]);
  }
  install("window", win);
  install("document", win.document);
  install("navigator", win.navigator);

  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  const matchMedia = (): MediaQueryList =>
    ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }) as unknown as MediaQueryList;
  const cssStub = { supports: () => false, escape: (s: string) => s };
  // jsdom has no Web Animations: nothing is ever animating, and nothing runs.
  const elementProto = (win.Element as unknown as { prototype: Record<string, unknown> }).prototype;
  elementProto.getAnimations ??= () => [];
  elementProto.animate ??= () => ({
    cancel() {},
    finish() {},
    finished: Promise.resolve(),
    onfinish: null,
  });
  install("ResizeObserver", NoopResizeObserver);
  install("matchMedia", matchMedia);
  install("CSS", cssStub);
  win.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver;
  win.matchMedia = matchMedia;
  win.CSS = cssStub;
  // No tugbank in a unit test: every write answers "ok" and is dropped.
  install("fetch", async () => new Response("{}", { status: 200 }));

  // A fresh mount point per file, and no state left on <html> by the last.
  win.document.body.replaceChildren();
  for (const attr of Array.from(win.document.documentElement.attributes)) {
    win.document.documentElement.removeAttribute(attr.name);
  }
  const container = win.document.createElement("div");
  container.id = "deck";
  win.document.body.appendChild(container);

  return {
    win,
    container,
    restore() {
      // Put back by assignment, never `delete`: deleting from the global
      // object, and re-adding at the next install, turns it into a dictionary
      // JSC cannot cache, which makes every global lookup in every later file
      // a slow runtime call (an allocation-heavy test ran 5× slower). A key
      // Bun never had goes back to `undefined` and stays a property.
      for (const key of replaced) g[key] = originals.get(key);
    },
  };
}

/** One macrotask past React's commit and the deck's deferred notifies. */
export const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

/**
 * Construct a test-mode `DeckManager` over `substrate.container`, seed it with
 * `state` (and `seed`'s card-state bags or focus), and wait for the commit to
 * land.
 */
export async function mountDeck(
  substrate: JsdomSubstrate,
  state: DeckState,
  seed: Omit<SeedDeckStateArgs, "state"> = {},
): Promise<DeckManager> {
  const { DeckManager } = await import("../deck-manager");
  const { TugConnection } = await import("../connection");
  const manager = new DeckManager(
    substrate.container,
    new TugConnection("ws://localhost/ws"),
    undefined,
    undefined,
    undefined,
    undefined,
    { testMode: true },
  );
  manager.seedDeckState({ ...seed, state });
  await settle();
  return manager;
}

/**
 * Destroy the deck, let React's scheduler drain against the jsdom window, and
 * only then restore the globals — a scheduled task that wakes to a restored
 * `window` throws between tests.
 */
export async function unmountDeck(
  substrate: JsdomSubstrate,
  manager: DeckManager | undefined,
): Promise<void> {
  manager?.destroy();
  await settle();
  substrate.restore();
}

/** A one-pane deck seed: `cardIds` in one free pane, the first active. */
export function onePaneDeck(componentId: string, cardIds: readonly string[]): DeckState {
  return {
    cards: cardIds.map((id) => ({ id, componentId, title: id, closable: true })),
    panes: [
      {
        id: "pane-1",
        position: { x: 20, y: 20 },
        size: { width: 600, height: 480 },
        cardIds: [...cardIds],
        activeCardId: cardIds[0],
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "pane-1",
    imposition: { sidebars: {} },
    hasFocus: true,
  };
}

/** The text of the deck's error banner, or `null` — a red names the error. */
export function errorBannerText(container: HTMLElement): string | null {
  const banner = container.querySelector('[data-slot="tug-banner"][data-variant="error"]');
  return banner?.textContent?.slice(0, 600) ?? null;
}
