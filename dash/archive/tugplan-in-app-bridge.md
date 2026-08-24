<!-- tugplan-skeleton v2 -->

## In-App Test Bridge {#phase-in-app-bridge}

**Purpose:** Build the DEBUG-only Tug.app ↔ bun test runner bridge that lets tests drive the real WKWebView inside Tug.app. Ships the Swift side (env-var detection, Unix-socket listener, `WKUserScript` for `__tugTestMode`, `evalJS` / `waitForCondition` RPC handlers) plus the TypeScript side (`DeckManager.testMode` flag, `window.__tug` surface, bun harness library). Phase 3 of the parent [In-App Test Harness plan](../.tugtool/tugplan-in-app-test-harness.md) consumes this bridge to author AT0001/AT0003/AT0016 regression tests.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-04-23 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The parent plan's Phase 1 (deck-trace instrumentation) has landed; Phase 3 (three AT-series regression tests) needs a test runner that can drive the real Tug.app WKWebView. happy-dom, Playwright-WebKit, and Safari-in-isolation are all wrong-engine-in-wrong-process (see parent plan [#context]). The only honest harness runs the same binary users run, inside the same WKWebView tugdeck renders into, under the same `WKWebViewConfiguration`.

This plan delivers that bridge. Every piece of it is DEBUG-build-only on both halves independently ([D03] in the parent plan, tracked here as [D01]): the Swift side is `#if DEBUG`-bracketed at file scope; the TypeScript side is gated by `import.meta.env.DEV && window.__tugTestMode`. Release binaries contain no bridge code, no socket listener, no `window.__tug`, no `DeckManager.testMode` codepath.

Three concerns drive the design. (1) **Boot timing** must be deterministic: `testMode` is decided before tugdeck's first line of JS via `TUGAPP_TEST_SOCKET` env var + `WKUserScript` at `atDocumentStart`, not via a post-connect bridge message. (2) **Transport** must preserve the DEBUG guard: this plan's first investigation decides whether to reuse tugcast's WebSocket multiplexer or stand up a parallel Unix socket (see [Q01]/[D02]). (3) **Waiting** is condition-based only: `waitForCondition` is the sole primitive; `setTimeout` is banned in test and harness code ([D07]).

#### Strategy {#strategy}

- **One Swift commit, then one TypeScript commit, then one harness commit.** Each reviewable in isolation. The transport choice from [D02] determines the shape of the Swift commit but not its cadence.
- **Transport investigation first.** Task 1 assesses tugcast reuse in concrete terms (see [#transport-investigation]). Decision lands as [D02] before any Swift code is written.
- **Two guard walls, not one.** Swift `#if DEBUG` and TypeScript `import.meta.env.DEV + __tugTestMode` are independent; neither defends alone. This is load-bearing per parent plan [R01].
- **Versioned surface from day one.** `__tug.version = "1.0.0"` compile-time constant. Harness asserts on connect. Every future extension bumps the version (parent plan [D11]).
- **Hand-written typed RPC client.** Two methods (`evalJS`, `waitForCondition`) — codegen is larger than the hand-written version. See [D05].
- **Socket-path security is declared, not vague.** Mode 0600, parent-dir ownership check, stale-unlink only if same-user-owned. See [D06].
- **Fidelity limits documented in writing.** Synthesized events are `isTrusted: false`; any behavior the harness cannot drive is called out before the first test is written. `CGEventPost` escape hatch is deferred ([D08]).
- **T-1 / T-2 stay in Phase 2.** Resolved in [Q02] / [D03] below: keeping `DeckManager.testMode` and `window.__tug` under this tugplan's umbrella keeps the Phase 2 Swift-and-TypeScript boundary coherent.

#### Success Criteria (Measurable) {#success-criteria}

- `TUGAPP_TEST_SOCKET=/tmp/tugapp-test-<uuid>.sock` launched Tug.app subprocess responds to `evalJS("1+1")` with `{ ok: true, value: 2 }`. (Verified: `bun test tests/app-test/smoke.test.ts` exits 0.)
- `window.__tugTestMode` is observable in `main.tsx` before `new DeckManager(...)` is constructed. (Verified: Swift-side unit test asserts WKUserScript injection timing; tugdeck-side log line.)
- `window.__tug.version === "1.0.0"` assertion passes on handshake; mismatched harness version throws `VersionSkewError`. (Verified: unit test on harness client + one mismatched-version test.)
- Release-build binary of Tug.app contains zero bytes of bridge code. (Verified: `wc -c` diff before/after; `strings` grep for `TUGAPP_TEST_SOCKET` / `evalJS` on release archive.)
- `tests/app-test/` runs under `bun test` in isolation from the tugdeck happy-dom suite. (Verified: `bun test` in `tugdeck/` does not load in-app tests; `bun test tests/app-test/` does not load happy-dom tests.)
- `waitForCondition(script, { timeoutMs: 100 })` on a never-truthy script throws `TimeoutError` within budget. (Verified: harness unit test with a stub transport.)
- `app.close()` on SIGINT leaves no stray Tug.app subprocess, no stale socket file. (Verified: manual + ps/lsof check in smoke test.)

#### Scope {#scope}

1. Swift-side env-var detection: read `TUGAPP_TEST_SOCKET` in `main.swift` (or equivalent entry point); gate behind `#if DEBUG` at file scope.
2. Swift-side transport listener per [D02] (tugcast reuse OR parallel Unix socket). Per-connection handler that reads newline-delimited JSON requests and writes responses.
3. Swift-side `evalJS` handler: forward `script` to `WKWebView.evaluateJavaScript`, serialize result or error per Spec [#s02-rpc-protocol].
4. Swift-side `waitForCondition` handler: poll loop running server-side, dispatching `evalJS` under the hood until script returns truthy or timeout. Bounded poll; hard-timeout termination.
5. Swift-side `WKUserScript` injection: `window.__tugTestMode = true` at `atDocumentStart`, only when `TUGAPP_TEST_SOCKET` is set.
6. Swift-side Web Inspector enablement in test mode (`configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")`).
7. Swift-side unit test that asserts `__tugTestMode` is readable before tugdeck's first script tag evaluates (see [#wkuserscript-timing-test]).
8. TypeScript-side `DeckManager.testMode?: boolean` constructor option with tugbank read/write guards and `seedDeckState(args)` method (parent plan [D02] / Spec [#s05-testmode-semantics]).
9. TypeScript-side `window.__tug` surface implementing `TugTestSurface` (parent plan Spec [#s03-tug-surface]).
10. TypeScript-side `main.tsx` integration: read `window.__tugTestMode` at module top level; pass `testMode: true` to `new DeckManager(...)`; attach `window.__tug` only under the double guard.
11. bun harness library at `tests/app-test/_harness/`: `launchTugApp`, typed RPC client, `toContainOrderedSubset` matcher, gesture/reset/seed wrappers, error classes (`TimeoutError`, `AppCrashedError`, `VersionSkewError`).
12. `tests/app-test/` workspace config: `tsconfig.json`, `bun test` glob, `logs/` directory (gitignored), exclusion from `tugdeck/` happy-dom suite.
13. One trivial smoke test: `launchTugApp → evalJS("1+1") → close` at `tests/app-test/smoke.test.ts`.

#### Non-goals (Explicitly out of scope) {#non-goals}

- The AT0001/AT0003/AT0016 regression tests themselves. They land under parent plan Steps 13–15, consuming this bridge.
- `CGEventPost` hardware-event synthesis. Deferred to a follow-up plan per parent [Q03] / this plan [D08].
- CI integration of `tests/app-test/`. First target is local-dev `bun test tests/app-test/` on macOS.
- Multi-window support. Tug.app is single-window; harness and `__tug` are not keyed per-window.
- EM-card support (tide-card contentEditable with tugcode running). Phase 3 stays FC-only.
- Replacing the tugdeck happy-dom test suite. Pure-logic unit tests stay on happy-dom.
- Extending the `__tug` surface beyond Spec [#s03-tug-surface]. Additions require a version bump and a tugplan follow-up.
- Windows / Linux harness paths. Tug.app is macOS-only; harness is macOS-only.

#### Dependencies / Prerequisites {#dependencies}

- Parent plan Step 1 (`deck-trace.ts`) and Step 2 (recording sites) landed. The `__tug` surface's trace-access methods (`getDeckTrace`, `markDeckTrace`, `clearDeckTrace`, `enableDeckTrace`) delegate to `deckTrace`.
- Parent plan Step 3 decision ([D13]): whichever fix path wins — patched `[A3]` or accelerated Step 23B — Phase 3 tests will assert against it. This plan's harness supports both outcomes; neither is load-bearing for Phase 2 work.
- `focus-transfer.ts` / `ActivationTarget` (tugplan-selection Step 23A). Surface-level imports only.
- Xcode with Swift 5.9+ (matches current `tugapp/` toolchain).
- bun ≥ 1.0 on macOS (existing tugdeck requirement).

#### Constraints {#constraints}

- **DEBUG-build-only guard is load-bearing, not defense-in-depth.** Parent plan [R01]; enforced independently on both halves.
- **Local Unix socket only.** No TCP. Socket mode 0600; parent-dir ownership check at bind. Parent [R02]. Also applies if [D02] resolves to tugcast reuse: the reused control-frame verb is still behind a DEBUG gate.
- **No `setTimeout`-based waiting in test or harness code.** `waitForCondition` is the sole primitive. Parent plan [D12].
- **No new happy-dom tests for UI / focus / selection / DOM-timing behavior.** Codified in feedback memory; enforced at review.
- **Single WebView assumption.** Harness and `__tug` are not keyed per-window.
- **macOS only.** Tug.app is macOS-only; no Linux/Windows path.
- **One app launch per test file.** Per parent plan [#l03-lifecycle-behaviors]. Tests within a file share the subprocess and reset explicitly per parent [D01].

#### Assumptions {#assumptions}

- `WKUserScript` at `atDocumentStart` fires before any tugdeck JS runs; `window.__tugTestMode` is readable in `main.tsx` before `DeckManager` is constructed. Verified by [#wkuserscript-timing-test].
- bun's subprocess APIs (`Bun.spawn`) are stable enough on macOS to launch and reap Tug.app.
- tugcast's WebSocket multiplexer is the first candidate for transport reuse; the investigation in Task 1 determines whether it passes the DEBUG-guard-cleanness bar.
- `WKWebViewConfiguration` does not need to change between release and test modes beyond enabling Web Inspector and the `__tugTestMode` user script.
- newline-delimited JSON (NDJSON) framing is sufficient; no length-prefix needed on local Unix sockets because we never hit the 64KB SO_SNDBUF wall with these payload sizes.
- Script payloads are bounded by `evalJS` ergonomics (tests assemble a few-hundred-byte scripts); no streaming mode needed.
- Tug.app on SIGTERM closes its WebView cleanly; harness subsequent `evalJS` observes EOF and rejects with `AppCrashedError`.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the conventions in [`tuglaws/tugplan-skeleton.md`](../tuglaws/tugplan-skeleton.md). Cross-plan references use the parent plan's anchor IDs (`[D03]`, `[R01]`, etc.) fully qualified in prose where ambiguous; within-plan decisions/questions/risks use this plan's local IDs renumbered from `01`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Transport: reuse tugcast's WebSocket multiplexer, or stand up a parallel Unix socket? (DECIDED) {#q01-transport-choice}

**Question:** Tug.app embeds tugcast's WebSocket multiplexer for runtime control frames. Can a DEBUG-only test-mode channel piggyback on tugcast, or does the test bridge need its own Unix socket transport? Reuse means one transport, one lifecycle; parallel means cleaner DEBUG-only separation.

**Why it matters:** Mixing the test channel with the production runtime transport risks blurring the DEBUG guard — a leak anywhere on the tugcast side leaks the test channel too. A parallel Unix socket is structurally cleaner but adds a second listener.

**Investigation performed (Task 1):**

- tugcast's main transport is axum-over-HTTP with WebSocket upgrade on `/ws` (`tugrust/crates/tugcast/src/server.rs`, `router.rs`). Clients reach it over **TCP**, authenticated via bearer tokens; control frames ride the same WebSocket connection as data feeds.
- The WebSocket handler path has no natural `#if DEBUG` / `#[cfg(debug_assertions)]` boundary. Adding a DEBUG-only control-frame verb means every release build's `ws_handler` reads the frame-kind byte of arbitrary incoming frames before the DEBUG check rejects the verb. That is not the same guard as "no code for this verb ships to release."
- tugcast exposes a secondary Unix-socket surface (`tugrust/crates/tugcast/src/control.rs`) for tugrelaunch progress — a different protocol, not a multiplexer. Not a candidate for reuse.
- Parent plan [R02] pins the bridge to local Unix socket only, mode 0600, parent-dir ownership checked. tugcast's TCP-plus-bearer model is a different security model; bolting the test verb onto it means the bridge inherits a TCP attack surface it was specifically designed not to have.
- Tug.app already contains `tugapp/Sources/ControlSocket.swift` — a `ControlSocketListener` that creates `socket(AF_UNIX, SOCK_STREAM, 0)`, binds a `sockaddr_un`, listens, and accepts via `DispatchSourceRead`. The parallel-socket pattern is already in the codebase and works.

**Options considered:**
- **Reuse tugcast.** Add a DEBUG-only control-frame verb to `ws_handler`. *Rejected* — blurs the DEBUG guard and imports tugcast's TCP-plus-bearer model into the bridge's security boundary.
- **Parallel Unix socket.** New DEBUG-only listener in `tugapp/`, bound to `TUGAPP_TEST_SOCKET` path with mode 0600. *Selected* — structurally cleaner, reuses the existing `ControlSocket.swift` pattern, keeps the DEBUG guard at file scope.

**Resolution:** DECIDED — parallel Unix socket. See [D02] below for the decision record.

#### [Q02] Should `DeckManager.testMode` and `window.__tug` land under Phase 1 of the parent plan instead of Phase 2? (DECIDED) {#q02-t1-t2-placement}

**Question:** Parent plan [Q02] deferred this placement decision to this tugplan. Should T-1 (`DeckManager.testMode`) and T-2 (`window.__tug` surface) land during parent Phase 1 (alongside the deck-trace module), leaving Phase 2 as a Swift-only boundary?

**Why it matters:** Placement affects reviewer ergonomics and the natural Swift-vs-TypeScript commit grouping.

**Options considered:**
- **Move T-1 / T-2 to parent Phase 1.** Cleaner Swift-only Phase 2 boundary; TypeScript work consolidates with the trace module.
- **Keep T-1 / T-2 in this tugplan.** All test-mode wiring stays under one umbrella; the Swift side has concrete TypeScript scaffolding to talk to from day one. *Selected.*

**Resolution:** DECIDED — keep T-1 / T-2 in Phase 2 (this tugplan). Rationale: the Swift bridge's first `evalJS` round-trip (parent Step 7) is meaningfully testable only once `window.__tugTestMode` and `window.__tug` exist. Splitting them across phases means parent Step 7 lands with the Swift side alive but nothing to talk to on the TypeScript side — a half-landed state that makes review harder, not easier. The parent plan's Step 5–7 ordering (testMode flag, `__tug` scaffold, transport) already sequences this correctly. See [D03] below.

#### [Q03] `CGEventPost` escape hatch — do any of AT0001/AT0003/AT0016 require it? (DEFERRED) {#q03-cgeventpost-needed}

**Question:** Synthesized PointerEvent/MouseEvent/InputEvent dispatches set `isTrusted: false`. If any of AT0001/AT0003/AT0016 hits a WebKit behavior gated on `isTrusted: true`, this harness cannot drive it.

**Why it matters:** Building `CGEventPost` is real work (Swift-side macOS event-stream posting, accessibility permission handling). Doing it speculatively bloats Phase 2; skipping when a test needs it blocks Phase 3.

**Resolution:** DEFERRED to parent plan Phase 3 observation. Tracked as this plan's [D08] fidelity-limit documentation. If a test cannot be made reliable via synthesized events, a follow-up plan adds `CGEventPost`.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Swift bridge code leaks to release binary | critical | low | `#if DEBUG` at file scope; CI grep check; binary-size diff in exit criteria | Any tugapp/ PR touching bridge-adjacent files |
| Unix socket permissions misconfigured | high | low | Mode 0600 at bind; parent-dir ownership check; stale-unlink gated on same-user-owned | Any change to socket-path handling |
| Boot-time race between `WKUserScript` and tugdeck first script | high | low | `atDocumentStart` timing + Swift unit test asserting readability | Any change to `WKWebViewConfiguration` or main-frame load order |
| Bridge subprocess hangs on stuck script | medium | medium | Per-call hard timeout in Swift (not relying on bun client); kill subprocess on repeated timeout | >1 harness hang observed locally |
| Version drift between `__tug` surface and harness client | medium | medium | Compile-time `version` constant; handshake throws `VersionSkewError` | Any PR touching `TugTestSurface` |
| `tests/app-test/` accidentally loaded by tugdeck happy-dom suite | medium | low | Separate `tsconfig.json`; bun test glob excludes `tests/app-test/` from tugdeck; tugdeck root glob excludes `tests/app-test/` | Any change to bun test config or tsconfig include paths |

**Risk R01: Swift bridge code leaks to release binary** {#r01-swift-release-leak}

- **Risk:** A `#if DEBUG` bracket is forgotten on a bridge-touching file (or misplaced inside a function body where only part of the code is gated), shipping socket listener or `__tugTestMode` mapping to end-user release builds.
- **Mitigation:**
  - Every bridge-touching Swift file is opened at line 1 inside `#if DEBUG ... #endif`. Partial-file gating is prohibited; the whole file, top to bottom, is under the bracket.
  - CI grep: `grep -rL '#if DEBUG' tugapp/Sources/TestHarness*` returns no files. Any file matching `TestHarness*` without the top-line bracket fails CI.
  - Binary-size diff vs pre-Phase-2 baseline is a phase exit criterion.
  - Release-archive `strings` grep for `TUGAPP_TEST_SOCKET` returns zero matches.
- **Residual risk:** A build misconfiguration where DEBUG is set in a release archive would still leak the code. Accepted — trapped by Xcode archive review.

**Risk R02: Bridge subprocess hang cascading into test-run hang** {#r02-subprocess-hang}

- **Risk:** A script passed to `evalJS` deadlocks (awaits a promise that never resolves, throws and swallows, etc.). Without a hard timeout, the entire test run hangs until the runner's outer timeout kills it.
- **Mitigation:**
  - Hard per-call timeout enforced server-side (Swift side), not just on the bun client. Default 5000ms for `evalJS`, 2000ms for `waitForCondition`.
  - On timeout, Swift sends a cancellation result to the client (so the bun-side RPC promise resolves into `TimeoutError`) and logs the script contents to `tests/app-test/logs/<test>.log`.
  - After three consecutive timeouts from the same connection, the Swift side closes the connection; harness client observes EOF and throws `AppCrashedError`, forcing a subprocess relaunch.
- **Residual risk:** A subprocess that deadlocks WITHOUT returning from `evaluateJavaScript`'s completion handler (e.g. WebKit internal deadlock) would not honor the Swift-side timeout. Very unlikely; trapped by the external bun test-runner timeout as backstop.

**Risk R03: `__tug` surface shape drift** {#r03-surface-drift}

- **Risk:** `__tug` gains methods over time; harness client forgets to update; tests call missing methods and get `undefined is not a function` errors that look like transport failures.
- **Mitigation:**
  - `__tug.version = "1.0.0"` is a compile-time constant (not a string field looked up at runtime). Vite dead-code-removes old versions.
  - Harness client asserts `__tug.version === expectedVersion` on connect; mismatch throws `VersionSkewError`.
  - Every PR touching `TugTestSurface` bumps the version and updates the harness client in the same commit.
- **Residual risk:** A breaking change that forgets the version bump. Caught by failing smoke test.

**Risk R04: Socket-path collision across concurrent test runs** {#r04-socket-collision}

- **Risk:** Developer runs two `bun test tests/app-test/` in parallel; second hits bind failure if they share a fixed path.
- **Mitigation:**
  - Harness generates socket path as `/tmp/tugapp-test-${uuid}.sock`; uuid per `launchTugApp` invocation.
  - `launchTugApp` sets `TUGAPP_TEST_SOCKET` on the spawned process's env, not process-global.
  - Socket file unlinked on `app.close()`; `process.on("exit")` does synchronous unlink as last resort.
- **Residual risk:** Crashed harness run leaves stale socket. Next run's bind sees `EADDRINUSE` and unlinks (after ownership check), then retries.

---

### Design Decisions {#design-decisions}

#### [D01] DEBUG-only guard applies at file scope on Swift, at two-layer gate on TypeScript (DECIDED) {#d01-debug-guard-placement}

**Decision:** Every Swift source file that contains bridge code begins with `#if DEBUG` at line 1 and ends with `#endif` at the last line. Partial-file gating is prohibited. On the TypeScript side, every touchpoint of `window.__tug` / `window.__tugTestMode` is gated by BOTH `import.meta.env.DEV` (so Vite dead-code-removes for release bundles) AND a runtime `window.__tugTestMode === true` check (so dev builds without test mode still don't attach the surface).

**Rationale:**
- File-scope bracketing makes guard coverage reviewable in one pass: `grep -L '#if DEBUG' tugapp/Sources/TestHarness*.swift` lists files missing the guard; any hit is a blocker.
- Two independent TypeScript guards mean misconfiguring one half (e.g. `__tugTestMode` accidentally true in dev) still doesn't attach the surface in production, and vice versa.
- Parent plan [R01] demands load-bearing, not defense-in-depth. Both halves provably absent from release builds.

**Implications:**
- All bridge Swift files live in `tugapp/Sources/TestHarness/` (a new directory), each file wrapped top-to-bottom.
- Xcode project adds the `TestHarness/` directory to the compile sources of the app target; `#if DEBUG` does the rest.
- TypeScript glue in `tugdeck/src/main.tsx` uses the idiom `if (import.meta.env.DEV && (window as any).__tugTestMode === true) { ... }` at every attach point.
- CI adds a `grep` check: any file under `tugapp/Sources/TestHarness/` without a top-line `#if DEBUG` fails the PR.

#### [D02] Parallel Unix socket transport, not tugcast reuse (DECIDED) {#d02-transport-parallel-socket}

**Decision:** Stand up a parallel DEBUG-only Unix socket listener in `tugapp/Sources/TestHarness/TestHarnessBridge.swift`. Do not reuse tugcast's WebSocket multiplexer for the test channel.

**Rationale:** See investigation in [Q01]. Three concrete findings:
- tugcast's WebSocket handler runs in every build, not just DEBUG. Adding a DEBUG-gated verb leaves the frame-kind dispatch in release binaries — "the verb is rejected" is weaker than "no code for this verb ships."
- tugcast is TCP + bearer-token by design. Parent plan [R02] pins the bridge to local-only Unix sockets mode 0600. Bolting the verb onto tugcast inherits a TCP attack surface the bridge was specifically designed not to have.
- `tugapp/Sources/ControlSocket.swift` already has a working `ControlSocketListener` pattern: `socket(AF_UNIX, SOCK_STREAM, 0)`, bind a `sockaddr_un`, `listen`, `DispatchSourceRead`-driven accept. The parallel-socket path is the cheaper path because the code template already lives in the repo.

**Implications:**
- Swift-side listener uses the `ControlSocketListener` template in a new `TestHarnessListener` struct under `#if DEBUG`.
- Single-client connection model: Swift accepts one connection at a time (second `accept` returns `ECONNREFUSED` to the kernel). Matches parent plan [L03] double-connect refusal.
- Socket path provided by `TUGAPP_TEST_SOCKET` env var; mode 0600 set via `fchmod` after bind; parent-dir ownership verified before bind.
- tugcast continues to serve its runtime responsibilities with no modification for Phase 2.

#### [D03] T-1 / T-2 stay in Phase 2 (DECIDED) {#d03-t1-t2-placement}

**Decision:** `DeckManager.testMode` and `window.__tug` land under Phase 2 (this tugplan), not moved to parent Phase 1.

**Rationale:** See [Q02]. The first meaningful Swift-side commit (`evalJS` round-trip, parent Step 7) needs the TypeScript halves to exist. Landing them across phases creates a half-landed state. The parent plan's Step 5–7 ordering already sequences testMode → `__tug` scaffold → Swift transport correctly; keeping them together preserves that sequence.

**Implications:**
- Parent plan Steps 5 and 6 remain in Phase 2 as originally authored.
- This plan's step list covers the Swift-side work only; tugdeck work continues to be authored in the parent plan's step list to keep reviewer-facing step-ordering coherent.
- No change to the parent plan's execution ordering.

#### [D04] Boot timing: env var + `WKUserScript` at `atDocumentStart`; never via the bridge (DECIDED) {#d04-boot-timing}

**Decision:** `testMode` is decided at Swift startup: `main.swift` reads `TUGAPP_TEST_SOCKET`; if set, the test harness is activated. `WKUserScript` injects `window.__tugTestMode = true` at `WKUserScriptInjectionTime.atDocumentStart`, before tugdeck's first script tag executes. Bridge socket connect is a separate concern for RPC transport; it cannot race the mode decision.

**Rationale:**
- Parent plan [D08]. Setting mode via the bridge after connect races the boot sequence: tugbank reads may fire before the bridge attaches, polluting state.
- Env-var-at-startup is the simplest primitive that provably runs before any JS.

**Implications:**
- `TUGAPP_TEST_SOCKET` unset = no test mode; app boots exactly as today.
- `TUGAPP_TEST_SOCKET` set + no harness ever connects = app sits in test mode with empty deck; harmless.
- WKUserScript injection timing is verified by a Swift-side test (see [#wkuserscript-timing-test]).

#### [D05] Hand-written typed RPC client, not codegen (DECIDED) {#d05-rpc-client-shape}

**Decision:** The bun-side RPC client is hand-written TypeScript in `tests/app-test/_harness/rpc.ts`. No codegen, no protocol descriptor files.

**Rationale:**
- The protocol has exactly two methods (`evalJS`, `waitForCondition`) and one response shape. Hand-written is ~60 lines; codegen toolchain is larger than the output.
- Fewer moving pieces — no tsproto or schema-compile step in the harness build path.
- Type-level contract is captured in `_harness/types.ts` shared with the Swift side informally (matched by Spec [#s02-rpc-protocol]). If either side drifts, `VersionSkewError` catches it at handshake.

**Implications:**
- `tests/app-test/_harness/rpc.ts` owns serialization, NDJSON framing, request-id correlation, and error-class translation.
- `tests/app-test/_harness/errors.ts` owns the three error classes (`TimeoutError`, `AppCrashedError`, `VersionSkewError`).
- `tests/app-test/_harness/index.ts` composes them into `launchTugApp` and the gesture/reset/seed wrappers.
- If the protocol grows a third method, this decision can be revisited.

#### [D06] Socket-path security: mode 0600, parent-dir ownership check, stale-unlink only if same-user-owned (DECIDED) {#d06-socket-security}

**Decision:** Swift-side bind sequence:
1. Expand `TUGAPP_TEST_SOCKET` path; reject if absolute path is outside a user-writable directory (`/tmp`, `$HOME`, `/var/folders`).
2. `stat()` the parent directory; verify `st_uid == geteuid()`. Fail fast with a distinctive log line if not.
3. If socket file already exists: `stat()` it; unlink only if `st_uid == geteuid()`. Otherwise fail with `EEXIST-style` message.
4. `bind()`.
5. `fchmod(fd, 0600)` immediately after bind; verify via `fstat`.
6. `listen(fd, 1)` (single-connection backlog).

**Rationale:**
- Parent plan [R02] mandates local-socket-only with 0600; this decision records the exact enforcement sequence.
- Stale-unlink without the ownership check would let another user's stale socket be unlinked. Restricting to same-uid is conservative.
- Parent-dir ownership check catches the case where `/tmp` has been prepped with a symlink attack.

**Implications:**
- `TestHarnessListener` carries a `SecurityError` variant; failure at any step aborts test-mode launch with a log line — the app continues booting without test mode, so a misconfigured env var is not a crash.
- Socket path in harness defaults to `/tmp/tugapp-test-${uuid}.sock`; tests may override but validation applies equally.

#### [D07] Structured errors, hard timeouts, no silent nulls (DECIDED) {#d07-rpc-error-model}

**Decision:** RPC protocol is a discriminated union `{ ok: true, value } | { ok: false, error: { name, message, stack? } }`. Script throws serialize into the `ok: false` shape server-side. Non-serializable return values become errors. Standard error `name` values the harness translates to JS error classes: `TimeoutError`, `AppCrashedError`, `VersionSkewError`. Hard timeouts: `evalJS` default 5000ms; `waitForCondition` default 2000ms poll-to-truthy, 16ms poll interval.

**Rationale:**
- Parent plan [D07]. Silent nulls are the worst debugging experience; structured errors let tests match on error kind.
- Hard timeouts prevent a stuck subprocess from hanging the whole test run.
- Three error classes cover the failure modes tests will actually need to branch on.

**Implications:**
- See Spec [#s02-rpc-protocol] for wire shape.
- Harness client wraps `ok: false` responses as thrown errors of the matching class so test code is idiomatic (`try { await app.evalJS(...) } catch (e) { if (e instanceof TimeoutError) ... }`).
- `waitForCondition` returns the truthy value, not a boolean; tests can capture state that way.

#### [D08] Hardware-event fallback (`CGEventPost`) declared as deferred follow-up (DECIDED) {#d08-cgeventpost-deferred}

**Decision:** `CGEventPost`-based `isTrusted: true` event synthesis is NOT in Phase 2 scope. If any of AT0001/AT0003/AT0016 cannot be made reliable via synthesized PointerEvent/MouseEvent/InputEvent, a follow-up plan adds `CGEventPost` with accessibility-permission handling.

**Rationale:**
- Parent plan [Q03]. Building `CGEventPost` is real work; doing it speculatively bloats Phase 2.
- Current code inspection says AT0001/AT0003/AT0016 are reachable via synthesized events (no `event.isTrusted` checks in our handlers).
- Deferring keeps the harness envelope honest: we build what we know we need, document what we don't.

**Implications:**
- `__tug.focusElement(selector)` is the escape hatch for paths where synthesized pointerdown is insufficient. Our production code calls `.focus()` directly in those paths anyway, so the test path matches.
- Fidelity limits (see [#fidelity-limits]) document what the harness cannot drive.
- If Phase 3 observation shows a test needs `isTrusted: true`, a new plan covers the `CGEventPost` work.

---

### Deep Dives {#deep-dives}

#### Boot choreography {#boot-choreography}

One ordering guarantee: `testMode` is decided at Swift startup via env var, never via the bridge. Bridge connection timing is irrelevant because mode is set before tugdeck boots.

1. Swift `main.swift` reads `TUGAPP_TEST_SOCKET`. If set: remember the socket path; `TestHarnessListener` will be started after the main window is constructed.
2. Swift constructs `MainWindow` / `WKWebViewConfiguration` with a `WKUserScript` at `WKUserScriptInjectionTime.atDocumentStart` injecting `window.__tugTestMode = true`. This fires before any tugdeck JS runs.
3. `WKWebViewConfiguration.preferences.setValue(true, forKey: "developerExtrasEnabled")` — Web Inspector reachable via Safari Develop menu.
4. `TestHarnessListener.start(path:)` asynchronously; does not block boot.
5. tugdeck `main.tsx` reads `window.__tugTestMode` at module top level and passes `testMode: true` to `new DeckManager(...)`.
6. DeckManager constructor sees `testMode: true`: skips boot-sequence tugbank reads, installs write-suppressor, starts with empty `DeckState`.
7. tugdeck initializes `window.__tug` (gated on `window.__tugTestMode === true` AND `import.meta.env.DEV`; without both, no surface is attached).
8. Harness `launchTugApp` connects to the Unix socket with bounded retry on `ECONNREFUSED` (default 10s window, 100ms interval).
9. First exchange: `version` handshake. Mismatch → harness throws `VersionSkewError` immediately.
10. Tests run.

Dev-mode boot without a harness: when `TUGAPP_TEST_SOCKET` is unset, steps 1-d, 4, 8–10 do not run; tugdeck boots exactly as today. Env var set + no harness ever connects: app sits in test mode with empty state; harmless.

#### Transport investigation {#transport-investigation}

See [Q01] for the full investigation record. Summary:

- tugcast is axum-over-HTTP with WebSocket upgrade on `/ws`; TCP-with-bearer-auth, not local-only.
- Adding a DEBUG-only verb to `ws_handler` leaves dispatch code in release builds — weaker than "no code for this verb ships."
- `tugapp/Sources/ControlSocket.swift` provides a working Unix-socket listener pattern (`socket(AF_UNIX, SOCK_STREAM, 0)`, `bind`, `DispatchSourceRead`).
- Decision: parallel Unix socket. See [D02].

#### WKUserScript injection timing test {#wkuserscript-timing-test}

A Swift-side unit test verifies that `window.__tugTestMode` is readable before tugdeck's first script tag evaluates. Approach:

1. Test configures a `WKWebView` with the test-mode `WKUserScript` AND a second `WKUserScript` at `atDocumentStart` that captures `typeof window.__tugTestMode` into `window.__testMode_orderCheck`.
2. Test loads a minimal HTML page containing `<script>window.__testMode_scriptTagRan = typeof window.__tugTestMode;</script>`.
3. After load, test calls `evaluateJavaScript` for both recorded values and asserts:
   - `window.__testMode_orderCheck === "boolean"` (first user script saw the mode set by the injection script)
   - `window.__testMode_scriptTagRan === "boolean"` (inline script tag also saw it)

This pins the timing contract that `main.tsx`'s `import.meta.env.DEV && window.__tugTestMode` read fires after the injection.

#### Transport and RPC protocol {#transport-and-rpc}

Wire format: newline-delimited JSON (NDJSON), one request or one response per line. Every request has a numeric `id`; response shares the id. No length prefix; lines are bounded by typical script payload size (few hundred bytes to a few KB).

See Spec [#s01-rpc-protocol] for exact shapes and Spec [#s02-error-classes] for error semantics. See [D07] for the design rationale.

#### `tests/app-test/` workspace config {#tests-in-app-config}

Directory structure (per parent plan [#new-files]):

```
tests/app-test/
├── _harness/
│   ├── errors.ts       # TimeoutError, AppCrashedError, VersionSkewError
│   ├── matchers.ts     # toContainOrderedSubset (trace-assertion matcher)
│   ├── rpc.ts          # NDJSON framing, request-id correlation, error translation
│   ├── types.ts        # Request<T>, Response<T>, DeckTraceEvent re-export
│   └── index.ts        # launchTugApp, App class, gesture/reset/seed wrappers
├── smoke.test.ts      # launchTugApp → evalJS("1+1") → close
├── at0001-tab-switch-fc.test.ts    # parent Step 13
├── at0003-pane-activation.test.ts  # parent Step 14
├── at0016-tab-close-handoff.test.ts # parent Step 15
├── logs/               # gitignored; per-test Tug.app stdout/stderr capture
├── tsconfig.json
└── .gitignore          # excludes logs/
```

`tsconfig.json` at `tests/app-test/tsconfig.json`:
- `extends`: none (independent from tugdeck's config)
- `compilerOptions.target`: `ES2022`
- `compilerOptions.module`: `ESNext`
- `compilerOptions.moduleResolution`: `bundler`
- `compilerOptions.types`: `["bun-types"]`
- `compilerOptions.paths`: `{"@/_harness": ["./_harness/index.ts"], "@/_harness/*": ["./_harness/*"]}`
- `compilerOptions.noEmit`: `true`
- `include`: `["**/*.ts"]`
- `exclude`: `["logs/**"]`

bun test glob: `bun test tests/app-test/` (runs from repo root). tugdeck's `bun test` glob is rooted in `tugdeck/src/` and never reaches `tests/app-test/`; the separation is structural.

Logs: `tests/app-test/logs/<test-name>.log` captures Tug.app stdout+stderr per test. On failure, runner prints last 50 lines.

#### Fidelity limits {#fidelity-limits}

Inherited from parent plan [#fidelity-limits]. Summarized here for the Phase 2 reviewer:

- **`isTrusted: true`-gated behaviors.** Synthesized events are `isTrusted: false`. Out-of-envelope: browser-default focus-on-mousedown for inputs; WebKit gesture focus-lock; fullscreen requests; clipboard writes; permissions prompts; IME composition lifecycles. *Mitigation:* `__tug.focusElement(selector)` for focus — production code does the same. *Escape:* `CGEventPost` follow-on per [D08] if a specific test demands it.
- **Visual rendering, paint, caret blink.** Harness reads DOM / focus / computed styles / selection; cannot assert "the caret is visibly blinking." Proxies cover most "element not rendered" bugs, not rendering-correctness.
- **User-perceptible timing.** Harness measures event-time deltas precisely; "snappy" is subjective. Proxy: assert trace-event deltas under a budget.
- **Multi-window scenarios.** Tug.app is single-window; harness assumes one WebView.
- **Cross-process behavior.** FC-card tests use no external processes. EM-card tests need tugcode running — out of Phase 3 scope.
- **Safari ≠ WKWebView.** Harness runs inside real Tug.app WKWebView by construction; Safari-in-isolation comparisons are out of scope.

---

### Specification {#specification}

#### Spec S01: RPC protocol {#s01-rpc-protocol}

Matches parent plan Spec [#s02-rpc-protocol]. Restated here for Phase 2 implementation.

Newline-delimited JSON. Every request has a numeric `id`; response shares the id.

```ts
type Request =
  | { id: number; method: "evalJS";           script: string;                     timeoutMs?: number }
  | { id: number; method: "waitForCondition"; script: string; timeoutMs?: number; pollMs?: number }
  | { id: number; method: "version";                                              };

type Response<T> =
  | { id: number; ok: true;  value: T }
  | { id: number; ok: false; error: { name: string; message: string; stack?: string } };
```

- **`version`.** First request on a new connection; returns `{ ok: true, value: "1.0.0" }`. Harness asserts on `expectedVersion === "1.0.0"`.
- **`evalJS`.** Script wrapped server-side in `try/catch`; throws serialize to `ok: false`. Non-serializable return values throw inside `JSON.stringify` and land in the same error path. Default timeout 5000ms.
- **`waitForCondition`.** Polls the script until truthy or timeout. Default poll 16ms; default timeout 2000ms. Returns the truthy value (not just `true`).

Framing:
- NDJSON. One JSON object per line; `\n` is the delimiter.
- Requests and responses interleave freely; `id` correlation is required.
- Lines exceeding a 1 MiB buffer trigger a connection close (sanity limit; real payloads are sub-KB).

Server-side timeout enforcement:
- `evalJS`: Swift fires a timer at `timeoutMs ?? 5000`; if `evaluateJavaScript` hasn't completed, Swift sends `{ id, ok: false, error: { name: "TimeoutError", message: "evalJS exceeded 5000ms" } }` and continues to ignore the belated completion.
- `waitForCondition`: Swift's poll loop runs server-side, issuing successive `evaluateJavaScript` calls at `pollMs ?? 16` intervals. On truthy value, responds with it. On `timeoutMs ?? 2000` elapsed, responds with `TimeoutError`.

#### Spec S02: Error classes {#s02-error-classes}

Harness client translates `ok: false` responses to thrown JS errors:

```ts
export class TimeoutError extends Error {
  readonly name = "TimeoutError";
  constructor(message: string, readonly script?: string, readonly timeoutMs?: number) { super(message); }
}

export class AppCrashedError extends Error {
  readonly name = "AppCrashedError";
  constructor(message: string, readonly exitCode?: number | null, readonly signal?: string | null) { super(message); }
}

export class VersionSkewError extends Error {
  readonly name = "VersionSkewError";
  constructor(message: string, readonly expected: string, readonly actual: string) { super(message); }
}
```

Translation rule: server-side `error.name` string matches the class name; harness client `switch` constructs the matching class and rethrows. Unknown `name` values throw a generic `Error` with the server-provided message.

#### Spec S03: Socket-path security contract {#s03-socket-security}

Restates [D06]. Normative sequence at bind:

1. Expand `TUGAPP_TEST_SOCKET` to an absolute path.
2. Verify path parent is one of `/tmp`, `$HOME`, `/var/folders`. Other parents fail fast.
3. `stat(parent)`; verify `st_uid == geteuid()`. Failure: log, abort test-mode launch, continue booting without test mode.
4. If socket path exists: `stat(path)`; verify `st_uid == geteuid()`. Failure: log, abort test-mode launch, continue booting without test mode. Success: `unlink(path)`.
5. `bind(fd, &addr, sizeof(addr))`.
6. `fchmod(fd, 0600)`; verify via `fstat` that mode is exactly `0100600` (S_IFSOCK | 0600).
7. `listen(fd, 1)`.

Single-connection backlog: second `connect` returns `ECONNREFUSED` to the kernel. Harness treats that as double-connect violation (rare; usually means two test runs sharing a socket path).

On `app.close()`: Swift closes the listen fd and unlinks the socket file. On `process.on("exit")` at the harness side: synchronous unlink as last resort (in case Swift exited abruptly).

#### Spec S04: `TestHarnessListener` Swift interface (summary) {#s04-swift-listener}

The Swift `TestHarnessListener` exposes this minimal surface inside `#if DEBUG`:

```swift
#if DEBUG
final class TestHarnessListener {
  init(socketPath: String, webView: WKWebView)
  func start() throws                // binds, listens, starts accept loop; throws on socket-security failure
  func close()                        // closes listen fd, unlinks socket, cancels in-flight RPCs
  var isListening: Bool { get }
}
#endif
```

Per-connection handler reads NDJSON, dispatches by `method`, forwards `evalJS` / `waitForCondition` to the injected `WKWebView`, serializes the response. Single-connection model: `accept` runs in a loop but a second `connect` while one is active is refused.

#### Spec S05: `WKUserScript` injection contract {#s05-wkuserscript-injection}

Restates parent plan Spec [#s06-boot-choreography] in Swift-side terms. When `TUGAPP_TEST_SOCKET` is set:

1. Construct a `WKUserScript` with:
   - `source: "window.__tugTestMode = true;"`
   - `injectionTime: .atDocumentStart`
   - `forMainFrameOnly: true`
2. Add to `WKWebViewConfiguration.userContentController.addUserScript(...)` before the WebView loads its main URL.
3. Set `WKWebViewConfiguration.preferences.setValue(true, forKey: "developerExtrasEnabled")` for Web Inspector.

`main.tsx` in tugdeck reads `window.__tugTestMode` at module top level (before any imports that might construct `DeckManager`), passes `testMode: true` to the constructor when set.

---

### Compatibility / Migration / Rollout {#rollout}

- **Compatibility policy:** `window.__tug.version` is semver. Breaking changes bump the major; additive extensions bump the minor. Harness client asserts on major match only (`"1.0.0"` → `"1.1.0"` is compatible; `"2.0.0"` throws `VersionSkewError`).
- **Migration plan:** Not applicable for Phase 2 first landing. Future versions of the `__tug` surface land under new tugplans; harness client bumps in the same commit.
- **Rollout plan:**
  - DEBUG-only by construction. Release builds are unaffected.
  - First merge to `main` leaves `tests/app-test/smoke.test.ts` passing locally; parent plan Phase 3 adds the AT-series tests.
  - Rollback strategy: revert the commits that introduce `tugapp/Sources/TestHarness/`, `tugdeck/src/test-surface.ts`, `tests/app-test/_harness/`. No production code path depends on any of them.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files (Swift, `#if DEBUG`-bracketed) {#new-files-swift}

| File | Purpose |
|------|---------|
| `tugapp/Sources/TestHarness/TestHarnessBridge.swift` | Top-level bridge entry: reads `TUGAPP_TEST_SOCKET`, constructs `TestHarnessListener`, wires into `MainWindow`'s `WKWebView`. |
| `tugapp/Sources/TestHarness/TestHarnessListener.swift` | Unix-socket listener: `socket(AF_UNIX, ...)`, `bind`, `listen`, `accept` via `DispatchSourceRead`. Implements [D06] security contract. |
| `tugapp/Sources/TestHarness/TestHarnessConnection.swift` | Per-connection handler: NDJSON reader/writer, request-id correlation, dispatch by `method`, timeout enforcement. |
| `tugapp/Sources/TestHarness/TestHarnessUserScript.swift` | `WKUserScript` construction for `__tugTestMode` injection per Spec [#s05-wkuserscript-injection]. |
| `tugapp/Tests/TestHarness/UserScriptTimingTests.swift` | Swift-side unit test per [#wkuserscript-timing-test]. |

#### New files (TypeScript) {#new-files-typescript}

Listed in the parent plan Symbol Inventory; duplicated here for completeness.

| File | Purpose |
|------|---------|
| `tugdeck/src/test-surface.ts` | `TugTestSurface` implementation (parent Spec [#s03-tug-surface]). |
| `tests/app-test/_harness/index.ts` | `launchTugApp`, `App` class, gesture/reset/seed wrappers. |
| `tests/app-test/_harness/rpc.ts` | NDJSON framing, request-id correlation, error translation. |
| `tests/app-test/_harness/errors.ts` | `TimeoutError`, `AppCrashedError`, `VersionSkewError` (this plan's Spec [#s02-error-classes]). |
| `tests/app-test/_harness/matchers.ts` | `toContainOrderedSubset` matcher. |
| `tests/app-test/_harness/types.ts` | `Request`, `Response<T>` types; `DeckTraceEvent` re-export. |
| `tests/app-test/smoke.test.ts` | Smoke test: `launchTugApp → evalJS("1+1") → close`. |
| `tests/app-test/tsconfig.json` | TypeScript config for in-app tests. |
| `tests/app-test/.gitignore` | Excludes `logs/`. |

#### Modified files {#modified-files}

| File | Change |
|------|--------|
| `tugapp/Sources/main.swift` | Read `TUGAPP_TEST_SOCKET`; hand path to `TestHarnessBridge.start(...)` in `#if DEBUG` block. |
| `tugapp/Sources/MainWindow.swift` | In test-mode code path (guarded `#if DEBUG`), attach `WKUserScript` for `__tugTestMode` and enable `developerExtrasEnabled`. |
| `tugapp/Tug.xcodeproj/project.pbxproj` | Add `TestHarness/` sources to the app target's compile phases. |
| `tugdeck/src/deck-manager.ts` | Add `testMode?: boolean` constructor option; guard tugbank reads and writes per parent Spec [#s05-testmode-semantics]; add `seedDeckState(args)` method. |
| `tugdeck/src/main.tsx` | Read `window.__tugTestMode` at module top level; pass `testMode: true` to `new DeckManager(...)` when set; attach `window.__tug` under `import.meta.env.DEV && window.__tugTestMode`. |
| `tugdeck/.gitignore` (if needed) | Verify `tests/app-test/` is not picked up by tugdeck build. |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `TestHarnessBridge` | Swift struct | `tugapp/Sources/TestHarness/TestHarnessBridge.swift` | Top-level entry; `#if DEBUG`. |
| `TestHarnessListener` | Swift class | `tugapp/Sources/TestHarness/TestHarnessListener.swift` | Spec [#s04-swift-listener]; `#if DEBUG`. |
| `TestHarnessConnection` | Swift class | `tugapp/Sources/TestHarness/TestHarnessConnection.swift` | Per-connection NDJSON handler; `#if DEBUG`. |
| `TugTestSurface` | TS interface | `tugdeck/src/test-surface.ts` | Parent Spec [#s03-tug-surface]. |
| `createTugTestSurface` | TS function | `tugdeck/src/test-surface.ts` | Factory; attaches to `window.__tug` under double guard. |
| `DeckManager.testMode` | constructor option | `tugdeck/src/deck-manager.ts` | Parent Spec [#s05-testmode-semantics]. |
| `DeckManager.seedDeckState` | method | `tugdeck/src/deck-manager.ts` | Parent Spec [#s05-testmode-semantics]. |
| `launchTugApp` | TS function | `tests/app-test/_harness/index.ts` | Spawn, connect, handshake. |
| `App` | TS class | `tests/app-test/_harness/index.ts` | `evalJS`, `waitForCondition`, `click`, `type`, `focusElement`, `reset`, `seedDeckState`, `expectFocusedCard`, `expectCaret`, `getDeckTrace`, `markDeckTrace`, `close`. |
| `TimeoutError` | TS class | `tests/app-test/_harness/errors.ts` | Spec [#s02-error-classes]. |
| `AppCrashedError` | TS class | `tests/app-test/_harness/errors.ts` | Spec [#s02-error-classes]. |
| `VersionSkewError` | TS class | `tests/app-test/_harness/errors.ts` | Spec [#s02-error-classes]. |
| `toContainOrderedSubset` | bun matcher | `tests/app-test/_harness/matchers.ts` | Trace-assertion matcher. |

---

### Documentation Plan {#documentation-plan}

- [ ] `tests/app-test/README.md`: how to write an in-app test (launch, reset, seedDeckState, drive gestures, assert, close).
- [ ] `tugapp/` README: `TUGAPP_TEST_SOCKET` env var; socket-path format; DEBUG-builds-only; Web Inspector enablement in test mode.
- [ ] Link from parent plan's [#phase-2-bridge] section to this plan.
- [ ] Update root `CLAUDE.md` with a pointer to `tests/app-test/` as the canonical surface for focus/selection/caret testing (inherited from parent plan Documentation Plan).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Swift)** | WKUserScript injection timing; socket-security sequence unit tests | `UserScriptTimingTests.swift`, security-sequence test |
| **Unit (TypeScript, happy-dom allowed)** | RPC client serialization, error-class translation, matcher logic | `tests/app-test/_harness/` unit tests (pure logic only) |
| **In-app integration (real WKWebView)** | Smoke test through the real bridge | `tests/app-test/smoke.test.ts` |
| **Golden / Contract** | Pin `version`, `Request`, `Response` wire shapes | `tests/app-test/_harness/rpc.test.ts` |

**What we do not use:**
- happy-dom for any UI / focus / selection / DOM-timing behavior of tugdeck. Parent plan constraint.
- Playwright or any non-WKWebView driver.
- Mock `DeckManager` in in-app tests. Real DeckManager inside real app.

---

### Execution Steps {#execution-steps}

> This plan coordinates the Swift-side work of Phase 2. The TypeScript-side steps (`DeckManager.testMode`, `window.__tug` scaffold, bun harness library) live in the parent plan's step list (Steps 5, 6, 10) to preserve reviewer-facing step ordering per [D03]. The steps below cover only the Swift-side changes and the `tests/app-test/` workspace scaffold.

#### Step 1: TypeScript-free workspace scaffold {#step-1}

**Commit:** `chore(tests): scaffold tests/app-test/ workspace with tsconfig and gitignore`

**References:** [D03] T-1/T-2 placement, [D05] hand-written RPC client, [D06] socket security (referenced for future steps), (#tests-in-app-config)

**Artifacts:**
- `tests/app-test/tsconfig.json`
- `tests/app-test/.gitignore`
- `tests/app-test/logs/.gitkeep`
- `tests/app-test/_harness/` (empty directory, committed via `.gitkeep` if needed)

**Tasks:**
- [ ] Create `tests/app-test/` directory tree.
- [ ] Author `tsconfig.json` per [#tests-in-app-config].
- [ ] Author `.gitignore` excluding `logs/`.
- [ ] Verify `bun test` in tugdeck does not pick up `tests/app-test/` (grep tugdeck bun test config).

**Tests:**
- [ ] `bun x tsc --noEmit -p tests/app-test/tsconfig.json` exits 0 (empty project).

**Checkpoint:**
- [ ] `bun x tsc --noEmit -p tests/app-test/tsconfig.json` exits 0.
- [ ] `cd tugdeck && bun test` continues to exit 0 and reports no tests from `tests/app-test/`.

---

#### Step 2: Harness error classes and RPC types {#step-2}

**Depends on:** #step-1

**Commit:** `feat(in-app-harness): add TimeoutError / AppCrashedError / VersionSkewError and RPC types`

**References:** [D05] hand-written RPC client, [D07] structured errors, Spec [#s01-rpc-protocol], Spec [#s02-error-classes]

**Artifacts:**
- `tests/app-test/_harness/errors.ts`
- `tests/app-test/_harness/types.ts`

**Tasks:**
- [ ] Author `errors.ts` with the three classes per Spec [#s02-error-classes].
- [ ] Author `types.ts` with `Request`, `Response<T>`, and a re-export of `DeckTraceEvent` from tugdeck.
- [ ] Ensure `types.ts` does not import any tugdeck runtime code — types-only.

**Tests:**
- [ ] Unit test: `new TimeoutError("foo", "bar", 100).name === "TimeoutError"` and preserves optional fields.
- [ ] Unit test: `new VersionSkewError("x", "1.0.0", "2.0.0").expected === "1.0.0"`.

**Checkpoint:**
- [ ] `bun x tsc --noEmit -p tests/app-test/tsconfig.json` exits 0.
- [ ] `bun test tests/app-test/_harness/errors.test.ts` passes.

---

#### Step 3: Swift `TestHarnessListener` with socket-security contract {#step-3}

**Depends on:** #step-2

**Commit:** `feat(tugapp): add TestHarnessListener with Unix-socket bind and 0600 security (DEBUG-only)`

**References:** [D01] DEBUG guard at file scope, [D02] parallel Unix socket, [D06] socket security, Spec [#s03-socket-security], Spec [#s04-swift-listener]

**Artifacts:**
- `tugapp/Sources/TestHarness/TestHarnessListener.swift` (entire file `#if DEBUG ... #endif`)
- `tugapp/Sources/TestHarness/TestHarnessBridge.swift` (top-level `start(socketPath:webView:)`, `#if DEBUG ... #endif`)
- Xcode project update to include new sources in compile phases.

**Tasks:**
- [ ] Author `TestHarnessListener` modeled on `ControlSocketListener` (see `tugapp/Sources/ControlSocket.swift`).
- [ ] Implement the [D06] bind sequence: parent allow-list, parent-dir ownership check, stale-unlink with same-uid check, `bind`, `fchmod(fd, 0600)`, verify via `fstat`, `listen(fd, 1)`.
- [ ] On any security failure, log a distinctive line (`tughost.test-harness.security: <reason>`) and return without starting — do NOT crash the app.
- [ ] Single-client connection model: second `accept` while one is active returns the accepted fd but we close it immediately with a log line.
- [ ] Author `TestHarnessBridge` top-level entry: reads socket path from argument, constructs listener, wires its `onConnection` callback to a stub that rejects all requests with `{ ok: false, error: { name: "NotImplemented", message: "..." } }` (real dispatch lands in Step 4).

**Tests:**
- [ ] Swift unit test: bind succeeds with a fresh path; fails with distinctive error on parent-dir owned by different uid (simulated via `/var/root` or test fixture).
- [ ] Swift unit test: stale socket owned by current uid is unlinked and bind succeeds.
- [ ] Swift unit test: stale socket owned by different uid fails fast with log.

**Checkpoint:**
- [ ] `xcodebuild -scheme Tug -configuration Debug build` exits 0.
- [ ] Swift unit tests pass.
- [ ] `grep -L '#if DEBUG' tugapp/Sources/TestHarness/*.swift` returns empty (every file starts with `#if DEBUG`).

---

#### Step 4: `evalJS` / `waitForCondition` / `version` RPC dispatch {#step-4}

**Depends on:** #step-3

**Commit:** `feat(tugapp): implement evalJS / waitForCondition / version RPC handlers (DEBUG-only)`

**References:** [D07] structured errors, Spec [#s01-rpc-protocol], Spec [#s04-swift-listener], (#transport-and-rpc)

**Artifacts:**
- `tugapp/Sources/TestHarness/TestHarnessConnection.swift` (per-connection NDJSON handler, `#if DEBUG ... #endif`)

**Tasks:**
- [ ] Author `TestHarnessConnection` reading NDJSON from the client fd.
- [ ] Implement `version` dispatch: respond `{ id, ok: true, value: "1.0.0" }`.
- [ ] Implement `evalJS` dispatch: forward to `WKWebView.evaluateJavaScript(script)`; serialize result via `JSONSerialization`; non-serializable → `{ ok: false, error: { name: "SerializationError", ... } }`; throws → `{ ok: false, error: { name: "EvalError", message, stack? } }`.
- [ ] Implement `waitForCondition`: poll loop calling `evaluateJavaScript` at `pollMs ?? 16` intervals until truthy or `timeoutMs ?? 2000` elapsed; return truthy value or `{ ok: false, error: { name: "TimeoutError", ... } }`.
- [ ] Hard server-side timeout on `evalJS`: timer at `timeoutMs ?? 5000`; on fire, respond with `TimeoutError` and ignore belated completion.

**Tests:**
- [ ] Swift unit test: `evalJS("1+1")` returns `{ ok: true, value: 2 }`.
- [ ] Swift unit test: `evalJS("throw new Error('boom')")` returns `{ ok: false, error: { name: "EvalError", message: /boom/ } }`.
- [ ] Swift unit test: `evalJS("new Promise(() => {})", { timeoutMs: 100 })` returns `TimeoutError` within ~150ms.
- [ ] Swift unit test: `waitForCondition("false", { timeoutMs: 100 })` returns `TimeoutError` within ~150ms.
- [ ] Swift unit test: `waitForCondition("(function(){ window.__c = (window.__c||0)+1; return window.__c > 3 ? 'yes' : null })()")` returns `"yes"` after polling.

**Checkpoint:**
- [ ] `xcodebuild -scheme Tug -configuration Debug build` exits 0.
- [ ] Swift unit tests pass.
- [ ] Manual smoke: launch debug Tug.app with `TUGAPP_TEST_SOCKET` set; connect via `nc -U` and send `{"id":1,"method":"version"}`; receive `{"id":1,"ok":true,"value":"1.0.0"}`.

---

#### Step 5: `WKUserScript` injection and Web Inspector enablement {#step-5}

**Depends on:** #step-4

**Commit:** `feat(tugapp): inject __tugTestMode via WKUserScript and enable Web Inspector (DEBUG-only)`

**References:** [D04] boot timing, Spec [#s05-wkuserscript-injection], (#boot-choreography, #wkuserscript-timing-test)

**Artifacts:**
- `tugapp/Sources/TestHarness/TestHarnessUserScript.swift` (`#if DEBUG ... #endif`)
- Modification to `tugapp/Sources/MainWindow.swift` adding `#if DEBUG` block that calls into `TestHarnessUserScript` when `TUGAPP_TEST_SOCKET` is set.
- `tugapp/Tests/TestHarness/UserScriptTimingTests.swift`

**Tasks:**
- [ ] Author `TestHarnessUserScript.install(into: WKWebViewConfiguration)` per Spec [#s05-wkuserscript-injection].
- [ ] Enable `developerExtrasEnabled` in test mode.
- [ ] In `MainWindow.swift`, wrap the install call in `#if DEBUG` + `ProcessInfo.processInfo.environment["TUGAPP_TEST_SOCKET"] != nil`.
- [ ] Author `UserScriptTimingTests` per [#wkuserscript-timing-test].

**Tests:**
- [ ] `UserScriptTimingTests.testModeReadableFromAtDocumentStartUserScript` passes.
- [ ] `UserScriptTimingTests.testModeReadableFromInlineScriptTag` passes.

**Checkpoint:**
- [ ] `xcodebuild -scheme Tug -configuration Debug build` exits 0.
- [ ] `UserScriptTimingTests` pass.
- [ ] Manual smoke: debug build with `TUGAPP_TEST_SOCKET=/tmp/foo.sock` set; open Safari Web Inspector; evaluate `window.__tugTestMode` → returns `true`.

---

#### Step 6: bun harness library — `launchTugApp`, RPC client, `App.evalJS` / `waitForCondition` {#step-6}

**Depends on:** #step-5

**Commit:** `feat(in-app-harness): launchTugApp, RPC client, App class with evalJS/waitForCondition`

**References:** [D05] hand-written RPC client, [D07] structured errors, Spec [#s01-rpc-protocol], Spec [#s02-error-classes]

**Artifacts:**
- `tests/app-test/_harness/rpc.ts`
- `tests/app-test/_harness/index.ts` (first pass: `launchTugApp`, `App` class with `evalJS`, `waitForCondition`, `close`)

**Tasks:**
- [ ] Author `rpc.ts`: NDJSON framing, request-id correlation, error-class translation.
- [ ] Author `App` class exposing `evalJS(script, opts?)`, `waitForCondition(script, opts?)`, `close()`. Each is a thin wrapper over `rpc.call`.
- [ ] `launchTugApp(opts?)` spawns Tug.app debug build via `Bun.spawn`, sets `TUGAPP_TEST_SOCKET` env, retries `UnixStream` connect on `ECONNREFUSED` for up to 10s (100ms interval).
- [ ] First RPC call: `version` handshake. Mismatch throws `VersionSkewError`.
- [ ] `app.close()` sends SIGTERM, waits up to 5s for exit, SIGKILL on timeout. Unlinks socket file.
- [ ] `process.on("SIGINT" | "SIGTERM" | "exit")` triggers `app.close()`.

**Tests:**
- [ ] Unit test: `rpc.ts` correlates responses to requests by id.
- [ ] Unit test: `rpc.ts` translates `{ name: "TimeoutError" }` to a `TimeoutError` throw.
- [ ] Unit test: `rpc.ts` translates unknown error names to a plain `Error`.

**Checkpoint:**
- [ ] `bun x tsc --noEmit -p tests/app-test/tsconfig.json` exits 0.
- [ ] Unit tests pass.

---

#### Step 7: `smoke.test.ts` and first round-trip {#step-7}

**Depends on:** #step-6

**Commit:** `test(in-app): add smoke test — launchTugApp → evalJS("1+1") → close`

**References:** [D05] hand-written RPC client, Spec [#s01-rpc-protocol], (#success-criteria)

**Artifacts:**
- `tests/app-test/smoke.test.ts`

**Tasks:**
- [ ] Author the smoke test: `const app = await launchTugApp(); expect(await app.evalJS("1+1")).toBe(2); await app.close();`.
- [ ] Verify the test uses `bun:test`, not `vitest` or `jest`.
- [ ] Add a second assertion: `expect(app.version).toBe("1.0.0")`.

**Tests:**
- [ ] Smoke test passes end-to-end against a debug Tug.app build.
- [ ] Smoke test fails loudly with `VersionSkewError` when the constant on the TS side is temporarily bumped to `"2.0.0"` (drift-prevention check).

**Checkpoint:**
- [ ] `bun test tests/app-test/smoke.test.ts` exits 0.
- [ ] `ps -ef | grep Tug.app` after the test shows zero leftover subprocesses.
- [ ] `ls /tmp/tugapp-test-*.sock` after the test shows zero leftover socket files.

---

#### Step 8: Integration Checkpoint — Phase 2 bridge end-to-end {#step-8}

**Depends on:** #step-7

**Commit:** `N/A (verification only)`

**References:** [D01] DEBUG guard, [D02] parallel socket, [D04] boot timing, [D06] socket security, [D08] CGEventPost deferral, (#success-criteria, #boot-choreography, #fidelity-limits)

**Artifacts:** None.

**Tasks:**
- [ ] Run the smoke test 10 times back-to-back; zero flakes, zero leftover processes.
- [ ] Build a release archive; run `strings` and grep for `TUGAPP_TEST_SOCKET`, `TestHarness`, `__tugTestMode` — all zero hits.
- [ ] `wc -c` on release archive vs a pre-Phase-2 baseline; delta < 1%.
- [ ] Manual: SIGINT a running smoke test; verify Tug.app subprocess terminates and socket file is unlinked.
- [ ] Code review: every file under `tugapp/Sources/TestHarness/` begins with `#if DEBUG` at line 1.
- [ ] Parent plan Step 11 (Phase 2 Integration Checkpoint) can consume this checkpoint.

**Tests:**
- [ ] Smoke test 10/10 passes.
- [ ] (Parent plan) Parent Step 11 checkpoints exit 0.

**Checkpoint:**
- [ ] Smoke test 10/10 passes.
- [ ] Release-archive grep for bridge identifiers returns zero hits.
- [ ] Binary-size delta vs baseline documented and < 1%.
- [ ] `grep -L '#if DEBUG' tugapp/Sources/TestHarness/*.swift` returns empty.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A DEBUG-only Tug.app test bridge that a bun harness can drive via Unix socket, plus the TypeScript surface on the tugdeck side, plus the `tests/app-test/` workspace scaffold and first smoke test.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `bun test tests/app-test/smoke.test.ts` exits 0 locally on macOS against a debug build (verification: repeat 10× with zero flakes).
- [ ] `window.__tug.version === "1.0.0"` handshake passes; mismatch throws `VersionSkewError` (verification: smoke test + temporary version bump test).
- [ ] Release-build `strings` grep for `TUGAPP_TEST_SOCKET`, `TestHarness`, `__tugTestMode` returns zero matches.
- [ ] Release-build binary-size delta vs pre-Phase-2 baseline is < 1% (verification: `wc -c` on notarized archive before/after).
- [ ] Every Swift file under `tugapp/Sources/TestHarness/` starts with `#if DEBUG` and ends with `#endif` at file scope (verification: `grep -L '#if DEBUG' tugapp/Sources/TestHarness/*.swift` empty).
- [ ] `bun test` in `tugdeck/` does not load `tests/app-test/`; `bun test tests/app-test/` does not load tugdeck happy-dom tests (verification: test count diff from pre-Phase-2 baseline).
- [ ] `UserScriptTimingTests` passes, verifying `__tugTestMode` is readable before tugdeck's first script tag evaluates.

**Acceptance tests:**
- [ ] `tests/app-test/smoke.test.ts` passes against a freshly built debug Tug.app.
- [ ] `UserScriptTimingTests` passes in Xcode.
- [ ] `xcodebuild -scheme Tug -configuration Debug build` exits 0.
- [ ] `xcodebuild -scheme Tug -configuration Release build` exits 0 and the resulting binary passes the release-build grep check.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] `CGEventPost` escape hatch for `isTrusted: true`-gated behaviors — new plan if parent Phase 3 demonstrates a need per [D08].
- [ ] CI integration of `bun test tests/app-test/` — new plan once local-dev workflow is stable.
- [ ] Multi-window harness keying — new plan if Tug.app grows multi-window support.
- [ ] `__tug` surface extensions beyond v1.0.0 — each under its own plan with a version bump.
- [ ] Harness performance telemetry (per-RPC latency, connection reuse across test files) — new plan if test-run time becomes a concern.

| Checkpoint | Verification |
|------------|--------------|
| Smoke test green | `bun test tests/app-test/smoke.test.ts` exits 0 (10/10 runs) |
| DEBUG guard holds | `grep -L '#if DEBUG' tugapp/Sources/TestHarness/*.swift` returns empty |
| Release binary clean | `strings <release-archive> \| grep -E 'TUGAPP_TEST_SOCKET\|TestHarness\|__tugTestMode'` returns empty |
| Binary-size delta | `wc -c` diff < 1% vs pre-Phase-2 baseline |
| Boot-timing contract | `UserScriptTimingTests` pass |
| Version handshake | Smoke test asserts `app.version === "1.0.0"` and fails on mismatch |
