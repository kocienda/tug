/**
 * Every card kind, registered by one list in every page.
 *
 * The shell's boot (`main.tsx`) and a body's (`body/body-main.ts`) both call
 * {@link registerCardKinds}, so a body page holds every kind the shell holds
 * and can mount whichever kind it is bound to — the warm spare is bound
 * before anyone knows which. Which kinds live in a body is a fact on each
 * registration (`CardRegistration.body`), not a second list here.
 *
 * Registration order is preserved exactly: it is the order the Layout card
 * lists its rows in.
 *
 * @module card-kinds
 */

import type { HostSettings } from "./lib/maker-mode-bridge";
import { registerHelloWorldCard } from "./components/tugways/cards/hello-world-card";
import { registerSessionCard } from "./components/tugways/cards/session-card-registration";
import { registerAboutCard } from "./components/tugways/cards/about-card";
import { registerSettingsCard } from "./components/tugways/cards/settings-card";
import { registerKeyboardCard } from "./components/tugways/cards/keyboard-card";
import { registerDevtoolsCard } from "./components/devtools/devtools-card";
import { registerJotsCard } from "./components/jots/jots-card-registration";
import { registerOverviewCard } from "./components/overview/overview-card-registration";
import { registerCardsCard } from "./components/cards/cards-card-registration";
import { registerLayoutCard } from "./components/layout/layout-card-registration";
import { registerArcsCard } from "./components/arcs/arcs-card-registration";
import { registerTextCard } from "./components/tugways/cards/text-card-registration";
import { registerFileViewCard } from "./components/tugways/cards/file-view-card-registration";
import { registerDiffCard } from "./components/tugways/cards/diff-card";
import { registerCommitCard } from "./components/tugways/cards/commit-card";

/** The maker kinds' registrations, loaded only where maker tooling is. */
export interface MakerTooling {
  registerGalleryCards: () => void;
  registerSpikeCards: () => void;
  registerFixtureCards: () => void;
}

/**
 * Whether this page carries maker tooling: the gallery, spike and fixture
 * cards.
 *
 * Three answers say yes. A Vite dev build; the app-test harness, which runs
 * the prebuilt `dist/` with `__tugTestMode` set; and a maker bundle whose
 * Vite was not ready, which falls back to serving that same `dist/` with
 * neither flag set — only the host's `makerMode` knows that deck is a
 * maker's, and without it the Maker menu's gallery item would be a dead
 * click. Outside the host the bridge resolves `null`, so a browser tab
 * answers from the first two alone.
 */
export async function isMakerTooling(
  hostSettings: Promise<HostSettings | null>,
): Promise<boolean> {
  if (import.meta.env.DEV || window.__tugTestMode === true) return true;
  return (await hostSettings)?.makerMode === true;
}

/**
 * Load the maker kinds' registrations, or nothing in a release page.
 *
 * Every one of them is a dynamic import, so a release build's reachable
 * chunks carry none of their ~40k lines. A boot awaits the result before
 * anything reads the registry: the deck's loader drops a pane whose only
 * card is unregistered at load, so a registration that resolved later would
 * lose every restored gallery or spike pane.
 */
export async function loadMakerTooling(
  hostSettings: Promise<HostSettings | null>,
): Promise<MakerTooling | null> {
  if (!(await isMakerTooling(hostSettings))) return null;
  const [gallery, spikes, fixtures] = await Promise.all([
    import("./components/tugways/cards/gallery-registrations"),
    import("./spikes/spike-registry"),
    import("./fixtures/fixture-registrations"),
  ]);
  return {
    registerGalleryCards: gallery.registerGalleryCards,
    registerSpikeCards: spikes.registerSpikeCards,
    registerFixtureCards: fixtures.registerFixtureCards,
  };
}

/**
 * Register every card kind, in the one order. `maker` is what
 * {@link loadMakerTooling} answered: its kinds follow the shipped ones.
 */
export function registerCardKinds(options: { maker: MakerTooling | null }): void {
  registerHelloWorldCard();
  registerSessionCard();
  registerAboutCard();
  registerSettingsCard();
  registerKeyboardCard();
  registerDevtoolsCard();
  // Every sidebar card must register unconditionally and before the deck
  // restores its layout, so its rail survives reload — `filterRegisteredCards`
  // drops panes whose only card's componentId is unregistered at load.
  registerJotsCard();
  registerOverviewCard();
  registerArcsCard();
  registerCardsCard();
  // Registration order is the order the Layout card lists its rows in.
  registerLayoutCard();
  registerTextCard();
  registerFileViewCard();
  registerDiffCard();
  registerCommitCard();
  options.maker?.registerGalleryCards();
  options.maker?.registerSpikeCards();
  options.maker?.registerFixtureCards();
}
