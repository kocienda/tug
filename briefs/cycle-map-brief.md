<!-- brief-skeleton v1 -->

# The cycle map: one shared component, at two sizes, with its layout under test

**Purpose:** Stage 4 of `briefs/cycle-rollout-brief.md`. The cycle map exists only inside the Cycle Band spike, where its layout has no tests and its view reads the spike's fixture types. Stages 5 and 6 both need it, so it has to become one tugways component that both can compose.

---

## Purpose {#purpose}

The rollout brief settles the map's place in the work: "The spike's layout file and map view graduate into `tugdeck/src/components/tugways/`, drawn at two sizes, with unit tests on the layout. Both surfaces compose it." ([B19] there), and stage 4 "waits on nothing" ([B18] and the Exit table there). This brief covers that stage and nothing more. The user's instruction for it: graduate the map layout and the map view, at two sizes, with unit tests on the layout, and **leave the spike in place**.

What the map draws is already settled in the rollout brief ([B06], [B12], [B14], [B15] there) and was reviewed rendered across about ten rounds. This stage moves the map out of the spike without changing what it looks like.

---

## Evidence {#evidence}

**[F01] The layout is pure, self-contained and untested.** `tugdeck/src/spikes/spike-cycle-band-layout.ts` (190 lines) exports `cycleMap(entries)`, `reducedWaits(entries)` and the types `CycleMapEntry`, `CycleMapSeat`, `CycleMapNode`, `CycleMapWire` and `CycleMap`. It imports nothing. Its input is `{ n, waits, late? }` and its output is whole-number columns and rows. It does longest-path layering, drops implied waits, gives a wire a held seat in each column it passes, orders each column with up to eight alternating barycentre sweeps and keeps the order with the fewest crossings, and seats a `late` node in the column just before the first node that waits on it. **(verified, read)**

**[F02] The layout's output for the spike's eight-entry cycle was measured.** I ran `cycleMap` on the spike's `EIGHT` fixture, with seals −1 and −2 for sketches A and B, the way `mapEntries` builds them. The result has 5 columns and 4 rows. Seal A is in column 0, entries 1, 2 and 3 in column 1, entry 4 in column 2, entries 5 and 7 and seal B in column 3, and entries 6 and 8 in column 4. `reducedWaits` drops 8's wait on 4, which 5 and 7 already imply. The wire 2→6 holds seats in columns 2 and 3, and 3→7 holds one in column 2. There are 12 wires. **(verified, run with `bun` against the spike file)**

**[F03] The layout tolerates bad input without hanging.** `cycleMap([])` returns zero columns, zero rows and no nodes. A wait on a number not in the input is ignored. A two-entry loop (1 waits on 2, 2 waits on 1) terminates, but it returns 3 columns with column 0 empty, and a wire that runs backwards. **(verified, run)**

**[F04] The view is one function inside the spike, and it is bound to the spike's fixture.** `CycleMapView` (`tugdeck/src/spikes/spike-cycle-band.tsx:374`) takes the spike's `Reading` (its `Entry[]` plus a `runs` map), and from that it derives each tile's state with `stateOf`, its step pips with `doneOf`, its tooltip with `sentenceOf`, and whether a wire is met from `runs`. Beside it in the same file sit the map's measures `MAP_FULL` `{colW 108, rowH 58, tileW 64, tileH 42, pad 10}` and `MAP_COMPACT` `{68, 38, 44, 28, 6}`, the geometry `xOf`, `yOf`, `wirePath` and `wireHead`, the sketch-to-seal transform `sealOf`, `headsOf` and `mapEntries`, the asset keys `entryKey` and `sketchKey`, `letterOf`, and the selection helper `togglePick`. **(verified, read)**

**[F05] The two sizes are the same view with a `compact` flag.** The Session card frame calls `CycleMapView` at full size (`spike-cycle-band.tsx:1071`) and the sidebar frame calls it with `compact` (`:1384`). The flag picks the measures and sets `data-compact`. The CSS (`spike-cycle-band.css:207–410` and `:741–781`) shrinks the type, the icons, the pips and the elsewhere dot under `data-compact`. **(verified, read)**

**[F06] The map's chrome differs between the two hosts.** `.sp-cycle-map-scroll` owns the horizontal overflow, and also the padding, the well background and the bottom hairline. The sidebar overrides the padding, the border, the radius and the margin through `.sp-cycle-side-pin .sp-cycle-map-scroll` (`:741`). The ground click that clears the selection is on that same scroll element. **(verified, read)**

**[F07] Tile sizes are written twice.** `.sp-cycle-tile` sets `width: 64px; height: 42px` and `.sp-cycle-sketch-seal` sets `42px`, while the view also sets every tile's and seal's size inline from the measures. The inline values win, so the CSS sizes are dead at the full size and wrong at the compact one. **(verified, read)**

**[F08] Hover highlighting goes through React state.** The view keeps `const [pointed, setPointed] = useState<number | null>(null)` and sets it on `onPointerEnter` and `onPointerLeave`, so that `data-hot` lands on the wires into the tile under the pointer. Nothing but the renderer reads `pointed`. Under [L06] in `tuglaws/tuglaws.md`, that is appearance state, and it belongs in the DOM. **(verified, read)**

**[F09] Stage 1's record is on `main`, and it differs from the spike in one place that matters to the map.** `CycleEntry` in `tugrust/crates/tugarc-core/src/cycle.rs` (landed `03cb88584`) has `n: u32`, `waits: Vec<u32>`, and **`from: Vec<String>`, the letters of every sketch the entry came from**. The spike's `Entry.sketch` is a single `1 | 2`. `CycleSketch` carries a `letter`. `EntryState` serialises as `joined`, `running`, `waiting` or `ready`, the same four words the spike uses. The record refuses waits that are missing, that point at the entry itself, or that would close a loop. A sketch can be added before any entry names it. The record carries no step counts; the cycle view carries each entry's arc stages. **(verified, read)**

**[F10] Tugways conventions.** Sibling components pair a `.tsx` and a `.css` with a module docstring, a `data-slot`, and a `tug-`-prefixed class (`.tug-arc-lifecycle-mark`). They use component-scoped `--tugx-<component>-*` tokens with defaults at the point of use, alongside the shared `--tug7-*` tone tokens ([L19], `tuglaws/component-authoring.md`). Pure-logic tests live in `tugdeck/src/components/tugways/__tests__/` as `*.test.ts`. **(verified, read; `component-authoring.md` itself was not read in full)**

**[F11] The spike is registered in `tugdeck/src/spikes/spike-registry.tsx`, and nothing outside the spike imports its files.** **(verified, grep)**

---

## Decisions {#decisions}

**[B01] Two modules land, and the spike's three files are not touched.** The layout goes to `tugdeck/src/components/tugways/cycle-map-layout.ts` and the view goes to `cycle-map.tsx` with `cycle-map.css`, beside it. The spike keeps its own copies and goes on rendering exactly as reviewed. It is not re-pointed at the new component: it is the reference the new component is judged against, and editing it would reopen a review the user has closed. The copies live side by side until stage 7 retires the spike. That duplication is deliberate and has an end.

**[B02] The layout moves without changing its behaviour, and its names change where they would collide with the component.** `cycleMap` becomes `layoutCycleMap`, and its result type `CycleMap` becomes `CycleMapLayout`, so that `CycleMap` can name the component. `reducedWaits` and the seat, node and wire types keep their names. The algorithm in [F01] is carried over as it is: the same layering, the same reduction, the same held seats, the same sweeps and the same `late` seating. A test fixed to [F02] is what proves the move kept it.

**[B03] The sketch-to-seal transform moves into the layout module, keyed on letters, and allows an entry to come from several sketches.** The spike builds the layout input from the cycle itself (`mapEntries`, `headsOf`, `sealOf`), with one sketch per entry. Stage 1's record allows several ([F09]). The shared transform reads `from: string[]`:

- An entry heads sketch L when L is in its `from` and none of its waits is on an entry that is also from L.
- An entry that heads two sketches gets a wire from each seal.
- A sketch no entry heads gets a seal with no wires, and it stays in column 0, because `late` has no node to seat it before.

Seals stay negative numbers inside the layout, an internal detail no caller sees. This transform is pure and is under test with the rest of the layout ([B07]).

**[B04] The geometry is pure and lives in the layout module too.** The two sets of measures, the pixel position of each tile and seal, the overall width and height, and each wire's path and arrowhead (`xOf`, `yOf`, `wirePath`, `wireHead`, and the width and height arithmetic at `spike-cycle-band.tsx:396–397`) become one function over a layout and a size. It returns rectangles and path strings. That leaves the view with no arithmetic, and it makes the two sizes testable without a DOM. For the eight-entry fixture this gives 516 × 236 px at full size and 328 × 154 px at compact, worked from the spike's constants.

**[B05] The component is presentational. It derives no state and reads no store.** Stage 4 waits on nothing ([B18] in the rollout brief), so the component cannot depend on stage 3's feed or store. The rollout brief's [B04] also puts state derivation upstream. So `CycleMap` takes what it draws:

- **tiles:** `n`, `waits`, `from`, a `state` of `joined`, `running`, `ready` or `waiting` (the record's four words, [F09]), an optional `elsewhere`, optional `steps` as `{ done, total }` for the running pips, and a `label`, the sentence used for both the tooltip and the accessible name;
- **sketches:** `letter` and `want`, the tooltip text;
- **`size`:** `"full"` or `"compact"`;
- **`chosen`:** the selected keys;
- **`onPress(key, shift)`** and **`onClear()`**.

A wire is met when the tile it leaves is `joined`, the spike's rule restated over state rather than `runs`. Hosts turn the store's cycle into these props in stages 5 and 6. Nothing in this stage knows where the props come from.

**[B06] Selection stays controlled by the host. Its one rule and its keys are shared.** The map reports presses and the host holds the set, because each host does something different after a press: the shade scrolls its list and the sidebar pins it ([B14] in the rollout brief). The rule both hosts apply is the same ([B15] there): a press selects one, a shift-press toggles one, a press on the ground clears. It ships as a pure `pickOnMap(chosen, key, shift)`, with the spike's `togglePick` folded into it. The keys `entryKey(n)` and `sketchKey(letter)` are exported, so a host's list and the map name an asset the same way.

**[B07] The unit tests cover the layout module: layering, reduction, seats, the seal transform, geometry and selection.** The file is `tugdeck/src/components/tugways/__tests__/cycle-map-layout.test.ts`, under bun, with no DOM. The guarantees each test pins:

- The eight-entry fixture lays out exactly as [F02] records.
- A wait another wait implies is dropped, and only that wait.
- A wire that passes a column holds a seat there, and the wire's seats run from its start to its end.
- The fewest-crossings ordering never does worse than the order it started from.
- A `late` node sits in the column just before the first node that waits on it, and a `late` node nothing waits on stays in column 0.
- The empty cycle has no columns and no rows. A wait on an unknown number is ignored.
- Malformed input terminates. Stage 1 refuses loops ([F09]), so the layout does not have to draw one well, but it must never hang on one.
- Every node gets exactly one seat, and no two nodes share a seat.
- The seal transform heads entries as [B03] says, including an entry from two sketches and a sketch with no heads.
- The geometry at both sizes gives the sizes in [B04], and every tile rectangle sits inside them.
- `pickOnMap` follows [B06].

The view itself gets no app-test in this stage, because no surface mounts it yet. Its first rendered verdict comes with stage 5 or 6.

**[B08] The component's CSS is the spike's map CSS, renamed and scoped, with the duplicates removed.** `sp-cycle-*` becomes `tug-cycle-map-*`, with `data-slot="tug-cycle-map"`. `data-size="compact"` replaces `data-compact`. The colours, the dash on waiting wires, the solid gray borders on waiting tiles, and the filtering fade carry over unchanged. Lengths that a theme or a host might tune go through `--tugx-cycle-map-*` tokens with the spike's values as defaults. The fixed CSS sizes from [F07] go, and the measures from [B04] are the only source of a tile's size.

**[B09] The component owns the drawn map, its horizontal overflow and its ground. The host owns the chrome around it.** In the spike, the padding, the well background, the hairline and the radius are exactly what the two hosts set differently ([F06]). So `CycleMap` renders the overflow element, which takes the ground click, and the positioned map inside it, and paints no well, padding or border of its own. Each host gives it those through its own class. This keeps [B16] in the rollout brief (one scrollbar per surface) in the host's hands, where the other scrollers are.

**[B10] Hover goes through the DOM.** Per [L06] and [F08], pointer-enter and pointer-leave on a tile write `data-hot` directly onto the wires whose `data-to` names that tile, through a ref on the map, and clear it again. React state is not used. The wires into the single chosen tile are still marked at render time, because `chosen` is data the host holds.

---

## Non-goals {#non-goals}

- **Changing or deleting the spike.** The user said to leave it in place. Retiring it is stage 7.
- **Any change to what the map looks like.** It was reviewed rendered, and the model never saw it rendered (F05 in the rollout brief). A visual change would need the user's eye, and this stage does not ask for it.
- **Mounting the map anywhere.** The cycle shade and the CYCLE cell are stage 5, and the Cycles & Arcs card is stage 6.
- **Reading cycle data.** No feed, no store and no fetch. That is stage 3.
- **The asset list, the Back bar, the folded strip, the footer.** These are surface parts, and they arrive with the surfaces. Only the map graduates.
- **Start controls on tiles or seals.** These were deferred in the rollout brief's Non-goals.
- **Drawing a loop well.** Stage 1 refuses loops at write time, so the layout only promises not to hang on one ([B07]).

---

## Exit {#exit}

An arc, `cycle-map`. The first steps, in the order they have to land:

1. Move the layout to `cycle-map-layout.ts` with the renames in [B02], and add the seal transform in [B03], the geometry in [B04] and `pickOnMap` and the keys in [B06].
2. Write `__tests__/cycle-map-layout.test.ts` covering everything in [B07], with the [F02] fixture first, so that the move is proven before anything else builds on it.
3. Build `cycle-map.tsx` and `cycle-map.css` over that module, presentational as [B05] says, with the chrome split in [B09], hover through the DOM as in [B10], and the CSS from [B08]. Then pass `tsc`, oxlint and the token, visibility and type-alignment audits that the spike already passes.

The spike's three files and its registry line are the same at the end as at the start.
