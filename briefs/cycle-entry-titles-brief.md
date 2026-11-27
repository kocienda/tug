# A cycle's entry is headed by its brief's title, and the three-panel arc view goes

**Purpose:** A cycle's surfaces name each piece of work by its arc's name, which is a handle and says nothing about what the work is. The brief is what says it, and the brief's title appears on no headline. Each entry should be headed by its brief's title, with the arc named under it once an arc exists. And a session whose arc is not yet on a cycle is shown an older view, three boxes numbered Sketch, Brief and Arc, which the user wants gone from the application: every arc should show the cycle's map. And the cycle shade opens with everything unfolded, which buries the user: its default should be the map and one line per item, with more shown only when the user clicks.

---

## Purpose {#purpose}

The user, looking at the cycle shade for a cycle of one: "WHERE IS THE BRIEF in the diagram." The map showed sketch `A` wired to tile `1`, and the row under it was headed by the arc chip `cycle-closing`.

The first answer tried was to put the brief on the map as a node of its own, between the sketch and the arc. The user saw it in the spike and rejected it: "I was wrong. This is worse." The question then became: "I guess this means that a brief is an invisible part of an arc? Is that right? Can the arc itself give the user enough information to know what they're getting? Where do we make the brief available to see?"

The answer the user accepted, after seeing it in the spike ("Let's go with this"): the tile is the brief, and the arc is what happens to it. So the brief's title is the headline of the entry everywhere, and the map is left alone.

A second report came from an arc in the Liven project, `liven-cast-interface`, whose shade showed three boxes, `1 SKETCH` reading None, `2 BRIEF` and `3 ARC` with a Start button, under the header `ARC`. The user: "I do not want to see this interface anymore. I want to see the diagrams that we have in the spike."

A third report, on the cycle shade itself, raised over a cycle of three: the whole sketch, the running arc's thirteen steps, its verbs and the brief's decisions, all open at once. The user: "I do not want to see this huge shade open up that just buries the user in information. If they click, we'll show them more information, but as a default view, I do not want to see this pile of information." And of the brief: "I don't want to see the brief if we're not showing it in the diagram. We only open it if the user clicks the link."

---

## Evidence {#evidence}

**[F01] The map draws a brief already, under another name.** `tuglaws/cycles.md` defines an entry as one brief and the one arc that carries it once that arc opens. A ready or waiting tile has no arc, so it is a brief and nothing else. **(verified by reading the law)**

**[F02] A brief node on the map made it worse.** The spike was changed to draw each brief as a page between its sketch and its arc. A brief and its arc are almost always one to one, so the second node and its wire carried no information, and the eight-entry fixture grew to 6 columns by 7 rows. The user rejected it on sight and the change was reverted. **(verified in the spike; the row count was computed from the layout)**

**[F03] The feed already sends each entry's brief title.** `CycleEntryWire` in `tugrust/crates/tugcast-core/src/types.rs` carries `brief_title`, the brief's first heading, read beside `brief_path` in `cycle_wire` (`tugrust/crates/tugcast/src/feeds/changeset.rs`). It is present only when the brief's file is on disk. The deck's wire type in `tugdeck/src/lib/changeset-types.ts` has the field. **(verified)**

**[F04] The Cycles & Arcs card prefers the arc's name.** `entryRow` in `tugdeck/src/components/arcs/arcs-projection.ts` sets a row's title to `entry.arc?.name ?? entry.brief_title ?? basename(entry.brief)`, so the brief's title shows only while no arc is linked. **(verified)**

**[F05] The cycle shade does the same.** In `tugdeck/src/components/tugways/cards/session-cycle-shade.tsx` an entry's row shows the arc atom when the entry has an arc and the brief's title only when it has none, and the footer's Now and Next lines name the arc. **(verified by reading the two branches; the whole component was not re-read)**

**[F06] A tile's tooltip is the state sentence alone.** `cycleShadeEntries` in `tugdeck/src/components/tugways/cards/session-cycle-shade-model.ts` sets a tile's `label` to the sentence ("Running in this session"), and `CycleMapTile.label` in `tugdeck/src/components/tugways/cycle-map.tsx` is documented as the tooltip and, after the number, the accessible name. Neither names the work. **(verified)**

**[F07] The spike shows the accepted shape.** `tugdeck/src/spikes/spike-cycle-band.tsx` at `51213d6e9` heads each entry with its brief's title in the shade's rows, the tile tooltips, the footer's two lines, the sidebar rows and the Brief panel of a cycle of one, and shows an arc's chip only for an entry whose arc has opened. **(verified; the spike was type-checked and seen by the user)**

**[F08] The three boxes are drawn for a bound arc that no cycle entry carries.** `cycleShadeForm` in `tugdeck/src/components/tugways/cards/session-cycle-shade-model.ts` answers `one` for a session with an arc and no cycle, and `SessionArcShadeContent` (`tugdeck/src/components/tugways/cards/session-arc-shade-content.tsx`) draws `SessionArcPanels` for it. `chooseCycle` finds a session's cycle only through an entry whose `owner_id` is the bound arc's. **(verified)**

**[F09] Every arc passes through that state when it opens.** The `/arc` door runs `tugtool arc run`, which creates the arc and binds the session, and only afterwards records the sketch and runs `tugtool cycle attach` (`tugplug/skills/arc/SKILL.md`, "Then put the arc on its cycle"). Between the two the arc is on no cycle. The Liven screenshot was taken there: the card read Working at 1m 48s and the arc read Briefed with Start. `tugtool cycle show bb8f39b5` in that project now lists the arc as entry 3, running. **(the order is verified in the skill; that the screenshot fell in that gap is inference from what it shows)**

**[F10] An arc can also stay there.** The attach is a step a skill asks a model to run, and the door's cycle writes never stop the work, so a skipped or refused attach leaves an arc on no cycle for its whole life. `tugtool cycle check` does not list such an arc: it reads cycles, and this arc is on none. **(verified by reading the skill; that `check` cannot see it follows from what it reads and was not run against a case)**

**[F11] The law already says a cycle of one is drawn as any other.** `tuglaws/cycles.md`, under "A cycle of one", says a surface draws what the record holds and adds no special case, and the shipped shade does so for an arc that is on a cycle. The three boxes are what is left for an arc that is not. **(verified)**

**[F12] The spike still draws the three boxes for a cycle of one.** `tugdeck/src/spikes/spike-cycle-band.tsx` renders `SessionArcPanels` from `panelsFor` when the cycle has a single entry, so the spike is behind the law on this point. Seven app-tests read the panels: `at0473`, `at0475`, `at0525`, `at0627`, `at0859`, `at0860` and `at0861`. **(verified by grep; the tests were not read)**

**[F13] The cycle shade draws every asset open.** In `tugdeck/src/components/tugways/cards/session-cycle-shade.tsx` a sketch's row shows its whole text, the bound arc's entry shows its lifecycle block, every step and its verbs (`hereBody`), and under them the brief's Decisions and Findings (`hereBrief`, `ArcBriefHeadings`), with a joined entry's line beside them. The user's screenshot of a three-entry cycle runs to about two screens. The Cycles & Arcs card already does the other thing: each asset is one row that opens in place when pressed. **(verified by reading the component's entry and sketch rows; the screenshot is the user's)**

---

## Decisions {#decisions}

**[B01] An entry is its brief, and the arc is what happens to it.** The brief is not a hidden part of an arc. Before an arc opens the entry is a brief alone, and once one opens the entry is that brief being carried. Every surface names the entry by what the brief says the work is.

**[B02] The brief's title is the headline of an entry on every surface.** That is the entry's row in the cycle shade, its row in the Cycles & Arcs card, the footer's Now and Next lines, and the Brief panel of a cycle of one. The title is the brief's first heading, as the feed sends it ([F03]).

**[B03] The headline falls back to the brief's file name.** The title is absent when the brief's file is not on disk, and a row must still say something. The fallback order is the brief's title, then the file name. The arc's name is never the headline.

**[B04] The arc is named under the headline, and only once it exists.** A ready or waiting entry shows no arc name, because no arc has been opened for it; the user confirmed this ("Keep it that way"). A running or joined entry shows its arc's chip beneath the title, beside the session and the brief's file atom. A dropped entry shows no arc chip either: an entry dropped by hand never had an arc, and one whose arc was discarded has none any longer.

**[B05] A tile's tooltip names the work and where it stands.** It reads as the brief's title, then the state sentence, as in "The tooled style keeps one look · Running in this session", and the tile's accessible name carries the same after its number.

**[B06] The map is unchanged.** It keeps two kinds of node, sketch seals and numbered entry tiles, and the wires between them. The brief gets no node ([F02]).

**[B07] The law says so.** `tuglaws/cycles.md` gains the rule that an entry is headed by its brief's title and that an arc is named once it opens, with the brief node on the map recorded as rejected beside it. It also records that the shade's assets start closed and that the three-panel view is gone ([B08], [B12], [B13]), each as a dated reversal where it replaces a rule the law holds today.

**[B08] The three-panel view is removed from the application.** A session bound to an arc always shows the cycle body: the header, the map, the asset list and the footer. `SessionArcPanels` and the `one` form go, with their stylesheet and their tests, once nothing draws them. Nothing is lost by it: the bound arc's entry in the cycle body holds the arc's steps and verbs once it is opened ([F11], [B12]).

**[B09] An arc not yet on a cycle is shown as the cycle of one it is about to be.** While no entry carries the bound arc ([F09]), the deck composes a cycle of one from the arc's own facts: its sketch when it has one, its brief and its title, and its arc. The shade draws the same body from it, so the map reads `A` to `1`, or the tile `1` alone when the arc has no sketch, from the moment the arc exists, and the real cycle takes its place when the attach lands. It is named by the brief's title until then. This is a reading of facts the arc already carries, and nothing is written.

**[B10] An arc that stays on no cycle is a defect that is reported.** `tugtool cycle check` lists a live arc that no entry carries, beside the chain breaks it lists today ([F10]). The stand-in of [B09] covers the gap on screen, and the check keeps the gap from being hidden by it.

**[B11] The spike's cycle of one is brought to the same body.** The spike drops its three panels for a single entry and draws the map and the list, so that the spike, the law and the product show one thing ([F12]).

**[B12] The cycle shade opens closed: the map, and one line per asset.** By default a sketch's row is its letter and its opening sentence, and an entry's row is its number, its brief's title and its state mark, with the arc's chip and session for one that is running. A press on a row, or on its tile or seal on the map, opens that asset in place: the sketch whole, or the entry's steps and verbs, its brief's file link, what it waits on and its note. A second press closes it. This is the rule the Cycles & Arcs card already follows ([F13]), so the two surfaces behave alike. The bound arc's own entry starts closed too: the footer's Now line already says where it stands, and one press reaches its steps and its Stop.

**[B13] The brief's contents are not listed on a cycle's surfaces.** The Decisions and Findings headings leave the shade. The brief is on the map as its tile and in its row as its title ([B01], [B02]), and its file link opens the document. The user's rule: the brief is shown when the user clicks its link, and not before.

---

## Non-goals {#non-goals}

- **A brief node on the map.** Tried in the spike and rejected by the user ([F02]). A third kind of asset on the map was already rejected once, in `briefs/cycle-chain-and-surfaces-brief.md` [B04], for a brief that leads to other briefs.
- **Any change to the feed or the record.** The title is already on the wire ([F03]), and the stand-in is composed in the deck ([B09]). The one Rust change is the check ([B10]).
- **Naming the arc an entry will get before it opens.** The arc does not exist yet, so there is nothing to name ([B04]).
- **Any change to how an arc is drawn outside a cycle.** The loose arc rows of the Cycles & Arcs card and the arc's own lifecycle faces keep the arc's name.
- **Retiring the spike.** It stays until the user has confirmed the shipped surfaces. Its cycle of one changes ([B11]); nothing else in it does.
- **Moving the attach into `tugtool arc run`.** It would close the gap at its source, but a cycle of one needs a name and a sketch in the user's words, which the door writes and a verb cannot. The stand-in and the check cover it ([B09], [B10]).
- **An entry that starts open.** Rejected for every entry, the session's own included ([B12]).
- **Keeping the three panels for any case.** Rejected by the user. An arc with no cycle is drawn as a cycle of one, not as a view of its own.

---

## Exit {#exit}

**An arc.** The work is in the deck, one check verb and the law:

- The model and projection: `entryRow` in `tugdeck/src/components/arcs/arcs-projection.ts` takes the brief's title first ([B03]); the shade model's tile label carries the title before the sentence ([B05]); their unit tests move to the new headline.
- The surfaces: the shade's entry row, its footer and the Brief panel of a cycle of one in `tugdeck/src/components/tugways/cards/`, and the entry row in `tugdeck/src/components/arcs/arcs-card.tsx`, each headed by the title with the arc's chip beneath it for a running or joined entry ([B02], [B04]).
- The app-tests that read an entry by its arc's name, `at0898-cycle-shade` and `at0899-cycles-arcs-card-section` among them, moved to the title while keeping what each one guarantees.
- The stand-in: a cycle of one composed from the arc's facts where `chooseCycle` finds none, the `one` form and `SessionArcPanels` removed, and the spike's cycle of one drawn as the map and the list ([B08], [B09], [B11]).
- The shade's rows closed by default and opened in place by a press on the row or the map, and the brief's headings removed from it ([B12], [B13]); the shade app-tests that read an open entry press it first.
- The seven app-tests that read the panels ([F12]) moved to the cycle body, each keeping what it guarantees about the arc's steps, verbs and brief.
- `tugtool cycle check` listing a live arc on no cycle, with its test ([B10]).
- The law ([B07]).
