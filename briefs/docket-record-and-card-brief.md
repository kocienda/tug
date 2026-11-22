# The docket: a record and a card that gather a line of work

**Purpose:** There is no place in Tug that shows how one line of work ran, from its briefs through its arcs and sessions to its commits. This brief adds the docket, a named list that gathers those objects, and a card that shows it.

This is brief 2 of 4 for the docket design. It depends on `briefs/arc-and-sketch-identity-brief.md`, which makes arcs and sketches durable and gives them atoms. `briefs/docket-authoring-brief.md` and `briefs/docket-loop-brief.md` follow.

---

## Purpose {#purpose}

The user asked for a construct "at a higher level than a session. It could gather up a number of ideas (even before we sketch them), then sketches, briefs, arcs, the sessions which implemented them, and the associated commits produced from the building process. The goal would be that I could *see* the flow."

And for a card: "a new type of card … that would gather up this content, help me to organize it, display it, review it, add to it."

This brief covers the record and the seeing. Creating work from the card is the next brief.

---

## Evidence {#evidence}

**[F01] "Project" already names the project directory.** It is the `tug` in a session reference `tug/mighty-cabin` and the key of `~/Library/Application Support/Tug/projects/`. The work grammar's rule is that every term names one thing. **(verified)**

**[F02] This checkout's arc log holds 409 arcs.** 402 joined and 12 discarded, in one flat file. Nothing groups them. **(verified)**

**[F03] The links between the objects are already recorded.** A joined arc's commit carries `Tug-Arc`, `Tug-Session` and `Tug-Session-Id` trailers. The sketch record ends on a `Source:` line naming a session uuid and turns. The arc log names each step's commit. `tugtool arc bind` records which session works on which arc. **(verified)**

**[F04] The per-checkout store exists.** `~/Library/Application Support/Tug/projects/<checkout>/` holds the arc log and the operation log, is shared across instances, and after brief 1 holds the arc archive. **(verified for the log; the archive is brief 1's work)**

**[F05] The `briefs/` charter forbids indexing the directory.** `tuglaws/work-grammar.md`: "no tool reads the directory, nothing indexes it", with the `roadmap/` directory named as the lesson. **(verified)**

---

## Decisions {#decisions}

**[B01] The construct is called a docket.** A docket is a list of matters to be dealt with, which moves as they are settled. "Project" is taken ([F01]). "Saga", "batch" and "vector" were considered and are recorded under Non-goals.

**[B02] A docket belongs to one checkout.** It does not span repositories. This is "one for now", in the user's words, and can be revisited.

**[B03] Membership is fluid and never required.** An arc, session, commit, brief or sketch may be on a docket or on none. It can be filed, moved or removed at any time. No arc, session or commit behaves differently for being unfiled.

**[B04] Main-lane work can be filed.** A session and the commits it made with `/commit` go on a docket with no arc involved.

**[B05] Filing is placing an atom.** Pasting or dragging an atom onto the docket card files that object. This is why brief 1's atoms come first.

**[B06] The docket record lives in the per-checkout store, beside the arc log.** It is user state: nothing deletes or prunes it, and it is not committed to git ([F04]).

**[B07] The docket keeps its own records and never crawls `briefs/`.** A brief on a docket is filed by reference to a snapshot the docket holds. The file in `briefs/` stays the user's and the charter stands ([F05]).

**[B08] A docket is shown as threads.** A thread is one piece of work followed as far as it has gone: sketch, brief, arc, sessions, commits, each drawn as its atom with its state. Threads are derived from the links already recorded ([F03]); filing an arc brings its sketch, brief, sessions and join commit into view without each being filed by hand.

**[B09] A new card type, the Docket card, shows one docket.** It lists the threads, shows a running arc's step count live, and takes filing gestures. It follows the tuglaws: external state through `useSyncExternalStore` [L02], appearance through CSS and DOM [L06].

**[B10] The arc card says which docket its arc is on.** It shows the docket's atom, and pressing it opens the Docket card at that thread. An arc on no docket shows nothing and behaves as it does today.

**[B11] A docket is itself an atom, with read verbs.** `tugtool docket list` and `tugtool docket show <id>` read it. The marker, the reference block and the prompt rule follow brief 1's pattern and ship in the plugin.

**[B12] A docket is created, renamed and retired by the user.** Retiring hides it and keeps its record, on the same rule as an instance directory: nothing automated removes it.

---

## Open Questions {#open-questions}

- **How many dockets may hold one object.** One at a time keeps "move" meaningful and the arc card's link single. Many allows a commit that matters to two lines of work. The recommendation is at most one for now.
- **Store format and writer.** Files or a ledger, and whether tugcast is the only writer as it is for the other shared ledgers. Brief 1 has the same question for the archive; one answer should serve both.
- **Where the card lives.** A deck card like a session card, or a sidebar card like Arcs. The docket is a place to work from, which argues for the deck.
- **The existing Arcs card.** Whether it gains a grouping by docket or stays a flat list beside the Docket card.

---

## Non-goals {#non-goals}

- **Ideas, and creating sketches, briefs or arcs from the card.** That is the authoring brief. This card files and shows.
- **Jots.** The user ruled that jots are wholly separate from this work.
- **A docket that spans checkouts.** Ruled out by [B02].
- **Required membership, or an implicit docket for unfiled arcs.** Ruled out by [B03].
- **The names saga, batch and vector.** "Saga" was too grand. "Batch" names a closed set processed together, and the word is already used in 935 files here, most visibly for app-test batches. "Vector" already names an embedding in the semantic index and reads as a property, not a container.

---

## Exit {#exit}

**An arc.** Its parts, in order:

1. The docket record: create, rename, retire, file, move, remove, with `tugtool docket list` and `show`.
2. Thread derivation from the recorded links.
3. The Docket card: threads, live arc state, filing by atom.
4. The docket atom and its reference block, and the arc card's link back.
