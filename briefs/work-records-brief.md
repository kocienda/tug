# Work records: one model for sketches, briefs, arcs and cycles

**Purpose:** A long run of work that a session sketched, briefed and listed is invisible to the cycle surfaces until each arc opens, because nothing holds a brief, a queued arc or where either came from. This brief gives sketches, briefs, queued arcs, arcs and cycles one model, one set of verbs and one record of change, so behaviour and interface can be built on it.

---

## Purpose {#purpose}

The user ran a fifteen-arc progression in another project from one steward session, `liven/rotund-plaid`. That session wrote about nine briefs over three days and restated an ordered list of `/arc <name> @<brief>` commands six times. The cycle surfaces showed almost none of it:

> We *are not* modeling this now in a way that helps the user at all. We don't seem to recognize that when I run one of these arcs that it is an item in this collection and progression.

> I *do not* want to impose the burden on the user to declare ahead of time that they are going to create a bunch of work. The opening of a session and the process of chatting with the AI and then producing some material *must be enough by itself*.

And, once the gaps were laid out:

> We should *canonicalize and formalize* how the model, skills, tools, etc. can communicate about sketches, briefs, arcs, and cycles. We need an API that we can build on as the basis for the behaviors and user interfaces we'll add on top. I don't think we have anythink like that yet—and we need it.

> yes! sketches too! we need to keep a frim grip on these reources!

This brief is the first of three. It settles the model, the verbs and the record of change. `briefs/work-statement-brief.md` settles how a session declares queued arcs in an answer. `briefs/cycle-keeper-brief.md` settles the model pass that tends a cycle from both.

---

## Evidence {#evidence}

**[F01] The record holds an entry only once an arc has opened on it.** Liven's cycle `bb8f39b5` held five entries on 2026-11-27, each added by the `/arc` door at the moment its arc opened. The steward session's last list named eleven more arcs in order. Between arcs every entry on record had landed, so the cycle was closed and on no surface. Read from `tugtool cycle show bb8f39b5` and `tugtool session show 81acbce8-ec2c-4686-877f-c889f083424f`. **(verified)**

**[F02] An entry is a brief, so arcs cut from one brief cannot be told apart.** `CycleEntry` in `tugrust/crates/tugarc-core/src/cycle.rs` carries a brief path, an optional arc link, waits, sketch letters and a note. It has no name of its own and no arc name before an arc opens. Twelve arcs on `briefs/liven-rigged-cast-brief.md` are twelve entries with one title. **(verified)**

**[F03] A brief has no record.** `tugtool brief` has one verb, `dir`, which prints a directory. A brief is known only as a path string on a cycle entry. Nothing records which sketch it came from, which session wrote it, or the commits that changed it, and a rename breaks every link to it. **(verified)**

**[F04] A sketch has a record, without structured sources.** The sketch store (`tugrust/crates/tugarc-core/src/sketch.rs`) keeps an id, numbered versions and an optional arc link under `<project_state_dir>/sketches/<id>/`. Where the sketch came from is a `Source:` line of prose inside the text. Nothing can list a sketch's sources without parsing it. **(verified)**

**[F05] A sketch written from a brief traces to nothing.** Sketch A of liven's cycle reads "This is the first group: the nine for conversation". The door wrote it from the brief when the first batch opened, under the doctrine's one exception for a brief on no cycle. It restates the brief and does not lead to the turns of `liven/rotund-plaid` where the hundred members and their batches were settled. **(verified)**

**[F06] The verbs are uneven and the skills chain them.** `tugtool cycle` has eleven verbs, `tugtool arc` twenty-six, `tugtool sketch` two and `tugtool brief` one. The `/arc` door (`tugplug/skills/arc/SKILL.md`) runs `cycle find`, reads the JSON, then picks between `attach`, `add-entry` then `attach`, or `create` then three more verbs. That choice lives in skill prose. **(verified)**

**[F07] The chained verbs already produced a wrong record.** In liven session `42690f8d` the door attached a second arc over a landed entry's link and then added a second entry for the same arc, leaving two entries carrying `liven-cast-devices` and `liven-cast-conversation` on none. `920f2ab2a` made `attach` refuse both, but the decision is still made by the skill. **(verified)**

**[F08] Change is learned by side effect.** The session ledger's `facts` table has twelve kinds (`tugrust/crates/tugcore/src/facts.rs`): prompt, the session lifecycle, commit, shell, test run and failed edit. A join records a commit fact. A sketch recorded, a brief written, a brief committed through `tugtool commit`, an entry added and an arc opened record nothing. Surfaces learn of a cycle write from a file watch (`tugrust/crates/tugcast/src/feeds/cycle_watch.rs`), and of the arc log from a byte cursor (`tugrust/crates/tugcast/src/feeds/arc_notes.rs`). **(verified, from a read of those files by a delegated search)**

**[F09] tugcast is the facts table's only writer.** The table is in the per-instance `sessions.db`, and every recorder found is inside tugcast. The cycle and sketch verbs run in `tugtool` processes, which do not link tugcast. So a verb cannot record a fact directly. **(inference from the recorders found; confirm by reading how `sessions.db` is opened for write)**

**[F10] Two writers could lose each other's change to a cycle record.** Every cycle verb read the record, changed it and wrote it whole with an atomic rename and no lock. This conversation added a lock on a sibling file, `cycle.json.lock`, held for each read, change and write, with a test that races eight writers and fails without it. It is uncommitted on main at the time of writing. **(verified)**

**[F11] The order of a listed run reads correctly as waits.** The Cycle Progression spike (`tugdeck/src/spikes/spike-cycle-progression.tsx`) feeds the shipped cycle shade a record in which each listed arc waits on the one before. The shade's own Ready, Waiting and Next lines then say where the run stands, with no new field for order. **(verified in the spike's fixture; not yet seen against a real record)**

---

## Decisions {#decisions}

**[B01] Five nouns, each with a record and a fixed identity.** Sketch, brief, queued arc, arc and cycle. Every one is addressed by an identity that does not change when a file moves or a name is reused. This rules out a path or a bare name as a link between two records.

**[B02] A brief gets a record of its own.** It holds an id of its own, the brief's path and every path it has had, its title, the sketches it came from by id, the session that wrote it, and each commit that changed it as a version. It lives in the app's store beside the sketch store, outside the project. A cycle entry names a brief by its id. The path stays what the user types and what `/arc` is handed; the record is found from it.

**[B03] A sketch's sources are part of its record.** Each source is a session and a turn, with the words said there when they were read. The record also says whether the sketch was written at the time or filled in afterwards. The `Source:` line stays in the text for the reader, and the record is what tools read. A sketch whose only source is a brief ([F05]) says so in its record, so it can be found and grounded later.

**[B04] A queued arc is an entry with no arc yet, and it carries its own name.** An entry gains the arc name it was listed under, a label of its own, and who stated it: the session and the turn. With those, twelve entries on one brief read as twelve things, and the door matches an arc to its entry by name, never by guessing from the brief. This removes the ambiguity behind [F07].

**[B05] Order is recorded as waits.** A listed run is each arc waiting on the one before it. No separate order field is added, because the shade's existing states already read a run correctly from waits ([F11]).

**[B06] An entry says whether it was listed.** Work that landed in the middle of a run without being on any list is placed on the cycle and marked as such. It waits on nothing and is not counted against the run.

**[B07] One Rust core owns the model, and verbs state intent.** `tugarc-core` holds every rule about what links to what. A caller says what it means and the core decides how the record changes. The door runs one verb that places an arc: the core fills the queued entry of that name, adds an entry, or starts a cycle. A skill never chains verbs on a reading of JSON. The chained verbs the skills use today are removed from the skills in the same change that adds the intent verbs.

**[B08] Each noun has the same small set of verbs.** Record, show, find and list, with one JSON envelope, the one `tugtool` already prints. `tugtool brief` and `tugtool sketch` grow to match `tugtool cycle`. A verb that exists today and still states an intent keeps its name.

**[B09] Every change to a work object is written once to a work log, and tugcast turns each line into a fact.** The core appends one line per change to an append-only log in the app's store: sketch recorded, brief recorded, brief committed, arc queued, arc opened, arc joined, arc discarded, entry dropped. Each line names the object, the session that caused it when one did, and the time. tugcast follows the log with a cursor, as it follows the arc log today, and records a fact for each line. This is how a `tugtool` process reaches a table only tugcast writes ([F09]). Rejected: letting `tugtool` write the session ledger, which breaks the one-writer rule the ledgers keep.

**[B10] The fact kinds are added to the fixed list, and nothing else announces a change.** Every consumer that needs to know work changed reads these facts: the keeper, the surfaces that want a history, and the Operator's existing fact verbs. The file watch stays as the way a surface learns to redraw.

**[B11] Evidence lives in the ledger, and decisions live on the records.** What was observed, such as a list stated in a session or a brief committed, is a fact. What was decided from it, such as a sketch's sources, an entry's label or a brief's sketch, is on the record, so `tugtool` reads it with no tugcast running. The user settled the ledger over a file beside the cycle: "We have a ledger, right? Why write to a file?"

**[B12] A private session's work is never recorded as evidence.** The facts table already refuses a private session's fact at write time. The work log carries the session id so that refusal applies. A record written from a private session still exists, since the user asked for it, and names no turn of it as a source.

**[B13] Every write to a work record is held against other writers.** The lock added for cycle records ([F10]) is the rule for every record this brief adds. Two doors, or a door and a keeper, must never lose each other's change.

**[B14] Records already on disk are brought forward, not abandoned.** A cycle entry that names a brief by path gets a brief record the first time the core reads it. The install base is the user's own machines, so the migration is one-way and keeps no reader for the old shape.

**[B15] The contract is written down in two places.** What a model, a skill or a tool may say and expect ships in the plugin, so it holds in any project. The doctrine and its reasons go in `tuglaws/cycles.md` and `tuglaws/work-grammar.md`.

---

## Open Questions {#open-questions}

- **How a brief's record follows a rename the user makes by hand.** A brief is a tracked file in the user's project, and `git mv` goes through no Tug verb. The record can be found again by git's rename detection at find time, or the brief can carry its id in the document. The sketch doctrine keeps ids out of the text. What would settle it: whether a brief has been renamed in practice, and whether an id line in a document the user reads is acceptable.

---

## Non-goals {#non-goals}

- **How a session declares queued arcs.** That is `briefs/work-statement-brief.md`. This brief adds the verb that queues an arc and leaves who calls it to that one.
- **Any model pass.** Grounding a sketch in its conversation and keeping a queue true need judgment. That is `briefs/cycle-keeper-brief.md`. Nothing here runs a model turn.
- **New surface work.** The shade's evolution is in the Cycle Progression spike and is not settled. This brief changes what the wire can carry and draws nothing new.
- **A level above the cycle.** The steward session's work was a program of several legs. The user set that aside: the spike explores what the user sees in one long cycle first.
- **Renaming the nouns.** Sketch, brief, arc and cycle keep their names and the ladder in `tuglaws/work-grammar.md` stands.
- **A plan record.** A plan belongs to its arc and is out of scope.

---

## Exit {#exit}

**An arc.** The work starts in `tugrust/crates/tugarc-core` and moves outward:

- The brief record and its store, with find-by-path and versions from commits.
- Sources on the sketch record, read from an existing `Source:` line where there is one.
- The entry's arc name, label, stated-by and listed mark, and the wire types in `tugdeck/src/lib/changeset-types.ts` that carry them.
- The intent verbs, the door's one verb first, and the skills rewritten to use them.
- The work log, tugcast's follower and the new fact kinds.
- The lock applied to every record, and the migration for records on disk.

The lock for cycle records and its test are already in the working tree and belong to this arc's first step if they have not been committed by then.
