<!-- brief-skeleton v1 -->

# Release Tug: one typed command, then the window

**Postscript, 2026-09-24:** what this brief describes was built and then removed — the user judged the in-app release flow the wrong call, and everything named below except `/push` is gone from the app, the server and the skills. See `briefs/remove-in-app-release-brief.md` for the excision and `briefs/release-script-brief.md` for the command-line script that replaces it.

**Purpose:** Cutting a release is seven manual steps chained across the terminal, the editor and the Session card, and they are the same seven every time. Fold the mechanical ones into a single project skill, `/release-tug`, and give the acts that are the user's — land, push, edit the notes, ship — surfaces inside the window, so the terminal is never compulsory.

---

## Purpose {#purpose}

The ask, verbatim: *"There are way too many manual operations I need to chain together, and they're almost all the same every time I release. We have a proper Changes experience, which is the big difference. The changes agent should compose proper release notes automatically using the `/write-release-notes` skill. I want a skill that is published only in the Tug project. Call it `/release-tug`. Bundle up all the necessary work so that this is the only thing I need to type, and after that, I'm using in-app interfaces to do the rest of the work. I do not want to be compelled to drop to the terminal anymore. I understand that I need to push to the remote repo. But this is something you can facilitate in the app as well."*

The chain as walked five times in one session, for 0.8.6 through 0.8.10: `just version-bump patch` → `/write-release-notes` → an editor session on `release-notes/<version>.md` → commit → push → `just bless` → `just release` → `y` at its prompt → watch. Every step but the notes edit is the same keystrokes every time; the notes edit is the one that needs a person, and it is the one with the worst tool today.

The release-ergonomics arc (`briefs/release-ergonomics-brief.md`) built the `just` surface this brief folds up. It was the right first layer: it made the pipeline findable and gave it a gate. What it could not do from the Justfile is make any of it a gesture in the window.

---

## Evidence {#evidence}

**[F01] Tug has no push, anywhere.** The landing lifecycle is Preflight → Draft → Land ([D116]) and ends at the commit receipt. No code in `tugrust/crates/tugcast`, `tugrust/crates/tugtool-core`, `tugrust/crates/tugchanges-core` or `tugdeck/src` runs `git push`, and nothing computes whether `HEAD` is ahead of its upstream; the only occurrences of the string are a facts-library fixture and the shell grammar data. `just bless` treats "HEAD is pushed and equals origin/main" as a precondition someone else met, and its FAIL line says "push before releasing" without saying where. **(verified)**

**[F02] `just release` cannot run inside the Session card's shell.** The block shell (`tugrust/crates/tugcast/src/feeds/shell.rs`, [D111]) runs every command wrapped `</dev/null` with no controlling TTY, so the recipe's `read -r REPLY` at its `[y/N]` prompt reads end of file and the recipe prints "Not dispatched." and exits 1. The watcher it then calls, `scripts/watch-release-run.sh`, drives a live elapsed counter with `\r`, which has no meaning in settled-whole output. This is the structural reason the terminal has been compulsory rather than merely habitual. **(verified)** by reading both; not run, since running it would dispatch a release.

**[F03] A skill cannot invoke `/write-release-notes`.** Its frontmatter carries `disable-model-invocation: true`, as every project and plugin skill here does, so the Skill tool refuses it from another skill. The doctrine it carries — who the reader is, how the range is found, what is written — is markdown any skill can `Read` as a document. **(verified)**

**[F04] The version bump writes five tracked files and seeds a sixth.** `tugrust/scripts/version.sh bump <component>` edits `tugrust/Cargo.toml`, `tugcode/package.json`, `tugdeck/package.json`, `tugapp/Info.plist` (two keys, in place) and `tugrust/Cargo.lock` (via `cargo update --workspace --offline`), and creates `release-notes/<version>.md` with a known seed comment, never overwriting one that exists. Nothing in the script records the change against a session; a bump run from a bare `Bash` call lands unattributed, and the landing draft's default selection would not include it. `tugtool file run -- <command>` exists for exactly this: it fingerprints the tree around a command that names no files and receipts what moved. **(verified)**

**[F05] `bless` is already a checklist of independent rows.** The recipe accumulates `FAIL`/`ok`/`note` lines rather than stopping at the first, prints them all, then a summary block. That is a table waiting for a surface. Two of its remote reads go through `git ls-remote`, and both report a false `ok` when origin is unreachable: an empty tag list is indistinguishable from "no such tag". The `gh api` spelling is already what the notes skill uses to find the newest tag when SSH is unavailable. **(verified)**

**[F06] The step timings a release wants are already extracted.** `scripts/watch-release-run.sh` polls `gh run view --json status,conclusion,jobs` and prints a duration per completed step, a live counter on the in-flight step, and the failing step's log on failure. Measured on run `35927571530`: the DMG step is 5m 54s of a 7m 39s run, most of it `notarytool` waiting on Apple. There is no push channel for run status; asking is the only instrument. **(verified)**

**[F07] The deck already has a read-write file editor.** `TugTextCardEditor` (`tugdeck/src/components/tugways/tug-text-card-editor.tsx`) is the third CodeMirror primitive: a file-editing surface bound to a `TextCardStore` autosave engine through the `TextCardBridge` contract, with external-change reverts arriving as minimal transactions that hold caret and scroll. tugcast has a file-write path (`tugrust/crates/tugcast/src/fs_write.rs`). The Changes shade (`tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx`) hosts a `TugMessageEditor` for the draft message and a `TugChangesList` whose rows expand into diffs; it has no mount that edits a file's content. **(verified)**

**[F08] Project-scoped skills live at `.claude/skills/`.** `write-release-notes` and `spike-card` are there, checked in, and appear in the Session card's catalog for this project only; `just tugplug-lint` and the standalone contract do not reach them. **(verified)**

**[F09] A `[tugtool.<section>]` table is how this checkout tells the product about itself.** `.tugtool/config.toml` carries `build = "just app-debug"` and the per-surface `check` commands the arc engine runs. The pattern is that the product knows a verb and the checkout fills in what the verb runs. **(verified)**

---

## Decisions {#decisions}

**[B01] One skill does everything mechanical; four gestures carry everything that is the user's.** `/release-tug [major|minor|patch] [emphasis…]`, patch by default, does the bump, writes the notes, and authors the landing draft, then stops. Land, push, edit the notes, and ship are gestures in the window: `/commit` as today, `/push` (new), the notes editor in the Changes shade (new), and `/release` (new). Nothing after the skill is typed into a shell.

**[B02] The skill lives at `.claude/skills/release-tug/` and is Tug's alone.** It reads `tugrust/scripts/version.sh`, `release-notes/` and this repository's remote; none of that exists in a project Tug.app is opened on, so it is not plugin material and never will be [F08]. `disable-model-invocation: true`, `disallowed-tools: Task`, like its neighbours.

**[B03] The bump runs through `tugtool file run`.** `tugtool file run -- tugrust/scripts/version.sh bump <component>` receipts the five edited files and the seeded sixth [F04], so the landing draft's default selection is exactly the release and the Changes shade shows six attributed rows, no `--include` needed. The bump stays in the script; the skill only wraps it [F04]. Moving the bump into a tugcast-side surface was considered and set aside in conversation: it would make the notes draft a server-side model call rather than this card's, a larger design for no gain in gesture count.

**[B04] The skill is re-entrant on the version state.** If the current version has a `v<version>` tag on origin, the release shipped and the skill bumps. If the current version's notes are still the seed, a bump happened and was abandoned, so it writes the notes and does not bump again. If the notes are written and untagged, the release is in flight; the skill says so and does nothing. The tag check uses `gh api`, never `git ls-remote` [F05].

**[B05] The notes doctrine is read, not invoked.** The skill reads `.claude/skills/write-release-notes/SKILL.md` as a document and follows its reader and range sections [F03]. `/write-release-notes` stays as the standalone door for notes alone; the two share one text so they cannot drift. The skill honours the same guardrails: never overwrite written notes, never invent a change for an empty range.

**[B06] The skill ends by writing the landing draft and naming the gestures.** `tugtool draft set --owner session --message …` in the subject style the last five bumps used, `tugarc(<version>): …`, over the six receipted files. It never commits. Its last lines say: review in the Changes shade, edit the notes there if you like, `/commit`, `/push`, `/release`.

**[B07] `/push` is a prompt-entry verb backed by a tugcast RPC, and the commit receipt offers it.** tugcast runs `git push` through `tugcore::git_command()` in the project directory and returns a receipt the transcript renders as non-context ink, like a landing. The changeset feed grows an ahead/behind pair from `git rev-list --left-right --count HEAD...@{u}`, read-only and fetch-free, so the receipt and the Changes shade can show "2 ahead" and offer the push exactly when it means something. Landing stays the user's act ([D116]); push is a second act, never bundled into `/commit`.

**[B08] The release notes are editable as text in the Changes shade.** The user asked for this in so many words. The shade already knows the notes file is in the landing; its row grows an editor mode that mounts `TugTextCardEditor` over the file through a `TextCardStore` [F07], the same substrate the text card uses, so autosave, undo and external-change reverts come for free. The edit is a working-tree edit like any other: the row's diff updates, the file stays attributed to the session that seeded it, and `/commit` lands what the editor saved. The shade does not become a general file editor; the mode is offered on a row whose path is under `release-notes/`, and that scoping is the whole of the product knowing anything about releases at this layer.

**[B09] `/release` opens a sheet in the Changes shade's family, driven by configuration the checkout supplies.** The product cannot know what Tug's release is, so it knows a verb and reads `[tugtool.release]` in `.tugtool/config.toml` [F09]: a `check` command whose output lines become rows, a `dispatch` command, and the workflow name to watch. This checkout fills in `just bless`, `gh workflow run release.yml --ref main`, and `release.yml`; a project with no table never sees the verb. The sheet runs `check`, shows the rows [F05], enables Dispatch only when every row is `ok` (with a confirmed override, the shade's Regenerate pattern, standing in for `--force`), then watches the run as step rows with durations [F06], and shows the failed step's log on red.

**[B10] The run watch polls, and the brief says so.** GitHub offers no push channel for run status [F06]; asking every few seconds with the horizon of run completion is the only instrument. The user accepted this explicitly as an internal feature. It is the one poll in the product with a reason written beside it, and it is not a licence for another.

**[B11] `just release` grows `--yes`, and `bless` moves its remote reads to `gh api`.** `--yes` skips the prompt so the recipe runs non-interactively in the card's shell [F02] and under the sheet's `dispatch` [B09]; the watcher already reprints every thirty seconds when not on a tty. Both remote checks in `bless` take the `gh api` spelling so an unreachable origin is a `FAIL`, not an `ok` [F05]. These are the recipe-level fixes that make the Justfile honest as the thing the sheet runs.

**[B12] Two stages, and the first alone removes the terminal.** Stage A is the skill, `/push`, the notes editor mode, and `--yes`: type `/release-tug`, review and edit in the shade, `/commit`, `/push`, then `just release --yes` in the card's own shell. Stage B is the `/release` sheet, after which nothing is typed into a shell. The split is a landing order, not two arcs: every Stage B piece depends on a Stage A piece and none the other way.

---

## Open Questions {#open-questions}

- **Which credential the push rides from a GUI process.** tugcast is launched by Tug.app, not a login shell. macOS launchd does hand GUI apps an `SSH_AUTH_SOCK`, and the `gh` credential helper works over HTTPS regardless, but this checkout's remote is SSH and the shell this session ran in had no key. The first thing the `/push` step does is push once from a debug tugcast and read the receipt; the answer decides whether the RPC needs an environment fix or nothing.

---

## Non-goals {#non-goals}

- **A local release path.** [B05] of the release-ergonomics brief stands: CI is the one implementation of signing, notarizing and appcast generation. The sheet dispatches it and watches it.
- **Changing `release.yml`, `build-app.sh` or `make-appcast.sh`.** The pipeline is correct. The only workflow-side change contemplated anywhere here is none.
- **Moving the bump into the product.** Considered in conversation and set aside [B03].
- **A general file editor in the Changes shade.** The editor mode is offered on notes rows only [B08]. Editing arbitrary changed files in the shade is a different feature with a different argument.
- **Bundling push into `/commit`.** A landing and a push are two acts with two receipts; a combined gesture would make the local-only commit unreachable [B07].
- **Putting anything Tug-specific in `tugplug/`.** The skill is project-scoped [B02]; the sheet learns Tug's release from `.tugtool/config.toml` [B09]. `just tugplug-lint` is not in question.
- **A second poll anywhere.** [B10] is a reasoned exception, not a precedent.

---

## Exit {#exit}

**An arc.** Its shape follows the landing order in [B12]:

1. `bless` remote reads to `gh api`, and `--yes` on `just release`. Small, independent, and the thing every later step's test can lean on.
2. The `/release-tug` skill at `.claude/skills/release-tug/`, with its re-entry rules and its hand-off lines. Confirmed by running it on a fresh patch bump and reading the Changes shade.
3. Ahead/behind in the changeset feed, the `/push` verb and RPC, and the receipt affordance. Confirmed by one real push from a debug tugcast, which also settles the open question.
4. The notes editor mode on the shade's `release-notes/` row over `TugTextCardEditor`. Confirmed by editing a seeded notes file in the shade, landing it, and reading the commit.
5. `[tugtool.release]` in config, the `/release` sheet, its check rows, dispatch, and the polled step rows. Confirmed with a real dry-run release, which is what 0.8.10 exists for.
