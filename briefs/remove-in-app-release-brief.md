# Remove the in-app release flow, keep `/push`

**Purpose:** The one-command, finish-it-in-the-window release flow that landed as `068522c16` was the wrong call: it put a release's checklist, dispatch and run-watch inside the product, in a fourth shade, behind three CONTROL verbs and a config table, to save typing seven commands. The user wants all of it gone from the app and from the skills, with `/push` the one survivor.

---

## Purpose {#purpose}

The user, after cutting 0.8.11 through the new flow: *"I hate the way that the in-app release work turned out. This was a wrong call on my part to add this complexity to the app itself. We should completely revert and remove the work on `/release-tug`, `/write-release-notes`, and `/release`. Remove all these from the app UI and skills completely. We should keep the `/push` verb, but we'll need to work on that afterwards to make it better."*

Its replacement is a command-line script, decided in the sibling brief `briefs/release-script-brief.md`. This brief is only the excision.

---

## Evidence {#evidence}

**[F01] The flow is one arc commit, and `/push` is interleaved through it** — `068522c16` (tugarc `release-tug`) touches 43 files. The `changeset_push` verb, its receipt block, the `ahead` consumers and at0616 landed in the same commit, in the same files as the release verbs (`agent_supervisor.rs`, `changeset.rs`, `session-card.tsx`, `slash-commands.ts`, `shell_ledger.rs`). A `git revert` would take `/push` with it. **(verified)** by reading the commit's stat and its Justfile, `main.tsx` and `shade-view-controller.ts` hunks.

**[F02] The push half has one later commit of its own** — `1afa822c1` (push-receipt) moves the ahead count into the header badge and adds Push to the commit receipt's header. It touches nothing release-shaped. **(verified)**

**[F03] The removal surface, deck** — `session-release/session-release-view.{tsx,css}`, `lib/release-store.ts` and its test, `attachReleaseStore` in `main.tsx`, the fourth `ShadeView` value and `NamedShadeView` in `shade-view-controller.ts`, the `/release` entry in `slash-commands.ts`, the Release shade wiring in `session-card.tsx` and `session-card.css`, the `session-changes/session-changes-notes-editor.{tsx,css}` editor mode with its release-notes row predicate in `tug-changes-list.tsx` and its hook in `session-changes-view.tsx`, the automatic-save mode added to `text-card.tsx` for it, and the optional `release` field on the changeset aggregate in `changeset-types.ts` with its parser test. **(verified)** by grep over `tugdeck/src` and the commit's file list.

**[F04] The removal surface, server** — `tugcast/src/feeds/release.rs` (1003 lines, whole file), the `release_check` / `release_dispatch` / `release_watch` CONTROL arms and `parse_release_payload`, `resolve_release_config` and `send_release_err` in `agent_supervisor.rs`, `ReleaseSurface` in `tugcast-core/src/types.rs` and its compose in `changeset_all.rs` with the test `a_declared_release_reaches_the_aggregate_and_absence_composes_none`, and `ReleaseConfig` with its `release` field on the tugtool table in `tugtool-core/src/config.rs`. **(verified)**

**[F05] The removal surface, skills, config and doctrine** — `.claude/skills/release-tug/` and `.claude/skills/write-release-notes/`; the `[tugtool.release]` table in `.tugtool/config.toml` and the comment on the `project` surface naming both skills; **D199** in `tuglaws/design-decisions.md`; the "Shipping is the fourth act" and "The run watch is the one poll" paragraphs in `tuglaws/tracking-changes.md`; the `/write-release-notes` mention in `release-notes/README.md`; app-tests at0617 (notes editor) and at0618 (release sheet). `write-release-notes` predates the arc (`78b33a265`) and goes because the script's one-shot callout replaces it. **(verified)**

**[F06] `file-read-error-copy.ts` was extracted for the notes editor but is not release-shaped** — it moved the Text card's `describeReadError` into its own module so two surfaces could share it, with a documented reason for the separate module (a `mock.module` leak on `file-io.ts`). With the notes editor gone it has one caller again. **(verified)** from the commit's hunk.

**[F07] The Justfile changes in the arc are of two kinds** — `bless` moved from `git ls-remote` to `gh api`, which distinguishes an absent tag from an unreachable origin where the old spelling reported both as blessed. `release --yes` was added only so the card's no-TTY shell could get past the confirmation prompt. **(verified)** from the Justfile hunk.

**[F08] One deck test uses the skill name as fixture data only** — `session-metadata-store.test.ts` lists `write-release-notes` in a commands array to exercise catalog union. It asserts nothing about the skill. **(verified)**

**[F09] The update pill and update wizard are a different feature** — `update-tug` (`3ecab8acd`, `8ee616c10`) is Sparkle's update surface, showing which Tug version is running. It shares the word and nothing else. **(verified)**

---

## Decisions {#decisions}

**[B01] Excise by hand; do not `git revert 068522c16`.** [F01] means a revert takes `/push` with it and then has to be partially re-applied. The arc is a subtraction of every surface named in [F03]–[F05] and nothing else. `1afa822c1` [F02] is left exactly as it is.

**[B02] `/push` survives untouched, including its receipt and the ahead badge.** The user has said it stays and that it will be reworked afterwards. This arc changes none of its bytes, so the rework starts from what is on `main` today rather than from something this arc half-adjusted.

**[B03] The notes editor mode in the Changes shade goes with the rest.** It existed so that the release's notes could be edited without leaving the window. With the window out of the release, a `release-notes/*.md` row is an ordinary changed file again. The `text-card.tsx` automatic-save hook it needed is removed with it unless something else has come to depend on it, which the arc should check rather than assume. `file-read-error-copy.ts` [F06] stays where it is: the extraction's reason was a mocking hazard, not the editor, and moving it back buys nothing.

**[B04] `bless` keeps the `gh api` spelling; `release --yes` goes.** [F07]. The three-outcome tag check is strictly better than the two-outcome one and is what the script in the sibling brief will call. `--yes` existed for a shell that no longer runs the recipe. Whether the `release` recipe itself survives or becomes a call into the script is the sibling brief's decision; this arc leaves it as it stands minus `--yes`.

**[B05] `[tugtool.release]` and `ReleaseConfig` are removed, not deprecated.** There are no installs in the wild and no other project declares the table. A config parser that accepts a table nothing reads is a lie in the schema. The `project` surface comment in `.tugtool/config.toml` that names the two skills is rewritten to say what `.claude/` holds once they are gone.

**[B06] The doctrine is cut, not annotated.** D199 is deleted from `design-decisions.md` and the two tracking-changes paragraphs [F05] are deleted; "The push is offered where the number means something" stays because it is about `/push`. A law that describes a surface that no longer exists is worse than a gap in the numbering. `briefs/release-tug-brief.md` stays as a working paper with a two-line postscript dated 2026-09-24 saying the built thing was removed and pointing at this brief and the script brief.

**[B07] Both skills are deleted, and `release-notes/README.md` points at the script instead.** `/write-release-notes` is not kept as a standalone door because the script's callout is the one place the notes doctrine will live [sibling brief]; two copies of the "reader" section would drift, which is the exact hazard the old skill's "read, not invoked" rule existed to avoid. The fixture string in [F08] can stay; it is just a name.

**[B08] The removal is verified by the same checks the arc's surfaces declare, plus a grep.** Every surface touched (`rust`, `deck`, `app-tests`, `prose`, `project`) has its check in `.tugtool/config.toml`. A final `grep -rn` for `release_check`, `release_dispatch`, `ReleaseSurface`, `ReleaseConfig`, `release-store`, `session-release`, `notes-editor`, `release-tug` and `write-release-notes` over the tree outside `briefs/` and `release-notes/` must come back empty. At0616 must stay green, since it is the one app-test that proves [B02].

---

## Non-goals {#non-goals}

- **Reworking `/push`.** The user has named it as later work. This arc is the one place it is guaranteed not to move.
- **Touching the update pill or wizard.** [F09].
- **Rewriting `bless`, `version-bump` or `release-notes` recipes.** They are the building blocks the script brief composes. Only `--yes` leaves.
- **Building the replacement.** That is `briefs/release-script-brief.md`, and it can land before or after this one; the two share no files except `release-notes/README.md` and the Justfile's `release` recipe.

---

## Exit {#exit}

An arc. The natural order is server first so the deck's type errors point at what to delete: `ReleaseConfig` and the config table, then `ReleaseSurface` and its compose, then `release.rs` and the supervisor arms; then the deck's store, shade, slash command and view slot; then the notes editor mode and the Text card hook; then the skills, the two app-tests, the laws and the README; then the grep in [B08] and the surface checks. Each of those is a checkpoint that compiles on its own.
