# Cycles

*What a cycle is, how its state is read, how it is numbered and named, and how the two surfaces that show one behave. Each rule names the module that holds it. Where an alternative was tried and rejected, it is recorded in one line beside the rule it lost to, so that it is not proposed again. The arc itself is [arc-lifecycle.md](arc-lifecycle.md); the vocabulary is [work-grammar.md](work-grammar.md).*

## The chain

**The process is sketch, then brief, then arc, then landed.** Work always starts at a sketch and always ends at a landed arc, with a brief in the middle. A cycle is the collection of arcs that belong together, each linked to its brief and its sketch.

**Every link is required.** An arc is carried by exactly one entry on exactly one cycle. An entry has exactly one brief. An entry names at least one sketch on its cycle. A missing link is a defect in Tug, never a state a surface draws around, and the record's writer refuses it ([L40]): `add_entry` in `tugrust/crates/tugarc-core/src/cycle.rs` refuses an entry with no brief or no sketch, a verb adds a sketch to an entry already on record without removing or renumbering anything, and a check verb lists every cycle on the machine that breaks the chain.

**One brief may be carried by more than one entry**, each with its own arc. It is rare and allowed, because a brief's work is sometimes split, and it is drawn as what it is: two entries that name the same brief. *Rejected: requiring a second brief before a second arc.*

**A brief that led to more briefs is a link, not an entry.** When a sketch is written up as a brief that spawns further briefs and never has an arc of its own, that first brief is recorded on the sketch it wrote up, and the arcs reach the sketch through it. It is not an entry, because an entry with no arc would read as ready forever. *Rejected: a third kind of asset on the map for such a brief.*

**A record is found through other records, never through the session** ([L41]). The brief skill finds its cycle by the sketch the brief comes from, or by the brief it was written from, and starts a new cycle when neither is on one. The arc door, handed a brief on no cycle, writes a sketch from that brief and adds it as A before the entry. *Rejected: choosing "this session's most recent cycle", which split one rollout across three cycles.*

**The user is always told what comes next.** Each skill that ends a link names the next one: after a sketch, brief it; after a brief, open an arc on it; after an arc finishes, land it. Each surface says the same for every item it shows. Naming the next step is not starting it; starting things from the surfaces stays [deferred](#drawn-and-deferred).

## What a cycle is

A **cycle** is a container of related work. It holds numbered **entries** and lettered **sketches**. An entry is one brief and the one arc that carries it once that arc opens; an entry has one arc, and a brief may be carried by more than one entry ([the chain](#the-chain)). A sketch says where entries came from, and one sketch may head several entries, and one entry may come from several sketches. A sketch may also carry the brief that wrote it up when that brief has no arc of its own, and `tugtool cycle find --brief` finds a cycle through that brief as it does through an entry's.

**Every arc is on a cycle.** A bare `/arc` writes a real cycle of one, because that arc may turn out to be the first stage of work that later gains another brief and another arc.

**A cycle closes when its work is finished, and reopens when work is added.** A cycle is closed when it has at least one entry, every entry is settled, and no sketch is pending. An entry is settled when it is joined or dropped ([State is derived](#state-is-derived)), and a sketch is pending when no entry names its letter and it has not been dropped. The rule counts entries, not arcs: a cycle with one entry landed and another not yet started has no open arc and stays open, because that is when what is ready next matters. A cycle with no entries yet is open, or it would close between its creation and its first entry.

Closed is read from the record and the arc log on every read, beside the entries' states, and is never stored (`cycle_closed` in `tugrust/crates/tugarc-core/src/cycle.rs`), so a cycle cannot be closed while one of its arcs is open. Nothing closes a cycle by hand and nothing reopens one: a brief written from a closed cycle's sketch or brief is added to it by [the chain's finding rule](#the-chain), which makes the rule false, and an undone join does the same. Entries and sketches can be added at any time, and nothing is ever removed or renumbered, so a closed cycle's record is what it reopens from. A cycle has no landing gesture of its own: each arc lands by its own join. *Rejected: a closing or landing gesture for the whole cycle. Rejected: closing by age, since a cycle with unfinished paperwork stays open until that paperwork is run or dropped.*

**A closed cycle is on no surface.** The feed leaves it out ([How a cycle reaches a surface](#how-a-cycle-reaches-a-surface)), and it leaves the moment its last entry settles: the cell goes from `2/3` to `None` with no `3/3` in between, because the join announces the landing itself. `tugtool cycle list` leaves closed cycles out and `--all` shows them, and `show`, `find` and `check` read any cycle, closed or not. *Rejected: holding a finished cycle in its session until the session's next turn. Rejected: a surface that lists closed cycles.*

*Reversed, 2026-11-26: a cycle was first never closed. Every cycle then stayed on every surface for good, a session whose cycle had landed days before still read `1/1 : —`, and the Cycles & Arcs card only grew. The user asked for a cycle to close once its arcs have finished and to reopen when another is added.*

The record is one file per cycle in the app's own store, outside the project and never committed. `tugrust/crates/tugarc-core/src/cycle.rs` holds its shape and every write to it, and `tugrust/crates/tugtool/src/cycle.rs` is the `tugtool cycle` verb over it. An entry links its arc by name and by the start of the arc's generation, because an arc name is unique only within one generation.

## State is derived

An entry is **joined**, **running**, **dropped**, **ready** or **waiting**, and the record stores none of these. Each is read from the arc log every time the record is read: joined when the linked arc's generation ended in a join, running when that generation is open, dropped when that generation was discarded or the entry was dropped by hand, and otherwise ready when every entry it waits on has joined and waiting when one has not. `entry_states` in `tugrust/crates/tugarc-core/src/cycle.rs` is the rule. Because nothing is stored, a cycle cannot disagree with the arcs it names.

**A dropped entry is settled, and nothing is lost by it.** An entry whose arc was discarded will not land as it stands, so it reads dropped and no longer holds its cycle open. Running `/arc` on its brief again links the entry to the new arc, and it reads running. A wait on a dropped entry is not met: the entry that waits stays waiting, and its cycle stays open until that entry is settled too. *Reversed, 2026-11-26: a discarded arc's entry first read ready again, the same as an entry that never had an arc, which would have held its cycle open for good.*

**Dropping by hand is the one stored fact.** `tugtool cycle drop <id> <n|letter>` marks an entry or a sketch that will never run. Nothing in the arc log says the user has given up on work that never started, so the mark is kept in the record, as a gate's note is. It removes nothing and renumbers nothing. It is refused on an entry whose arc is open, which is ended by discarding the arc, on one that has joined, and on a sketch an entry already came from, where the entry is what there is to drop. An open or joined arc outranks a mark left on its entry, and attaching an arc to a dropped entry, or adding an entry from a dropped sketch, clears the mark. The verb is typed, and no surface has a control for it.

**A gate is a note.** "After you approve the spike" is free text on an entry. It is shown with the entry and blocks nothing. *Rejected: gates as states that hold an entry back mechanically.*

A wait names another entry by number, and a set of waits that loops is refused when it is written (`wait_loop`).

## Numbers and letters

Entries are numbered 1, 2, 3 and sketches are lettered A, B, C, each in the order added. A digit always means work that can land, and a letter always means where work came from. A number or a letter is never reused, and nothing is renumbered.

*Rejected: B1/A1 prefixes, which give one entry two names. Rejected: one sequence for entries and sketches together, which makes "1 of 8 landed" and "waits on 3" skip numbers.*

## The name

A cycle is named once, when it is created, by the skills, from the opening sentence of its sketch A. A later sketch never renames it. It changes only by hand, through `tugtool cycle rename`, when the user asks. The text of the naming rule ships in the plugin's brief skill, under "The naming rule" in `tugplug/skills/brief/SKILL.md`, and that is its one home.

## How a cycle reaches a surface

Cycles ride the same aggregate frame as the arc rows, as a list on each project's changeset, composed in `tugrust/crates/tugcast/src/feeds/changeset.rs` from one read of the arc log. A closed cycle is left out of that list (`cycle_entries_in`), which is the one place every surface gets its cycles, so no surface filters for itself. An entry reading running and its arc's row arrive in one frame and cannot disagree. A write to a cycle's record is seen by a file watch (`tugrust/crates/tugcast/src/feeds/cycle_watch.rs`), never by a timer.

In the deck, `tugdeck/src/lib/cycle-store.ts` projects that frame and holds no feed of its own. Sketch text is composed on the server and travels on the wire, because the deck has no filesystem.

## No surface has a prompt

The cycle shade and the Cycles & Arcs card show a cycle. Neither sends a turn, and neither has a prompt of its own.

## Where a cycle shows

A cycle shows in the session that wrote it and in every session bound to one of its arcs or that ran a stage of one (`cyclesForSession` in `tugdeck/src/lib/cycle-store.ts`). A Session card bound to an arc shows the cycle holding that arc, because the shade's first job is the work this session is doing, and when no cycle holds it yet the card shows the [cycle of one](#a-cycle-of-one) the arc is about to be; a card bound to no arc shows the most recently changed cycle the session belongs to (`chooseCycle` in `tugdeck/src/components/tugways/cards/session-cycle-shade-model.ts`).

A running entry names its session with the ordinary session chip, and pressing the chip goes to that session. The chip is the link between sessions. *Rejected: a separate "go to session" control.*

## The map

The map draws a cycle as a graph, and both surfaces compose the one component: `tugdeck/src/components/tugways/cycle-map.tsx`, laid out by `tugdeck/src/components/tugways/cycle-map-layout.ts`, at a full size in the shade and a compact size in the sidebar.

- **A tile per entry and a wire per wait.** A tile's column is how deep its waits run, so the first column is everything that can start now.
- **A wait another wait already implies is not drawn**, and a wire that passes a column holds a seat in it, so it never runs through a tile it does not join.
- **A sketch is a seal**, wired to the entries it heads and seated in the column just before them, so a sketch added late stands beside what it added.
- **A wire is solid once what it leaves has landed.** Until then the wire is dashed.
- **Waiting is solid gray.** The border of a waiting tile and an unmet wait chip are solid gray. *Rejected: dashed borders for waiting.*
- **Dropped is muted.** A dropped entry in a cycle that is still open keeps its tile, with a dashed border in the muted ink and a cross where a joined tile has its check. Its row and its strip segment are muted the same way, and it stays in the total and is never counted as landed.
- **A tile's steps stay inside the tile.** The pips share the width the tile has left after its number, and an arc with more steps than readable pips fit draws one bar filled to the same fraction, at both sizes.

The map is presentational: it reads no store and derives no state. The host holds the selection and paints the well around the map.

## One representation per asset

A sketch or an entry is drawn once under the map, and that one drawing holds everything about it. For an entry that is its arc, its session, its brief, what it waits on, its note, its state, and its steps while it runs. For a sketch it is its letter, the entries it heads, and its text. In the sidebar the asset is one row that opens in place. *Rejected: a detail panel beside the list.*

**An entry is headed by its brief's title.** An entry is a brief, and the arc is what happens to it, so every surface names the entry by what the brief says the work is: its row in the shade and in the Cycles & Arcs card, the shade footer's Now and Next lines, and its tile's tooltip, which reads the title and then the state sentence, as in "The tooled style keeps one look · Running in this session". The title is the brief's first heading as the feed sends it, and when the brief's file is not on disk the headline falls back to the file name; the arc's name is never the headline (`cycleEntryHeadline` in `tugdeck/src/components/tugways/cards/session-cycle-shade-model.ts`). The arc is named once it exists: a running or joined entry shows its arc's chip beneath the title, beside its session and the brief's file atom, and a ready, waiting or dropped entry shows none, because it has no arc to name. *Rejected: a node for the brief on the map, between its sketch and its tile. A brief and its arc are almost always one to one, so the second node and its wire carried nothing, and the map grew by a column and several rows.*

*Reversed, 2026-11-27: an entry was first headed by its arc's name once it had one, and by its brief's title only before. A ready entry and a running one then named the same work two different ways.*

**An asset starts closed and opens in place.** In the shade a sketch's row is its letter and its opening sentence, and an entry's row is its number, its title and its state mark, with the arc's chip and the session for one that is running. A press on the row, or on its tile or seal on the map, opens that asset where it is: the sketch whole, or the entry's steps and verbs, its brief's file link, what it waits on and its note. A second press closes it. The bound arc's own entry starts closed too, since the footer's Now line already says where it stands and one press reaches its steps and its Stop. The sidebar's rows already worked this way, so the two surfaces behave alike. *Reversed, 2026-11-27: every asset in the shade was first drawn open, and the bound arc's entry listed its brief's headings.*

**A brief's contents are not listed on a cycle's surfaces.** The brief is on the map as its tile and in its row as its title, and its file link opens the document; it is shown when the user presses that link, and not before. *Rejected: the brief's Decisions and Findings headings under its entry.*

A running entry's steps are read from its arc's own row in the same frame, found by the owner key both carry, so the entry and the arc cannot disagree.

## A press on the map never moves the map

A press on a tile or a seal opens the pressed asset in place and brings it into view. In the shade the list scrolls only as far as it must to show the asset, never to put it at the top, and the map stays fixed above it (`cycleRevealTop` in `tugdeck/src/components/tugways/cards/session-cycle-shade-model.ts`). In the sidebar each cycle's header and map pin to the top of the card while that cycle's rows scroll under them (`tugdeck/src/components/arcs/arcs-card.css`). Only a map press scrolls: a press on a row leaves the row under the pointer. The map holds its place on the screen: the shade keeps the height it rose to while it is up ([the cycle shade](#the-cycle-shade)), so an asset that opens grows the list, which scrolls.

*Reversed, 2026-11-27: a map press first scrolled the asset to the top of the list, and a blank tail under the last asset made room for it, so the shade never changed height. With every asset closed by default the list is short, so the shade rises to what it holds and the list scrolls once an asset opens.*

## Selection

Selection is one set, and the rule is the same on both surfaces because both apply `pickOnMap` from `tugdeck/src/components/tugways/cycle-map-layout.ts`:

- a click selects one asset;
- a shift-click adds it to the set or takes it out;
- a press on the map's ground clears the set;
- with two or more selected, the list shows only those, under a Back control that clears (`tugdeck/src/components/tugways/cycle-only-bar.tsx`).

## One scrollbar per surface

No surface has more than one vertical scroller, and nothing inside it is an exception. In the shade it is the asset list, and the shade itself does not scroll; the running entry's steps are laid out in full inside that list, never in a capped scroller of their own. In the sidebar it is the card. The map's own sideways overflow is the only other scrolling.

## The CYCLE:ARC cell

The Session card's status row has an ordinary cell labelled `CYCLE:ARC`. Pressed, it raises and lowers the cycle shade. Its value is written the way its label is, two fractions joined by a spaced colon, as `0/3 : 2/5`: the cycle's entries landed over its entries, then this session's arc's steps done over its steps. A cycle of one reads 0/1 like any other, and 1/1 only while a sketch on it still waits for an entry, because a cycle whose every entry has landed and that has no sketch pending is closed and the cell then reads `None`. A session bound to no arc holds the arc's place with a dash, as `1/3 : —`, and an arc that is not walking steps (devising, reviewing, auditing) shows that stage's mark in the second place, as the arc cell did (`cycleCellReading` in `tugdeck/src/components/tugways/cards/session-cycle-shade-model.ts`). *Rejected: a separate expand control on the status row's edge.*

*Reversed, 2026-11-26: the cell first read the cycle or the arc, never both: the landed fraction for two or more entries, and the arc's reading for one. The user wanted both numbers at once.*

## A cycle of one

A cycle of one is a cycle, on every surface: a surface draws what the record holds and adds no special case. In the Session card it has the same header, map, asset list and footer as any other (`cycleShadeForm`), in the Cycles & Arcs card the same name, map and sketch (`projectArcsCard` in `tugdeck/src/components/arcs/arcs-projection.ts`), and in the status row the same two fractions. The entry for the arc the session is bound to holds that arc's own steps and verbs (`ArcPopoverContent`) once it is opened, so stopping and landing an arc happen in its entry.

**An arc on no cycle is drawn as the cycle of one it is about to be.** The `/arc` door creates an arc and binds its session before it puts the arc on its cycle, so every arc spends a moment on none. For that moment the deck composes a cycle of one from the arc's own facts: its record of where the work came from as sketch `A` when it has one, its brief as entry 1, running in this session, and the cycle named by the brief's title (`standInCycle` in `tugdeck/src/components/tugways/cards/session-cycle-shade-model.ts`). The shade draws the ordinary body from it, `A` to `1`, or the tile `1` alone with no sketch, and the real cycle takes its place when the attach lands. Nothing is written. The stand-in is the shade's alone: the CYCLE:ARC cell reads only a cycle on record, so an arc that never reaches one reads as its arc alone rather than `0/1 : 2/5`.

**An arc that stays on no cycle is reported.** Since [every link is required](#the-chain), an arc whose attach never landed is a defect to repair by putting it on a cycle, and the stand-in must not hide it. `tugtool cycle check` lists every live arc no entry carries, in each checkout that keeps cycles, beside the chain breaks it lists (`unattached_arcs` in `tugrust/crates/tugarc-core/src/cycle.rs`), and fails when there is one.

*Reversed, 2026-11-26: the shade first kept the arc's three panels for a cycle of one, and the sidebar a plain row with no header, map or number. The user saw the first real cycles drawn that way and asked for the one design everywhere.*

*Reversed, 2026-11-27: an arc no cycle held was still drawn as the three panels, and the check could not see it. The panels are gone from the application: a session bound to an arc always shows the cycle body, and the check reads the arc log beside the records.*

## The cycle shade

The shade is a header, the map, the asset list and a footer (`tugdeck/src/components/tugways/cards/session-cycle-shade.tsx`). It rises as tall as what it holds, up to four fifths of the card, with no blank space under its last asset, and keeps that height until it lowers, so nothing pressed inside it moves the map (`tugdeck/src/components/tugways/cards/session-arc-shade.tsx`). A grip on its top edge sets its height, up to the same four fifths, and the card keeps the height it was set to for every later rise (`cycleShadeHeightKey` in `tugdeck/src/components/tugways/cards/session-cycle-shade-model.ts`). *Reversed, 2026-11-27: the shade first stood at a fixed four fifths of the card, so a cycle of one with nothing open sat over a blank tail.* *Reversed, 2026-11-27: the shade then grew and shrank with what it held as assets opened and closed, which moved the map under the press.* The header has the lowering control, the cycle's name and how much has landed. The footer is two lines: what this session is doing now, and what is ready next. Work running in other sessions is named with each session's chip, which goes to that session. Under 520 px of card width the footer gives up its count of other sessions.

**Other shades stand over the cycle shade and do not lower it.** A Changes or History shade presents over a raised cycle shade, Find opens beside it, and the cycle shade is there when they leave (`tugdeck/src/lib/arc-shade-controller.ts`). Only share mode lowers it, because share mode selects the transcript turns the shade would cover.

**A lowered cycle shade leaves nothing standing.** The CYCLE:ARC cell carries the fractions and the way back. *Rejected: a footer left standing under a lowered shade.*

## The Cycles & Arcs card

The sidebar card lists cycles first, then the arcs no cycle names, then waiting paperwork. An arc is drawn once: an arc a cycle's entry carries is drawn in its cycle and left out of the loose list.

**A folded cycle shows a strip.** In place of its map, a folded cycle shows one segment per entry in the tone of that entry's state. A cycle starts open, and the user's fold or unfold holds for as long as the card is open (`cycleIsFolded` in `tugdeck/src/components/arcs/arcs-projection.ts`). *Reversed, 2026-11-26: a cycle at rest, with every entry joined, first started folded. Such a cycle is now closed and never reaches the card, unless a sketch on it is still pending, which is work still to start.*

Every row is a keyboard stop, and the map is never the only door: each tile and seal has a row that says the same thing.

## Drawn and deferred

Four controls were drawn while the cycle surfaces were explored, and none of them is built. The deferral was the user's: starting things from these surfaces waits until the surfaces themselves have settled. The drawing is in the Cycle Band spike (`tugdeck/src/spikes/spike-cycle-band.tsx`), which stays in the tree as the reference the shipped surfaces are checked against until the user has confirmed them. This section records a design that has no other home. It is not a commitment to build it.

- **Start on a ready entry.** A button on a ready entry's asset, and on the footer's Next line, that starts that entry's arc in this session.
- **Start in a new session.** A second, smaller button beside it that opens a new session for the entry.
- **New Cycle.** A button in the shade's no-cycle form.
- **Bind.** A button beside it that binds this session to a cycle that is already open.

One finding about them was reviewed and holds if they are built: **a Start press fills the prompt and never sends.** Start places the arc command for the entry in the card's prompt and stops, and the user sends it. Start in a new session opens the session with the command in its prompt, unsent. This is the same rule as [No surface has a prompt](#no-surface-has-a-prompt): the surfaces can prepare a turn, and only the user sends one.

As the product stands, a ready entry wears its Ready mark and has nothing to press beside it, and the footer's Next line names what is ready and carries no control.
