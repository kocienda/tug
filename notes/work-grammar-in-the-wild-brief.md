<!-- brief-skeleton v1 -->

# The Work Grammar in the Wild

**Purpose:** The words *idea, sketch, brief, plan* are law in `tuglaws/work-grammar.md`, and nothing carries them to a project that is not this one. Tug is an IDE for other people's projects, and on those projects the model has never heard the words. This brief settles how the grammar ships inside the bundle, where a brief lands on any project, and where the brief skeleton lives. **This work changes no behavior.** How briefs are sharpened and written, and how the base checkout and an arc's worktree relate, are exactly as they are today; the work makes the vocabulary and the format reachable, and nothing more.

---

## Purpose {#purpose}

The user's words, from the conversation that settled this: "We need to teach the model about the terminology for *idea, sketch, brief, plan*. Sketches generally *should not* be written to files. When I say *brief*, I mean to use the `@tuglaws/brief-skeleton.md`. When I say *plan*, I mean a document that is produced by the /tugplug:arc-devise skill (which is a feature not directly accessible to the user), but the word *plan* must be understood in the context of arcs." And the constraint: "We must make this terminology work in Tug in a way that this knowledge will apply *when using the Tug app for projects other than directly working on Tug*."

The failure on a foreign project today: the user says "make a plan" and the model writes an ad hoc `plan.md`, or enters Plan mode, because the only documents that say otherwise are ones no foreign project loads. The user says "write a brief" and the model has no format to write against, because the skeleton lives in `tuglaws/`, which the foreign project does not have. The user says "sketch this" and the model reaches for a file.

---

## Evidence {#evidence}

**[F01] The grammar exists and is unreachable.** `tuglaws/work-grammar.md` defines the artifact ladder — idea → sketch → brief → plan — with one defining property per rung: a sketch "lives in the transcript only and is never written to a file"; a brief conforms to `tuglaws/brief-skeleton.md`; a plan is "written by the wheel's devise stage" and "the word *plan* means only the document." Nothing in the bundle carries any of that. **(verified — read from the tree, 2026-09-06)**

**[F02] `tugplug/CLAUDE.md` reaches no one outside this checkout.** The file says so itself: "Nothing loads it in a user's project: Claude Code reads a `CLAUDE.md` from the working tree, and the plugin's own is not one, so it ships as prose nobody outside this checkout will read." The Plan Mode Policy — "DO NOT automatically enter Plan mode" — lives only there, so it is unenforced on every foreign project. **(verified)**

**[F03] Every plugin skill is invisible to the model.** All eight `tugplug/skills/*/SKILL.md` carry `disable-model-invocation: true`, which hides the skill's description from the model as well as barring invocation. On a foreign project the model cannot learn that a brief format exists by reading the skill catalog. **(verified — frontmatter of all eight)**

**[F04] The bundle already has an always-on channel.** `tugcode/src/session.ts` spawns Claude Code with `--append-system-prompt SESSION_SYSTEM_PROMPT_NUDGE`, a short string about not restating tool blocks. It reaches every session Tug spawns on every project, survives compaction, and needs no project setup. It is the only such channel in the product today. `tugcode` already resolves the plugin directory for `--plugin-dir` (`session.ts:122`), so a file beside the plugin is one `readFileSync` away at spawn. **(verified — `session.ts:122`, `:910`, `:975`)**

**[F05] The absence clauses are the current answer, and they are a downgrade.** `arc`, `arc-plan`, and `arc-devise` each say some form of "when the project has no `tuglaws/brief-skeleton.md`, write the six beats and say the format document is missing; do not reconstruct it from memory." `scripts/tugplug-lint.ts` enforces that every `tuglaws/` link carries such a clause. The brief format is therefore degraded by design on every project but this one. **(verified — `arc/SKILL.md:27,79`, `arc-plan/SKILL.md:28`, `arc-devise/SKILL.md:66`)**

**[F06] The plugin's hook surface is one script and the standalone test pins it.** `tugplug/hooks/hooks.json` routes `PreToolUse` for Skill, Bash, and the edit tools at `pre-tool-use.sh`, which pipes to `tugtool hook pre-tool-use`. `tugplug/__tests__/standalone.test.ts` asserts that `hooks/` contains exactly `hooks.json` and `pre-tool-use.sh`. `tugtool hook` knows one event. Nothing in tugcode or tugdeck handles `SessionStart` hook output. **(verified)**

**[F07] The PreToolUse hook auto-approves every `tugplug:` skill.** `PLUGIN_SKILL_PREFIX = "tugplug:"` in `tugrust/crates/tugtool/src/commands/hook.rs`. A model-invocable skill in the plugin runs without a permission prompt. **(verified)**

**[F08] `notes/` is chartered inert, and the charter is prose.** `work-grammar.md`: "no tool reads it, no tool writes it, no skill resolves paths into it by convention, and nothing in `tugrust/` or `tugplug/` may ever mention it." The charter is the lesson of the old `roadmap/` directory. It is enforced by nothing but the sentence; `tugplug-lint` has no rule for it. The directory holds forty-odd briefs, sketches, and audits. Every brief in it was written in the main-lane session, in the base checkout, by an ordinary `Write` to a path the user named; every arc so far was handed its brief from there by explicit path. No brief has ever been written from inside an arc's seated session. **(verified — the charter is read from the tree; the writing history is read from the arc log and the git log)**

**[F09] App-wide settings are tugbank, and tugbank is Rust.** The deck persists the theme, keyboard access, focus-ring modality, and the **default project directory** through `/api/defaults/<domain>/<key>` (`tugdeck/src/settings-api.ts`), which tugcast backs with `tugbank-core` — a per-instance SQLite store at `<Application Support>/Tug/instances/<id>/tugbank.db`. The default project directory is `dev.tugapp.app` / `default-project-path` (`settings-api.ts:428`), edited in the Settings card's **General** section (`settings-general-body.tsx`) as a labelled `TugFileChooser` row with a caption. `tugbank-core` is depended on by `tugcast` and by the `tugbank` CLI, which is a `defaults`-like reader (`tugbank read <domain> <key>`, with the instance resolved from `TUG_INSTANCE_ID`). `tugtool` does not depend on it today. An earlier draft of this brief said "no Rust reads user defaults"; that was wrong — the store is Rust end to end, and the only gap is that `tugtool` has not been wired to it. **(verified — `settings-api.ts`, `settings-general-body.tsx`, `tugbank/src/main.rs`, the three `Cargo.toml` files that name `tugbank-core`)**

**[F10] An arc's brief already has an address.** `tugtool arc documents <name> --ensure` resolves `.tug/arcs/<name>/brief.md`, gitignored, and both doors' Orient stage already handles "this arc already has a brief." **(verified)**

**[F11] There is a "plan" collision with Claude Code's own vocabulary.** Claude Code has Plan mode, `EnterPlanMode`, and a `Plan` agent type. On a foreign project with no policy loaded, "make a plan" is as likely to reach those as to reach `/arc-plan`. **(verified for the harness surface; the likelihood is inference)**

**[F12] `tugplug-lint` already lints every `.md` under `tugplug/`.** The walk in `scripts/tugplug-lint.ts` takes `.md`, `.sh`, and `.json`, so a markdown file at the plugin's root is covered by the existing rules with no lint change. **(verified)**

---

## Decisions {#decisions}

**[B01] The grammar ships as markdown in the plugin, appended to the system prompt by tugcode at spawn.** A file at the plugin's root — `tugplug/grammar.md` or a name the devise round picks — states the four rungs in the project-agnostic voice: an idea is the user's prompt and has no form; a sketch is the converged shape of a conversation and lives in the transcript only, never in a file; a brief is the first document, written against the skeleton the plugin ships, and the user asks for one by saying "brief"; a plan is the document a planned arc's devise stage writes from a brief. The model never authors a plan on its own and never enters Plan mode; the user gets a plan by typing `/arc-plan`. `tugcode` reads the file beside the plugin directory it already resolves ([F04]) and passes it as a second `--append-system-prompt` alongside the existing nudge. The user's call, 2026-09-06: "make this markdown I think. An extra file read is no big deal." Why the file rather than a string: the vocabulary is then lintable by `tugplug-lint` ([F12]) and editable without rebuilding tugcode. A missing file is a bundle defect, not a runtime condition: tugcode logs it and spawns with the existing nudge alone, so a session is never refused over prose.

**[B02] The Plan Mode Policy moves from `tugplug/CLAUDE.md` into the grammar file.** It is unenforced where it sits ([F02]). `tugplug/CLAUDE.md` keeps a sentence saying where the policy went.

**[B03] A `brief` skill joins the plugin, and it is the plugin's first model-invocable skill.** `tugplug/skills/brief/` carries `SKILL.md` without `disable-model-invocation`, so the model can reach it when the user says "brief" in prose ([F03]), and the hook auto-approves it ([F07]). **The skill changes nothing about how a brief comes to be.** Today a brief is written after the conversation has settled the sketch, by the user's own model, against the skeleton, to a path — and that is what the skill does: it reads the skeleton beside it, writes the conversation's settled findings and decisions in the six beats, and ends. It does no sharpening of its own, opens no dialog beyond the one in [B07], writes no plan and no task list, and opens no arc. The user's call: "We *are not* changing how briefs work. This is about making this terminology more widely-applicable."

**[B04] The brief skeleton's home is the plugin.** `tugplug/skills/brief/brief-skeleton.md` is the one copy. `tuglaws/brief-skeleton.md` becomes a short document that says the format lives in the plugin and links there, with no duplicated content. The user's call: "plugin. link to it in `tuglaws/` in a document which makes a short mention but contains no extra/duplicated content." Consequence: the absence clauses about the brief format in `arc`, `arc-plan`, and `arc-devise` ([F05]) come out, because the format is never absent again. The clauses about `arc-work-doctrine.md` and the devise skeleton stay; those are still `tuglaws/`-only. The skeleton's own comment prose must stop naming `tuglaws/devise-skeleton.md` as a sibling path that exists, since on a foreign project it does not; it names the devise stage instead.

**[B05] `notes/` is renamed `briefs/`, and its inertness charter is revised, not kept.** The user's call: "change the name of our `notes/` directory in the top level of our repo and name it *briefs*. That's where they should go." The charter said no tool may write it and no skill may resolve paths into it ([F08]); the new skill does exactly that. The revision: **the briefs directory is a setting, and the `brief` skill is the one writer, writing only briefs.** No tool reads the directory, nothing indexes it, nothing resolves any other document kind into it, and disposition after landing stays the user's exercise. The `roadmap/` lesson was machinery entangling itself with a document directory; one skill writing one document kind to a user-set path is the narrowest entanglement that makes the directory usable at all, and the setting is what keeps the path the user's rather than the tool's. `work-grammar.md`'s "Where documents live" and its Retired names section are rewritten to say so.

**[B06] The briefs directory is an app-wide setting, defaulting to `<project_dir>/briefs`.** The user's call. It is a tugbank key in the `dev.tugapp.app` domain beside `default-project-path` ([F09]), holding a template resolved per project, so one setting serves every project the app opens. It is edited in the Settings card's **General** section as a second row under the default project directory — the same labelled file-chooser-and-caption shape, titled along the lines of *Briefs Directory*, whose caption says where a brief is written when the user asks for one and that an unset value means `briefs/` inside the project. The user's call: "We should provide a new setting in *General*." App-wide means what it means for the theme: per instance, and a value set in one instance does not reach another.

**[B07] `tugtool` reads the setting through `tugbank-core`, and the skill reads `tugtool`.** `tugtool` gains a dependency on `tugbank-core` and a verb — `tugtool brief dir` or a name the devise round picks — that resolves the instance from `TUG_INSTANCE_ID` exactly as the `tugbank` CLI does ([F09]), reads the key, resolves the template against the project directory, and prints the path; an unset key resolves to `<project_dir>/briefs` in the binary, so the default is one place. The read is read-only and goes through the sanctioned open in `tugcore::ledger_db`. The skill never computes the path itself. The user's call: "Give Rust the ability to read the default, eh?" — and the finding that it already can ([F09]).

**[B08] The first time the directory is needed, the skill asks once.** When the resolved directory does not exist, the skill raises one `AskUserQuestion` confirming the path before creating it; a directory that exists is never asked about. The ask is gated on absence, which makes it one-time per project by construction rather than by a remembered flag. The user's call: "The first time this directory is needed to write a brief, we should ask for confirmation." This is the skill's only dialog ([B03]).

**[B09] The project directory is whatever it is today — no worktree-aware resolution is added.** A brief is written where a `Write` to `notes/<name>.md` writes today: relative to the session's project directory, in the main-lane session, on the base checkout ([F08]). The `brief` skill and the `tugtool` verb resolve `<project_dir>` the same way every other `tugtool` verb resolves the project it is run in, and add no rule of their own for arcs. Briefs are not written from inside seated arc sessions today, and this work does not start writing them there. The user's call: "We should do whatever we do now for `notes/`. … We *must not regress this* and create issues between the main project_dir and an arc's worktree."

**[B10] An explicit path wins.** `/tugplug:brief <path>` or a path in the prose writes there and consults no setting. A brief meant for a named arc may be written to `tugtool arc documents <name> --ensure`'s brief address ([F10]) when the user says so; that is not the default.

**[B11] No hook.** A `SessionStart` hook would keep the vocabulary plugin-side, but nothing in the product handles injected hook context ([F06]), and [B01] gets the plugin-side markdown without one. A `UserPromptSubmit` hook watching for the words would be polling the transcript. What would revisit it: tugcode learning to handle hook context for some other reason.

**[B12] No `sketch` skill.** A sketch's defining property is that it is not a file. A skill would be a tool for producing nothing.

**[B13] The guards grow with the surface.** `tugplug-lint` refuses `tuglaws/` links in the shipped skeleton and the grammar file, and the skeleton file is exempt from the absence-clause rule because it is the thing the rule stood in for. `test-standalone` drives the new `tugtool` verb from the scratch project with no instance and no setting and asserts the `<project_dir>/briefs` default. A `tugcode` test asserts the grammar file is appended at spawn and that its absence degrades to the existing nudge. The plugin version bumps. The Tug `CLAUDE.md` gains one line pointing at `tuglaws/work-grammar.md`, which it does not cite today.

---

## Open Questions {#open-questions}

- **Names.** The tugbank key, the `tugtool` verb, the grammar file's filename, and the settings row's title and caption. All mechanical; the devise round picks them against the neighbours they sit beside (`default-project-path`, `tugtool arc documents`, the General section's existing row).

- **How the template is spelled.** The setting holds `<project_dir>/briefs` as a template, and the devise round decides the placeholder's spelling by reading how `Surface` in `tugtool-core/src/config.rs` spells `{paths}`, so the product has one placeholder grammar rather than two.

---

## Non-goals {#non-goals}

- **Any change to how briefs are sharpened or written.** Sharpening is the conversation, as now. The skill is the format and the destination, nothing else ([B03]).
- **Any change to how the base checkout and an arc's worktree relate.** No new root resolution, no new rule for seated sessions ([B09]).
- **Renaming any file inside `notes/`.** The directory renames; its contents keep their names. `*-brief.md` suffixes inside a `briefs/` directory are redundant, and that is a separate, optional tidy.
- **Linting briefs.** The skeleton's own comment says the omission is a decision. Moving the file does not earn it a checker.
- **A plugin-side `CLAUDE.md` that foreign projects load.** Claude Code has no such mechanism for plugins; [B01] is the channel that exists.
- **Teaching the model Tug's other doctrine on foreign projects.** The arc-work doctrine, the review rubric, and the devise skeleton stay `tuglaws/`-only with their absence clauses intact. This brief is about four words and one format.
- **Making `/arc-plan` write to `briefs/`.** The doors write to the arc's document home ([F10]) and that stays. A brief in `briefs/` is handed to a door by path, as today.
- **A per-project override in `.tugtool/config.toml`.** The setting is app-wide by the user's call; a per-project spelling can be added later without disturbing this one.

---

## Exit {#exit}

**A plan.** The user runs `/arc-plan` against this brief. A sensible phase shape for the devise round to consider: (1) the skeleton move and the `tuglaws/` pointer, with the absence-clause edits in the three skills and the lint changes, behind `tugplug-lint` and `test-standalone`; (2) the `briefs/` rename, the `work-grammar.md` rewrite, and the `CLAUDE.md` pointer; (3) the setting — the tugbank key, the General row, the `tugtool` verb over `tugbank-core` — behind `cargo nextest`, the standalone test, and `app-test-changed`; (4) the grammar file, the tugcode spawn read, the Plan Mode Policy move, and the `brief` skill, behind `tugplug-lint` and the tugcode test. Every phase is behavior-preserving for briefs and arcs; the audit stage should read the diff against that sentence first.
