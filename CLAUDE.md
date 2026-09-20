# Claude Code Guidelines for Tug

## Project Overview

Tug is a developer tool suite. Its centerpiece is the **Session card** — a graphical surface where shell commands and AI interactions coexist in one UI, replacing the terminal. The suite includes tugcast (WebSocket multiplexer), tugcode (Claude Code bridge), tugtool (the unified developer CLI — changes & commits, arcs, host plumbing), tugdeck (browser frontend), tugplug (agentless skills), and Tug.app (macOS host).

## Git Policy

**ONLY THE USER CAN COMMIT TO GIT.** Do not run `git commit`, `git push`, or any git commands that modify the repository history unless explicitly instructed by the user. You may run read-only git commands like `git status`, `git diff`, `git log`, etc.

**Exceptions:**
- Autonomous implementation: when the user explicitly authorizes autonomous sub-step execution (e.g., "go on your own"), commit after each sub-step using the `/tugplug:draft` skill's message style. Report each commit hash and message.
- The `/arc` door's arcs commit on their **arc worktree** (never on `main`) via `tugtool arc commit`, as part of walking an arc's steps. `main` is only updated by the user's landing gestures.
- The `/tugplug:brief` skill commits the one brief it wrote, via `tugtool commit --paths <path>`, as its last act before the hand-off — an uncommitted brief is missing from the worktree of any arc opened on it. That commit carries nothing but the brief.

The `/tugplug:draft` skill **never commits** — it authors the session's landing draft via `tugtool draft set`. Landing is the user's act: `/commit` (main lane) and `/arc-join <name>` (arc lane) in the Session card are the landing gestures.

## Writing prose the Session card renders

The rule — backtick every path you write, and write a commit sha bare in backticks — ships in `tugplug/transcript-prose.md` and rides every session's system prompt, so it holds on every project Tug opens. That file is the source; this checkout keeps no second copy. The doctrine behind it, and the resolver that rules a confirmed reference, are in [tuglaws/entity-presentation.md](tuglaws/entity-presentation.md#the-house-voices-backtick-every-path).

## The standalone contract

Tug is distributed as `Tug.app` to people whose projects have nothing to do with this checkout: no `tuglaws/`, no `justfile`, no `CLAUDE.md` of ours, no `~/.local/bin` symlinks, possibly no `jq` or `bun`. Everything the AI needs to drive Tug on such a project must be inside the bundle — the binaries in `Contents/MacOS/` and the plugin at `Contents/Resources/tugplug/`. The contract and its guards are in [tugplug/CLAUDE.md](tugplug/CLAUDE.md#the-standalone-contract): `just tugplug-lint` (in `just lint`) refuses checkout-only shapes under `tugplug/`, and `just test-standalone` (in `just test`) drives the real hook script and arc verbs from a scratch project with an empty PATH. Anything Tug-specific a skill would like to say — which recipe builds, which tests are green — belongs in `.tugtool/config.toml` or in this file, never in the plugin.

## Repository Structure

| Directory | Description |
|-----------|-------------|
| `tugrust/` | Rust crates (tugcast, tug, tugexec, tugbank, tugcore, the `*-core` libraries — tugtool-core/tugarc-core/tugchanges-core — and supporting libraries) |
| `tugproto/` | Shared protocol / message types (TypeScript) |
| `tugcode/` | Claude Code bridge (stream-json IPC); bun-compiled binary |
| `tugdeck/` | Web frontend (the Session card lives here) |
| `tugapp/` | Swift macOS app (Tug.app host) |
| `tugplug/` | Claude Code plugin (agentless skills: arc/arc-devise/arc-review/arc-implement/arc-audit/draft). An arc's documents live at `.tug/arcs/<name>/` and are never tracked. |
| `tuglaws/` | Architecture laws + design decisions — the curated durable doc surface |
| `briefs/` | Working papers — briefs, audits, sketches that became files. Its address is the Briefs Directory setting; the vocabulary (idea → sketch → brief → plan) is [tuglaws/work-grammar.md](tuglaws/work-grammar.md). |
| `tests/` | App-test harness that drives the real Tug.app |

## Build Policy

**WARNINGS ARE ERRORS.** The Rust workspace enforces `-D warnings` via `tugrust/.cargo/config.toml`.

- `cargo build` will fail if there are any warnings
- `cargo nextest run` will fail if tests have any warnings
- Fix warnings immediately; do not leave them for later

## Host tools — never probe git by running it

Tug ships no git ([D171]): git is GPLv2-only and Tug takes on no GPL obligations, so the offer points at Apple's Command Line Tools and the user installs them from Apple. Detection lives in `tugcore::host_tools` and **the order it takes is load-bearing**: resolve `git` on `PATH` first and version anything that is not `/usr/bin/git` — only the shim, or an empty `PATH`, reaches the silent `xcode-select -p`, and only its exit 0 makes `git --version` safe. On a machine with no active developer directory `/usr/bin/git` is Apple's shim, byte-identical to `/usr/bin/clang`, and running it pops a system modal. So never add a bare `git --version` probe anywhere, and never collapse the order into one; the wizard row, the shades' `TugNoGitNotice`, and the `tugtool arc` preflight all read the one implementation.

## Testing

Run Rust tests with:
```bash
cd tugrust && cargo nextest run
```

### App-tests: run a selection, never a sweep

Every app-test launches its own `Tug.app` subprocess and the whole invocation is serialized behind a machine-wide gate, so running the corpus is expensive. **Selective runs are the default.**

```bash
just app-test-changed        # the everyday command — derived from your working diff
just app-test-select         # print that selection without running it
```

Selection is derived, not guessed: every `*.test.ts` declares the source it exercises with `@covers` lines in its header docblock, and `app-test-changed` resolves the changed files through those declarations. Any new test **must** carry `@covers` — `just app-test-covers-check` fails on a missing declaration or a path that no longer resolves.

The changed files are **this session's**, not the whole tree's. The selector reads `tugtool changes --json` and selects from the attributed bucket plus any unattributed entry carrying a this-session hint; the **foreign** bucket — files another live session claims — is never selected, so a shared checkout no longer hands you tests for work that isn't yours. When the ledger can't answer (no `TUG_SESSION_ID`, unresolvable session, no built `tugtool`), selection falls back to the whole working tree and prints which fallback it took and why.

Do **not** run `just app-test-all` on your own initiative. Run the full corpus only when:

- the user explicitly asks for it, or
- you changed something that runs before any test's first assertion (`tests/app-test/_harness/`, `tugapp/Sources/TestHarness/`, `tugdeck/src/main.tsx`, `tugdeck/index.html`) — no `@covers` line can scope those, so `app-test-changed` prints a **CORE TIER ADVISED** advisory. The answer to that advisory is the ~20-file core tier (`just app-test`), not the full corpus. Run it and move on; it is not a question for the user.

Bare `just app-test` (no arguments) is a curated **core tier** of ~20 tests — one per load-bearing surface — for a fast read on whether the app fundamentally works. It is deliberately not everything. `just app-test <files…>` runs exactly what you name.

### The output is the report

The recipe prints a finished report: a per-file result table, a `Diagnostics:` section carrying every `note()` the tests asked to be seen, a `Failures:` section giving each failure's message and its location in the test file, and a closing `VERDICT:` line. Per-file `bun` streams are suppressed by default (`TUG_APPTEST_STREAM=1` restores them verbatim), so a green one-file run is about twenty lines. There is nothing a filter can extract that the summary has not already extracted.

If you do filter it, know what the filter costs: the pipeline's exit status becomes the filter's, so `just app-test X | grep -A 8 "Failures:"` on a **passing** run prints nothing and exits 1 — a green run that reads as a silent failure. A fixed `-A N` window also truncates the second failure and drops `Diagnostics:` entirely. Reading the report bare is simpler than working around either.

Want a result to compute over rather than read? `TUG_APPTEST_JSON=<path>` writes a document — verdict, totals, per-file status, failures, notes — serialized from the same arrays the text summary renders, so the two cannot drift. It never touches stdout.

The doctrine is in [tuglaws/app-test-harness.md](tuglaws/app-test-harness.md#selection-is-derived-not-remembered); the how-to is in [tests/app-test/README.md](tests/app-test/README.md#choosing-what-to-run).

## Ledger databases — never open live files with sqlite3

Never point the `sqlite3` CLI (or any non-Tug SQLite build) at the live databases under `~/Library/Application Support/Tug/` — a foreign SQLite participating in WAL recovery/checkpointing on a live ledger is a corruption vector (the 2026-07-27 incident). Use `just db-inspect <name|path> ["SQL"]`, which copies the db + WAL/shm to a temp dir and inspects the copy. In Rust, every writable ledger open goes through `tugcore::ledger_db` (enforced by the `no_ad_hoc_ledger_opens` test); shared `changes.db` schema changes require bumping `CHANGES_SCHEMA_VERSION` with a registered migration — never edit the DDL alone.

`apptest_results.db` is the machine-global record of every app-test run — one row per run, one per file in it — keyed by the **resolved base checkout**, so an arc worktree and the checkout it forked from share one history. It exists to answer one question cheaply: every red file in a `Failures:` section arrives with a `history:` line saying whether it was green before you touched it, when it last was, or that it has been red for the last N recorded runs — and, in every case, how big a batch each of those runs was, which is what tells a defect from contention (green alone and red only in batches means re-run it alone before concluding anything). The same object rides `TUG_APPTEST_JSON`. Write and read it only through `tugtool apptest record|history` (`just db-inspect apptest_results "SELECT …"` to look); recording is telemetry that never gates a run, and retention is the most recent 500 runs per checkout, pruned at record time. `TUG_APPTEST_RESULTS_DB` redirects it for test isolation.

`prompt_history.db` is the machine-global, append-only record of every prompt the user has submitted — shared top-level like `changes.db`, deliberately not per-instance, because the corpus belongs to the user rather than to an instance. Inspect it the same way (`just db-inspect prompt_history "SELECT …"`). It is the one ledger with no retention policy at all: nothing trims it, and any change that would drop, cap, or expire a row is a bug in the feature, not a tuning knob. Its schema is gated on `PRAGMA user_version` with a registered migration list in `prompt_ledger.rs` — the same regime as the other shared ledgers.

## Editing repo files from the shell

The contract — the order of preference, the edit program, and the `edit`/`probe`/`run` verbs — ships in `tugplug/file-editing.md` and rides every session's system prompt. That file is the source, and it is written for any project. What is true of this checkout alone:

- The grammar that decides whether a shell command can be attributed is `tugchanges-core::shell_ops` (`tugrust/crates/tugchanges-core/src/shell_ops.rs`), and the gate that denies the shapes it proves unreadable is `tugtool hook pre-tool-use`. The edit-program language is specified in [tuglaws/tugedit.md](tuglaws/tugedit.md).
- The probe shape this repository reaches for is an app-test behind a patch: `tugtool file probe --patch p.diff -- just app-test at0287-….test.ts`.
- **`file probe` advances the mtime, and the corollary is yours to keep.** A source reading older than the artifact built from it is the one staleness direction cargo cannot see, so a build inside a hand-rolled revert leaves stale artifacts behind a clean-looking tree. If you put bytes back by hand, `touch` the files, or the next `cargo build` prints `Finished` having compiled nothing.

## Tugdeck — Theme Token Files

Theme tokens live in `tugdeck/styles/themes/*.css` — `brio`/`nocturne`/`bravura` (dark) and `harmony`/`aria`/`vivace` (light). These are hand-authored CSS files — there is no generation script. Edit them directly when adding or tuning tokens. Each theme is one tint hue over a shared tone skeleton; see `tuglaws/theme-engine.md` for the authoring doctrine. Validate contrast with `bun run audit:theme-contrast` (no theme may exceed the `brio` accessibility budget). Register new themes in `SHIPPED_THEME_NAMES` (`tugdeck/src/action-dispatch.ts`).

## AskUserQuestion — shape and affordances

The shape — 1–4 questions per call, 2–4 options per question, fixed upstream by Claude Code's own schema — ships in `tugplug/ask-user-question.md` and rides every session's system prompt. What is true of this checkout alone is the Tug-side handling: the Session card's question dialog (`tugdeck/src/components/tugways/chrome/session-question-dialog.tsx`) renders any number of options with no cap of its own, and `AskUserQuestionToolBlock` (`tugdeck/src/components/tugways/cards/blocks/ask-user-question-tool-block.tsx`) detects the upstream `InputValidationError` and mounts a salvage path so an overflowing call can still be answered.

## Tugdeck — Tuglaws

Before implementing any tugways/tugdeck code, verify against the [Tuglaws](tuglaws/tuglaws.md) and [Design Decisions](tuglaws/design-decisions.md). Critical laws:

1. **One `root.render()`, at mount, ever.** [L01]
2. **External state enters React through `useSyncExternalStore` only.** [L02]
3. **Use `useLayoutEffect` for registrations that events depend on.** [L03]
4. **Appearance changes go through CSS and DOM, never React state.** [L06]
