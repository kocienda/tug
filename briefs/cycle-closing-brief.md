# Cycles close when their work is finished

**Purpose:** A cycle stays on every surface forever, even after all its arcs have landed. A cycle should close by itself once its work is finished, leave the surfaces, and reopen when more work is added to it.

---

## Purpose {#purpose}

The user's words: "We need to figure out some way that we can close cycles when they no longer have work associated with them. As it is, cycles will stay open forever, and that is not the intent of them." And the rule proposed: "once a cycle's arcs have all finished, it closes, and is removed from the various user interfaces. If the user goes back to one to re-open it and add another arc, they can. Also, while [a cycle] is still open (i.e. its arcs have not completed), more can be added."

The visible symptom is a session whose cycle landed days ago still reading `1/1:—` in its `CYCLE:ARC` cell, and a Cycles & Arcs card that only ever grows.

---

## Evidence {#evidence}

**[F01] The law says a cycle is never closed.** `tuglaws/cycles.md` under "What a cycle is" and [D235] in `tuglaws/design-decisions.md` both state it, and record "a closing or landing gesture for the whole cycle" as rejected. **(verified)**

**[F02] An entry's state is derived on every read and never stored.** `entry_states` in `tugrust/crates/tugarc-core/src/cycle.rs` reads joined, running, ready or waiting from the arc log through `link_status`. The record stores no state. **(verified)**

**[F03] A discarded arc's entry reads as ready again.** `link_status` maps a generation that ended in `discarded` (or its old spelling, `released`) to `LinkStatus::NotStarted`, the same value as an entry that never had an arc, so `entry_states` cannot tell the two apart. A cycle of one whose arc was discarded would therefore never read as finished. **(verified)**

**[F04] An undone join already reads as open again.** `link_status` clears a generation's ending on an `undone` line whose note starts `reversed join`, so anything derived from it follows an undo with no further code. **(verified)**

**[F05] Running `/arc` again on a discarded entry's brief relinks the entry.** `attach` replaces a link whose generation has ended, so the entry is carried by the new arc and reads running. **(verified)**

**[F06] An entry or sketch that never starts cannot be derived as finished.** An entry with no arc reads ready or waiting for ever, and a sketch with no entry is not looked at by `entry_states` at all. Nothing in the arc log says the user has given up on either. **(verified by reading; the conclusion that only the user knows is inference)**

**[F07] Every surface gets its cycles from one place.** `cycle_entries_in` in `tugrust/crates/tugcast/src/feeds/changeset.rs` composes the cycle list each project's changeset carries, from `tugarc_core::cycle::cycles` and `view_cycle_in`. The shade, the `CYCLE:ARC` cell and the Cycles & Arcs card all read that list through `tugdeck/src/lib/cycle-store.ts`. **(verified)**

**[F08] A brief written from a cycle's sketch or brief is already added to that cycle.** The brief skill finds its cycle with `tugtool cycle find --sketch` or `--brief` ([L41]), with no check on whether the cycle's work has finished. **(verified)**

**[F09] All four cycles on this machine read 1/1.** `tugtool cycle list --json` on 2026-11-26 listed four cycles, each with one entry, landed. **(verified)**

**[F10] The sidebar has a rule for a cycle at rest.** `cycleIsFolded` in `tugdeck/src/components/arcs/arcs-projection.ts` starts a cycle folded when every entry is joined. **(verified in `tuglaws/cycles.md`; the function was not re-read)**

---

## Decisions {#decisions}

**[B01] Closed is derived, never stored, and there is still no closing gesture.** A cycle is closed when the rule in [B02] holds, read from the record and the arc log on every read, beside `entry_states`. This keeps the property [F02] exists for: a cycle cannot disagree with its arcs. Reopening needs no verb, because adding work makes the rule false. The law's "never closed" is reversed; its rejection of a closing gesture stands.

**[B02] A cycle is closed when it has at least one entry, every entry is settled, and no sketch is pending.** An entry is settled when its arc joined, its arc was discarded, or it was dropped by hand ([B04]). A sketch is pending when no entry names its letter and it has not been dropped. The rule counts entries, not arcs: a cycle with entry 1 landed and entry 2 not started has no open arc, and it must stay open, because that is when "what is ready next" matters. A cycle with no entries yet is open, or it would close between its creation and its first entry.

**[B03] An entry whose arc was discarded is settled, and reads `dropped`.** Today it reads ready ([F03]), which would hold its cycle open for ever. `link_status` tells a discarded generation apart from one that never started, and `EntryState` gains `Dropped`. Running `/arc` on the brief again relinks the entry ([F05]) and it reads running, so the cycle reopens and nothing is lost. A wait on a dropped entry is not satisfied: the waiting entry stays waiting, and its cycle stays open until that entry is settled too.

**[B04] `tugtool cycle drop <id> <n|letter>` abandons an entry or a sketch that will never run.** It marks the item dropped in the record, removes nothing and renumbers nothing, and the item reads `dropped`. It is the one stored fact in this design, because it is a decision only the user can make ([F06]), in the same way a gate note is. It is refused on an entry that is running or joined: a running arc is ended by discarding it, and a joined one is already settled. `attach` clears the mark, so a dropped entry whose brief is run after all is carried normally. The verb is typed and has no control on any surface.

**[B05] The feed leaves a closed cycle out.** `cycle_entries_in` omits a closed cycle ([F07]), so the shade, the `CYCLE:ARC` cell and the Cycles & Arcs card stop showing it with no filter of their own. A session whose cycle closed reads `None` in the cell and the centered `None` in its shade.

**[B06] A cycle vanishes the moment its last entry settles.** The cell goes from, say, `2/3` to `None` with no `3/3` in between, and the shade empties. The user chose this over holding the finished cycle in the session until its next turn: the join announces the landing itself.

**[B07] Going back to a closed cycle uses the chain rule, with no new door.** A brief written from a closed cycle's sketch or brief is added to that cycle ([F08]), which reopens it by [B02]. An undone join reopens it too ([F04]). No surface offers a reopen control.

**[B08] `tugtool cycle list` hides closed cycles, and `--all` shows them.** `show`, `find` and `check` read any cycle, closed or not, so a closed cycle is always findable from the command line. The JSON of `list` and `show` carries the closed reading.

**[B09] The surfaces draw `dropped`, and the at-rest fold rule goes.** A dropped entry in a cycle that is still open is drawn in a muted tone on the map, the folded strip and its row, and is not counted in the landed fraction's numerator. The sidebar's "starts folded when every entry is joined" rule ([F10]) can no longer fire, since such a cycle is not delivered, and is removed.

**[B10] The law is rewritten in the open.** `tuglaws/cycles.md` replaces "A cycle is never closed" with the closing rule and a dated "Reversed" line, in the form its other reversals take, and [D235] is amended the same way. `docs/glossary.md` and `docs/features.md` say what a closed cycle is wherever they describe a cycle.

---

## Non-goals {#non-goals}

- **A closing or landing gesture for a cycle.** Still rejected. Closing is derived, and each arc lands by its own join.
- **Any control on a surface for dropping, closing or reopening.** `drop` is typed. No surface gains a control, in line with the standing rule that no surface starts or creates arcs or cycles.
- **A surface that lists closed cycles.** They are removed from the interfaces, as asked. `tugtool cycle list --all` is the way to see them.
- **Keeping the finished cycle on screen for a while.** Considered as "until the session's next turn" and rejected by the user ([B06]).
- **Deleting a closed cycle's record.** Nothing is removed; the record is what makes reopening possible.
- **Closing by age.** A cycle with unfinished paperwork stays open until that paperwork is run or dropped, however old it is.

---

## Exit {#exit}

**An arc.** The work runs from the record outward, and the order matters because each layer reads the one before it:

- The rule in `tugrust/crates/tugarc-core/src/cycle.rs`: a discarded link told apart from one never started, the `Dropped` state, the dropped mark on entries and sketches, `attach` clearing it, and the closed reading on `CycleView`, each with unit tests over arc-log text, the undo and relink cases included.
- The verb in `tugrust/crates/tugtool/src/cycle.rs`: `drop`, and `list` with `--all`.
- The feed in `tugrust/crates/tugcast/src/feeds/changeset.rs`: closed cycles left out, and `dropped` on the wire.
- The deck: the `dropped` tone on the map, the strip and the rows, and the at-rest fold rule removed. The spike `tugdeck/src/spikes/spike-cycle-band.tsx` is left alone.
- An app-test that lands a cycle's last arc and reads the cell as `None` and the sidebar without the cycle, and the existing cycle app-tests moved wherever they relied on a finished cycle staying on screen.
- The law and the docs ([B10]).
