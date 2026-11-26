<!-- brief-skeleton v1 -->

# The cycle shade and the CYCLE cell in the Session card

**Purpose:** Stage 5 of `briefs/cycle-rollout-brief.md`. Cycles reach the deck and the map is a shared component, but no surface shows a cycle, so a session working one arc of several still cannot see the others. This stage makes the Session card's arc shade the cycle shade and its ARC status cell the CYCLE cell.

---

## Purpose {#purpose}

The rollout brief gives stage 5 as "The cycle shade and the CYCLE cell in the Session card", waiting on stages 3 and 4. Both have landed: the feed and store as `9bc80a668`, the map as `2484fd770`. What the shade holds was settled there ([B08] to [B16]) and reviewed rendered in the Cycle Band spike.

The user's scope for this brief: stage 5 only, built on the shared map and the cycle store, and **no Start controls**.

---

## Evidence {#evidence}

**[F01] The store answers what the shade needs to ask.** `tugdeck/src/lib/cycle-store.ts` exports `useCycles`, `useCycle(id)` and `useCyclesForSession(sessionId)`. The last returns a list, in the frame's order (most recently changed first), of every cycle the session wrote, is bound to an entry of, or ran a stage of. A session can be in more than one. **(verified, read)**

**[F02] The map is presentational and takes props the wire nearly supplies.** `CycleMap` in `tugdeck/src/components/tugways/cycle-map.tsx` takes `tiles` (`n`, `waits`, `from`, `state`, optional `elsewhere`, optional `steps` as done and total, `label`), `sketches` (`letter`, `want`), `size`, `chosen`, `onPress(key, shift)` and `onClear()`. It owns its horizontal overflow and its ground and paints no well, padding or border. `pickOnMap`, `entryKey` and `sketchKey` are in `cycle-map-layout.ts`. A ready tile wears a Play glyph as a mark; it is not a control. **(verified, read)**

**[F03] The wire carries no sketch text and no steps.** `CycleSketchWire` in `tugdeck/src/lib/changeset-types.ts` is `letter`, `id` and `added`. `CycleEntryWire` has `n`, `brief`, `brief_path`, `brief_title`, `arc`, `waits`, `from`, `note`, `state`, `stages`, and, only while its arc runs, `owner_id`, `bound_session` and `bound_callsign`. The feed brief left sketch text "to the stage whose surface shows them". **(verified, read)**

**[F04] A running entry's arc row is in the same frame, findable by owner key.** `owner_id` on an entry is the key its arc row wears, and `changeset-all-store.ts` already finds an arc row by owner id (near line 156). `ArcSessionFact` in `arc-session-index.ts` carries `ownerId`, the step counters and the track model for the arc a session is bound to. Arcs already send their sketch as `ArcDocuments.sketch_text`, composed in `tugrust/crates/tugcast/src/feeds/changeset.rs`; `tugarc-core`'s `sketch.rs` has `read_version` and `want_of`. **(verified, read)**

**[F05] The arc shade is a frame and a body.** `SessionArcShade` (`tugdeck/src/components/tugways/cards/session-arc-shade.tsx`) is always mounted and raised by a data attribute. It holds a focus mode whose key view lands on the footer's Done, lowers on Escape, makes the transcript pane inert, and is never taller than four fifths of the slot. Its header reads `Arc` and the arc's sigil. `SessionArcShadeContent` is the body: with an arc, the Sketch, Brief and Arc panels, the Arc panel carrying the arc's verbs and Discard's confirm; with none, `SessionArcShadeHint` and the project's unbound arcs, each with Bind. **(verified, read)**

**[F06] The card keeps the arc shade exclusive with every other surface over the transcript.** `ArcShadeController` (`tugdeck/src/lib/arc-shade-controller.ts`) is a store of its own because the arc shade leaves the status row in view. In `session-card.tsx` (near line 3736) a Changes or History shade arriving, or share mode, lowers it, and raising it closes Find, leaves share mode and both landings, and hides whichever shade is up. Opening Find lowers it too (near line 2061). `at0859-arc-shade-surface.test.ts` asserts "History rising lowers the arc shade". **(verified, read)**

**[F07] The ARC cell and what reads it.** The cell is in `session-card-telemetry-renderers.tsx` (near line 1823): `priority="arc"`, `label="ARC"`, `pressed` while the shade is up, toggled through `TUG_ACTIONS.TOGGLE_ARC_SHADE`, which ⌥⌘R also sends. Its value is two dots with a reading between them, the step fraction or the phase's word, or `None` with no arc, in slots `session-telemetry-arc-value` and `session-telemetry-arc-none`. `at0192`, `at0473` and `at0627` assert the label is `ARC`; `at0484` and `at0859` to `at0862` cover the cell and the shade. `gallery-arc-lifecycle.tsx` draws a sample cell labelled `ARC`. **(verified, grep and read)**

**[F08] The spike's shade, as last reviewed.** In `tugdeck/src/spikes/spike-cycle-band.tsx` a cycle of several is a pinned header (lowering control, `Cycle`, name, "N of M landed"), the map, a Back bar when two or more assets are selected, one asset list, and a two-line footer. The shade holds one height of four fifths and does not scroll; the list is the only scroller and has a tail so its last asset can reach the top. A press on the map scrolls the pressed asset to the list's top. A sketch asset is its letter, the entries it heads and its text whole. An entry asset is its number, arc, session chip when it runs in another session, brief as a file atom, waits as numbered chips with a check once met, note, state mark, and steps while it runs. A cycle of one is the header over the arc shade's three panels. **(verified, read; the model has not seen it rendered)**

**[F09] The spike drew Start in three places and left three switches open.** Start is in each ready entry's row (with a second "in a new session" button), on the footer's Next line, and as "New Cycle" and "Bind" in the no-cycle body. Its switches were whether a lowered shade keeps its footer standing, whether another shade covers the footer or stands on it, and what the shade gives up at the slim width; the last has an answer in its CSS, where the footer drops the other sessions' count under 520 px. **(verified, read)**

**[F10] A session chip that opens its session already exists.** `session-identity.tsx` (near line 700) wraps `SessionIdentityView` for a session id and gives it an `onOpen` that raises the session's card or resumes the session, through `performSessionOpenAct`. **(verified, read; the wrapper's exact props were not read)**

---

## Decisions {#decisions}

### The shade

**[B01] The arc shade becomes the cycle shade. There is one shade, one controller, one action and one chord.** The rollout's [B10] gives the cell one shade to toggle, and its [B11] keeps the arc's three panels inside it. So `SessionArcShade` and `ArcShadeController` stay as the frame and the store, and ⌥⌘R and `TOGGLE_ARC_SHADE` keep their meaning. The frame's visible label and accessible name read `Cycle` when the session has a cycle. Module and action names are not renamed in this stage: nothing a user sees depends on them, and a rename would move every arc-shade test for no gain.

**[B02] The cycle a card shows is chosen by one pure rule.** First, the cycle holding an entry whose `owner_id` is the owner key of the arc this session is bound to ([F04]). Otherwise, the first of `useCyclesForSession` ([F01]), which is the most recently changed. Otherwise none. The bound arc comes first because the shade's first job is to show the work this session is doing. There is no cycle picker in this stage.

**[B03] The body has three forms, and two of them are today's.**

- **No cycle.** Today's hint and unbound arcs, unchanged, Bind included. That Bind shipped with the arc shade; it is not the spike's no-cycle door, and the user's deferral named the spike's controls.
- **One entry, or an arc with no cycle.** Today's three panels, verbs and confirm, unchanged. An arc opened before the skills wrote cycles has no cycle, and it must read exactly as it does now. Where the one entry's arc is not bound to this session, the panels are built from the entry: its sketch, its brief, and one line for where the arc stands.
- **Two or more entries.** The spike's form ([F08]), as [B04] to [B09] say.

**[B04] The several-entry form is the spike's layout over real data.** A header with the lowering control, `Cycle`, the cycle's name and "N of M landed" (`landed` is on the wire). Then `CycleMap` at `full` size inside a well the shade's own class paints. Then the Back bar when two or more assets are selected. Then the asset list, the only scroller, with the spike's tail. Then the footer. The shade holds four fifths of the slot in this form so the map does not move when the list's content changes; the other two forms keep today's height rule.

**[B05] The lowering control is in the header in every form, and the key view lands on it in the several-entry form.** The rollout's [B11] puts it there. The other two forms keep the Done footer and its focus landing, so the guarantees `at0859` to `at0862` hold stay as written. In the several-entry form the two-line footer stands where Done stood.

**[B06] Each asset appears once, under the map, holding what the spike's holds, less Start.** A sketch asset: letter, the entries it heads, its text whole. An entry asset: number, arc atom, brief as a file atom from `brief_path`, waits as numbered chips, note, state mark, and its steps while it runs. A joined entry says it has landed. An entry asset has no Start button and no "start in a new session" button.

**[B07] "This session" and "another session" are read from `bound_session` through the session's line.** A running entry whose `bound_session` is this card's segment or line reads "this session". One bound to another session shows that session's chip, the one that opens its session when pressed ([F10]), and its tile is marked `elsewhere`. A running entry with no `bound_session` is running with no chip, since the live session is this instance's view only.

**[B08] A running entry's steps come from its arc row in the same frame.** The shade finds the row by `owner_id` ([F04]) and draws the entry's steps and the tile's pips from it. Nothing about steps is added to the cycle wire, so an entry and its arc row cannot disagree.

**[B09] Sketch text travels on the wire.** Each `CycleSketchWire` gains `text`, the sketch's latest version, and `want`, its opening line from `want_of`. The server composes both, as it composes `sketch_text` for an arc, because the deck has no filesystem ([D138]). Both are omitted when the sketch cannot be read. The Rust type, the TS mirror, the guard and the golden fixture move together, as the feed brief's [B09] requires. This is the one change outside tugdeck.

**[B10] The footer is two lines and has no Start.** *Now*: the entry this session is running, as its arc atom and lifecycle mark, or "No arc in this session", or that the cycle is at rest; and at its trailing edge how many more run in other sessions. *Next*: the first ready entry by number, with its note, or "and N more ready", or that nothing is ready until an arc lands. The trailing Start the spike drew on the Next line is not built. Under 520 px of card width the footer drops the other sessions' count.

**[B11] A lowered shade leaves nothing standing.** The spike left this open ([F09]). The standing footer's reason was the next Start one glance away, which this stage does not build, and the CYCLE cell already carries the fraction and the way back. This is this brief's call, not one the user stated; a rendered look could reverse it without touching anything else here.

**[B12] Changes, History and Find stand over the cycle shade and no longer lower it. This reverses the exclusion in [F06].** The rollout's [B11]: "Other shades present over the cycle shade without replacing it." A raised cycle shade stays raised beneath another shade and is there when that shade leaves; raising it no longer closes Find or hides a shade. The landings keep their own rules. Share mode, which selects transcript turns the shade would cover, still lowers it. The assertion in `at0859` that History rising lowers the shade is a settled decision being reversed, so it is rewritten to assert the new guarantee and the commit says so. `ArcShadeController`'s docblock is corrected with it.

**[B13] Selection follows the map brief's rule and lives with the shade.** `pickOnMap` decides the set. One selected: the list is whole and scrolls that asset to its top. Two or more: the list shows only those, under Back. A press on a row in the whole list selects it. The set is cleared when the shown cycle changes. A press on the map never scrolls the map ([B14] in the rollout).

### The cell

**[B14] The cell's label reads `CYCLE`, and its value is the cycle's fraction only when there is more than one entry.** Several entries: `landed/total`. One entry, or an arc with no cycle: the arc's reading exactly as now. Neither: `None`. The cell keeps its construction, two dots and a reading in one box, and its slots, so nothing in the row moves and readers of the value still find it. The dots keep the meaning they have: the state of this session's own arc. The accessible label names the cycle and how much has landed.

**[B15] The tests that assert `ARC` move to `CYCLE` in the open.** `at0192`, `at0473` and `at0627` pin the label, which the rollout's [B10] changes. Each is edited to the new word with the reason in the commit. The gallery's sample cell changes too. Everything else those files assert stays as it is.

### Building it

**[B16] What turns a cycle into the shade's props is pure and tested without a DOM.** One module holds: the choice of cycle ([B02]), the form ([B03]), the map's tiles and sketches from a `CycleWire` and the frame's arc rows, each tile's sentence, the header's and footer's summary, and the cell's reading. The view composes `CycleMap` and existing tugways parts and adds no drawing of its own. The spike's CSS for the shade's parts is carried over under the shade's own class names, as the map's was.

**[B17] Verification is unit tests on that module and one new app-test.** The app-test seeds a cycle of several entries through `tugtool cycle` in a scratch project and reads: the cell's label and fraction, the shade raised with the map and the list, a map press bringing its asset to the list's top with the map unmoved, a shift-press narrowing the list, and no Start control anywhere in the shade. It carries `@covers` and stays under the per-file budget. `at0859` to `at0862` and `at0484` are in the step's selection because their surface is the one being changed.

---

## Open Questions {#open-questions}

- **The first rendered look.** The model has never seen the spike or the map rendered ([F08]). Measures carried from the spike may want tuning once the shade stands in a real card, and [B11] is the call most likely to move. Settled by the user looking at it.

---

## Non-goals {#non-goals}

- **Start controls of any kind.** No Start on an entry, on the footer, or on a tile; no "start in a new session"; nothing that fills the prompt. The user's instruction for this brief, and the rollout's deferral.
- **The spike's "New Cycle" and "Bind" doors.** Not built. The hint's existing Bind stays ([B03]).
- **A footer left standing when the shade is lowered.** Rejected in [B11].
- **A cycle picker.** A session in several cycles shows one, by [B02].
- **Verbs on entries this session does not hold.** Stop, Join, Discard and the rest stay on this session's own arc, in the one-entry form's Arc panel.
- **The Cycles & Arcs sidebar card.** Stage 6.
- **Touching or retiring the spike.** Stage 7. Its files are the same at the end as at the start.
- **Any change to what the map draws.** It was reviewed rendered and landed in stage 4.
- **Renaming the arc shade's modules, action or chord.** Rejected in [B01].
- **Steps on the cycle wire.** Rejected in [B08].

---

## Exit {#exit}

An arc, `cycle-shade`. Stages 3 and 4 have landed, so it waits on nothing. Its first steps, in the order they have to land:

1. Sketch `text` and `want` on the wire ([B09]): the Rust type and composition, the TS mirror and guard, the golden fixture, and both languages' tests against it.
2. The pure module and its unit tests ([B16]): cycle choice, form, tiles and sketches, sentences, summary, cell reading.
3. The several-entry body: header, map, Back bar, asset list, footer ([B04] to [B10], [B13]), mounted in the shade beside today's two forms ([B03]).
4. The frame: the label, the lowering control and focus landing ([B01], [B05]), and the exclusion change with `at0859`'s rewritten assertion ([B12]).
5. The cell: label, reading and accessible label, with the three label tests and the gallery sample moved ([B14], [B15]).
6. The new app-test, then the verdict run over it and the arc-shade files ([B17]).

Step 1 stands alone. Steps 3 to 5 need step 2. Step 6 is last.
