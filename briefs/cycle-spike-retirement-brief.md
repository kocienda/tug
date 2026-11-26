<!-- brief-skeleton v1 -->

# Retire the Cycle Band spike: its findings into `tuglaws/`, its files out of the tree

**Purpose:** The Cycle Band spike was the reviewed reference for the cycle shade and the Cycles & Arcs card, and both now stand on real data. What the spike settled is written only in working briefs and in the spike's own comments, and `tuglaws/` says nothing about cycles. This is stage 7 of `briefs/cycle-rollout-brief.md`: record the durable findings, then delete the spike.

---

## Purpose {#purpose}

The rollout brief's last row reads: "The spike retired: durable findings recorded in `tuglaws/`, the spike files and registry lines deleted", waiting on stages 5 and 6. The user's instruction for this brief is that row and nothing wider: "record the spike's durable findings in tuglaws/ and delete the spike files and their two registry lines."

The spikes directory states the same exit for any spike that has done its job: "Component work moves to `components/tugways/`, durable findings move to `tuglaws/`, and the spike file is deleted. A settled spike kept as permanent furniture is just a gallery card in the wrong room." The component work moved in stages 4 to 6. The other two halves are this stage.

---

## Evidence {#evidence}

**[F01] Stages 1 to 6 have all landed on `main`.** The record and `tugtool cycle` verbs as `03cb88584`, the shared map as `2484fd770`, the feed and store as `9bc80a668`, the skills as `f1b3536e1`, the cycle shade and CYCLE cell as `16e74e9d7`, and the Cycles & Arcs card as `2d76a0d38`. Nothing has touched the cycle surfaces since the last of them. Read from `git log`. **(verified)**

**[F02] The spike is three files and two registry lines, and nothing else imports it.** The files are `tugdeck/src/spikes/spike-cycle-band.tsx` (60,926 bytes), `spike-cycle-band.css` (21,910) and `spike-cycle-band-layout.ts` (6,575). The registry lines are `tugdeck/src/spikes/spike-registry.tsx:53`, the import of `cycleBandSpike`, and `:131`, its entry in `SPIKES`. A search of the tree for `spike-cycle-band`, `SpikeCycleBand` and `cycleBandSpike` outside those three files finds the registry import and six briefs under `briefs/`, and nothing in `tugdeck/src`, `tugdeck/scripts`, `tests/`, `tugapp/` or the recipes. The spike's last commit is `54475b519`. **(verified)**

**[F03] The shipped code does not lean on the spike.** A case-insensitive search for "spike" in the shared map and its parts (`tugdeck/src/components/tugways/cycle-*`), the shade (`cards/session-cycle-shade*`), the card (`tugdeck/src/components/arcs/arcs-card.tsx`, `arcs-projection.ts`), `tugdeck/src/lib/cycle-store.ts`, `tugrust/crates/tugarc-core/src/cycle.rs` and the two new app-tests `at0898` and `at0899` finds nothing. The map brief's [B01] had the spike keep its own copy of the layout, so the shipped layout is `cycle-map-layout.ts` and the spike's is a duplicate. **(verified)**

**[F04] `tuglaws/` has no account of a cycle.** The only line there that names one is `tuglaws/menus.md:203`, the menu row "Show Cycles & Arcs". `tuglaws/work-grammar.md`, which the index calls "the lexicon every other document here defers to", does not contain the word, and neither does `tuglaws/arc-lifecycle.md` apart from its title's "lifecycle". The last numbered decision in `tuglaws/design-decisions.md` is D234. **(verified)**

**[F05] A new document under `tuglaws/` must be in the index.** `tests/app-test/scripts/tuglaws-index-coverage.test.ts` fails when any `*.md` under `tuglaws/` other than `INDEX.md` is not linked from it. **(verified, read the test's header and assertion)**

**[F06] The spike draws four things the product does not have, and deleting it deletes the only drawing of them.** A Start control on a ready entry and on the footer's Next line, which places the arc command in the prompt and stops, "the press fills, the user sends" (`spike-cycle-band.tsx:535`, `:876`, `:1534`); a second Start that opens a new session with the command in its prompt, unsent (`:549`, `:1210`, `:1536`); a New Cycle control and a Bind control in the no-cycle form (`:1051`, `:1054`). All four were deferred by the user in the rollout brief's Non-goals, and the stage 5 and 6 briefs built none of them. **(verified, read)**

**[F07] The spike's three open switches were each settled by a later stage.** Its header lists them: whether a lowered shade leaves its footer standing, whether another shade covers the footer or stands on it, and what the shade gives up at the card's slim width. The shade brief's [B11] chose that a lowered shade leaves nothing, and its [B12] that Changes, History and Find stand over the cycle shade without lowering it. The shipped shade answers the third in CSS: under 520 px the footer gives up the count of other sessions (`tugdeck/src/components/tugways/cards/session-cycle-shade.css:339`). **(verified, read)**

**[F08] The calls the spike settled are spread across four briefs.** The rollout brief's [B01] to [B17] carry the concept and the surfaces. The map brief, the shade brief and the card brief each refined some of them against the code: several sketches per entry, the selection rule shared as `pickOnMap`, a cycle of one drawn as the arc it is, a cycle becoming a section at its second entry, a folded cycle's strip, sketch text composed on the server. `briefs/` is working paper, and none of it is in the curated surface. **(verified)**

**[F09] The tests that walk the spike registry were not read whole.** `tugdeck/src/__tests__/card-taxonomy.test.ts`, `components/cards/__tests__/cards-groups.test.ts` and `lib/__tests__/card-identity-coverage.test.ts` import the registry, and `at0741`'s two halves declare `@covers tugdeck/src/spikes/spike-registry.tsx`. A search of them for the spike's name and for a pinned count found neither. That is a search, not a reading: a test that enumerates spikes some other way would show only when run.

---

## Decisions {#decisions}

### The record

**[B01] The findings go into one new document, `tuglaws/cycles.md`, linked from `INDEX.md` under "Working on an arc".** A cycle is a concept with a record, a derivation rule, a naming rule and two surfaces, which is the size of topic every other file in that section holds. Spreading it across `arc-lifecycle.md`, `list-surface-grammar.md` and `modal-rest-line.md` would leave no place to look for "what is a cycle". The index line is required by [F05].

**[B02] The document states the rules of the product as it stands, and cites the shipped code.** It is written in the present tense about cycles, with each rule pointing at the module that holds it: the record in `tugarc-core`, the feed, `cycle-store.ts`, `cycle-map-layout.ts`, the shade's model and the card's projection. It does not tell the story of the spike's rounds, and it never cites a spike path, because those paths stop existing in the same change. Where a stage brief refined a rollout decision ([F08]), the document carries the refined rule.

**[B03] What the document must hold.** These are the findings that outlive the spike:

- **What a cycle is.** A container of numbered entries and lettered sketches. An entry is one brief and its one arc. Every arc is on a cycle, and a bare arc is a cycle of one. A cycle is never closed and has no landing gesture; each arc lands by its own join.
- **State is derived.** An entry is joined, running, ready or waiting, read from the arc log, git and its waits, and never stored. A gate is a note on an entry and blocks nothing.
- **Numbers and letters.** A digit is work that can land and a letter is where it came from. Numbers are given in order and never reused or renumbered.
- **The name.** Given once by the skills, from the opening of sketch A, and changed only by hand. The rule's text ships in the plugin's brief skill, and the document points there for it.
- **No surface has a prompt.** The shade and the card show a cycle and never send a turn.
- **Where a cycle shows.** In the session that wrote it and in every session bound to one of its arcs. The session chip is the link between them, and there is no other control for it.
- **The map.** A tile per entry, a wire per wait, a tile's column as deep as its waits run, a sketch as a seal wired to the entries it heads. A wire is solid once what it leaves has landed. Waiting is solid gray, never dashed.
- **One representation per asset.** A sketch or an entry is drawn once under the map and holds everything about it. No detail panel stands beside the list.
- **A press on the map never moves the map.** It brings the pressed asset up under the map. Only a map press scrolls.
- **Selection.** One set, the same rule on both surfaces: a click selects one, a shift-click toggles one, a press on the ground clears, and two or more narrow the list under a Back control.
- **One scrollbar per surface.**
- **The CYCLE cell.** An ordinary status cell that toggles the shade and reads the landed fraction only when there are several entries.
- **A cycle of one is drawn as its arc.** The shade keeps the arc's three panels and the card keeps one row with no map and no number. A cycle becomes a header and a map when it gains a second entry.
- **The shade among shades.** Other shades stand over the cycle shade and do not lower it. A lowered cycle shade leaves nothing standing.
- **The folded cycle.** In the sidebar a folded cycle shows a strip of its entries' states, and a cycle at rest starts folded.

**[B04] The rejected alternatives are recorded beside the rule each lost to, one line each.** The separate expand control on the status row's edge, the B1/A1 prefixes and the single number sequence, dashed borders for waiting, gates as states, a closing gesture, a footer left standing under a lowered shade, and a detail panel. A rejection that lives only in a brief gets proposed again; one line in the curated document is what stops that.

**[B05] The four unbuilt controls get a section of their own, marked as drawn and deferred, with `54475b519` named as where the drawing can be read.** They are Start on a ready entry, Start in a new session, New Cycle, and binding a session to a cycle ([F06]). The section records the one finding about them that was reviewed: a Start press fills the prompt and never sends. It says plainly that none of them is built and that the deferral was the user's. This is a record of a design that has no other home once the files go, not a commitment to build it.

**[B06] One numbered decision, the next free number after D234, goes into `tuglaws/design-decisions.md`.** It states the invariant that later plans will need to cite: a cycle is a record of entries and sketches whose entry states are derived and never stored, every arc is on one, and it is never closed. It points at `cycles.md` for the rest. One entry and not seventeen, because the decisions list is for the choices other documents cite by number, and the surface rules are read in their own document.

**[B07] `tuglaws/work-grammar.md` gains the word, in one sentence under "The arc", pointing at `cycles.md`.** The lexicon that every document defers to should not lack a first-class term the app now shows in a status cell and a card title ([F04]). One sentence and a link, with the definition kept in `cycles.md` so there is one source for it.

### The removal

**[B08] The three spike files and the two registry lines are deleted, and nothing else under `tugdeck/src/spikes/` changes.** That is the whole of what the user named. The other spikes, the registry's shape and the directory's `README.md` stay as they are. [F02] and [F03] say no other code needs to move.

**[B09] The briefs that cite the spike's paths and line numbers are left as written.** Six files under `briefs/` do ([F02]). They are working papers that record what was true when each was written, and the spike can still be read at `54475b519`. Rewriting them would be editing history to match the present.

**[B10] The record and the removal land as one arc, the document first.** The document is written while the spike's header and controls can still be read in the tree beside the shipped code, and the deletion follows it. Either order is recoverable from git; this one keeps the reading cheap.

**[B11] A pane holding the spike in a saved layout is dropped on next launch, and that is accepted.** The spikes `README.md` describes it: `filterDeckStateByRegistration` removes a card whose component no longer resolves, with a console warning. The user reviewed the spike over about ten rounds, so their deck may hold one. The arc's report says so in a sentence. No migration is written for a debug-only card.

**[B12] The checks are the fast layer plus the files the selection finds.** The type checker and lint over `tugdeck`; the three unit suites that walk the registry ([F09]); `tuglaws-index-coverage.test.ts` and the doc-link check for the new document; and `just app-test-changed`, which resolves `spike-registry.tsx` to `at0741`'s two halves through their `@covers` lines. A test that turns out to count or name spikes is fixed in this arc.

---

## Open Questions {#open-questions}

- **Has the user's eye confirmed the calls the model made without seeing them rendered?** The shade brief's [B11], that a lowered shade leaves nothing standing, was marked there as "this brief's call, not one the user stated", and the card brief left the look of the verb row on an open entry to a first rendered look. [B03] records both as the product stands. If the user has looked and wants either changed, the document should record the changed rule; that is settled by the user saying so, not by reading code.

---

## Non-goals {#non-goals}

- **Building any deferred control.** Start, Start in a new session, New Cycle and Bind are recorded by [B05] and not built.
- **Any change to the shade, the card, the map, the feed or the record.** This stage writes prose and deletes a spike. A fault found in the shipped surfaces while writing the document is reported, not folded in.
- **Touching the plugin's text.** `tugplug/work-grammar.md` and the skills ride every session's prompt and already carry what the skills need about cycles. The user named `tuglaws/`, and [B07] edits only the `tuglaws/` lexicon.
- **Retiring other spikes.** Forty-odd other files sit in the directory. None was named.
- **Moving the spike into the Component Gallery.** The gallery is for exemplary uses of shipping components. The spike is a fixture-driven stand-in for surfaces that now exist for real.
- **Keeping the spike as a reference with a note on it.** Rejected by the directory's own rule and by the arc doctrine: a retired design is deleted whole, never marked superseded.
- **A numbered decision per surface rule.** Rejected in [B06].
- **Editing the earlier cycle briefs.** Rejected in [B09].

---

## Exit {#exit}

**An arc.** Its raw material, in the order [B10] gives:

- Write `tuglaws/cycles.md` from [B02] to [B05], reading the shipped modules for each rule's citation and the spike's header and controls for the deferred section.
- Add its line to `tuglaws/INDEX.md`, the numbered decision to `design-decisions.md`, and the sentence to `work-grammar.md`.
- Delete the three spike files and the two lines of `spike-registry.tsx`.
- Run the checks in [B12].

With this arc joined, every row of the rollout brief's table has landed.
