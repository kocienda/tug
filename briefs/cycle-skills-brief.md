<!-- brief-skeleton v1 -->

# Cycles, stage 2: the skills write cycles, and name them by one rule

**Purpose:** Stage 1 gave a cycle a durable record and a `tugtool cycle` verb family, but nothing writes one yet: a brief written with `/tugplug:brief` and an arc opened with `/arc` leave no trace on any cycle. This stage makes those two skills the writers, and settles the rule both use to name a cycle.

---

## Purpose {#purpose}

This is stage 2 of the rollout in `briefs/cycle-rollout-brief.md`, whose Exit table states it as: "The skills write cycles: `/tugplug:brief` adds an entry with its waits and note, the `/arc` door puts its arc on its entry or on a new cycle of one, and both follow the naming rule." It waits on stage 1 alone, which landed as `03cb88584`.

The rollout brief left two things open that this stage has to close. The first is the naming rule itself, since its [B07] says only that "the skills name a cycle, from its sketches." The second is what the two skills record today, which its [F08] says nobody had read. Both are settled below. The user settled the rule after seeing three worked examples, with one addition: a cycle must be renameable by hand.

---

## Evidence {#evidence}

**[F01] Stage 1's verbs are all the writes a skill needs, except four.** `tugtool cycle` has `create --name`, `add-entry <id> --brief [--wait n]… [--from L]… [--note]`, `add-sketch <id> <sketch>`, `attach <id> <n> <arc>`, `list` and `show`. This was read from `--help` on the built binary and from `tugrust/crates/tugtool/src/cycle.rs`. Four things are missing: renaming a cycle, finding the entry that holds a given brief, listing only this session's cycles, and recording a sketch that has no arc. **(verified)**

**[F02] A sketch can only enter the store through an arc.** `tugtool sketch record <arc>` reads `.tug/arcs/<arc>/sketch.md`. `record_arc_sketch` in `tugrust/crates/tugarc-core/src/sketch.rs` is the only writer. `SketchRecord.arc` is already an `Option<SketchArc>`, so the store's shape allows a sketch with no arc, but no verb writes one. As things stand, `/tugplug:brief`, which runs with no arc, has no sketch to name a cycle from or to put on one. **(verified)**

**[F03] A sketch's first paragraph is its "what is wanted" line.** `want_of(text)` in `sketch.rs` returns the record body's first paragraph. The arc doctrine's shape for a sketch, which `/arc` step 3 follows, opens with what is wanted in one or two plain sentences. Every sketch sampled from this machine's store (25 of its 49, across `tug` and `liven`) opens that way: "Set the words Liven draws in its pictures and movies in IBM Plex instead of Apple's system typeface…", "Stop the end-of-arc check from re-running test suites over code that has not changed…". **(verified)**

**[F04] `/tugplug:brief` writes, commits and hands off, and touches nothing else.** `tugplug/skills/brief/SKILL.md` picks an address (an explicit path, an arc's own brief, or the Briefs Directory), writes against the skeleton, commits only that file with `tugtool commit --paths`, and prints `/arc <slug> @<path>`. It records no sketch and writes no record outside the brief. **(verified)**

**[F05] The `/arc` door records its sketch only after the arc opens.** `tugplug/skills/arc/SKILL.md` step 6 runs `tugtool arc run <name>`, reads the receipt, and only then runs `tugtool sketch record <name>`, "because only the opening starts a new generation of a name that was used before." A handed-in brief (grammar rule 1) is copied verbatim to `.tug/arcs/<name>/brief.md`, and the source path is known at the door. **(verified)**

**[F06] `attach` needs the arc in the arc log.** `cycle::attach` refuses with "the arc log has no arc named …" until `generation_started_at` finds the name. So the door can attach only after whatever writes `arc-start`. The `/arc` skill's own ordering in [F05] implies that `arc run` is that point. A quick search did not find the production caller of `append_arc_start`, so this is **inferred, not verified**. Implementation confirms it by attaching straight after a real `arc run` receipt.

**[F07] A cycle records its writer, but `list` does not show it.** `cycle create` stores `created_by` from `session_identity::resolve_soft`. `cycle list --json` rows carry `id`, `name`, `updated`, `landed` and `total` only, so to find "this session's cycle" today a skill would have to call `show` on every cycle and compare a session id it would have to resolve the same way. **(verified)**

**[F08] Entries are keyed by brief path, relative to the project root.** `add-entry` stores `--brief` relative to the root, and turns an absolute path inside the checkout into a relative one (`brief_path` in `tugtool/src/cycle.rs`). Nothing looks an entry up by its brief. **(verified)**

---

## Decisions {#decisions}

### The naming rule

**[B01] A cycle is named once, when it is created, from the opening sentence of its sketch A.** The name is the thing the work changes, as a noun phrase of two to four words in sentence case. It has no verb, uses the sketch's own plain words, and keeps proper nouns. It never carries an arc name, kebab-case, an id, a date, the project's name, or the words "cycle" or "work". Settled by the user as proposed. The argument is that the name is what the shade's header and the sidebar row show, so it has to read at a glance as the subject. The sketch's want line is the one sentence every sketch is required to open with ([F03]), so the rule always has something to work from.

Worked examples, from sketches in the store:

| Sketch A opens… | Name | What it shows |
|---|---|---|
| "Set the words Liven draws in its pictures and movies in IBM Plex instead of Apple's system typeface…" | IBM Plex typeface | The subject is kept and the verb dropped |
| "Make dockets carry a whole run of work, from one conversation to many briefs landed in order…" | Dockets of many briefs | A later sketch B ("Let a docket hold more than one sketch…") leaves the name alone |
| "Stop the end-of-arc check from re-running test suites over code that has not changed…" | Remembered test runs | The name comes from the sketch, not from the arc's name `verify-memo` |

**[B02] A later sketch never renames a cycle.** When a cycle gains sketch B or C, the skills leave its name as it is. A name that moves while the cycle is on screen stops being the thing the user recognises. Re-naming on each sketch was offered and declined.

**[B03] With no sketch, the brief's Purpose stands in.** This applies when the `/arc` door opens a cycle of one and no source conversation can be found, as with a brief written by hand ([F05] and the door's own rule that it never composes a sketch from the brief). The rule in [B01] is then applied to the brief's `**Purpose:**` line.

**[B04] A cycle can be renamed by hand, and only by hand.** Stage 2 adds `tugtool cycle rename <id> --name <name>`. It refuses an empty name, keeps the id, and moves `updated`. The skills never call it on their own judgment. When the user asks for a cycle to be renamed, the model runs it with the name the user gave. Stated by the user when settling the rule. A UI for renaming falls under the rollout's deferred controls.

### `/tugplug:brief` writes the entry

**[B05] The brief skill records its conversation's sketch, with no arc.** `tugtool sketch record` gains a form that takes no arc: it reads the sketch text on stdin, mints a fresh id, and prints it, and with `--id <sketch>` it keeps the text as a new version of an existing arc-less sketch. The text has the same shape as the `/arc` door's `sketch.md`, as the arc doctrine gives it under *The record of where the work came from*, `Source:` line included, and the skill reads that section before writing. Chosen by the user over naming from the brief alone, because it keeps [B01] true from the first brief onwards and makes "where it came from" real on the brief path as well as the arc path ([F02]). A sketch is never written into the project's working tree, so it never straggles beside the brief.

**[B06] The brief skill adds to this session's cycle, or starts one.** The cycle it writes to is, in order: a cycle the user named (by its id) in this conversation; otherwise the most recently changed cycle in this checkout that this session created; otherwise a new one. To serve the second case, `tugtool cycle list` gains `--mine`, which filters by the same resolver `create` records with ([F07]). That keeps the session-identity comparison out of the skill. A new cycle is created with sketch A recorded first, named by [B01] from it, and the sketch added as A.

**[B07] Each brief is one entry, with its sketch letters, waits and note.** After the brief is written, the skill runs `tugtool cycle add-entry` with the brief's path, `--from` the letter of the sketch it came from, a `--wait` for each earlier entry whose work must land before this one's, and a `--note` for a gate that is not an entry ("after you approve the spike"). A wait or a note is recorded only when the conversation or the brief states it. One is never inferred from file overlap, since a wait changes whether an entry reads ready. Where the conversation has turned in a new direction since sketch A, the skill records a new arc-less sketch and adds it as the next letter. Otherwise later briefs come from the letters already there.

**[B08] The entry is written before the commit, and the hand-off names it.** The cycle write comes after the brief is written and before `tugtool commit`. The hand-off sentence names the cycle and the entry number ("entry 3 of *Dockets of many briefs*"), next to the path and sha. The cycle record lives in the state directory and is never committed, so the brief's commit still carries the brief alone.

### The `/arc` door attaches its arc

**[B09] A handed-in brief finds its entry by path.** Stage 2 adds `tugtool cycle find --brief <path>`, which prints the cycle id and entry number holding that brief in this checkout and exits 0 with nothing when none does. The door runs it on the handed-in source path ([F05], [F08]), not on the copy under `.tug/arcs/`.

**[B10] The door attaches after the opening, beside the sketch record.** In step 6, after the receipt is confirmed and `sketch record` has run, the door runs `tugtool cycle attach <id> <n> <name>` ([F06]). When the arc is a found entry, the arc's own sketch is not added to the cycle. The cycle's sketches already say where the entry came from, and the arc keeps its sketch through the sketch store's own link.

**[B11] Anything else becomes a cycle of one.** This covers a bare idea, a brief on no cycle, and a brief written before this stage. After `sketch record`, the door creates a cycle named by [B01] from the arc's sketch, or by [B03] when none was recorded. It adds the sketch as A when there is one, adds entry 1 with the handed-in path, or the arc's own `.tug/arcs/<name>/brief.md` when nothing was handed in, `--from A` where there is an A, and attaches entry 1. This is the rollout's [B02], that every arc is on a cycle.

**[B12] A continuation changes nothing.** An existing arc reached by `/arc <name>` is already on its entry. `attach` is idempotent on the link it already holds, so the door does not need to tell the cases apart.

### Both skills

**[B13] Cycle writes are bookkeeping, and never stop the work.** If a `tugtool cycle` or arc-less `sketch record` call refuses, the skill says so in one sentence with the verb's output and carries on: the brief is still committed and handed off, and the arc is still handed to the wheel. A brief or an arc without its cycle line can be put right by hand. A skill that stopped on one would lose the work the user asked for.

**[B14] The skills name only `tugtool` verbs.** The four new verb forms ([B04], [B05], [B06], [B09]) live in `tugtool` and `tugarc-core`, so both skills stay inside the standalone contract. The standalone suite gains a scratch-project pass over them, together with the stage 1 verbs a skill now calls.

---

## Open Questions {#open-questions}

- **Where exactly `arc-start` is written.** [F06] infers that it is during `arc run`. If it turns out to be later (for example, at the first rotation), the attach in [B10] and [B11] moves to that point and the door's ordering is rewritten to match. Settled by one real `arc run` followed by an `attach` during implementation.

---

## Non-goals {#non-goals}

- **Re-naming on each new sketch.** Offered and declined in [B02].
- **Names longer than four words, or with a verb.** Offered as "longer, sentence-like" and declined in favour of [B01].
- **Naming from the arc's name, or leaving it to the model's taste.** Ruled out by the rollout's [B07]. The third worked example exists to show the difference.
- **A rename control, or any cycle control, in the UI.** The rollout defers every door that starts or edits a cycle from a surface. [B04] is a CLI verb only.
- **Inferring waits from the code.** A wait is a statement about the work's order that the user made, not one the model reads off file overlap ([B07]).
- **Tugcast, the deck, and the map.** Stages 3 to 6. Nothing in this stage sends or draws a cycle.
- **Backfilling cycles for arcs and briefs that already exist.** A brief written before this stage gets a cycle of one when an arc opens on it ([B11]). Nothing walks history.

---

## Exit {#exit}

An arc. The order the parts land in follows from what each one reads:

1. **The verbs.** `tugtool cycle rename`, `tugtool cycle find --brief`, `tugtool cycle list --mine`, and the arc-less `tugtool sketch record` (stdin, `--id`), each with unit tests in `tugarc-core` beside stage 1's.
2. **`/tugplug:brief`.** Record sketch A, choose or create the cycle ([B06]), add the entry ([B07]), and name it in the hand-off ([B08]).
3. **The `/arc` door.** Find or create the cycle, then attach after the opening ([B09]–[B12]), confirming [F06] on the first real run.
4. **The standalone pass** over the new verbs ([B14]).
