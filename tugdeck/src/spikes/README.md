# Spikes

A **spike** is an exploratory design surface on the deck. It is where you try a layout, a typography question, a new card shape, or a comparison between two treatments — against real components, with none of it being a commitment.

A spike is not a component demo. The Component Gallery (`components/tugways/cards/gallery-registrations.tsx`) is the home for exemplary uses of established `Tug*` components: it shows proper usage and the range of an API, and every card in it is meant to be read as documentation. A spike shows an idea. If a spike settles into a permanent showcase of a shipping component, it has graduated and belongs in the gallery.

A spike is also not a test fixture. A card whose only consumer is the app-test harness lives in `tugdeck/src/fixtures/`.

## Making one

One file plus two lines.

Write `spike-<name>.tsx` in this directory:

```tsx
/**
 * spike-<name>.tsx — <the question this spike explores>.
 */

import "./spike.css";

import React from "react";

import type { SpikeDef } from "./spike-registry";

function Spike<Name>(): React.ReactElement {
  return (
    <div className="sp-content">
      <section className="sp-section">
        <h2 className="sp-section-title">A section</h2>
        {/* the idea */}
      </section>
    </div>
  );
}

export const spike: SpikeDef = {
  name: "<name>",
  title: "<Title>",
  blurb: "<the one-line question, shown on the index row>",
  component: () => <Spike<Name> />,
};
```

Then add two lines to `spike-registry.tsx` — the `import`, and the entry in `SPIKES`:

```tsx
import { spike as nameSpike } from "./spike-<name>";

export const SPIKES: readonly SpikeDef[] = [
  // …
  nameSpike,
];
```

That is the whole registration. The family, the accepted families, the size policy, the category, and the closable flag are answered once in `spike-registry.tsx` for every spike at once. Override `size` on the `SpikeDef` if your spike needs unusual room; set `kbfAtRest: true` only if the spike's subject *is* the focus language.

`/tugplug:spike-card` does all of the above for you.

## Styling

`spike.css` gives you `.sp-content`, `.sp-section`, and `.sp-section-title`. Anything else goes in your own sibling `spike-<name>.css`, the same way a component owns its stylesheet ([L16]).

Never use the gallery's own class vocabulary or import `gallery.css`. A spike that reaches into the gallery's stylesheet is still a gallery card, and detaching from that borrowed infrastructure is the entire point of this directory. (A drift test greps this directory for gallery classes, so the rule is enforced rather than remembered.) Use design tokens, never raw hex ([L15]).

Compose existing `Tug*` components rather than hand-rolling equivalents ([L20]) — that is true even in a spike, and especially in a spike, because a spike that hand-rolls a list is exploring the wrong thing.

## Getting to it on the deck

**Maker ▸ New Spikes Card** (debug builds, Maker mode on) opens the Spikes index: one row per spike, showing its title and blurb. Clicking a row mounts that spike as a tab in the same pane.

The index rows are the way in to a *second* spike, not just a convenience. A pane opened from the menu holds one card, and a single-card pane's `+` picker only offers the `"standard"` family — no spikes appear in it. Once an index row has added one, the pane is multi-card and its `+` picker lists every spike as well.

## Getting out

Two exits, both good:

- **Graduate it.** Component work moves to `components/tugways/`, durable findings move to `tuglaws/`, and the spike file is deleted. A settled spike kept as permanent furniture is just a gallery card in the wrong room.
- **Delete it.** Remove the file and its two registry lines. A spike nobody is exploring any more is not documentation of anything.

One after-effect worth knowing: deleting a spike that is open in somebody's saved layout means that pane is dropped on next launch, with a `[DeckManager] filterRegisteredCards: dropping card …` console warning. That is correct behavior — `filterDeckStateByRegistration` removes cards whose componentId no longer resolves and then removes panes left empty — but a pane vanishing is worth having been told about rather than discovering.
