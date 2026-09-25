# A release is a script that asks before every command

**Purpose:** With the in-app release flow removed, cutting a Tug release goes back to a chain of commands typed in a terminal in an order one person remembers. Replace the chain with one command-line script that knows the order, shows each command, asks `y/N`, runs it, and can be rerun from wherever it stopped. The only AI in it is a single one-shot call that drafts the release notes.

---

## Purpose {#purpose}

The user, deciding the shape after rejecting the in-app flow: *"Instead, once we do this in-app release flow removal, I want to build a python script (maybe with some `gh` and `expect` in it if needed) that I can run from the command line. We should retain a one-shot callout to the AI to write the release notes."*

On whether the script commits and pushes: *"Since my intention would be to change to a command-line interface running in the terminal, I see no reason why I couldn't just run the commands myself, or better yet, have the `scripts/release.py` prompt me for the commands to run with a `y/N` confirmation interface. In this case, `/commit` and `/push` play no role in releasing. `/commit` and `/push` stay for other purposes."*

On the editor step: *"No. That goes, too. The commit message is something I would rarely want to edit by hand, so the script could show me the message in the terminal and offer the opportunity to open it with the env's `EDIT_OPENER` program if I wanted to tune it."*

The removal itself is `briefs/remove-in-app-release-brief.md`.

---

## Evidence {#evidence}

**[F01] The chain, as it existed before the in-app flow** — `just version-bump patch` → `/write-release-notes` → `just release-notes` to edit → `git add` and `git commit` → `git push` → `just bless` → `just release`. Seven steps, recorded in `briefs/release-tug-brief.md` from five walks of it (0.8.6 through 0.8.10). **(verified)** from that brief.

**[F02] The building blocks already exist and stay** — `tugrust/scripts/version.sh show|set|bump` rewrites `tugrust/Cargo.toml`, `Cargo.lock`, both `package.json` files and `tugapp/Info.plist`, and seeds `release-notes/<version>.md` with a heading and a comment ending `Delete this comment`. `just bless` is a read-only checklist whose verdict is its exit code, with a three-outcome tag check through `gh api`. `just release` does bless → confirm → `gh workflow run release.yml --ref main` → find the new run id by comparing against the newest run before dispatch → `scripts/watch-release-run.sh <run id>`. `.github/workflows/release.yml` is `workflow_dispatch` only and rejects an already-published version itself. **(verified)** by reading the Justfile, `version.sh` and the workflow.

**[F03] The notes doctrine is a page of prose** — the "The reader" section of the old `write-release-notes` skill: written for someone who does not read the repository, what they can now do and what stopped being annoying, no paths, crate names, arc names, citations or shas, plain markdown, short, ten lines is a lot. Its range rule: the newest `v*` tag on origin to `HEAD`, read as `git log --format='%s%n%b'`, with the join bodies on `main` usually already holding the reader-facing sentence. **(verified)** from the skill file, which the removal deletes.

**[F04] The old skill's best idea was the state probe** — before writing anything it asked origin whether `v<version>` exists, then whether the notes file is still the seed, and did only the step that was missing. That is what let an abandoned bump or a release already in flight be resumed. **(verified)** from `.claude/skills/release-tug/SKILL.md`.

**[F05] Nothing in the flow needs `expect`** — every interactive moment is the script's own `y/N` on an inherited terminal. `claude -p` is non-interactive. `gh workflow run` and `gh api` do not prompt once `gh auth status` is green. `git push` over the user's configured credentials does not prompt on this machine. **(verified)** for `claude -p` and `gh`; the push claim is the user's own experience and is inference here.

**[F06] Tools on the machine** — `python3` 3.14 at `/opt/homebrew/bin/python3`, `gh` at `/opt/homebrew/bin/gh`, `claude` 2.1.276 at `~/.local/bin/claude`, `EDIT_OPENER=bbedit` exported from `~/.zshrc`. **(verified)**

**[F07] The user's release commit message shape** — `tugarc(0.8.11): A release about motion and legibility`, with a body summarising the notes. The subject is the version and the notes' first line. **(verified)** from `0abae9534`.

---

## Decisions {#decisions}

**[B01] One file, `scripts/release.py`, standard library only, run as `just release [major|minor|patch] [--force] [emphasis words…]`.** The Justfile's `release` recipe becomes a one-line exec of the script so the entry point stays where the other release recipes are. `version-bump`, `release-notes` and `bless` stay as they are and are what the script calls. No third-party Python: the machine has Homebrew Python and nothing else is promised.

**[B02] The script runs nothing that changes state without showing the exact command and asking `y/N`, default N.** This is the interface the user asked for, and it is what makes `/commit` and `/push` irrelevant to releasing: the script is a checklist that runs its own rows. Read-only probes (`version.sh show`, `gh api` for the tag, `git status`, `just bless`) run without asking, since asking about a read teaches the habit of answering `y` without reading. Declining a row ends the run, and the run is resumable ([B03]), so `N` is never a dead end.

**[B03] Every step is idempotent and the script begins with the state probe from [F04].** Read the version; ask origin whether `v<version>` is tagged; read whether the notes file exists and is still the seed; read whether the tree is clean and whether `HEAD` equals `origin/main`. From those four facts the script knows which step is next and skips the ones already done. A run interrupted at any `N` or any failure is continued by running the same command again. Both `bless` and `release.yml` already refuse a published version, so a rerun after shipping refuses rather than bumping again unless a component is named.

**[B04] The notes draft is one `claude -p` call with no tools, and the script writes the file.** The doctrine [F03] lives in `scripts/release-notes-prompt.md` beside the script, not inlined in Python, so the voice can be tuned without touching code. The script appends the version, the emphasis words from the command line, and the `git log` of the range (newest `v*` tag on origin to `HEAD`), pipes it to `claude -p --output-format text` with a named model, and writes stdout under the `# Tug <version>` heading. The model never touches the tree. A model that returns nothing, or a range that is empty, is reported and the run stops rather than seeding plausible prose. Written notes are never overwritten: the draft step runs only while the file is still the seed.

**[B05] No editor step. The script prints the notes and the commit message and offers `EDIT_OPENER`.** After the draft it prints the notes file to the terminal, then asks one question: continue, or open the file with `$EDIT_OPENER` first. Opening does not block; the script says it will reread the file at the commit step and waits for `y` to go on. The commit message [F07] is shown the same way before the commit row: subject `tugarc(<version>): <first line of the notes>`, body the notes' prose. `EDIT_OPENER` unset falls back to printing only.

**[B06] The commit stages exactly the bump's files and the notes, by path.** The six files `version.sh` rewrites plus `release-notes/<version>.md`, named explicitly on `git add`, so other work in the tree is never swept in. Then `git push origin main`. Both are `y/N` rows.

**[B07] Bless gates dispatch by exit code; `--force` is the only way past it.** Same as the old recipe: `just bless` runs, its output is shown, a non-zero exit ends the run unless `--force` was given, in which case the script says so out loud and continues. Dispatch is `gh workflow run release.yml --ref main` behind its own `y/N` naming the version, the run id is found the way the old recipe found it, and the watch is handed to `scripts/watch-release-run.sh`, which already exists and already says how long things take.

**[B08] Preflight refuses early and names what is wrong.** Not on `main`; `gh auth status` failing; `claude` not on `PATH`; a dirty tree whose dirt is not the bump's own files. Each is one line and exit 1 before anything is asked.

**[B09] The script is Tug's alone and lives in `scripts/`.** It knows `version.sh`, `release-notes/`, `release.yml` and this repo's origin. None of that exists in a project Tug.app is merely opened on, so nothing here is plugin material, and the `project` surface in `.tugtool/config.toml` already claims `scripts/`.

---

## Open Questions {#open-questions}

- **Which model the callout names.** `claude -p` takes `--model`; the draft is a summarising task and a fast model is likely enough, but the choice is a taste call the user makes once. The arc should pick one, put it in one constant at the top of the script, and say which in the hand-off.

---

## Non-goals {#non-goals}

- **`expect`.** [F05]. Nothing prompts through a pipe, so there is nothing to drive.
- **Any surface in the app.** No verb, no shade, no CONTROL frame, no config table. The script reads the same Justfile recipes a person would.
- **An interactive AI session.** The callout is one prompt in, one document out. The script never runs a tool-using agent and never lets the model write a file.
- **Editing the notes inside the script.** The user rarely edits by hand; `EDIT_OPENER` covers the rare case without the script owning a terminal editor.
- **Replacing `bless` or `watch-release-run.sh`.** They are composed, not rewritten.
- **A local build or signing path.** The release stays CI's, as the Justfile already says.

---

## Exit {#exit}

An arc. First the prompt file, recovered from the doctrine in [F03] before the removal arc deletes the skill. Then the script's skeleton: preflight, the state probe, and the `y/N` row primitive, with a dry run that prints every row and runs none. Then the steps in walking order: bump, draft, show-and-offer, commit, push, bless, dispatch, watch. Then the Justfile `release` recipe pointed at it, `release-notes/README.md` rewritten to name the script, and a real run cutting the next patch release as the proof.
