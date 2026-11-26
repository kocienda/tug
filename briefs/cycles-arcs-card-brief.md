<!-- brief-skeleton v1 -->

# The Cycles & Arcs card: the sidebar card draws cycles, on the shared map and the cycle store

**Purpose:** Stage 6 of `briefs/cycle-rollout-brief.md`. Cycles now reach the deck and the map is a shared component, but no surface draws either. The Arcs sidebar card still lists arcs one by one, so a run of related arcs reads as unrelated rows. This stage makes that card Cycles & Arcs.

---

## Purpose {#purpose}

The rollout brief settles what the card becomes ([B17] there): "The sidebar card becomes Cycles & Arcs and uses the same parts. The same map at smaller measures, the same letters and numbers, one row per asset. An arc on a cycle of one is the same row with no map and no number. A folded or rested cycle keeps a strip of its entries' states." Its Exit table gives stage 6 as "The Cycles & Arcs sidebar card", waiting on stages 3 and 4. Both have landed, as `9bc80a668` and `2484fd770`.

The user's scope for this brief: stage 6 only, the card built on the shared map and the cycle store, and no Start controls.

---

## Evidence {#evidence}

**[F01] The Arcs card today is one list of arc rows, then plan rows.** `ArcsBody` in `tugdeck/src/components/arcs/arcs-card.tsx` projects the `CHANGESET_ALL` snapshot into live arc rows (`arcRowsFromSnapshot`) and branchless document-arc rows (`documentArcRowsFromSnapshot`), and gives both to one inline `TugListView` in the focus group `arcs-card`. Each row is an `ArcLifecycleBlock` with an `ArcVerbRow` under it (next step, Changes, Bind or Unbind, Replay, Discard), a fold over the arc's steps, and a right-click menu. The fold bits, the one confirm popover and the verb round trips are held in the body, keyed by the arc's owner key, because a list cell is recycled on every changeset beat. A row's activation opens the arc's room (`openArcRoom`). With no rows the card draws one `None` line. **(verified, read)**

**[F02] The card stands in the rail-card shell, which has one scroller.** `tugdeck/src/components/tugways/cards/rail-card-shell.tsx` says every rail card is "one scroller at its root holding one in-flow content column". The Arcs card puts `RAIL_CARD_CLASS` on its root and `RAIL_CARD_CONTENT_CLASS` on its content column. **(verified, read)**

**[F03] The spike's sidebar frame is the reviewed reference for this card.** `tugdeck/src/spikes/spike-cycle-band.tsx:1115–1446` draws it, with its CSS at `spike-cycle-band.css:700–891`:

- `SidebarCycle`: a section per cycle. A sticky pin holds a header (a `BlockFoldCue`, the cycle's name, and "N of M landed" or "At rest · M arcs"), the map at the compact size, and a Back bar (`OnlyBar`) when two or more assets are selected. Under the pin, one row per asset, each sketch before the entries that follow it.
- `SidebarEntry`: a compact `TugListRow`. Its lead is the entry's number. Closed, it shows the arc atom, the session running it as a session chip, and its waits and note. Open, it adds the steps (`ArcStepItems`) while running, or one line saying where it stands, and the brief as a file atom. Its trailing edge holds the state mark (`EntryMark`: a Joined badge, the lifecycle mark while running, a Ready badge) and, on a ready entry, a play button that starts it in a new session.
- `SidebarSketch`: a row whose lead is the sketch's letter in a small seal, with the entries it heads at the trailing edge. Closed, it shows the want on one line. Open, it shows the whole sketch.
- `CycleStrip`: a folded cycle's map is replaced by one short segment per entry, in the state's tone. A cycle at rest starts folded.
- A cycle of one (`SOLO`) is a bare `SidebarEntry` with `numbered={false}`: no header, no map, no number, no sketch row.
- A press on the map selects the asset, opens it, and scrolls it up under the pin. A press on a row selects it alone and scrolls nothing. Selection is a set per cycle.
- A tail spacer, `height: calc(100cqh - 280px)`, lets the last asset come up under the pin. The 280 px is a constant fitted to the fixture's pin.

**(verified, read. The model has never seen the spike rendered; the user reviewed it across about ten rounds, [F05] in the rollout brief.)**

**[F04] The shared map and the cycle store are on `main` and nothing mounts them.** `tugdeck/src/components/tugways/cycle-map.tsx` exports `CycleMap`, presentational, taking `tiles`, `sketches`, `size`, `chosen`, `onPress` and `onClear`; `cycle-map-layout.ts` exports `pickOnMap`, `entryKey` and `sketchKey`. `tugdeck/src/lib/cycle-store.ts` exports `useCycles()`, `useCycle(id)` and `useCyclesForSession(id)` over the aggregate. A grep for importers outside tests finds only those three files themselves. **(verified, grep)**

**[F05] A cycle on the wire carries most of what a row needs.** `CycleWire` in `tugdeck/src/lib/changeset-types.ts` has `id`, `name`, `project_dir`, `created_by`, `landed`, `entries` and `sketches`. A `CycleEntryWire` has `n`, `brief`, `brief_path` and `brief_title` when the file is on disk, the arc link, `waits`, `from`, `note`, `state`, the arc's `stages`, and, only while the arc is running, `owner_id`, `bound_session` and `bound_callsign`. It carries no step counts. `owner_id` is the same key the arc's own row wears in the same frame (`ArcChangesetEntry.owner_id`), and that row is what the card folds over for steps today. **(verified, read)**

**[F06] A sketch's words are not on the wire.** `CycleSketchWire` is `letter`, `id` and `added`. The feed brief left the text out on purpose: "Sketch text or sketch titles on the wire. Left to the stage whose surface shows them." The spike's sketch row needs the want closed and the whole text open ([F03]). The server has both: `want_of(text)` in `tugrust/crates/tugarc-core/src/sketch.rs` returns the first paragraph, and the arc documents already send a whole sketch as `sketch_text`. **(verified, read)**

**[F07] Arcs exist that no cycle names.** `tugtool cycle list --json` in this checkout returns no cycles, run with the debug binary on 2026-11-26, while the arc log holds arcs. The skills began writing cycles only at `f1b3536e1`, so every arc opened before that is on no cycle, and so is an arc opened by hand through `tugtool arc`. The app-test fixtures build their arcs through the CLI in scratch repositories and write no cycles either ([F09]). **(verified, run)**

**[F08] The card's name is in three places, and its id is a persistence key.** The title `"Arcs"` is in `defaultMeta` in `tugdeck/src/components/arcs/arcs-card-registration.tsx` and in the Window menu's row table at `tugapp/Sources/MenuStateSync.swift:355`; `tugdeck/src/components/tugways/command-registry.ts` orders the menu rows by that noun. The component id is still `dashes`, kept because it is what a saved layout stores ([D141]), and the list's `scrollKey` is `dashes` too. **(verified, read)**

**[F09] About twenty app-test files cover the card, and all of them read arc rows.** `grep` for `arcs-card` and `components/arcs` under `tests/app-test/` finds the four `at0407-arcs-card-*` files and their shared `arcs-card-fixture.ts`, `at0438`, `at0469-*`, `at0473`, `at0499-arcs-scroll`, `at0523`, `at0524`, `at0575`, `at0619`, the body-grounding `kind-arcs` and `row-13-arc-tracking` rows, and the style census (`tests/app-test/style-census/rail-cards.json` pins `.arcs-card-content`, `.arcs-empty` and `.arcs-section`; `scripts/card-dom-census.ts` maps `components/arcs/` to `dashes`). They select on `data-slot="arcs-row"`, `arcs-steps-fold`, `arc-document-row` and the `tug-arc-lifecycle-*` slots. Under an app-test instance the checkout's own arcs are hidden (`arcs_hidden_for` in `tugrust/crates/tugcast/src/feeds/changeset.rs`), and the feed brief hides cycles under the same gate, so a test sees only what its fixture made. **(verified, grep and read; the test files' assertions were not read one by one)**

**[F10] The card is a keyboard list, and the map is not part of the focus engine.** The registration sets `kbfAtRest: true`: every row is an engine focus stop, walked by the arrows, through `TugListView`. `CycleMap` draws its tiles and seals as plain `<button>` elements and registers nothing with the focus engine. The spike's sidebar lays its sections out by hand and does not use `TugListView`. **(verified, read)**

**[F11] `useCycleMode` and `fixture-cycle-demo.tsx` are about something else.** They are the keyboard focus-cycling mode (⌥⇥), and share only the word. **(verified, read)**

---

## Decisions {#decisions}

### What the card shows

**[B01] The card is renamed Cycles & Arcs wherever the user reads its name, and keeps its id.** The title in the registration and the Window menu row change ([F08]). The component id `dashes`, the family `arcs`, the scroll key, the directory `tugdeck/src/components/arcs/` and the `arcs-` slot names stay, because the id is what a saved layout holds and the slots are what twenty tests select on ([F09]). The menu orders rows by noun, so the row moves to where "Cycles & Arcs" sorts.

**[B02] The card lists cycles first, then the arcs no cycle names, then waiting paperwork.** Cycles come from `useCycles()`, in the order the frame sends them, most recently changed first. Arcs on no cycle exist today and will go on existing ([F07]), and the "& Arcs" in the name is theirs. They are drawn exactly as the card draws them now: the same `ArcLifecycleBlock` rows, the same verbs, the same order. Document-arc rows follow, also unchanged. The `None` line shows only when all three are empty.

**[B03] An arc is drawn once.** This is the rollout's [B13]. A live arc whose `owner_id` an entry carries ([F05]) is drawn in its cycle and left out of the loose list. The match is on that key and never on the arc's name, which is unique only inside one generation.

**[B04] A cycle with one entry is one row: no header, no map, no number and no sketch row.** This follows the spike's `SOLO` ([F03]) and the rollout's [B17]. Its sketch is still one press away, in the arc shade's Sketch panel in the session working it. A cycle becomes a section with a map the moment it gains a second entry.

**[B05] A cycle with two or more entries is a section: a pinned header and map, then one row per asset.** The parts and their order are the spike's `SidebarCycle` ([F03]): the fold cue, the name, and "N of M landed" or "At rest · M arcs"; `CycleMap` at `size="compact"`; the Back bar when two or more assets are selected; then each sketch's row before the entries that came from it. A sketch no entry came from is listed after the entries, so it is never left out. The header and map pin to the top of the card while that cycle's assets are in view, which is the rollout's [B14].

**[B06] A folded cycle shows a strip in place of its map, and a cycle at rest starts folded.** The strip is one segment per entry in the state's tone ([F03]). "At rest" is every entry joined. The user's fold or unfold of a cycle then holds for as long as the card is open.

### The rows

**[B07] An entry row is the spike's row, and it opens in place.** Closed: the number, the arc atom (or the brief's title when no arc has opened), the session chip while running, the waits and the note, and the state mark at the trailing edge. Open: the steps while running, or the one line saying where it stands, then the brief as a file atom from `brief_path`. A running entry's steps and lifecycle mark are read from the arc's own row in the same frame, found by `owner_id` ([F05]), so the entry and the arc cannot disagree.

**[B08] Pressing the session chip goes to that session, and pressing the row opens the row.** This is the rollout's [B09]: the chip is the link, and there is no second control for it. The loose arc rows keep today's activation, which opens the arc's room ([F01]), because nothing about them changes ([B02]).

**[B09] An open entry row whose arc is live carries that arc's existing verb row and messages.** Discard, Replay, Unbind, the next step and the join register are what the card does for an arc today ([F01]). An arc that moves from the loose list into a cycle must not lose them, so the open row composes the same `ArcVerbRow`, the same confirm and the same right-click menu, under the steps. The spike did not draw this, so its look is the one part of the row the user has not reviewed; see Open Questions.

**[B10] This stage adds no control that starts anything.** The spike's play button on a ready entry ([F03]) is not built: a ready entry wears its Ready badge and nothing to press beside it. No New Cycle control and no control that binds a session to a cycle is added either. The verbs the card already has are not a Start control in the sense the rollout deferred, and removing them was not asked for, so they stay where they are, on loose rows and on open live entries ([B09]).

**[B11] A sketch row shows its want closed and its whole text open, and the wire gains both.** `CycleSketchWire` gains `want` and `text`, composed on the server from the sketch store with `want_of` ([F06]), with the TS mirror, its guard and the golden fixture moved in the same change. The deck has no filesystem and composes nothing ([D138]). A sketch is a few hundred words, the size the arc documents already send. If stage 5 lands first and has added the same fields, this stage adds nothing.

**[B12] On the map, a running tile wears the elsewhere dot when its session is not the one the card follows.** The card already tracks a followed session card (`useTrackFollowedCard`, [F01]). A running entry whose `bound_session` is that card's session draws plain; any other running entry draws the dot. With nothing followed, no tile draws it.

### How it behaves

**[B13] Selection and fold are view state, held in the card body and keyed by cycle id.** This is where the fold bits live today and for the same reason ([F01]): a bit inside a row is lost when a changeset beat replaces the row. Each cycle has its own selection set. The rule is `pickOnMap` from the shared module ([F04]), so the card and the stage 5 shade cannot differ: a press selects one, a shift-press toggles one, a press on the map's ground clears. A press on a row selects it alone, and does nothing while the list is narrowed to several. Closing the card forgets all of it.

**[B14] A press on the map never moves the map; it brings the pressed row up under the pin.** Only a map press scrolls. A press on a row leaves the row under the pointer. The room under the last cycle that lets its last row come up is sized from the pin's measured height, in place of the spike's fitted 280 px ([F03]).

**[B15] The card keeps its one scroller.** The rail-card root scrolls ([F02]); the pins are sticky inside it; nothing else scrolls up and down. The map's own sideways overflow, which `CycleMap` owns, is the only other scrolling, and the card gives the map its well and padding through its own class, as the map brief's [B09] left to each host.

**[B16] Every row stays a keyboard stop, and the map is never the only door.** The card keeps `kbfAtRest` and the `arcs-card` focus group ([F10]). The arrows walk every row in card order, across cycles and into the loose rows. Each cycle's fold cue is a stop. Return or Space on an asset row does what a click does. The map's tiles stay pointer targets in this stage: every tile and seal has a row that says the same thing, so nothing is reachable only through the map.

### How it is built and proven

**[B17] The projection is one pure module with unit tests.** A module beside the card turns a snapshot and a followed session into what the card draws: the cycle sections and single rows, the loose arcs left after [B03], the plan rows, each cycle's `CycleMap` tiles (state, `elsewhere` by [B12], `steps` from the matched arc row, and the `label` sentence) and sketches, each header's text, and each strip. It reads no store and holds no React. Its tests run over the shared golden fixture, which the feed stage already gave a cycle with an entry in each state.

**[B18] The parts both surfaces draw go into tugways now; the parts only the card draws stay with the card.** The wait chips, the small seal, the entry's state mark and the Back bar are drawn by the spike's shade and its sidebar alike ([F03]), and stage 5 will need them. They land as small tugways components beside `cycle-map.tsx`, named clear of `use-cycle-mode` ([F11]). The section, the pin, the strip and the two row shapes are the card's. Nothing is imported from the spike, and the spike's files are not edited; retiring it is stage 7.

**[B19] The existing app-tests are the proof that arc rows did not change, and one new file is the map's first rendered verdict.** Every fixture in [F09] builds arcs with no cycles, so after this stage those arcs are loose rows and each existing file must pass as it stands. A file that fails is a regression in [B02], and the fix is in the card. One new app-test file builds a scratch repository with one cycle of three entries and one sketch through `tugtool cycle`, and asserts what no unit test can: the section mounts with the map, a press on a tile opens that entry's row under the pin, folding leaves the strip, and the card has one vertical scroller. It carries `@covers` and stays under the per-file budget. The style census gains the new selectors. The map brief's [B07] left the map's first rendered check to stage 5 or 6; this is it.

---

## Open Questions {#open-questions}

- **Can one piece of work show as both an entry and a document-arc row?** A brief written by the brief skill is an entry with no arc. An arc whose plan is still being devised has documents and no branch, and is a `DocumentArcEntry`. Whether the `/arc` door has attached the entry by then, and whether such an entry carries an `owner_id` to match on, was not established: `owner_id` is documented as present "only while the arc is running", and the cycle-skills brief marks the attach point as inferred. Reading the cycle composition in `tugrust/crates/tugcast/src/feeds/changeset_all.rs` and one real planned arc settles it. If the two can coincide, [B03] needs a second match for branchless arcs, and the wire may need the key on an entry whose arc has documents and no branch.
- **How the verb row looks on an open entry.** [B09] keeps the verbs, and the spike never drew them on an entry row. It needs the user's eye at the first render. What is at stake is the look, not whether the verbs stay.

---

## Non-goals {#non-goals}

- **Start controls.** No play button on a ready entry, no start in a new session, nothing that fills a prompt. Excluded by the user for this stage, and deferred in the rollout brief.
- **New Cycle, and binding a session to a cycle.** Deferred in the rollout brief with Start. The arc rows' existing Bind and Unbind are not these and are not touched.
- **Removing or redrawing the loose arc rows and plan rows.** They stay exactly as they are ([B02]).
- **The cycle shade and the CYCLE cell.** Stage 5.
- **Retiring or editing the spike.** Stage 7.
- **Renaming the component id, the directory or the `arcs-` slots.** Rejected in [B01].
- **A detail panel beside the list.** Rejected in the rollout's [B13]; a row opens in place.
- **Keyboard travel on the map itself.** Left out by [B16], since every tile has a row.
- **Renaming a cycle from the card.** The cycle-skills brief keeps renaming to `tugtool cycle rename`, by hand.
- **Cycles from projects that are not open.** The aggregate lists open projects, and so does the card.

---

## Exit {#exit}

An arc, `cycles-arcs-card`. Stages 3 and 4 have landed, so it waits on nothing. The first steps, in the order they have to land:

1. Settle the first open question by reading the cycle composition, and adjust [B03] and the wire if entries and document arcs can coincide.
2. The wire: `want` and `text` on the cycle's sketches, in Rust, the TS mirror, the guard and the golden fixture ([B11]).
3. The projection module and its unit tests ([B17]), including the one-drawing rule ([B03]) and the single-entry case ([B04]).
4. The shared parts in tugways ([B18]).
5. The card: sections, pins, rows, strip, selection, fold and the scroll under the pin ([B05]–[B09], [B12]–[B16]), with the loose rows and plan rows left as they are, and the rename ([B01]).
6. The new app-test file and the style census ([B19]), then the existing Arcs card files as the verdict that nothing about arc rows moved.

`just app-test-build` is needed before the app-tests, because step 2 changes Rust.
