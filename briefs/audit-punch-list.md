All five audits are in, and I verified the two load-bearing claims myself (the bare `git --version` probe in the arc engine, and the open CORS plus unauthenticated HTTP API in tugcast). Here is the sketch.

## The shape of it

The codebase is in better mechanical health than its raw numbers suggest. Production Rust has almost no `unwrap` outside tugcast, every file in tugdeck typechecks under `strict`, the single-root and `useSyncExternalStore` laws are honored by structure, test ratios are healthy, and the `-D warnings` regime holds. The weaknesses are not sloppiness. They are gravity: a handful of hub files have absorbed every feature for a year, the seams between the four languages are stringly typed, and the gates that would catch drift are either off or run nowhere.

Five cross-cutting themes account for nearly everything the audits found:

- **Hub files that cannot be split without a plan.** `agent_supervisor.rs` is 14k production lines holding four unrelated subsystems behind one 510-line string match. `ops.rs`, `session.ts`, `deck-manager.ts`, `AppDelegate.swift`, `main.rs` in tugcast, and the 1,102-line `app-test` recipe are the same story. Each has internal section markers that already name the split.
- **Protocol defined by hand on every side.** Outbound frames exist twice in TypeScript with no shared names, `tugproto` covers inbound only, Rust matches 114 CONTROL action strings against 65 in tugdeck, and the deck casts websocket payloads after checking only the type tag. Nothing tests parity anywhere.
- **Gates that exist but are not wired.** The TS linter has `correctness` off and two rules, so 107 disable comments enforce nothing. `just lint` never typechecks. CI runs Rust only, and with a toolchain that ignores the pinned version.
- **Loopback trusted as if it were authentication.** Open CORS on every tugcast route, an eval endpoint and filesystem routes with no session check, and three WebKit message handlers in `MainWindow.swift` that create, trash, or move any path the page names.
- **Duplicated small things.** Five duration formatters, three `clamp`, three `escapeHtml`, three line splitters, 31 test `fn git`, 297 local `deckShape`, two `git --version` parsers, four repo-root resolvers, 98 hand-rolled stores.

## Punch list

**Do first, small and high-value**

1. Require the auth session on every `/api/*` route in `server.rs` and narrow CORS to the app's own origins. The deck's websocket already does this at `router.rs:390`.
2. Root-restrict `openPath`, `trashPath`, and `restorePath` in `MainWindow.swift` to the open project directories and the Tug data root.
3. Route `git_supports_merge_base_flag` and `git_supports_merge_tree` through `tugcore::host_tools` instead of running `--version` on whatever is on PATH, and keep one parser.
4. Turn the linter on. Enable the `react-hooks` and `typescript` categories in `.oxlintrc.json`, then triage the 60 `exhaustive-deps` suppressions into refs.
5. Add `bun run check` for tugdeck, tugcode, and `tests/app-test` to `just lint`, and give the latter two a lint script at all.
6. Add a bun job to CI running `just lint test-ts test-standalone app-test-covers-check`, and let `rust-toolchain.toml` win over the action's `stable`.
7. Load spikes, gallery, fixtures, and `test-surface.ts` behind the existing DEV and test-mode gate with dynamic imports. That is about 37k lines out of the production chunk.
8. One capped `LineSplitter` replacing the three copies in tugcode, plus checking the stdin write result in `session.ts` so a wedged claude cannot grow Bun's buffer unbounded.
9. Lock-poisoning policy for tugcast ledgers. Either `parking_lot` or a `lock_or_recover` helper replacing the 97 `.expect("ledger mutex")` sites.
10. Log the five silently dropped ledger mutations in `agent_supervisor.rs` and observe the dropped `spawn_blocking` handle at line 9137.
11. Unique temp file in `write_atomic` in `ops.rs`, and kill the leaked login shell in `tuggram/src/words.rs` on timeout.
12. Regenerate `THIRD_PARTY_NOTICES.md` from the lockfiles. It lists five libraries Tug does not use and omits Sparkle, which is a real problem for a shipped app.
13. Repo hygiene in one pass: delete the stale `package-lock.json`, the dead `Cargo.lock` ignore rule, unused Cargo deps in four crates, and decide between committed fonts and `fetch-fonts`.

**Medium, each a focused arc**

14. Move the outbound frame types into `tugproto`, import them from tugcode and tugdeck, and add a tag-set parity test. Then typed CONTROL request and reply enums in `tugcast-core` with a drift test against the TS union, the way `stream_json_catalog_drift.rs` already does for Claude frames.
15. Structural guards at the deck's websocket boundary in `code-session-store.ts` so a field drift is a logged decode error, not a reducer exception.
16. Type the Claude stream-json wire once from the captured catalog, retiring the 126 casts in `session.ts`.
17. An async `LedgerHandle` facade so SQLite and the 2-second blocking `ureq` forward never run on a tokio worker under a std mutex.
18. One `control_frame` helper replacing 82 copy-pasted emitters, and a `SupervisorDeps` struct replacing `LEDGER_HANDLE` and the late-bound `OnceLock` wiring.
19. A `--json` error envelope for every tugtool verb. Today 16 sites print raw and most errors go to stderr, so a `--json` caller gets nothing to parse.
20. Drop the cwd-reading wrappers from `tugarc-core` so its 217 `#[serial]` tests can parallelize, and a shared hermetic `git()` fixture that sets `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM`.
21. One owner for shared-ledger DDL and version in `tugcore`. `draft.rs` currently creates a table with no migration regime, and test DDL is pasted five times.
22. Break the two import cycles in tugdeck by moving two constants out of component files and splitting the pure formatters out of `session-card-telemetry-renderers.tsx`. Then a lint rule forbidding `lib` to import from `components`.
23. A shared store base for the 98 hand-rolled subscribe and notify implementations, and a cap on reducer growth so a day-long session does not grow memory linearly.
24. Move the `app-test` recipe out of the Justfile into a script shellcheck and the existing script tests can reach, kill the process group on wedge, and base the cap on a median rather than the last run.
25. Lift the 83 byte-identical harness helpers into `_harness/`, route pixel and timing thresholds through one tolerance table, and tag motion files so the selector can keep them out of contended batches.
26. An XCTest target for the pure-logic Swift. There are zero Swift unit tests today.

**Large, the arcs that unblock the rest**

27. Split `AgentSupervisor` into control-handler modules behind a registry instead of the string match. This is the one that makes every other tugcast change cheaper.
28. Split `ops.rs` along its seven clusters and give the arc engine a typed error. Today a typed error is flattened to `String` on the first hop, so tugtool cannot map causes to exit codes.
29. Split `session.ts` by concern, inject the spawner, and replace the eight mode booleans with one phase enum. The 223 private pokes in its test file are the measure of the current coupling.
30. Carve `deck-manager.ts` along its own section markers and add a fast unit layer under `deck-canvas`, `settle-engine`, `tug-sheet`, and `card-host`, which today have only minutes-long app-test coverage.
31. Extract `MenuBuilder` and `BridgeHandler` from `AppDelegate.swift`, and shrink tugcast's 2,280-line `main` to builders.

**Doc drift, cheap but worth a sweep**

32. Fifteen stale code paths in `tuglaws`, two unsynced `work-grammar.md` files, the git policy restated in 11 places, 38 duplicate app-test numbers, and `tugplug-lint` promising a hash rule it does not have. Extend the existing index-coverage test to resolve backticked paths, and add a numbering uniqueness check to `app-test-covers-check`.

If you want to turn any slice of this into a brief, items 1 through 7 are the ones I would not leave for later.

## Briefs

The **Do first** items are briefed as seven independent arcs. Each brief records where reading the code corrected the punch list.

| Brief | Items | Arc |
|---|---|---|
| [`loopback-trust-boundary-brief.md`](loopback-trust-boundary-brief.md) | 1, 2 | `/arc loopback-trust-boundary @briefs/loopback-trust-boundary-brief.md` |
| [`lint-and-ci-gates-brief.md`](lint-and-ci-gates-brief.md) | 4, 5, 6 | `/arc lint-and-ci-gates @briefs/lint-and-ci-gates-brief.md` |
| [`dev-only-code-out-of-bundle-brief.md`](dev-only-code-out-of-bundle-brief.md) | 7 | `/arc dev-only-code-out-of-bundle @briefs/dev-only-code-out-of-bundle-brief.md` |
| [`arc-engine-hardening-brief.md`](arc-engine-hardening-brief.md) | 3, 11 | `/arc arc-engine-hardening @briefs/arc-engine-hardening-brief.md` |
| [`tugcode-line-splitter-brief.md`](tugcode-line-splitter-brief.md) | 8 | `/arc tugcode-line-splitter @briefs/tugcode-line-splitter-brief.md` |
| [`ledger-locks-and-dropped-writes-brief.md`](ledger-locks-and-dropped-writes-brief.md) | 9, 10 | `/arc ledger-locks-and-dropped-writes @briefs/ledger-locks-and-dropped-writes-brief.md` |
| [`repo-hygiene-and-notices-brief.md`](repo-hygiene-and-notices-brief.md) | 12, 13 | `/arc repo-hygiene-and-notices @briefs/repo-hygiene-and-notices-brief.md` |

Corrections the briefs carry against the list above:

- **Item 1.** A cookie on every `/api/*` route would break `tugtool`, the changes forwarder, and `deck motion`. The brief gates on browser markers instead.
- **Item 7.** A maker build can serve the prebuilt bundle when Vite is not ready, so the gate also reads the host's maker-mode flag.
- **Item 12.** The five "unused" libraries are legitimate L21 pattern credits. The gap is Sparkle and the npm and cargo trees.
- **Item 13.** Committed fonts and wasm `pkg/` are documented decisions, and both are non-goals.

The **Large** items are briefed as six arcs. Item 31 bundled two codebases and is two briefs.

| Brief | Item | Arc |
|---|---|---|
| [`agent-supervisor-split-brief.md`](agent-supervisor-split-brief.md) | 27 | `/arc agent-supervisor-split @briefs/agent-supervisor-split-brief.md` |
| [`arc-ops-split-and-typed-error-brief.md`](arc-ops-split-and-typed-error-brief.md) | 28 | `/arc arc-ops-split-and-typed-error @briefs/arc-ops-split-and-typed-error-brief.md` |
| [`tugcode-session-split-brief.md`](tugcode-session-split-brief.md) | 29 | `/arc tugcode-session-split @briefs/tugcode-session-split-brief.md` |
| [`deck-manager-carve-and-chrome-tests-brief.md`](deck-manager-carve-and-chrome-tests-brief.md) | 30 | `/arc deck-manager-carve-and-chrome-tests @briefs/deck-manager-carve-and-chrome-tests-brief.md` |
| [`appdelegate-extraction-brief.md`](appdelegate-extraction-brief.md) | 31 | `/arc appdelegate-extraction @briefs/appdelegate-extraction-brief.md` |
| [`tugcast-boot-builders-brief.md`](tugcast-boot-builders-brief.md) | 31 | `/arc tugcast-boot-builders @briefs/tugcast-boot-builders-brief.md` |

Corrections the Large briefs carry against the list above:

- **Item 27.** No registry or trait. The families become child modules of `agent_supervisor/`, which see the parent's private fields, so the split is a pure move and the string match becomes a one-level delegation.
- **Item 29.** Only the six process-lifecycle booleans become a phase enum. `replayActive` and `isInWake` are orthogonal modes and stay.
- **Item 31.** The 96 `@objc` actions stay on `AppDelegate` as forwarders, since AppKit owns their selector and validation wiring. The tugcast `main` is 2,166 lines, not 2,280.
- **Ordering.** `agent-supervisor-split` and `tugcast-boot-builders` both touch the supervisor's construction. Run them one after the other in either order, never concurrently.

The **Medium** and **Doc drift** items are not briefed yet.