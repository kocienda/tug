<!-- brief-skeleton v1 -->

# A `--json` error envelope for every tugtool verb

**Purpose:** `tugtool --json` prints a structured envelope on success from eleven of nineteen verbs and almost never on failure: errors go to stderr as `error: …` with an exit code, so a caller that asked for JSON gets nothing to parse when the answer is no. The app-test fixtures already match stderr substrings to find out what went wrong.

---

## Purpose {#purpose}

Item 19 of `briefs/audit-punch-list.md`:

> 19. A `--json` error envelope for every tugtool verb. Today 16 sites print raw and most errors go to stderr, so a `--json` caller gets nothing to parse.

Exit codes do not change. The text a human sees without `--json` does not change. What changes is that `--json` means JSON on both outcomes.

---

## Evidence {#evidence}

**[F01] The envelope exists and has no error printer** — `tugrust/crates/tugtool/src/output.rs` (97 lines): `JsonResponse<T>` with `schema_version`, `command`, `status`, `data`, `issues` (:8-20), `ok` (:24), `error` (:35), `JsonIssue` with `code`, `severity`, `message`, and optional `file`, `line`, `anchor` (:55-72), and `print_ok` (:49-52). `print_ok` has 48 callers (`arc.rs` 29, `changes.rs` 6, `session.rs` 6, `draft.rs` 4, `plan.rs` 2, `brief.rs` 1). `JsonResponse::error` has 5 (`plan.rs:122`, `tell.rs` ×4). There is no `print_error`. **(verified)**

**[F02] 24 print sites in 16 files bypass `output.rs`** — 11 build the envelope by hand and print it raw (`plan.rs:128`, `init.rs` ×3, `tell.rs` ×5, `state_dir.rs:28`, `gate.rs:327` with a hand-written `status: "held"`); 13 print no envelope (`changesets.rs:28` passes an HTTP body through, `deck_motion.rs` ×3, `deck_motion_walk.rs` ×2, `deck_motion_slide.rs`, `deck_motion_settle.rs`, `instance.rs:521`, `sweep.rs:26`, `test_ledger_cli.rs:150`, `apptest.rs:97-99`). **(verified)**

**[F03] Every dispatcher's failure path is `eprintln!` and an exit code** — `changes::finish` (`changes.rs:86-104`) prints `error: {msg}` and returns 1, 2, or 3 without reading `json`; `arc::dispatch` (`arc.rs:23-136`) does the same at :25, :129-135, and :167-170; `host.rs:52-57`, `deck.rs:17-22`, `session.rs:55-60` likewise. `AppError` (`changes.rs:24-36`) carries a message and an exit code and nothing else; `arc::exit_code_for` (:146-152) maps `ArcError` variants to 2 (`InvalidName`, `NotFound`), 3 (`Blocked`, `Conflicted`, `Refused`), 1 (`Git`, `Io`). Distinct exit codes across the binary: 0, 1, 2, 3, plus pass-through. **(verified)**

**[F04] `--json` is global and declared twice more** — `cli.rs:122-123` `global = true`; redeclared on `ApptestCommands::History` (:443) and `HostCommands::Sweep` (:1577). Nineteen top-level verbs; by success output, 11 use the envelope, host is mixed, and deck, apptest, test, file, hook, progress print none. **(verified)**

**[F05] The consumers parse success and grep failure** — `tests/app-test/_harness/arc-fixture.ts` reads `.data.id` and `.data.worktree` from `arc record --json` (:498-509) and detects failures by stderr substrings (`index.lock` at :149-155, `unknown_session` and "no segment of its line is live" at :851-903). `tugplug`'s skills tell the agent to run `--json` in fourteen places and describe failures by exit code only. No tugdeck or tugapp code runs `tugtool --json`. The envelope shape is documented nowhere outside `output.rs`'s comments; `tuglaws/tracking-changes.md:317` says only that its fields are additive. **(verified)**

---

## Decisions {#decisions}

**[B01] `output::print_error(command, error: &AppError)` writes `JsonResponse::error` to stdout with `issues[0] = { code, severity: "error", message }`, and every dispatcher calls it when `json` is set, keeping the same `ExitCode`.** stderr stays what it is when `--json` is absent; with it, the human line is suppressed and the envelope carries the message. Exit codes are the contract the skills already document ([F05]) and do not move.

**[B02] `AppError` gains a machine `code: &'static str` beside its message, populated by the `From` impls from the typed errors that already exist.** `ArcError::NotFound` becomes `"arc_not_found"`, the refusal in [F05] becomes `"unknown_session"`, the git lock becomes `"git_index_locked"`. The app-test fixture's three substring matches become `issues[0].code` reads, which is the test that the codes are the right ones. A code that no caller reads is still named, because the next caller will.

**[B03] The 24 bypass sites go through `print_ok` or `print_error`, and `apptest history`, `test last`, `sweep`, and the four `deck motion` verbs gain the envelope around the body they print today.** [F02]. `changesets.rs`'s HTTP pass-through wraps the body as `data`. `gate`'s `"held"` becomes a third `status` value in `JsonResponse`, since a held gate is neither success nor failure and the envelope should be able to say so. The two redundant `--json` flags in [F04] go.

**[B04] The envelope is written down in `tuglaws/tugtool-json.md`: the five fields, the three statuses, the rule that `issues[0].code` is the machine-readable cause, the rule that fields are additive, and the exit-code table.** [F05]: a contract four consumers follow should exist as a sentence somewhere other than a struct comment.

**[B05] The gauge is one integration test per dispatcher that forces its failure path with `--json` and asserts the envelope parses with `status: "error"` and a non-empty `code`, plus a test that `print_ok` and `print_error` are the only `println!` of a `JsonResponse` in the crate.** The second test is what keeps a 25th bypass site from appearing.

---

## Open Questions {#open-questions}

- None. Which verbs exist, what they print, and who reads it are all in the code.

---

## Non-goals {#non-goals}

- **Changing any exit code.** [B01].
- **Changing the non-`--json` text.** Humans and the skills read it.
- **Structured `data` on errors.** The envelope allows it; no caller needs it yet, and adding it per verb is a later arc's call.

---

## Exit {#exit}

An arc. Steps: `print_error` and the `code` field with the dispatcher cut-over ([B01], [B02]); the bypass sweep ([B03]); the doc ([B04]); the tests ([B05]), with the app-test fixture's substring matches converted in the same step as the codes they read. `cargo nextest run -p tugtool` is each step's verdict; `just test-standalone` runs after the dispatcher step because the plugin's hook and skills drive these verbs from an empty PATH; the `@covers`-derived app-test selection for `arc-fixture.ts` runs once after the fixture conversion.
