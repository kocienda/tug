# Brief: the Lens joins the imposition

## Why

The Lens sits outside the layout imposition scheme, and that costs three separate mechanisms that exist for no other reason: a bespoke geometry mode (`TugPaneState.anchor`), a deck-state invariant policing `anchor ⊕ slot`, and a CSS channel (`--tug-imposer-inset-left` / `--tug-imposer-inset-right`) whose only job is to tell the imposer where the Lens isn't.

It also puts a layout decision in the wrong place. "Which side is the Lens on" is answered today in an app-wide preference (Settings ▸ General), far from where every other layout decision is made. Settings ▸ General contains **nothing but** that one chooser, so folding it into the Layouts section retires the whole tab.

Bringing the Lens into the imposition gathers all layout-related matters into one place.

## The model

An imposition stops being one value and becomes a small record:

```ts
imposition = {
  kind: "two-up" | "three-up" | "four-up",   // how many card positions
  lens: "left" | "right",                    // which end of the strip the Lens holds
}
```

The strip is the ordered thing — `[Lens, 1, 2, 3]` or `[1, 2, 3, Lens]` — and the Lens is simply its first or last link.

## The Lens is the strip's fixed end, not a link in the chain

The imposer packs cards with a step rule (`lib/layout-imposer.ts`): cards stand one imposition gap apart when they fit, and overlap by equal amounts when they don't, sized so the strip's far edge lands exactly on the band's far edge.

The Lens must **not** take a step in that chain. A locked requirement of the imposition scheme is that an imposed card never slides under the Lens; if the Lens were an ordinary link, a crowded deck would overlap cards onto it. So the Lens holds its width and the cards share what remains — which is what the band inset already does today. The change is that the inset is derived from the *layout* rather than from a stored `anchor`, which is the whole point.

## Pinned, not evictable

Any manual move or resize releases a pane from its slot — that rule is already in force for every imposed pane. The Lens has no free geometry to fall back to, so it is the one exception: it resizes (re-packing the strip) but never evicts and never drags. This is the same exception the anchored rail has today.

## What retires

- `TugPaneState.anchor`, and the anchored geometry mode in `components/chrome/tug-pane.tsx` (its one-edge resize path, `data-anchored`). The Lens becomes *imposed and pinned* — it goes through `imposeStyle` like everything else, and so gains the imposition gap on all four sides, the deeper bottom gap, and rounded corners for free.
- Deck-state invariant 6 (`anchor ⊕ slot`, in `layout-tree.ts`), replaced by "at most one pane is the Lens".
- The `set-lens-side` action, `lensStore.anchorSide`, `useLensAnchorSide`, and `normalizeLensAnchorSide` (`lib/lens-store/`).
- `components/tugways/cards/settings-lens-body.tsx` and `.css`, and the `general` tab in `settings-card.tsx`. Settings drops to three tabs: Session Card, Text Card, Maker.

## The Layouts section becomes two controls

`lens` is independent of `kind`, so `kind` off plus `lens: "right"` reproduces today's default arrangement with the app-wide setting gone.

That makes the Lens section's picker two-axis: a Lens-position control above the N-up tiles. The tiles' miniatures should reflect the chosen Lens position live — choose Lens Left and all four pictures flip — so a tile stops being a picture of an abstract N-up and becomes a picture of the actual deck.

The picker design is spiked in the gallery card `components/tugways/cards/gallery-slot-layout.tsx` (Maker ▸ Layout & Structure, "Layouts Picker"). Proposal **P4** — two-column rows, each a scale miniature of the canvas with the rail drawn in and the cards packed away from it — is the chosen direction.

## Migration

This rides the additive-optional precedent `slot` already set in the v4 wire format (`serialization.ts`) — no version bump.

- A v4 blob's `anchor` on the Lens pane reads once into `imposition.lens`, and is dropped on the next save.
- The persisted tugbank value `dev.tugtool.lens` / `anchorSide` seeds `imposition.lens` on first boot, then is ignored.

## Open question: `lens` versus the Lens's open/closed state

`toggle-lens` (Cmd-L) opens and closes the Lens today, which is a second representation of roughly the same fact as `imposition.lens`. The two will collide unless the relationship is settled. Specifically: does Cmd-L write `imposition.lens`? Does closing the Lens mean the strip has no Lens end, and if so, what remembers which side to reopen on?

Recommended resolution, to be confirmed: `imposition.lens` carries the **side only** (`"left" | "right"`), the Lens's open/closed state stays exactly where it is today, and there is no `"off"` value. A closed Lens already means "no Lens end in the strip", and the remembered side is precisely what `imposition.lens` is for.

## Suggested commit boundaries

1. Model, wire format, and migration.
2. The Lens becomes an imposed pinned pane; `anchor` and the anchored geometry mode retire.
3. The two-axis Layouts picker.
4. Delete the app-wide setting, the store field, and the Settings General tab.
