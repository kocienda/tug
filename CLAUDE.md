# Claude Code Guidelines for Tugtool

## Project Overview

Tugtool is a developer tool suite. Its centerpiece is the **Session card** — a graphical surface where shell commands and AI interactions coexist in one UI, replacing the terminal. The suite includes tugcast (WebSocket multiplexer), tugcode (Claude Code bridge), tug (the unified developer CLI — changes & commits, dashes, host plumbing), tugdeck (browser frontend), tugplug (agentless skills), and Tug.app (macOS host).

## Git Policy

**ONLY THE USER CAN COMMIT TO GIT.** Do not run `git commit`, `git push`, or any git commands that modify the repository history unless explicitly instructed by the user. You may run read-only git commands like `git status`, `git diff`, `git log`, etc.

**Exceptions:**
- Autonomous implementation: when the user explicitly authorizes autonomous sub-step execution (e.g., "go on your own"), commit after each sub-step using the `/tugplug:draft` skill's message style. Report each commit hash and message.
- The `dash-implement` and `dash-on` skills commit on their **dash worktree** (never on `main`) via `tugutil dash commit`, as part of running a recipe / dash. `main` is only updated by the user's landing gestures.

The `/tugplug:draft` skill **never commits** — it authors the session's landing draft via `tugutil draft set`. Landing is the user's act: `/commit` (main lane) and `/join <name>` (dash lane) in the Session card are the landing gestures.

## Repository Structure

| Directory | Description |
|-----------|-------------|
| `tugrust/` | Rust crates (tugcast, tug, tugexec, tugbank, tugcore, the `*-core` libraries — tugutil-core/tugdash-core/tugchanges-core — and supporting libraries) |
| `tugproto/` | Shared protocol / message types (TypeScript) |
| `tugcode/` | Claude Code bridge (stream-json IPC); bun-compiled binary |
| `tugdeck/` | Web frontend (the Session card lives here) |
| `tugapp/` | Swift macOS app (Tug.app host) |
| `tugplug/` | Claude Code plugin (agentless skills: dash/plan-devise/plan-review/dash-implement/dash-on/dash-join/dash-audit/draft) |
| `tuglaws/` | Architecture laws + design decisions — the curated durable doc surface |
| `dash/` | Implementation plans (recipes) |
| `tests/` | App-test harness that drives the real Tug.app |

## Build Policy

**WARNINGS ARE ERRORS.** The Rust workspace enforces `-D warnings` via `tugrust/.cargo/config.toml`.

- `cargo build` will fail if there are any warnings
- `cargo nextest run` will fail if tests have any warnings
- Fix warnings immediately; do not leave them for later

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

The changed files are **this session's**, not the whole tree's. The selector reads `tugutil changes --json` and selects from the attributed bucket plus any unattributed entry carrying a this-session hint; the **foreign** bucket — files another live session claims — is never selected, so a shared checkout no longer hands you tests for work that isn't yours. When the ledger can't answer (no `TUG_SESSION_ID`, unresolvable session, no built `tugutil`), selection falls back to the whole working tree and prints which fallback it took and why.

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

`apptest_results.db` is the machine-global record of every app-test run — one row per run, one per file in it — keyed by the **resolved base checkout**, so a dash worktree and the checkout it forked from share one history. It exists to answer one question cheaply: every red file in a `Failures:` section arrives with a `history:` line saying whether it was green before you touched it, when it last was, or that it has been red for the last N recorded runs. The same object rides `TUG_APPTEST_JSON`. Write and read it only through `tugutil apptest record|history` (`just db-inspect apptest_results "SELECT …"` to look); recording is telemetry that never gates a run, and retention is the most recent 500 runs per checkout, pruned at record time. `TUG_APPTEST_RESULTS_DB` redirects it for test isolation.

`prompt_history.db` is the machine-global, append-only record of every prompt the user has submitted — shared top-level like `changes.db`, deliberately not per-instance, because the corpus belongs to the user rather than to an instance. Inspect it the same way (`just db-inspect prompt_history "SELECT …"`). It is the one ledger with no retention policy at all: nothing trims it, and any change that would drop, cap, or expire a row is a bug in the feature, not a tuning knob. Its schema is gated on `PRAGMA user_version` with a registered migration list in `prompt_ledger.rs` — the same regime as the other shared ledgers.

## Editing repo files from the shell

`Edit`/`MultiEdit`/`Write` name their file in the tool input, so the change is attributed with certainty. A shell command is only attributed when the grammar in `tugchanges-core::shell_ops` can read which files it names — and **a `python3` heredoc that writes a repo file cannot be read at all.** Heredoc bodies are stripped before parsing (a body is data, not commands), so nothing inside one is evidence of anything. The file lands in the Changes card's `UNATTRIBUTED — NO SESSION CLAIMS THESE` bucket with at best a `likely` hint, and somebody has to press `CLAIM ALL` to repair it by hand. Same for `python3 -c`.

So when an edit does not fit `Edit`/`MultiEdit`, reach for the verbs rather than a scripting language:

```bash
tugutil file edit --path src/x.ts --replace 'old' --with 'new' [--count N] [--regex]
tugutil file edit --patch changes.diff          # or --patch - to read the diff from stdin
tugutil file probe --patch p.diff -- just app-test at0287-….test.ts   # patch, run, restore
```

- **`edit`** performs the substitution or applies the diff itself and prints a `TUG-FILE-RECEIPT` naming exactly the files whose bytes moved, which the relay turns into proof-class rows. A no-match exits non-zero rather than succeeding quietly.
- **`probe`** is the patch → run → revert cycle in one command: it restores bytes *and* mtime afterwards and records nothing, which is strictly better than doing it by hand (a hand-rolled probe leaves a spurious hint on the file it touched). Use it instead of `git checkout --` to revert, which would also destroy any uncommitted work already on those paths.
- `sed -i`, `perl -i`, and `ruby -i` are readable **when every file operand is a literal path**. With a glob or a variable they are denied by the PreToolUse gate and steered here — the gate denies only what the grammar proves it cannot resolve.

## Tugdeck — Theme Token Files

Theme tokens live in `tugdeck/styles/themes/*.css` — `brio`/`nocturne`/`bravura` (dark) and `harmony`/`aria`/`vivace` (light). These are hand-authored CSS files — there is no generation script. Edit them directly when adding or tuning tokens. Each theme is one tint hue over a shared tone skeleton; see `tuglaws/theme-engine.md` for the authoring doctrine. Validate contrast with `bun run audit:theme-contrast` (no theme may exceed the `brio` accessibility budget). Register new themes in `SHIPPED_THEME_NAMES` (`tugdeck/src/action-dispatch.ts`).

## AskUserQuestion — shape and affordances

`AskUserQuestion`'s shape is fixed **upstream by Claude Code's own schema**, not by Tug: **1–4 questions per call, 2–4 options per question** (a hard minimum of 2 and maximum of 4 options). A call outside those bounds fails with an `InputValidationError` inside Claude Code *before* the request is ever forwarded to the Session card — so this is not a constraint Tug can relax by editing anything here.

When generating an `AskUserQuestion` call:
- Give each question **2–4 options**.
- If you have more candidate choices, split them across multiple questions (up to 4 questions per call) — the per-question cap is real, the per-call question count gives you room.

Two rows the terminal renders below the options — **`Type something`** (a free-text answer) and **`Chat about this`** (dismiss the questions and reply in prose) — are harness *affordances*, not options, and don't count against the 2–4 cap. On the answer side they come back as the free-text answer value and the optional top-level `response` field respectively. The Session card's `QuestionDialog` is where Tug renders these (see `chrome/session-question-dialog.tsx`).

Tug-side handling: the `QuestionDialog` renders **any** number of options with no cap of its own — the 2–4 limit lives only in Claude Code upstream. If a call somehow exceeds 4 (e.g. a drifted or hand-crafted payload), `AskUserQuestionToolBlock` detects the `InputValidationError` and mounts a salvage path so the user can still answer. Overflow is therefore graceful, but generate within 2–4 so the round-trip isn't wasted.

## Tugdeck — Tuglaws

Before implementing any tugways/tugdeck code, verify against the [Tuglaws](tuglaws/tuglaws.md) and [Design Decisions](tuglaws/design-decisions.md). Critical laws:

1. **One `root.render()`, at mount, ever.** [L01]
2. **External state enters React through `useSyncExternalStore` only.** [L02]
3. **Use `useLayoutEffect` for registrations that events depend on.** [L03]
4. **Appearance changes go through CSS and DOM, never React state.** [L06]
