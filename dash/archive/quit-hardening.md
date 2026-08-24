<!-- devise-skeleton v4 -->

## Quit Hardening — Termination Pipeline, Verified Saves, Update Consent {#quit-hardening}

**Purpose:** Make every Tug.app exit safe: in-flight composer typing is never lost, a live session is never rug-pulled by process teardown, and a Sparkle update never installs itself without consent. One termination pipeline that every initiator funnels into, with ordered, awaited, *verified* phases.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-27 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Self-update via Sparkle landed on main (`1128c1fe4`), which makes the app an *initiator* of its own termination for the first time. The brief at [dash/quit-hardening-brief.md](quit-hardening-brief.md) recorded five findings; devise investigation on the same commit corrected two of them and found the likely root cause of the standing "typing sometimes lost on reload or relaunch" bug:

- **The graceful save path has no write acknowledgment.** `putCardState` in `tugdeck/src/settings-api.ts` with `sync: true` sends a synchronous XHR and swallows every failure — it never checks `xhr.status`, and exceptions land in a `console.warn`. The async path likewise `.catch`es into a warn. If tugcast is down, restarting (supervisor backoff can hold it down for seconds), or the request fails, every card-state write is silently dropped while `AppDelegate` logs "tugdeck.saveState completed successfully" and tears down. This is an intermittent, unacknowledged data-loss hole on the *graceful* quit/reload path — it matches the observed bug's shape exactly.
- **F1 (sudden termination) is overstated.** `NSSupportsSuddenTermination` is absent from `tugapp/Info.plist`, so the process runs with sudden termination disabled — macOS does not skip `applicationShouldTerminate` at logout. No new lever is needed; the key's absence needs *guarding* so a future edit can't open the hole.
- **F3 (tmux residue) is cleared.** tugcast's shutdown path (`tugrust/crates/tugcast/src/main.rs`, end of `main`) deliberately keeps the dev/release tmux server across restarts — session persistence is a feature; only `apptest-*` identities run `tmux kill-server`. The leftover server observed after the update cycle was expected behavior, not a leak.
- **F2 and F4 are confirmed defects.** Nothing interrupts a live turn before teardown, and `ProcessManager.stop()`'s 200 ms SIGTERM→SIGKILL window is far shorter than tugcode's own interrupt ladder (2 s ack grace + 1.5 s SIGINT grace). `DeckManager.saveAndFlushSync()` — the quit path — neither clears the pending layout `saveTimer` nor calls `saveLayout()`, so a layout change inside the 500 ms debounce is dropped even on a clean ⌘Q.
- **[Q02] from dash/self-update.md folds into this plan** (user decision): a release-configuration bundle downloads and installs a scheduled update with *no consent step*, while the identical code in a debug bundle correctly defers to the delegate and downloads nothing. Reproduced three times; not yet root-caused. The self-update plan is implemented and closed, so the defect lives here now.

#### Strategy {#strategy}

- Build one deck-side termination pipeline, `prepareForTermination()`, with ordered awaited phases: interrupt live turns → capture (including queued/unsent text) → verified flush with retry → return an honest verdict. Swift calls it through `callAsyncJavaScript` under a deadline.
- Fix the write path first (status checks, per-card results), because every later phase depends on saves being *verified*, not assumed.
- Unify the four `DeckManager` flush entry points behind one teardown-save core so the guarantee lives in one function, fixing the layout-timer defect in passing.
- Replace fixed sleeps in Swift process teardown with polling, giving tugcode's own graceful ladder room to run.
- Wire Sparkle's `shouldPostponeRelaunchForUpdate:untilInvokingBlock:` so an update-driven quit is indistinguishable from ⌘Q, and root-cause + fix the unconsented release-build install.
- Verify with real tests at each layer: bun unit tests for the write/verdict logic, app-tests for draft survival across the saveState RPC, and a scripted end-to-end update pass for the Sparkle path.

#### Success Criteria (Measurable) {#success-criteria}

- Typing in the composer survives ⌘Q, Maker ▸ Reload, log out, and a Sparkle update relaunch, including when tugcast is mid-restart at quit time (verified by the retry path's logs and the relaunched app's restored draft).
- A live turn is observably interrupted and acknowledged before any process is signalled — verified from NSLog + deck-trace output, not by inspection ("interrupted N sessions, N acknowledged" precedes "shutdown" in the log).
- Quit with nothing dirty and no live turn completes in the same wall-clock time as today (no added fixed sleeps on the idle path).
- A wedged session delays quit by at most the bounded window (~5 s deck-side, ~10 s Swift total), never indefinitely.
- A release-configuration bundle offered a scheduled update defers to the deck bulletin exactly as the debug bundle does, and downloads nothing until consent (the [Q02] acceptance test).
- `saveAndFlushSync`-class paths save pending layout changes (the F4 defect test).

#### Scope {#scope}

1. Verified card-state/layout writes with failure reporting and bounded retry.
2. Unified teardown-save core in `DeckManager`.
3. `prepareForTermination()` deck pipeline: interrupt + await + capture + flush + verdict.
4. Swift `applicationShouldTerminate` rewire via `callAsyncJavaScript` with deadline; plist-key guard.
5. `ProcessManager` polled SIGTERM→SIGKILL grace.
6. Sparkle postpone-relaunch integration and the [Q02] unconsented-install fix.
7. Tests at each layer per the test plan.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Crash recovery and transcript reconstruction — [L23] governs *known* transitions; force-quit/SIGKILL/panic recovery is a different phase.
- Any redesign of the composer, prompt entry, or Session card beyond what draft durability requires.
- Changing the steady-state debounce constants (`SAVE_DEBOUNCE_MS`, `CARD_STATE_FLUSH_DEBOUNCE_MS`) — see [P09].
- Interrupting running Shell-route commands at quit — a live `$` command still dies with the process group. Promise 2 is scoped to Claude turns; shell exchange rows are durable server-side (ShellLedger), and a shell command killed at quit behaves like any terminal closing. A deliberate scoping, not an oversight.
- The rest of the self-update feature (appcast, signing, release workflow) — already landed.

#### Dependencies / Prerequisites {#dependencies}

- Self-update on main (`1128c1fe4`) — `UpdateController`, the bulletin bridge, and the local-feed test harness from dash/self-update.md all exist.
- tugcode's interrupt ladder (`INTERRUPT_ACK_GRACE_MS = 2000`, `FORCE_TERMINATE_SIGINT_GRACE_MS = 1500` in `tugcode/src/session.ts`) — this plan's timing budget is derived from it.

#### Constraints {#constraints}

- Warnings are errors (`-D warnings` in the Rust workspace); tugdeck changes must pass `bunx vite build` (the debug app loads the production rollup bundle).
- No `localStorage` / `sessionStorage` / `IndexedDB` — durable web state goes through tugbank `/api/defaults/<domain>/<key>`.
- Quit must stay instant-feeling when nothing is dirty and nothing is live.
- App-tests are selective via `@covers`; changes under `tugapp/Sources/` sit beneath every test and will trip the SWEEP ADVISED advisory — expected, not a reason to run the full corpus uninvited.
- HMR must never reload data or transcript; Maker ▸ Reload stays a true hard refresh. The unified teardown core must preserve the `captureAllForTeardown("hmr")` no-reload semantics.
- `tugcode` is a compiled binary — if any tugcode file changes, it must be rebuilt before verification.

#### Assumptions {#assumptions}

- `WKWebView.callAsyncJavaScript` (macOS 11+) is available in the deployment target; if a call fails, the Swift side falls back to the existing synchronous `saveState` path (see Risk R02).
- tugcast's supervisor restart (backoff 1→30 s) is the only reason the HTTP API is unreachable during a quit on a healthy machine; the bounded retry window in [P02] is sized to cover the first backoff steps.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Is the silent write failure the actual cause of the observed typing loss? (OPEN → instrumented) {#q01-loss-root-cause}

**Question:** The silent-failure hole in `putCardState` is the strongest candidate for "typing sometimes lost on reload or relaunch", but the historical incidents were never traced.

**Why it matters:** If a second hole exists (e.g. a restore-side race on reload), fixing only the write path leaves the bug alive.

**Plan to resolve:** Step 1 adds status checks and failure logging to every write; Step 4 makes Swift log the returned verdict. After landing, any recurrence produces a named, logged failure instead of silence — the fix and the diagnosis are the same code.

**Resolution:** OPEN — instrumented by design; revisit only if loss recurs with clean verdict logs.

#### [Q02] Why does a release build install a scheduled update without consent? (MUST RESOLVE) {#q02-unconsented-install}

**Question:** Inherited verbatim from dash/self-update.md [Q02]: a release-configuration bundle fetched the appcast, downloaded `Tug-0.8.1.zip`, and replaced the bundle in place while running — no bulletin click, no Sparkle window — while the identical code in a debug bundle correctly deferred to the delegate and downloaded nothing. Reproduced on a fresh extract, with Sparkle defaults cleared, and with `SUAutomaticallyUpdate` explicitly `false`.

**Why it matters:** An app that replaces itself under the user is the one behavior self-update must never have; it also converts every latent quit-path bug into one that fires on Sparkle's schedule.

**Options (from the recorded diagnostic state):**
- The `SPUStandardUserDriverDelegate` conformance is not witnessed / the delegate is not seen in the release binary (release runs predated the delegate `NSLog` instrumentation, so callback firing was never confirmed there).
- A genuine Sparkle policy difference keyed on the release configuration.

**Plan to resolve:** Step 7 re-runs the release build with the now-landed delegate logging; the branch taken depends on whether the callback logs appear. Either way, `automaticallyDownloadsUpdates = false` is set explicitly on the updater as a hard backstop — consent must not depend on a heuristic.

**Resolution:** RESOLVED — the release-configuration divergence does not reproduce, and the delegate hypothesis is refuted by direct evidence.

A release-configuration bundle (`Tug-release-tugdash-quit-hardening.app`, Sparkle framework embedded) was run twice against a locally served, EdDSA-signed appcast advertising 0.8.1 to its own 0.8.0, with the bundle's Sparkle defaults cleared between runs. Both runs logged:

```
UpdateController: started (automaticallyDownloadsUpdates=no, automaticallyChecksForUpdates=yes)
UpdateController: scheduled update 0.8.1 — sparkle shows it: no
UpdateController: will show update 0.8.1 (sparkle handles: no, userInitiated: no)
```

and the feed server recorded **only** `GET /appcast.xml` — never `GET /Tug-0.8.1.zip`. So in a release build: the `SPUStandardUserDriverDelegate` conformance *is* witnessed (both callbacks fire), the scheduled update *is* handed to the deck bulletin rather than Sparkle, and nothing is downloaded before consent. The "conformance dropped in release" option is out.

That leaves the policy explanation, which [P07] now forecloses regardless of cause: `automaticallyDownloadsUpdates = false` is set explicitly on the started updater, and both automatic-update flags are NSLogged at launch so a release bundle's real policy is readable without a debugger.

**Caveat on the evidence:** this bundle is ad-hoc signed with a branch-rewritten identity, reaching Sparkle through the `TUG_SPARKLE_FEED` override rather than the stable-identity gate; the original incident was on a notarized, DMG-installed `dev.tugtool.app`. The behavioral acceptance test on that exact path stays a user pass (it needs notarization credentials), and the observed evidence here is what the fix is gated on.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Quit latency regression on the idle path | med | low | R01 | ⌘Q visibly slower with nothing running |
| `callAsyncJavaScript` failure leaves no save at all | high | low | R02 | verdict never logged on quit |
| Interrupt-await races long CASE B turns (e.g. compaction) | med | med | R03 | quit regularly hits the 5 s bound |
| [Q02] root cause is inside Sparkle | med | low | R04 | delegate logs present, download still happens |

**Risk R01: Idle-path quit latency** {#r01-idle-latency}

- **Risk:** The pipeline adds awaited phases to every quit.
- **Mitigation:** Every phase early-exits when it has nothing to do — no live turns → no interrupt wait; nothing dirty → no flush wait; retry only arms on a *failed* write. No unconditional sleeps anywhere in the pipeline.
- **Residual risk:** One JS↔Swift round-trip (~ms) added; imperceptible.

**Risk R02: callAsyncJavaScript unavailable or throwing** {#r02-callasync-fallback}

- **Risk:** If the async bridge call errors (JS exception, WebView already dead), quit could proceed with no save.
- **Mitigation:** The Swift completion handler treats *any* error by falling back to the existing `window.tugdeck?.saveState?.()` synchronous path before teardown, and logs the degradation. The old path is strictly no worse than today.
- **Residual risk:** The fallback has today's unverified-write behavior; acceptable as a last resort.

**Risk R03: Long unacknowledgeable turns** {#r03-long-turns}

- **Risk:** A compaction turn is deliberately CASE B and can run minutes; its interrupt may not acknowledge within the bound.
- **Mitigation:** Bounded wait then proceed (user decision): the deck reports `unacknowledged` sessions in the verdict, Swift logs them, and teardown continues — tugcode's own force-terminate ladder and Claude Code's JSONL durability make this safe. Quit never hangs.
- **Residual risk:** An interrupted compaction may complete on disk and appear only after reload — the pre-existing, documented compaction behavior, not new loss.

**Risk R04: [Q02] is Sparkle-internal** {#r04-q02-sparkle}

- **Risk:** The delegate may be witnessed correctly and Sparkle may still download.
- **Mitigation:** `automaticallyDownloadsUpdates = false` set explicitly on `SPUUpdater` is a documented hard stop on unattended downloads regardless of driver-delegate behavior; the acceptance test gates on observed behavior, not on which explanation was right.
- **Residual risk:** If even that fails, the fallback is pinning Sparkle to a known-good version and filing upstream — revisit at the trigger.

---

### Design Decisions {#design-decisions}

#### [P01] One termination pipeline, called from Swift as an awaited async function (DECIDED) {#p01-termination-pipeline}

**Decision:** Add `DeckManager.prepareForTermination(): Promise<TerminationVerdict>`, exposed as `window.tugdeck.prepareForTermination`, invoked from `AppDelegate.applicationShouldTerminate` via a new `MainWindow.callAsyncJavaScript` wrapper. Phases in order: (1) interrupt live sessions and await acknowledgment (bounded), (2) run save callbacks with a `"termination"` source and save layout, (3) flush all dirty state with verification and bounded retry, (4) return the verdict.

**Rationale:**
- A guarantee that must hold *always* cannot be spread across four functions and two languages; the pipeline is the single place the ordering lives.
- `callAsyncJavaScript` awaits the JS promise natively, so the quit path no longer needs synchronous XHR — awaited `fetch` with status checks replaces it (the WebView stays alive until Swift replies to `terminateLater`).

**Implications:**
- `window.tugdeck.saveState` stays (Risk R02 fallback and the `MainWindow` reload intercept), but quit no longer depends on it.
- The verdict is transient data returned to Swift, never React state.

#### [P02] Writes are verified, and teardown retries failed writes within a bounded window (DECIDED) {#p02-verified-writes}

**Decision:** `putCardState` / `putLayout` (in `tugdeck/src/settings-api.ts`) check response status and report failure to their callers; `flushDirtyCardStates` returns per-card results; the termination pipeline retries failed writes (250 ms interval) until they succeed or a 5 s retry budget expires, then reports the survivors in the verdict.

**Rationale:**
- The silent-failure hole is the leading root-cause candidate for the standing typing-loss bug (#context); acknowledgment is the fix *and* the diagnosis.
- tugcast's supervisor restarts a crashed tugcast with 1 s initial backoff — a short retry window converts "quit during restart" from silent loss into a successful late write.

**Implications:**
- The sync-XHR path keeps working for true unload paths (`beforeunload`, HMR) but gains an `xhr.status` check and a boolean return.
- Failed-card ids appear in the verdict and in Swift's NSLog.

#### [P03] Live turns are explicitly interrupted and awaited before any teardown (DECIDED) {#p03-interrupt-first}

**Decision:** The pipeline enumerates live code sessions through `cardServicesStore` (`tugdeck/src/lib/card-services-store.ts`) and calls `codeSessionStore.interrupt()` on every store whose **published snapshot reports `canInterrupt: true`** — never a raw phase test. It then awaits each interrupted store reaching `phase ∈ {idle, errored}` (via `subscribe` + snapshot reads) under a 5 s deadline. Stores in `replaying` are **skipped entirely**: nothing durable is at risk (replay re-runs on next boot), and `canInterrupt` deliberately excludes it.

**Rationale:**
- The interrupt protocol (`interrupt` CODE_INPUT frame; CASE A/B semantics documented at `CodeSessionStore.interrupt`, `tugdeck/src/lib/code-session-store.ts`) already exists and works — termination just never invoked it (brief F2).
- `canInterrupt` (the snapshot projection at `code-session-store.ts`, `getSnapshot`) enumerates exactly `submitting | awaiting_first_token | streaming | tool_work | awaiting_approval | waking` and excludes `replaying` — "the bracket window owns the card; the user can only watch." A raw `phase ∉ {idle, errored}` test would send `interrupt` into a replaying store; `handleInterrupt` has no `replaying` early-return, so CASE A logic would reset the store to `idle` mid-replay and corrupt the bracket. Acting on the *published* projection instead of reimplementing the phase test is [L28] ([D01]'s source→delegate doctrine).
- 5 s comfortably contains tugcode's own ladder: `INTERRUPT_ACK_GRACE_MS` (2 s) + `FORCE_TERMINATE_SIGINT_GRACE_MS` (1.5 s) + margin.

**Implications:**
- CASE A interrupts route the un-answered submission into `pendingDraftRestore`, which the capture phase must then persist — see [P10].
- The verdict distinguishes `interrupted` (acknowledged) from `unacknowledged` (bound expired) sessions; skipped `replaying` stores appear in neither list.
- Every `subscribe` taken for the await is unsubscribed on acknowledgment *and* on deadline expiry — release paired with acquisition, [L27].

#### [P04] Bounded everywhere: quit may be slow, never hung (DECIDED) {#p04-bounded-quit}

**Decision:** Deck-side bounds: 5 s interrupt-await, 5 s flush-retry (phases overlap only in the worst case; typical live-turn quit ≈ interrupt ack ≪ 2 s). Swift-side: a 12 s outer deadline on the `callAsyncJavaScript` call; on expiry, run the R02 fallback save and proceed to teardown with an honest log line.

**Rationale:**
- User decision: bounded wait, then proceed. A quit that hangs on a wedged session is its own failure mode; tugcode's ladder and JSONL durability make proceeding safe.

**Implications:**
- No path exists where quit blocks on user intervention; the OS logout timeout is never approached on the happy path (idle quit adds no waits at all).

#### [P05] Process-group teardown polls for exit instead of sleeping 200 ms (DECIDED) {#p05-polled-teardown}

**Decision:** In `ProcessManager.stop()` (`tugapp/Sources/ProcessManager.swift`), after `kill(-pgid, SIGTERM)`, poll `kill(-pgid, 0)` every 100 ms for up to 5 s; SIGKILL only if the group still exists at the deadline.

**Rationale:**
- tugcode's SIGTERM handler runs `sessionManager.shutdown()` (stdin-EOF graceful path, up to seconds); 200 ms guarantees the SIGKILL lands mid-shutdown (brief F2).
- Polling costs nothing when children exit fast — the common case after [P03] has already idled the sessions.

**Implications:**
- Worst-case quit gains up to 5 s only when a child is genuinely wedged; the log records which.
- The kill(0) probe returns ESRCH when the group is empty — that, not a timer, is the proceed signal.

#### [P06] Sparkle's relaunch is postponed until Tug's teardown reports done (DECIDED) {#p06-postpone-relaunch}

**Decision:** Implement `updater(_:shouldPostponeRelaunchForUpdate:untilInvokingBlock:)` in `UpdateController`'s `SPUUpdaterDelegate` extension (`tugapp/Sources/UpdateController.swift`); stash the block; `AppDelegate` invokes it immediately before `NSApp.reply(toApplicationShouldTerminate: true)` on the termination path.

**Rationale:**
- Sparkle terminates the app through the normal `NSApp.terminate` path, so the pipeline already runs; the postpone hook additionally holds the *relaunch* until teardown is truly complete, closing the race where the new instance boots while the old one's children still hold sockets/ports.

**Implications:**
- The hook must be invoked on every termination that has one pending, including the R02 fallback path, or the update stalls.

#### [P07] Update consent gets a hard backstop: automaticallyDownloadsUpdates = false (DECIDED) {#p07-consent-backstop}

**Decision:** Whatever [Q02]'s root cause turns out to be, `UpdateController.startIfEligible()` explicitly sets `automaticallyDownloadsUpdates = false` on the started `SPUUpdater`, and the acceptance test is behavioral: a release bundle offered an update must download nothing until consent.

**Rationale:**
- Consent must not depend on the driver-delegate heuristic that already failed once in release configuration; an explicit updater policy is documented and configuration-independent.

**Implications:**
- If diagnosis (#step-7) shows the delegate conformance was dropped in release, that gets fixed *too* — the backstop is belt, not suspenders-removal.

#### [P08] Sudden termination needs a guard, not a lever (DECIDED) {#p08-sudden-termination-guard}

**Decision:** No `disableSuddenTermination()` calls. Instead, `applicationDidFinishLaunching` gains a check that logs an error (and `assertionFailure`s in debug builds) if `NSSupportsSuddenTermination` or `NSSupportsAutomaticTermination` appears in the bundle's Info.plist.

**Rationale:**
- The keys are absent today, so sudden termination is already disabled process-wide; adding counter calls would be cargo cult. The real risk is a future plist edit silently opening the hole — a guard catches that at first launch.

**Implications:**
- Corrects brief finding F1 in the durable record (this plan) — the intermittent loss is explained by [P02]'s hole, not by sudden termination.

#### [P09] The durability floor stays a debounce (DECIDED) {#p09-debounce-stays}

**Decision:** `SAVE_DEBOUNCE_MS` (500) and `CARD_STATE_FLUSH_DEBOUNCE_MS` (250) are unchanged; no sync-write-on-keystroke, no `pagehide` handlers.

**Rationale:**
- Every *known* transition ([L23]'s domain) now routes through the verified pipeline, so the debounce window only matters for crash-class exits — explicitly out of scope (#non-goals). Tightening it buys nothing this plan promises and costs steady-state write traffic.

**Implications:**
- If crash recovery becomes a phase later, revisit there.

#### [P10] Queued and pulled-back text folds into the saved draft at termination (DECIDED) {#p10-unsent-text}

**Decision:** `CodeSessionStore` gains `captureUnsentText(): string[]` returning, in order: the unconsumed `pendingDraftRestore` text (if any) and each `queuedSends[].text`. `TugPromptEntry`'s `onSave` (`tugdeck/src/components/tugways/tug-prompt-entry.tsx`) appends those strings (newline-joined) to the captured draft **only when the save source is `"termination"`** — steady-state saves must not duplicate text that is still visibly queued.

**Rationale:**
- `queuedSends` is in-memory only; today a quit with queued sends silently drops their text — the same class of loss as the composer bug.
- A CASE A interrupt (from [P03]) parks the submission in `pendingDraftRestore`; if React hasn't consumed it into the editor before the save callback runs, the capture must read it from the store directly rather than depend on a render tick.

**Implications:**
- **Ordering defect found during implementation:** a CASE A interrupt sets `queuedSends: []` in the reducer (`handleInterrupt`, `tugdeck/src/lib/code-session-store/reducer.ts`) — correct for a user pulling a turn back, fatal for this plan, because [P03] interrupts *before* the capture phase runs. The pipeline would have interrupted the turn and then found an empty queue, losing exactly the queued text [P10] exists to save. Resolved with `CodeSessionStore.stashUnsentText()`: the pipeline calls it on every live session immediately before `interrupt()`, and `captureUnsentText()` returns the deduplicated union of the live slots and the stash, oldest first. Pinned by `code-session-store.unsent-text.test.ts`.
- `SaveCallbackSource` (defined in `tugdeck/src/deck-trace.ts`) gains a `"termination"` member.
- **The source does not reach `onSave` today** — `invokeSaveCallback(id, source)` uses `source` only for the deck-trace tag; the registered callback is `() => void`. Threading it requires extending four signatures along the capture chain, all backward-compatibly (optional parameter): the callback type in `DeckManager.registerSaveCallback` (`tugdeck/src/deck-manager.ts`), the registered wrapper in `tugdeck/src/components/chrome/card-host.tsx`, `CardStateOrchestrator.captureCardState` + `CardAssembler.capture` (`tugdeck/src/card-state-orchestrator.ts`), and `onSave: (source?) => T` in `tugdeck/src/components/tugways/use-card-state-preservation.tsx`. The deck reaching into bag internals instead would violate [L10]; threading keeps capture in the cards.

#### [P11] One teardown-save core behind the four entry points (DECIDED) {#p11-unified-teardown-save}

**Decision:** Add a private `DeckManager.teardownSave(reason, opts)` that always: clears `saveTimer` and runs `saveLayout()`, invokes every save callback with the caller's source, and flushes (sync or awaited per caller). `captureAllForTeardown`, `saveAndFlushSync`, `saveAndFlush`, and `prepareForReload` become thin wrappers preserving their existing guard semantics (`reloadPending`/`stateFlushed` idempotence, the suspend-gate bypass flags).

**Rationale:**
- Brief F4: the guarantee was spread across four functions that each held part of it; `saveAndFlushSync` demonstrably drops pending layout saves today.

**Implications:**
- The F4 defect is fixed as a property of the shape, not a patch; a regression test pins layout-save-on-quit.
- **Implementation note (landed):** the core takes `layoutSave: "if-pending" | "always"`. `"if-pending"` (default) writes the layout when a debounced save was in flight — exactly the F4 loss window — and is what the frequent teardown signals (HMR, `visibilitychange`, `beforeunload`) use, so a layout that never changed is not re-written on every HMR update. `"always"` is for the once-per-exit callers (`prepareForReload`, the termination pipeline), where the extra write costs nothing and makes the verdict's `layoutSaved` mean "the current layout is on disk". `handleVisibilityChange` — a fifth entry point the plan did not enumerate — carried the same partial copy and now runs through the core too.

---

### Deep Dives {#deep-dives}

#### Current termination call graph (as of 1128c1fe4) {#current-call-graph}

`AppDelegate.applicationShouldTerminate` (`tugapp/Sources/AppDelegate.swift`) → `window.freezeForShutdown` (snapshot overlay) → `evaluateJavaScript("window.tugdeck?.saveState?.()")` → completion → `window.cleanupBridge()` → `processManager.shutdown()` → `NSApp.reply(toApplicationShouldTerminate: true)`, having returned `.terminateLater`.

`window.tugdeck.saveState` (`tugdeck/src/main.tsx`) → `DeckManager.saveAndFlushSync()` → save callbacks (`"manual"` source) → `flushDirtyCardStates({ sync: true })` (synchronous XHR per bag) → `stateFlushed = true`.

`ProcessManager.shutdown()` (`tugapp/Sources/ProcessManager.swift`) → `stop()`: kill Vite → UDS `{"type":"shutdown"}` → wait ≤5 s for tugcast exit → `kill(-pgid, SIGTERM)` → `usleep(200_000)` → `kill(-pgid, SIGKILL)` → close control connection; then close+unlink the listener.

On the tugcast side, a UDS shutdown → `shutdown_rx` fires → shutdown message echoed to the parent → cancel background tasks → unregister from `tug-instances.json` → (app-test only) `tmux kill-server` → `libc::kill(0, SIGTERM)` (own process group — this is what signals tugcode) → `process::exit`. tugcode's `SIGTERM`/`SIGHUP` handler (`tugcode/src/main.ts`, `shutdownOnSignal`) runs `sessionManager.shutdown()` then exits.

**The rug pull precisely located:** the deck is never asked to interrupt; tugcode's graceful shutdown needs seconds; the app's `usleep(200_000)` SIGKILLs the group mid-shutdown whenever tugcast's own exit didn't already finish the job.

#### The silent-write hole {#silent-write-hole}

`putCardState` (`tugdeck/src/settings-api.ts`): the `sync: true` branch wraps `xhr.send` in try/catch → `console.warn` → `Promise.resolve()`; **`xhr.status` is never read**, so a 500/404 counts as success even when the exception path doesn't fire. The fetch branch `.catch`es into a warn. `putLayoutGuarded` is equivalent. Meanwhile tugcast can be legitimately down at quit time: the supervisor (`ProcessManager.startProcess`) restarts a dead tugcast with 1→30 s exponential backoff, and `applicationShouldTerminate` runs `saveState` *before* teardown regardless of tugcast liveness. Swift's completion handler logs success because the JS returned, not because anything was written.

#### Interrupt acknowledgment signals {#interrupt-ack-signals}

`CodeSessionStore.interrupt()` dispatches `interrupt_action`; the reducer (`tugdeck/src/lib/code-session-store/reducer.ts`, `handleInterrupt`) is a no-op at `idle`/`errored`. CASE A (no answer content): store returns to `idle` synchronously and parks the submission in `pendingDraftRestore` — acknowledgment is immediate. CASE B (answer content exists, and always for compaction turns): phase stays until the wire's `turn_complete(error)` commits a `TurnEntry` with `result: "interrupted"`. So the await in [P03] watches for `phase ∈ {idle, errored}` per store; `interruptInFlight` is the in-between marker. tugcode's side: `handleInterrupt` sends the in-band interrupt control-request, arms `INTERRUPT_ACK_GRACE_MS = 2000`, then escalates to `killAndCleanup({escalate: true})` — SIGINT, `FORCE_TERMINATE_SIGINT_GRACE_MS = 1500`, SIGKILL (`tugcode/src/session.ts`).

**Table T01: Termination initiators and their current entry routes** {#t01-initiators}

| Initiator | Route today | After this plan |
|---|---|---|
| ⌘Q / Quit menu | `applicationShouldTerminate` → `saveState` | pipeline via `callAsyncJavaScript` |
| OS logout / restart / shutdown | same (`NSApp.terminate` AppleEvent; sudden termination disabled) | same pipeline |
| Sparkle update install | same, via Sparkle's terminate | same pipeline + postponed relaunch [P06] |
| Maker ▸ Reload | `sendControl("reload")` → `prepareForReload()` → `location.reload()` → `MainWindow` reload intercept → `saveState` again | wrappers over `teardownSave` [P11]; double-save stays idempotent |
| HMR update / full reload | `captureAllForTeardown("hmr" / "hmr-full-reload")` | wrapper over `teardownSave`; no data reload (constraint) |
| Log out (app-level) | `logout` control frame → TugLogout flow | unchanged (session-level, not process teardown) |
| Force quit / crash / SIGKILL | nothing | out of scope (#non-goals) |

---

### Specification {#specification}

**Spec S01: TerminationVerdict** {#s01-termination-verdict}

The resolved value of `prepareForTermination()`, returned to Swift as a JSON-serializable object:

```ts
interface TerminationVerdict {
  ok: boolean;                    // everything below is clean
  interrupted: string[];          // tug_session_ids interrupted AND acknowledged
  unacknowledged: string[];       // interrupt sent, bound expired (Risk R03)
  flushedCards: number;           // card bags written and verified
  failedCards: string[];          // card ids whose writes still failed after retry
  layoutSaved: boolean;
  elapsedMs: number;
}
```

Swift logs the verdict verbatim via NSLog. `ok === false` never blocks quit ([P04]); it makes the failure *named*.

**Table T02: Timing budget** {#t02-timing-budget}

| Phase | Bound | Basis |
|---|---|---|
| Interrupt await (deck) | 5 000 ms | 2 000 (tugcode ack grace) + 1 500 (SIGINT grace) + margin |
| Flush retry (deck) | 5 000 ms, 250 ms interval | covers tugcast supervisor's first backoff steps |
| `callAsyncJavaScript` outer deadline (Swift) | 12 000 ms | deck worst case + bridge margin; on expiry → R02 fallback |
| SIGTERM→SIGKILL group poll (Swift) | 5 000 ms, 100 ms interval | tugcode graceful shutdown headroom [P05] |

All bounds early-exit; the idle-path quit takes none of them.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Termination verdict | none — transient return value to Swift | plain object, never rendered | [L02] not implicated |
| `terminationInProgress` flag in `DeckManager` | local-data (non-React) | private field guarding re-entry | [L10] |
| `"termination"` save source | existing `SaveCallbackSource` vocabulary | string union member | [L23] |
| Postpone-relaunch block | Swift-side only | stored closure on `UpdateController` | n/a |

No new React-observed state is introduced anywhere in this plan.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `putCardState` / `putLayout` | fn (modify) | `tugdeck/src/settings-api.ts` | status checks; return success boolean / rejected promise info |
| `flushDirtyCardStates` | method (modify) | `tugdeck/src/deck-manager.ts` | returns per-card `{cardId, ok}` results |
| `teardownSave` | method (new, private) | `tugdeck/src/deck-manager.ts` | [P11] core; wrappers delegate |
| `prepareForTermination` | method (new) | `tugdeck/src/deck-manager.ts` | [P01] pipeline; exposed on `window.tugdeck` in `main.tsx` |
| `SaveCallbackSource` | type (modify) | `tugdeck/src/deck-trace.ts` | add `"termination"` |
| `registerSaveCallback` callback type | type (modify) | `tugdeck/src/deck-manager.ts` | `(source?: SaveCallbackSource) => void`; `invokeSaveCallback` passes it |
| save-callback wrapper | fn (modify) | `tugdeck/src/components/chrome/card-host.tsx` | forwards `source` into the orchestrator |
| `captureCardState` / `CardAssembler.capture` | fn/type (modify) | `tugdeck/src/card-state-orchestrator.ts` | optional `source` parameter threaded to the assembler |
| `onSave` option type | type (modify) | `tugdeck/src/components/tugways/use-card-state-preservation.tsx` | `onSave: (source?: SaveCallbackSource) => T` |
| `captureUnsentText` | method (new) | `tugdeck/src/lib/code-session-store.ts` | [P10]; reads `pendingDraftRestore` + `queuedSends` |
| `forEachServices` (or equivalent iterator) | method (new) | `tugdeck/src/lib/card-services-store.ts` | pipeline enumerates live sessions; `getByTugSessionId` shows the existing iteration idiom |
| `onSave` termination-source branch | fn (modify) | `tugdeck/src/components/tugways/tug-prompt-entry.tsx` | append `captureUnsentText()` on `"termination"` only |
| `callAsyncJavaScript` | method (new) | `tugapp/Sources/MainWindow.swift` | wrapper over `WKWebView.callAsyncJavaScript` |
| `applicationShouldTerminate` | method (modify) | `tugapp/Sources/AppDelegate.swift` | pipeline call + deadline + fallback + verdict log + postpone-block invoke |
| Info.plist key guard | code (new) | `tugapp/Sources/AppDelegate.swift` | [P08] launch check |
| `stop()` group poll | method (modify) | `tugapp/Sources/ProcessManager.swift` | [P05] |
| `shouldPostponeRelaunchForUpdate` | delegate method (new) | `tugapp/Sources/UpdateController.swift` | [P06]; block handed to AppDelegate |
| `automaticallyDownloadsUpdates = false` | config (new) | `tugapp/Sources/UpdateController.swift` | [P07] |

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tests/app-test/at0279-quit-draft-survival.test.ts` | typed text and the layout survive the `prepareForTermination` RPC, asserted against the real tugbank file; verdict shape checked (`@covers` deck-manager, settings-api, main.tsx, AppDelegate) |

---

### Documentation Plan {#documentation-plan}

- [ ] Record the [Q02] root cause in this plan's Resolution line (Step 7) and add a closing cross-reference note to `dash/self-update.md` [Q02] pointing here.
- [ ] If the termination pipeline earns a durable doctrine (one-pipeline-per-initiator), propose it as a tuglaws design-decision entry at landing time — user's call, not part of any step.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (bun)** | verdict assembly, retry loop, `captureUnsentText`, teardown-save ordering, status-check behavior against a stubbed fetch/XHR | Steps 1–3 |
| **Integration (app-test)** | type a draft → invoke the termination RPC through the real app → read the bag back from tugbank | Step 8 |
| **Manual / scripted end-to-end** | Sparkle local-feed update with a live turn running; release-build consent behavior | Steps 7, 9 |

#### What stays out of tests {#test-non-goals}

- Mock-store assertion tests and fake-DOM render tests — banned patterns; store logic is tested through the real `CodeSessionStore` with scripted wire events (the existing `code-session-store` test idiom).
- A fully automated quit-and-relaunch app-test — the harness can invoke the termination RPC and inspect tugbank, but actually terminating Tug.app mid-test kills the harness transport; the full quit is covered by the scripted end-to-end pass (Step 9) instead. Long real-scribe UI flows stay out per the established app-test transient-workspace limitation.
- tugcode's escalation ladder internals — already covered by tugcode's own tests; this plan only consumes its timings.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** This rule applies to every step below.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Verified writes in settings-api + flush results | done | `2019f58d7` |
| #step-2 | Unified teardown-save core in DeckManager | done | `762de4b46` |
| #step-3 | prepareForTermination pipeline (interrupt + capture + retry + verdict) | done | `c9520b8c0` |
| #step-4 | Swift rewire: callAsyncJavaScript, deadline, fallback, plist guard | done | `1e777e1e7` |
| #step-5 | ProcessManager polled teardown grace | done | `2e49b52fe` |
| #step-6 | Sparkle postpone-relaunch integration | done | `e756c2564` |
| #step-7 | [Q02] diagnosis + consent backstop | done | `e756c2564` (backstop; diagnosis run recorded in [Q02]) |
| #step-8 | App-test: draft survival through the termination RPC | done | `592b9150e` |
| #step-9 | Integration checkpoint: end-to-end quit + update passes | partial | `N/A` (two of four passes run; live-turn passes are the user's) |

#### Step 1: Verified writes in settings-api + flush results {#step-1}

**Commit:** `tugdeck(quit-hardening): verify card-state and layout writes, report failures`

**References:** [P02] Verified writes, [Q01] loss root-cause, (#silent-write-hole)

**Artifacts:**
- `putCardState` / `putLayout` return honest success signals (sync branch checks `xhr.status`; fetch branch resolves `{ok}` from `response.ok` instead of swallowing).
- `flushDirtyCardStates` returns `Array<{cardId, ok}>`; failed cards are re-marked dirty so a later flush retries them naturally.
- Failures log through `tugDevLogStore.warn` (not bare console) with card id and status.

**Tasks:**
- [ ] Rework the two write functions in `tugdeck/src/settings-api.ts`; audit their callers for signature impact (`deck-manager.ts` `putCardStateGuarded` / `putLayoutGuarded`).
- [ ] Thread per-card results out of `flushDirtyCardStates`; keep the existing suspend-gate / `sync` / `force` semantics byte-for-byte.
- [ ] Re-mark failed cards dirty.

**Tests:**
- [ ] bun unit: a stubbed non-2xx response yields `ok: false` and the card stays dirty; a 2xx clears it.
- [ ] bun unit: sync-branch failure (thrown XHR and non-2xx status both) reports failure.

**Checkpoint:**
- [ ] `cd tugdeck && bun test settings-api deck-manager` (or the nearest existing suites) passes.
- [ ] `bunx vite build` succeeds.

---

#### Step 2: Unified teardown-save core in DeckManager {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(quit-hardening): one teardown-save core; quit saves pending layout`

**References:** [P11] Unified teardown-save, [P09] Debounce stays, (#current-call-graph, #t01-initiators)

**Artifacts:**
- Private `teardownSave(reason, opts)` in `tugdeck/src/deck-manager.ts`; `captureAllForTeardown` / `saveAndFlushSync` / `saveAndFlush` / `prepareForReload` delegate to it with their existing guard semantics preserved (documented in each wrapper).
- The F4 defect is gone: every teardown-class path clears `saveTimer` and runs `saveLayout()`.

**Tasks:**
- [ ] Extract the core; keep `stateFlushed` / `reloadPending` behavior identical per wrapper (the `captureAllForTeardown` early-out, the `saveAndFlushSync` lock, `prepareForReload`'s awaited force-flush).
- [ ] Verify the HMR wrappers still perform zero data reload (constraint; `tugdeck/src/hmr-bridge.ts` call sites unchanged).

**Tests:**
- [x] `src/__tests__/teardown-save-core.test.ts` — shape guard: every teardown entry point delegates to the core and keeps no private copy of the save sequence; the core retires the layout timer, saves the layout, invokes the callbacks, and flushes. **`DeckManager` cannot be constructed without a live container element and there is no fake-DOM substrate in this suite**, so the behavioral F4 pin (a pending layout change persisted on quit) lives in the app-test at #step-8; the source guard is the cheap regression pin for the shape, on the `boot-faithful-restore.test.ts` precedent.

**Checkpoint:**
- [ ] `cd tugdeck && bun test deck-manager` passes; `bunx vite build` succeeds.

---

#### Step 3: prepareForTermination pipeline {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck(quit-hardening): prepareForTermination — interrupt, capture, verified flush, verdict`

**References:** [P01] Pipeline, [P03] Interrupt-first, [P04] Bounded, [P10] Unsent text, Spec S01, Table T02, (#interrupt-ack-signals)

**Artifacts:**
- `DeckManager.prepareForTermination()` implementing the phase order with the T02 bounds; exposed as `window.tugdeck.prepareForTermination` in `tugdeck/src/main.tsx` beside `saveState`.
- `CodeSessionStore.captureUnsentText()`; `"termination"` member on `SaveCallbackSource`; the `TugPromptEntry.onSave` termination-source append.
- A live-session iterator on `cardServicesStore`.

**Tasks:**
- [ ] Interrupt phase: enumerate services, `interrupt()` every store whose snapshot reports `canInterrupt: true` (skip `replaying` — [P03]), await `phase ∈ {idle, errored}` per store via `subscribe`, 5 s shared deadline, unsubscribing on ack *and* on expiry ([L27]); collect `interrupted` / `unacknowledged` by `tugSessionId`.
- [ ] Thread `source` through the capture chain ([P10] implications): `registerSaveCallback` callback type in `deck-manager.ts`, the wrapper in `components/chrome/card-host.tsx`, `captureCardState`/`CardAssembler.capture` in `card-state-orchestrator.ts`, and the `onSave` option type in `components/tugways/use-card-state-preservation.tsx` — all as optional parameters so existing callers are untouched.
- [ ] Capture phase: `teardownSave("termination", …)` — runs after interrupts so CASE A `pendingDraftRestore` and queued text are present for `captureUnsentText()`.
- [ ] Flush-retry phase: awaited fetch flush (no sync XHR needed here — the WebView outlives the call, [P01]); retry failed cards at 250 ms up to 5 s.
- [ ] Assemble and return the Spec S01 verdict; guard re-entry with `terminationInProgress`.
- [ ] Add `prepareForTermination` to the `window.tugdeck` interface declaration in `tugdeck/src/main.tsx`.

**Tests:**
- [x] `src/lib/code-session-store/__tests__/code-session-store.unsent-text.test.ts` (real `CodeSessionStore`, scripted wire): a CASE A interrupt's pulled-back text and two queued sends all appear in `captureUnsentText()`, in order, *after* the interrupt has cleared the queue; no duplication when the queue survived; `canInterrupt` published true for a running turn and false when idle; CASE A settles synchronously (no wait on the idle-ish path) while CASE B stays open until the wire commits (the case the bound exists for).
- [ ] **Deferred to #step-8 (app-test):** verdict shape, the unacknowledged-after-deadline path, and the flush-retry loop. These are `DeckManager` behavior and `DeckManager` needs a live container element — there is no fake-DOM substrate in the bun suite, and hand-rolling a store to assert call counts is a banned pattern. The real app exercises them through `window.tugdeck.prepareForTermination()`.

**Checkpoint:**
- [ ] `cd tugdeck && bun test` for the touched suites passes; `bunx vite build` succeeds.

---

#### Step 4: Swift rewire — callAsyncJavaScript, deadline, fallback, plist guard {#step-4}

**Depends on:** #step-3

**Commit:** `tugapp(quit-hardening): applicationShouldTerminate runs the deck termination pipeline`

**References:** [P01] Pipeline, [P04] Bounded, [P08] Plist guard, Risk R02, Table T02, (#current-call-graph)

**Artifacts:**
- `MainWindow.callAsyncJavaScript(_:completionHandler:)` wrapper.
- `applicationShouldTerminate` calls `window.tugdeck.prepareForTermination()` through it under the 12 s deadline; logs the verdict; on any error or deadline expiry falls back to `window.tugdeck?.saveState?.()`; then `cleanupBridge()` → `processManager.shutdown()` → reply. `freezeForShutdown` ordering unchanged.
- The [P08] Info.plist key guard in `applicationDidFinishLaunching`.

**Tasks:**
- [ ] Implement the wrapper and the deadline (DispatchWorkItem or continuation-with-timeout; exactly one resume path).
- [ ] Wire the verdict NSLog: one line, includes `interrupted` / `unacknowledged` / `failedCards` / `elapsedMs`.
- [ ] Add the plist guard (log + `assertionFailure` in DEBUG).

**Tests:**
- [ ] Build-level: `just app-debug` builds clean with no new warnings (the Xcode project does not enforce warnings-as-errors — hold the line by inspection).

**Checkpoint:**
- [x] Debug app launched and quit: `AppDelegate: applicationShouldTerminate — running the deck termination pipeline` → `AppDelegate: termination verdict — ok=true interrupted=none unacknowledged=none flushedCards=2 failedCards=none layoutSaved=true elapsedMs=4` → teardown. Verdict precedes teardown, both cards' writes confirmed by tugbank, layout saved.
- [x] Idle-path cost measured, not estimated: **4 ms** (Risk R01 closed). Every phase early-exited — no live turn, no failed write.
- [ ] Typed-draft survival across a real relaunch — folded into #step-9's manual passes.

---

#### Step 5: ProcessManager polled teardown grace {#step-5}

**Depends on:** #step-4

**Commit:** `tugapp(quit-hardening): poll process group to exit before SIGKILL`

**References:** [P05] Polled teardown, Table T02, (#current-call-graph)

**Artifacts:**
- `ProcessManager.stop()` replaces `usleep(200_000)` with a 100 ms `kill(-pgid, 0)` poll up to 5 s; logs whether the group exited gracefully or was SIGKILLed, and after how long.

**Tasks:**
- [ ] Implement the poll; keep the pre-existing 5 s UDS wait and the always-SIGTERM-the-group behavior (tugcast's `std::process::exit` rationale in the existing comment stands).

**Tests:**
- [x] Quit with an idle session: `ProcessManager: process group 78728 exited gracefully after 0.0s` — the poll saw ESRCH on its first check and no SIGKILL line was emitted.

**Checkpoint:**
- [x] After the quit, `pgrep -fl "tugcast|tugcode"` shows no survivor for this instance (the only tugcode left belongs to the separate `release-main` instance).
- [ ] The tmux-server-survives assertion was not exercised: no tmux server was running on this machine during the pass (`no server running on /private/tmp/tmux-501/default`), so there was nothing to preserve. Re-check during #step-9 with a live Shell route.

---

#### Step 6: Sparkle postpone-relaunch integration {#step-6}

**Depends on:** #step-4

**Commit:** `tugapp(quit-hardening): postpone Sparkle relaunch until teardown completes`

**References:** [P06] Postpone relaunch, (#t01-initiators)

**Artifacts:**
- `updater(_:shouldPostponeRelaunchForUpdate:untilInvokingBlock:)` in `UpdateController` returning `true` and stashing the block; an `UpdateController.pendingRelaunchBlock`-style handoff; `AppDelegate` invokes it immediately before `NSApp.reply(toApplicationShouldTerminate: true)` on *every* completion path, including the R02 fallback.

**Tasks:**
- [ ] Implement, with the invoke-exactly-once discipline (nil-out after invoking).

**Tests:**
- [ ] Manual, using the dash/self-update.md local-feed staging pattern (`/tmp/tug-update-stage`, `TUG_SPARKLE_FEED` override): drive an update; verify the relaunch happens only after the verdict + shutdown log lines.

**Checkpoint:**
- [ ] Update-driven quit produces the same verdict/teardown log sequence as ⌘Q, then relaunches as the new version.

---

#### Step 7: [Q02] diagnosis + consent backstop {#step-7}

**Depends on:** #step-6

**Commit:** `tugapp(quit-hardening): update consent — never download without it ([Q02])`

**References:** [Q02] Unconsented install, [P07] Consent backstop, Risk R04

**Artifacts:**
- `automaticallyDownloadsUpdates = false` set explicitly in `startIfEligible()`.
- The release-configuration divergence root-caused and fixed (delegate-conformance fix if the release run shows no delegate NSLog output; otherwise the policy backstop carries it), recorded in this plan's [Q02] resolution.

**Tasks:**
- [x] Built a release-configuration bundle and ran it against a locally served signed appcast (0.8.1 offered to 0.8.0). Both delegate callbacks log in release — the conformance-not-witnessed hypothesis is refuted.
- [x] `automaticallyDownloadsUpdates = false` set explicitly, plus a launch-time NSLog of both automatic-update flags.
- [x] [Q02] **Resolution** recorded above, with the evidence and its caveat.

**Tests:**
- [x] Acceptance (behavioral): the feed server logged only `GET /appcast.xml` across both runs — no archive download, no bundle replacement, deferral to the deck bulletin.

**Checkpoint:**
- [x] Run repeated twice with Sparkle defaults cleared between: deferral both times, zero zip requests.
- [ ] The same pass on a notarized, DMG-installed stable-identity bundle — needs notarization credentials, so it stays a user pass.

---

#### Step 8: App-test — draft survival through the termination RPC {#step-8}

**Depends on:** #step-3, #step-4

**Commit:** `tests(quit-hardening): draft + queued text survive the termination pipeline`

**References:** [P01] Pipeline, [P10] Unsent text, Spec S01, (#test-non-goals)

**Artifacts:**
- `tests/app-test/at02xx-quit-draft-survival.test.ts` (next free number; `@covers` lines for `tugdeck/src/deck-manager.ts`, `tugdeck/src/settings-api.ts`, `tugdeck/src/components/tugways/tug-prompt-entry.tsx`): type into the real composer via the harness, invoke `window.tugdeck.prepareForTermination()` through `app.evalJS`, assert the verdict shape (Spec S01) and that the card-state bag in tugbank now holds the typed text.

**Tasks:**
- [x] Authored `at0279-quit-draft-survival.test.ts` on the at0017 precedent, with a per-test `TUGBANK_PATH` + `persistInTestMode` so the assertions read the **file the app wrote**, not the in-memory cache — the cache would pass even if every write were dropped, which is the exact failure this plan closes. Runs in ~2 s, no Claude turn.
- [x] `just app-test-covers-check` passes (238 files, all `@covers` resolving).

**Tests:**
- [x] The new app-test: 13 assertions, green. Verdict `ok: true`, nothing interrupted, no failed cards, `layoutSaved: true`; the typed text is in the durable card-state bag and the layout blob is on disk.

**Checkpoint:**
- [x] `just app-test tests/app-test/at0279-quit-draft-survival.test.ts` green.
- [x] `just app-test-changed` — the plan's earlier deck-manager selection ran 19/19 green; after this step the working diff is the new test file alone, which resolves to no additional coverage.

---

#### Step 9: Integration checkpoint — end-to-end quit and update passes {#step-9}

**Depends on:** #step-5, #step-6, #step-7, #step-8

**Commit:** `N/A (verification only)`

**References:** [P03] Interrupt-first, [P04] Bounded, [P06] Postpone relaunch, Spec S01, (#success-criteria)

**Tasks:**
- [ ] **Live-turn quit:** start a real session turn, ⌘Q mid-stream; verify from logs: interrupt sent → acknowledgment (or bounded expiry) → verdict → shutdown → group exit; relaunch and confirm the interrupted turn shows `result: "interrupted"` (CASE B) or the pulled-back draft (CASE A), and the composer draft survived. **Not run** — it needs a real Claude turn driven by hand in the running app; the store-level contract it rests on is pinned by `code-session-store.unsent-text.test.ts` (canInterrupt gating, CASE A settling synchronously, CASE B staying open until the wire commits).
- [x] **Quit during tugcast outage:** tugcast SIGKILLed, then quit immediately. Verdict: `ok=false interrupted=none unacknowledged=none flushedCards=0 failedCards=a56b524b…,45694c20… layoutSaved=false elapsedMs=5092` — the full 5 s retry budget spent, then teardown proceeded with every casualty named. Quit was delayed by exactly the bound and never hung. **This pass found a real gap and it was fixed here:** the first run reported `layoutSaved=false elapsedMs=253`, because the retry loop covered card bags but not the layout — the layout write failed once and was never re-attempted. `retryFailedWrites` now retries both.
- [ ] **Update with a live turn:** local-feed update while a turn streams. **Not run** — needs both a real Claude turn and the notarized update path.
- [x] **Idle-path timing:** quit with nothing live and nothing failing: `ok=true … flushedCards=2 layoutSaved=true elapsedMs=4`. Four milliseconds — every phase early-exited (Risk R01 closed with a measurement, not an estimate).

**Checkpoint:**
- [x] The two passes above recorded with log excerpts. The other two are the user's: both need a live Claude turn, and the update pass additionally needs notarization credentials.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Every Tug.app termination initiator funnels through one verified, bounded pipeline — typing and queued text always persist, live turns are interrupted and awaited before teardown, process teardown gives children real grace, and updates neither install without consent nor relaunch before teardown completes.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All Step 9 passes green with log evidence (verification per step).
- [ ] [Q02] resolution recorded with root cause; consent acceptance test passes on a release bundle.
- [ ] The F4 regression pin (layout save on quit) and the write-verification unit tests are in the suite.
- [ ] `bunx vite build`, `just app-test-changed`, and `cd tugrust && cargo nextest run` (if any Rust files were touched) all green.

**Acceptance tests:**
- [ ] at02xx-quit-draft-survival (automated).
- [ ] Release-bundle consent deferral (scripted manual, twice).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Crash-class durability (tighter debounce or journaled drafts) — deliberately excluded by [P09]; a future phase if force-quit loss ever matters.
- [ ] Automated app-test coverage of a full quit-and-relaunch cycle, if the harness ever grows a relaunch-safe transport.

| Checkpoint | Verification |
|------------|--------------|
| Verified writes | bun unit suite, Step 1 |
| Unified teardown save | F4 regression pin, Step 2 |
| Pipeline + verdict | bun units + app-test, Steps 3/8 |
| Interrupt-before-teardown | live-turn quit logs, Step 9 |
| Update consent | release-bundle acceptance, Step 7 |
