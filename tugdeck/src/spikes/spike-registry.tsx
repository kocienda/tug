/**
 * spike-registry.tsx — the whole of a spike's registration machinery.
 *
 * A **spike** is an exploratory design surface on the deck: a place to try a
 * layout, a typography question, or a new card shape against real components,
 * without any of it being a commitment. Spikes are not component demos — the
 * Component Gallery is the home for exemplary uses of established `Tug*`
 * components, and a spike that settles into a permanent showcase belongs there
 * instead.
 *
 * Adding a spike is one file plus two lines here: an `import` and an entry in
 * {@link SPIKES}. Everything a card registration normally has to decide — the
 * family, the accepted families, the size policy, the category, the closable
 * flag — is answered once, below, for every spike at once. A spike author
 * writes a `SpikeDef` and nothing else.
 *
 * The list is explicit rather than globbed. Vite's `import.meta.glob` would
 * make discovery zero-touch, but the registry-walking unit tests run under
 * `bun test`, which does not implement that transform; an explicit array is the
 * version that works in both runtimes.
 *
 * Two exits, both fine: a spike **graduates** (its component work moves to
 * `components/tugways/`, its durable findings to `tuglaws/`, and the spike file
 * is deleted), or it is simply **deleted**. Nothing here is meant to be
 * permanent.
 *
 * @module spikes/spike-registry
 */

import type React from "react";

import { registerCard, type CardSizePolicy } from "@/card-registry";
import { SpikeHome } from "./spike-home";
import { spike as slotLayoutSpike } from "./spike-slot-layout";
import { spike as pulseDisplaySpike } from "./spike-pulse-display";
import { spike as configureTugSpike } from "./spike-configure-tug";
import { spike as sessionIdentitySpike } from "./spike-session-identity";
import { spike as transcriptRegistersSpike } from "./spike-transcript-registers";
import { spike as pinnedHeadersSpike } from "./spike-pinned-headers";
import { spike as commitSurfacesSpike } from "./spike-commit-surfaces";
import { spike as placeCoordinateSpike } from "./spike-place-coordinate";
import { spike as cardChromeSpike } from "./spike-card-chrome";
import { spike as modalHeadersSpike } from "./spike-modal-headers";
import { spike as focusLanguageSpike } from "./spike-focus-language";
import { spike as lightChromeSpike } from "./spike-light-chrome";

/**
 * One design spike. The shape a spike file exports as `spike`.
 */
export interface SpikeDef {
  /** Kebab-case slug. The componentId is `spike-${name}`. */
  name: string;
  /** Card title, shown in the pane title bar and on the index row. */
  title: string;
  /** One line: the question this spike explores. Rendered by the index card. */
  blurb: string;
  /** lucide-react icon name. Defaults to `"FlaskConical"`. */
  icon?: string;
  /** Overrides {@link SPIKE_SIZE} for a spike that needs unusual room. */
  size?: CardSizePolicy;
  /**
   * True when the spike's subject IS the focus language, so it must read with
   * keyboard-focus rings on at rest rather than only once the keyboard drives.
   */
  kbfAtRest?: boolean;
  /** The card body. Receives the cardId the host assigned. */
  component: (cardId: string) => React.ReactNode;
}

/**
 * The size every spike gets unless it overrides it — the values most spikes
 * already picked by hand back when each one had to choose.
 */
export const SPIKE_SIZE: CardSizePolicy = {
  min: { width: 400, height: 350 },
  preferred: { width: 640, height: 520 },
};

/**
 * The single category every spike files under, so a multi-card spike pane's
 * `+` picker groups them all in one section.
 */
export const SPIKE_CATEGORY = { label: "Spikes", icon: "FlaskConical" } as const;

/** The componentId of the Spikes index card. */
export const SPIKE_HOME_ID = "spike-home";

/** The card family every spike registers under. */
export const SPIKE_FAMILY = "spike";

/** The componentId a spike's `name` resolves to. */
export function spikeComponentId(name: string): string {
  return `spike-${name}`;
}

/**
 * Every spike on the deck, in the order the index card lists them.
 *
 * To add one: write `spikes/spike-<name>.tsx` exporting `spike: SpikeDef`,
 * then add its `import` above and its entry here.
 */
export const SPIKES: readonly SpikeDef[] = [
  slotLayoutSpike,
  pulseDisplaySpike,
  configureTugSpike,
  sessionIdentitySpike,
  transcriptRegistersSpike,
  pinnedHeadersSpike,
  commitSurfacesSpike,
  placeCoordinateSpike,
  // Settled references: these began as spikes and closed into the reference
  // for their subject. They stay here rather than becoming permanent gallery
  // furniture, so the graduation path — durable content into tuglaws/, file
  // deleted — stays visible.
  cardChromeSpike,
  modalHeadersSpike,
  focusLanguageSpike,
  lightChromeSpike,
];

/**
 * Register the Spikes index card and every entry in {@link SPIKES}.
 *
 * Called from `main.tsx` alongside the other card registrations, and from the
 * `beforeAll` of any test that walks the registry. A register function that
 * exists but is never called does not fail loudly — it makes cards vanish from
 * saved layouts, because `filterDeckStateByRegistration` drops restored cards
 * whose componentId no longer resolves.
 */
export function registerSpikeCards(): void {
  registerCard({
    componentId: SPIKE_HOME_ID,
    contentFactory: () => <SpikeHome />,
    defaultMeta: { title: "Spikes", icon: "FlaskConical", closable: true },
    family: SPIKE_FAMILY,
    acceptsFamilies: [SPIKE_FAMILY],
    sizePolicy: SPIKE_SIZE,
    category: SPIKE_CATEGORY,
  });

  for (const def of SPIKES) {
    registerCard({
      componentId: spikeComponentId(def.name),
      contentFactory: def.component,
      defaultMeta: {
        title: def.title,
        icon: def.icon ?? "FlaskConical",
        closable: true,
      },
      family: SPIKE_FAMILY,
      acceptsFamilies: [SPIKE_FAMILY],
      sizePolicy: def.size ?? SPIKE_SIZE,
      category: SPIKE_CATEGORY,
      ...(def.kbfAtRest === true ? { kbfAtRest: true } : {}),
    });
  }
}
