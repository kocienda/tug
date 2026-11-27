<!-- brief-skeleton v1 -->

# Cycles: a whole chain from sketch to landed arc, and surfaces that match the spike

**Purpose:** The cycle surfaces shipped, and the first real cycles show a map with no sketch, steps drawn outside their tile, and a status cell that reads one number where two are wanted. The user wants a process that starts at a sketch and ends at a landed arc with a brief in the middle, that never leaves them wondering what happens next, and surfaces that show it as clearly as the Cycle Band spike did.

---

## Purpose {#purpose}

The user looked at the cycle "Animal gaits and flight" in the Session card and the Cycles & Arcs card and reported three things:

> There's *always* a sketch for a brief. There must be. There's *always* a brief for an arc. There must be. Really. Figure out why we don't seem to have the resources we need to draw a complete diagram.

> Arc steps can just draw all over the place. They must be confined to their chip in the diagram. Flaw in both the Cycles & Arcs card and in the shade in a session card.

> Z2 item label probably needs to be CYCLE & ARC, with *two* N/M N/M numbers underneath.

Asked whether one brief may be carried by two arcs: "This is a rare case I hope, but I think we need to allow it." Asked whether related briefs written in different sessions should join one cycle: "yes. absolutely. sessions are only loosely associated with sketches, briefs, arcs, and cycles. They must be able to cross these boundaries with ease and aplomb."

Then the user stated the whole requirement:

> we need to provide a workflow that has a start state of a sketch and an end state of a completed arc. We need a brief in the middle. A cycle is a collection of arcs, with links to the other associated assets. The model, laws, skills... everything!... needs to help the user move their way through this process without leaving them in a ditch on the side of the road wondering what's happening. Then the user interface components need to provide a view onto this process which makes everything clear and intelligible.

And the instruction for this brief: do the level best to make the result match the spike design.

The background is the rollout in `briefs/cycle-rollout-brief.md`. Its seven stages landed, its last stage deleted the spike before the user had confirmed the result, and the shipped shade carried a special case the user never asked for. The spike is back in the tree and stays there.

---

## Evidence {#evidence}

**[F01] The record refuses an entry with no brief and accepts one with no sketch.** `add_entry` in `tugrust/crates/tugarc-core/src/cycle.rs` returns "an entry needs a brief" for an empty brief path, and checks a `from` letter only when one is given. An empty `from` is written as it is. **(verified, read in the code)**

**[F02] "Animal gaits and flight" has two entries and no sketch.** `tugtool cycle show ff4e578d --json`, run in the liven checkout, prints `"sketches": []` and neither entry has a `from`. The other five cycles on this machine (two in liven, three in tug) each have a sketch A and an entry `from` it. **(verified)**

**[F03] The arc door adds a sketch only when the door itself wrote one.** `tugplug/skills/arc/SKILL.md` says a brief on no cycle "becomes a cycle of one", and to "add this arc's sketch as A when one was recorded". For a brief handed in, the door records none. The animals brief was committed at 16:42Z as `39eebf6` in liven with no cycle, and the door made the cycle at 16:44Z when `/arc` was handed it. **(verified for the skill text and the times; that the brief skill in that session did not yet write cycles is inferred from the record having no entry before the door's)**

**[F04] One brief is carried by two entries and two arcs.** Entries 1 and 2 of that cycle both name `briefs/liven-cast-animals-brief.md`, carried by `liven-cast-birds` (joined) and `liven-cast-beasts` (running). No rule in `tuglaws/cycles.md` or either skill covers this; the door added the second entry on its own judgment. **(verified)**

**[F05] The brief skill chooses a cycle by session.** `tugplug/skills/brief/SKILL.md`, under "Choose the cycle", takes a cycle the user named, then "this session's most recent cycle in this checkout" (`tugtool cycle list --mine`), then a new cycle. The rollout's stage briefs were each written in their own session, and `tugtool cycle list` in tug shows three separate cycles of one for stages 5, 6 and 7: "Related arcs shade", "Arcs sidebar card" and "Retired spike findings". **(verified)**

**[F06] A pip has a fixed width and a tile has a fixed width.** `tugdeck/src/components/tugways/cycle-map.css` gives each pip `--tugx-cycle-map-pip-width` (4 px by default) with a 2 px gap, in an `inline-flex` row that never shrinks. The tile is placed at a width the layout sets. The spike's tiles are 64 px wide at full size and 44 px compact (`MAP_FULL` and `MAP_COMPACT` in `tugdeck/src/spikes/spike-cycle-band.tsx`). Thirteen steps need about 76 px. The spike has the same rule and never showed the flaw because its sample arcs had few steps. **(verified in the code; the overflow itself is in the user's screenshots of both surfaces)**

**[F07] The status cell reads the cycle or the arc, never both.** `cycleCellReading` in `tugdeck/src/components/tugways/cards/session-cycle-shade-model.ts` returns the landed fraction when the cycle has two or more entries, and otherwise the arc reading. **(verified)**

**[F08] The sidebar still draws a cycle of one as a plain row.** `tuglaws/cycles.md`, under "A cycle of one", says so and names `projectArcsCard` in `tugdeck/src/components/arcs/arcs-projection.ts`. The user's sidebar screenshot shows `liven-cast-fill-bigger-ui`, which is entry 1 of the cycle "Cast grid and UI size" with sketch A, as a loose row with no cycle name, no map and no sketch. The shade drew a cycle of one as a cycle from `acb8850fc` on. **(verified for the law and the record; the row is in the screenshot)**

**[F09] The shade's screenshot shows two vertical scrollbars.** The running entry's steps sit in their own scroller inside the asset list, which also scrolls. `tuglaws/cycles.md` says no surface has more than one vertical scroller. The cause in the code was not traced; the running entry's body is `ArcPopoverContent`, passed in from `tugdeck/src/components/tugways/cards/session-arc-shade-content.tsx`. **(seen in the screenshot, not traced)**

**[F10] The sidebar's joined entry says "Joined" twice.** The user's screenshot shows the Joined badge at the right of entry 1 and the word "Joined" again under the arc name. **(seen in the screenshot, not traced)**

**[F11] The shipped surfaces have not been compared with the spike part by part.** The spike is `tugdeck/src/spikes/spike-cycle-band.tsx` with its CSS and layout file, restored in `d8c53c2e0`. In it each sketch is an asset in the list with its letter, the entries it heads and its text; each entry is one row with its arc, session, brief, waits, note and state; and a running entry shows its steps. [F06], [F08], [F09] and [F10] were found from three screenshots. A full comparison has not been done, so more differences are likely.

**[F12] The laws in `tuglaws/tuglaws.md` run to L39.** The file groups numbered laws under headings; none is about work records or sessions. `tuglaws/cycles.md` holds the cycle rules and `tuglaws/arc-lifecycle.md` the arc's. **(verified)**

---

## Decisions {#decisions}

### The process

**[B01] The process is sketch, then brief, then arc, then landed.** It always starts at a sketch and always ends at a landed arc, with a brief in the middle. A cycle is the collection of arcs that belong together, each linked to its brief and its sketch. Stated by the user outright. Everything below serves this.

**[B02] Every link in the chain is required.** An arc is carried by exactly one entry on exactly one cycle. An entry has exactly one brief. An entry names at least one sketch on its cycle. A missing link is a defect in Tug, never a state a surface has to draw around.

**[B03] One brief may be carried by more than one entry, each with its own arc.** It is rare and it is allowed, at the user's direction, because a brief's work is sometimes split ([F04]). It is drawn as what it is: two entries that name the same brief.

**[B04] A brief that led to more briefs is a link, not an entry.** When a sketch is written up as a brief that spawns further briefs and never has an arc of its own, as `briefs/cycle-rollout-brief.md` did, that first brief is recorded on the sketch it wrote up. The arcs reach the sketch through it. It is not an entry, because an entry with no arc would read as ready forever, and it is not a third kind of thing on the map.

**[B05] The user is always told where they are and what comes next.** Each skill ends by naming the next step in the process: after a sketch, brief it; after a brief, open an arc on it; after an arc finishes, land it. Each surface says the same for every item it shows. No step ends in silence. Starting things from the surfaces stays deferred, as the rollout brief decided; naming the next step is not starting it.

### The record and the skills

**[B06] The record's writer refuses a broken chain.** `add-entry` refuses an entry that names no sketch, the same way it refuses one with no brief. This is the direct fix for [F01]: a rule only a skill keeps is not kept, because a skill is prose a model follows.

**[B07] A work record is found through other records, never through the session.** The brief skill finds its cycle by the sketch the brief comes from, or by the brief it was written from ([B04]), and starts a new cycle when neither is on one. The "this session's most recent cycle" rule ([F05]) is removed. The user's words: sessions are only loosely associated with sketches, briefs, arcs and cycles, and must cross those boundaries with ease.

**[B08] The arc door records a sketch for a brief that has none.** When the door is handed a brief on no cycle, it writes a sketch from that brief, in the sketch's ordinary shape and the user's words, and adds it as A before the entry. With [B06] in place the door cannot do otherwise.

**[B09] Existing records are repaired and checked.** A new verb adds a sketch to an entry already on record; it only adds, so nothing is removed or renumbered. A second new verb reads every cycle on the machine and lists each one that breaks [B02]. "Animal gaits and flight" gets its sketch through the first, and the second is how anyone knows the records are whole.

**[B10] Two numbered laws are added, and the cycle rules are restated.** In `tuglaws/tuglaws.md`: **L40, a record's rule is refused by the record's one writer**, and **L41, a session works on records and never owns one**. In `tuglaws/cycles.md`: a new opening section stating [B01] to [B04], and the "A cycle of one" and "The CYCLE cell" sections rewritten for [B11] and [B14]. Both laws are general: L40 would have caught [F01] and L41 would have caught [F05].

### The surfaces

**[B11] A surface draws what the record holds and adds no special case.** A cycle of one is a cycle in the shade, in the sidebar and in the cell. The sidebar's plain row for a cycle of one ([F08]) goes, as the shade's did. Only an arc that no cycle holds is drawn alone, and after [B02] and [B09] that is a defect to fix, not a form to keep.

**[B12] The spike is the reference, and each difference is decided, not drifted into.** The shade and the sidebar card are compared with the spike part by part ([F11]): the map, the sketch asset, the entry row, the running entry's steps, the header, the footer, selection, pinning and scrolling. Where a shipped surface differs, it changes to match, unless this brief or the user says otherwise. The two differences decided here are the cell ([B14]) and the deferred Start controls.

**[B13] A tile's steps stay inside the tile.** The pips share the width the tile has left after its number. When an arc has too many steps for each pip to stay readable, the tile draws one bar filled to the same fraction. This holds at both sizes and goes into the shared map, so both surfaces get it at once. The spike is corrected the same way, since it has the same latent flaw ([F06]).

**[B14] The status cell is labelled CYCLE & ARC and shows two fractions.** The first is the cycle's entries landed over its entries; the second is this session's arc's steps done over its steps. A session bound to no arc shows the cycle's fraction alone. A cycle of one reads 0/1 or 1/1 like any other. Pressing the cell still raises and lowers the shade.

**[B15] One vertical scroller per surface, with no exception for the running entry.** The running entry's steps are laid out in full inside the asset list, which is the shade's one scroller ([F09]). The duplicate "Joined" in the sidebar ([F10]) is removed under the one-representation rule.

**[B16] The spike stays until the user confirms the surfaces.** Nothing in this work deletes or retires it. Confirmation is the user looking at real cycles in the built app beside the spike and saying so.

---

## Open Questions {#open-questions}

- **What the two fractions look like when the arc is not walking steps.** An arc being devised, reviewed or audited has no step count. Whether the second place shows that stage's mark, as the arc cell did, or stays empty needs the cell drawn and the user's eye on it.
- **How many steps is too many pips.** [B13] needs a threshold at each tile size. It is a matter of measuring the tile's inner width and choosing a least readable pip; the first drawing will settle it.

---

## Non-goals {#non-goals}

- **Starting things from the surfaces.** Start, Start in a new session, New Cycle and Bind stay deferred, as `briefs/cycle-rollout-brief.md` decided. The spike draws them and the product does not.
- **Merging cycles.** The three stage cycles in tug ([F05]) stay three. A verb that moves entries between cycles would break "nothing is removed or renumbered" to tidy finished work, and [B07] stops new ones from splitting.
- **Requiring a second brief before a second arc.** Rejected in [B03].
- **A third kind of asset on the map for an index brief.** Rejected in [B04].
- **Retiring the spike.** Rejected in [B16].
- **A session as the owner of anything.** `created_by` on a cycle stays as a fact about who wrote it. It routes no write and decides no lookup.

---

## Exit {#exit}

**An arc.** The record comes first, so the surfaces are built once on records that are already whole. The order the work must land in:

1. The rules written down: the chain in `tuglaws/cycles.md`, L40 and L41 in `tuglaws/tuglaws.md`.
2. The record enforcing them: `add-entry` refusing no sketch, the verb that adds a sketch to an old entry, the verb that checks every record, a sketch able to carry the brief that wrote it up, and `cycle find` matching that brief.
3. The skills matching: the brief skill finding its cycle through records, the door writing a sketch for a brief with none, and both naming the next step.
4. The records on this machine repaired and the check run clean.
5. The shared map: pips held inside the tile, in the component and in the spike.
6. The comparison with the spike, written as a list of differences, and each one fixed in the shade and the sidebar card, including the cycle of one in the sidebar, the single scroller and the duplicate Joined.
7. The CYCLE & ARC cell.

It ends with the spike still in the tree and the user checking the built app against it.
