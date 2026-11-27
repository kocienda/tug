# A cycle's entry is headed by its brief's title

**Purpose:** A cycle's surfaces name each piece of work by its arc's name, which is a handle and says nothing about what the work is. The brief is what says it, and the brief's title appears on no headline. Each entry should be headed by its brief's title, with the arc named under it once an arc exists.

---

## Purpose {#purpose}

The user, looking at the cycle shade for a cycle of one: "WHERE IS THE BRIEF in the diagram." The map showed sketch `A` wired to tile `1`, and the row under it was headed by the arc chip `cycle-closing`.

The first answer tried was to put the brief on the map as a node of its own, between the sketch and the arc. The user saw it in the spike and rejected it: "I was wrong. This is worse." The question then became: "I guess this means that a brief is an invisible part of an arc? Is that right? Can the arc itself give the user enough information to know what they're getting? Where do we make the brief available to see?"

The answer the user accepted, after seeing it in the spike ("Let's go with this"): the tile is the brief, and the arc is what happens to it. So the brief's title is the headline of the entry everywhere, and the map is left alone.

---

## Evidence {#evidence}

**[F01] The map draws a brief already, under another name.** `tuglaws/cycles.md` defines an entry as one brief and the one arc that carries it once that arc opens. A ready or waiting tile has no arc, so it is a brief and nothing else. **(verified by reading the law)**

**[F02] A brief node on the map made it worse.** The spike was changed to draw each brief as a page between its sketch and its arc. A brief and its arc are almost always one to one, so the second node and its wire carried no information, and the eight-entry fixture grew to 6 columns by 7 rows. The user rejected it on sight and the change was reverted. **(verified in the spike; the row count was computed from the layout)**

**[F03] The feed already sends each entry's brief title.** `CycleEntryWire` in `tugrust/crates/tugcast-core/src/types.rs` carries `brief_title`, the brief's first heading, read beside `brief_path` in `cycle_wire` (`tugrust/crates/tugcast/src/feeds/changeset.rs`). It is present only when the brief's file is on disk. The deck's wire type in `tugdeck/src/lib/changeset-types.ts` has the field. **(verified)**

**[F04] The Cycles & Arcs card prefers the arc's name.** `entryRow` in `tugdeck/src/components/arcs/arcs-projection.ts` sets a row's title to `entry.arc?.name ?? entry.brief_title ?? basename(entry.brief)`, so the brief's title shows only while no arc is linked. **(verified)**

**[F05] The cycle shade does the same.** In `tugdeck/src/components/tugways/cards/session-cycle-shade.tsx` an entry's row shows the arc atom when the entry has an arc and the brief's title only when it has none, and the footer's Now and Next lines name the arc. **(verified by reading the two branches; the whole component was not re-read)**

**[F06] A tile's tooltip is the state sentence alone.** `cycleShadeEntries` in `tugdeck/src/components/tugways/cards/session-cycle-shade-model.ts` sets a tile's `label` to the sentence ("Running in this session"), and `CycleMapTile.label` in `tugdeck/src/components/tugways/cycle-map.tsx` is documented as the tooltip and, after the number, the accessible name. Neither names the work. **(verified)**

**[F07] The spike shows the accepted shape.** `tugdeck/src/spikes/spike-cycle-band.tsx` at `51213d6e9` heads each entry with its brief's title in the shade's rows, the tile tooltips, the footer's two lines, the sidebar rows and the Brief panel of a cycle of one, and shows an arc's chip only for an entry whose arc has opened. **(verified; the spike was type-checked and seen by the user)**

---

## Decisions {#decisions}

**[B01] An entry is its brief, and the arc is what happens to it.** The brief is not a hidden part of an arc. Before an arc opens the entry is a brief alone, and once one opens the entry is that brief being carried. Every surface names the entry by what the brief says the work is.

**[B02] The brief's title is the headline of an entry on every surface.** That is the entry's row in the cycle shade, its row in the Cycles & Arcs card, the footer's Now and Next lines, and the Brief panel of a cycle of one. The title is the brief's first heading, as the feed sends it ([F03]).

**[B03] The headline falls back to the brief's file name.** The title is absent when the brief's file is not on disk, and a row must still say something. The fallback order is the brief's title, then the file name. The arc's name is never the headline.

**[B04] The arc is named under the headline, and only once it exists.** A ready or waiting entry shows no arc name, because no arc has been opened for it; the user confirmed this ("Keep it that way"). A running or joined entry shows its arc's chip beneath the title, beside the session and the brief's file atom. A dropped entry shows no arc chip either: an entry dropped by hand never had an arc, and one whose arc was discarded has none any longer.

**[B05] A tile's tooltip names the work and where it stands.** It reads as the brief's title, then the state sentence, as in "The tooled style keeps one look · Running in this session", and the tile's accessible name carries the same after its number.

**[B06] The map is unchanged.** It keeps two kinds of node, sketch seals and numbered entry tiles, and the wires between them. The brief gets no node ([F02]).

**[B07] The law says so.** `tuglaws/cycles.md` gains the rule that an entry is headed by its brief's title and that an arc is named once it opens, with the brief node on the map recorded as rejected beside it.

---

## Non-goals {#non-goals}

- **A brief node on the map.** Tried in the spike and rejected by the user ([F02]). A third kind of asset on the map was already rejected once, in `briefs/cycle-chain-and-surfaces-brief.md` [B04], for a brief that leads to other briefs.
- **Any change to the feed or the record.** The title is already on the wire ([F03]).
- **Naming the arc an entry will get before it opens.** The arc does not exist yet, so there is nothing to name ([B04]).
- **Any change to how an arc is drawn outside a cycle.** The loose arc rows of the Cycles & Arcs card and the arc's own lifecycle faces keep the arc's name.
- **Retiring the spike.** It stays until the user has confirmed the shipped surfaces.

---

## Exit {#exit}

**An arc.** The work is in the deck and the law:

- The model and projection: `entryRow` in `tugdeck/src/components/arcs/arcs-projection.ts` takes the brief's title first ([B03]); the shade model's tile label carries the title before the sentence ([B05]); their unit tests move to the new headline.
- The surfaces: the shade's entry row, its footer and the Brief panel of a cycle of one in `tugdeck/src/components/tugways/cards/`, and the entry row in `tugdeck/src/components/arcs/arcs-card.tsx`, each headed by the title with the arc's chip beneath it for a running or joined entry ([B02], [B04]).
- The app-tests that read an entry by its arc's name, `at0898-cycle-shade` and `at0899-cycles-arcs-card-section` among them, moved to the title while keeping what each one guarantees.
- The law ([B07]).
