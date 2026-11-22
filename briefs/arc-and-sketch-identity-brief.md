# Arcs and sketches survive, and can be named

**Purpose:** An arc's documents are deleted when it joins and a sketch is written once and lost with them, so neither can be pointed at, pasted, or read back later. This brief makes both durable objects with an identity, an atom, and a verb that reads them.

This is brief 1 of 4 for the docket design. The other three are `briefs/docket-record-and-card-brief.md`, `briefs/docket-authoring-brief.md` and `briefs/docket-loop-brief.md`. This one stands alone: it is useful with no docket, and the other three build on it.

---

## Purpose {#purpose}

The user wants sketches and arcs to become "interactive, fluid, first-class objects in Tug. Maybe even up to the level of sessions and commits, in that we can make atoms of them to copy and paste them around and include them in prompts and the AI can look them up to include them in its cogitations."

Today only sessions and commits have that standing. An arc has a name and a display pill, but once it joins there is nothing left to open: its brief, plan, task list and sketch are gone. A sketch has no name at all.

---

## Evidence {#evidence}

**[F01] The join deletes an arc's documents, on purpose.** `tugrust/crates/tugarc-core/src/ops/join.rs` removes `.tug/arcs/<name>/` after deleting the branch, under a comment that reads "The documents go with the branch ([P11]): the squash commit is the durable record of a joined arc, and the brief and the plan have nothing to add to it", and notes that an `undo` does not bring the directory back. `.tug/arcs/` in this checkout is empty. **(verified)**

**[F02] A discard keeps the documents.** `tugrust/crates/tugarc-core/src/ops/discard.rs` leaves the directory standing and `tugtool arc delete-documents` is the separate gesture that removes it. So the two endings of an arc treat its documents in opposite ways. **(verified)**

**[F03] After a join, the durable record is the arc log and one squash commit.** The arc log is `~/Library/Application Support/Tug/projects/<checkout>/arc-log.md`, one line per event. A joined arc is one commit on the base carrying a `Tug-Arc: tugarc/<name> onto <base>` trailer beside `Tug-Session` and `Tug-Session-Id` trailers. The step commits were on the arc's branch and are unreachable after the join; the log still names their shas. This checkout's log holds 409 arcs created, 402 joined, 12 discarded. **(verified)**

**[F04] A sketch is already written to a file, against the work grammar.** `tuglaws/work-grammar.md` and `tugplug/work-grammar.md` say a sketch "lives in the transcript only and is never written to a file". The `/arc` door writes `sketch.md` beside the brief (`tugplug/skills/arc/SKILL.md`, "Record where the work came from"), and `ArcDocuments::read` in `tugrust/crates/tugarc-core/src/ops/documents.rs` serves its text to the Sketch panel of the arc card. **(verified)**

**[F05] The sketch record has a fixed shape, a source, and is rewritten in place.** The arc doctrine (`tugplug/doctrine/arc-work-doctrine.md`, *The record of where the work came from*) gives its shape: what is wanted in one or two sentences, then the shape of the work as one sentence and three to six bullets, ending on a `Source:` line naming the session's full uuid and the turns. Every later stage reads it and rewrites it when the source session moved on. No earlier text is kept. **(verified)**

**[F06] An arc atom exists for display only.** `tugdeck/src/components/tugways/tug-arc-atom.tsx` draws the arc pill. It cannot be picked from `@`-completion, copied with clipboard flavours, or sent in a prompt. A session atom can do all three (`tugdeck/src/lib/session-atom.ts`), and a prompt carrying one ends with a reference block the model reads (`tugplug/session-references.md`). **(verified)**

**[F07] `tugtool arc show` and `arc record` read only live arcs.** They derive from git and from `.tug/arcs/<name>/`, both of which are gone after a join. **(inferred from F01 and the verbs' help text; not run against a joined arc)**

---

## Decisions {#decisions}

**[B01] A joined arc's documents are archived, not deleted. This reverses [P11] in `join.rs`.** The reasoning in [P11] was that the squash commit says everything. It does not: it says what changed, and the brief says what was decided and why. The reversal is stated here, in the code comment, and in the arc doctrine, not made quietly.

**[B02] The archive lives beside the arc log, in `~/Library/Application Support/Tug/projects/<checkout>/`.** That store is already keyed by checkout and shared by every instance, which is where a record of the checkout's arcs belongs. It is user state: nothing prunes it, and nothing commits it to git. `.tug/arcs/<name>/` stays the working home of a live arc and is still cleared at the join, after the archive is written.

**[B03] An archived arc is keyed by its name and its creation time.** Arc names are reused over time, so the name alone cannot be the key. A bare name resolves to the most recent arc of that name.

**[B04] A discarded arc is archived the same way when its documents are deleted.** `arc delete-documents` archives before it removes. The two endings then agree: the working directory goes, the record stays.

**[B05] `tugtool arc undo` of a join restores the documents from the archive.** [F01] names this gap; the archive closes it.

**[B06] A sketch is a kept, versioned record with its own id.** The id is minted when the record is first written and does not depend on the arc, because later briefs let a sketch exist before any arc does. Every rewrite ([F05]) saves the previous text as a version. The arc's `sketch.md` stays the working copy the panels read.

**[B07] A sketch stays informal.** It gains an id and versions and nothing else: no skeleton, no lint, no required sections beyond the doctrine shape the door already writes.

**[B08] The work grammar is changed to say so.** `tuglaws/work-grammar.md` and `tugplug/work-grammar.md` both say a sketch is never a file. Both are rewritten: a sketch is the converged shape of a conversation, and its record is kept and versioned.

**[B09] Arc and sketch become placed atoms on the same mechanism as a session.** Each can be picked from `@`-completion, copied and pasted with the atom clipboard flavours, and sent on the wire as a backticked marker. A prompt carrying one ends with a reference block naming the command that reads it, with the same verdicts a session reference has. `tuglaws/entity-presentation.md` gains the two kinds.

**[B10] Read verbs, reading live and archived alike.** `tugtool arc show <name>` answers for a joined or discarded arc from the archive and can print each document. `tugtool sketch show <id> [--version n]` prints a sketch. Both are read-only.

**[B11] The prompt rule ships in the plugin.** The model learns the markers, the block and the verbs from a `tugplug/` root prompt file, as it learns session references, so the feature holds on any project.

---

## Open Questions {#open-questions}

- **Archive format.** Plain files in a directory per arc, or rows in a ledger opened through `tugcore::ledger_db`. Files match the arc log beside them and can be read by hand; a ledger gives ordered queries. The docket brief needs a store too, and the two should agree.
- **Backfill.** The 402 arcs already joined have no documents left. Their arcs can still be listed from the log; whether to show them as archived arcs with no documents, or leave them out, is undecided.
- **One reference block or one per kind.** The session block is `<!-- tug:session-refs -->`. Arc and sketch references can extend it or get their own.

---

## Non-goals {#non-goals}

- **The docket.** No grouping, no card, no ideas. Those are the next three briefs.
- **Editing a sketch.** This brief makes sketches durable and readable. Editing by hand and the Keep sketch gesture are in the authoring brief.
- **Tracking arc documents in git.** They stay untracked. The archive is Tug state.
- **Indexing `briefs/`.** That directory's charter is unchanged; nothing here reads it.
- **Keeping an arc's branch or step commits after a join.** The join stays a squash.

---

## Exit {#exit}

**An arc.** Its work falls into three parts, in this order:

1. The archive: write it at the join and at `delete-documents`, restore from it on undo, and read it from `arc show`.
2. The sketch record: id, versions, and `tugtool sketch show`.
3. The atoms: `@`-completion, clipboard, wire marker, reference block and the plugin prompt file, for arc and sketch, with the work grammar and entity-presentation changes.
