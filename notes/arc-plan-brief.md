# One word for the work: retire dash and trek, expose only arc

**Purpose:** The arc lexicon (`fa1e96b41`, 2026-09-01) settled the machinery on one unit — the arc — but kept two proper nouns for its kinds, **dash** and **trek**, and exposed both to the user as the doors `/dash` and `/trek`. Seen and tried, three words is two too many. This brief charters the follow-on arc: **arc** is the only term a user meets, the doors become `/arc` and `/arc-plan`, and dash and trek retire totally — from prose, from code identifiers, from the wire, and from git plumbing. It is a naming iteration on the lexicon arc, behavior-preserving throughout.

---

## Purpose {#purpose}

The user's words, from the conversation that settled this (2026-09-02): "Honestly, I think fewer terminology elements are better … choose *arc* as the single main term we expose to users, completely retire *dash* and *trek* as names … Not to mention how the `^` sigil would *finally* make more sense — since the circumflex character is the most *arclike* of any common character on a standard keyboard."

The lexicon arc was right about the unit and right that the two kinds differ only in settling time. What it left was a vocabulary tax: a user who wants to send work down the arc lane has to know that a dash and a trek are both arcs, that `/dash` and `/trek` are the doors but `/arc-join` is the landing, and that the card listing them is the Arcs card. Every surface already says arc except the two words a user actually types. This brief removes the exception.

A first draft of this brief spelled the doors `/arc` and `/arc-short`. The user's second look, on a walk: "My main issue is the double-entendre between *short* and *brief*, and then the lack of clarity when both arcs take a brief and `/arc-short` is the one we qualify." The flaw was the direction of the qualifier. Both doors take a brief; marking one by what it *lacks* lands on a word like short, lite, or mini, each of which either collides with "brief" or smuggles size back in. Marking the door by what it *adds* — the plan — fixes both objections at once.

The settled shape:

- **`/arc`** — takes a brief and works from it. Brief → implement → audit. The bare word is a complete story.
- **`/arc-plan`** — takes a brief, devises a plan, has it cold-reviewed, then works from the plan. Brief → devise → review → implement → audit. The marked door is the one that does something more.
- **`^`** is the arc sigil, and now reads as one: a caret is an arc.

This brief exists so a devise round can plan the rename. Read `tuglaws/work-grammar.md` first and `notes/arc-lexicon-brief.md` second; this arc amends the first and continues the second.

---

## Evidence {#evidence}

**[F01] The kind axis is already a two-valued enum with a serialized spelling.** `ArcKind { Dash, Trek }` in `tugrust/crates/tugarc-core/src/arc.rs:30`, `#[serde(rename_all = "lowercase")]`, with `as_str()`/`parse()` spelling `"dash"`/`"trek"`. The kind is recorded once, at open, as an `arc-kind` note in the arc's log (`append_arc_kind`, `arc.rs:516`), and the runner reads the recorded kind rather than sniffing documents (`tugcast/src/feeds/arc.rs:465` and the tests at `:746`–`:776`). The CLI flag is `tugtool arc run <name> --kind dash|trek`, default `trek` (`tugtool/src/cli.rs:835`). **(verified — read 2026-09-02)**

**[F02] The doors are the only place the kind is chosen.** `tugplug/skills/dash/SKILL.md:119` runs `tugtool arc run <name> --kind dash`; `tugplug/skills/trek/SKILL.md:118` relies on the `trek` default and says so. The four stage skills (`arc-devise`, `arc-review`, `arc-implement`, `arc-audit`) mention the kind names only in prose describing which kind they serve — 3–14 spellings each. `tugplug/.claude-plugin/plugin.json` carries `dash`/`trek` in its description and keywords. **(verified — grepped)**

**[F03] The sigil component is already `ArcSigil`.** `tugdeck/src/components/tugways/arc-sigil.tsx:76`. The doctrine is stale: `tuglaws/arc-lifecycle.md:31` still says "rendered by the single `DashSigil` component". No `DashSigil` symbol exists in `tugdeck/src/`. **(verified — grepped)** The rename the user asked for is therefore a one-line doctrine fix, not a code change.

**[F04] The Session card's slash popup has a hide tier, but it is the wrong tier for the stage skills.** `HIDDEN_SLASH_COMMANDS` (`tugdeck/src/lib/slash-supported.ts`) is consulted both by `filterCommandProvider` (which drops the name from the completion popup — `use-session-card-services.ts:112`) and by the submit path, where a hidden name dispatches a "Command not available" notice and is **never sent to claude** (`tuglaws/slash-commands.md`, the hidden row). The user's ask is different: the stage skills should be absent from the popup but still reach claude if typed exactly. That is a new tier — call it **unlisted** — that affects only the completion provider's filter and nothing in the submit path. Plugin skills reach the popup as `tugplug:<leaf>` and are matched bare by `resolveRemoteCommand` (`slash-supported.ts:29`), so the filter has to recognize both spellings. **(verified — read the filter and the submit chain)**

**[F05] Footprint of the two words, as anchors for the devise round's inventory.** Doctrine: 32 spellings each in `tuglaws/design-decisions.md` and `tuglaws/arc-lifecycle.md`, 15 in `arc-revision-flow.md`, 13 each in `tracking-changes.md`, `arc-work-doctrine.md`, `app-test-harness.md`, 10 in `wheel.md`, 9 in `work-grammar.md`, 7 in `slash-commands.md`, single digits in nine more; `CLAUDE.md` twice (Git Policy line 13, repository table line 36). Plugin: `skills/dash/` (20 + 5), `skills/trek/` (8 + 8). App-tests: nineteen files carry `dash` in their filename (`at0405`–`at0479`); their `@covers` lines are the straggler detector per the lexicon brief's [B10]. **(verified — counted 2026-09-02; counts are anchors, not the inventory)**

**[F06] Not every `dash` spelling in the tree names the kind; two other senses survive from before the lexicon arc and this arc takes both ([B13]).** (a) The **wire and ledger spelling** of the arc lane — `owner_kind: "dash"` and `kind: "dash"` on changeset entries (`tugcast-core/src/types.rs:475`, `:1248`), `DashChangesetEntry` and `entry.kind === "dash"` in `tugdeck/src/components/arcs/arcs-card.tsx:253`, and `changeset_draft("dash", …)` calls in `tugcast/src/server.rs`. (b) The **git-visible plumbing** — the branch prefix is minted in one place, `branch_name` at `tugarc-core/src/ops.rs:401` (`format!("tugdash/{}", name)`); `base_config_key` and `description_config_key` (`ops.rs:919`, `:923`) derive from it, but `tugid_config_key` (`ops.rs:957`) hard-codes `tugdash/` a second time; the owner key is `tugdash/<name>#<tugid>` (`ops.rs:33`) and is opaque, never displayed; the reconciliation sweep at `ops.rs:718` enumerates `tugdash/*` branches; the append-only record is called the dash-log in `tuglaws/arc-lifecycle.md:12`. **(verified — read 2026-09-02)**

**[F07] Exactly one arc is live at the time of writing:** worktree `.tug/worktrees/audit-integrity` on branch `tugdash/audit-integrity`, and one `tugdash/*` branch in total. **(verified — `git worktree list`, `git branch --list 'tugdash/*'`, 2026-09-02)** This is the migration's whole population on this machine, and it makes the migration's shape cheap to test.

**[F08] The previous arc's retired-names table is the record this one extends.** `tuglaws/work-grammar.md` "Retired names" already carries `course`, `planned dash`/`/dash-plan`, `proposal`, `roadmap/`, and `arc (old sense)`. The `/dash-plan` entry matters here: `/arc-plan` rhymes with it, and the table has to say why that is not the old confusion returning (see [B03]). **(verified)**

---

## Decisions {#decisions}

**[B01] Arc is the one term. Dash and trek retire totally — no aliases, no compatibility spellings, no legacy prose.** The user's explicit call, same standard as `course` in the lexicon arc. In prose the two kinds are **an arc** and **a planned arc**; the unmarked kind takes no adjective. The words "dash" and "trek" survive only in git history and in the retired-names table. What would reopen it: the user's say-so.

**[B02] The bare word is the plain arc, and the qualifier names what the other door adds.** `/arc` opens brief → implement → audit; `/arc-plan` opens brief → devise → review → implement → audit. An earlier draft made the bare word the full progression, on the argument that the default gesture should not be "skip the plan." Reversed: the work grammar already says the short kind is not a lesser arc, and a plain arc is a complete story — brief, implement, audit. The plan is the extra provisioning chosen when the decisions are the hard part, and naming the extra is more honest than naming the absence. Which door is bare says nothing about the CLI default ([B04]).

**[B03] `/arc-plan` keeps the rule that "plan" means only the document.** The door is named for the document it produces: an arc *with a plan*. The soup the lexicon arc fixed was "plan" naming a document, a kind, and a door at once, beside "dash" naming three things. With one unit called arc, "a planned arc" is a derivation from the document's name, not a third meaning. The retired-names entry for `/dash-plan` is amended to say so: it went to `/trek`, and `/trek` goes to `/arc-plan`, and the collision that retired the first spelling was in "dash," never in "plan." No name that keeps dash or trek is acceptable ([Non-goals]).

**[B04] The kind axis becomes the presence of a plan: `--plan` on `tugtool arc run`, recorded in the arc's log.** The only difference between the two kinds is whether the arc earns a plan, so a boolean is the honest shape. The devise round chooses between a bare flag (`tugtool arc run <name> --plan`, absent by default) and keeping the enum with new spellings (`ArcKind { Plain, Planned }`, `--kind plain|planned`); the flag is recommended, and whichever is chosen the doctrine says the same words. The CLI default is the plain arc, matching the bare door — the `/arc-plan` skill passes the flag explicitly, exactly as `/dash` passes `--kind dash` today ([F02]), so the door and the flag agree. The log note keeps its `arc-kind` key or gains an `arc-plan` one; `ArcKind::parse` (or its successor) keeps returning `None` for an unknown word, so an arc log written under the old spellings falls back to the document sniff exactly as every pre-kind arc does. Confirm during devise that no live arc at rename time is a plain arc with no task list yet on disk (the one shape the sniff cannot recover; see the test at `tugcast/src/feeds/arc.rs:746`).

**[B05] Door skills: `tugplug/skills/dash/` → `tugplug/skills/arc/`; `tugplug/skills/trek/` → `tugplug/skills/arc-plan/`.** Prose rewritten in the grammar's terms, not search-replaced, per the lexicon brief's [B04]. The `/arc` skill's opening currently defines itself against `/trek` by name; the obvious recast is "`/arc-plan` is `/arc` with a devise and review stage in front of implement," and the devise round should read both skills whole rather than patch the sentences that mention the old words. The stage skills keep their names — `arc-devise`, `arc-review`, `arc-implement`, `arc-audit` are already right — and their prose drops the kind names. `plugin.json` description and keywords follow. Standalone contract applies unchanged: `just tugplug-lint`, `just test-standalone`.

**[B06] The stage skills become unlisted in the Session card's slash popup, and only there.** A new tier beside `hidden` and `pass-through` in `slash-supported.ts`: an **unlisted** set the completion provider filters out and the submit path never consults. Typing `/arc-devise` exactly still reaches claude and still refuses to run outside a wheel-driven arc, as today. The doctrine row goes in `tuglaws/slash-commands.md` next to the hidden row, and the rule for membership is the work grammar's: a stage skill is "not vocabulary anyone speaks." `/arc-join` is a card verb and stays listed, so the popup's arc entries are exactly `/arc`, `/arc-plan`, `/arc-join`. The filter must match the bare leaf and the `tugplug:` qualified form alike ([F04]).

**[B07] `ArcSigil` stays; the doctrine catches up.** `tuglaws/arc-lifecycle.md:31` is corrected to name the component that exists ([F03]). The sigil's rationale gains its missing sentence: a caret is the arc's own shape, which is a better reason to keep it than "unclaimed by any other grammar."

**[B08] User-visible strings follow the word.** The Arcs card's rows say "planned" where they say the kind today and nothing for the plain kind; any "dash lane" or "trek" strings in the Session card, Changes shade, masthead, and entity tips follow. `tuggram`'s command catalog entry for `dash` (`tuggram/data/commands.json:4590`) is renamed with the skill.

**[B09] Doctrine files are rewritten, not search-replaced, and the retired-names table records both words.** `work-grammar.md`'s "The arc" and "The wheel, the doors, the stages" sections are recast around `/arc` and `/arc-plan` — the defining sentence becomes "a planned arc is an arc that earns a plan before a step is walked"; `arc-lifecycle.md`, `arc-work-doctrine.md`, `arc-revision-flow.md`, `wheel.md`, `tracking-changes.md`, `app-test-harness.md`, `slash-commands.md`, `entity-presentation.md`, and the design-decisions entries follow, with their prose updated. `CLAUDE.md` lines 13 and 36 follow. Entries added to Retired names: **dash** → an arc, entered by `/arc`; **trek** → a planned arc, entered by `/arc-plan`; **`tugdash/`** → the `tugarc/` branch prefix ([B13]); and the existing `/dash-plan` entry amended per [B03].

**[B10] Behavior-preserving.** No stage logic, wheel behavior, join semantics, or document format changes ride along. The unlisted tier ([B06]) is the one new behavior, and it is a presentation change to a completion list. The plumbing migration ([B13]) changes spellings that identify things, not what the things do.

**[B11] Verification is the existing gates**, as the lexicon brief's [B10]: `cargo nextest run` under `-D warnings`, `just lint` (including `tugplug-lint`), `just test-standalone`, `just app-test-changed`, and `just app-test-covers-check` as the straggler enumerator for the nineteen `dash`-named app-test files.

**[B12] `notes/` is out of scope**, per the lexicon brief's [B11]; this file and its predecessors keep their vocabulary as historical record.

**[B13] The wire spellings and the git plumbing go in this arc, not a later one.** The user's call (2026-09-02), against the first draft's recommendation to defer the branch prefix. Three parts:

- *Code and wire identifiers* ([F06a]): `DashChangesetEntry` → `ArcChangesetEntry`; the entry-kind literal `"dash"` → `"arc"` on changeset entries, in `changeset_draft("dash", …)`, and in every reader in `tugdeck/`; `append_dash_log` and the name "dash-log" → the **arc log**. The wire literal is a protocol change between tugcast and tugdeck and ships in one step with both sides, as every `tugproto/` change does.
- *Git plumbing* ([F06b]): the branch prefix `tugdash/` → **`tugarc/`**; `branch_name` is the single mint, and `tugid_config_key`'s hard-coded second spelling is folded into it as a casualty. The config keys follow the branch, so `branch.tugarc/<name>.{tugbase,description,tugid}`. The owner key becomes `tugarc/<name>#<tugid>`; it is opaque and never displayed, but it *is* an identity stored in ledgers (draft overlays keyed on `(workspace_key, owner_kind, owner_id)`, `tugcast-core/src/types.rs:512`), so the devise round reads every consumer of the owner key before writing the step.
- *Migration for live arcs*: the reconciliation sweep at `ops.rs:718` already runs at the top of every verb over `tugdash/*`; it is the natural home for a one-shot rename — for each `tugdash/<name>` branch, `git branch -m` to `tugarc/<name>`, copy the three config keys under the new branch section, and rewrite any ledger row keyed on the old owner key. It runs once per checkout, is idempotent, and is exercised against the one live arc on this machine ([F07]). Whether `changes.db` rows need rewriting decides whether `CHANGES_SCHEMA_VERSION` bumps with a registered migration — per `CLAUDE.md`, never a DDL edit alone. The devise round settles that by reading the ledger's owner-key columns.

What would reopen it: nothing short of the migration proving impossible to make idempotent, which the sweep's existing shape makes unlikely.

---

## Open Questions {#open-questions}

- **Flag or enum for the kind** ([B04]). The flag is recommended; the devise round decides after reading every reader of `ArcKind`.
- **Does the owner-key rewrite touch `changes.db`?** ([B13]) If any persisted row carries `tugdash/<name>#<tugid>`, the migration is a schema-versioned one. The devise round reads the ledger's owner-key columns and answers; no user judgment is needed, only the read.

---

## Non-goals {#non-goals}

- **`/arc-short`.** The first draft's spelling. Rejected: "short" and "brief" are a double-entendre, both doors take a brief, and a qualifier that marks an absence is the wrong direction — the plan is what one door adds, so the plan is what the name says.
- **`/arc-mini`, `/arc-lite`, `/arc-quick`.** Rejected with `/arc-short`, and additionally because each names size, and size is a symptom.
- **`/dash-arc` / `/arc-dash` / `/arc-trek`.** Rejected: any spelling that keeps dash or trek keeps three terms, which is the problem.
- **Bare `/arc` as the planned door with a subtractive qualifier for the plain one.** Rejected per [B02].
- **Hiding `arc` behind a "Dashes and Treks" card.** Rejected: the join gesture, the documents directory, the CLI, and the sigil all already say arc. Hiding the word would rename the most surface for the least gain.
- **One door with a flag, `/arc --plan <name>`.** Rejected: the fewest names possible, and the argument hint could advertise the flag, but it hides the routing choice inside argument parsing, puts one picker entry where two discoverable ones serve better, and weakens "which door the user typed is the routing decision." Two skills is the simpler machine, and both already exist. (The *CLI* takes a flag, [B04]; that is a different surface.)
- **A single `/arc` door that decides settling itself and asks the user to confirm.** Rejected: it turns a routing decision made by typing into a question on every arc.
- **Reusing the `hidden` tier for the stage skills.** Rejected: hidden commands are swallowed with a notice and never reach claude ([F04]); the stage skills must stay typeable.
- **Deferring the `tugdash/` branch prefix to a later arc.** The first draft's recommendation; rejected by the user. A rename that leaves the old word in every branch name is not a retirement, and the migration population is one arc ([F07]).
- **Any change to what the stages do, how the wheel rotates, or how a join lands.** This is a rename.

---

## Exit {#exit}

**A plan.** Its natural first steps: (1) the kind axis in `tugarc-core` and `tugtool` — flag or enum per [B04] — with the parse fallback confirmed; (2) the branch prefix, config keys, owner key, and the reconciliation-sweep migration, tested against the live `audit-integrity` arc ([B13]); (3) the wire literal and `ArcChangesetEntry` on both sides of the protocol, with the `changes.db` question answered ([B13]); (4) the door skill directories and prose, then the stage skills' prose and `plugin.json` ([B05]); (5) the unlisted tier in `slash-supported.ts` and its completion-provider filter, with a unit test in `slash-commands.test.ts` ([B06]); (6) tugdeck strings and the Arcs card ([B08]); (7) doctrine, `CLAUDE.md`, and the retired-names table, with the `ArcSigil` correction ([B07], [B09]); (8) app-test renames and `@covers` reconciliation ([B11]). The phase boundary is between (5) and (6): after (5) the machinery, the plumbing, the wire, and the doors speak the new word and nothing user-visible has moved yet; (6)–(8) are the visible half. Step (2) is the one with a real failure mode — a half-migrated checkout — so its step carries the idempotence test and runs before anything depends on the new prefix.
