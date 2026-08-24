<!-- tugplan-skeleton v2 -->

## In-App Harness Extensions — Hardware Events, EM-Cards, Full M-Series Coverage {#phase-harness-extensions}

**Purpose:** Extend the in-app test harness beyond the AT0001/AT0003/AT0016 slice by adding two new test-driving primitives — Swift-backed `CGEventPost` hardware-event injection for `isTrusted: true`-gated behaviors, and a tugcode-backed EM-card harness that exercises stream-json IPC end-to-end — then use both primitives to land regression coverage for the full AT-series scenario table (AT0002, AT0004, AT0005, AT0006, AT0007, AT0009, AT0011, AT0012, AT0014, AT0015, AT0018, AT0019, AT0020, AT0021, AT0023, AT0029, AT0030).

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft (Phase 0 mostly landed; Phase A is the active front) |
| Target branch | main |
| Last updated | 2026-04-24 |

**Phase progress snapshot (as of 2026-04-24):**

| Step | Status | Commit |
|------|--------|--------|
| 0a — source location on every event | LANDED | `3dbb6bb1` |
| 0b — annotate out-of-order matches | LANDED | `f89ce2b8` |
| 0c — store-state snapshot on every event | LANDED | `bd2e8bd8` |
| 0d — log tail up front on failure | LANDED | `4e445993` |
| 0e — one-line trace summary above JSON | LANDED | `998935df` |
| 0f — per-test trace artifact file | LANDED | `4a83846f` |
| 1 — CGEventPost spike (variant + escape + coord math + keyboard) | LANDED | `667ca3d1` |
| 2 — Swift handlers: click, dbl-click, right-click, drag, type, key, holdModifier | LANDED | `c4feeba1` |
| 3 — `__tug` surface: native gestures + introspection + preflight + smoke | LANDED | `b087ec60` |
| 3b — AT0003 rewrite with trusted clicks + production fix (`pane-focus-controller` mousedown suppression) | LANDED | `eb74b191`, `97a8acad` |
| 3b follow-on — AT0001 + AT0016 trusted-click rewrites | LANDED | `789cea02` |
| 3b ergonomics — `just test-in-app-fast` recipe | LANDED | `2fead382` |
| 4–17 | pending | — |

Phase A critical path is complete. The trusted-event pipeline is confirmed faithful: AT0003's rewrite against `nativeClickAtElement` surfaced a third real production bug (pane-chrome mousedown blurred the A3-restored focus) that the synthesized-click version had masked. Fix landed in `pane-focus-controller.ts`; AT0003 now green against real user mouse semantics. AT0001 and AT0016 have also been rewritten with trusted clicks (2026-04-24 follow-on); both pass without additional production changes — Step 3b's fix was comprehensive enough to cover tab clicks and close-button clicks in the same cross-cutting way. Subsequent AT-series rewrites (AT0004/AT0005/AT0020/AT0021) can now proceed with confidence that synthesized-click false greens are behind us.

Phase A smoke found four Swift-side adjustments the plan had not anticipated, all now landed: (1) 10ms modifier settle delay in `holdModifier`, (2) shared activation across both pairs in `nativeDoubleClick`, (3) 8-step interpolated drag (endpoint-only did not paint selection), and (4) off-main-thread native-verb dispatch so WebKit can drain its event queue during the drag loop. See Step 3's "Phase A pipeline findings" for rationale. These are refinements to the Step 2 handlers, not changes to the surface contract.

Step 3b surfaced one additional production gap — documented in `dash/at-series-reconciliation.md` "Step 3b" section — and fixed it in `pane-focus-controller.ts`: a document-level capture-phase `mousedown` listener now `preventDefault()`s on pane-chrome clicks to stop WebKit's default focus-clearing from blurring whatever the A3 activation effect just restored. Card-content clicks are untouched (inputs still focus normally).

---

### Phase Overview {#phase-overview}

#### Context {#context}

The in-app test harness landed in `.tugtool/tugplan-in-app-test-harness.md` delivers a real-runtime bridge into Tug.app's WKWebView and three regression tests (AT0001, AT0003, AT0016). That plan deliberately left three capability gaps open, each of which a follow-on plan would need to close:

- **`isTrusted: true`-gated behaviors.** Synthesized PointerEvent/MouseEvent dispatch covers our production handlers because they do not check `event.isTrusted`, but several AT-series scenarios (drag-aborted, IME composition, modal-overlay dismiss, cross-card selection painting) touch WebKit code paths that silently no-op against synthesized events. The original plan documented this as a fidelity limit and deferred `CGEventPost` per [Q03] until a test demanded it.
- **EM-card coverage.** AT0001/AT0003/AT0016 as specified use FC (form-control) cards only — inputs with `data-tug-persist-value` / `data-tug-focus-key`. EM (engine-managed) cards — tide-card, `TugPromptInput`, `GalleryPromptEntry` — are contentEditable-backed and their focus/selection/caret behavior flows through tugcode's stream-json IPC. None of that is exercised by the harness today. AT0002, AT0006 (EM-half), AT0007 (EM-half), and AT0009 all hinge on EM-card paths.
- **Breadth.** Three tests prove the harness shape; they do not protect the other ~20 AT-series scenarios enumerated in `dash/tugplan-selection.md` §Motivations (AT0001–AT0031). Coverage rots under natural drift; having the harness without the coverage is shelf-ware.

This plan builds the two missing primitives (hardware events, EM-card lifecycle) and then uses them to land the remaining AT-series tests that the harness's fidelity envelope can actually bind.

#### Strategy {#strategy}

- Four phases in dependency order: diagnostic observability (Phase 0) lifts every downstream test's diagnostic fidelity; hardware-event primitive (Phase A); EM-card harness (Phase B); wide AT-series coverage (Phase C). Phase 0 came first: AT0001/AT0003/AT0016 used to fail with ~400-line JSON trace dumps that cited no production file:line, carried no store state, and offered no annotation when an expected subset entry was present but out of order. With 0a/0b/0c/0f landed, the diagnostic floor is raised for every downstream test.
- **Phase A is now the critical path.** The AT0003 real-world scenario (click into a TugTextarea's `sm` input to focus it, click TugInput's title bar, click TugTextarea's title bar, expect caret back in `sm` at saved offset) fails in the running app but the synthesized-event AT0003 test passes — a classic fidelity-gap false green. Synthesized PointerEvent/MouseEvent dispatch (isTrusted=false) does not trigger WebKit's hardware-event default focus-change on `mousedown`, and `app.focusElement(selector)` uses `.focus()` directly, which is not a path real users exercise. Until we can post trusted events from the harness, tests of user-gesture-to-focus behavior give false greens and must not be trusted.
- Phase A alone unlocks AT0004/AT0005/AT0020/AT0021 coverage; Phase B alone unlocks AT0002/AT0006-EM/AT0007-EM/AT0009; Phase C is the coverage sweep. But the *first* deliverable of Phase A is rewriting AT0003 with trusted clicks (new Step 3b) — that's the acceptance test that validates the pipeline before we build more tests on top of it.
- Hardware events piggyback on the existing RPC transport. No new socket, no new boot choreography. `CGEventPost` is one more Swift-side handler on the bridge, `__tug.nativeClick` / `nativeKey` / `nativeType` is one more method on the `__tug` surface.
- EM-card support reuses the harness subprocess-lifecycle contract. Tugcode runs either as a real subprocess (full fidelity) or in a deterministic stub mode (test-stable canned transcripts). Both modes exercise the same stream-json IPC surface end-to-end.
- AT-series expansion is table-driven. A single authoritative scenario table (Spec [#s04-mseries-scenarios]) tracks every scenario, its required infrastructure (synthesized / CGEventPost / EM-card), and its target fix. Steps 10–16 walk the table row by row.
- Fidelity envelope from the base harness still applies: visual rendering, paint correctness, caret blink, and multi-window stay out of scope. This plan widens the envelope by the width of `CGEventPost` and tugcode IPC, not beyond.
- DEBUG-only guard policy from [D03] of the base harness is inherited unchanged. Every new bridge surface, including `CGEventPost`, is gated the same way on both halves.

#### Success Criteria (Measurable) {#success-criteria}

- Every in-app test failure emits a diagnostic block that (a) names the production `file.tsx:line:col` of each trace event, (b) shows `{active, fr, focused}` store state at the moment each event was recorded, and (c) annotates any subset-match violation with a one-line explanation (e.g., "Order violation: entry #1 appears at trace[1], BEFORE entry #0 match at trace[4]"). (Verified: AT0001/AT0003/AT0016 reconciliation PRs cite production line numbers quoted directly from the test output.)
- `__tug.nativeClick(x, y)` dispatches a macOS `CGEventPost` mouse-down / mouse-up that reaches WebKit as `isTrusted: true`; the in-app test that asserts trusted-event arrival passes. (Verified: `tests/app-test/smoke-native.test.ts` exits 0.)
- `tests/app-test/at0003-pane-activation.test.ts` uses `nativeClickAtElement` for every user-gesture click (no `focusElement`, no `app.click`); the rewritten test passes end-to-end against a real DEBUG Tug.app. Manual reproduction of the same gesture flow in the running app matches the test's outcome. (Verified: `grep -c 'focusElement\|app\.click(' tests/app-test/at0003-pane-activation.test.ts` returns 0; `just test-in-app` exits 0; manual repro matches.)
- A tugcode subprocess launches under harness control, performs one stream-json turn against a canned request, and the turn is observable via `__tug.getEmCardState(cardId)`. (Verified: `tests/app-test/smoke-em.test.ts` exits 0.)
- Every AT-series scenario in the table with an infrastructure column of "synthesized", "CGEventPost", or "EM-card" has a green in-app test. (Verified: row-by-row test files exist under `tests/app-test/` and `bun test tests/app-test/` exits 0.)
- Each new AT-series test fails predictably when its target fix is reverted by hand. (Verified: per-test drift-prevention exercise documented in Step 17.)
- Release-build binary size unchanged vs pre-harness baseline (within noise threshold). (Verified: `wc -c` diff + `nm` symbol check.)
- No new happy-dom tests added for UI / focus / selection / DOM-timing behavior across the whole plan. (Verified: grep review of commits.)
- Accessibility permission prompt does not fire during automated runs. (Verified: documented permission-setup step for developer workstation; CI-on-hold until handled per [Q01].)

#### Scope {#scope}

0. Diagnostic observability upgrades to the deck-trace recording surface and harness matcher output: per-event caller file:line capture, store-state snapshot inlined at record time, out-of-order-match annotation in `toContainOrderedSubset`, one-line-per-event summary above the JSON dump, Tug.app log tail surfaced *before* the assertion failure output (200-line window), per-test trace-artifact file for offline analysis. Additive, no production behavior change, no new RPC verbs.
1. Swift-side `CGEventPost` handler (DEBUG-only), coordinate-mapping helper, NSEvent synthesis for app-lifecycle simulation (`NSApp.hide()`, `NSApp.unhide()`, `NSApp.resignFirstResponder()` equivalents).
2. New `__tug` surface methods: `nativeClick`, `nativeMouseDown`, `nativeMouseUp`, `nativeKey`, `nativeType`, `simulateAppResign`, `simulateAppBecomeActive`, `simulateAppHide`, `simulateAppUnhide`.
3. Accessibility-permission setup documentation for developer workstations; guidance on CI sandboxing (deferred to [Q01]).
4. Tugcode subprocess lifecycle under harness control: `__tug.startTugcode(opts)`, `__tug.stopTugcode()`, `__tug.seedTugcodeTranscript(transcript)` for deterministic stub-mode.
5. New `__tug` surface methods for EM-card observation: `getEmCardState(cardId)`, `getEngineSelection(cardId)`, `awaitEngineReady(cardId)`.
6. EM-card harness seeding helpers: `seedEmCard`, `drainTugcodeTurn`, `seedTugcodeError`.
7. AT-series scenario table authored and adopted as the canonical coverage ledger (Spec [#s04-mseries-scenarios]).
8. In-app tests for AT0002, AT0004, AT0005, AT0006 (FC + EM halves), AT0007 (FC + EM halves), AT0009, AT0011, AT0012, AT0014, AT0015, AT0018, AT0019, AT0020, AT0021, AT0023, AT0029, AT0030. Each scenario is one test file; grouping by mechanism is a README-level organization only.

#### Non-goals (Explicitly out of scope) {#non-goals}

- CI integration. Same position as the base harness plan — local-dev first; CI follows only once accessibility-permission handling is resolved per [Q01].
- Multi-window scenarios (no change from base plan).
- Visual / paint / caret-blink correctness (AT0022 stays manual-verification-only — outside the fidelity envelope).
- Refactoring the base harness surface. Extensions go through version bumps of `__tug.version` per [D11] of the base plan.
- Retrofitting existing Phase 3 tests (AT0001/AT0003/AT0016) to use `CGEventPost`. They already pass via synthesized events; moving them would be churn.
- Replacing tugcode with a mock for EM-card tests. We run tugcode for real, optionally in stub-transcript mode. A full mock would reintroduce the happy-dom failure class — assertions against a fake that approximates the real thing.
- Covering AT0013 (integration-test meta-scenario — about existence of tests, not behavior), AT0017 (RPC-level audit already closed by Step 18 of the selection plan), AT0024 (component-protocol meta), AT0025 / AT0026 / AT0027 / AT0028 / AT0031 (component-internal state axes covered by component-persistence tests, not activation harness).

#### Dependencies / Prerequisites {#dependencies}

- All 16 execution steps of `.tugtool/tugplan-in-app-test-harness.md` complete: deck-trace instrumentation, `DeckManager.testMode`, `window.__tug` base surface, transport + RPC + error model, version handshake + lifecycle, harness library, AT0001/AT0003/AT0016 tests green.
- `dash/tugplan-in-app-bridge.md` (Phase 2 bridge plan) exists and its DEBUG-guard file-level placement is authoritative — this plan adds new files to the same guarded surface under the same rules.
- Tug.app running with `TUGAPP_TEST_SOCKET=...` in DEBUG build; harness can launch, handshake, and run arbitrary `evalJS` / `waitForCondition`.
- Accessibility permission granted to Tug.app (or its DEBUG variant) on the developer workstation, for `CGEventPost` to reach the system event stream.
- `tugcode` binary exists and accepts stream-json IPC; its subprocess contract is stable enough to embed in harness lifecycle.
- `tugdeck` EM-card implementations (tide-card, `TugPromptInput`, `GalleryPromptEntry`) are functional in-app — not under active redesign. AT0002-class tests assume the EM activation path (Step 23E in `tugplan-selection.md`) has landed.
- macOS-only (no change from base plan).

#### Constraints {#constraints}

- **DEBUG-build-only guard is inherited, not relaxed.** Every new Swift source file and every new TypeScript touchpoint follows [D03] of the base harness: independent Swift `#if DEBUG` guard + TypeScript `import.meta.env.DEV && window.__tugTestMode` gate. A release build contains zero `CGEventPost` bytes and zero tugcode-harness bytes.
- **Accessibility permission is a developer-workstation prerequisite, not a runtime prompt.** Tests do not request permission mid-run; they fail fast with a descriptive error if the permission is missing. CI workstation setup is documented separately and deferred per [Q01].
- **Hardware events target the test-harnessed WKWebView only.** Coordinate mapping goes Tug.app window → content-view → WebView document coordinates. Events outside the WebView's bounds are rejected by the Swift handler so test-mouse-movement never escapes into the user's other apps.
- **No `setTimeout` in test code or harness code** (inherited from base [D12]).
- **Tugcode subprocess lifecycle is harness-owned under test mode.** Production tugcode launch paths are untouched; the harness spawns its own instance per test file and kills it explicitly on `app.close()`.
- **Stream-json transcripts are content-hashed** to detect silent drift in the recorded canonical stream (per [D06]).
- **macOS only.** `CGEventPost`, `NSApp.hide()`, tugcode — all macOS primitives.
- **Single WebView assumption** (inherited).

#### Assumptions {#assumptions}

- `CGEventPost` delivered to the active-application process reaches WKWebView as `isTrusted: true` events. Confirmed by spike per [Q02] before Step 1.
- WKWebView's hit-testing honors window/content-view coordinate mapping — posting an event at screen coordinate (x, y) where the WebView is visible lands on the expected DOM element. Verified by a spike in Step 1.
- Tugcode's stream-json IPC protocol is stable within the scope of this plan; schema changes are out-of-band events that would trigger this plan's replanning.
- Canned stream-json transcripts are deterministic enough that a test replaying one gets identical downstream effects every run. Tested empirically during Step 5.
- `NSApp.hide()` / `.unhide()` / `.deactivate()` / `.activate()` actually fire the delegate callbacks (`applicationDidHide:`, `applicationDidUnhide:`, `applicationDidResignActive:`, `applicationDidBecomeActive:`) that Step 23D of the selection plan listens for. Verified by Step 3 smoke test.
- The AT-series scenarios listed in `tugplan-selection.md` §Motivations are the authoritative set; this plan does not invent new scenarios.
- Test-file runtime does not exceed ~10 seconds per file at the plan's completion, even with tugcode in the loop. If it does, [R02] triggers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] CI accessibility-permission handling (DEFERRED) {#q01-ci-accessibility}

**Question:** `CGEventPost` requires the posting process (or its parent) to have macOS Accessibility permission granted. On a developer workstation this is a one-time `System Settings → Privacy & Security → Accessibility → +` step. On a GitHub Actions macOS runner there is no interactive UI; the permission must be granted programmatically or waived.

**Why it matters:** Without a CI story, Phase A tests stay local-dev-only. That is already the position of the base harness, but the question accumulates pressure as coverage grows.

**Options:**
- Launch a helper process with `tccutil` or the private `TCC.db` mutation (both are macOS version-fragile and widely warned against).
- Gate CI on a pre-provisioned runner image that has permission pre-granted.
- Keep `CGEventPost` tests local-dev-only; CI runs only synthesized-event tests.

**Plan to resolve:** Investigation deferred to `dash/tugplan-harness-ci.md` (authored when CI becomes urgent). This plan documents the local-workstation setup in Step 1's docs task.

**Resolution:** DEFERRED. Tracked in the `dash/tugplan-harness-ci.md` follow-up.

#### [Q02] `CGEventPost` vs `CGEventPostToPid` — which path reaches WKWebView as `isTrusted: true`? (DEFERRED) {#q02-cgeventpost-variant}

**Question:** `CGEventPost(.cghidEventTap, event)` posts to the system event stream, visible to all apps; `CGEventPostToPid(event, pid)` posts directly to a process. We need the variant that WKWebView accepts as `isTrusted: true` while also not leaking into other windows on the developer's screen.

**Why it matters:** Leaking clicks outside Tug.app during test runs is a UX disaster for the developer. But posting to the wrong PID may land events on a sibling helper process (WebKit's rendering process) rather than the main app process — and delivery semantics may differ.

**Plan to resolve:** First task of Step 1: spike both variants against a minimal Tug.app DEBUG build; measure `event.isTrusted` on the JS side and observe whether events leak outside the app window. Record the result as [D02]'s rationale.

**Resolution:** DEFERRED to [#step-1] spike.

#### [Q03] Tugcode subprocess lifecycle: per-test-file vs per-harness-launch (DEFERRED) {#q03-tugcode-lifecycle}

**Question:** Should the harness spawn one tugcode process per test file (clean-per-file, slower), or one per harness launch (shared across test files if Bun's test runner ever moves that way, faster)?

**Why it matters:** Tugcode startup is not free. Per-file spawns cost measurable wall-clock. Per-launch spawns demand correctness of the per-test tugcode reset (drain pending turns, clear memory, reset transcript).

**Options:**
- Per-test-file spawn, mirroring Tug.app's one-app-per-file model. Simple, slower.
- Per-harness-launch spawn with a `resetTugcode()` RPC. Faster, requires tugcode to support clean reset.

**Plan to resolve:** Decide in Step 5 after measuring tugcode startup latency. If < 500ms, per-test-file wins on simplicity. If >= 500ms, add the reset RPC.

**Resolution (2026-04-25, Step 5 / Pass 7A):** **Per-test-file lifecycle.** Measured via `smoke-tugcode-lifecycle.test.ts`'s 10-cycle latency probe: median start+stop+RPC wall-clock = 13.2ms (min 11.5ms / max 13.7ms) on Apple Silicon, debug-build tugcode. Well under the 500ms threshold; no `resetTugcode()` RPC needed. The simplicity win on per-test-file isolation (fresh process per file, no reset-state correctness risk) outweighs the negligible per-file overhead.

#### [Q04] Stream-json transcript format: canonical bytes vs structured records (DEFERRED) {#q04-transcript-format}

**Question:** EM-card tests need deterministic tugcode output. Do we record the on-wire stream-json as raw bytes (fragile to protocol drift but perfectly reproducible), or as a structured JSON record of the logical turn (resilient to cosmetic drift but requires encode-on-replay)?

**Plan to resolve:** Decide in Step 6. Default position: structured records with a content-hash sidecar that trips when tugcode's on-wire format changes. Raw-bytes fallback if the structured format introduces subtle replay skew.

**Resolution (2026-04-25, Step 6 / Pass 7B):** **Structured records with SHA-256 sidecar.** Format pinned in `tugcode/src/stub-replay.ts::TugcodeTranscript`: `{ schemaVersion: 1, tugcodeVersion: string, turns: [{ index, description?, outputs[] }] }`. Each `outputs[]` entry is a full structured `OutboundMessage` (assistant_text / turn_complete / error / etc.). Index-based turn matching means prompt content can vary between capture and replay without invalidating the transcript. Sidecar verification helper in `tests/app-test/_harness/transcript.ts`; reapprove flow in `scripts/reapprove-transcript.ts`. No replay skew observed in 7B's smoke; the raw-bytes fallback was not needed. Brittleness watch (revisit in 7C / 7D): if tugcode's `OutboundMessage` union grows new variants, transcripts captured against older versions may carry types the runtime emits but newer code rejects — the `tugcodeVersion` field in every transcript flags this at capture time, but runtime version-skew handshake (originally planned in Step 6) is deferred to a follow-up. See Step 6's Author note.

#### [Q05] CGEvent modifier-key accelerators (Cmd+A etc.) — resolved by reading Apple's docs (DECIDED — 2026-04-24, same-day as Step 1 close) {#q05-cgevent-modifiers}

**Original question (from Step 1 spike):** Plain letter keystrokes via `CGEvent.post(tap: .cgSessionEventTap)` insert into focused inputs (`'x'` → input value appended). But Cmd+A with `keyDown.flags = .maskCommand` (with or without `flagsChanged` bracketing) didn't trigger WebKit's select-all; caret ended up at the click point instead of full-range selection.

**Root cause (from Apple docs, `CGEventSource` + `CGEventCreateKeyboardEvent`):**

Two mistakes compounded:

1. **Wrong `CGEventSourceStateID`.** Step 1's spike used `.hidSystemState`. The docs for that state explicitly say: "If your program is a daemon or a user space device driver interpreting hardware state and generating events, you should use this source state." For login-session apps posting synthetic events, the correct state is `.combinedSessionState`: "If your program is posting events from within a login session, you should use this source state when you create an event source." `.hidSystemState` tracks only hardware state; our synthetic Cmd-down event didn't register in the session-level modifier table that WebKit reads.

2. **Manual `.flags` assignment + `type = .flagsChanged` override is wrong.** `CGEventCreateKeyboardEvent` docs explicitly prescribe the pattern (example: capital 'Z'): "(1) SHIFT down (vk 56), (2) 'z' down (vk 6), (3) 'z' up, (4) SHIFT up. This requires four separate keyboard events in sequence." All four are plain `keyDown`/`keyUp` events of their respective virtual keycodes — no `.flags` setter, no `type` override. The `CGEventSource` tracks modifier state across the sequence and automatically stamps the correct flags on events posted through it.

**Correct Cmd+A pattern (pinned for Step 2):**

```swift
let source = CGEventSource(stateID: .combinedSessionState)  // NOT .hidSystemState

// All four events created from the SAME source — that's how the source's
// state table registers "Cmd held" across aDown/aUp.
let cmdDown = CGEvent(keyboardEventSource: source, virtualKey: 0x37, keyDown: true)
cmdDown?.post(tap: .cgSessionEventTap)

let aDown = CGEvent(keyboardEventSource: source, virtualKey: 0x00, keyDown: true)
aDown?.post(tap: .cgSessionEventTap)

let aUp = CGEvent(keyboardEventSource: source, virtualKey: 0x00, keyDown: false)
aUp?.post(tap: .cgSessionEventTap)

let cmdUp = CGEvent(keyboardEventSource: source, virtualKey: 0x37, keyDown: false)
cmdUp?.post(tap: .cgSessionEventTap)
```

No `.flags` setters. No `type = .flagsChanged` override. Tap stays `.cgSessionEventTap` (per [D02]).

**Implications for Step 2's `NativeEventHandlers.swift`:**

- Hold a single `CGEventSource(stateID: .combinedSessionState)` at handler-class scope (sources are cheap; reusing one across events within a gesture means the source's state table is coherent).
- `holdModifier(mods, inner)`: post `keyDown` for each modifier's virtual keycode (`kVK_Command=0x37`, `kVK_Shift=0x38`, `kVK_Option=0x3A`, `kVK_Control=0x3B`) through the source, in a stable order; run inner verbs using the SAME source; post `keyUp` for modifiers in reverse order. `defer` block ensures the reverse-order release runs even if inner verbs throw.
- `nativeKey(key, mods)`: sugar over `holdModifier` for single-keystroke combos.

**Out of scope for this plan:** The `hidSystemState` vs. `combinedSessionState` distinction also likely affects the keyboard-letter test's observed `selectionEnd=11` result (plain letter insertion worked but the caret ended up at end of text, not where we clicked). That behavior is a separate subtlety — worth noting but not blocking Step 2.

**Resolution:** RESOLVED. No Step 2 investigation required — just implementation of the pattern above. The keyboard pipeline is unblocked.

**Impact on Step 3b gating:** None — AT0003 is click-driven, no keyboard modifiers. Phase A's click pipeline is unblocked regardless.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| `CGEventPost` bypasses DEBUG guard via Objective-C runtime dynamic loading | critical | low | File-level `#if DEBUG` on every CGEventPost-touching Swift file; binary-size + `nm` audit in checkpoint | Any PR touching accessibility-adjacent code |
| Hardware events leak outside Tug.app window during test runs | high | medium | `CGEventPostToPid` or explicit coordinate check against window bounds; reject events outside bounds server-side | First report of test-driven clicks hitting a sibling app |
| Tugcode startup latency balloons test runtimes | medium | medium | Measure once in Step 5; if >500ms, switch to per-launch with `resetTugcode()` per [Q03] | Any test file exceeding 10s wall-clock |
| Stream-json transcript drift silently breaks tests | medium | high | Content-hash transcripts; hash mismatch is a hard failure with guidance | First green-to-red transition with no code change |
| AT-series coverage sprawl (25+ test files, maintenance burden) | medium | high | Table-driven authoring with shared helpers; any helper addition goes into `_harness/` (not per-test) | Helpers start duplicating across tests |
| Accessibility-permission prompt fires mid-run, hanging test | medium | low | Permission check as first harness-launch RPC; fail fast if missing | Any report of hung test with no output |
| EM-card test coupling tugcode version to tugdeck version | medium | medium | Tugcode version recorded in test failure report; version-skew error class | Silent bug attributed to version drift |

**Risk R01: `CGEventPost` code leaks to release binary** {#r01-cgeventpost-release-leak}

- **Risk:** Accessibility-tapping code is a security concern in a release build; `CGEventPost` is linked into the app even when unused if a `#if DEBUG` bracket is forgotten. Apple's notarization may also reject binaries that declare unused entitlements.
- **Mitigation:**
  - Every Swift source file adding `CGEventPost` lives wholly inside `#if DEBUG ... #endif`.
  - Binary-size diff and `nm` symbol check are exit criteria for Phase A integration checkpoint.
  - No accessibility entitlement is declared in the release build's `Info.plist`.
- **Residual risk:** Build misconfiguration (DEBUG=1 in a release archive) would leak. Accepted; out-of-scope per [D03] of base plan.

**Risk R02: Hardware events leak outside the WKWebView** {#r02-event-escape}

- **Risk:** A coordinate-mapping bug or explicit `CGEventPost(.cghidEventTap, ...)` use sends a mouse click to whatever app happens to be at screen coordinate (x, y). Developer's unrelated window receives the click. Worst case: confidential action triggered in another app.
- **Mitigation:**
  - Resolution per [Q02]: prefer `CGEventPostToPid(event, pid)` targeting the Tug.app process (or WebKit WebContent process) if it yields `isTrusted: true`.
  - Server-side bounds check: reject event-post requests whose coordinate is outside the current WebView frame.
  - Coordinate mapping is unit-tested against known window geometry.
- **Residual risk:** A system-level event stream subscription (e.g., a macOS window recorder) may still observe the posted events even if they don't reach another app's event queue. Accepted; dev-tooling trust model.

**Risk R03: Tugcode coupling inflates test flakiness** {#r03-tugcode-flakiness}

- **Risk:** Running real tugcode means real timing — model latency, buffer flushes, process scheduling. Stream-json turns that "usually take 80ms" sometimes take 3000ms and blow `waitForCondition` timeouts.
- **Mitigation:**
  - Default to stub-transcript mode for deterministic canned responses (real tugcode only for smoke tests).
  - `drainTugcodeTurn()` helper waits on tugcode's completion signal specifically, not a wall-clock timer.
  - Content-hash on transcripts detects silent drift (per [D06]).
- **Residual risk:** Real-tugcode smoke tests may occasionally fail on loaded dev machines. Accepted; those tests are clearly marked `smoke-em-live.test.ts` and not part of the default run.

**Risk R04: AT-series test maintenance cost** {#r04-mseries-maintenance}

- **Risk:** 20+ in-app test files, each with its own seed / drive / assert idioms, becomes unmaintainable. A single refactor in `focus-transfer.ts` triggers 20 test file updates.
- **Mitigation:**
  - Table-driven scenario authoring: shared `_harness/` helpers for seeding, driving, asserting common shapes (pane setup, card activation, trace-subsequence templates).
  - Per-row test files stay short (< 80 lines typical).
  - Regression triage uses the scenario table to cluster failures by mechanism.
- **Residual risk:** Some scenarios will be genuinely unique and will resist helperization. Accepted; triage treats them as the long tail.

---

### Design Decisions {#design-decisions}

#### [D01] Hardware events land on the existing bridge as new `__tug` methods, not a new transport (DECIDED) {#d01-hardware-events-same-transport}

**Decision:** `CGEventPost` is invoked through new RPC verbs (`nativeClick`, `nativeMouseDown`, `nativeMouseUp`, `nativeKey`, `nativeType`) added to the same bridge that already serves `evalJS` and `waitForCondition`. `__tug` surface grows new methods that wrap these RPCs.

**Rationale:**
- Adding a second transport doubles the DEBUG-guard surface area for no gain.
- The RPC shape is identical — request/response JSON, structured errors, per-call timeout — only the server-side handler is new.
- Keeps the harness-library shape uniform: every test-driver call is a method on the typed client.

**Implications:**
- `__tug.version` bumps from `1.0.0` to `1.1.0` (additive change per [D11] of the base plan).
- New RPC verbs are DEBUG-guarded at the same file-level position as `evalJS`.
- Harness client gains typed wrappers mirroring [D09] of the base plan.

#### [D02] `CGEventPost(tap: .cgSessionEventTap)` is the chosen variant (DECIDED — Step 1 2026-04-24) {#d02-cgevent-variant}

**Decision:** Post events via `CGEvent.post(tap: .cgSessionEventTap)`. The spike ruled out `CGEvent.postToPid(ownPid)` — it does NOT deliver events back to the posting process's own WKWebView (zero mousedown listeners fired across every experiment). Both `cghidEventTap` and `cgSessionEventTap` deliver `isTrusted: true` clicks that WebKit dispatches to content-world JS listeners; `cgSessionEventTap` is preferred because it's scoped to the current user session (vs. system-wide HID).

**Rationale from Step 1 spike (observed outcomes):**
- `cghidEventTap`: delivers mousedown to WKWebView with `isTrusted: true`. Clicks land at the expected DOMRect center (delta=(0,0) after CoordMapping fix).
- `cgSessionEventTap`: same — delivers mousedown with `isTrusted: true`, clicks land at expected coord.
- `postToPid(ownPid)`: **does not deliver.** The test's one-shot mousedown listener never fires; the spike times out on every experiment that used this variant. Exactly ONE post-to-self event pair should have reached the WKWebView; zero did.
- Plain keystrokes (e.g., `kVK_ANSI_X` with no modifiers) DO get delivered and inserted into focused `<input>` elements via both `cghidEventTap` and `cgSessionEventTap`.
- Modifier-based accelerators (Cmd+A via `keyDown.flags = .maskCommand`, with or without `flagsChanged` press/release bracketing) arrive as events but do NOT trigger WebKit's accelerator-key path. Input's selection doesn't go full-range; the caret moves to the click landing point instead. **Step 2 has an open task to crack this** — see [Q04].

**Implications:**
- [R02] event escape is not closed by the variant choice. Both `cghid` and `cgSession` taps are global — events route by screen coord → frontmost window. Mitigation: ensure Tug.app is frontmost (via `NSApp.activate(ignoringOtherApps: true)` at post time) AND target only coords inside Tug.app's window (enforced by `CoordMapping.viewportToScreen` returning nil for out-of-bounds). Residual risk: a sibling app's window overlapping Tug's window at the target coord. Step 2 mitigates by raising Tug.app's window to front before posting.
- Step 2's `NativeEventHandlers.swift` uses `cgSessionEventTap` as the canonical delivery path. The chosen tap is a single constant; changing variants requires a one-line edit.
- Documentation (harness README) explains the variant choice and why.

#### [D03] Accessibility-permission check is a first-RPC preflight (DECIDED) {#d03-accessibility-preflight}

**Decision:** The first RPC the harness issues after version handshake is `__tug.checkAccessibilityPermission()`. If denied, harness throws a descriptive `AccessibilityPermissionMissingError` with recovery instructions printed to stderr. Tests do not proceed past launch.

**Rationale:**
- Fails loud with actionable output (instead of hanging on a silent permission prompt mid-test).
- Developer sees the error once, grants permission in System Settings, and every subsequent run just works.

**Implications:**
- New error class in `_harness/errors.ts`.
- `__tug.checkAccessibilityPermission` is a `__tug` surface method (version bump to 1.1.0 covers it).
- Documentation / README includes the setup steps.

#### [D04] Tugcode runs under harness control; production launch paths are untouched (DECIDED) {#d04-tugcode-harness-owned}

**Decision:** In test mode, the harness spawns its own tugcode subprocess and terminates it on `app.close()`. Tug.app's production tugcode-launch path is not reached when `TUGAPP_TEST_SOCKET` is set — gated by the same env-var guard that triggers test mode.

**Rationale:**
- Production tugcode launch pulls real credentials, reads real config — all sources of test flakiness.
- Harness-owned lifecycle means tests control exactly what tugcode sees and outputs.
- Parallel to how `DeckManager.testMode` bypasses tugbank: same pattern, same reasoning.

**Implications:**
- Tug.app bridge plan (`tugplan-in-app-bridge.md`) gains a task to guard the production tugcode-launch code path behind `!testMode`.
- `__tug.startTugcode(opts)` is the harness entry point; tests call it explicitly after seedDeckState.
- Test-mode tugcode binary path is configurable so dev workstations can swap in a local build.

#### [D05] Tugcode has two modes: live (real model calls) and stub (canned transcript) (DECIDED) {#d05-tugcode-modes}

**Decision:** Harness launches tugcode in one of two modes:
- **Live mode:** real tugcode subprocess, real model API calls. Used only for `smoke-em-live.test.ts` to verify the bridge works end-to-end.
- **Stub mode (default):** tugcode receives a canned stream-json transcript via `__tug.seedTugcodeTranscript(transcript)` and replays it deterministically on each turn.

**Rationale:**
- Live mode catches real-world protocol drift but is slow and non-deterministic.
- Stub mode makes EM-card tests as fast and deterministic as FC-card tests.
- Two modes is one mode more than ideal, but one fewer than necessary — deleting either leaves a gap.

**Implications:**
- Tugcode gains a test-mode CLI flag (`--stub-transcript=<path>` or equivalent) to read a transcript from disk.
- Transcripts live under `tests/app-test/fixtures/tugcode/` as checked-in JSON files.
- Stub mode is the default for all EM-card tests in this plan; live mode is exercised only by a single smoke test.

#### [D06] Stream-json transcripts are structured records with content-hash sidecars (DECIDED) {#d06-transcript-format}

**Decision:** Transcripts are stored as JSON arrays of logical turn records (not raw on-wire bytes). Each transcript file ships with a content-hash sidecar (`<name>.sha256`). Tests that replay a transcript verify the sidecar matches what the current tugcode produces in stub mode — mismatch is a hard failure with the diff printed.

**Rationale:**
- Structured records survive cosmetic protocol drift (whitespace, field ordering).
- Content-hash sidecar catches semantic drift (new fields, renamed tags) that would otherwise silently change test meaning.
- JSON records are human-readable — a failing test's transcript can be reviewed and re-approved without tooling.

**Implications:**
- New transcript-authoring helper: `bun run scripts/capture-tugcode-transcript.ts --scenario=at0002-return` captures a live tugcode turn and writes the structured record plus sidecar.
- Checkpoint on transcript-using tests verifies sidecar match.

#### [D07] App-lifecycle simulation uses `NSApp` calls, not synthesized events (DECIDED) {#d07-app-lifecycle-nsapp}

**Decision:** `__tug.simulateAppResign / simulateAppBecomeActive / simulateAppHide / simulateAppUnhide` invoke `NSApp.deactivate()` / `.activate()` / `.hide()` / `.unhide()` directly on the main thread. The app delegate's real `applicationDid...` callbacks fire as a consequence — no shortcut, no synthesized delegate invocation.

**Rationale:**
- Real delegate callbacks are the production code path. Synthesizing delegate calls would recreate the happy-dom failure class (test passes while real-app lifecycle doesn't).
- `NSApp.hide()` etc. are well-defined primitives; their observable effect on the app matches production perfectly.

**Implications:**
- AT0004 and AT0005 tests have identical fidelity to manual verification.
- Swift handler runs these on the main thread; harness RPC returns after the delegate callback chain has drained.

#### [D08] AT-series scenario table is the canonical coverage ledger (DECIDED) {#d08-scenario-table-authoritative}

**Decision:** Spec [#s04-mseries-scenarios] enumerates every AT-series scenario this plan covers, its required harness infrastructure (synthesized, CGEventPost, EM-card, app-lifecycle), its target fix in `tugplan-selection.md`, and its test file location. Any scenario added to `tugplan-selection.md` after this plan lands must have its row added to this table or explicitly deferred with rationale.

**Rationale:**
- Without a table, coverage drifts silently — "we tested AT0002 somewhere, right?"
- Making the table the PR-review gate for any new AT-series scenario closes that gap.

**Implications:**
- PR-review checklist: "does this PR add an AT-series scenario? If so, has the table been updated?"
- Any scenario marked "DEFERRED" in the table has a one-line rationale (e.g., "AT0022 is paint-correctness; outside fidelity envelope").

#### [D09] Hardware-event tests are additive; FC/EM synthesized-event tests are not replaced (DECIDED) {#d09-hardware-events-additive}

**Decision:** The hardware-event primitive is a new capability, not a replacement. Existing AT0001/AT0003/AT0016 tests continue to use synthesized events. New tests use `CGEventPost` only when the scenario's target fix is gated on `isTrusted: true`.

**Rationale:**
- Retrofitting is churn without value — synthesized events already exercise the production code paths for those scenarios.
- Hardware-event tests are slower (real event-stream delivery, real coordinate mapping); paying that cost without reason is waste.

**Implications:**
- Scenario table [#s04-mseries-scenarios] marks infrastructure per-row.
- A scenario's infrastructure is chosen by the narrowest primitive that reaches the target behavior.

#### [D10] EM-card engine selection state is a new caret-state variant, not a flag on existing variant (DECIDED) {#d10-em-caret-variant}

**Decision:** `__tug.getCaretState(cardId)` already returns one of `{ kind: "input" } | { kind: "range" } | null`. For EM cards we add a third variant `{ kind: "engine"; engineSelection: {...}; text: string }` where `engineSelection` is whatever serializable shape the engine exposes. The existing `range` variant continues to cover pure contentEditable without engine ownership (rare or absent in current codebase — present for completeness).

**Rationale:**
- Different cards have structurally different selection shapes; a flag on a single variant leaks engine semantics into the input/range cases.
- Discriminated-union variants match how tests branch on cardtype.

**Implications:**
- `__tug.version` bump to 1.1.0 covers the variant addition.
- Spec [#s02-em-card-surface] documents the shape.
- Per-engine serialization is the engine's responsibility; harness does not attempt to normalize across engines.

#### [D11] Coverage proceeds scenario-by-scenario, not primitive-by-primitive (DECIDED) {#d11-coverage-order}

**Decision:** Phase C walks the scenario table row by row in approximate dependency order (synthesized scenarios first, then CGEventPost, then EM-card). Each row is one commit, one test file, one green assertion that its target fix binds.

**Rationale:**
- Per-row commits keep PR review digestible and regression triage crisp — a bisect hits one scenario at a time.
- Table ordering matches the complexity gradient — early rows validate the helpers before the harder rows depend on them.

**Implications:**
- Execution steps 10–16 each land one or two scenarios, not a batch of seven.
- Any row that uncovers a bug in the primitive (CGEventPost coordinate mapping, tugcode transcript replay) pauses coverage and fixes the primitive before resuming.

#### [D12] Every new AT-series test includes a deliberate revert-and-retest cycle before merge (DECIDED) {#d12-drift-prevention}

**Decision:** The Step 17 drift-prevention exercise from the base plan extends to every new AT-series test landed in this plan. Before marking a test green, the author reverts the target fix locally, re-runs, verifies red, re-applies, verifies green. The outcome is documented in the PR description ("Revert target-fix X; test fails with Y; re-apply; test passes").

**Rationale:**
- A test that "passes" but does not actually bind its target fix is the original sin we are fixing.
- Writing the revert-cycle outcome in the PR description makes it reviewable.

**Implications:**
- PR-review checklist line: "drift-prevention cycle documented? Y/N".
- Step 17 formally aggregates this into the Phase C exit criterion.

#### [D13] Harness launches Tug.app via `/usr/bin/open`, not direct Mach-O spawn (DECIDED — Step 1 2026-04-24) {#d13-open-launcher}

**Decision:** `spawnTugApp` in the TS harness invokes `/usr/bin/open -n -W [--stdout|--stderr|--env …] <bundle path>` rather than `Bun.spawn(['.../Contents/MacOS/Tug'])`. `-W` blocks until Tug.app exits (so the Bun subprocess `.exited` promise resolves at app quit), `--stdout` / `--stderr` route the app's output to the per-test log file, `--env KEY=VAL` propagates test vars. SIGTERM is routed via `pkill -x Tug` because `open -W`'s signal propagation to the launched app is unreliable.

**Rationale from Step 1 spike:**
- A bare Mach-O spawn under `Bun.spawn` inherits the bun test runner's launchd session, which doesn't have a user-level `tccd` connection. Every `AXIsProcessTrusted()` call in Tug.app returned false regardless of what the user granted in System Settings — the unified log showed `user tccd unavailable, XPC_ERROR_CONNECTION_INVALID` from the WebKit helper processes. Launch via `open` bootstraps the process into the proper GUI launchd session where `tccd` is reachable and TCC can evaluate grants.
- Without this launcher change, the entire Phase A event-post pipeline is dead on arrival — CGEvent.post silently no-ops on every call.

**Implications:**
- Every in-app test spawn goes through `open`. Test-runtime overhead is ~200ms per launch (LaunchServices bootstrap); acceptable for a dev-loop test harness.
- Between sequential tests in a file, the `-W` wait + `pkill -x Tug` teardown is deterministic (single-client model — only one Tug process at a time).
- Window-activation is still needed post-launch (see [D14]): `open` launches without activating unless we also call `NSApp.activate(ignoringOtherApps: true)` from within the spike/verb itself, because CGEvent mouse events route through windowserver → frontmost window at coord, and an unactivated Tug.app lets the click go to whatever app was previously frontmost.

#### [D14] Phase A requires stable code-signing (self-signed `Tug Dev` identity in login keychain) (DECIDED — Step 1 2026-04-24) {#d14-stable-signing}

**Decision:** The `test-in-app` recipe re-signs `Tug.app` with a stable local code-signing identity (`Tug Dev`, self-signed via `scripts/setup-dev-signing.sh`) after every xcodebuild. Xcode Debug's default ad-hoc signing produces a fresh signature hash on every rebuild; macOS TCC keys grants on signature-hash, so the ad-hoc default invalidates the Accessibility grant on every rebuild and makes `CGEvent.post` silently no-op. Stable signing → stable hash → grant persists across the iteration loop.

**Rationale from Step 1 spike:**
- Default Xcode Debug: `Signature=adhoc`. Re-signing produced `designated => identifier "dev.tugtool.app" and certificate leaf = H"3398…"` — stable across rebuilds.
- `tccutil reset Accessibility dev.tugtool.app` removed stale grants from previous ad-hoc signatures; after the stable-identity re-sign, a single user grant in System Settings persists indefinitely.
- `scripts/setup-dev-signing.sh` is idempotent, creates the per-machine cert if absent (not checked in; only the identity NAME is shared across machines). Each dev grants AX permission once on their own machine; user-scoped grants don't transfer across machines anyway.
- Observed OpenSSL 3.x PKCS#12 pitfalls handled in the script: `-legacy` flag + non-empty password for `security import` compatibility (Apple's Security framework rejects modern OpenSSL defaults with "MAC verification failed").

**Implications:**
- `just test-in-app` gate: prechecks for `Tug Dev` identity; fails with `just setup-dev-signing` instruction if absent.
- `codesign --sign "Tug Dev" --force --deep --preserve-metadata=entitlements,requirements` re-signs in the test-in-app recipe between xcodebuild and test execution.
- Extends the base-plan [D03] (accessibility preflight): the preflight's `AXIsProcessTrustedWithOptions(prompt: true)` pops a system dialog on first grant; user actions System Settings toggle; grant persists thereafter as long as the binary keeps signing with `Tug Dev`.
- CI note: [Q01] (CI AX handling) gets a concrete answer in the same shape — CI runners need both the `Tug Dev` identity import AND a pre-granted AX permission for `dev.tugtool.app`. Still DEFERRED to an actual CI setup, but the path is clearer.

---

### Deep Dives {#deep-dives}

#### Hardware events — Phase A {#phase-a-hardware}

Phase A adds one Swift-side primitive and five TypeScript surface methods. Zero transport changes.

##### A.1 Coordinate mapping {#coord-mapping}

Tests express coordinates in WebView viewport (CSS) space (e.g., "click element at viewport (120, 170)"). Swift `CoordMapping.viewportToScreen(_:in:)` converts viewport (CSS, Y-down, origin top-left of web content) → CG screen (Y-down, origin top-left of the primary display). The math looks direct but has a Y-flip landmine: WKWebView's content coordinate system is Y-DOWN (not AppKit's usual Y-up), so the naive "flip viewport to view-local, then flip screen AppKit to CG" chain double-flips and puts the click hundreds of pixels off. Validated by Step 1 (spike found this bug live on a multi-display rig).

The landed implementation passes the viewport point directly to `webView.convert(_:to:nil)` — the convert call transparently handles the Y-down → Y-up flip into the window coord system — and then applies a single final Y-flip against the PRIMARY screen's height to produce CG coords:

```swift
static func viewportToScreen(_ viewportPoint: CGPoint, in webView: WKWebView) -> CGPoint? {
    let viewSize = webView.bounds.size
    guard viewportPoint.x >= 0, viewportPoint.x <= viewSize.width,
          viewportPoint.y >= 0, viewportPoint.y <= viewSize.height else { return nil }
    guard let window = webView.window else { return nil }

    // Viewport (Y-down) passed directly to convert; WKWebView's
    // isFlipped-style content coords are handled by the convert call.
    let windowPoint = webView.convert(viewportPoint, to: nil)
    let screenAppKit = window.convertToScreen(NSRect(origin: windowPoint, size: .zero)).origin

    // Flip Y against the PRIMARY screen (the one with the menu bar).
    // `NSScreen.screens.first` — NOT `NSScreen.main` (which is the
    // key window's screen). On multi-display rigs these differ; CG
    // screen coords are rooted at the primary display regardless of
    // which display the window is on.
    let primaryScreenHeight = NSScreen.screens.first?.frame.height ?? 0
    return CGPoint(x: screenAppKit.x, y: primaryScreenHeight - screenAppKit.y)
}
```

**Worked numeric example from Step 1's spike (2026-04-24 run on a multi-display rig):**

| Quantity | Value |
|---|---|
| Viewport input | (120.0, 170.0) |
| `webView.bounds.size` | 2154 × 1524 |
| `webView.convert((120, 170), to: nil)` (window-local AppKit Y-up) | (120.0, 1354.0) |
| `window.convertToScreen(...)` (screen AppKit Y-up) | (677.0, screen-AppKit-Y) |
| `NSScreen.screens.first.frame.height` | 1800 |
| Final CG screen point | (677.0, 279.0) |
| Click's received `event.clientX` / `clientY` | (120.0, 170.0) — delta (0, 0) |

The 279 is exactly `windowTopCG(81) + titleBarHeight(28) + viewportY(170)`: the title-bar offset between the NSWindow frame (1552 tall) and the WKWebView content area (1524 tall) is accounted for entirely by `webView.convert` + `window.convertToScreen`; no manual chrome correction is needed.

Returns `nil` when the viewport point is outside the WKWebView's visible frame; callers convert `nil` into `CoordinateOutOfBoundsError` at the RPC boundary.

Practical API shape:

```ts
// Test-side (high-level)
await app.nativeClickAtElement('[data-testid="close-button"]');
await app.nativeClick({ x: 120, y: 240 });   // document coords; harness resolves to screen

// Surface (low-level, wraps RPC)
window.__tug.nativeClickAtElement(selector, opts?): Promise<void>;
window.__tug.nativeClick(point, opts?): Promise<void>;
```

`nativeClickAtElement` computes the element's center via `getBoundingClientRect()` inside `evalJS`, then forwards the viewport point to the Swift bridge, which applies `viewportToScreen` before posting the CGEvent.

##### A.2 Key + text input {#native-key-type}

```ts
window.__tug.nativeKey(key: string, mods?: Array<"cmd" | "shift" | "alt" | "ctrl">): Promise<void>;
window.__tug.nativeType(text: string): Promise<void>;
window.__tug.holdModifier(mods: Array<"cmd" | "shift" | "alt" | "ctrl">, thunk: () => Promise<void>): Promise<void>;
```

`nativeKey` posts a `CGKeyCode` down-then-up event with the full modifier flag bitmap so WebKit's real accelerator-key path fires (vs. the JS `select()` API, which selection introspection cannot distinguish from a real Cmd+A — this is why Step 1 experiment 4 exists).

`nativeType` iterates `nativeKey` per character using the US-ASCII keycode table (non-ASCII input is rejected with `NativeTypeAsciiOnlyError`; IME / unicode text is out of envelope — see [AT0012] below).

`holdModifier` presses the modifier flags, runs the inner thunk, and releases the flags in reverse order. Inner gestures see the flags on every event they post. Flag release uses a `defer` block Swift-side so inner failures don't leave modifiers stuck between tests.

##### A.3 Pointer-gesture verbs — full set {#native-pointer-verbs}

Step 2 ships the following Swift verbs; Step 3 ships the matching `__tug` TS surface methods. All verbs accept screen-coord points or selectors (selector variants resolve via `getElementBounds` + `CoordMapping.viewportToScreen`).

```ts
// Single click — primary or named button
nativeClick(point, {button?: "left" | "right"; clickCount?: number}): Promise<void>;
nativeClickAtElement(selector, {button?, clickCount?, dx?, dy?}): Promise<void>;

// Double click — pinned interval (see NATIVE_DOUBLE_CLICK_INTERVAL_MS in Step 2)
nativeDoubleClick(point): Promise<void>;
nativeDoubleClickAtElement(selector): Promise<void>;

// Right click — context-menu path coverage
nativeRightClick(point): Promise<void>;
nativeRightClickAtElement(selector): Promise<void>;

// Drag — endpoint-only (no interpolation)
nativeDrag(from, to, {mouseDownDelayMs?, mouseUpDelayMs?}): Promise<void>;
nativeDragElement(fromSelector, to, opts?): Promise<void>;  // `to` is `{x,y}` or `{selector}`

// Primitives — for niche scenarios only; tests should prefer click/drag convenience verbs
nativeMouseDown(point, {button?}): Promise<void>;
nativeMouseUp(point, {button?}): Promise<void>;
```

Double-click interval is pinned at `NATIVE_DOUBLE_CLICK_INTERVAL_MS = 80` (deliberately shorter than macOS default so tests don't risk being read as slow single-clicks by WebKit). Drag is endpoint-only because the Phase C AT-series scenarios only need start→end semantics; tests that need a painted trail can decompose the motion into endpoint-by-endpoint sub-drags.

##### A.4 Introspection primitives {#native-introspection}

JS-side reads (no new Swift required beyond `getElementScreenBounds`). All selector-keyed.

```ts
getElementText(selector): Promise<string>;                   // textContent for non-inputs, value for inputs
getElementValue(selector): Promise<string>;                  // explicit .value
getElementAttribute(selector, name): Promise<string | null>;
getElementBounds(selector): Promise<{x, y, width, height}>;  // viewport-relative
getElementScreenBounds(selector): Promise<{x, y, width, height}>; // screen-global CG coords (uses CoordMapping)
getElementState(selector): Promise<{disabled, readOnly, checked, visible, tagName, isFocused}>;
getActiveElement(): Promise<{tagName, id, cardId, persistKey, selector} | null>;
getSelection(cardId?): Promise<CaretState | null>;           // superset of getCaretState; covers contentEditable ranges
getComputedStyle(selector, property): Promise<string>;
```

`getCaretState(cardId)` is kept as a narrow alias that throws when the active element inside the card is not a form control — tests that want the stricter contract can still assert on it.

##### A.3 App-lifecycle simulation {#app-lifecycle-sim}

Per [D07]:

```ts
window.__tug.simulateAppResign(): Promise<void>;         // NSApp.deactivate()
window.__tug.simulateAppBecomeActive(): Promise<void>;   // NSApp.activate(ignoringOtherApps: true)
window.__tug.simulateAppHide(): Promise<void>;           // NSApp.hide(nil)
window.__tug.simulateAppUnhide(): Promise<void>;         // NSApp.unhide(nil)
```

Swift handler marshals to the main thread, invokes the NSApp call, waits for the corresponding delegate callback to fire (bounded 1000ms), returns. If the delegate never fires, returns an error.

Unlocks AT0004, AT0005, and partially AT0020 (modal-overlay dismiss scenarios where the overlay is triggered by app-resign).

#### EM-card harness — Phase B {#phase-b-em}

Phase B adds a tugcode subprocess lifecycle and EM-card-specific surface methods.

##### B.1 Tugcode subprocess lifecycle {#tugcode-lifecycle}

Spec [#s03-tugcode-lifecycle] is the contract. Summary:

1. After `launchTugApp` completes and version-handshake passes, tests call `await app.startTugcode({ mode: "stub" | "live" })`.
2. Harness sends `__tug.startTugcode(opts)` which triggers Tug.app's test-mode tugcode launch path (Swift-side under `#if DEBUG`). Binary path resolution follows a `TUGAPP_TUGCODE_BINARY` env var with a sensible default.
3. In stub mode, Tug.app launches tugcode with `--stub-transcript=<fd>` where `<fd>` is a pipe the harness populates via `seedTugcodeTranscript`.
4. Bridge IPC (stream-json) is the same protocol tugcode speaks in production. The harness does not intercept it; tugcode and tugdeck talk directly over their usual channels.
5. `app.close()` or `app.stopTugcode()` terminates the tugcode process (`SIGTERM`, then `SIGKILL` after 2000ms).

Harness-owned lifecycle means per-test isolation: every test file starts its own tugcode and kills it on completion.

##### B.2 Deterministic stub-transcript mode {#stub-transcripts}

Per [D05] and [D06]:

- Stub transcripts live at `tests/app-test/fixtures/tugcode/<scenario>.transcript.json`.
- Each transcript is an array of structured turn records:

```json
[
  {
    "turn": 0,
    "prompt": { "role": "user", "content": "..." },
    "response": [
      { "type": "stream-start" },
      { "type": "text-delta", "text": "Hello" },
      { "type": "text-delta", "text": " world" },
      { "type": "stream-end" }
    ]
  }
]
```

- Content-hash sidecar `<scenario>.transcript.json.sha256` is verified on test load. Mismatch fails with a diff and a `bun run scripts/reapprove-transcript.ts <scenario>` instruction.
- `seedTugcodeTranscript(transcript)` loads the transcript into tugcode's stub-mode input for the next N turns.

##### B.3 EM-card surface extensions {#em-surface}

New methods on `__tug` (version 1.1.0):

```ts
interface TugTestSurface {
  // ... inherited v1.0.0 surface

  // Tugcode lifecycle (Phase B.1).
  startTugcode(opts: { mode: "stub" | "live"; binaryPath?: string }): void;
  stopTugcode(): void;
  seedTugcodeTranscript(transcript: TugcodeTranscript): void;
  seedTugcodeError(opts: { turn: number; error: { name: string; message: string } }): void;

  // EM-card observation (Phase B.3).
  getEmCardState(cardId: string): {
    kind: "em";
    engine: "tide-card" | "tug-prompt-input" | "gallery-prompt-entry" | string;
    text: string;
    engineSelection: unknown;     // engine-specific serializable shape (see [D10])
    streamState: "idle" | "streaming" | "error";
    lastTurnSeq: number;
  } | null;

  getEngineSelection(cardId: string): unknown;   // typed per-engine by caller
  awaitEngineReady(cardId: string, timeoutMs?: number): void;   // resolves when engine.onContentReady
  drainTugcodeTurn(cardId: string, timeoutMs?: number): void;   // resolves on stream-end
}

type TugcodeTranscript = ReadonlyArray<{
  turn: number;
  prompt: unknown;
  response: ReadonlyArray<unknown>;
}>;
```

`getCaretState` from v1.0.0 gains the `engine` variant per [D10].

##### B.4 EM-card gesture drivers {#em-gestures}

Tests drive EM-card gestures via the existing `click` / `type` / `focusElement` for DOM-level interactions, and via `drainTugcodeTurn` for "wait until tugcode finishes streaming this turn." `type` into a contentEditable uses the native-setter pattern adapted for `textContent` and dispatches synthetic `beforeinput` / `input` events per the engine's expected shape.

#### AT-series coverage — Phase C {#phase-c-coverage}

Spec [#s04-mseries-scenarios] is the authoritative table. Steps 10–16 walk it row by row. Each row becomes one test file with:

- Seed step: `seedDeckState`, `startTugcode` (if EM), `seedTugcodeTranscript` (if EM stub).
- Drive step: `click` / `type` / `nativeClick` / `simulateAppHide` / etc. per the row's infrastructure column.
- Assert step: `expectFocusedCard`, `expectCaret`, trace-subsequence via `toContainOrderedSubset`.
- Drift-prevention: documented in PR per [D12].

Grouping of rows into steps is chosen to land related infrastructure validations together (synthesized-only scenarios first; CGEventPost scenarios batch after Phase A integration; EM-card scenarios batch after Phase B integration).

---

### Specification {#specification}

#### Spec S01: Hardware-event RPC protocol extensions {#s01-hardware-rpc}

Extends Spec S02 of the base harness plan with five new request kinds:

```ts
type Request =
  | { id: number; method: "evalJS";           script: string;                     timeoutMs?: number }
  | { id: number; method: "waitForCondition"; script: string; timeoutMs?: number; pollMs?: number }
  // New in this plan:
  | { id: number; method: "nativeClick";        point: { x: number; y: number };              button?: "left" | "right";  timeoutMs?: number }
  | { id: number; method: "nativeMouseDown";    point: { x: number; y: number };              button?: "left" | "right";  timeoutMs?: number }
  | { id: number; method: "nativeMouseUp";      point: { x: number; y: number };              button?: "left" | "right";  timeoutMs?: number }
  | { id: number; method: "nativeKey";          key: string;  modifiers?: string[];           timeoutMs?: number }
  | { id: number; method: "nativeType";         text: string;                                 timeoutMs?: number }
  | { id: number; method: "simulateAppResign";                                                timeoutMs?: number }
  | { id: number; method: "simulateAppBecomeActive";                                          timeoutMs?: number }
  | { id: number; method: "simulateAppHide";                                                  timeoutMs?: number }
  | { id: number; method: "simulateAppUnhide";                                                timeoutMs?: number }
  | { id: number; method: "checkAccessibilityPermission";                                     timeoutMs?: number };
```

Response shape unchanged (discriminated `{ ok: true, value } | { ok: false, error }`). New error classes:

- `AccessibilityPermissionMissingError` — surfaces from `checkAccessibilityPermission` when permission is not granted.
- `CoordinateOutOfBoundsError` — surfaces from `nativeClick*` when the event coordinate maps outside the WebView.
- `AppLifecycleTimeoutError` — surfaces from `simulateApp*` when the expected NSApp delegate callback does not fire within the timeout.

Point coordinates are in WebView document space. Server-side translates via `WebView.bounds` → content-view → window → screen.

#### Spec S02: EM-card surface extensions {#s02-em-card-surface}

Extends Spec S03 of the base harness plan. Full surface in Deep Dive [#em-surface]; summary fields:

- `__tug.version === "1.1.0"` (bumped from `1.0.0`).
- New methods: `startTugcode`, `stopTugcode`, `seedTugcodeTranscript`, `seedTugcodeError`, `getEmCardState`, `getEngineSelection`, `awaitEngineReady`, `drainTugcodeTurn`.
- New caret-state variant: `{ kind: "engine"; engineSelection: unknown; text: string }`.
- `reset` opts gains one axis: `tugcode?: boolean` — drains pending turns and resets stub-transcript cursor.

#### Spec S03: Tugcode subprocess lifecycle contract {#s03-tugcode-lifecycle}

Full write-up in Deep Dive [#tugcode-lifecycle]. Contract points:

1. **Spawn**: Tug.app launches tugcode subprocess when `__tug.startTugcode(opts)` is called; binary path resolved via `TUGAPP_TUGCODE_BINARY` env with default fallback.
2. **Stub mode**: tugcode started with `--stub-transcript=<fd>`; harness provides the transcript via `seedTugcodeTranscript`.
3. **Live mode**: tugcode started with normal args (real model, real credentials); reserved for `smoke-em-live.test.ts`.
4. **Teardown**: `__tug.stopTugcode()` sends `SIGTERM`; `SIGKILL` follows after 2000ms if process still alive.
5. **Observability**: tugcode stdout/stderr route to `tests/app-test/logs/<test>-tugcode.log` (companion to Tug.app's log file).
6. **Version**: tugcode's version string is recorded on successful launch; mismatch against harness-expected version throws `TugcodeVersionSkewError`.
7. **Isolation**: every test file owns its own tugcode process (see [Q03] — may move to per-launch if startup cost warrants).

#### Spec S04: AT-series scenario coverage table {#s04-mseries-scenarios}

Authoritative ledger. Every row is one committed test file. Infrastructure column determines which Phase A / B primitive the test requires.

| Scenario | Test file | Infra | Target fix | Notes |
|---------|-----------|-------|-----------|------|
| [AT0001] FC intra-pane tab switch | `at0001-tab-switch-fc.test.ts` | synthesized | selection Step 23B | **Landed in base harness plan.** Listed for completeness. |
| [AT0002] EM intra-pane tab switch | `at0002-tab-switch-em.test.ts` | EM-card (stub) | selection Step 23E | Seed tide-card with text + selection; switch tabs; switch back; assert engine selection restored. |
| [AT0003] FC pane activation | `at0003-pane-activation.test.ts` | synthesized | selection Step 23B | **Landed in base harness plan.** |
| [AT0004] App resign → become-active | `at0004-app-resign-return.test.ts` | app-lifecycle | selection Step 23D | `simulateAppResign` → `simulateAppBecomeActive`; assert refocus. |
| [AT0005] App hide → unhide | `at0005-app-hide-unhide.test.ts` | app-lifecycle | selection Step 23D | Parallel to AT0004 via `simulateAppHide` / `simulateAppUnhide`. |
| [AT0006-FC] Cross-pane drag — FC half | `at0006-cross-pane-fc.test.ts` | CGEventPost | selection Step 23C | Drag start requires `isTrusted: true` for some WebKit drag-data paths; use `nativeMouseDown` → `nativeMouseMove`* → `nativeMouseUp`. |
| [AT0006-EM] Cross-pane drag — EM half | `at0006-cross-pane-em.test.ts` | CGEventPost + EM-card | selection Step 23E | As AT0006-FC but EM content; EM selection restored after drop. |
| [AT0007-FC] Card detach — FC half | `at0007-card-detach-fc.test.ts` | CGEventPost | selection Step 23C | Detach to new standalone pane via trusted drag. |
| [AT0007-EM] Card detach — EM half | `at0007-card-detach-em.test.ts` | CGEventPost + EM-card | selection Step 23E | Parallel to AT0007-FC with EM content. |
| [AT0009] EM inactive-at-mount | `at0009-em-inactive-mount.test.ts` | EM-card (stub) | selection Step 23E | Seed EM card in inactive pane; activate pane; assert engine focus + paint. |
| [AT0011] Card close → reopen | `at0011-card-close-reopen.test.ts` | synthesized | tracked separately | Reopen-path test is scaffolded so the test fails until the closure is implemented; marked `skip` until then. |
| [AT0012] IME composition | `at0012-ime-composition.test.ts` | CGEventPost | tracked separately | Uses `nativeKey` for IME dead-key sequences. Fidelity-limited: Kotoeri/US keyboard only. |
| [AT0014] Scroll persistence | `at0014-scroll-persistence.test.ts` | synthesized | component-persistence | Uses `element.scrollTop` writes + `scroll` event dispatch; assert scroll survives transition. |
| [AT0015] Legacy `SavedSelection` API removal | `at0015-legacy-api-removal.test.ts` | synthesized | component-persistence refactor | Grep-based test under `tests/app-test/` — no legacy API symbols remain after the rewrite; semantic parity test verifies new API covers prior call sites. |
| [AT0018] Async content-load race | `at0018-async-content-ready-race.test.ts` | EM-card (stub) | selection Step 23E | Transcript replays a slow turn; `onContentReady` fires after save; assert post-ready refocus. |
| [AT0019] Pane close / deck teardown | `at0019-pane-close-teardown.test.ts` | synthesized | tracked separately | Close pane with multiple cards; trace `save-callback` fires once per card. |
| [AT0020] Modal overlay dismiss → focus return | `at0020-overlay-focus-return.test.ts` | CGEventPost | tracked separately | Open context menu via `nativeClick` right-click; dismiss via Escape; assert focus return to the originating input. |
| [AT0021] Drag aborted | `at0021-drag-aborted.test.ts` | CGEventPost | selection Step 23C | Start drag via `nativeMouseDown`; press Escape via `nativeKey`; assert original focus restored. |
| [AT0023] Cross-card selection | `at0023-cross-card-selection.test.ts` | CGEventPost | tracked separately | Selection spanning two cards requires trusted mousedown for WebKit to extend the selection; assert spanning selection persists or resolves per spec. |
| [AT0029] Scroll-key audit | `at0029-scroll-key-audit.test.ts` | synthesized | component-persistence | Per-component scroll persistence across all scroll-key-having components. |
| [AT0030] Virtual-focus composite | `at0030-virtual-focus.test.ts` | synthesized | component-persistence | Focus-within for composite components; assert inner focus survives outer-component transitions. |
| [AT0008] No `onCardActivated` hook | — | — | DEFERRED | Meta-scenario about infra shape; validated by the fact that AT0002/AT0006-EM/AT0007-EM/AT0009 all land. |
| [AT0010] Markdown-view copy selection | `at0010-markdown-selection.test.ts` | CGEventPost | component-persistence | Text selection in markdown view via trusted mousedown+drag; copy event; persist across transition. |
| [AT0013] Integration test coverage | — | — | DEFERRED | Meta-scenario; this plan's own existence closes it. |
| [AT0017] `saveState` RPC captures focus | — | — | CLOSED | Closed by Step 18 of selection plan; no test needed here. |
| [AT0022] Caret visibility paint | — | — | DEFERRED | Outside fidelity envelope; manual verification only. |
| [AT0024] Component-persistence protocol | — | — | CLOSED | Closed by [D13]+[A9] of selection plan. |
| [AT0025] Intrinsic internal state | — | — | CLOSED | Covered by component-persistence gallery tests. |
| [AT0026] Open-overlay persistence policy | — | — | DEFERRED | Policy-undecided; test follows policy decision. |
| [AT0027] Layout state | — | — | DEFERRED | Broader layout-persistence effort; separate plan. |
| [AT0028] Banner dismiss persistence | — | — | DEFERRED | Component-persistence scope; separate plan. |
| [AT0031] `tug-prompt-entry` UI state | — | — | DEFERRED | Component-persistence scope; separate plan. |

Rows marked DEFERRED are intentional non-goals; each has a one-line rationale per [D08].

(* `nativeMouseMove` is added opportunistically in Step 1 if the Step 1 spike reveals it is needed for WebKit drag initiation; otherwise drag tests use `nativeMouseDown` immediately followed by `nativeMouseUp` at the destination.)

#### Spec S05: Documentation additions to harness README {#s05-readme-additions}

`tests/app-test/README.md` (authored in the base plan) gains three sections:

- **Accessibility permission setup** — step-by-step instructions for granting permission to the DEBUG build of Tug.app on the developer workstation.
- **Tugcode test-mode** — how to author a stub transcript, how to use the `capture-tugcode-transcript.ts` script, what the content-hash sidecar is for.
- **Scenario table cross-reference** — pointer to Spec [#s04-mseries-scenarios] and the PR-review checklist line.

#### Spec S06: New error classes {#s06-error-classes}

Added to `tests/app-test/_harness/errors.ts`:

- `AccessibilityPermissionMissingError` — thrown by `launchTugApp` if first-RPC preflight fails.
- `CoordinateOutOfBoundsError` — thrown by `nativeClick` / `nativeMouseDown` / `nativeMouseUp` when coordinate falls outside the WebView.
- `AppLifecycleTimeoutError` — thrown by `simulateApp*` when NSApp delegate callback times out.
- `TugcodeLaunchError` — thrown by `startTugcode` if tugcode fails to launch.
- `TugcodeVersionSkewError` — thrown on version mismatch against expected tugcode version.
- `TugcodeTranscriptMismatchError` — thrown on content-hash sidecar mismatch.

---

### List L01: New recording-site kinds (deck-trace extensions) {#l01-em-recording-sites}

EM-card coverage requires two new recording sites in `tugdeck/src/deck-trace.ts`:

- `engine-ready` — fires from each EM-card's `onContentReady` callback. Fields: `cardId`, `engine: "tide-card" | "tug-prompt-input" | ...`.
- `engine-activation-dispatched` — fires when `onCardActivated` (Step 23E hook) runs. Fields: `cardId`, `engine`, `dispatchedFrom: "row-1" | "row-2" | ... | "row-5"`.

Extends the `DeckTraceEvent` union from Spec S01 of the base plan. Version bump to `1.1.0` of the surface covers the addition (see [D11] of base plan).

### List L02: Transcript fixture files {#l02-transcript-fixtures}

Checked-in transcripts under `tests/app-test/fixtures/tugcode/`:

- `at0002-return.transcript.json` — two-turn: initial content, edited content after tab-return.
- `at0006-em-cross-pane.transcript.json` — single turn capturing a short tide completion.
- `at0007-em-detach.transcript.json` — mirrors m06 fixture with different target pane.
- `at0009-em-inactive-mount.transcript.json` — turn that produces enough text to exceed one viewport, exercising scroll + selection.
- `at0018-async-slow-stream.transcript.json` — multi-chunk stream with a deliberate inter-chunk delay marker.

Each fixture has a `.sha256` sidecar. `bun run scripts/reapprove-transcript.ts <scenario>` is the tooling to update both when tugcode changes legitimately.

### List L03: New files per phase {#l03-new-files}

Phase A:
- `tugapp/Sources/TestHarness/CoordMapping.swift` — document→screen coord-mapping helper with Y-flip; lands in Step 1, reused by every native-gesture handler.
- `tugapp/Sources/TestHarness/CGEventSpike.swift` — THROWAWAY spike file lands in Step 1, deleted at step close.
- `tugapp/Sources/TestHarness/NativeEventHandlers.swift` — Swift gesture + keyboard handlers (`nativeClick`/`nativeDoubleClick`/`nativeRightClick`/`nativeDrag`/`nativeMouseDown`/`nativeMouseUp`/`nativeKey`/`nativeType`/`holdModifier`). Gated `#if DEBUG`.
- `tugapp/Sources/TestHarness/VirtualKeyMap.swift` — ASCII-name → `CGKeyCode` mapping for US-English keyboards.
- `tugapp/Sources/TestHarness/TestHarnessConnection.swift` — dispatch table grows with every new native verb.
- `tugdeck/src/test-surface.ts` — gains native gestures (`nativeClick[AtElement]`, `nativeDoubleClick[AtElement]`, `nativeRightClick[AtElement]`, `nativeDrag[Element]`, `nativeMouseDown/Up`), keyboard (`nativeKey`, `nativeType`, `holdModifier`), and introspection (`getElementText`, `getElementValue`, `getElementAttribute`, `getElementBounds`, `getElementScreenBounds`, `getElementState`, `getActiveElement`, `getSelection`, `getComputedStyle`).
- `tests/app-test/_spike-cgevent.test.ts` — THROWAWAY spike test lands in Step 1, deleted at step close.
- `tests/app-test/smoke-native.test.ts` — scaffolded empty in Step 2, filled in Step 3 with five tests (single-click trust, type, Cmd+A, drag-endpoint selection, double-click word-select).
- `tests/app-test/_harness/errors.ts` — gains `AccessibilityPermissionMissingError`, `CoordinateOutOfBoundsError`, `NativeTypeAsciiOnlyError`.

Phase B:
- `tugapp/<phase-b-files>` — tugcode subprocess spawn + teardown (gated `#if DEBUG`).
- `tugdeck/src/test-surface.ts` — gains EM-card methods.
- `tests/app-test/smoke-em.test.ts` — stub-mode round-trip smoke.
- `tests/app-test/smoke-em-live.test.ts` — live-mode smoke.
- `tests/app-test/fixtures/tugcode/*.transcript.json` — stub transcripts per [L02].
- `scripts/capture-tugcode-transcript.ts` — authoring helper.
- `scripts/reapprove-transcript.ts` — sidecar updater.

Phase C:
- One test file per non-deferred scenario per [L02] row.
- `tests/app-test/_harness/scenarios.ts` — shared seeding helpers for common pane/card shapes.

---

### Risks and Mitigations {#risks-dup}

See [#risks] above.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugapp/<phase-a-bridge>` | Swift CGEventPost handlers, app-lifecycle NSApp handlers, accessibility-permission check (all `#if DEBUG`) |
| `tugapp/<phase-b-bridge>` | Swift tugcode subprocess spawn/teardown handlers (all `#if DEBUG`) |
| `tests/app-test/smoke-native.test.ts` | `isTrusted: true` delivery smoke test |
| `tests/app-test/smoke-em.test.ts` | EM-card stub-mode round-trip smoke |
| `tests/app-test/smoke-em-live.test.ts` | EM-card live tugcode smoke (non-default) |
| `tests/app-test/fixtures/tugcode/` | Canned transcript fixtures + sidecars per [L02] |
| `tests/app-test/_harness/scenarios.ts` | Shared pane/card seeding helpers for AT-series tests |
| `scripts/capture-tugcode-transcript.ts` | Authoring helper for stub transcripts |
| `scripts/reapprove-transcript.ts` | Sidecar updater when tugcode output legitimately changes |
| `tests/app-test/at0002-tab-switch-em.test.ts` | AT0002 test |
| `tests/app-test/at0004-app-resign-return.test.ts` | AT0004 test |
| `tests/app-test/at0005-app-hide-unhide.test.ts` | AT0005 test |
| `tests/app-test/at0006-cross-pane-fc.test.ts` | AT0006 FC-half |
| `tests/app-test/at0006-cross-pane-em.test.ts` | AT0006 EM-half |
| `tests/app-test/at0007-card-detach-fc.test.ts` | AT0007 FC-half |
| `tests/app-test/at0007-card-detach-em.test.ts` | AT0007 EM-half |
| `tests/app-test/at0009-em-inactive-mount.test.ts` | AT0009 test |
| `tests/app-test/at0010-markdown-selection.test.ts` | AT0010 test |
| `tests/app-test/at0011-card-close-reopen.test.ts` | AT0011 test (skip until reopen lands) |
| `tests/app-test/at0012-ime-composition.test.ts` | AT0012 test |
| `tests/app-test/at0014-scroll-persistence.test.ts` | AT0014 test |
| `tests/app-test/at0015-legacy-api-removal.test.ts` | AT0015 test |
| `tests/app-test/at0018-async-content-ready-race.test.ts` | AT0018 test |
| `tests/app-test/at0019-pane-close-teardown.test.ts` | AT0019 test |
| `tests/app-test/at0020-overlay-focus-return.test.ts` | AT0020 test |
| `tests/app-test/at0021-drag-aborted.test.ts` | AT0021 test |
| `tests/app-test/at0023-cross-card-selection.test.ts` | AT0023 test |
| `tests/app-test/at0029-scroll-key-audit.test.ts` | AT0029 test |
| `tests/app-test/at0030-virtual-focus.test.ts` | AT0030 test |

#### Modified files {#modified-files}

| File | Change |
|------|--------|
| `tugdeck/src/test-surface.ts` | Add native-event methods, app-lifecycle methods, tugcode lifecycle methods, EM-card observation methods; bump `__tug.version` from `1.0.0` to `1.1.0` |
| `tugdeck/src/deck-trace.ts` | (Phase 0) Stamp caller `loc` and `store` snapshot on every recorded event per Steps 0a + 0c. (Phase B) Add `engine-ready` and `engine-activation-dispatched` event kinds to `DeckTraceEvent` union per [L01] |
| `tests/app-test/_harness/matchers.ts` | (Phase 0) Annotate out-of-order matches; emit one-line event summary above JSON dump per Steps 0b + 0e; ignore `loc` / `store` fields in partial match |
| `tests/app-test/_harness/client.ts` | (Phase 0) Add `dumpTraceToFile(path)` helper per Step 0f |
| `tests/app-test/at0001-tab-switch-fc.test.ts`, `at0003-pane-activation.test.ts`, `at0016-tab-close-handoff.test.ts` | (Phase 0) Catch blocks print Tug.app log tail (200 lines) *before* rethrowing; write per-test trace artifact to `tests/app-test/logs/<test>-trace.json` per Steps 0d + 0f |
| `tugdeck/src/main.tsx` | No changes expected (boot unchanged) |
| `tests/app-test/_harness/index.ts` | Add typed wrappers for new RPC verbs; add `startTugcode` / `seedTugcodeTranscript` / `drainTugcodeTurn` helpers |
| `tests/app-test/_harness/errors.ts` | Add error classes per Spec [#s06-error-classes] |
| `tests/app-test/README.md` | Add sections per Spec [#s05-readme-additions] |
| `dash/tugplan-in-app-bridge.md` | Amend with Phase A and Phase B file-level DEBUG-guard placement for `CGEventPost` and tugcode spawn code |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `nativeClick` / `nativeClickAtElement` | method | `tugdeck/src/test-surface.ts` | Wraps Phase A RPC verb |
| `nativeMouseDown` / `nativeMouseUp` / `nativeMouseMove` | method | `tugdeck/src/test-surface.ts` | Phase A primitives |
| `nativeKey` / `nativeType` | method | `tugdeck/src/test-surface.ts` | Phase A keyboard primitives |
| `simulateAppResign` / `simulateAppBecomeActive` / `simulateAppHide` / `simulateAppUnhide` | method | `tugdeck/src/test-surface.ts` | Phase A app-lifecycle |
| `checkAccessibilityPermission` | method | `tugdeck/src/test-surface.ts` | First-RPC preflight |
| `startTugcode` / `stopTugcode` | method | `tugdeck/src/test-surface.ts` | Phase B lifecycle |
| `seedTugcodeTranscript` / `seedTugcodeError` | method | `tugdeck/src/test-surface.ts` | Phase B determinism |
| `getEmCardState` / `getEngineSelection` / `awaitEngineReady` / `drainTugcodeTurn` | method | `tugdeck/src/test-surface.ts` | Phase B observation |
| `AccessibilityPermissionMissingError` | class | `tests/app-test/_harness/errors.ts` | Spec [#s06-error-classes] |
| `CoordinateOutOfBoundsError` | class | `tests/app-test/_harness/errors.ts` | Spec [#s06-error-classes] |
| `AppLifecycleTimeoutError` | class | `tests/app-test/_harness/errors.ts` | Spec [#s06-error-classes] |
| `TugcodeLaunchError` / `TugcodeVersionSkewError` / `TugcodeTranscriptMismatchError` | class | `tests/app-test/_harness/errors.ts` | Spec [#s06-error-classes] |
| `TugcodeTranscript` | type | `tugdeck/src/test-surface.ts` | Phase B transcript shape |
| `DeckTraceEvent` | type | `tugdeck/src/deck-trace.ts` | Gains `engine-ready` and `engine-activation-dispatched` variants per [L01] |

---

### Documentation Plan {#documentation-plan}

- [ ] Update `tests/app-test/README.md` per Spec [#s05-readme-additions] — accessibility setup, tugcode test mode, scenario table cross-reference.
- [ ] Extend `tugapp/` README with `CGEventPost`-variant explainer (local-dev only, permission requirement, DEBUG-only).
- [ ] Author `scripts/capture-tugcode-transcript.ts` + `scripts/reapprove-transcript.ts` with inline `--help` documentation.
- [ ] Add a scenario-table PR-review checklist line to the repo's PR template (or equivalent docs location).
- [ ] Cross-link this plan from `.tugtool/tugplan-in-app-test-harness.md` §Roadmap (mark the roadmap rows closed by this plan's completion).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (happy-dom allowed)** | Pure-logic tests on data structures, matchers, transcript shape | Per base plan policy; ring buffer, matchers, transcript-hash logic |
| **In-app integration (real WKWebView, synthesized events)** | Inherited from base plan | AT0001/AT0003/AT0016 baseline, plus scenarios marked "synthesized" in [#s04-mseries-scenarios] |
| **In-app integration (real WKWebView, CGEventPost)** | Trusted-event-gated scenarios | Scenarios marked "CGEventPost" in the table |
| **In-app integration (real WKWebView, EM-card stub transcripts)** | EM-card scenarios with deterministic tugcode | Scenarios marked "EM-card (stub)" in the table |
| **In-app smoke (real tugcode, live)** | One-off round-trip sanity | `smoke-em-live.test.ts` — non-default, run on demand |
| **App-lifecycle integration** | Macros over NSApp delegate callbacks | AT0004/AT0005 |
| **Drift prevention** | Per-test revert-and-retest cycle | Every new AT-series test — per [D12] |

**What we do not use:**
- happy-dom for UI/focus/selection/DOM-timing behavior (inherited prohibition from base plan).
- Tugcode mocks. Real tugcode, live or stub.
- Synthesized events for trusted-event-gated scenarios — if the scenario needs `isTrusted: true`, it uses CGEventPost.

---

### Execution Steps {#execution-steps}

Twenty-four flat steps across four phases (0: diagnostic observability, A: hardware events including AT0003 trusted-click rewrite, B: EM-cards, C: AT-series coverage) with one integration checkpoint per phase. Phase 0 steps are lettered (0a–0f) to preserve anchor stability of existing Steps 1–17; Step 3b is lettered for the same reason. Every step has explicit commit boundary and checkpoint. **Commit after all checkpoints pass.**

Phase 0 was a prerequisite for reconciling the AT0001/AT0003/AT0016 failures that the base-plan harness surfaced. All six steps are landed (0a, 0b, 0c, 0d, 0e, 0f). Phase A Swift handlers landed as well (Steps 1 and 2): `CoordMapping.swift` + `NativeEventHandlers.swift` + `VirtualKeyMap.swift` deliver the full click/drag/key gesture set via trusted `CGEvent.post` through a login-session event source. Step 3 wraps those handlers in the TS `__tug.*` surface + adds introspection primitives; Step 3b rewrites AT0003 as the acceptance test for the trusted-event pipeline.

**Critical path right now:** 3 → 3b. After 3b, we have a faithful AT0003 regression test we can run automatically end-to-end; before 3b, the test harness's verdict on user-gesture-to-focus scenarios cannot be trusted.

#### Phase 0: Diagnostic Observability {#phase-0-diagnostic}

Six additive upgrades to the deck-trace recording surface and the harness matcher output. No production behavior changes, no new `__tug` RPC verbs, no new DEBUG guards. Every improvement propagates to every future in-app test — Phase A's CGEventPost scenarios, Phase B's EM-card scenarios, Phase C's ~20-scenario sweep — so diagnostic fidelity lifts compound rather than accumulating tech debt.

**Landed:** 0a (commit `3dbb6bb1`), 0b (commit `f89ce2b8`), 0c (commit `bd2e8bd8`), 0d (commit `4e445993`), 0e (2026-04-24), 0f (commit `4a83846f`). **Phase 0 complete.**

#### Step 0a: Source location on every deck-trace event {#step-0a}

**Status:** LANDED (commit `3dbb6bb1`, 2026-04-24).

**Commit:** `feat(deck-trace): stamp caller file:line on every recorded event`

**References:** Direct enabler for m01/m03/m16 trace-emitter reconciliation; [#s01-deck-trace-event] from base plan.

**Artifacts:**
- `tugdeck/src/deck-trace.ts` — `record()` captures the caller stack frame at record time; `DeckTraceEvent` union gains optional `loc?: string` (shape: `"file.tsx:line:col"`).
- `tests/app-test/_harness/matchers.ts` — `partialMatchEntry` ignores `loc` in subset matching unless the expected entry explicitly asserts it. This surfaces `loc` in diagnostic dumps without tightening the assertion contract.
- `tests/app-test/_harness/matchers.test.ts` — unit tests that `loc`-bearing events satisfy `loc`-less expectations.

**Tasks:**
- [ ] Capture `new Error().stack?.split("\n")` in `record()`; extract the first frame that is not inside `deck-trace.ts` itself.
- [ ] Regex-extract `file.tsx?:line:col` from the frame; tolerate unexpected formats with an empty-string fallback.
- [ ] Add `loc?: string` to the `DeckTraceEvent` union; stamp on every recorded event.
- [ ] Empirically verify the stack-frame format under WKWebView's JSC (it may differ from V8 — spike during this step if needed; document the result in a comment at the capture site).
- [ ] Update `partialMatchEntry` to ignore `loc` unless asserted; add unit tests.

**Tests:**
- [ ] `bun test tests/app-test/_harness/matchers.test.ts` — new unit tests pass; existing tests unaffected.
- [ ] `bun test tests/app-test/smoke.test.ts` still green.
- [ ] Manual: re-run `just test-in-app` against AT0001; confirm failure dump carries `@ deck-manager.ts:NNN:NN` or similar on each event.

**Checkpoint:**
- [ ] `loc` field present on >95% of events in a fresh trace (engine quirks on early-boot frames may occasionally blank it — tolerated).
- [ ] No behavior change in release builds (deck-trace is test-mode-only already).
- [ ] Trace record overhead stays sub-millisecond per event (measured via `performance.now()` brackets around 100 records).

---

#### Step 0b: Smarter matcher failure output — annotate out-of-order matches {#step-0b}

**Status:** LANDED (commit `f89ce2b8`, 2026-04-24).

**Depends on:** #step-0a (strongly recommended — annotations read much better alongside `loc`).

**Commit:** `feat(harness): annotate out-of-order matches in toContainOrderedSubset`

**References:** Tier-1 m01/m03 diagnosis. Today's matcher says *"entry #1 not found after index 4"* when the entry actually exists at index 1 — the "out of order" diagnosis is forced on the reader, not stated by the matcher.

**Artifacts:**
- `tests/app-test/_harness/matchers.ts` — on cursor-search miss, scan `actual[0..cursor]` for `partialMatchEntry` hits; if any exist, emit an "Order violation" line that cites both the actual index where the match exists and the cursor position that was expected.
- Same file: failure messages carry a compact prelude block *before* the full JSON dump so the violation jumps out.

**Tasks:**
- [ ] Extend `toContainOrderedSubset` failure path: scan `actual[0..cursor]` for matches; record their indices.
- [ ] Emit a top-of-message "Order violation" annotation that quotes the expected pattern, the actual index where it appears, and the cursor position.
- [ ] Retain the full JSON dump below the annotation.
- [ ] Unit tests: out-of-order failure → message contains "Order violation"; genuinely-absent-entry failure → message unchanged.

**Tests:**
- [ ] Unit test in `matchers.test.ts`: `[event1, event2]` with expected `[event2, event1]` → out-of-order annotation cites indices 1 and 0.
- [ ] Unit test: `[event1]` with expected `[event2]` → existing "not found" message, no "Order violation" line.
- [ ] Manual: re-run AT0001; confirm failure prints `Order violation: destination-flip{B,true} appears at trace[1], BEFORE fr-flip{to:B} at trace[4]`.

**Checkpoint:**
- [ ] Out-of-order failures emit the new annotation.
- [ ] Plain absent-entry failures retain existing diagnostic text.
- [ ] `bun test tests/app-test/_harness/matchers.test.ts` exits 0.

---

#### Step 0c: Store-state snapshot inlined on every event {#step-0c}

**Status:** LANDED (commit `bd2e8bd8`, 2026-04-24). Shipped shape is `DeckTraceStoreSnapshot { activePaneId, activeCardId, hasFocus }` — the plan's original `{active, fr, focused}` was a pre-inspection guess; actual tugdeck state has no separate "first responder" or "focusedCardId" bit in live state. `isFocusDestination(cardId)` can be reconstructed from the shipped snapshot (true iff `hasFocus && activeCardId === cardId`).

**Depends on:** #step-0a (both add optional fields via the same matcher-ignore pattern).

**Commit:** `feat(deck-trace): snapshot store state on every recorded event`

**References:** Disambiguates "event fires as reaction vs prediction" for m01/m03/m16. Also: when `destination-flip` fires before `fr-flip`, the store snapshot tells you which one *caused* the other — the bit that flipped first was the cause.

**Artifacts:**
- `tugdeck/src/deck-trace.ts` — `record()` reads `getDeckStore()?.getState()` and stamps `store?: { active: string|null; fr: string|null; focused: string|null }` on every event.
- `tests/app-test/_harness/matchers.ts` — `partialMatchEntry` ignores `store` unless asserted.

**Tasks:**
- [ ] Read store state synchronously in `record()` (store registry is already imported at `deck-trace.ts` line 88).
- [ ] Populate `{ active, fr, focused }` from the relevant selectors; tolerate null store (early boot, pre-registration).
- [ ] Add `store?: {...}` to `DeckTraceEvent`.
- [ ] Update matcher ignore list; add unit test that `store`-less expectations still match `store`-bearing actuals.

**Tests:**
- [ ] Unit: `store` field present for every event when store is registered.
- [ ] Unit: `store: null` tolerated for pre-registration events.
- [ ] Manual: m01 failure shows `store={active:A, fr:A}` on early events and `store={active:B, fr:A}` on the flip event — making the transition moment visible in the diagnostic.

**Checkpoint:**
- [ ] `store` populated on every post-boot event.
- [ ] Overhead still sub-millisecond per event.
- [ ] No production behavior change.

---

#### Step 0d: Tug.app log tail up front on failure; 200-line window {#step-0d}

**Status:** LANDED (2026-04-24). Shipped as 200-line `app.tailLog(200)` calls and banner `[<testName>] Tug.app log tail (last 200 lines):` in the three AT-series catch blocks. Shared helper deferred — three sites does not yet bite.

**Commit:** `feat(harness): surface Tug.app log tail before assertion failure output`

**References:** The app's runtime log carries first-party diagnostic prints (pane-focus-controller, close-tab logic, `[A3]` effect decisions) that often hold the answer for AT-series failures. Today those lines sit below ~400 lines of JSON trace dump.

**Artifacts:**
- Each of `tests/app-test/at0001-tab-switch-fc.test.ts`, `at0003-pane-activation.test.ts`, `at0016-tab-close-handoff.test.ts` — `catch` block writes `app.tailLog(200)` to stderr with a clear banner *before* rethrowing; tail length moves 50 → 200.
- Optional shared helper `dumpLogTail(app, testName)` in `_harness/index.ts` if the pattern repeats (extract only when the duplication actually bites — three sites is not yet enough).

**Tasks:**
- [x] Update the three AT-series test catch blocks to call `app.tailLog(200)` and print with a banner: `[<testName>] Tug.app log tail (last 200 lines):`.
- [x] Ensure the log tail appears *before* the bun assertion error message in terminal output order.
- [x] Consider extracting a shared helper (deferred decision — evaluate after 0d ships). **Resolution:** deferred. Three call sites with a 4-line body each is below the extraction threshold; revisit when AT0011–AT0016 coverage lands (Step 11+).

**Tests:**
- [ ] Manual: trigger a known AT0001 failure; confirm layout is `[m01] log tail → assertion failure → JSON trace dump`. *(Gated on Step 3b — requires a real failure to observe.)*
- [x] `bun test tests/app-test/` still exits 0 for passing tests (catch blocks are the only changed path). Verified with `TUGAPP_IN_APP_TEST` unset: 3 skip / 0 fail.

**Checkpoint:**
- [x] Failure output ordered correctly in terminal. *(Synchronous `process.stderr.write` before `throw err` guarantees tail lands before Bun's assertion error.)*
- [x] Passing tests emit nothing new.

---

#### Step 0e: One-line trace summary before JSON dump {#step-0e}

**Status:** LANDED (2026-04-24). Shipped as `summarizeEvent` + `formatActualSummary` in `tests/app-test/_harness/matchers.ts`, plus the compile-time drift test at `tugdeck/src/__tests__/trace-summarize-drift.test.ts` that pins the harness-side `HarnessKnownTraceKind` mirror against tugdeck's real `DeckTraceEvent["kind"]` union. Internal `never`-branch in `summarizeEvent` catches drift in the reverse direction (branch missing for a mirrored kind).

**Depends on:** #step-0b.

**Commit:** `feat(harness): print one-line trace summary above JSON dump in matcher failures`

**References:** The full JSON is ~400 lines for 8 events. A single line per event makes the sequence scannable in 10 seconds; expected-entry match markers make the failure shape visible at a glance.

**Artifacts:**
- `tests/app-test/_harness/matchers.ts` — `summarizeEvent(e: DeckTraceEventShape)` returns a short kind-specific label; `formatActualSummary(...)` renders the numbered actual-trace block with match markers (`← matched #N`, `← expected #i (wrong order)`, `← cursor stopped here`); `toContainOrderedSubset` failure message inserts the summary block between the preamble and the full JSON dump.
- `tugdeck/src/__tests__/trace-summarize-drift.test.ts` — compile-time drift check pinning tugdeck's `DeckTraceEvent["kind"]` against the harness-side mirror (`HarnessKnownTraceKind`). Adding a kind on either side without the matching mirror update fails tsc with an actionable error.

**Tasks:**
- [x] Implement `summarizeEvent` branches for every `DeckTraceEvent` kind: `fr-flip A→B`, `destination-flip B:false→true`, `a3-fire B early=not-dest`, `focus-call B site=…`, `save-callback A1 src=debounced`, `focusin el=input#…`, etc. Internal `never` default-branch enforces exhaustiveness.
- [x] In the failure message, print a numbered list of one-line summaries with match markers; the violation-annotation from Step 0b anchors the header.
- [x] Retain the full JSON dump below the summary for completeness.

**Tests:**
- [x] Unit: `summarizeEvent` returns non-empty string for every kind in the union (exhaustiveness check via `never` type). Covered by `summarizeEvent — exhaustive per-kind coverage` describe block in `_harness/matchers.test.ts`.
- [x] Unit: failure message contains summary above JSON dump (order-sensitive substring check). Covered by `toContainOrderedSubset — one-line summary above JSON dump` describe block.
- [x] Unit: compile-time drift check via `trace-summarize-drift.test.ts` (tugdeck side).
- [ ] Manual: m01 failure reads as an indexed summary list with match markers — no need to open the JSON to understand the violation. *(Gated on Step 3b — requires a real failure to observe.)*

**Checkpoint:**
- [x] Summary precedes JSON in every matcher failure. Verified by `toContainOrderedSubset` unit test asserting `summaryPos < jsonPos`.
- [x] Exhaustive-check passes (new trace event kinds added by Phase B force a `summarizeEvent` branch update, failing typecheck otherwise). Confirmed by the drift test compiling only when `Exclude<DeckTraceEvent["kind"], HarnessKnownTraceKind>` is `never`.

---

#### Step 0f: Per-test trace artifact file on failure {#step-0f}

**Status:** LANDED (commit `4a83846f`, 2026-04-24). Shipped as `App.dumpTraceToFile(path)` in `tests/app-test/_harness/index.ts`. Wired into AT0016's catch block (`tests/app-test/at0016-tab-close-handoff.test.ts`). Path resolves relative to the test cwd (`tests/app-test/`), so callers pass `logs/<test>-trace.json`. The existing `tests/app-test/.gitignore` covers the `logs/` directory, so trace files don't leak into commits.

**Depends on:** #step-0a, #step-0c (trace file is most useful when `loc` and `store` are present).

**Commit:** `feat(harness): write full trace to tests/app-test/logs/<test>-trace.json on failure`

**References:** Archival + offline analysis. A saved trace file enables `jq` queries over a known-good trace without re-running the test — essential for deeper m01/m03/m16 forensics once the diagnostic fidelity improvements land.

**Artifacts:**
- `tests/app-test/_harness/client.ts` — `dumpTraceToFile(path: string): Promise<void>` method on the harness client; writes `getDeckTrace()` output as formatted JSON.
- AT0001/AT0003/AT0016 `catch` blocks — call `dumpTraceToFile(\`tests/app-test/logs/${testName}-trace.json\`)` and print the path in the failure banner.
- `.gitignore` — add `tests/app-test/logs/*-trace.json` if not already covered by the existing logs pattern.
- `tests/app-test/README.md` — one-paragraph note on analyzing trace files with `jq` (e.g., `jq '.[] | select(.kind == "fr-flip")' trace.json`).

**Tasks:**
- [ ] Add `dumpTraceToFile(path)` on the harness client; writes `formatJSON(await this.getDeckTrace())` to disk.
- [ ] Update AT0001/AT0003/AT0016 catch blocks to dump traces alongside the log tail banner (Step 0d's output).
- [ ] `.gitignore` update if needed (existing `logs/` rule likely covers it — verify).
- [ ] README subsection on `jq` analysis patterns.

**Tests:**
- [ ] Manual: trigger AT0001 failure; confirm `tests/app-test/logs/at0001-tab-switch-fc-trace.json` is written and is valid JSON (`jq '.' <file>` succeeds).
- [ ] Passing tests do not write the file.

**Checkpoint:**
- [ ] Trace file appears on failure only.
- [ ] File parses as JSON with `jq`.
- [ ] Path referenced in the failure banner.

---

#### Step 1: Spike CGEventPost — variant, escape, coord math, keyboard {#step-1}

**Status:** LANDED (2026-04-24). [D02] decided (`cgSessionEventTap`). [D13] added (open-launcher). [D14] added (stable signing). [Q05] surfaced (modifier-key accelerators — carried into Step 2). CoordMapping.swift validated: viewport (120, 170) → screen (677, 279) with received-event delta=(0, 0). Spike code (`CGEventSpike.swift`, `_spike-cgevent.test.ts`, `spikeCGEvent` dispatch case) removed in closing commit.

**Commit:** `spike(harness-native): validate CGEventPost variant, coord mapping, and keyboard pipeline`

**References:** [D02] cgevent variant, [Q02] variant question, [R02] event escape, (#phase-a-hardware, #coord-mapping)

**Why this step widened:** The original Step 1 was "pick a variant and write the decision line." Before Step 2 lands Swift verbs for the full native surface (click, double-click, right-click, drag, type, key, holdModifier), the spike needs to de-risk every hard unknown that Step 2's design hinges on — otherwise Step 2 becomes its own spike and we pay for the reshaping in re-writes. Four experiments below. Each has a one-paragraph writeup in the plan when Step 1 closes.

**Experiments (the real deliverable):**

1. **Variant selection — `CGEventPost(.cghidEventTap, ...)` vs `CGEventPostToPid(event, pid)`.** Post a single primary-click event at a known screen coordinate inside the WKWebView. A one-shot JS `mousedown` listener records `event.isTrusted` into `window.__spike_isTrusted`. Run both variants. Outcomes to record: does each variant deliver `isTrusted: true` to content-world JS? Latency? Ordering vs. a simultaneously-synthesized JS mousemove? Answers pin [D02].
2. **Event escape ([R02]).** For the winning variant, verify events stay inside Tug.app's process. Test: click at a screen coordinate that sits over a visible sibling app window (e.g., Finder). The sibling must NOT receive the click. `CGEventPostToPid` should close this by construction; `CGEventPost(.cghidEventTap, ...)` almost certainly leaks. If the winning variant leaks, Step 1 does NOT close — we fall back to the other and re-measure `isTrusted`.
3. **DOMRect → screen-coord round-trip.** Resolve `[data-card-id="c1"]` via `evalJS` → `getBoundingClientRect()` → WKWebView view-local → window-local (AppKit Y-up, origin bottom-left) → screen-local CG coords (Y-down, origin top-left of main display). The Y-axis flip is the load-bearing bit. Post a click at the computed screen coord and verify (a) the element receives the event, (b) `clientX`/`clientY` on the received event matches the DOMRect center (within 1px rounding). This produces the coord-mapping helper Step 2 needs as a ready-to-commit unit — spike artifact that survives.
4. **Keyboard-accelerator sanity (Cmd+A).** Focus an `<input>` with seeded text; post a Cmd+A keydown+keyup via CGEvent with `.maskCommand` flag. Read the input's `selectionStart`/`selectionEnd` afterwards — they must span the full value (start=0, end=value.length). This proves the keyboard path reaches WebKit's real accelerator-key handler (vs. the `select()` JS API, which selection-state introspection cannot distinguish from a real Cmd+A). If it fails, we learn *before* Step 2 that the keyboard pipeline needs a different shape — e.g., `keyboardSetUnicodeString` for key names that don't have a stable virtual-keycode mapping.

**Artifacts:**

- `tugapp/Sources/TestHarness/CGEventSpike.swift` — `#if DEBUG` spike file with one public entry point per experiment (`runVariantSpike()`, `runEscapeSpike()`, `runCoordSpike()`, `runKeyboardSpike()`), invoked from a temporary bridge verb `spikeCGEvent(experiment: String)`. Spike file *and* bridge verb deleted in the same commit that closes Step 1; nothing ships to production.
- `tugapp/Sources/TestHarness/CoordMapping.swift` — the coord-mapping helper proved out by experiment 3, PRESERVED in tree (Step 2 uses it). Pure-function API: `fn viewportToScreen(_: CGPoint, in: WKWebView) -> CGPoint?` with bounds-check; `nil` when out of bounds. Unit-tested against a fixed-geometry fixture.
- `tests/app-test/_spike-cgevent.test.ts` — throwaway TS test driving all four experiments via `__tug.spikeCGEvent(...)`; asserts observable outcomes (`isTrusted === true`, selection span, etc.). Also deleted in the closing commit.
- Plan updates in place: [D02]'s Decision line fills in (variant name + rationale); [R02] gets a note if event escape surfaced; `#coord-mapping` subsection gets the Y-flip math written down for future reference.

**Tasks:**

- [x] Land `CGEventSpike.swift` with four experiment functions, gated by `#if DEBUG`.
- [x] Land `CoordMapping.swift` with the screen-coord conversion. Hand-rolled Swift unit test cases in `runPureMathUnitTests()` (no XCTest target exists yet); Step 2 upgrades to proper XCTest when it adds the NativeEventHandlers target.
- [x] Add temporary bridge verb `spikeCGEvent(experiment: String)` in `TestHarnessConnection.swift`.
- [x] Write `tests/app-test/_spike-cgevent.test.ts` covering: permission probe, coord-math unit tests, window probe, variant delivery, event escape, coord round-trip, keyboard (Cmd+A), keyboard letter probe.
- [x] Run the spike. Outcomes recorded in [D02], [R02] (updated), [D13], [D14], [Q05] (new), and `#coord-mapping` (worked numeric example). Resolved unknowns: variant `cgSessionEventTap`; escape mitigation via Tug-frontmost + coord-inside-window; coord delta=(0, 0); LaunchServices `open` launcher required for TCC; stable signing required; modifier-key Cmd+A doesn't fire select-all (carried to Step 2).
- [x] Scaffold `scripts/setup-dev-signing.sh` + `just setup-dev-signing` recipe; integrate re-sign step into `just test-in-app`. Added [D14] decision documenting the workflow.
- [x] Rewrite `_harness/spawnTugApp` to launch via `/usr/bin/open -n -W --stdout --stderr --env`; added [D13] decision.
- [x] Delete `CGEventSpike.swift`, the `spikeCGEvent` dispatch case, and `_spike-cgevent.test.ts` in the step's closing commit. `CoordMapping.swift` stays.

**Tests:**

- [x] All experiments exit cleanly (no Swift crash, no TS timeout) before deletion.
- [x] `isTrusted === true` for `cghidEventTap` and `cgSessionEventTap`; `postToPid(ownPid)` does not deliver (recorded in [D02]).
- [x] Automation cannot assert sibling-app state; escape probe only verifies the in-Tug listener doesn't fire for out-of-window clicks. Mitigation is discipline-based (Tug frontmost + coord-in-window), not delivery-scoped.
- [x] Coord-mapping delta (0.0, 0.0) for viewport (120, 170) → received (120, 170).
- [ ] Cmd+A produces a full-range selection on the focused input. *(Failed — modifier-key accelerator investigation deferred to Step 2 per [Q05]; plain-letter keystrokes DO work via CGEvent, so the keyboard pipeline itself is fine, only the modifier path is.)*
- [x] `xcodebuild` DEBUG build passes with the spike code present AND with the spike code removed.
- [x] `grep -rn "CGEventSpike\|spikeCGEvent" tugapp/` after the closing commit returns zero hits.
- [x] `CoordMapping.swift` pure-math unit cases pass (via `runPureMathUnitTests()`).

**Checkpoint:**

- [x] [D02] Decision line filled: `cgSessionEventTap`, with rationale.
- [x] [R02] annotated: escape is real; mitigation is Tug-frontmost + coord-inside-window.
- [x] `#coord-mapping` subsection contains the Y-flip math with a worked numeric example from the 2026-04-24 spike.
- [x] `CoordMapping.swift` committed; Step 2 imports it directly.
- [x] Spike code removed.
- [x] [D13] and [D14] added (LaunchServices launcher; stable signing).
- [x] [Q05] added (modifier-key accelerator investigation carried to Step 2).

---

#### Step 2: Swift `CGEventPost` handlers — full gesture + keyboard surface {#step-2}

**Status:** LANDED (2026-04-24). Shipped `NativeEventHandlers.swift` (click, double-click with 80ms pinned interval, right-click, endpoint-only drag, mouse-down/up primitives, `nativeKey`, `nativeType`, `holdModifier` with `defer`-based modifier release) and `VirtualKeyMap.swift` (US-English ASCII + named-key table, ~120 entries, hand-rolled self-tests in `runUnitTests()`). Dispatch table extended in `TestHarnessConnection.swift` with 9 new verbs. Swift + TS `SURFACE_VERSION` bumped to `1.1.0`. Typed error classes added to `tests/app-test/_harness/errors.ts` + wired into `translateError`. `smoke-native.test.ts` scaffold landed (skipped; Step 3 fills bodies). No regressions: 2 smoke + AT0001 + AT0003 + AT0016 all green.

**Depends on:** #step-1 (reuses `CoordMapping.swift` from Step 1; variant choice from [D02]).

**Commit:** `feat(tugapp-bridge): add CGEventPost gesture and keyboard handlers (DEBUG-only)`

**References:** [D01] same transport, [D02] variant choice, [R02] event escape, [D03] accessibility preflight, Spec [#s01-hardware-rpc], (#coord-mapping)

**Scope note:** Step 2 grew (2026-04-24 re-scope) beyond the original click+key primitives to cover every gesture the Phase C AT-series sweep will need — double-click, right-click, endpoint-only drag, and a `holdModifier` scope verb. ASCII-only typing is sufficient per user call (non-ASCII / IME is out of scope for Phase C). Drag interpolation is NOT provided; tests express multi-step interactions as sequences of endpoint clicks. A `nativeDelay` surface primitive is deliberately NOT exposed — test authors use `waitForCondition` instead; inter-event spacing inside gesture builders is internal.

**Carry-overs from Step 1:**
- **[Q05] resolved before Step 2 starts** — the modifier-key failure from the Step 1 spike was caused by using `CGEventSource(stateID: .hidSystemState)` (daemon/driver scope) instead of `.combinedSessionState` (login-session scope), plus manual `.flags` + `type = .flagsChanged` overrides that fought the source's automatic modifier tracking. Step 2 implements the docs-prescribed pattern directly: one `CGEventSource(stateID: .combinedSessionState)` per gesture scope, plain `keyDown`/`keyUp` events for the modifier key (virtual keycodes 0x37/0x38/0x3A/0x3B for cmd/shift/alt/ctrl), no `.flags` setter, no `type` override. See [Q05]'s resolution block for the exact code shape.
- Does NOT block Step 3b (AT0003 rewrite is click-driven). Unblocked via Step 2's click/drag handlers regardless of the keyboard path.

**Artifacts:**

- `tugapp/Sources/TestHarness/NativeEventHandlers.swift` — Swift source file adding the full gesture + keyboard handler set. All code `#if DEBUG ... #endif`. Every handler uses `CoordMapping.swift` (landed in Step 1) for selector-to-screen coord conversion; caller provides screen coords directly for coord-based variants.
  - **Pointer:**
    - `nativeClick(point, button?, clickCount?)` — single primary (default) or right click at a screen coordinate. `clickCount` arg lets callers post a fast second click directly instead of `nativeDoubleClick`, if they want to pin the timing.
    - `nativeDoubleClick(point, button?)` — convenience. Posts two click pairs with `CGEventSetIntegerValueField(event, .mouseEventClickState, ...)` set to 1 then 2, separated by the pinned interval (see below).
    - `nativeRightClick(point)` — convenience for `button: .right`; `.rightMouseDown` + `.rightMouseUp`. Context-menu path coverage.
    - `nativeDrag(from, to, {mouseDownDelayMs?, mouseUpDelayMs?})` — endpoint-only drag. Posts `.leftMouseDown` at `from`, waits `mouseDownDelayMs` (default 20ms), `.leftMouseDragged` at `to` (single event, no interpolation), waits `mouseUpDelayMs` (default 20ms), `.leftMouseUp` at `to`.
    - `nativeMouseDown(point, button?)` / `nativeMouseUp(point, button?)` — individual halves, for niche scenarios (hover-while-modifier-held, modal dismiss patterns) where `holdModifier` + click is not enough.
  - **Keyboard:**
    - `nativeKey(key, modifiers?)` — single named-key press. `key` is a harness-stable name (`"a"`, `"Enter"`, `"ArrowLeft"`, `"Tab"`, `"Escape"`, `"Backspace"`, `"Delete"`, `"Home"`, `"End"`, `"PageUp"`, `"PageDown"`, digits, letters, shifted punctuation via `"!"`/`"@"`/etc.) mapped to a virtual keycode table. `modifiers` is a set of `"cmd"`, `"shift"`, `"alt"`, `"ctrl"`. Handler posts the correct flagsChanged events so the key event carries the full modifier bitmap — real accelerator paths fire.
    - `nativeType(text)` — iterates the ASCII string, posts each character as a `nativeKey` with any shift modifier the character requires (e.g., capital letters, `!`, `@`, etc.). Non-ASCII input returns a `NativeTypeAsciiOnlyError` so callers notice early if a test author hands in unicode.
    - `holdModifier(mods, innerVerbs[])` — scope verb. Presses the requested modifier flags (one `flagsChanged` event per press), executes the inner RPC verbs in order with the modifier bitmask included on every mouse/key event, releases the flags in reverse order. Inner verbs are a JSON array of `{verb: "nativeClick" | "nativeKey" | "nativeDrag" | ...; args: {...}}`. This is the mechanism for "click with Cmd held," "drag with Shift held," "Cmd+click then Shift+click" — scenarios that `nativeKey` + modifier-as-argument can't express cleanly.
  - **Constants:**
    - `NATIVE_DOUBLE_CLICK_INTERVAL_MS: Int = 80` — the pinned interval between first and second click pair, per the 2026-04-24 user call ("pin an explicit interval in the spike"). Documented inline as "deterministic test-side constant, deliberately shorter than macOS default to avoid double-clicks misreading as slow single-clicks."
- `tugapp/Sources/TestHarness/VirtualKeyMap.swift` — ASCII-name → `CGKeyCode` + shift-required boolean table. Closed set (no dynamic layout detection); hand-maintained to cover US-English keyboards as the only supported input layout for tests. Non-`US` layouts are out of scope per the same user call.
- `tugapp/Sources/TestHarness/TestHarnessConnection.swift` — dispatch table grows with the new verbs. All verbs gated on the version handshake (Step 3 bumps the version).
- `tests/app-test/_harness/errors.ts` — adds `CoordinateOutOfBoundsError`, `NativeTypeAsciiOnlyError`, `AccessibilityPermissionMissingError` (landed but uncited here until Step 3).

**Tasks:**

- [x] Land `VirtualKeyMap.swift` with the ASCII-name → `CGKeyCode` mapping for letters, digits, common punctuation (shifted + unshifted), and special keys (`Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, arrows, `Home`/`End`, `PageUp`/`PageDown`).
- [x] Land `NativeEventHandlers.swift`:
  - [x] `nativeClick(point:button:clickCount:)` — one event pair. Uses [D02]'s `.cgSessionEventTap`. Respects bounds check from `CoordMapping.swift` — out-of-bounds returns `CoordinateOutOfBoundsError`.
  - [x] `nativeDoubleClick(point:button:)` — two pairs, `mouseEventClickState` 1 then 2, separated by `NATIVE_DOUBLE_CLICK_INTERVAL_MS` (80ms).
  - [x] `nativeRightClick(point:)` — right-button click.
  - [x] `nativeDrag(from:to:opts:)` — endpoint-only; `mouseDown` → one `mouseDragged` → `mouseUp`. Default inter-event delay 20ms each side.
  - [x] `nativeMouseDown(point:button:)` / `nativeMouseUp(point:button:)` — primitives for niche paths.
  - [x] `nativeKey(key:modifiers:)` — per [Q05]'s resolution: plain `keyDown`/`keyUp` events on modifier keys via shared `CGEventSource(stateID: .combinedSessionState)`. Auto-presses Shift when the mapped key needs it (e.g. `"A"`, `"!"`). Uses `VirtualKeyMap`.
  - [x] `nativeType(text:)` — ASCII loop with per-char Shift bracketing. Non-ASCII pre-check: throws `NativeTypeAsciiOnlyError` before any events post.
  - [x] `holdModifier(mods:innerVerbs:)` — presses modifier-key `keyDown` events, runs inner verbs via recursive `executeNativeVerb`, releases modifiers in reverse order via `defer`. Inner-verb failures release modifiers cleanly — no stuck-modifier bleed.
- [x] Wire every verb into the `TestHarnessConnection.swift` dispatch table via `dispatchNativeVerb` → `executeNativeVerb` (shared by top-level dispatch and `holdModifier` recursion). Each verb JSON-decodes args via `parsePoint` / `parseButton` / `parseModifiers` helpers; native errors translate to typed wire errors via `NativeEventError.wireName`.
- [x] Swift-side unit tests for `VirtualKeyMap` (runtime `runUnitTests()` fixtures; XCTest target deferred until one exists).
- [x] Bump `__tug.version` to `1.1.0` in Swift (`TestHarnessConnection.surfaceVersion`). **TS `EXPECTED_SURFACE_VERSION` bumped in Step 2 too** (not Step 3 as originally planned) because `smoke.test.ts` asserts exact-match equality — the staggered-bump plan would have left the smoke test red. Tugdeck-side `SURFACE_VERSION` in `tugdeck/src/test-surface.ts` still awaits Step 3.
- [x] Every new Swift file + every new dispatch-table case inside `#if DEBUG ... #endif`.

**Tests:**

- [x] `VirtualKeyMap` Swift unit cases (a/A, z/Z, 0/), 1/!, space, , / <, / / ?, ` / ~, Enter/Return/Tab/Escape/Backspace/Delete, all arrows) wired via `runUnitTests()`.
- [x] `CoordMapping` Swift unit cases (from Step 1) still pass unmodified.
- [x] `tests/app-test/smoke-native.test.ts` — scaffold landed with 5 `describe.skip`'d tests, Step 3 fills bodies.
- [x] `bun test ./_harness/rpc.test.ts ./_harness/matchers.test.ts` — 46 pass / 0 fail.
- [x] `just test-in-app` — 2 smoke + AT0001 + AT0003 + AT0016 all green; no regressions.

**Checkpoint:**

- [x] `xcodebuild` DEBUG build succeeds with zero warnings; build completes in the same step without the spike's `try holdModifier` warning (inner closure is non-throwing → no `try`).
- [x] `grep -rnE "CGEventPost|CGEvent\.post|NativeEventHandlers|VirtualKeyMap" tugapp/` — every hit is inside `#if DEBUG`-guarded file (CoordMapping.swift, CGEventSpike deleted, NativeEventHandlers.swift, VirtualKeyMap.swift, TestHarnessConnection.swift) or pbxproj metadata.
- [x] Dispatch table handles `nativeClick`, `nativeDoubleClick`, `nativeRightClick`, `nativeDrag`, `nativeMouseDown`, `nativeMouseUp`, `nativeKey`, `nativeType`, `holdModifier`.
- [x] No production codepath references `NativeEventHandlers`, `VirtualKeyMap`, or `NATIVE_DOUBLE_CLICK_INTERVAL_MS`.

---

#### Step 3: `__tug` surface — native gestures, keyboard, introspection, preflight {#step-3}

**Depends on:** #step-2

**Commit:** `feat(test-surface): add native-event + introspection methods and accessibility preflight`

**References:** [D01] same transport, [D03] accessibility preflight, Spec [#s01-hardware-rpc], Spec [#s06-error-classes], (#phase-a-hardware)

**Scope note:** Step 3 grew (2026-04-24 re-scope) beyond the native-gesture mirror to include the introspection primitives the Phase C sweep needs to assert on contents/state/caret/selection/computed-style. Authoring the mirror and introspection together keeps `__tug.version = 1.1.0` a single bump and avoids a mid-phase second handshake change.

**Artifacts:**

- `tugdeck/src/test-surface.ts` — grows three concern groups. All methods remain inside the v1.1.0 DEV gating (`import.meta.env.DEV && window.__tugTestMode`).
  - **Native gestures (TS wrappers over Step 2's Swift verbs):**
    - `nativeClick(point, opts?)`, `nativeClickAtElement(selector, opts?)`
    - `nativeDoubleClick(point, opts?)`, `nativeDoubleClickAtElement(selector, opts?)`
    - `nativeRightClick(point)`, `nativeRightClickAtElement(selector)`
    - `nativeDrag(from, to, opts?)`, `nativeDragElement(fromSelector, to, opts?)` where `to` is `{x, y}` or `{selector}`.
    - `nativeMouseDown(point, opts?)` / `nativeMouseUp(point, opts?)` — primitives for niche cases.
  - **Native keyboard:**
    - `nativeKey(key, mods?)` — named-key + modifier set.
    - `nativeType(text)` — ASCII-only string. Non-ASCII rejected with `NativeTypeAsciiOnlyError` (Swift-side check, TS surfaces the typed rejection).
    - `holdModifier(mods, async thunk)` — pressed before the inner callback runs, released after. TS-side shape is `async (mods, async () => { ... })` so tests write it as `await app.holdModifier(["cmd"], async () => { await app.nativeKey("a"); })`. Under the hood the TS facade collects inner RPC calls into a queue (see `Tasks`) and sends them as one `holdModifier` RPC so the Swift side controls the flag lifecycle atomically.
  - **Introspection (selector-based, JS-surface — no new Swift):**
    - `getElementText(selector)` — `.textContent` for non-inputs, `.value` for `<input>`/`<textarea>`.
    - `getElementValue(selector)` — explicit `.value` for form controls.
    - `getElementAttribute(selector, name)` — any attribute; returns `null` if unset.
    - `getElementBounds(selector)` — viewport-relative `DOMRect`-like `{x, y, width, height}`.
    - `getElementScreenBounds(selector)` — Swift-computed screen coords; reuses `CoordMapping.swift`. Returns the same rect in global screen CG coords. Load-bearing for the `nativeClickAtElement` path and for tests that want to name an exact screen point.
    - `getElementState(selector)` — bundle: `{disabled, readOnly, checked, visible, tagName, isFocused}`. `visible` uses `getBoundingClientRect()` + `offsetParent` test; `isFocused` is `document.activeElement === el`.
    - `getActiveElement()` — `{tagName, id, cardId, persistKey, selector} | null`. `cardId` walks up to the nearest `[data-card-id]`; `persistKey` reads `data-tug-persist-value` if present.
    - `getSelection(cardId?)` — superset of existing `getCaretState(cardId)`: covers form-control inputs *and* contentEditable ranges (for EM-card scenarios that become relevant in Phase B). Keep `getCaretState` as a narrow alias that throws if the active element isn't a form control, for tests that want that stricter contract.
    - `getComputedStyle(selector, property)` — `window.getComputedStyle(el).getPropertyValue(property)`. Thin wrapper; enables CSS-driven behavior assertions (e.g., "after this gesture, the `card-host--active` class's `background-color` is the token X").
  - **Accessibility preflight ([D03]):**
    - `checkAccessibilityPermission()` — Swift-side AXIsProcessTrusted probe returned over the RPC; TS wrapper throws `AccessibilityPermissionMissingError` on denial.
- `tests/app-test/_harness/errors.ts` — adds `AccessibilityPermissionMissingError`, `CoordinateOutOfBoundsError`, `NativeTypeAsciiOnlyError`.
- `tests/app-test/_harness/client.ts` — typed client wrappers for every new verb; `launchTugApp` calls `checkAccessibilityPermission` as first RPC after version handshake; throws if denied.
- `tests/app-test/_harness/index.ts` — `App` class exposes the same methods with the harness's usual shape (promise-returning, matchers-aware).
- `tests/app-test/smoke-native.test.ts` — fills in the scaffold from Step 2. Five tests, one per critical path:
  1. **Trusted single-click** — `nativeClickAtElement("button#…")`; a one-shot listener records `isTrusted`; assert `true`.
  2. **Trusted type** — `nativeClickAtElement("input#…")` then `nativeType("hello")`; assert `input.value === "hello"`.
  3. **Cmd+A selects all** — `nativeClickAtElement("input#…")`, pre-fill, `nativeKey("a", ["cmd"])`; assert `{selectionStart: 0, selectionEnd: value.length}`.
  4. **Endpoint drag paints selection** — seed a contentEditable with text, `nativeDrag` from char-0 bounding rect to char-5 bounding rect; assert `window.getSelection().toString().length === 5`. (If endpoint-only drag does NOT paint selection on WebKit — a risk — this test fails, and we have unambiguous early signal to course-correct.)
  5. **Double-click selects word** — seed an input with `"hello world"`, `nativeDoubleClickAtElement` on the input; assert the browser's double-click-word-select behavior produced `"hello"` as the selection.

**Tasks:**

- [x] Implement every TS surface method in `test-surface.ts` — thin wrappers for the Swift verbs, direct implementations for the introspection group. (Physical layout differed from the plan text: native gestures ship as RPC verbs only — JS has no `CGEvent` access, so `window.__tug.native*` wrappers would be useless indirection. Introspection group lives on `__tug` as planned.)
- [x] Implement `holdModifier(mods, thunk)`: implemented as the buffering variant in `tests/app-test/_harness/client.ts`. Inner RPC calls collect into an `innerVerbs` array; the outer call sends them as one `holdModifier` RPC so Swift presses the modifier once, dispatches every inner verb under the held flag, and releases in a single defer. Nested scopes reject; `evalJS` / `waitForCondition` inside the thunk reject.
- [x] Implement the typed client wrappers in `_harness/client.ts` for every new verb (native gestures + introspection + `checkAccessibilityPermission` + `getElementScreenBounds`).
- [x] Implement `launchTugApp` preflight: calls `checkAccessibilityPermission` as the final handshake step; throws `AccessibilityPermissionMissingError` with actionable System-Settings guidance on denial. Harness-internal protocol tests opt out via `skipAccessibilityPreflight: true`.
- [x] Bump `__tug.version` surface assertion from `1.0.0` to `1.1.0`; update harness expected-version constant.
- [x] Author `smoke-native.test.ts` per the five tests above. (Test 4 needed environmental setup — tugdeck's `selectionGuard` blocks `selectstart` outside registered card boundaries. Added `__tug.registerSelectionBoundary` so the ad-hoc fixture overlay can mirror what a real card does on mount.)
- [x] Extend `tests/app-test/README.md` with a section documenting the new surface (native gestures, introspection primitives, `holdModifier` usage pattern, AX preflight).

**Tests:**

- [x] `bun test tests/app-test/smoke-native.test.ts` exits 0 with accessibility permission granted. (5/5 green.)
- [x] Manual test: revoke permission, run smoke; harness exits 1 with a readable error citing the System Settings path. (Error class carries bundle path + id + `tccutil reset` recipe.)
- [x] `bun test tests/app-test/` does not regress any prior test (AT0001/AT0003/AT0016 still green).

**Checkpoint:**

- [x] `bun x tsc --noEmit` exits 0 in `tests/app-test/` and `tugdeck/`. (Five pre-existing errors in `tugdeck/src/__tests__/card-host-default-focus.test.ts` predate Step 3 and are unchanged.)
- [x] `bun test tests/app-test/smoke-native.test.ts` exits 0 (all five tests green).
- [x] `bun test tests/app-test/` full sweep green (`_smoke` 2/2, `_smoke-native` 5/5, `m01` 1/1, `m03` 1/1, `m16` 1/1).
- [x] `grep -nE "window\.__tug\.(native|holdModifier)" tugdeck/src/` shows only DEV-gated uses. (Returns no matches — native gestures are RPC-verb-only, never surfaced on `window.__tug`.)
- [x] `__tug.version` is `1.1.0`; TS handshake constant matches.

**Phase A pipeline findings (from smoke-native):**

The tests surfaced four Swift-side fidelity adjustments that the plan had not anticipated:

1. **Modifier settle delay.** `holdModifier` now sleeps `NATIVE_MODIFIER_SETTLE_MS` (10ms) between pressing a modifier and dispatching the inner keystroke (and again before releasing). Back-to-back CGEvent posts caused the `a` keyDown to arrive at the application before windowserver had propagated the Cmd flag, producing select-all misses.
2. **Double-click activation.** `nativeDoubleClick` now activates the app once and shares one coord resolution across both pairs instead of delegating to `nativeClick` twice. The redundant `NSApp.activate(ignoringOtherApps:)` between clicks disturbed WebKit's click accumulator and broke word-select.
3. **Interpolated drag.** Endpoint-only drag (the plan's 2026-04-24 hope) does NOT paint selection on WebKit. `nativeDrag` now posts 8 interpolated `mouseDragged` events between `from` and `to` with 20ms spacing.
4. **Background-thread dispatch.** Native-verb execution moved off the main thread via `DispatchQueue.global(qos: .userInitiated).async`. Running on main blocked WebKit's run loop — all CGEvent dispatches arrived at the DOM coalesced into one burst because WebKit couldn't drain its event queue until Swift's handler returned. Off-thread execution lets WebKit dispatch events as they arrive. Main-thread hops are still used synchronously for `NSApp.activate` and `CoordMapping`.

All four adjustments live in `tugapp/Sources/TestHarness/NativeEventHandlers.swift` and `TestHarnessConnection.swift`; the Swift-side tests in `runPureMathUnitTests` still pass.

---

#### Step 3b: Rewrite AT0003 with trusted click events (Phase A acceptance test) {#step-3b}

**Depends on:** #step-3 (requires the `nativeClickAtElement` TS surface, accessibility preflight, and a green `smoke-native.test.ts`).

**Commit:** `test(in-app): rewrite AT0003 with trusted click events`

**References:** [D09] (fidelity limits); user-reported real-world discrepancy (2026-04-24) where the current AT0003 test passes but the user's real-app gesture flow fails — "click into TugTextarea's `sm` input, click TugInput title, click TugTextarea title → caret not restored in `sm`."

**Why this step exists:**

The existing `tests/app-test/at0003-pane-activation.test.ts` passes but does NOT reproduce real-user behavior. It uses `app.focusElement(inputSelectorFor("A1"))` to set initial focus via a direct `.focus()` call, and `app.click(paneTitleSelectorFor(…))` which dispatches synthesized PointerEvent/MouseEvent (isTrusted=false). Neither path triggers the browser's hardware-event default focus-change on `mousedown`. Real users never call `.focus()` programmatically; they click. Synthesized clicks skip the browser's default focus handling. This fidelity gap is documented in the base plan as [D09].

A human has demonstrated that AT0003's real-app scenario fails despite the test passing. That makes every downstream synthesized-click test suspect: any green could be a false green. Until AT0003 is rewritten with trusted clicks and passes against the real-app behavior, Phase C's broader AT-series coverage cannot be trusted either.

This step does two things:

1. **Rewrite AT0003** to use `nativeClickAtElement` for every user-gesture click, matching what a real user does.
2. **If the rewritten test fails, it has surfaced the real production bug the synthesized test was masking.** Iterate on a production fix, re-run, re-regress-check. The step doesn't close until the rewritten test is green AND the same gesture flow works interactively in the real app.

**Artifacts:**

- `tests/app-test/at0003-pane-activation.test.ts` — rewritten:
  - `app.focusElement(inputSelectorFor("A1"))` → `await app.nativeClickAtElement(inputSelectorFor("A1"))`. Real click on the input; the browser's mousedown default focuses it.
  - `app.click(paneTitleSelectorFor("p2"))` → `await app.nativeClickAtElement(paneTitleSelectorFor("p2"))`. Real click on non-focusable chrome; mousedown default fires (since title-bar div has no `data-tug-focus="refuse"`) but browsers don't focus non-focusable divs, so `document.activeElement` blurs to `body`.
  - `app.click(paneTitleSelectorFor("p1"))` → `await app.nativeClickAtElement(paneTitleSelectorFor("p1"))`. Same pattern for the return trip.
  - Keep `app.type(inputSelectorFor("A1"), "hello")` — synthesized input events are faithful for typing (the browser's default keystroke handling just fires `input`/`change` events, which `type`'s synthesis already does; typing into an already-focused element does not depend on isTrusted).
  - Keep `expectFocusedCard`, `expectCaret`, `getDeckTrace`, and all trace assertions — these all read real DOM and store state.
  - Keep the trace-assertion shapes landed in the Phase 0 reconciliation (destination-flip before fr-flip, save-callback on A1, focus-call via `a3-default-focus` on A2).

- (Possibly) production files in `tugdeck/src/` — IF the rewritten test fails, the production fix lands in this same step. Likely suspects named in Tasks below.

- `dash/at-series-reconciliation.md` — update with any production fix rationale discovered during this step.

**Tasks:**

- [x] Apply the rewrite to `tests/app-test/at0003-pane-activation.test.ts` per Artifacts above.
- [x] Verify the rewrite is total: `grep -cE "focusElement|app\.click\(" tests/app-test/at0003-pane-activation.test.ts` returns `0`.
- [x] Run in-app tests; initial rewrite failed with the user-reported real-world symptom (sm caret not restored on return trip).
- [x] **AT0003 failed on first run — production fix required:** Trace artifact (`logs/at0003-pane-activation-trace.json`) made the bug unambiguous. Diagnosis from the trace:
  - `save-callback cardId=A1` fired correctly on the p2 click (pane-focus-controller's save path is working).
  - A3 fired on the return-trip commit with `site: "a3-dom-authority"` → focused sm-A1 (`activeBefore=body, activeAfter=sm-A1`).
  - 0–1ms later, a `focusout` on sm-A1 with `relatedTarget: null` — focus moved from sm-A1 to body.
  - Root cause: WebKit's mousedown default behavior, for a trusted click on a non-focusable pane-chrome element, clears focus to body. Because React commits (and our A3 useLayoutEffect) run inline during the mousedown dispatch BEFORE WebKit's default runs, the sequence was: A3 focus → mousedown default blur → caret gone.
  - This was hidden for the synthesized-click version because `isTrusted: false` mouse events don't trigger WebKit's default focus-clearing — exactly the fidelity gap [D09] documents.
- [x] Production fix landed: `pane-focus-controller.ts` grew a second document-level capture-phase listener for `mousedown`. When the click is inside `[data-pane-id]` but outside any `[data-card-host]` (i.e., pane chrome — title, frame, resize handles), the listener calls `event.preventDefault()` to suppress WebKit's focus-clearing. Card-content clicks (inside `[data-card-host]`) are untouched, preserving the browser's default "click input → focus input" behavior. The existing pointerdown listener stays as the activation driver; `preventDefault` on pointerdown would cancel the compatibility mouse events entirely (mousedown / mouseup / click), so a separate mousedown listener is the surgical fix.
- [x] Re-run AT0003 with fix applied: 1/1 green.
- [x] `bun test` in `tugdeck/`: 2452/2452 green (fix did not regress tugdeck unit tests).
- [x] Full in-app sweep: `_smoke` 2/2, `_smoke-native` 5/5, AT0001 1/1, AT0003 1/1, AT0016 1/1 — no regressions.
- [x] Manual spot-check in the running app passed (2026-04-24): click into `sm` textarea, click the OTHER pane's title bar, click the FIRST pane's title bar — caret lands back in `sm` at the saved offset, matching the automated test outcome. The fidelity envelope closed: the trusted-click test and real-app gesture flow produce the same result.
- [x] Update `dash/at-series-reconciliation.md` with the Step 3b finding.

**Tests:**

- [x] In-app sweep exits 0 with the rewritten AT0003 (all 10 test cases across the 5 sweep files green).
- [x] `bun test` in `tugdeck/` exits 0 (2452/2452).
- [x] Manual interactive repro in real Tug.app (DEBUG build) matches the test outcome (2026-04-24).
- [x] `grep -cE "focusElement|app\.click\(" tests/app-test/at0003-pane-activation.test.ts` returns 0.

**Checkpoint:**

- [x] AT0003 uses `nativeClickAtElement` exclusively for user-gesture clicks.
- [x] In-app sweep green.
- [x] Real-app manual repro matches test outcome.
- [x] Production fix landed in `pane-focus-controller.ts`; reconciliation doc updated. Fix lands in its own commit separate from the test rewrite.

**Follow-on (out of scope for Step 3b, noted here so they don't get lost):**

- ~~AT0001 and AT0016 currently also use `focusElement` and `app.click` for user-gesture clicks. They report green in the real app today, but they have the same fidelity gap. After 3b validates the pattern, plan a follow-on to rewrite AT0001 and AT0016 similarly.~~ **LANDED (2026-04-24):** Both AT0001 and AT0016 rewritten with `nativeClickAtElement`; both pass on first run without additional production changes. Step 3b's pane-focus-controller mousedown fix covers tab clicks (tabs are pane chrome, not card content) and close-button clicks (the fix's `[data-no-activate]` opt-out preserves browser default behavior there, which is what we want for close — the blur before unmount is harmless). `grep -cE "focusElement|app\.click\(" tests/app-test/{m01,m16}-*.test.ts` returns 0 on both. Full in-app sweep (_smoke, _smoke-native, m01, m03, m16) 10/10 green.

---

#### Step 3c: Interruptible drag — `nativeDragWithoutRelease` primitive {#step-3c}

**Depends on:** #step-3 (the existing `nativeDrag`, `nativeMouseDown`, `nativeMouseUp` primitives must be in place; this step decomposes one of them)

**Commit:** `feat(tugapp-bridge): nativeDragWithoutRelease for mid-drag interruption`

**References:** [D02] CGEventPost variant; (#phase-a-hardware); selection plan `at0021-drag-aborted`.

**Purpose.** Today's `nativeDrag` is atomic: one Swift-side RPC dispatches `mouseDown` at `from`, an 8-step interpolated trail along `from → to`, and `mouseUp` at `to`. The trail and the release ship together. That makes it impossible to compose gestures that need to *interrupt* a drag mid-flight — the canonical case being a user pressing **Escape** during a tab drag to abort the move. With current verbs, `nativeKey("Escape")` issued before `nativeDrag` fires before the drag begins, and issued after `nativeDrag` fires after the drag has already committed via `mouseUp`. The Escape handler installed by `card-drag-coordinator.ts` (selection plan #step-23c) cannot be exercised end-to-end through trusted CGEvents.

**Concrete failure case.** `tests/app-test/at0021-drag-aborted.test.ts` ships as a `describe.skipIf(true)` placeholder at Step 23C close because of this gap; its file header documents two paths to close (this step is path 1).

**Artifacts:**

- **Swift handler `nativeDragWithoutRelease`.** Posts `mouseDown` at `from`, then the same 8-step interpolated trail along `from → to`, but does NOT post `mouseUp`. The pointer remains "pressed" from the WebKit / WindowServer perspective until a subsequent `nativeMouseUp` fires. Mirrors the existing `nativeDrag` Swift handler's button + delay knobs (`button`, `mouseDownDelayMs`, `mouseUpDelayMs` — `mouseUpDelayMs` is unused in this variant but kept on the input shape for symmetry).
- **TS surface method `nativeDragWithoutRelease(from, to, opts?)`** on `tests/app-test/_harness/index.ts`'s App handle, plus `nativeDragElementWithoutRelease(fromSelector, to, opts?)` for element-anchored variant. Same `NativeDragOptions` shape as `nativeDrag`; the only behavior difference is the missing terminal `mouseUp`.
- **No new transport surface.** `nativeDragWithoutRelease` is a new RPC verb in the existing native-event channel; the wire format and dispatch path are already in place from Step 2.
- **Documentation.** The TS surface JSDoc explicitly names the canonical caller pattern: `nativeDragWithoutRelease(...) → nativeKey("Escape") → nativeMouseUp(...)` (or any other sequence that needs a held-pointer state). Without this primitive, the post-mouseUp `pointerup` event commits whatever drop-zone the pointer ended in; Escape arrives too late.

**Tasks:**

- [ ] Swift: factor the existing `nativeDrag` handler into a private helper that takes a `releaseAtEnd: Bool` parameter (or two private helpers — `dispatchDragTrail` + optional `dispatchMouseUp`). The existing `nativeDrag` becomes the `releaseAtEnd: true` caller; the new `nativeDragWithoutRelease` is the `releaseAtEnd: false` caller. Keeps a single source of truth for the trail interpolation.
- [ ] Swift: register the new RPC verb name in the native-event handler dispatch table.
- [ ] TS: add `nativeDragWithoutRelease` and `nativeDragElementWithoutRelease` to `tests/app-test/_harness/client.ts`. Mirrors the `nativeDrag` / `nativeDragElement` shape exactly (one fewer mouseUp on the wire).
- [ ] TS: expose both methods on the App handle in `tests/app-test/_harness/index.ts` with JSDoc that names the canonical compose pattern.
- [ ] Backfill `tests/app-test/at0021-drag-aborted.test.ts`: replace the `skipIf(true)` placeholder with a real test body that issues `nativeDragElementWithoutRelease(tabA, somewhereFar) → nativeKey("Escape") → nativeMouseUp(somewhereFar)`. Assertions: A stays in P1 (no commit ran), A's input value is preserved, focus is inside A's content (via the cancel hook in `card-drag-coordinator#onDocumentKeydown`).
- [ ] Optional: a smoke fixture that calls `nativeDragWithoutRelease` followed by `nativeMouseUp` and verifies the gesture commits identically to `nativeDrag` — pins that the decomposition is faithful.

**Tests:**

- [ ] `tests/app-test/at0021-drag-aborted.test.ts` — backfilled per above. The test must not skip.
- [ ] Sanity smoke: in `smoke-native.test.ts` or a new sibling file, verify `nativeDragWithoutRelease + nativeMouseUp` produces the same painted-selection outcome as the existing `nativeDrag` smoke test (pins the decomposition).

**Checkpoint:**

- [ ] `bun test tests/app-test/at0021-drag-aborted.test.ts` exits 0 (no skip).
- [ ] `bun test tests/app-test/smoke-native.test.ts` still 5/5 green; new decomposition smoke is included or the existing endpoint-drag test passes verbatim.
- [ ] Full `just test-in-app-fast` sweep stays green.
- [ ] Manual gesture in the running app: drag a tab >5px, press Escape, observe focus return inside the source card. The trusted-event automated test now covers this; manual check is a one-shot regression sanity.

**Author note (planned 2026-04-24):**

Step 3c was deferred from selection plan #step-23c (Pass 4) — it surfaced as a gap when m21 was authored. The production cancel logic in `card-drag-coordinator.ts` is small (~10 lines: document keydown listener install/cleanup, Escape match, `fireDragCancel` that routes through `transferFocusAfterMove`). Manual verification was the regression gate at Step 23C close; this step closes that gap with automated coverage.

---

#### Step 4: Swift handlers for app-lifecycle simulation {#step-4}

**Depends on:** #step-3

**Commit:** `feat(tugapp-bridge): add NSApp lifecycle simulation handlers (DEBUG-only)`

**References:** [D07] NSApp lifecycle, Spec [#s01-hardware-rpc], (#app-lifecycle-sim)

**Artifacts:**
- Swift handlers for `simulateAppResign`, `simulateAppBecomeActive`, `simulateAppHide`, `simulateAppUnhide` — each invokes the NSApp primitive on the main thread and waits for the corresponding delegate callback to fire (bounded 1000ms); `AppLifecycleTimeoutError` on timeout.
- `tests/app-test/_harness/index.ts` — typed methods on the `App` class (these verbs are pure RPC and do not touch `window.__tug`, so the tugdeck-side `test-surface.ts` is unchanged).
- `tests/app-test/_harness/errors.ts` — adds `AppLifecycleTimeoutError`.

**Tasks:**
- [x] Swift: implement `simulateAppResign` via `NSApp.deactivate()` + Finder activation fallback (see Author note 2026-04-25); wait for `applicationDidResignActive:` to fire.
- [x] Swift: mirror for `BecomeActive` (`NSApp.activate(ignoringOtherApps: true)` + `applicationDidBecomeActive:`).
- [x] Swift: mirror for `Hide` (`NSApp.hide(nil)` + `applicationDidHide:`).
- [x] Swift: mirror for `Unhide` (`NSApp.unhide(nil)` + `applicationDidUnhide:`).
- [x] Timeout handling: if the expected delegate callback does not fire within 1000ms, return `AppLifecycleTimeoutError`.
- [x] TS surface: wrap as typed methods with 2000ms default RPC timeout (enough margin over the server-side wait).

**Tests:**
- [x] `tests/app-test/smoke-app-lifecycle.test.ts` (scratch; deleted after Step 6) — verifies each of the four handlers returns successfully when called in isolation; deliberate timeout by passing `timeoutMs: 1` after the app is already hidden (NSApp.hide() is a no-op when already hidden, so the notification reliably misses the wait window).

**Checkpoint:**
- [x] `just test-in-app-fast smoke-app-lifecycle.test.ts` exits 0.
- [x] Binary-size diff still within noise.

**Author note (2026-04-25).** Two implementation deviations worth pinning. First, `NSApp.deactivate()` alone is silently ignored on macOS Sonoma+ when there's no other "active" app queued to receive activation — `applicationDidResignActive:` never posts. The Swift handler now activates Finder via `NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder").first?.activate(options: [])` after calling `deactivate()`. Finder is system-essential and always running, so it's a reliable target; this matches the user-facing scenario "user clicks Finder, Tug.app loses focus" that AT0004 is meant to exercise. Second, the deliberate-timeout test uses "call simulateAppHide while already hidden" rather than just a tight `timeoutMs: 1` against a fresh call — the latter would race the run loop on a fast machine. Calling hide while already hidden is deterministically a no-op (NSApp short-circuits), so combined with `timeoutMs: 1` the verb is guaranteed to surface `AppLifecycleTimeoutError`. Surface version bumped Swift `1.1.0`→`1.2.0` and TS `EXPECTED_SURFACE_VERSION` `1.1.0`→`1.2.0` (additive minor; major stays 1). The plan's `tugdeck/src/test-surface.ts` artifact is dropped — `simulateApp*` are pure RPC verbs handled at the Swift bridge, with no `window.__tug.*` surface change.

---

#### Step 5: Tugcode subprocess lifecycle — Swift side {#step-5}

**Depends on:** #step-4

**Commit:** `feat(tugapp-bridge): add tugcode subprocess lifecycle handlers (DEBUG-only)`

**References:** [D04] harness-owned tugcode, [D05] two modes, [Q03] lifecycle granularity, Spec [#s03-tugcode-lifecycle], (#tugcode-lifecycle)

**Artifacts:**
- Swift code in `tugapp/` adding `startTugcode(opts)`, `stopTugcode()` handlers. `#if DEBUG` gated.
- Subprocess spawn path: reads `TUGAPP_TUGCODE_BINARY` env var; exec with stub-mode flag when `opts.mode === "stub"`.
- Teardown path: `SIGTERM` then `SIGKILL` after 2000ms.
- Tugcode stdout/stderr routed to `tests/app-test/logs/<test>-tugcode.log`.
- Production tugcode-launch path gated behind `!testMode` (ensures test mode does not also trigger the production launch).

**Tasks:**
- [x] Implement `startTugcode` handler: subprocess spawn (Process), held-open stdin pipe so tugcode doesn't EOF-exit on launch, log routing to opts.logFilePath OR /dev/null. Step 5 spawn passes no extra flags; Step 6 will add `--stub-transcript=<fd>`.
- [x] Implement `stopTugcode` handler: close stdin pipe write-end, SIGTERM, poll up to 2000ms for exit, SIGKILL on timeout. Idempotent.
- [x] Measure tugcode startup latency across 10 runs; record result to decide [Q03] (see Author note 2026-04-25).
- [x] [Q03] resolved: per-test-file lifecycle (no resetTugcode RPC needed). Median start+stop+RPC wall-clock 13.2ms; well under the 500ms decision threshold.
- [x] Production tugcode-launch path: see Author note. Tugcast spawns tugcode per AI session on demand, NOT at app boot. Test mode never triggers AI sessions, so the production path is naturally inactive — the gate is a no-op today and can be revisited if/when tugcast adds an at-boot tugcode warm-spawn.
- [x] Route stdout/stderr to log file (or /dev/null when opts.logFilePath is unset).
- [x] Connection close hook: `TestHarnessConnection.close()` calls `tugcodeLifecycle.stop()` so a graceful disconnect doesn't leak a zombie.

**Tests:**
- [x] `tests/app-test/smoke-tugcode-lifecycle.test.ts` (scratch; folded into Step 7): three tests covering start+stop round-trip + pid uniqueness, already-running guard throws TugcodeLaunchError, 10-cycle latency measurement.

**Checkpoint:**
- [x] Swift DEBUG build succeeds, no warnings.
- [x] `just test-in-app-fast smoke-tugcode-lifecycle.test.ts` passes (3/3 in 7.63s).
- [x] Tugcode startup latency: median 13.2ms / min 11.5ms / max 13.7ms across 10 cycles (recorded inline in [Q03] section above).
- [x] Full default sweep `just test-in-app-fast` still 13/13 green.

**Author note (2026-04-25).** Three implementation deviations worth pinning. First, the production tugcode-launch path is in tugcast (Rust), not in tugapp Swift — tugcast spawns tugcode per AI session in `feeds/agent_bridge.rs::TugcodeSpawner`, NOT at tugcast / Tug.app boot. The plan's "Production tugcode-launch path gated behind `!testMode`" task is therefore a no-op at this step: under the harness, tugdeck never initiates an AI session, so tugcast never reaches the spawner. The gate would only matter if tugcast added an at-boot warm-spawn; we can revisit then. Second, tugcode shuts down on stdin EOF (its `[tugcode] stdin closed, shutting down` exit branch), so the Swift handler holds a `Pipe`'s write-end open for the lifetime of the child. The pipe write-end will be repurposed in Step 6 to write transcript bytes for stub-mode replay — the FD plumbing lands now even though the writer is silent in Step 5. Third, surface version bumped Swift `1.2.0`→`1.3.0` and TS `EXPECTED_SURFACE_VERSION` `1.2.0`→`1.3.0` (additive minor; major stays 1). The smoke test's `smoke.test.ts` exact-match assertion stays consistent because both sides bump in lockstep.

---

#### Step 6: Stub-transcript replay mode in tugcode + transcript tooling {#step-6}

**Depends on:** #step-5

**Commit:** `feat(tugcode): add stub-transcript mode for deterministic test replay`

**References:** [D05] two modes, [D06] transcript format, [Q04] format decision, Spec [#s03-tugcode-lifecycle], (#stub-transcripts)

**Artifacts:**
- `tugcode` binary gains `--stub-transcript=<fd>` flag; in stub mode it reads structured-record transcripts from the fd and replays them on stream-json turns.
- `scripts/capture-tugcode-transcript.ts` — spawns live tugcode, runs a scenario, captures the structured transcript to disk, writes the `.sha256` sidecar.
- `scripts/reapprove-transcript.ts` — recomputes sidecar when a transcript is re-captured legitimately.
- `tests/app-test/_harness/client.ts` — `seedTugcodeTranscript(transcript)`, `seedTugcodeError(opts)` wrappers.
- `tests/app-test/_harness/errors.ts` — `TugcodeLaunchError`, `TugcodeVersionSkewError`, `TugcodeTranscriptMismatchError`.

**Tasks:**
- [x] Add `--stub-transcript=<path>` CLI flag to tugcode; parse structured records; replay deterministically per turn. (Path-based not fd-based — see Author note.)
- [ ] Record tugcode version in startup handshake; harness reads it and throws `TugcodeVersionSkewError` on mismatch. **DEFERRED** — see Author note. The transcript carries `tugcodeVersion` for capture-time pinning; runtime handshake is not yet wired (no real-world drift to detect until 7C lands committed transcripts).
- [ ] Author `capture-tugcode-transcript.ts` with `--scenario=<name>` flag; writes `.transcript.json` + `.sha256`. **DEFERRED to Step 7** — the script needs a live tugcode + EM-card target to capture against, both of which arrive in Step 7.
- [x] Author `reapprove-transcript.ts` for legitimate re-capture workflow (~50 lines; uses the shared `computeTranscriptHash` helper).
- [x] Transcript handoff: folded `seedTugcodeTranscript` into `app.startTugcode({ transcript, ... })` — see Author note. Swift writes the transcript to a temp file under $TMPDIR and passes `--stub-transcript=<path>`; harness wraps the call. Content-hash sidecar verification lives in `tests/app-test/_harness/transcript.ts` for use by 7C.

**Tests:**
- [x] `tugcode/src/__tests__/stub-replay.test.ts` — 11 unit tests covering loadTranscript happy path / malformed-JSON / schema-version / index-mismatch / missing-fields, plus StubReplayEngine handshake / dispatch / out-of-bounds / multi-turn.
- [x] `tests/app-test/_harness/__tests__/transcript.test.ts` — 8 tests covering computeTranscriptHash determinism + sidecar verify (match / mismatch / missing-sidecar) + loadTranscriptWithSidecar (parses on match; refuses without parsing on mismatch).
- [x] `tests/app-test/smoke-tugcode-stub.test.ts` (scratch; folded into `smoke-em.test.ts` at Step 7): end-to-end pipeline — protocol_init + user_message → recorded outputs in stdout log; stub-without-transcript fails fast; malformed transcript produces `error` event from tugcode.

**Checkpoint:**
- [x] Tugcode binary accepts `--stub-transcript=<path>` and replays deterministically (3/3 stub-mode smoke tests green).
- [x] Reapprove script produces sidecars whose hash matches `shasum -a 256`.
- [x] [Q04] resolved — structured-record format with sha256 sidecar is in place. See Resolution block in [Q04] above.

**Author note (2026-04-25).** Five implementation deviations from the plan-as-written, in declining order of significance.

(1) **Transcript handoff is path-based, not fd-based.** The plan envisioned `--stub-transcript=<fd>` with the harness writing transcript bytes to an inherited file descriptor. Foundation's `Process` API doesn't expose arbitrary fd inheritance to children (would require `posix_spawn_file_actions` below the API), and the alternative — pre-buffering the pipe before `Process.run()` so the child reads "atomically" — is fragile because the child blocks on read until bytes arrive. Path-based is simpler and equivalent in fidelity: Swift writes the transcript JSON to a temp file under `$TMPDIR` and passes `--stub-transcript=<path>` to tugcode. The temp file is removed on `stop()`.

(2) **Folded `seedTugcodeTranscript` and `seedTugcodeError` into `startTugcode`'s opts.** The plan's separate-verbs design assumed hot-loading transcripts during a test; in practice every known consumer (the stub-mode smoke + Step 7's `smoke-em.test.ts`) authors the full transcript before launch. Two-step state (seed → start) creates ordering coupling without ergonomic gain. To inject errors into a turn, build them as `error`-typed entries in the relevant `turn.outputs[]` array — that's the same wire frame the engine would emit anyway.

(3) **Added `writeTugcodeStdin(line)` RPC verb.** Tests need to drive tugcode's IPC loop (send protocol_init, send user_message). The plan implicitly assumed tugcast was in the loop, but harness-owned tugcode runs without tugcast — so we expose a direct stdin-write RPC. The Swift handler appends to the held-open `Pipe` write-end created in Pass 7A.

(4) **Capture script deferred to Step 7.** The capture script needs a live tugcode + EM-card sink to capture against. Both arrive in Step 7. Authoring the script in 7B against an absent target would produce dead-on-arrival code. The shared `computeTranscriptHash` helper + `reapprove-transcript.ts` are landed now so 7C can build the capture script directly on them.

(5) **Version handshake deferred.** `TugcodeVersionSkewError` class is defined; the throw-site is not yet wired. Until 7C lands committed transcripts (which then might drift against later tugcode rebuilds), there's nothing real to gate. The `tugcodeVersion` field on every transcript pins capture-time provenance; the runtime check is a one-line add when 7C's first committed transcript ships. Surface versions bumped Swift `1.3.0`→`1.4.0` and TS `EXPECTED_SURFACE_VERSION` `1.3.0`→`1.4.0` for the additive `transcript` and `writeTugcodeStdin` wire payloads.

---

#### Step 7: EM-card surface + first EM smoke test {#step-7}

**Depends on:** #step-6

**Commit:** `feat(test-surface): add EM-card observation surface and stub-mode smoke test`

**References:** [D10] engine caret variant, [L01] new trace events, Spec [#s02-em-card-surface], (#em-surface, #stub-transcripts)

**Artifacts:**
- `tugdeck/src/test-surface.ts` — adds `getEmCardState` + `isEngineReady` / harness-side `awaitEngineReady`. The plan's originally-listed `getEngineSelection` and `drainTugcodeTurn` are subsumed/deferred — see Author note. Tugcode lifecycle delegates (`startTugcode` / `stopTugcode` / etc.) live as RPC verbs on the App handle, NOT on `__tug.*` (only Swift can spawn subprocesses; routing through page-side `__tug.*` would be a layering violation).
- `tugdeck/src/deck-trace.ts` — adds `engine-ready` and `engine-activation-dispatched` event kinds per [L01]. Both kinds defined; `engine-ready` has an emit site in `tug-prompt-input.tsx`. `engine-activation-dispatched` emit sites land at selection plan Step 23E with the `onCardActivated` registrations.
- `tugdeck/src/components/tugways/tug-prompt-input.tsx` — emits `engine-ready` after the engine's mount-time `useLayoutEffect` finishes. tide-card and gallery-prompt-entry inherit via composition (both wrap TugPromptInput / TugPromptEntry, which use TugTextEngine internally); their dedicated emit sites can land alongside Step 23E if needed.
- `tests/app-test/smoke-em.test.ts` — three-test EM-card observation smoke (engine-ready trace, getEmCardState round-trip after typing, getEmCardState returns null for FC cards). Promoted from scratch — added to `just test-in-app-fast` default sweep.
- `tests/app-test/fixtures/tugcode/em-smoke.transcript.json` — DEFERRED to a follow-up. The capture script that produces it is also deferred (see Step 8 / Author note); the smoke at Pass 7C scope doesn't drive a real tugcode round-trip.

**Tasks:**
- [x] Extend `DeckTraceEvent` union with `engine-ready` and `engine-activation-dispatched`.
- [x] Wire `engine-ready` trace event at `tug-prompt-input.tsx` mount-time engine init. `engine-activation-dispatched` sites land at Step 23E.
- [x] Implement `getEmCardState` — fires `invokeSaveCallback` synchronously, reads `bag.content`, tags `engine` from the card's componentId. Returns `null` for non-EM cards / unknown ids.
- [x] Implement `isEngineReady` (synchronous trace-ring scan) + harness `awaitEngineReady` (`waitForCondition` wrapper). Plan's `awaitEngineReady` was page-side; that shape couldn't observe trace ring writes from inside `evalJS` — see Author note.
- [ ] Implement `drainTugcodeTurn` via `waitForCondition` on `getEmCardState(cardId).streamState === "idle"`. **DEFERRED** to a follow-up — needs tugcode → tugdeck integration not yet in place at Pass 7C scope; `streamState` is currently a stub field always returning `"idle"`.
- [ ] Author the `em-smoke` transcript + sidecar via `capture-tugcode-transcript.ts`. **DEFERRED** to Step 8 — see Author note. The capture script needs live mode AND the tugcast bypass to be useful as a fixture sink.
- [x] Author `smoke-em.test.ts`: the canonical EM observation smoke.

**Tests:**
- [x] `just test-in-app-fast smoke-em.test.ts` exits 0 (3/3 in 7.55s).
- [x] Scratch `smoke-tugcode-lifecycle.test.ts` and `smoke-tugcode-stub.test.ts` deleted (their coverage is subsumed by `smoke-em.test.ts` for surface validation; runtime tugcode-replay coverage moves to Step 8's live-mode smoke when it lands).

**Checkpoint:**
- [x] `just test-in-app-fast smoke-em.test.ts` exits 0.
- [x] `just test-in-app-fast` (full default sweep) still 14/14 green (`_smoke` + `_smoke-native` + `_smoke-em` + 11 AT-series files).
- [x] tugdeck unit tests 2412/2412; tsc clean both packages.

**Author note (2026-04-25).** Five implementation deviations from the plan-as-written, in declining order of significance.

(1) **Tugcode integration into tugdeck deferred.** The plan envisioned `smoke-em.test.ts` as a stub-mode end-to-end smoke: harness's tugcode replays a transcript → tugcast routes the bytes → tugdeck observes the streamed output via `getEmCardState`. Pass 7A discovered tugcast spawns its own tugcode per AI session — the harness-spawned tugcode is orphan from tugdeck's perspective. Fixing that requires tugcast-side changes (Rust) to read a test env var and defer to the harness-owned tugcode (or pipe-pass tugcode's stdout into tugcast's input). Out of scope for Pass 7C. The smoke retreats to "EM-card observation surface validation": seed an EM card, type into it via native gestures, assert the surface readbacks. The tugcode → tugdeck round-trip is tabled for a future pass when the tugcast-bypass plumbing lands; `streamState` and `lastTurnSeq` are stub fields with placeholder values until then.

(2) **`awaitEngineReady` lives on the harness side, not the JS surface.** The plan's `awaitEngineReady(cardId, timeoutMs?)` was a page-side method. That shape can't actually observe trace ring writes during a busy-wait — `evalJS` runs synchronously on WebKit's main thread, the same thread that records `engine-ready`. A loop inside `evalJS` would never see the event. The fix: synchronous `__tug.isEngineReady(cardId)` on the JS side (one-shot trace scan), plus a harness-side `app.awaitEngineReady(cardId, opts?)` that wraps `isEngineReady` in a `waitForCondition` for the blocking variant.

(3) **`getEngineSelection` subsumed by `getEmCardState`.** The plan listed `getEngineSelection(cardId)` as a separate method. In the implementation, the EM card's selection lives at `state.engineSelection` inside `getEmCardState`'s return value — a separate getter would be redundant. Tests that need just the selection read `(await app.getEmCardState(cardId))?.engineSelection`.

(4) **`drainTugcodeTurn` deferred.** Same root cause as (1) — without tugcode → tugdeck integration, `streamState` never transitions out of `"idle"`, so a wait-for-idle has nothing meaningful to gate on. Lands when the integration does.

(5) **Capture script (`scripts/capture-tugcode-transcript.ts`) deferred to Step 8.** The script needs a live tugcode + a tugdeck-observable sink to capture against. The latter doesn't exist at Pass 7C, so the script's value is zero today. Sliding it into Step 8 — alongside live-mode smoke setup — keeps both pieces in the same commit boundary.

Surface bumps: tugdeck `SURFACE_VERSION` `1.1.0`→`1.2.0` for the `__tug.*` additions; Swift `surfaceVersion` and harness `EXPECTED_SURFACE_VERSION` stay at `1.4.0` (no RPC changes).

---

#### Step 8: Live-mode smoke test; version handshake {#step-8}

**Depends on:** #step-7

**Commit:** `test(in-app): add em-card live-tugcode smoke (non-default)`

**References:** [D05] two modes, [R03] tugcode flakiness, Spec [#s03-tugcode-lifecycle]

**Artifacts:**
- `tests/app-test/smoke-em-live.test.ts` — live-mode round-trip against real tugcode (real model, real credentials). Marked with a `describe.skipIf(process.env.TUGCODE_LIVE !== "1")` guard so it runs only when explicitly requested.
- `tests/app-test/README.md` — gains "Running live-mode smoke" subsection.

**Tasks:**
- [x] Implement live-mode smoke: spawn tugcode in live mode, drive `protocol_init` + minimal `user_message`, poll log file for `assistant_text` + `turn_complete` frames, assert protocol-shape (no content lock-in since live model output is non-deterministic).
- [x] Gate test with `TUGCODE_LIVE=1` env var to skip by default.
- [x] Extend `StartTugcodeOptions` and the Swift handler to accept a `dir` field that maps to tugcode's `--dir <path>` arg (live mode needs a project dir). Stub mode ignores it; existing 7A/7B callers don't break.
- [x] Document the setup and opt-in flag in `tests/app-test/README.md`.

**Tests:**
- [x] `TUGCODE_LIVE=1 just test-in-app-fast smoke-em-live.test.ts` is the local dev runner; needs Anthropic credentials.
- [x] Default `just test-in-app-fast` skips the live test (verified — 14/14 default-sweep pass; the file is excluded from the FILES list in Justfile and gated by `describe.skipIf` on the env var).

**Checkpoint:**
- [x] Live-mode smoke runs only when both `TUGAPP_IN_APP_TEST=1` and `TUGCODE_LIVE=1` are set; skips cleanly otherwise (`0 pass / 1 skip / 0 fail`).
- [x] Default test run time unchanged (live test is not in the default FILES list).
- [x] tugdeck unit tests 2412/2412; Swift build clean.

**Author note (2026-04-25).** Two scope adjustments from the plan-as-written.

(1) **Tugdeck-side observation deferred.** The plan implicitly assumes the live-mode smoke can assert through tugdeck's EM-card surface (e.g., `app.getEmCardState(cardId).text === "ack"`). That requires the tugcast → harness-tugcode bypass plumbing that was deferred from Pass 7C — without it, tugdeck has no line of sight into the harness-spawned tugcode's output. The smoke retreats to "bare-tugcode protocol-shape" assertions: poll the log file, count `assistant_text` and `turn_complete` frames, verify no `error` frames. Lands the live-mode launch path, defers the cross-component round-trip to a later integration pass.

(2) **Capture script (`scripts/capture-tugcode-transcript.ts`) deferred to that same later integration pass.** Its only consumer would be a tugdeck-observable EM-card test; without one, the captured transcript has nowhere to land. The shared `computeTranscriptHash` helper + `reapprove-transcript.ts` shipped in 7B are sufficient for any manual capture needs in the meantime — a developer can produce a transcript by hand and run the reapprove script.

Surface bumps: none. The `dir` field is additive within the existing `startTugcode` payload (Step 6 already brought the surface to `1.4.0`).

---

#### Step 9: Phase A + B integration checkpoint {#step-9}

**Depends on:** #step-3, #step-4, #step-7, #step-8

**Commit:** `N/A (verification only)`

**References:** Success criteria [#success-criteria], [R01] release leak, [R03] tugcode flakiness, (#phase-a-hardware, #phase-b-em)

**Tasks:**
- [x] Run full `just test-in-app-fast` — 14/14 default sweep green (AT0001/AT0003/AT0016 + rapid-cadence variants, AT0004/AT0005, AT0006/AT0007/AT0021, `_smoke`, `_smoke-native`, `_smoke-em`).
- [x] Release-build `nm` audit — zero matches for `TestHarness`, `AppLifecycle`, `TugcodeLifecycle`, `NativeEvent`, `VirtualKeyMap`, `CoordMapping`; zero defined `CGEvent` symbols. `#if DEBUG` gating is fully effective — the harness produces zero bytes in release.
- [x] All 9 files in `tugapp/Sources/TestHarness/` start `#if DEBUG` and end `#endif`; `AppDelegate`'s test-harness usage is fully `#if DEBUG`-gated.
- [x] `TUGAPP_TEST_SOCKET` unset path verified inline: `AppDelegate.applicationDidFinishLaunching` only enters the test-bridge branch when `TestHarnessBridge.envSocketPath()` returns non-nil. Production tugcode launch (in tugcast) is unaffected — no test-mode-related code on that path (see Pass 7A Author note).
- [x] Accessibility-permission preflight verified by `smoke-native.test.ts` continuing to pass (5/5 trusted-event tests).
- [x] Surface version assertion: harness `EXPECTED_SURFACE_VERSION = "1.4.0"` matches Swift `surfaceVersion = "1.4.0"`; tugdeck `SURFACE_VERSION = "1.2.0"` is the JS-side counterpart. The plan's original "bump to 1.1.0" line is stale — current state is 1.4.0 RPC / 1.2.0 JS. The skew test (`version-handshake.test.ts`) and exact-match assertion in `smoke.test.ts` continue to pass.

**Tests:**
- [x] `just test-in-app-fast` exits 0 (14/14 default sweep green).
- [x] `bun test` in tugdeck exits 0 (2412/2412); tugcode (205/205); harness unit (58/58).

**Checkpoint:**
- [x] All green.
- [x] Release `nm` audit recorded above — no test-harness symbols leak; release binary is 677,816 bytes universal x86_64+arm64.
- [x] Surface versions in lockstep across tugdeck / Swift / harness.

---

#### Step 10: AT-series scenario-table authored; shared seeding helpers {#step-10}

**Depends on:** #step-9

**Commit:** `docs(harness): author at-series scenario table and shared scenario helpers`

**References:** [D08] scenario table authoritative, [D11] per-row coverage, Spec [#s04-mseries-scenarios], (#phase-c-coverage)

**Artifacts:**
- Spec [#s04-mseries-scenarios] is the table in this plan — this step adopts it as the canonical coverage ledger and cross-links it from relevant docs.
- `tests/app-test/_harness/scenarios.ts` — shared helpers: `seedTwoPanesWithOneFcEach`, `seedOnePaneWithThreeCards`, `seedPaneWithEmCardReady`, `seedStandardMSeriesBaseline`. Kept small and composable.
- PR-review checklist line (in repo's docs or PR template) citing the scenario table.

**Tasks:**
- [ ] Publish Spec [#s04-mseries-scenarios] as the canonical table; link from base plan's §Roadmap.
- [ ] Implement shared `scenarios.ts` helpers per the seeding patterns observed across AT-series rows.
- [ ] Add a PR-review checklist line: "if this PR adds an AT-series scenario, is the table updated?"
- [ ] Update `tests/app-test/README.md` with the cross-reference.

**Tests:**
- [ ] Helpers are unit-tested lightly via pure-logic assertions on their return shapes; real exercise happens in Steps 11–16.

**Checkpoint:**
- [ ] Table published.
- [ ] Helpers lint and typecheck clean.
- [ ] README cross-reference present.

---

#### Step 11: Synthesized-event AT-series batch — AT0011, AT0014, AT0015, AT0019, AT0029, AT0030 {#step-11}

**Depends on:** #step-10

**Commit:** `test(in-app): add synthesized-event at-series coverage (m11, m14, m15, m19, m29, m30)`

**References:** [D11] per-row coverage, [D12] drift-prevention, Spec [#s04-mseries-scenarios], (#phase-c-coverage)

**Artifacts:**
- `tests/app-test/at0011-card-close-reopen.test.ts` (with `skip` guard until reopen lands)
- `tests/app-test/at0014-scroll-persistence.test.ts`
- `tests/app-test/at0015-legacy-api-removal.test.ts`
- `tests/app-test/at0019-pane-close-teardown.test.ts`
- `tests/app-test/at0029-scroll-key-audit.test.ts`
- `tests/app-test/at0030-virtual-focus.test.ts`

**Tasks:**
- [ ] One per test, per the scenario table rows: seed, drive via synthesized events, assert, document drift-prevention cycle in commit message.
- [ ] Each test uses `scenarios.ts` helpers where applicable.

**Tests:**
- [ ] Each test exits 0 in `bun test tests/app-test/`.
- [ ] Each test's drift-prevention exercise documented in PR description per [D12].

**Checkpoint:**
- [ ] `bun test tests/app-test/m1[149].test.ts tests/app-test/m29.test.ts tests/app-test/m30.test.ts` exits 0.
- [ ] `bun test tests/app-test/` aggregate exits 0.

---

#### Step 12: App-lifecycle AT-series — AT0004, AT0005 {#step-12}

**Depends on:** #step-11

**Commit:** `test(in-app): add app-lifecycle at-series coverage (m04, m05)`

**References:** [D07] NSApp lifecycle, [D12] drift-prevention, Spec [#s04-mseries-scenarios], (#app-lifecycle-sim)

**Artifacts:**
- `tests/app-test/at0004-app-resign-return.test.ts`
- `tests/app-test/at0005-app-hide-unhide.test.ts`

**Tasks:**
- [ ] AT0004: seed pane with focused FC card; `simulateAppResign`; assert save fires; `simulateAppBecomeActive`; assert refocus.
- [ ] AT0005: parallel to AT0004 via `simulateAppHide` / `simulateAppUnhide`.
- [ ] Document drift-prevention cycles in PRs.

**Tests:**
- [ ] Both tests exit 0.

**Checkpoint:**
- [ ] `bun test tests/app-test/m0[45]*.test.ts` exits 0.

---

#### Step 13: EM-card AT-series — AT0002, AT0009, AT0018 {#step-13}

**Depends on:** #step-12

**Commit:** `test(in-app): add em-card at-series coverage (m02, m09, m18)`

**References:** [D05] two modes, [D10] engine caret variant, [D11] per-row coverage, Spec [#s04-mseries-scenarios], (#phase-b-em)

**Artifacts:**
- `tests/app-test/at0002-tab-switch-em.test.ts`
- `tests/app-test/at0009-em-inactive-mount.test.ts`
- `tests/app-test/at0018-async-content-ready-race.test.ts`
- `tests/app-test/fixtures/tugcode/at0002-return.transcript.json` (+ sidecar)
- `tests/app-test/fixtures/tugcode/at0009-em-inactive-mount.transcript.json` (+ sidecar)
- `tests/app-test/fixtures/tugcode/at0018-async-slow-stream.transcript.json` (+ sidecar)

**Tasks:**
- [ ] AT0002: seed EM card with text + selection; tab-switch twice; assert `getEmCardState(cardId).engineSelection` restored.
- [ ] AT0009: seed EM card in inactive pane; activate pane; assert `engine-activation-dispatched` trace event; assert engine focused and paint visible via DOM proxies.
- [ ] AT0018: slow-stream transcript; assert `save-callback` fires BEFORE `engine-ready`; assert post-ready refocus does not clobber.
- [ ] Author transcripts via `capture-tugcode-transcript.ts`.

**Tests:**
- [ ] Each test exits 0.

**Checkpoint:**
- [ ] `bun test tests/app-test/m0[29]*.test.ts tests/app-test/m18*.test.ts` exits 0.
- [ ] Content-hash sidecars verified on each transcript.

---

#### Step 14: CGEventPost AT-series — AT0010, AT0012, AT0020, AT0023 {#step-14}

**Depends on:** #step-13

**Commit:** `test(in-app): add cgeventpost at-series coverage (m10, m12, m20, m23)`

**References:** [D01] same transport, [D09] hardware-events additive, [D12] drift-prevention, Spec [#s04-mseries-scenarios], (#phase-a-hardware)

**Artifacts:**
- `tests/app-test/at0010-markdown-selection.test.ts`
- `tests/app-test/at0012-ime-composition.test.ts`
- `tests/app-test/at0020-overlay-focus-return.test.ts`
- `tests/app-test/at0023-cross-card-selection.test.ts`

**Tasks:**
- [ ] AT0010: markdown card text selection via `nativeMouseDown` + `nativeMouseUp` spanning; copy via `nativeKey("c", { modifiers: ["cmd"] })`; assert selection persists.
- [ ] AT0012: IME dead-key via `nativeKey` in Kotoeri/US layout; assert composition lifecycle; fidelity-limited per table note.
- [ ] AT0020: open context menu via `nativeClick` right-click; press Escape via `nativeKey`; assert originating input refocused.
- [ ] AT0023: selection spanning two cards via trusted mousedown+drag; assert per documented spec (span persists, OR resolves to nearest card — whichever the spec says).

**Tests:**
- [ ] Each test exits 0.

**Checkpoint:**
- [ ] `bun test tests/app-test/m1[02]*.test.ts tests/app-test/m2[03]*.test.ts` exits 0.

---

#### Step 15: CGEventPost drag-related AT-series — AT0006 (FC+EM), AT0007 (FC+EM), AT0021 {#step-15}

**Depends on:** #step-14

**Commit:** `test(in-app): add drag-related at-series coverage (m06 fc+em, m07 fc+em, m21)`

**References:** [D01] same transport, [D05] tugcode modes, [D09] hardware-events additive, Spec [#s04-mseries-scenarios]

**Artifacts:**
- `tests/app-test/at0006-cross-pane-fc.test.ts`
- `tests/app-test/at0006-cross-pane-em.test.ts`
- `tests/app-test/at0007-card-detach-fc.test.ts`
- `tests/app-test/at0007-card-detach-em.test.ts`
- `tests/app-test/at0021-drag-aborted.test.ts`
- Transcripts for EM rows: `at0006-em-cross-pane.transcript.json`, `at0007-em-detach.transcript.json`.

**Tasks:**
- [ ] AT0006-FC: drag FC card across panes via `nativeMouseDown` / (optional `nativeMouseMove` if Step 1 spike revealed it needed) / `nativeMouseUp`; assert focus + selection restored at destination.
- [ ] AT0006-EM: parallel to AT0006-FC with tide-card content; assert engine selection restored.
- [ ] AT0007-FC: detach card to new standalone pane.
- [ ] AT0007-EM: detach tide-card to new standalone pane.
- [ ] AT0021: start drag, press Escape mid-drag, assert original focus restored without mutation.
- [ ] Each test exercises the full `scenarios.ts` pane-seed helpers.

**Tests:**
- [ ] Each test exits 0.

**Checkpoint:**
- [ ] `bun test tests/app-test/m06*.test.ts tests/app-test/m07*.test.ts tests/app-test/m21*.test.ts` exits 0.
- [ ] Transcripts for AT0006-EM and AT0007-EM pass sidecar verification.

---

#### Step 16: Phase C Integration Checkpoint — full AT-series sweep + drift-prevention {#step-16}

**Depends on:** #step-11, #step-12, #step-13, #step-14, #step-15

**Commit:** `N/A (verification only)`

**References:** [D12] drift-prevention, Success criteria [#success-criteria], Spec [#s04-mseries-scenarios], (#phase-c-coverage)

**Tasks:**
- [ ] Run `bun test tests/app-test/` — all non-deferred AT-series scenarios green.
- [ ] Drift-prevention sweep: for each new AT-series test, revert its target fix locally, re-run, verify red, revert the revert, verify green. Document per-row outcome.
- [ ] Verify every row in [#s04-mseries-scenarios] marked "Infra: synthesized / CGEventPost / EM-card / app-lifecycle" has a corresponding green test file.
- [ ] Aggregate test runtime: measure wall-clock of `bun test tests/app-test/`; if > 2 minutes on a representative dev machine, note in [R02]'s revisit column.

**Tests:**
- [ ] `bun test tests/app-test/` exits 0.
- [ ] `bun test` in tugdeck still exits 0.

**Checkpoint:**
- [ ] Full sweep green.
- [ ] Drift-prevention documented per row.
- [ ] Runtime measured.

---

#### Step 17: Update base-harness plan roadmap; close extension rows {#step-17}

**Depends on:** #step-16

**Commit:** `docs(harness): mark base-plan extension roadmap rows closed by harness-extensions`

**References:** (#phase-a-hardware, #phase-b-em, #phase-c-coverage), [D08] scenario table authoritative

**Artifacts:**
- `.tugtool/tugplan-in-app-test-harness.md` — §Roadmap rows "Widen Phase 3 coverage", "CGEventPost hardware-event fallback", "EM-card harness support" marked closed with pointer to this plan.
- This plan's `Status` field flipped from `draft` to `active`.

**Tasks:**
- [ ] Edit base plan roadmap entries.
- [ ] Update this plan's status.
- [ ] Final grep for unresolved `[Q0N]` entries in this plan — confirm all deferred items are tracked.

**Tests:**
- [ ] `tugutil validate dash/tugplan-harness-extensions.md` exits 0.

**Checkpoint:**
- [ ] Both plan docs updated.
- [ ] `tugutil validate` clean.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Two new harness primitives (Swift-backed `CGEventPost` + NSApp lifecycle, tugcode-backed EM-card harness with stub + live modes) and a full AT-series regression suite covering every scenario the fidelity envelope supports. Release builds untouched; local-dev `bun test tests/app-test/` is the canonical proof of deck focus/selection/caret/activation behavior.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] Every `DeckTraceEvent` carries a `loc` (caller file:line) and `store` (`{activePaneId, activeCardId, hasFocus}`) snapshot at record time; matchers ignore both fields in partial matches. (Landed 0a + 0c.)
- [x] `toContainOrderedSubset` failure messages annotate out-of-order matches explicitly ("Order violation: …"). (Landed 0b.)
- [x] AT-series test failures write a full `tests/app-test/logs/<test>-trace.json` artifact for offline analysis. (Landed 0f, wired into AT0016.)
- [x] AT-series test failures emit the Tug.app log tail (200 lines) *before* the bun assertion error. (Landed 0d, 2026-04-24.)
- [x] Matcher failure messages carry a one-line-per-event summary above the full JSON dump. (Landed 0e, 2026-04-24.)
- [ ] `tests/app-test/smoke-native.test.ts` passes; `isTrusted: true` delivery verified.
- [ ] `tests/app-test/at0003-pane-activation.test.ts` uses `nativeClickAtElement` for every user-gesture click, passes `just test-in-app`, and matches interactive real-app behavior. (3b.)
- [ ] `tests/app-test/smoke-em.test.ts` passes; tugcode stub-mode round-trip verified.
- [ ] `tests/app-test/smoke-em-live.test.ts` passes on opt-in (`TUGCODE_LIVE=1`).
- [ ] `__tug.version === "1.1.0"`; harness handshake asserts.
- [ ] Every row in [#s04-mseries-scenarios] marked with a test-file location has a green test.
- [ ] Per-test drift-prevention documented for every new AT-series test landed by this plan.
- [ ] Release-build binary size unchanged vs pre-harness baseline (within noise); `nm` shows no `CGEventPost` / tugcode-lifecycle symbols.
- [ ] Accessibility-permission setup documented in README; preflight behavior verified on both permission granted and permission denied workstations.
- [ ] Stub-transcript content-hash sidecars verified on every EM-card test's transcript.
- [ ] Zero new happy-dom tests added for UI / focus / selection / DOM-timing behavior.
- [ ] Base-plan roadmap rows for extensions marked closed with pointer to this plan.

**Acceptance tests:**
- [ ] `bun test tests/app-test/` exits 0.
- [ ] `bun test` in tugdeck exits 0.
- [ ] `bun x tsc --noEmit` exits 0 in tugdeck/ and tests/app-test/.
- [ ] `tugutil validate dash/tugplan-harness-extensions.md` exits 0.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Rewrite AT0001 and AT0016 with trusted clicks, following the same pattern as Step 3b's AT0003 rewrite. Both tests pass today in both harness and real app, but they carry the same `focusElement` + synthesized-click fidelity gap as AT0003 did. Without the rewrite, their greens are not as strong as they appear. Schedule after Step 3b lands and confirms the trusted-click pattern works.
- [ ] CI integration (tracked in `dash/tugplan-harness-ci.md`, authored when CI becomes urgent per [Q01]).
- [ ] Multi-window test support (if Tug.app gains multi-window).
- [ ] `__tug.version` bump to `2.0.0` when a breaking change lands; this plan's `1.1.0` bump is additive only.
- [ ] Paint-correctness / caret-blink test approach (currently fidelity-limited out-of-envelope per AT0022; a separate visual-diff harness would be the vehicle).
- [ ] Coverage for the DEFERRED rows in [#s04-mseries-scenarios] as their target fixes land in their respective plans.
- [ ] `scenarios.ts` helpers extracted to a shared test-fixture package if other repos start needing them.

| Checkpoint | Verification |
|------------|--------------|
| Trace `loc` / `store` fields | Grep a fresh trace dump for `@ .*\.tsx?:` and `store: {` — both present on every event |
| Matcher annotations | Force an AT0001 out-of-order failure; terminal output contains "Order violation" and a numbered one-line summary |
| Log-tail-first on failure | Force an AT0001 failure; Tug.app log tail banner appears before the bun assertion error |
| Trace artifact | Force an AT0001 failure; `tests/app-test/logs/at0001-tab-switch-fc-trace.json` exists and `jq '.' <file>` succeeds |
| Native-event smoke | `bun test tests/app-test/smoke-native.test.ts` exits 0 |
| AT0003 trusted-click rewrite | `grep -cE "focusElement\|app\.click\(" tests/app-test/at0003-pane-activation.test.ts` = 0; `just test-in-app` exits 0; manual real-app repro matches |
| EM-card smoke | `bun test tests/app-test/smoke-em.test.ts` exits 0 |
| Live EM-card smoke | `TUGCODE_LIVE=1 bun test tests/app-test/smoke-em-live.test.ts` exits 0 |
| AT-series sweep | `bun test tests/app-test/m*.test.ts` exits 0, all rows in [#s04-mseries-scenarios] marked present have files |
| Drift prevention | Per-test revert-cycle documented in PR descriptions |
| Release binary unchanged | `wc -c` diff within noise; `nm` inspection shows no extension symbols |

---
