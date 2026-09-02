# The arc lexicon — rename the dash machinery to the work grammar

**Purpose:** The vocabulary around dashes grew by accretion until "dash" and "plan" each named three things and "arc" and "course" named the same thing. The settled lexicon now exists as doctrine in `tuglaws/work-grammar.md`; this brief charters the campaign that brings the tree's spellings to it. The campaign is a rename — behavior-preserving throughout.

---

## Purpose {#purpose}

The user's words, from the conversation that settled this: "We have arrived at this confusing mix of: dash, plan, wheel, arc, course, direct, chart[ed]. Honestly, this is a complete mess, and combining these names produces a soup of confusion in my mind."

The diagnosis was collision, not count: **dash** named the work unit, one of the two course kinds (`--course dash`), and the door skill; **plan** named the document, the other course kind, and the other door — and the plan course's distinguishing feature is a document called a plan, so the word could not disambiguate even from context. **arc** and **course** named the same thing, mid-rename.

The settled lexicon, now law in `tuglaws/work-grammar.md`: an **arc** is the work unit that leaves `main` on a worktree and returns through a join; a **dash** is a short arc (brief → implement → audit); a **trek** is a long arc (brief → devise → review → implement → audit); **plan** means only the document; **course** is retired totally — the user's call: "no confusing or lingering legacies." The landing gesture becomes `/arc-join` — also the user's explicit call, over plain `/join`.

This brief exists so a devise round can plan the rename. Read `tuglaws/work-grammar.md` first; it is the authority this campaign converges on, and its closing section ("Spellings in transition") is deleted as this campaign's last act.

---

## Evidence {#evidence}

**[F01] The variant axis is spelled `--course dash|plan` on `tugtool dash run`.** `tugrust/crates/tugtool/src/cli.rs:835`–`:844` — "Which progression the course runs — `plan` (devise → review …)". The `DashCommands` enum is at `cli.rs:606` and carries the verb family: `create` (with `--carry`, `--base`), `commit`, `join` (with `--strategy`, `--preview`, `--continue`, `--resolve`), `run`, `step`, and more — enumerate the full set during devise. **(verified — read from the tree, 2026-09-02)**

**[F02] The arc→course rename from the course retrofit is only partly landed, so the codebase currently speaks both.** `TUG_DASH_COURSE` is live and the four stage skills read it, each noting "a bundle older than the rename set `TUG_DASH_ARC` instead and both are written today, so read either" (`tugplug/skills/dash-devise/SKILL.md:93`, `dash-review/SKILL.md:29`, `dash-implement/SKILL.md:46`, `dash-audit/SKILL.md:31`). Meanwhile `ArcStage`, `dash_arc_runner`, and `TUG_DASH_ARC` spellings persist across `tugrust/crates/tugdash-core/src/arc.rs`, `tugcast/src/feeds/dash_arc.rs`, `tugcast/src/wheel/mod.rs`, `tugcast/src/dash_api.rs`, and others; `course` spellings exist in `tugcast/src/wheel/mod.rs`, `tugtool/src/dash_course.rs`, `tugtool/src/commands/hook.rs`, `tugtool/tests/turn_boundary_cli.rs`. This campaign supersedes and absorbs the unfinished one — do not finish arc→course and then undo it. **(verified — grepped 2026-09-02)**

**[F03] The dash spelling's footprint.** The crate is `tugrust/crates/tugdash-core`. `.tug/dashes` appears in 31 files across `tugrust/`, `tugplug/`, `tuglaws/`, `tugdeck/src/`, and `CLAUDE.md`. The landing gesture `/dash-join` and its spelling appear across `tugdeck/src/` (`components/tugways/dash-join-register.tsx` and `.css`, `commit-presentation.tsx`, `cards/session-landing-progress-row.tsx`, `cards/gallery-dash-lifecycle.tsx`, `main.tsx`, more), plus `CLAUDE.md` and `tuglaws/`. There is a user-visible `tugdeck/src/components/dashes/dashes-card.tsx`. **(verified — grepped 2026-09-02; counts are anchors, not an inventory — the devise round builds the real one)**

**[F04] The plugin's skill surface.** Doors: `tugplug/skills/dash/` and `tugplug/skills/dash-plan/`. Stages: `dash-devise/`, `dash-review/`, `dash-implement/`, `dash-audit/` — per the course retrofit these already refuse to run outside a wheel-driven run and are internal machinery, not doors. Unaffected siblings: `draft/`, `tripwire/`, and the rest. The standalone contract applies: everything the plugin needs must live in the bundle, and `just tugplug-lint` plus `just test-standalone` guard its shapes. **(verified — read from the tree)**

**[F05] The doctrine surface speaking the old lexicon.** `tuglaws/dash-lifecycle.md`, `dash-work-doctrine.md`, `dash-review-rubric.md`, `dash-revision-flow.md`, `wheel.md`, plus `CLAUDE.md` (Git Policy exceptions, repository table, app-test selection prose) and `tuglaws/brief-skeleton.md`/`devise-skeleton.md` comment prose where it mentions dashes. `tuglaws/work-grammar.md` is already written in the new lexicon. **(verified — listed from the tree)**

**[F06] `.tug/dashes/<name>/` is never tracked and its contents are transient per-arc documents** (brief, plan, ledger, logs), so a directory rename carries no git-history cost. Live in-flight arcs at rename time are the only migration concern. **(verified for the untracked claim; the in-flight concern is inference — confirm during devise by reading the runner's path resolution)**

---

## Decisions {#decisions}

**[B01] The lexicon in `tuglaws/work-grammar.md` is the authority; on any conflict, it wins.** An **arc** is the work unit; a **dash** is a short arc, a **trek** is a long arc; **plan** means only the document. Settled with the user 2026-09-02. What would reopen it: nothing short of the user's say-so.

**[B02] "course" is retired totally — no compatibility spellings, no lingering legacies in prose or code.** The user's explicit call. The variant axis is the **kind** (`dash` | `trek`); the stage sequence gets no proper noun. `--course dash|plan` becomes `--kind dash|trek`; `dash_course.rs` and every `course` identifier are renamed or dissolved. Old spellings remain findable only in git history and in `work-grammar.md`'s Retired names section.

**[B03] The landing gesture is `/arc-join`.** The user's explicit call, chosen over plain `/join`. Every `dash-join` spelling in `tugdeck/`, `tuglaws/`, and `CLAUDE.md` follows.

**[B04] Doors rename: `/dash` stays; `/dash-plan` becomes `/trek`.** The door skills' prose is rewritten in the grammar's terms (kind, arc, settling), not merely search-replaced — sentences like "the dash course of a dash" must come out as casualties of the fix, not survive it reworded.

**[B05] Stage skills rename `dash-*` → `arc-*`** (`arc-devise`, `arc-review`, `arc-implement`, `arc-audit`): they are stages of an arc of either kind, and a trek's stages running under skills named `dash-*` is the exact category error this campaign exists to fix. They remain internal machinery, not doors.

**[B06] Machinery renames follow the unit:** crate `tugdash-core` → `tugarc-core`; `tugtool dash` → `tugtool arc`; `.tug/dashes/` → `.tug/arcs/`; `TUG_DASH_COURSE`/`TUG_DASH_ARC` → `TUG_ARC` (the value stays the arc's name); modules `dash_api.rs`, `dash_arc.rs`, `dash_arc_runner.rs`, `dash_course.rs` to arc-terms spellings the devise round chooses. The unfinished arc→course rename ([F02]) is absorbed: its `course` spellings are casualties like the rest.

**[B07] User-visible surfaces follow the lexicon:** the Dashes card (`tugdeck/src/components/dashes/dashes-card.tsx`) becomes the Arcs card, listing arcs of both kinds; any dash-lane strings in the Session card and Changes shade follow. The lexicon is not an internal convention wearing a public alias.

**[B08] The `tuglaws/dash-*.md` doctrine files are retitled and rewritten to the grammar** (e.g. `arc-lifecycle.md`, `arc-work-doctrine.md`), with their prose updated, not search-replaced. Per the retirement doctrine the old spellings stay findable — `work-grammar.md`'s Retired names section is that record.

**[B09] The campaign is behavior-preserving.** No stage logic, wheel behavior, join semantics, compaction threshold, or document format changes ride along. Any behavioral itch discovered en route is written down as a note, not scratched here.

**[B10] Verification is the existing gates:** `cargo nextest run` under `-D warnings`, `just lint` (including `tugplug-lint`), `just test-standalone`, and `just app-test-changed` — noting that `@covers` declarations referencing renamed paths must be updated or `just app-test-covers-check` fails, which is a feature: it enumerates stragglers.

**[B11] `notes/` and its contents are out of scope for renaming** — the directory is inert by charter, and existing notes are historical records that keep their old vocabulary as a matter of course.

---

## Open Questions {#open-questions}

- **What compatibility window, if any, does `TUG_ARC` need for in-flight runs?** A bundle created before the rename sets the old variables; a run resumed across the rename must still bind. Settle by reading how the runner and stage skills resolve the variable today ([F02]) and whether any run can outlive a rebuild. If none can, cut clean with no window — [B02]'s spirit.
- **What happens to a live `.tug/dashes/<name>/` worktree at rename time?** Probably: the campaign itself runs as an arc, so at least one is live by construction. Settle by reading the runner's path resolution; candidates are a one-time move at first touch or resolving both paths for one release, preferring whichever leaves no permanent fallback.
- **Do any ledger schemas, recorded course kinds ([F02]'s durable course record), or `apptest_results.db` keys carry the old spellings durably?** If a recorded kind spells `plan`, the rename needs a registered migration under the shared-ledger regime, never a DDL edit — check `CHANGES_SCHEMA_VERSION` doctrine in `CLAUDE.md`.

---

## Non-goals {#non-goals}

- **Renaming `dash` away entirely.** Considered and rejected: dash survives as the short kind's name, unmarked-default style. The category got the new name instead.
- **`trip` as the unit name, and renaming tripwire to "hooks."** Rejected: "trip" is a homograph with *stumble* and collides with the tripwire facility; "hooks" collides head-on with Claude Code hooks, which `tugplug/` ships and documents. Tripwire keeps its name and is untouched by this campaign.
- **`chart`/`charted` as the marked kind.** Rejected: it added a fourth near-synonym to the plan/devise/course cluster.
- **`epic` or any size-axis name.** Rejected: the axis between the kinds is settling time, not size.
- **Automating `notes/` disposition.** The user's call: it remains a human exercise.
- **Any behavior change.** See [B09].

---

## Exit {#exit}

**A plan.** The user runs the settling door against this brief; the devise stage plans the campaign. A sensible phase shape for the plan to consider: (1) the Rust surface — crate, CLI verbs, env var, modules, `.tug/arcs/` — behind green `cargo nextest`; (2) the plugin — doors and stage skills — behind `tugplug-lint` and `test-standalone`; (3) `tugdeck` — landing gesture, Arcs card, strings — behind `app-test-changed`; (4) the prose — `tuglaws/` retitles, `CLAUDE.md` — closing with the deletion of `work-grammar.md`'s "Spellings in transition" section. The open questions above are the devise round's first reads.
