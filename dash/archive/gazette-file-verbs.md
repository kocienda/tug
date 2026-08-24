## Gazette File Verbs: the Operator Reads the Source {#gazette-file-verbs}

**Purpose:** Give the Gazette Operator the ability to open, navigate, and quote the project's own source files, make a failed lookup say so instead of reporting a clean miss, and carry the asker's `@`-atom pointing gesture all the way from the composer into the retrieval turn — so that "show me where X is in this file" is answered from the file's actual content.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main (via a dash worktree) |
| Last updated | 2026-08-16 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-16, opus.** Reviewed `plan:6c1888c01b5a0033`. Lint: 0 errors, 0 warnings (clean before and after).
Oriented on: the whole document — a first pass on a never-reviewed plan, authored in the same turn.
Applied, in descending severity. **[P03] would have broken every directory and glob scope:** the decision and Spec S04 treated "several candidates" as an error uniformly, but a literal pathspec matching many files is the *normal* case — measured on this repository, `git ls-files -- 'tuglaws/'` returns 37 paths and `-- '*.md'` returns 502, so `repo.grep` scoped to a directory would have started refusing work it does today. Multiplicity is now explicitly not ambiguity: a literal match is exact at any count, ambiguity is a repair-stage concept only, and its handling is per-verb — `repo.read`/`repo.outline` error (a read has one target) while `repo.grep` searches all repair candidates and names them, because grep is multi-file by construction. **A cross-plan label collision would have misled a cold reader four times:** the document used `[P06]` to mean the *boost* plan's per-verb-logging decision in four places while this plan's own `[P06]` is question refs; all four now name the log line by what it is (`gazette operator verb …`, written by `log_verb`). **[#step-8] rested on an unproven gesture and would have grown machinery beside machinery that ships:** no existing app-test drives the `@` completion popup (`at0205` makes its atom by dropping an image, and the `@` source is async), and the proposed new `at0371` would have launched a second serialized Tug.app to reach a surface `at0365-gazette-card.test.ts` already holds — it types into this composer, submits, and observes the resulting user post today. The step now extends at0365, opens by settling drivability against `at0051`'s precedent, and names a real fallback (insert the atom through the editor's own delegate — still the production editor and atom, never a mock). **Two checkpoints were not falsifiable:** [#step-2]'s said an `operator-ask` run "is not needed here" and gestured at a test instead, and [#step-3]'s asked for ad-hoc proof pasted into a commit body; both are now commands, and the real-document proof moved to [#step-5]'s replay deliberately — a unit test reading the live `design-decisions.md` would break the day someone edits it, which is why [#step-3]'s tests run against a fixture reproducing the shape. **Step 1's fixture was hand-waved** ("`%design-decisions.md`-shaped against the fixture"); it now names a concrete committed `docs/design-notes.md` containing `zone`, so the incident's exact shape has a real target, and gains a directory-scope test pinning the [P03] correction. Added the mandatory **law cross-check** as its own section — [L02]/[L06]/[L26] honored by adding nothing, [L11]/[L27] not engaged, and [L23] engaged-and-satisfied with the reason stated: dropping an unverifiable ref is safe *only* because the atom already flattened into the body text, and would become a violation if refs ever became the path's sole carrier. Also recorded three findings the plan had not costed: resolution adds one `git ls-files` subprocess per grep, pathspec magic survives `path_arg` harmlessly (it cannot address outside the index), and `git ls-files --others --exclude-standard` accepts a pathspec — verified by running it.
Deferred: [Q01] (whether the tree needs its own FTS/embedding index) stays open by design, with the calibration suite named as the instrument that resolves it. The two questions this plan genuinely turned on — its scope, and how much of the filesystem the read verbs may reach — were put to the owner during authoring and decided ([P02] carries the second, including its accepted secret-exposure trade in [#r01-filesystem-reach]).

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Gazette Operator answers questions about the work in a user's coding sessions. It has thirteen read-only verbs (`VERB_NAMES` in `tugrust/crates/tugcast/src/feeds/operator.rs`): seven ledger searches, two session verbs, two changes verbs, `git.log`, `git.show`, and `repo.grep`. **None of them opens a file.** `repo.grep` returns matching lines truncated to 240 characters each — needles, never the cloth — so a question about what a file *says* is unanswerable by construction, and the source tree, which is the thing the user most wants to ask about, is not a content base the channel can work with.

This was diagnosed from two live incidents on 2026-08-16, both asking the same question — *"show me where we have the Z-zone drawing in the tuglaws/design-decisions.md document"* — with the target file `@`-completed in the composer. The answer is decision D97 in `tuglaws/design-decisions.md`, whose ASCII drawing begins at line 271. The full evidence is in [`dash/gazette-file-verbs-brief.md`](gazette-file-verbs-brief.md); the two findings that drive this plan are in [the incident deep dive](#incident-evidence). The short version: the second incident's retrieval round was *correct in every part except one*, and that one part failed silently, after which the answering model wrote a fluent and completely false claim that the term does not appear in the file.

Everything already landed — the gazette-intelligence-boost program (index vocabulary, ranking, the lexical relaxation ladder, Haiku expansion, `tugcast operator-ask`) and the gazette-fixes dash (prose-answer salvage, the `repo.grep` pattern-recovery ladder, the coined-term teaching, the question post's annotation root) — improved retrieval and answer delivery without touching either structural gap. Both are on `main` as of 2026-08-16.

#### Strategy {#strategy}

- **Close the silent-failure gap before adding reach.** A verb that reports `ok, rows=0` for a scan that never ran is what licensed a false answer; making an unmatched scope an *error* is the single highest-value change here, and it lands first.
- **Add reading as a first-class verb, capped like every other verb.** `repo.read` is the missing fundamental; its caps follow `git.show`'s existing, proven numbers rather than inventing new ones.
- **Navigate by what the file's own text advertises, never by parsing it.** `repo.outline` scans line shapes (headings, label leads, `MARK:` comments, declaration lines) — cheap, no AST, no language dependency, and honest about what it cannot see.
- **Recover in Rust; teach in instructions; pin both.** The house pattern established by `absorb_flat_args` and the pattern-recovery ladder. A model slip that Rust can repair should be repaired, not merely discouraged.
- **Then carry the pointing gesture.** With the verbs in place, the asker's `@` atom is worth propagating: the file they pointed at should be in the Operator's hands before the first verb runs.
- **Verify against the real thing at each half.** `tugcast operator-ask` replays the actual incident question against a copy of the live ledger; that replay is the checkpoint for both halves, not a unit test standing in for one.

#### Success Criteria (Measurable) {#success-criteria}

- A `repo.grep`, `repo.read`, or `repo.outline` whose path/scope argument matches nothing returns `Err`, never `Ok` with zero rows (verified by unit tests asserting the error text names the argument and lists near-miss candidates).
- `repo.grep {"pattern": "zone", "path_scope": "%design-decisions.md"}` — the exact arguments from incident B — returns the file's real matches with a `path_scope_used` of `tuglaws/design-decisions.md` and a repair note (unit test against the fixture repo, plus the live replay).
- `repo.read {"path": "tuglaws/design-decisions.md", "around_line": 271}` returns numbered lines including the drawing's box-drawing characters, with `total_lines` and a `truncated` flag (unit test).
- `repo.outline {"path": "tuglaws/design-decisions.md"}` returns both the `## Code Session & Transcript` heading at line 263 and the `**D97.**` label at line 267 (unit test against a fixture reproducing both shapes; the real file is confirmed to contain exactly these two shapes at those lines).
- A path argument that resolves through a symlink to outside the project dir is refused (unit test creating a symlink in a fixture repo).
- `tugcast operator-ask "show me where we have the Z-zone drawing in the tuglaws/design-decisions.md document"` answers with the D97 location and the drawing's line span, against a copy of the live ledger (integration checkpoint, [#step-5]).
- A question submitted with an `@` file atom produces a user post whose `refs` carry that path, and a retrieve input containing the verified-mention preamble (Rust pipeline test + app-test [#step-8]).
- `cargo nextest run` green across the workspace and `bun test` green, with `-D warnings` clean, at every step.

#### Scope {#scope}

1. Path resolution and a repair ladder shared by every path-taking verb, with unmatched paths becoming errors that name candidates ([P03]).
2. `repo.ls` — resolve a name fragment or glob to real paths ([P01]).
3. `repo.read` — a file's content as numbered lines, capped, with a line-window mode ([P01], [P05]).
4. `repo.outline` — a file's structural lines with their line numbers, by line shape ([P04]).
5. Retrieval and answer instruction teachings for the new verbs, the LIKE-contamination hazard, and the absence rule — each with a job-table pin ([P08]).
6. Question refs on the wire: composer atoms → `GAZETTE_INPUT` → the user post → verified mentions in the retrieve turn, with outline seeding ([P06], [P07]).

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Any index or embedding of the source tree.** The evidence says every observed failure was mechanical rather than semantic; the tier ladder and the condition for revisiting are in [#roadmap].
- **Writing anything.** Every Operator verb is read-only and stays so.
- **Symbol-accurate code outlines.** [P04] is deliberately a line-shape scan; a real symbol index (tree-sitter or LSP-backed) is a different project with a different cost, noted in [#roadmap].
- **History reads.** `repo.read` reads the working tree only; reading a file *as of* a commit is `git.show`'s job and it already exists.
- **Image or binary content.** A binary file is refused with a message, not returned as mojibake ([P05]).
- **Changing `MAX_VERBS_PER_ROUND` (6) or `MAX_RETRIEVAL_ROUNDS` (2).** The new verbs are designed to fit the existing budget; outline seeding reduces round pressure rather than adding to it.

#### Dependencies / Prerequisites {#dependencies}

- `main` at or after the gazette-fixes landing (prose-answer salvage, `repo.grep` pattern ladder, question-post `project_dir`) — all present as of 2026-08-16.
- `tugcast operator-ask` (shipped in the boost program) for the integration replays.
- A copy of a live `sessions.db` for the replay checkpoints — made with `just db-inspect`, never by pointing anything at the live file ([#constraints]).

#### Constraints {#constraints}

- **Warnings are errors.** `-D warnings` via `tugrust/.cargo/config.toml`; `cargo build` and `cargo nextest run` fail on any warning.
- **Never point `sqlite3` or any foreign SQLite at a live ledger** under `~/Library/Application Support/Tug/`. Use `just db-inspect`, which copies the db plus its WAL/shm to a temp dir first. `operator-ask` takes `--db` and must be given a copy.
- **No string interpolation into a git argv.** `operator.rs` pushes arguments one at a time; every model-supplied string reaching git passes `plain_arg` (no leading `-`, no control characters) and, for paths, `path_arg` (no absolute, no `..`).
- **Every verb result is capped** before it is returned, because it becomes the answering model's input.
- **App-tests are selective.** `just app-test-changed` derives the run from `@covers`; never run the full corpus unprompted. A Rust change requires `just build-app` before app-tests, since the harness refreshes `dist` but not the app binary.
- **The app-test output is the report** — never pipe it into `grep`/`head`/`tail`.

#### Assumptions {#assumptions}

- `git` is on `PATH` and the project dir is a git repository — already assumed by `git.log`, `git.show`, and `repo.grep`, and `run_git` already answers "not a directory" as an error.
- The project dir may be reached through a symlink. This is true on the development machine right now: `tugcast::path_resolver` logs `original=/u/src/tugtool primary=/Users/kocienda/Mounts/u/src/tugtool`. Containment checks must therefore canonicalize **both** sides ([P02]).
- Files the Operator reads are UTF-8 or near enough for `String::from_utf8_lossy`; binary files are detected and refused rather than lossily converted ([P05]).
- The question's `@` atoms flatten to repo-relative paths in the composer today (`buildSlashCommandLine`), and the flattened text remains the wire's body — [P06] adds a parallel structured channel and changes nothing about the body.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings, plan-local decisions labelled `[P01]`…, and `**References:**` lines citing decisions, specs, and anchors — never line numbers. Step anchors are `#step-N`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Whether the tree needs its own search index (DEFERRED) {#q01-tree-index}

**Question:** Should the Operator get a `repo.search` verb backed by an FTS5 index over tracked text files (and, further out, embeddings), rather than relying on `repo.grep` plus the file verbs this plan adds?

**Why it matters:** An index is the single largest piece of optional work in this area, and building it before the mechanics are sound would bolt better retrieval onto a pipeline that has demonstrably lost answers *after* retrieval succeeded.

**Options (if known):**
- FTS5 over the tracked tree, reusing the boost program's `search_tokens` normalizer, sanitize/relax ladder, and `query_used`/`note` conventions wholesale.
- Embeddings, for paraphrase-level recall.
- Neither — grep plus file verbs is enough.

**Plan to resolve:** Measure rather than guess. After this plan lands, run a standing question suite through `tugcast operator-ask` (the calibration habit the boost roadmap named) and read the per-verb `gazette operator verb …` log lines: if questions are failing specifically for *cross-file lexical recall* reasons — the model cannot name any word that appears in the relevant text — the FTS tier is justified. Every failure diagnosed so far has instead been mechanical, which is what this plan fixes.

**Resolution:** DEFERRED — revisited in [#roadmap] after the calibration suite has run against the landed work.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| A read exposes secrets (`.env`, key material) into an answer post | high | med | Owner's decision ([P02]) accepts filesystem reach; containment, caps, and binary refusal bound it; posts are local to the user's own machine and channel | Any request to share Gazette posts off-machine, or a report of a secret surfacing in a post |
| A symlink inside the repo escapes the project dir | high | low | Canonicalize both the resolved path and the project dir, then require the prefix ([P02]); unit test with a real symlink | A containment test failing, or a new verb taking a path without going through the resolver |
| Reads and outlines crowd the answer turn's context | med | med | `git.show`'s proven caps reused verbatim (400 lines / 16 KB), `around_line` windowing, outline entry cap, seeding bounded to the first named files ([P05], [P07]) | An answer turn truncating, or replay latency climbing past the ~10 s the user waits |
| Outline's line-shape patterns miss or over-match | med | med | Patterns chosen against measured conventions in this repo; an empty outline says so and points at `repo.read` ([P04]) | A file family where outline is consistently empty or noisy |
| The wire change breaks questions from an older deck | med | low | `refs` is an optional field with `#[serde(default)]`; a payload without it behaves exactly as today ([P06]) | A deserialize warning in the tugcast log on `GAZETTE_INPUT` |
| Model reads a repaired path as if it were the one it asked for | med | med | Every repair reports `path_used` / `path_scope_used` plus a fixed `note`, and the answer instructions require saying so ([P03], [P08]) | An answer citing a file the question did not name, without a note |

**Risk R01: Filesystem reach is wider than any existing verb** {#r01-filesystem-reach}

- **Risk:** [P02] lets `repo.read` open any file under the project dir, including files git never sees — `.env`, local config, credentials a developer keeps in-tree.
- **Mitigation:**
  - Containment is enforced against the canonicalized project dir, so "under the project dir" is literally true, symlinks included.
  - Binary refusal and byte caps bound how much of any single file can move.
  - The verb is read-only and its output goes only into the answering model's turn and the user's own Gazette post, on the user's own machine.
- **Residual risk:** A user who asks a question whose retrieval reaches a secret-bearing file can get that secret quoted back into a channel post. This is an accepted trade made by the plan's owner in exchange for the reach; it is recorded in [P02] rather than silently mitigated away.

**Risk R02: A false-absence answer is worse than no answer** {#r02-false-absence}

- **Risk:** The failure this plan exists to fix — the model states that something is not in a file, on the strength of a scan that never happened.
- **Mitigation:**
  - Unmatched scopes become errors, so `ok, rows=0` acquires exactly one meaning ([P03]).
  - The answer instructions state the evidence that licenses an absence claim, pinned in the job-table test ([P08]).
- **Residual risk:** A model can still overstate a *narrow* clean scan ("not in this file" → "not in the codebase"). Bounded by the read/grep results naming their own scope, but not eliminated.

---

### Design Decisions {#design-decisions}

#### [P01] Three new verbs: `repo.read`, `repo.outline`, `repo.ls` (DECIDED) {#p01-three-verbs}

**Decision:** Add three read-only verbs to `VERB_NAMES` and `dispatch`: `repo.read` (file content as numbered lines), `repo.outline` (structural lines with line numbers), and `repo.ls` (name fragment or glob → real paths).

**Rationale:**
- The Operator's inability to open a file is the root gap; `repo.read` is the smallest thing that closes it.
- "Where in this document is X" is answered by structure, not by content — `repo.outline` answers it in one small result instead of a large read.
- `repo.ls` falls out of the path-resolution machinery [P03] already needs, and gives the model a way to answer "which file did you mean" itself; its result is paths only, so it cannot bloat a context.

**Implications:**
- `the_verb_table_matches_the_instructions` forces all three into `OPERATOR_RETRIEVE_INSTRUCTIONS`, and the answer instructions' verb roster must list them too.
- Sixteen verbs now compete for `MAX_VERBS_PER_ROUND` (6); the instructions must make the grep→read pairing explicit so a round spends itself well.
- Every new verb dispatches through `run_verb`, so it inherits `VERB_TIMEOUT` and the per-verb `gazette operator verb …` INFO line for free.

#### [P02] Any file under the project dir, with containment enforced on canonicalized paths (DECIDED) {#p02-file-visibility}

**Decision:** `repo.read` and `repo.outline` may open any file under the resolved project dir, tracked or not, ignored or not. Reach is bounded by three gates and nothing else: `path_arg` (no absolute paths, no `..`), a canonicalized containment check, and the content caps of [P05].

**Rationale:**
- Decided by the plan's owner when the alternatives (tracked-only; tracked plus untracked-not-ignored) were put to them.
- The Gazette narrates live session work, where the interesting file is often minutes old and uncommitted; a git-tracked-only rule would make "what's in the new file X" unanswerable exactly when it is most asked.
- The wider reach costs nothing in machinery — the existence check is the filesystem, which is simpler than consulting git.

**Implications:**
- `path_arg` alone is **not** sufficient: it inspects the argument's text, so a symlink *inside* the repo pointing outside it passes the text check and escapes. Containment must canonicalize the resolved path and compare it against the canonicalized project dir. Both sides, because the project dir itself is reached through a symlink on the development machine (`/u/src/tugtool` → `/Users/kocienda/Mounts/u/src/tugtool`).
- Files git deliberately ignores are readable, including `.env`-shaped ones. This is recorded as accepted in [#r01-filesystem-reach] rather than mitigated.
- `repo.grep` is unaffected: `git grep` searches tracked content by its own nature, and its scope resolution stays git's ([P03]).

#### [P03] A path that matches nothing is an error, not an empty result (DECIDED) {#p03-provable-absence}

**Decision:** Every path-taking verb resolves its path argument before doing any work. A resolution that matches nothing returns `Err` naming the argument and listing near-miss candidates. A resolution that matches after repair proceeds and reports what it used, in `path_used` / `path_scope_used`, with a fixed `note`.

**Rationale:**
- This is the direct fix for incident B. `git grep -e zone -- '%design-decisions.md'` exits 1 with empty stdout *and* empty stderr, which `run_git`'s existing "matched nothing is an answer, not a failure" branch converts into `Ok("")` — indistinguishable from a real clean miss. Verified by hand on this repository during planning.
- With the invariant in place, `ok, rows=0` from a scoped grep means exactly one thing — *the file was scanned and the pattern is not in it* — which is what makes the absence rule in [P08] enforceable by the model against its own results.
- The repair ladder additionally retires the observed cross-verb contamination class (a `changes.for_path` LIKE pattern reaching `repo.grep`) in Rust, following the house pattern of `absorb_flat_args`.

**Implications:**
- **A literal match is exact however many files it names.** `git ls-files -- 'tuglaws/'` returns 37 paths on this repository and `-- '*.md'` returns 502; a directory scope and a glob scope are ordinary, correct arguments. Multiplicity is therefore *not* ambiguity — it only becomes a question during repair, when the model's argument matched nothing as written and the system is guessing on its behalf.
- The repair ladder runs cheapest-first, and only when the literal resolution returned zero: strip LIKE artifacts (`%`, `_`) and retry literally → `*<basename>` glob → case-insensitive basename match.
- **Several repair candidates resolve per verb, because the verbs differ in nature.** `repo.read` and `repo.outline` have exactly one target, so several candidates is an `Err` listing them for the next round to name. `repo.grep` is multi-file by construction, so it searches all the candidates, names them in `path_scope_used`, and says in its note that the scope was guessed — a refusal there would be less useful than matches the model can see the provenance of.
- No candidate is an error naming the argument and whatever near-misses exist, for every verb.
- Verb errors already ride `render_results` to the answering model, so the model that would have claimed absence instead reads that the scan never happened.
- `repo.grep`'s existing pattern-recovery ladder (case-insensitive, then fragments) is untouched and composes: scope is resolved first, then the pattern ladder runs inside the resolved scope.
- Resolution costs one extra `git ls-files` per grep. Measured in milliseconds on this repository against a `VERB_TIMEOUT` of 10 s, and it buys the invariant the whole plan rests on — but it is a real subprocess and the implementer should not be surprised to see two git calls where there was one.
- Pathspec magic (`:(exclude)…`, `:(glob)…`) survives `path_arg`, which screens only for absolute paths and `..`. This is harmless: pathspec magic addresses the repository's own index and cannot reach outside it, and `git ls-files` resolves it the same way `git grep` would, so scope validation stays consistent with what the grep will actually search.

#### [P04] Outline is a line-shape scan, never a parse (DECIDED) {#p04-outline-line-shapes}

**Decision:** `repo.outline` recognizes structure by matching line shapes against a small pattern table selected by file extension. Markdown gets ATX headings and bold label leads; code files get `MARK:` comments and declaration lines indented four spaces or less. Nothing is parsed; no AST, no language server, no dependency.

**Rationale:**
- Measured against this repository during planning, and the measurements decided the design. `tuglaws/design-decisions.md` carries **20 ATX headings for 132 decisions** — D97, the target of the incident question, is a `**D97.**` bold-label paragraph at line 267 under the `## Code Session & Transcript` heading at line 263. A headings-only outline would have missed the very thing the incident asked for, which is why label leads are tier one rather than a refinement.
- In `operator.rs`, declarations indented up to four spaces (119) outnumber column-0 declarations (94), because `impl` blocks and the test module hold most of the functions. A column-0-only rule would hide more than half the file.
- `MARK:` comments appear in 10 files under `tugcast/src` and 1 under `tugdeck/src` — worth recognizing where present, not worth depending on.
- Line-shape matching cannot fail the way parsing can: no file is unparseable, no grammar goes stale, and a file that yields nothing simply says so.

**Implications:**
- A bold label lead is recognized narrowly enough to exclude prose bolding: the line must begin with `**`, close the bold span within 32 characters, and the bold text must be a short label ending in digits with optional trailing punctuation (`D97.`, `L26`, `Spec S01`, `Step 4`). `**Depends on:**` — which appears in every plan step — has no digits and is correctly excluded.
- Fence tracking is required: a `#` inside a triple-backtick or triple-tilde block is not a heading, and this repository's docs are full of fenced diagrams. The D97 drawing itself is inside a fence.
- Nested and deeply-indented declarations are not listed. This limitation is stated in the verb's own result (`note`) rather than left for the model to discover.
- An outline with no entries returns an explicit empty result whose `note` points at `repo.read`, so the model does not read "no structure" as "no file".

#### [P05] Reads reuse `git.show`'s caps, and say when they bite (DECIDED) {#p05-read-caps}

**Decision:** `repo.read` caps at 400 lines and 16 KB per call — the same `GIT_SHOW_MAX_LINES` / `GIT_SHOW_MAX_BYTES` numbers `git.show` already uses — and every result carries `total_lines` and `truncated`. A binary file (a NUL byte in the first 8 KB) is refused with a message naming the file rather than returned.

**Rationale:**
- Reusing the existing constants avoids inventing a second cap vocabulary for the same consumer: both results land in the same answering turn, and `git.show`'s numbers are already proven to fit it.
- `total_lines` is what makes a capped read honest — the model knows there is more and where it stands, which is what lets it ask for the next window instead of concluding the file ends there.
- Binary refusal has direct precedent in this repository: a literal NUL byte in `changeset-verb-store.ts` made the file invisible to `rg` and `git diff` and cost an afternoon of misattribution. A verb that returns NUL-laden mojibake to a model is the same failure with a model on the receiving end.

**Implications:**
- Three ways to name a window: nothing (the file's head, capped), `start`/`end`, or `around_line` with an optional `context` (default 40 lines each side).
- Lines are returned numbered, which is what lets an answer say "the drawing starts at line 271" without arithmetic, and what makes `repo.grep`'s `line` field compose directly into `around_line`.
- `cap_text` already exists for the byte/line pair and is reused rather than reimplemented.

#### [P06] The question's file atoms ride the wire as structured refs (DECIDED) {#p06-question-refs}

**Decision:** The Gazette composer sends its non-image atoms as a structured `refs` array on the `GAZETTE_INPUT` payload, alongside the flattened body it already sends. The pipeline verifies each against the project dir and publishes them on the user's question post.

**Rationale:**
- The asker's strongest signal — *this exact file* — currently evaporates at the first hop: `buildSlashCommandLine` flattens the atom to path text and `submitQuestion` sends only body plus image attachments, so the pipeline receives a sentence with no claim in it.
- Verification is a stat against a root the question post already carries (`project_dir`, landed in gazette-fixes), so a verified mention costs microseconds and is worth stating to the model as fact rather than as text it must notice.
- The post's refs render for free: the card already draws refs, and `unmentionedRefs` suppresses the chip when the prose names the same path, so a question whose text contains the path stays visually unchanged.

**Implications:**
- The wire field is optional (`#[serde(default)]` on the Rust side, omitted when empty on the deck side), so an older deck's payload behaves exactly as today.
- Question-side refs are **user-supplied and verified against the tree**; answer-side refs are model-written and verified against the verb-result corpus by `validate_refs`. The two channels keep separate rules, and question refs must not be run through `validate_refs` (nothing has run yet, so it would drop all of them).
- `sole_ledger_session`'s session-promotion logic is answer-side only and is not applied to question refs.
- `GazettePostWire.project_dir`'s doc comment in `tugdeck/src/protocol.ts` currently says the field is "Absent on a user question", which gazette-fixes made untrue; the same step corrects it.

#### [P07] A named file's outline seeds the retrieval turn (DECIDED) {#p07-outline-seeding}

**Decision:** When a question carries verified file refs, `compose_retrieve_input` gains a preamble naming them as verified-to-exist with their line counts, and the pipeline pre-runs `repo.outline` on the first two of them, including the outlines in the retrieval material.

**Rationale:**
- It converts the Operator's opening move from "I should search for this" into "I can see the file's structure" — for the incident question, round one becomes a single `repo.read` at the right line.
- It costs no model round: the outline runs in Rust before the retrieve turn, and an outline is small by construction ([P04]'s entry cap).
- It reduces round pressure rather than adding to it, which is what keeps `MAX_RETRIEVAL_ROUNDS` at 2.

**Implications:**
- Bounded to two files and to outline (never read) so a question naming a directory's worth of atoms cannot displace itself.
- A file that fails to outline contributes nothing and warns; the preamble still names it as verified.
- The preamble is a labelled section like `NOW:` and `SESSIONS (newest first):`, so it gets a named header constant and a job-table pin, following the convention those two already set.

#### [P08] Teach the new verbs, the LIKE hazard, and the absence rule — with pins (DECIDED) {#p08-teachings}

**Decision:** Add four teachings across `OPERATOR_RETRIEVE_INSTRUCTIONS` and `OPERATOR_ANSWER_INSTRUCTIONS` in `gazette_agent.rs`, each with an assertion in `the_job_table_carries_every_contract_the_gates_depend_on`.

**Rationale:**
- Rust recovery and model teaching are complements, not alternatives: the pattern-recovery ladder landed with a teaching beside it, and in the second incident the *teaching* is what produced a correct `zone` pattern on the first try.
- A contract the model was never told about cannot be relied on downstream, which is what the job-table pin test exists to prevent.

**Implications:**
- The four teachings: (1) `path` and `path_scope` are literal repo-relative paths or git globs, never `%`-style LIKE patterns — `changes.for_path` is the only verb that speaks LIKE and its `pattern` never travels; (2) a question about what a file *says* wants `repo.read`/`repo.outline` — grep locates, read answers; (3) the absence rule, answer-side: never state that something is absent unless a scoped scan of that file returned `ok` with zero rows, because an errored or repaired scan is not evidence of absence; (4) when a result carries `note`/`path_used`/`path_scope_used`, say so rather than presenting a repaired match as an exact one.
- The answer instructions' verb roster — the "read this list again" paragraph — must gain all three new names, since the answering turn never receives the verb table any other way.

---

### Deep Dives {#deep-dives}

#### The incident evidence {#incident-evidence}

Two questions, identical text, a day of fixes apart. The full narrative is in [`dash/gazette-file-verbs-brief.md`](gazette-file-verbs-brief.md); what an implementer needs is here.

**Incident A (release instance).** `repo.grep {"pattern": "Z-zone", "path_scope": "tuglaws/design-decisions.md"}` → 0 rows, because the document's own vocabulary is `Z0`–`Z5` and never the coinage "Z-zone". The answering model then wrote correct prose without the JSON envelope and the pipeline discarded it. Both halves are fixed on `main`: prose answers are salvaged, and the pattern-recovery ladder relaxes a zero-match pattern.

**Incident B (debug build carrying all of the above).** The per-verb log line that `log_verb` writes — the observability the boost program added, and the only reason this was a grep rather than an inference — verbatim:

```
gazette operator verb round=1 verb=repo.grep        args={"path_scope":"%design-decisions.md","pattern":"zone"}  outcome="ok" elapsed_ms=12 size=rows=0
gazette operator verb round=1 verb=changes.for_path args={"pattern":"%design-decisions.md"}                      outcome="ok" elapsed_ms=1  size=rows=4
```

The **pattern** was right — `zone`, exactly what the teaching asks for. The **scope** was `%design-decisions.md`: SQL LIKE syntax, which is `changes.for_path`'s legitimate grammar, written into both verbs in the same round. As a git pathspec it matches no file, so `git grep` scanned nothing; the pattern ladder then dutifully reran all three of its rungs against the same empty scope, because the ladder relaxes the pattern and never the scope.

Reproduced by hand on this repository during planning:

```
$ git grep -n -I --no-color -e zone -- '%design-decisions.md' ; echo "exit=$?"
exit=1
$ git grep -c -I --no-color -e zone -- 'tuglaws/design-decisions.md'
tuglaws/design-decisions.md:9
$ git ls-files -- '%design-decisions.md'          # no output, exit 0
$ git ls-files -- '*design-decisions.md'
tuglaws/design-decisions.md
```

Two facts follow, and both are load-bearing for [P03]. First, the unmatched-pathspec grep exits 1 with **empty stdout and empty stderr**, which is precisely the branch in `run_git` that returns `Ok(String::new())` — the comment there ("`git grep` exits 1 with empty output when it simply matched nothing; that is an answer, not a failure") is correct for its intended case and is exactly what makes this one silent. Second, `git ls-files` is a sound resolver: it exits 0 and prints nothing for a pathspec matching nothing, and the `*basename` glob resolves the real path.

Given `ok, rows=0`, the answering model wrote a fluent false claim — that the term appears nowhere in the file, with speculation that the content may have been removed in a recent edit — decorated with the four real `changes.for_path` rows. That is the failure this plan is built to make impossible.

#### What `tuglaws/design-decisions.md` actually looks like {#target-document-shape}

The canonical example must survive contact with the real file, so it was measured:

| Property | Value |
|---|---|
| ATX headings (`^#{1,6} `) | 20 |
| Decision paragraphs (`^\*\*D[0-9]`) | 132 |
| Nearest heading above the target | `## Code Session & Transcript`, line 263 |
| The target decision | `**D97.** The session card is partitioned into **six placement zones, `Z0`-`Z5`…`, line 267 |
| The drawing | a fenced block beginning line 271, box-drawing characters, zone labels `Z0`/`Z1A`/`Z1C`/`Z2` |
| Occurrences of `zone` (case-insensitive) | 9 lines |

This is why [P04] recognizes bold label leads as tier one and why fence tracking is mandatory rather than a nicety: the drawing the question asks for lives inside a fence, and the decision that owns it is not a heading.

#### The end-to-end flow this plan enables {#target-flow}

For the incident question, after both halves land:

1. The composer sends `refs: [{kind: "file", target: "tuglaws/design-decisions.md"}]` beside the body ([P06]).
2. The pipeline verifies the path, publishes the question post carrying the ref, and seeds the retrieve turn with a verified-mention line and the file's outline ([P07]).
3. The retrieve model sees `## Code Session & Transcript — line 263` and `**D97.** — line 267` and asks for `repo.read {"path": "tuglaws/design-decisions.md", "around_line": 271}`.
4. The answer quotes the drawing and names its span.

Without the second half, the same question still works through the first: a scope resolved or repaired, a grep for `zone` returning nine real lines, and a read around the best hit.

---

### Specification {#specification}

**Spec S01: `repo.read`** {#s01-repo-read}

- **Arguments:** `path` (required, repo-relative), `start` / `end` (optional, 1-based inclusive), `around_line` + `context` (optional; `context` defaults to 40), `session_id` (optional, selects the project dir as every other verb does).
- **Resolution:** `path_arg` → repair ladder ([P03]) → filesystem existence → canonicalized containment ([P02]).
- **Refusals:** a path matching nothing (error naming candidates); a directory (error saying so and suggesting `repo.ls`); a binary file (error naming the file); several repair candidates (error listing them).
- **Result:** `{ path, path_used, lines: [{ line, text }], start, end, total_lines, truncated, note? }`.
- **Caps:** 400 lines and 16 KB per call via the existing `cap_text` pair ([P05]); a request wider than the cap is honored from its start and marked `truncated`.

**Spec S02: `repo.outline`** {#s02-repo-outline}

- **Arguments:** `path` (required), `session_id` (optional).
- **Resolution:** identical to [#s01-repo-read].
- **Entry:** `{ line, kind, text }` where `kind` is one of `heading`, `label`, `mark`, `decl`.
- **Patterns, by extension family:**
  - `.md` / `.markdown` / `.txt`: ATX headings (`^#{1,6} `, outside fences) → `heading`; bold label leads (`^\*\*<label>\*\*`, label ≤ 32 chars ending in digits with optional trailing punctuation) → `label`.
  - `.rs` / `.ts` / `.tsx` / `.js` / `.jsx` / `.swift` / `.py` / `.css`: `MARK:` comments → `mark`; declaration lines indented ≤ 4 spaces whose first keyword is one of the family's declaration keywords → `decl`.
  - Anything else: no patterns; the result is empty with a `note`.
- **Fence tracking:** triple backtick and triple tilde toggle an in-fence state for every family; no pattern matches inside a fence.
- **Result:** `{ path, path_used, entries, count, truncated, note? }` with an entry cap of 200.
- **Empty is explicit:** zero entries returns `note: "no structural lines recognized in this file; read it with repo.read"`.

**Spec S03: `repo.ls`** {#s03-repo-ls}

- **Arguments:** `pattern` (required — a name fragment, a basename, or a git glob), `session_id` (optional).
- **Behavior:** the same candidate resolution [P03] uses for repair, exposed directly: literal, then `*pattern*` glob, then case-insensitive basename match, over tracked files plus untracked-not-ignored files (`git ls-files` and `git ls-files --others --exclude-standard`).
- **Result:** `{ pattern, paths, count, truncated }`, capped at 50 paths.
- **Empty is not an error** here — "no file by that name" is a real answer to a naming question, and unlike a scoped scan it cannot be mistaken for a content claim.

**Spec S04: path resolution and repair** {#s04-path-resolution}

The shared machinery every path-taking verb calls. Two entry points over one candidate helper:

- `resolve_grep_scope(dir, scope) -> Result<ScopeResolution, String>` — for `repo.grep`'s `path_scope`, resolving against **git's** view, because `git grep` searches tracked content.
- `resolve_readable_path(dir, path) -> Result<PathResolution, String>` — for `repo.read` and `repo.outline`, resolving against the **filesystem** ([P02]), falling back to the candidate helper for repair suggestions.
- `path_candidates(dir, needle) -> Vec<String>` — the ladder: literal match; LIKE-artifact strip (leading/trailing `%`, stray `_` wildcards) retried literally; `*<basename>` glob; case-insensitive basename match. Tracked and untracked-not-ignored files are both candidate sources.

Resolution outcomes. The first, second, and fourth rows are uniform; the third differs by verb because a read has one target and a grep does not ([P03]):

| Outcome | Behavior |
|---|---|
| Literal match, any number of files | Exact — proceed with the argument as written; `*_used` equals the argument; no note |
| Repair matched exactly one | proceed against the candidate; `*_used` names it; fixed note naming what happened |
| Repair matched several | `repo.read` / `repo.outline`: `Err` listing them, so the next round names one. `repo.grep`: search all of them, name them in `path_scope_used`, and say in the note that the scope was guessed |
| Nothing matched | `Err` naming the argument and the nearest names found |

**Spec S05: the verified-mention preamble** {#s05-verified-mentions}

A labelled section in `compose_retrieve_input`, present only when the question carried verified file refs:

```
FILES NAMED BY THE QUESTION (verified to exist):
- tuglaws/design-decisions.md (2431 lines)
  OUTLINE:
    263  heading  ## Code Session & Transcript
    267  label    **D97.**
```

The header string is a `pub const` beside `NOW_HEADER` and `SESSIONS_HEADER` and is pinned in the job-table test, following the convention those two set. Outlines are included for at most the first two files ([P07]).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

Only [#step-6] touches tugdeck, and it adds no new stored state — the outbound refs are computed at submit time from the editor's own captured state, exactly as image attachments already are, and the inbound refs arrive through the existing store fold.

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Question refs, outbound (composer → wire) | none — derived at submit, never held | `editorRef.captureState()` in `submit`, same call that already yields the atoms for `buildSlashCommandLine` and the image attachments | — |
| Question refs, inbound (post → row) | local-data | existing `GazetteStore` fold; `useGazette`'s `useSyncExternalStore` | [L02] |
| Question post's ref chips | appearance | existing `unmentionedRefs` + `RefAtom` render path; no new state | [L06] |

#### Law cross-check {#law-cross-check}

Only [#step-6] and [#step-8] touch tugdeck; the rest is Rust. Each law below was checked against `tuglaws/tuglaws.md` and the code, and the verdict is stated rather than assumed.

- **[L02] — external state enters React through `useSyncExternalStore` only. Honored, by adding nothing.** Inbound refs arrive on the post through the existing `GazetteStore` fold, which `useGazette` already subscribes to. The plan introduces no second path into React.
- **[L06] — ephemeral appearance state goes through CSS and DOM, never React state. Honored, by adding nothing.** The ref chips render through the existing `unmentionedRefs` + `RefAtom` path; nothing about the composer's appearance moves.
- **[L26] — mount identity must be stable across logical transitions. Honored, by not touching it.** A post's `key` is its request id plus author, which is what makes the pending row and its answer one row; refs ride the same post and change no key.
- **[L23] — internal operations must never lose user-visible state. Engaged, and satisfied.** [P06] drops refs that fail verification, which is a deliberate discard of something the user typed. It is safe here for a specific reason: the atom already flattened into the body text, so the path stays visible in the sentence and only the structured claim is dropped. If a future change ever made refs the *only* carrier of the path, this discard would become an [L23] violation and would need to become an error instead.
- **[L11] — controls emit actions; responders own state. Not engaged.** The composer's `submit` reads editor state it already captures; no new control, no new responder, no change to `REMOVE_ATTACHMENT`'s existing wiring.
- **[L27] — every acquisition returns its release. Not engaged.** Neither half acquires anything: outline seeding runs inline inside the question's own task, and the deck change holds nothing.
- **[L19]/[L20] — component authoring and module docstrings. Engaged on the Rust side only** ([#documentation-plan]); no new tugdeck component is created.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/src/feeds/repo_files.rs` | Path resolution and repair ([S04]), the outline line-shape scanner ([S02]), and the binary/containment helpers — the pure, heavily-tested half, kept out of the already-large `operator.rs` |

No new app-test file: [#step-8] extends `tests/app-test/at0365-gazette-card.test.ts`, which already drives the Gazette composer to submit and observes the resulting user post.

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `VERB_NAMES` | const | `feeds/operator.rs` | gains `repo.read`, `repo.outline`, `repo.ls` |
| `dispatch` | fn | `feeds/operator.rs` | three new match arms |
| `repo_read` / `repo_outline` / `repo_ls` | async fn | `feeds/operator.rs` | verb executors; resolution and scanning delegated to `repo_files` |
| `repo_grep` | async fn | `feeds/operator.rs` | scope resolved via [S04] before the existing pattern ladder runs |
| `READ_MAX_LINES` / `READ_MAX_BYTES` / `READ_CONTEXT_DEFAULT` / `OUTLINE_MAX_ENTRIES` / `LS_MAX_PATHS` | const | `feeds/operator.rs` | caps beside the existing cap block; the first two reuse `git.show`'s values |
| `resolve_grep_scope` / `resolve_readable_path` / `path_candidates` | fn | `feeds/repo_files.rs` | [S04] |
| `ScopeResolution` / `PathResolution` | struct | `feeds/repo_files.rs` | carry the used path plus an optional note |
| `outline_entries` | fn | `feeds/repo_files.rs` | [S02]; pure over `(&str contents, &str extension)` so it tests without a filesystem |
| `is_binary` / `contained_path` | fn | `feeds/repo_files.rs` | NUL scan over the first 8 KB; canonicalized prefix check ([P02]) |
| `QuestionRef` | struct | `feeds/operator.rs` | the wire shape for [P06]; `kind` + `target` |
| `OperatorPipeline::handle` | fn | `feeds/operator.rs` | gains a `refs: Vec<QuestionRef>` parameter |
| `run_question` | fn | `feeds/operator.rs` | gains the verified mentions for [S05] |
| `compose_retrieve_input` | fn | `feeds/operator.rs` | gains the preamble ([S05]) |
| `QUESTION_FILES_HEADER` | pub const | `feeds/operator.rs` | [S05]'s label, pinned like `NOW_HEADER` |
| `RawGazetteInput` | struct | `main.rs` | gains `#[serde(default)] refs` |
| `OPERATOR_RETRIEVE_INSTRUCTIONS` / `OPERATOR_ANSWER_INSTRUCTIONS` | const | `feeds/gazette_agent.rs` | [P08]'s four teachings and the verb roster |
| `the_job_table_carries_every_contract_the_gates_depend_on` | test | `feeds/gazette_agent.rs` | pins for each teaching and the new header |
| `encodeGazetteInput` | fn | `tugdeck/src/protocol.ts` | optional `refs` argument, omitted when empty |
| `GazettePostWire.project_dir` | doc comment | `tugdeck/src/protocol.ts` | corrected — no longer absent on a user question |
| `GazetteStore.submitQuestion` | method | `tugdeck/src/lib/gazette-store.ts` | third parameter for refs |
| `GazetteComposer.submit` | fn | `tugdeck/src/components/gazette/gazette-card.tsx` | collects non-image atoms into refs |

---

### Documentation Plan {#documentation-plan}

- [ ] Module docstring for `feeds/repo_files.rs` stating the resolution ladder, the containment rule, and why outline is a scan rather than a parse.
- [ ] `feeds/operator.rs`'s module docstring gains the new verbs' place in its "three structural properties" framing — specifically that reading is capped and contained.
- [ ] `@covers` lines on the new app-test, and updated `@covers` on `at0365-gazette-card.test.ts` if its coverage set moves.
- [ ] No new tuglaws entry: this plan adds verbs inside an existing subsystem and changes no law or global design decision.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (pure)** | `outline_entries`, `path_candidates`, the label-lead and fence rules, `is_binary` | Line-shape and ladder logic — no filesystem, no git |
| **Unit (fixture repo)** | Verb executors against the existing `git_repo()` tempdir fixture in `operator.rs`'s test module | Resolution, repair, containment, caps, error text |
| **Pipeline (scripted pool)** | `handle`/`run_question` with `scripted_pool` | Question refs reaching the post and the preamble reaching the retrieve input |
| **Contract / pin** | `the_job_table_carries_every_contract_the_gates_depend_on`, `the_verb_table_matches_the_instructions` | Every teaching and header the code depends on the model having read |
| **App-test** | `at0371`, driving the real app | The composer's atom becoming a ref on the real post |
| **Integration replay** | `tugcast operator-ask` against a ledger copy | The whole pipeline answering the real question |

#### What stays out of tests {#test-non-goals}

- **No mock filesystem and no mock git.** The fixture repo in `operator.rs`'s test module is a real `git init` with real commits; new fixtures extend it (a file with a fence, a file with a NUL byte, a symlink) rather than standing in for it. This follows the project's real-not-fake discipline.
- **No jsdom render test for the composer change.** The ref round trip is covered where it is real — a Rust pipeline test for the wire and pipeline halves, an app-test for the gesture — never a fake-DOM render assertion.
- **No assertion on model wording.** The replays check that the right verbs ran with the right arguments and that the answer names the right location; the exact sentences are the model's.
- **No test of `git` itself.** That `git ls-files` resolves a glob is git's contract; what is pinned is our behavior given each resolution outcome.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Path resolution, repair, and `repo.ls`; grep scope becomes provable | done | `c5a6b028d` |
| #step-2 | `repo.read` | done | `18afad71e` |
| #step-3 | `repo.outline` | done | `1b760ff46` |
| #step-4 | Instruction teachings and pins | done | `bd373b452` |
| #step-5 | Integration checkpoint: replay the incident question | done | `732a67aff` |
| #step-6 | Question refs on the wire | done | `f4eeceba1` |
| #step-7 | Verified mentions and outline seeding | done | `a0dd0ddd7` |
| #step-8 | App-test: the pointing gesture | done | `da788db8d` |
| #step-9 | Integration checkpoint: the whole arc | done | `da788db8d` |

#### Step 1: Path resolution, repair, and `repo.ls`; grep scope becomes provable {#step-1}

**Commit:** `tugcast(operator): resolve and repair path arguments, and refuse a scope that matches nothing`

**References:** [P01] Three new verbs, [P03] Provable absence, Spec S03, Spec S04, (#incident-evidence, #s04-path-resolution)

**Artifacts:**
- New `tugrust/crates/tugcast/src/feeds/repo_files.rs`, registered in `feeds/mod.rs`
- `repo.ls` verb; `repo.grep` resolving its scope before running

**Tasks:**
- [ ] Create `feeds/repo_files.rs` with a module docstring covering the ladder and the "unmatched is an error" rule, and register `pub mod repo_files;` in `feeds/mod.rs`.
- [ ] Implement `path_candidates(dir, needle)`: literal → LIKE-artifact strip → `*<basename>` glob → case-insensitive basename match, over `git ls-files` and `git ls-files --others --exclude-standard`. Dedupe, preserve ladder order, cap the returned list.
- [ ] Implement `resolve_grep_scope` returning `ScopeResolution { used, note }` or the `Err` cases of [S04]'s table.
- [ ] Add `repo.ls` per [S03]: `VERB_NAMES` entry, `dispatch` arm, executor, `LS_MAX_PATHS` cap.
- [ ] Rewrite `repo_grep` to resolve `path_scope` first, then run its existing pattern-recovery ladder inside the resolved scope; add `path_scope_used` to the result and merge a scope note with any pattern note.
- [ ] Extend the test fixture's `git_repo()` (in `operator.rs`'s test module — a real `git init` with real commits, currently holding `alpha.txt` and `beta.txt`) with a committed `docs/design-notes.md` whose text contains the word `zone`, so the incident's shape has a real target to resolve against.

**Tests:**
- [ ] `path_candidates` unit tests: literal hit; `%design-notes.md` repaired via LIKE strip; `*notes.md` basename glob; case-insensitive match; nothing found.
- [ ] `repo.grep {"pattern": "zone", "path_scope": "%design-notes.md"}` — the incident's exact shape — returns the fixture file's matches with `path_scope_used` of `docs/design-notes.md` and a repair note.
- [ ] `repo.grep` with a scope matching nothing returns `Err` whose message names the argument and lists near-misses — explicitly asserting it is `Err`, not `Ok` with `count: 0`. This is the test that would have caught incident B.
- [ ] `repo.grep` with an exact scope carries no scope note and a `path_scope_used` equal to the argument.
- [ ] `repo.grep` scoped to a directory (`docs/`) searches all of its files and is treated as exact, not ambiguous ([P03]).
- [ ] `repo.ls` resolves a basename fragment; an unmatched pattern returns `Ok` with an empty list (not an error).
- [ ] `the_verb_table_matches_the_instructions` still passes once `repo.ls` is added to the retrieval instructions.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `cd tugrust && cargo clippy -p tugcast --all-targets` (clean under `-D warnings`)

---

#### Step 2: `repo.read` {#step-2}

**Depends on:** #step-1

**Commit:** `tugcast(operator): add repo.read so the Operator can open a file`

**References:** [P01] Three new verbs, [P02] File visibility, [P05] Read caps, Spec S01, (#r01-filesystem-reach, #target-flow)

**Artifacts:**
- `repo.read` verb; `resolve_readable_path`, `contained_path`, `is_binary` in `repo_files.rs`

**Tasks:**
- [ ] Implement `contained_path(project_dir, path)`: canonicalize **both** sides and require the prefix. Document why both — the project dir is itself reached through a symlink on the development machine (`/u/src/tugtool` → `/Users/kocienda/Mounts/u/src/tugtool`), so canonicalizing only the target would reject every legitimate read.
- [ ] Implement `is_binary`: a NUL byte within the first 8 KB.
- [ ] Implement `resolve_readable_path`: `path_arg` → filesystem existence → `path_candidates` repair when absent → containment → `PathResolution { used, note }`.
- [ ] Add `READ_MAX_LINES` / `READ_MAX_BYTES` (equal to `GIT_SHOW_MAX_LINES` / `GIT_SHOW_MAX_BYTES`) and `READ_CONTEXT_DEFAULT` beside the existing cap block, each with a comment saying why it holds that value.
- [ ] Implement `repo_read` per [S01]: window selection (head / `start`+`end` / `around_line`+`context`), numbered lines, `total_lines`, `truncated`, refusals for directory and binary.
- [ ] Register in `VERB_NAMES` and `dispatch`; add the verb to the retrieval instructions so `the_verb_table_matches_the_instructions` passes.

**Tests:**
- [ ] Reads a fixture file's head with no window; `total_lines` is the real count.
- [ ] `start`/`end` returns exactly that inclusive range, numbered from `start`.
- [ ] `around_line` with default context centers the window and clamps at both file ends.
- [ ] A file longer than the line cap comes back `truncated: true` with `total_lines` still exact.
- [ ] A directory path errors and the message suggests `repo.ls`.
- [ ] A file containing a NUL byte errors as binary rather than returning its bytes.
- [ ] A symlink inside the fixture repo pointing outside it is refused by containment — the test creates a real symlink with `std::os::unix::fs::symlink`.
- [ ] An absolute path and a `..` path are refused by `path_arg` (extending the existing `a_path_may_not_escape_the_project_dir` coverage to the new verb).
- [ ] An untracked, uncommitted file in the fixture repo reads successfully ([P02]).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `cd tugrust && cargo clippy -p tugcast --all-targets` (clean under `-D warnings`)

---

#### Step 3: `repo.outline` {#step-3}

**Depends on:** #step-2

**Commit:** `tugcast(operator): add repo.outline — a file's structure by line shape`

**References:** [P04] Line-shape scan, Spec S02, (#target-document-shape)

**Artifacts:**
- `repo.outline` verb; `outline_entries` in `repo_files.rs`

**Tasks:**
- [ ] Implement `outline_entries(contents, extension) -> Vec<OutlineEntry>` as a pure function: fence tracking (``` and ~~~), then the per-family pattern table of [S02].
- [ ] Markdown patterns: ATX headings outside fences; bold label leads — line begins `**`, bold span closes within 32 characters, bold text is a short label ending in digits with optional trailing punctuation.
- [ ] Code patterns: `MARK:` comments; declaration lines indented four spaces or fewer whose first keyword is in the family's keyword set (Rust: `fn`, `pub fn`, `pub async fn`, `struct`, `enum`, `trait`, `impl`, `const`, `static`, `mod`; TS/JS: `function`, `const`, `class`, `interface`, `type`, `export` forms; Swift: `func`, `struct`, `class`, `enum`, `extension`, `protocol`; Python: `def`, `class`).
- [ ] Implement `repo_outline` per [S02] with `OUTLINE_MAX_ENTRIES`, the explicit-empty note, and the same resolution as `repo.read`.
- [ ] Register in `VERB_NAMES`, `dispatch`, and the retrieval instructions.

**Tests:**
- [ ] Against a fixture reproducing the real document's shape — an `## Section` heading, a `**D97.**` label paragraph below it, and a fenced block containing a `#` line and box-drawing characters — the outline returns the heading and the label with their correct line numbers and returns nothing from inside the fence. This is the [#target-document-shape] finding turned into a test.
- [ ] `**Depends on:**` produces no entry (no digits in the label), while `**Spec S01: Title**` does.
- [ ] A Rust fixture yields both column-0 and four-space-indented declarations, and not an eight-space-indented one.
- [ ] A `MARK:` comment is recognized in a Rust fixture.
- [ ] An extension with no pattern family returns zero entries plus the pointing note.
- [ ] A file with more structural lines than the cap comes back `truncated: true`.
- [ ] Resolution and containment behave as in [#step-2] (one shared-path test, not a re-run of the whole matrix).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `cd tugrust && cargo clippy -p tugcast --all-targets` (clean under `-D warnings`)
- [ ] The fixture outline test asserts the heading, the label, and the fence exclusion. The proof against the **real** `tuglaws/design-decisions.md` is [#step-5]'s, deliberately: a unit test reading the live document would break the day someone edits it, and the replay exercises the real file anyway.

---

#### Step 4: Instruction teachings and pins {#step-4}

**Depends on:** #step-3

**Commit:** `tugcast(gazette): teach the file verbs, the LIKE hazard, and the absence rule`

**References:** [P08] Teachings, [P03] Provable absence, (#incident-evidence)

**Artifacts:**
- Four teachings across `OPERATOR_RETRIEVE_INSTRUCTIONS` and `OPERATOR_ANSWER_INSTRUCTIONS`; matching assertions in the job-table pin test

**Tasks:**
- [ ] Retrieve instructions: `path`/`path_scope` are literal repo-relative paths or git globs, never `%`-style LIKE patterns — naming `changes.for_path` as the only verb that speaks LIKE, and naming the observed contamination.
- [ ] Retrieve instructions: grep locates, read answers — a question about what a file *says* wants `repo.read` or `repo.outline`, and a grep hit's `line` feeds `around_line` directly.
- [ ] Answer instructions: the absence rule — never write that something is absent from a file unless a scoped scan of that file returned `ok` with zero rows; an errored or repaired scan is not evidence of absence.
- [ ] Answer instructions: when a result carries `note` / `path_used` / `path_scope_used`, say so rather than presenting a repaired match as an exact one.
- [ ] Answer instructions: add `repo.read`, `repo.outline`, and `repo.ls` to the "read this list again" verb roster.
- [ ] Add one assertion per teaching in `the_job_table_carries_every_contract_the_gates_depend_on`, each with a comment naming the incident or contract it protects.

**Tests:**
- [ ] Pin assertions for all four teachings and for the three new names in the answer roster.
- [ ] `the_verb_table_matches_the_instructions` passes with sixteen verbs.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `cd tugrust && cargo nextest run` (whole workspace green)

---

#### Step 5: Integration checkpoint — replay the incident question {#step-5}

**Depends on:** #step-1, #step-2, #step-3, #step-4

**Commit:** `N/A (verification only)`

**References:** [P03] Provable absence, [P05] Read caps, Spec S01, Spec S02, (#success-criteria, #incident-evidence)

**Tasks:**
- [ ] Copy a live ledger safely: `just db-inspect` to produce the copy, or copy `sessions.db` plus its `-wal` and `-shm` to a temp dir by hand. **Never** point `operator-ask` at the live file.
- [ ] Replay the real question: `cargo run -q -p tugcast -- operator-ask "show me where we have the Z-zone drawing in the tuglaws/design-decisions.md document" --db <copy> --project-dir <this repo> --show-rounds`.
- [ ] Read the per-verb `gazette operator verb …` lines that `--show-rounds` prints: confirm no verb reports `ok, rows=0` for a scope that matched nothing, and that a read or outline actually ran.
- [ ] Confirm the real document's outline against [#target-document-shape]: `## Code Session & Transcript` at line 263 and `**D97.**` at line 267. This is where the line-shape scanner meets the real file — [#step-3]'s unit tests run against a fixture reproducing the shape, deliberately, so that the test does not break when the document is edited.
- [ ] Replay a deliberate scope miss (a question naming a file that does not exist) and confirm the answer says the lookup failed rather than asserting absence.
- [ ] Delete the ledger copy when finished.

**Tests:**
- [ ] No new automated tests — this step's product is the replay transcript, recorded in the dash round's summary.

**Checkpoint:**
- [ ] The replay answers with D97's location and the drawing's line span.
- [ ] The deliberate-miss replay produces no false absence claim.
- [ ] `cd tugrust && cargo nextest run` green.

---

#### Step 6: Question refs on the wire {#step-6}

**Depends on:** #step-5

**Commit:** `tugcast+tugdeck(gazette): carry the question's file atoms as refs`

**References:** [P06] Question refs, (#state-zone-mapping, #target-flow)

**Artifacts:**
- `refs` on the `GAZETTE_INPUT` payload, end to end; the question post carrying verified refs

**Tasks:**
- [ ] `tugdeck/src/components/gazette/gazette-card.tsx`: in `submit`, collect non-image atoms from the already-captured `state.atoms` into `{kind: "file", target: <value>}` and pass them to `submitQuestion`. The existing `buildSlashCommandLine` flattening and the image-attachment loop are unchanged — this reads the same captured state a third time.
- [ ] `tugdeck/src/lib/gazette-store.ts`: `submitQuestion` takes refs and forwards them to `encodeGazetteInput`.
- [ ] `tugdeck/src/protocol.ts`: `encodeGazetteInput` gains an optional refs argument, omitted from the JSON when empty so the common payload stays byte-identical; correct `GazettePostWire.project_dir`'s doc comment, which still claims the field is absent on a user question.
- [ ] `tugrust/crates/tugcast/src/main.rs`: `RawGazetteInput` gains `#[serde(default)] refs: Vec<QuestionRef>`, forwarded to `handle`.
- [ ] `feeds/operator.rs`: add `QuestionRef`; `handle` takes the refs, verifies each against the project dir through [S04]'s resolver, and publishes the verified ones on the user post. Unverifiable refs are dropped with a warning rather than published — a chip nobody can act on is worse than no chip, which is the card's existing rule for malformed refs.
- [ ] Confirm the question post's refs do **not** pass through `validate_refs` or `sole_ledger_session` ([P06]).

**Tests:**
- [ ] Pipeline test: `handle` with a ref naming a real fixture file publishes a user post carrying that ref.
- [ ] Pipeline test: a ref naming a nonexistent file is dropped and the post still publishes.
- [ ] A `GAZETTE_INPUT` payload with no `refs` field deserializes and behaves exactly as before.
- [ ] `bun test` covers the encode side (a payload with refs, and a payload without them staying byte-identical to today's).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `cd tugdeck && bun test && bunx vite build`

---

#### Step 7: Verified mentions and outline seeding {#step-7}

**Depends on:** #step-6

**Commit:** `tugcast(operator): seed the retrieve turn with the files the question named`

**References:** [P07] Outline seeding, Spec S05, (#target-flow)

**Artifacts:**
- `QUESTION_FILES_HEADER` and the preamble in `compose_retrieve_input`; outline seeding in `run_question`

**Tasks:**
- [ ] Add `QUESTION_FILES_HEADER` as a `pub const` beside `NOW_HEADER` and `SESSIONS_HEADER`.
- [ ] Thread the verified mentions from `handle` into `run_question` and `compose_retrieve_input`.
- [ ] Render the preamble per [S05]: one line per verified file with its total line count, and — for the first two files — its outline entries indented beneath.
- [ ] A file that fails to outline contributes its name and line count only, with a warning logged.
- [ ] Pin `QUESTION_FILES_HEADER` in the job-table test the way `NOW_HEADER` and `SESSIONS_HEADER` are, and add a retrieve-instruction sentence telling the model what the section means and that those files are verified to exist.

**Tests:**
- [ ] `compose_retrieve_input` with no verified files is byte-identical to today's output — the common case must not move.
- [ ] With one verified file, the output contains the header, the path, the line count, and the outline lines.
- [ ] Seeding is bounded to two outlines when three files are named.
- [ ] Pipeline test with a scripted pool: a question carrying a file ref produces a retrieve input containing the header (asserted through the pool's captured input).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `cd tugrust && cargo nextest run` (workspace green)

---

#### Step 8: App-test — the pointing gesture {#step-8}

**Depends on:** #step-6, #step-7

**Commit:** `apptest(gazette): pin the question's file atom reaching the post as a ref`

**References:** [P06] Question refs, (#test-categories, #test-non-goals)

**Artifacts:**
- New assertions inside the existing `tests/app-test/at0365-gazette-card.test.ts`

**Extend the existing test rather than adding a file.** `at0365-gazette-card.test.ts` already drives this exact path end to end: it types into the Gazette composer, submits, and observes the resulting user post (its `rows after the round trip` diagnostic shows the user question and the Operator's reply as real rows). A new test file would stand up a second Tug.app subprocess to reach a surface this one is already holding, and every app-test invocation is serialized behind a machine-wide gate. The `@covers` set at0365 already declares includes `gazette-card.tsx`, `gazette-store.ts`, and the ref-render path, so the selection derivation needs nothing new either.

**The gesture's drivability is unproven and the step opens by settling it.** No existing app-test drives the `@` file-completion popup: `at0205-atom-chip-first-paint` makes its atom by dropping an image, and the composer's `@` source is asynchronous. The first task establishes which path is real before any assertion is written; both paths exercise the production editor, the production atom, and the production submit — neither is a mock.

**Tasks:**
- [ ] Determine whether the `@` completion popup can be driven from the harness. Read `at0051-completion-popup-escapes-card.test.ts` for the precedent, then try it: type `@`, wait for the popup, accept the item. If it works, that is the gesture the test drives.
- [ ] If it cannot be driven reliably, insert the atom through the editor's own delegate on the test surface instead — the real `TugTextEditor` holding a real file atom — and `note()` which path was taken, so the diagnostics record what the test actually exercised.
- [ ] Submit, and assert the question post carries the path: either as an annotated inline mention (the annotator marks it because the prose names it) or as a trailing ref chip. Assert the post's ref is present rather than asserting on the wire payload — the wire is covered by [#step-6]'s Rust and `bun` tests, and this test's job is the surface.
- [ ] `note()` the observed row, following the file's existing diagnostic style.
- [ ] Re-run `just app-test-covers-check` to confirm the declarations still resolve.
- [ ] Rebuild before running: the Rust changes from [#step-6] and [#step-7] mean `just build-app` first, since the harness refreshes `dist` but not the app binary.

**Tests:**
- [ ] The new assertions inside at0365 are the test.

**Checkpoint:**
- [ ] `just build-app`
- [ ] `just app-test-covers-check`
- [ ] `just app-test at0365-gazette-card.test.ts` (run bare — never piped)
- [ ] `just app-test-changed` (run bare — never piped)

---

#### Step 9: Integration checkpoint — the whole arc {#step-9}

**Depends on:** #step-5, #step-7, #step-8

**Commit:** `N/A (verification only)`

**References:** [P06] Question refs, [P07] Outline seeding, (#success-criteria, #target-flow)

**Tasks:**
- [ ] Replay the incident question again through `operator-ask` against a fresh ledger copy and compare the verb rounds against [#step-5]'s transcript: with seeding in place, round one should reach the answer with fewer or better-aimed lookups.
- [ ] Build and launch the debug instance from the worktree: `just app-debug`, confirm with `just instances`, and mark the dash built.
- [ ] In the debug instance, ask the real question with the file `@`-completed in the composer, and confirm both halves: the atom renders on the question post, and the answer names D97 and the drawing's line span.
- [ ] Read the instance's tugcast log for the exchange and confirm the verb line-up matches what the replay predicted.
- [ ] Delete the ledger copy.

**Tests:**
- [ ] No new automated tests; the artifacts are the replay transcript and the live exchange.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` (workspace green)
- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] `just app-test-changed`
- [ ] The live debug-instance exchange answers correctly, with the log line-up recorded in the dash round summary.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The Gazette Operator can open, navigate, and quote the project's source files; a lookup that scanned nothing says so instead of reporting a clean miss; and a file the asker points at with an `@` atom is in the Operator's hands before the first verb runs.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `repo.read`, `repo.outline`, and `repo.ls` exist, are offered to the model, and are pinned by `the_verb_table_matches_the_instructions` (test)
- [ ] No path-taking verb can return `Ok` with zero rows for an argument that matched nothing (tests in [#step-1], [#step-2], [#step-3])
- [ ] Containment holds through symlinks, with a test that builds a real one ([#step-2])
- [ ] The four teachings and `QUESTION_FILES_HEADER` are pinned in the job-table test ([#step-4], [#step-7])
- [ ] A question carrying an `@` file atom produces a post with that ref and a retrieve input naming it verified ([#step-6], [#step-7], [#step-8])
- [ ] The incident question is answered correctly by replay and in the live debug instance ([#step-5], [#step-9])
- [ ] `cargo nextest run` and `bun test` green; `bunx vite build` clean; `just app-test-changed` green

**Acceptance tests:**
- [ ] The `repo.grep` incident-arguments test ([#step-1])
- [ ] The `repo.read` symlink-containment and binary-refusal tests ([#step-2])
- [ ] The outline test reproducing the real document's heading-plus-label-plus-fence shape ([#step-3])
- [ ] `at0371-gazette-question-refs.test.ts` ([#step-8])

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] **The calibration suite** — a standing set of questions (the Z-zone question among them) replayed through `operator-ask` after each change, with the per-verb log lines as the scorecard. This is the instrument that resolves [Q01].
- [ ] **`repo.search` over the tracked tree** — FTS5 reusing the boost program's `search_tokens` normalizer, sanitize/relax ladder, and `query_used`/`note` conventions. Take it only if the calibration suite shows failures caused by cross-file lexical recall ([Q01]).
- [ ] **Embeddings** — only if an FTS tier measurably misses on paraphrase-level recall.
- [ ] **Symbol-accurate outlines** — a real parser (tree-sitter) behind `repo.outline`'s `decl` kind, if line-shape scanning proves too coarse in practice ([P04]).
- [ ] **`repo.read` on history** — reading a file as of a commit, if questions about past file states turn out to be common; `git.show` covers the diff case today.

| Checkpoint | Verification |
|------------|--------------|
| Absence is provable | `cargo nextest run -p tugcast` — the unmatched-scope tests assert `Err`, not empty `Ok` |
| The Operator can read | `repo.read` window and cap tests; the [#step-5] replay quoting the drawing |
| Structure is navigable | The outline test against the real document's shape; `**D97.**` at 267 |
| The gesture arrives | `at0371` app-test plus the `compose_retrieve_input` preamble tests |
| The real question is answered | The [#step-9] live exchange in the debug instance |
