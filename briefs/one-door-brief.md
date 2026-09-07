# One door: collapse `/arc-plan` into `/arc`

**Purpose:** The arc lane has two doors, `/arc` and `/arc-plan`, and the user has to remember which is which to open one. They should have to remember one name.

---

## Purpose {#purpose}

The user's words: "I don't like the way we have *two doors* into the *arc* feature set. We need to figure out how to collapse `/arc-plan` into `/arc`, so that the user only needs to remember one slash command." And, on the earlier brief that chose two doors: "I don't care. My experience with arcs tells me that it's wrong to persist in two different types of *doors* into this feature set."

The two doors differ by settling time and by nothing else. One writes a brief and a task list and opens the arc at implement; the other writes a brief alone and opens it at devise. That is one bit of information, and today it costs the user a second command name and a routing decision made at the keyboard before any conversation has happened. The user's estimate is that a quarter or fewer of their ideas warrant the planned shape, so the second door is the uncommon case wearing a name as prominent as the common one.

---

## Evidence {#evidence}

**[F01] The two door skills are the same door with one bit flipped.** `tugplug/skills/arc/SKILL.md` and `tugplug/skills/arc-plan/SKILL.md` both orient, sharpen, write a brief, run `tugtool arc run`, and end the turn. `/arc` also writes `tasks.md` and passes no flag; `/arc-plan` writes no task list and passes `--plan`. Each carries a "size it" step whose only product is a sentence offering the *other* door. Both say, in the same words, that "which door they typed is the routing decision." **(verified)**

**[F02] The flag is the whole kind axis, and it is recorded once.** `run_arc_run` in `tugrust/crates/tugtool/src/arc.rs` maps `--plan` to `ArcKind::Planned` and everything else to `ArcKind::Plain`, then `open_arc` in `tugarc-core/src/ops.rs` writes one `arc-kind` line to the arc log after `arc-start`. Nothing else in the CLI reads the flag. **(verified)**

**[F03] The wheel already knows how to read the kind off the documents.** The opening chooser in `tugrust/crates/tugcast/src/feeds/arc.rs` (around line 575) reads the recorded kind to pick the first stage, and for a *pre-kind* arc falls back to the documents: a plan opens at review, a task list at implement, a brief alone at devise. Its own comment says the fallback "skews toward more settling" and never skips a cold read. `ledger_file` in `ops.rs` already discriminates plain from planned by which documents exist, calling that "the whole of the discrimination." **(verified)**

**[F04] Everything downstream of the opening is identical.** Both skills, `tuglaws/work-grammar.md`, and `tugplug/CLAUDE.md` state it, and the runner confirms it: after the opening stage, the stage sequence, the compaction, the audit, and the join offer read only the arc record and the documents, never the door. **(verified)**

**[F05] The second door's name is load-bearing in a bounded set of places.** Outside the plugin: `ARC_DOOR_PREFIXES` in `tugcast/src/feeds/agent_supervisor.rs` (four spellings, used by `arc_door_target` to bind the Session card early on a lone-name invocation); the slash-support tests under `tugdeck/src/__tests__/` and `tugdeck/src/lib/__tests__/`; three app-tests that name `/arc-plan` in comments only (`at0504`, `at0513`, `at0524`); `tugplug/.claude-plugin/plugin.json`; `tugplug/CLAUDE.md`; the project `CLAUDE.md` (lines 13 and 36); the brief skeleton's own comment; and the laws `work-grammar.md`, `arc-work-doctrine.md`, `arc-lifecycle.md`, `slash-commands.md`, and `design-decisions.md`. No Rust or TypeScript code path branches on the spelling other than the supervisor's prefix list. **(verified by grep; the `tuggram/data/commands.json` catalog was not checked and should be)**

**[F06] The earlier brief rejected this shape, on premises this brief replaces.** `briefs/arc-plan-brief.md` Non-goals rejected "one door with a flag" because a flag hides routing in argument parsing, and rejected "a single door that decides settling itself and asks the user to confirm" because it "turns a routing decision made by typing into a question on every arc." **(verified)** Both rejections assume the door must carry the bit in its *invocation*. This brief carries it in the door's *product* and asks only on genuine ambiguity, which the user expects to be uncommon.

---

## Decisions {#decisions}

**[B01] There is one door, `/arc`, and `/arc-plan` retires totally.** The user's explicit call, made against the earlier brief's reasoning and overriding it. No alias, no compatibility skill, no notice, no legacy prose: the `tugplug/skills/arc-plan/` directory is deleted and the spelling survives only in git history and in the work grammar's retired-names table. Typed afterwards, `/arc-plan` is an unknown command like any other. What would reopen it: the user's say-so.

**[B02] The door's argument grammar is `/arc [name] [instruction…]`, and every part is optional.** The user's requirement: "the `<name>` must be optional. The `<instruction>` may be a path to a brief." The shapes the door must read, in order of precedence:

- **A path** anywhere in the arguments that resolves to a readable markdown file is a **handed-in brief**, used as-is (the work grammar already says so: "One handed in with the invocation is used as-is"). The door copies or references it as the arc's `brief.md` at `.tug/arcs/<name>/`, sharpens nothing that the brief already settles, and settles only the name and the kind.
- **A lone first token that names an existing arc** is a continuation, exactly as both skills say today.
- **A first token that is slug-shaped (hyphenated, alphanumeric, 2+ chars) and is not a path** is the arc's name, and the rest is the instruction.
- **Anything else** is the idea in prose, and the door settles the name in conversation, as `/arc-plan` does today. A single plain word followed by prose is prose, not a name: `/arc make the ring pulse` opens on an idea. The door states the name it chose in the sentence it says at hand-off, so a name the user meant and the door missed is corrected in one reply.
- **Bare `/arc`** with nothing in flight asks what to work on; with a stopped or resumable arc in flight, names it and offers to continue, as `/arc-plan`'s Orient does today.

The supervisor's `arc_door_target` stays deliberately narrow (a lone well-formed name binds early; prose never does) and shrinks to two spellings.

**[B03] The kind is the door's one decision, made from the user's prose and the model's own reading, and confirmed by dialog only when they do not settle it.** The user's guidance: "the model obviously needs an opinion on this. If there is any ambiguity, then the skill should raise an inline dialog to interact with the user and confirm the choice. I expect (and hope) this will be uncommon." So:

- **Prose drives.** "Plan this", "devise a plan", "just go", "no plan" in the invocation or the conversation decide it outright.
- **The model weighs in.** With prose silent, the door writes a task list when it can write one it would stand behind, and writes the brief alone when the decisions are not settled or their order is itself a problem. This is the judgment the "size it" step already makes today; it stops handing the answer back as a command to retype.
- **Ambiguity asks once.** When the model's reading and the prose disagree, or the model has no reading it would stand behind, one `AskUserQuestion` with two options: write the task list now and open at implement, or write the brief alone and let the wheel devise and review a plan first. Two options, no third, never re-asked. The user's estimate that a quarter or fewer of arcs want the plan is the calibration: the plain shape is the expected answer, and a door that asks on most arcs has the threshold wrong.
- **The door says which shape it chose** in its hand-off sentence, every time, so the choice is visible on the card and in the transcript rather than remembered.

This retires the "which door they typed is the routing decision" sentence everywhere it appears; the routing decision is what the door writes.

**[B04] `--plan` leaves `tugtool arc run`, and the kind is derived from the documents at open.** The user's call: "No `--plan`. This is an *AI experience*, not a TUI/CLI experience." `open_arc` computes the kind from what the arc has: a `tasks.md` beside the brief is a plain arc; a brief alone, or a `plan.md`, is a planned arc. It records the kind exactly as today (the `arc-kind` line stays, `ArcKind` stays, the Arcs card's "planned" label stays, the runner's chooser reads the recorded kind as it does now). The pre-kind fallback in the chooser is unchanged for old logs and becomes, in effect, the rule at open. The one shape the old sniff could not recover, a plain arc with no task list on disk, cannot exist: the door writes the task list before it runs the arc, and an arc opened without one is planned. The install base is zero, so the flag is removed rather than kept as a dead override; a flag nobody passes is a second source of truth for the kind.

**[B05] The `arc` skill is rewritten whole, not merged by paragraph.** Per the lexicon brief's standard for prose. It takes `/arc-plan`'s richer Orient (finding existing briefs and plans, offering to resume, reading a stopped arc's record), `/arc`'s task-list authoring, the brief writing both share, the argument grammar of [B02], and the kind decision of [B03]. Both "size it" steps and both "when to reach for something else" sections go; the only referral that survives is to the spike card for something the user mostly wants to look at. The stage skills keep their names and their "runs only under an arc" rule; `arc-audit`'s sentence naming the two doors is recast to one. The plugin's `plugin.json` description and keywords, `tugplug/CLAUDE.md`, and the brief skeleton's comment follow. Standalone contract unchanged: `just tugplug-lint`, `just test-standalone`.

**[B06] Doctrine is rewritten to one door, and the retired-names table records `/arc-plan`.** `work-grammar.md`'s "The wheel, the doors, the stages" section becomes one door; the two kinds of arc and the defining sentence "a planned arc is an arc that earns a plan before a step is walked" stay, because the kind still exists and is still recorded, only its selection moved. `arc-work-doctrine.md` lines 5 and 114, `arc-lifecycle.md`, `slash-commands.md` ("the doors stay listed" becomes "the door"), and the project `CLAUDE.md` follow. A design-decisions entry records the reversal and cites the arc-plan brief's rejected option and the user's reason. Retired names gains: **`/arc-plan`** — the second door; now the one door `/arc`, which decides the kind from the conversation.

**[B07] Behavior-preserving downstream of the opening.** No stage logic, wheel rotation, compaction, audit, join, or document format changes ride along. The one behavioral change is where the kind is decided and how the door reads its arguments.

**[B08] Verification is the existing gates**: `cargo nextest run` under `-D warnings`, `just lint` including `tugplug-lint`, `just test-standalone`, `just app-test-changed`, and `just app-test-covers-check`. The deck's slash-support unit tests and the supervisor's door-prefix tests are updated to two spellings.

**[B09] `briefs/` is out of scope**, per the earlier briefs; existing documents keep their vocabulary as record.

---

## Open Questions {#open-questions}

- **How a handed-in brief becomes the arc's brief.** Copy into `.tug/arcs/<name>/brief.md`, or record the outside path as the arc's document? `open_arc` today looks only at the arc's own directory, and the stage divider shows the document path. The devise round reads `open_arc` and `arc documents` and chooses; copying is simpler and keeps the arc self-contained, and is recommended.
- **The `tuggram` command catalog.** [F05] did not check `tuggram/data/commands.json`; the earlier brief renamed an entry there. The devise round greps it.

---

## Non-goals {#non-goals}

- **A flag or sub-verb on the door** (`/arc --plan`, `/arc plan <name>`). Rejected: the kind is decided from the conversation, not typed; a flag is the second door's bit in a new spelling, and the `/arc` skill's "there are no sub-verbs" rule stands.
- **Asking on every arc.** Rejected: the dialog is for ambiguity only. A door that asks routinely has moved the second door into a question.
- **Keeping `--plan` as a CLI override the skill never passes.** Rejected per [B04].
- **Removing the kind.** The plain and planned arcs remain two kinds, recorded and shown. Only the door that chose between them is collapsing.
- **Any change to what the stages do, how the wheel rotates, or how a join lands.**

---

## Exit {#exit}

**A plan.** The first steps: remove `--plan` and derive the kind in `open_arc` with tests for each document shape; shrink `ARC_DOOR_PREFIXES` and its tests; rewrite the `arc` skill whole and delete `arc-plan`; then the plugin metadata, the deck's slash-support tests, the app-test comments, and the laws. The phase boundary is between the machinery (CLI, runner, supervisor, deck) and the prose (skill, laws, `CLAUDE.md`), so the prose is written against a tree where the machinery already behaves as the prose says.
