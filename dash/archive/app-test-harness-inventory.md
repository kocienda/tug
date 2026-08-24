# App-Test Harness — Feature Inventory, Audit, and Desiderata

**Last updated:** 2026-04-27.

This document is the authoritative catalog of what the **app-test
harness** can do. It complements [`tuglaws/app-test-inventory.md`](../tuglaws/app-test-inventory.md),
which catalogs *regression scenarios* (the AT-tags). They answer
different questions:

- This file: **"What can the harness do?"** Every method on the `App`
  class, every RPC verb the Swift bridge dispatches, every helper,
  every error type.
- The AT-tag inventory: **"What regression scenarios are gated?"** Each
  named regression case and the test file(s) that pin it.

Cross-link: a feature in this inventory is **covered** when at least
one AT-tag test or smoke test exercises it; **partial** when it
exists but only a subset of axes is tested; **gap** when no test
exercises it (and the feature exists in code but the harness can't
demonstrate it works end-to-end).

---

## 1. Bridge / RPC surface

The harness talks to `Tug.app` via a per-spawn Unix-socket bridge.
Each `launchTugApp` spawns a fresh `Tug.app` subprocess and connects
to its `TestHarness` listener. The bridge speaks JSON-line RPC.

| Feature | Where | One-line description |
|---|---|---|
| `launchTugApp(opts)` | `_harness/index.ts:1035` | Spawn + connect + version-handshake. Returns an `App`. |
| Version handshake (`version` RPC) | Swift dispatch `case "version"` | First RPC after connect; client expects `EXPECTED_SURFACE_VERSION`. |
| `EXPECTED_SURFACE_VERSION` constant | `_harness/index.ts:136` | Pinned `"1.5.0"` — must match Swift bridge byte-for-byte. |
| Single-client transport | Swift `TestHarnessListener` | First connect accepted; second connect → ECONNREFUSED. |
| Per-test log capture | `tests/app-test/logs/<testName>.log` | Tug.app stdout/stderr routed when `testName` set; gitignored. |
| `evalJS<T>(script, opts?)` | `_harness/index.ts:208` | Evaluate JS in WKWebView; result typed as `T`. |
| `waitForCondition<T>(expr, opts?)` | `_harness/index.ts:225` | Poll a JS expression until truthy; structured timeout. |
| RPC error translation | `_harness/rpc.ts` | Maps Swift error names → typed JS Errors (`TimeoutError`, `AppCrashedError`, etc.). |

## 2. Lifecycle verbs

| Feature | Where | One-line description |
|---|---|---|
| `app.close()` | `index.ts:982` | SIGTERM the subprocess; cleanup signals + sockets. |
| `app.quitGracefully(opts?)` | `index.ts:743`, Swift `case "quitGracefully"` | Schedules `NSApp.terminate(nil)` so `applicationShouldTerminate` runs `saveState()` before exit. |
| `app.appReload(opts?)` | `index.ts:812` | Soft `location.reload()` of the WKWebView; Tug.app + tugcast survive. |
| `simulateAppResign` | `index.ts:703`, Swift `case "simulateAppResign"` | `NSApp.deactivate()` → awaits `applicationDidResignActive:`. |
| `simulateAppBecomeActive` | `index.ts:712` | `NSApp.activate(ignoringOtherApps: true)` → awaits `applicationDidBecomeActive:`. |
| `simulateAppHide` | `index.ts:717` | `NSApp.hide(nil)` → awaits `applicationDidHide:`. |
| `simulateAppUnhide` | `index.ts:722` | `NSApp.unhide(nil)` → awaits `applicationDidUnhide:`. |
| `checkAccessibilityPermission(opts?)` | `index.ts:542`, Swift `case "checkAccessibilityPermission"` | Reports current AX-grant state; harness preflights this on every spawn. |
| AX preflight (auto, in `launchTugApp`) | `index.ts` `launchTugApp` | Throws `AccessibilityPermissionMissingError` unless `skipAccessibilityPreflight: true`. |

## 3. Synthesized DOM gestures (`isTrusted: false`)

| Feature | Where | One-line description |
|---|---|---|
| `app.click(selector, opts?)` | `index.ts:273` | JS `dispatchEvent` mousedown/mouseup/click. |
| `app.type(selector, text)` | `index.ts:281` | JS-synth typing into focused element. |
| `app.focusElement(selector)` | `index.ts:290` | Calls `.focus()` via production code path (not synthesized). |

These are useful for fast paths that do not require WebKit's
trusted-event handling. For paths that depend on `isTrusted: true`
(default focus, drag selection, double-click word-select, modifier
keys), use the native verbs in §4.

## 4. Native CGEvent gestures (`isTrusted: true`)

Posted via `CGEvent.post(tap: .cgSessionEventTap)` ([D02] in
`tugplan-harness-extensions.md`). Requires the Accessibility grant.

### 4a. Pointer

| Feature | Where | One-line description |
|---|---|---|
| `nativeClick(point, opts?)` | `index.ts:553`, Swift `case "nativeClick"` | One trusted click at viewport coords. |
| `nativeClickAtElement(selector, opts?)` | `index.ts:561` | Resolves selector → bounds-center, then `nativeClick`. |
| `nativeDoubleClick(point)` | `index.ts:569`, Swift `case "nativeDoubleClick"` | Pinned 80ms-interval double click; drives WebKit word-select. |
| `nativeDoubleClickAtElement(selector)` | `index.ts:577` | Selector-anchored variant. |
| `nativeRightClick(point)` | `index.ts:589`, Swift `case "nativeRightClick"` | Right-button click for context-menu paths. |
| `nativeRightClickAtElement(selector)` | `index.ts:594` | Selector-anchored variant. |
| `nativeDrag(from, to, opts?)` | `index.ts:599`, Swift `case "nativeDrag"` | Endpoint-only drag (mouseDown → one mouseDragged → mouseUp). |
| `nativeDragElement(fromSel, to, opts?)` | `index.ts:611` | Selector-anchored variant. |
| `nativeDragWithoutRelease(from, to)` | `index.ts:630`, Swift `case "nativeDragWithoutRelease"` | Drag without releasing — for multi-stage gestures. |
| `nativeDragElementWithoutRelease(fromSel, to)` | `index.ts:644` | Selector-anchored variant. |
| `nativeMouseDown(point)` | `index.ts:658`, Swift `case "nativeMouseDown"` | Primitive — only when atomic click won't do. |
| `nativeMouseUp(point)` | `index.ts:666`, Swift `case "nativeMouseUp"` | Primitive companion. |

### 4b. Keyboard

| Feature | Where | One-line description |
|---|---|---|
| `nativeKey(key, modifiers?)` | `index.ts:678`, Swift `case "nativeKey"` | One keystroke. `key` = VirtualKeyMap entry; `modifiers` ⊆ `["cmd", "shift", "alt", "ctrl"]`. |
| `nativeType(text)` | `index.ts:686`, Swift `case "nativeType"` | ASCII string typed key-by-key. Non-ASCII → `NativeTypeAsciiOnlyError`. |
| `holdModifier(mods, async thunk)` | `index.ts:909`, Swift `case "holdModifier"` | Press modifiers, run inner verbs, release — atomic Swift-side. |

`holdModifier` constraints:
- Inner verbs must be native gestures only (`evalJS` / `waitForCondition` / nested `holdModifier` reject).
- Flatten modifier sets (`["cmd", "shift"]`) instead of nesting scopes.

## 5. Deck-state seeding and reset

| Feature | Where | One-line description |
|---|---|---|
| `seedDeckState(args)` | `index.ts:306` | Preload deck contents (cards, panes, focus) before driving gestures. |
| `reset(opts)` | `index.ts:298` | Reset deck state without re-spawning. Orders-of-magnitude faster than relaunch. |

## 6. Deck-trace ring

The deck-trace ring captures structured events (`fr-flip`,
`destination-flip`, `focus-call`, `engine-ready`, `engine-restore`,
etc.) emitted by tugdeck production code. Tests assert against the
ring instead of brittle DOM-state polling.

| Feature | Where | One-line description |
|---|---|---|
| `getDeckTrace(opts?)` | `index.ts:339` | Read the ring; optional `since` cursor. |
| `markDeckTrace()` | `index.ts:344` | Returns a cursor for "events emitted from now on". |
| `clearDeckTrace()` | `index.ts:349` | Drop everything. |
| `enableDeckTrace(flag)` | `index.ts:354` | Turn the ring on/off. |
| `toContainOrderedSubset` matcher | `_harness/matchers.ts:538` | Bun `expect` matcher — partial ordered subset check. |
| `registerSubsetMatcher()` | `_harness/matchers.ts:639` | Registers the matcher with bun:test once at module load. |
| `summarizeEvent(e)` helper | `_harness/matchers.ts:351` | Produces a short string for assertion-failure diagnostics. |

## 7. Element / DOM introspection (pure reads)

| Feature | Where | One-line description |
|---|---|---|
| `getElementText(selector)` | `index.ts:388` | `textContent` (or `.value` for form controls). |
| `getElementValue(selector)` | `index.ts:393` | `.value` of `<input>` / `<textarea>` / `<select>`. |
| `getElementAttribute(selector, name)` | `index.ts:398` | Attribute string or `null`. |
| `getElementBounds(selector)` | `index.ts:406` | Viewport-rel `{x, y, width, height}`. |
| `getElementScreenBounds(selector)` | `index.ts:416`, Swift `case "getElementScreenBounds"` | Screen-CG `{x, y, width, height}` via CoordMapping. |
| `getElementState(selector)` | `index.ts:421` | `{tagName, disabled, readOnly, checked, visible, isFocused}`. |
| `getActiveElement()` | `index.ts:426` | `{tagName, id, cardId, persistKey, selector}` or `null`. |
| `getSelection(cardId?)` | `index.ts:435` | Selection snapshot (form-control or contentEditable range). |
| `getComputedStyleValue(selector, property)` | `index.ts:440` | Resolved CSS value. |

## 8. Card / focus / caret

| Feature | Where | One-line description |
|---|---|---|
| `getActiveCardId()` | `index.ts:311` | Deck's active card id (or `null`). |
| `getFocusedCardId()` | `index.ts:316` | Card that owns `document.activeElement`. |
| `getCaretState(cardId)` | `index.ts:321` | `{kind: "form-control", ...}` or `{kind: "engine", ...}` or `null`. |
| `getFormControlValue(cardId, persistKey)` | `index.ts:326` | Read a persisted form-control's current value. |
| `assertHostRootRegistered(cardId)` | `index.ts:334` | True iff the card's host root is mounted; gates timing-sensitive assertions. |
| `expectFocusedCard(cardId, opts?)` | `index.ts:363` | Wait + assert combo via `waitForCondition`; default 2000ms budget. |
| `expectCaret(cardId, expected, opts?)` | `index.ts:375` | Same shape for caret state. |

## 9. Selection boundary

| Feature | Where | One-line description |
|---|---|---|
| `registerSelectionBoundary(cardId, selector)` | `index.ts:458` | Register a card-scope selection boundary for cross-card guard logic. |
| `unregisterSelectionBoundary(cardId)` | `index.ts:470` | Inverse. |

## 10. EM-card / engine surface

EM (engine-managed) cards delegate text + selection state to a
contenteditable engine (`tug-prompt-input`, `tug-prompt-entry`,
tide). Their state shape differs from FC (form-control) cards.

| Feature | Where | One-line description |
|---|---|---|
| `getEmCardState(cardId)` | `index.ts:485` | `{kind: "em", engine, text, engineSelection, streamState, lastTurnSeq}` or `null`. |
| `isEngineReady(cardId)` | `index.ts:490` | Pure check against the trace ring. |
| `awaitEngineReady(cardId, opts?)` | `index.ts:499` | Wait + assert wrapper. |
| `bindTideSession(cardId, sessionId)` | `index.ts:516` | Bind a tide card to a session id. |
| `engine-ready` trace event | (emitted by tugdeck factories) | Fires on EM-card mount; consumed by `awaitEngineReady`. |

## 11. Tugcode subprocess control

The harness can spawn its own `tugcode` (Claude Code bridge) child
process per test, in either *stub* mode (canned transcript replay) or
*live* mode (real Anthropic API).

| Feature | Where | One-line description |
|---|---|---|
| `startTugcode(opts)` | `index.ts:878`, Swift `case "startTugcode"` | Spawn tugcode in stub or live mode. |
| `stopTugcode()` | `index.ts:887`, Swift `case "stopTugcode"` | SIGTERM the child. |
| `writeTugcodeStdin(line)` | `index.ts:898`, Swift `case "writeTugcodeStdin"` | Send a stream-json frame. |
| Stub-mode transcript replay | Swift `--stub-transcript=<path>` | In-memory transcript bytes written to a temp file passed on the CLI. |
| Transcript hash + sidecar | `_harness/transcript.ts:47–99` | `computeTranscriptHash`, `sidecarPathFor`, `verifyTranscriptSidecar`, `loadTranscriptWithSidecar` — guards against silent transcript drift. |
| `TUGCODE_TRANSCRIPT_SCHEMA_VERSION` | `client.ts` (re-export) | Pinned schema version for transcript JSON. |

## 12. Tugbank cold-boot helpers

For tests that span two `Tug.app` processes (cold-boot persistence)
or need tugbank isolation from the developer's real `~/.tugbank.db`.

| Feature | Where | One-line description |
|---|---|---|
| `mkTempTugbank()` | `_harness/tugbank-helpers.ts:61` | Returns a fresh temp `.db` path. |
| `rmTempTugbank(path)` | `tugbank-helpers.ts:73` | Best-effort cleanup. |
| `tugbankRead<T>(path, domain, key)` | `tugbank-helpers.ts:95` | Shells to the `tugbank` CLI for disk-side reads between processes. |
| `tugbankWrite(path, domain, key, value)` | `tugbank-helpers.ts:158` | Disk-side write companion. |
| `tugbankDelete(path, domain, key)` | `tugbank-helpers.ts:128` | Drop a single key. |
| `seedTugbankForLaunch(path)` | `tugbank-helpers.ts:203` | Pre-seeds `dev-mode-enabled` + `source-tree-path` so `launchTugApp({ env: { TUGBANK_PATH } })` finds a configured DB. |

## 13. Diagnostics

### 13a. Logging

| Feature | Where | One-line description |
|---|---|---|
| `app.tailLog(lines = 50)` | `index.ts:930` | Read last N lines of the per-test log file. |
| `app.dumpTraceToFile(path)` | `index.ts:966` | Dump the deck-trace ring to a JSON file for post-mortem. |

### 13b. Structured errors

| Error class | Where | When it fires |
|---|---|---|
| `TimeoutError` | `errors.ts:25` | `waitForCondition` budget exceeded. |
| `AppCrashedError` | `errors.ts:43` | Transport closed mid-call. |
| `VersionSkewError` | `errors.ts:66` | Handshake version mismatch. |
| `CoordinateOutOfBoundsError` | `errors.ts:90` | Native gesture point outside viewport. |
| `NativeTypeAsciiOnlyError` | `errors.ts:105` | `nativeType` given non-ASCII text. |
| `AccessibilityPermissionMissingError` | `errors.ts:128` | AX preflight failed. |
| `UnknownKeyError` | `errors.ts:145` | `nativeKey` given an unmapped key name. |
| `TugcodeLaunchError` | `errors.ts:163` | `startTugcode` couldn't spawn. |
| `TugcodeVersionSkewError` | `errors.ts:180` | tugcode binary's protocol version mismatched. |
| `TugcodeTranscriptMismatchError` | `errors.ts:201` | Stub transcript hash drifted from sidecar. |
| `AppLifecycleTimeoutError` | `errors.ts:236` | `simulateApp*` verb didn't see the expected `NSNotification`. |

## 14. Lint

| Feature | Where | One-line description |
|---|---|---|
| `lint-no-timers.ts` | `tests/app-test/lint-no-timers.ts` | `bun run lint:no-timers` — bans `setTimeout`/`setInterval` in test files outside `_harness/`. Forces use of `waitForCondition`. |

---

## 15. Audit table

Maps every feature to its current test status. **Status** is
`covered` (gate test exists and passes), `partial` (some axes covered,
others not), or `gap` (no gate test). Smoke files live under
`harness-smoke/`; AT-tag files are `at{NNNN}-*.test.ts`.

| Feature | Status | Gating test(s) | Notes |
|---|---|---|---|
| `launchTugApp` | covered | `harness-smoke/smoke.test.ts` | Spawn + handshake + close. |
| Version handshake | covered | `harness-smoke/version-handshake.test.ts` | Mismatch → `VersionSkewError`. |
| Single-client transport | covered | `harness-smoke/double-connect.test.ts` | Second connect → ECONNREFUSED. |
| Per-test log capture | covered | `harness-smoke/log-capture.test.ts` | Console.log lands in log file. |
| `evalJS` | covered | `harness-smoke/smoke.test.ts`, `wait-for-condition.test.ts` | Plus error-translation gate. |
| `waitForCondition` | covered | `harness-smoke/wait-for-condition.test.ts` | Timeout + immediate-truthy paths. |
| `app.close` | covered | every test (always called in `finally`). | |
| `app.quitGracefully` | covered | `harness-smoke/smoke-cold-boot.test.ts` | Two-process round-trip. |
| `app.appReload` | covered | `harness-smoke/smoke-app-reload.test.ts` | __tug re-attaches; tugcast survives. |
| `simulateAppResign / BecomeActive` | covered | `at0004-app-resign-return.test.ts` | (Older `_smoke-app-lifecycle.test.ts` was subsumed and removed.) |
| `simulateAppHide / Unhide` | covered | `at0005-app-hide-unhide.test.ts` | |
| AX preflight | covered | implicit in every native-event test; see also `harness-smoke/smoke-native.test.ts`. | |
| `app.click` (synthesized) | covered | many AT tests (e.g., `at0001-tab-switch-fc.test.ts`). | |
| `app.type` (synthesized) | covered | `at0001-tab-switch-fc.test.ts` and friends. | |
| `app.focusElement` | covered | many AT tests. | Production-path focus. |
| `nativeClick` / `AtElement` | covered | `harness-smoke/smoke-native.test.ts`, `at0003-pane-activation.test.ts` | Trusted click. |
| `nativeDoubleClick` / `AtElement` | covered | `harness-smoke/smoke-native.test.ts` | Word-select smoke. |
| `nativeRightClick` / `AtElement` | gap | none | No AT-tag exercises right-click; context-menu paths use `app.click` on the trigger. |
| `nativeDrag` / `Element` | covered | `harness-smoke/smoke-native.test.ts`, `at0006-cross-pane-drag.test.ts`, `at0007-card-detach.test.ts`, `at0021-drag-aborted.test.ts`. | |
| `nativeDragWithoutRelease` / `Element*` | partial | drag-aborted tests cover the abort branch but not multi-stage drag-and-pause flows. | |
| `nativeMouseDown` / `Up` (primitives) | gap | none | No AT-tag exercises the primitives directly; covered indirectly via `nativeClick`. |
| `nativeKey` | covered | `harness-smoke/smoke-native.test.ts` (Cmd+A). | |
| `nativeType` | covered | `harness-smoke/smoke-native.test.ts` | ASCII path; non-ASCII → `NativeTypeAsciiOnlyError`. |
| `holdModifier` | partial | only the `nativeKey("a", ["cmd"])` short form is tested in smoke; multi-keystroke `holdModifier` thunk path is structurally covered but not in an AT scenario. | |
| `seedDeckState` | covered | every AT test uses it. | |
| `app.reset` | partial | used internally by some tests; no dedicated smoke gate for the reset path itself. | |
| Deck-trace ring (`getDeckTrace` / `markDeckTrace` / `clearDeckTrace` / `enableDeckTrace`) | covered | every AT tab-switch / cross-pane test asserts via `toContainOrderedSubset`. | |
| `toContainOrderedSubset` matcher | covered | `_harness/matchers.test.ts` (unit) + every AT use site. | |
| `summarizeEvent` | covered | `tugdeck/src/__tests__/trace-summarize-drift.test.ts` pins the harness-side mirror against tugdeck's union. | |
| Element / DOM introspection (`getElement*`, `getActiveElement`, `getSelection`, `getComputedStyleValue`) | covered | many AT tests. | |
| `getElementScreenBounds` | covered | `harness-smoke/smoke-native.test.ts` | Used to compute click coords. |
| `registerSelectionBoundary` / `unregister*` | partial | Used by the M23 cross-card path (`at0023-cross-card-selection.test.ts`); narrow coverage. | |
| `getEmCardState` / `isEngineReady` / `awaitEngineReady` | covered | `harness-smoke/smoke-em.test.ts`, all `at*-em-*.test.ts` files. | |
| `bindTideSession` | partial | Used by tide tests (`at0035-tide-app-switch-selection.test.ts`); no dedicated unit gate. | |
| `startTugcode` / `stopTugcode` / `writeTugcodeStdin` | partial | Stub-mode end-to-end via `harness-smoke/smoke-em.test.ts`; live-mode via opt-in `harness-smoke/smoke-em-live.test.ts`. | |
| Stub transcript hash + sidecar | covered | `_harness/__tests__/transcript.test.ts` (unit). | |
| Tugbank helpers (`mkTempTugbank`, `tugbankRead`, `tugbankWrite`, `tugbankDelete`, `seedTugbankForLaunch`) | covered | `harness-smoke/smoke-cold-boot.test.ts`, `harness-smoke/smoke-app-reload.test.ts`, all `at*-cold-boot-*.test.ts`. | |
| `app.tailLog` | covered | `harness-smoke/log-capture.test.ts`. | |
| `app.dumpTraceToFile` | partial | Wired into the catch blocks of several AT tests; no positive gate that asserts the file's content. | |
| Structured errors (all 11 classes) | partial | `TimeoutError`, `VersionSkewError`, `AppCrashedError`, `NativeTypeAsciiOnlyError`, `AppLifecycleTimeoutError`, `AccessibilityPermissionMissingError`, `TugcodeTranscriptMismatchError` are positively gated by smoke files. `CoordinateOutOfBoundsError`, `UnknownKeyError`, `TugcodeLaunchError`, `TugcodeVersionSkewError` have no failing-by-design test that fires the error path. | |
| `lint-no-timers.ts` | partial | The lint script exists and runs; CI doesn't currently gate on its exit code, and four test files have known-banned `setTimeout` references that predate the lint. | The lint is informational today. |

---

## 16. Desiderata

What's missing, with a one-line rationale each. None of these are
implemented as part of the rename plan; they're picked from for
follow-on plans.

### Process / CI

- **CI integration.** The AX preflight gates the harness on a manual
  macOS grant; CI runners that don't have AX access can't run AT
  tests. (Tracked as `tugplan-harness-extensions.md` [Q01].)
- **`lint:no-timers` in CI gate.** Today the script is informational
  with four pre-existing violations. Either fix the violations and
  fail-the-build, or document the carve-outs and gate strictly on
  the rest.
- **Drift-prevention discipline.** `tugplan-harness-extensions.md`
  [D12] requires a deliberate revert-and-retest cycle for every new
  AT test before merge — process, not code.
- **Parser-drift gate for the `app-test` summary.** Bun's per-file
  `"X pass, Y fail"` line is what the recipe parses. A dedicated
  smoke gate would catch a future bun upgrade silently breaking the
  parser. (Today, divergence produces an `[ERR]` row — visible but
  not as crisp.)

### Fidelity gaps

- **Visual / paint assertions.** The harness reads selection, focus,
  scroll, but cannot assert paint correctness, caret blink, or
  perceived snappiness. Out of fidelity envelope.
- **IME / composition input.** `nativeType` rejects non-ASCII; no
  `bag.markedText` axis. (Tracked as `AT0012`.)
- **Multi-window scenarios.** `Tug.app` supports multiple windows;
  the harness drives a single WKWebView root per spawn.
- **Trackpad / wheel scroll.** No `nativeScroll` verb. Tests can
  synthesize `wheel` via `evalJS` but those carry `isTrusted: false`.
- **Cross-app drag-and-drop.** No Finder / external-app drop
  fidelity.
- **Native right-click coverage.** `nativeRightClick` exists and is
  wired but no AT scenario exercises it end-to-end.
- **Mouse primitives (`nativeMouseDown` / `Up`) coverage.** No
  scenario uses them directly; covered indirectly via `nativeClick`.
- **Multi-keystroke `holdModifier` thunk path.** Only the
  `nativeKey(key, [mods])` short form is gated in smoke; the
  multi-inner-verb thunk shape lives in the spec but has no smoke
  gate.

### Coverage gaps

- **`registerSelectionBoundary` narrow coverage.** Used only by the
  M23 cross-card path; the full intent of cross-card selection
  isolation isn't exercised under harness conditions.
- **`bindTideSession` no unit gate.** Used by tide AT tests but no
  smoke gate pins the binding semantics in isolation.
- **Banner / bulletin dismissals.** Needs a separate user-prefs
  persistence store. (Tracked as `AT0028`.)
- **Scroll-key audit.** Walk every stateful component for scrollable
  sub-regions. (Tracked as `AT0029`.)
- **Rapid-cadence variants.** Only `AT0001`, `AT0003`, `AT0016` have
  rapid-cadence siblings.
- **Failing-by-design tests for unfired error paths.**
  `CoordinateOutOfBoundsError`, `UnknownKeyError`,
  `TugcodeLaunchError`, `TugcodeVersionSkewError` have no positive
  gate that fires the error path.
- **`app.dumpTraceToFile` content gate.** The helper is wired into
  catch blocks but no test asserts the dumped file's content shape.
- **`app.reset` smoke gate.** Used internally; no positive gate for
  the reset path itself.

### Performance / scale

- **Parallel test execution.** One `App` per file by design;
  test-suite wallclock is sequential. Worth quantifying before any
  parallelization attempt.
- **Live-mode tugcode coverage breadth.** Only `smoke-em-live.test.ts`
  exercises the real Anthropic API; expanding catches tugcode-side
  regressions earlier but costs API credits.

### Naming / cleanup

- ~~**Rename `TUGAPP_IN_APP_TEST` → `TUGAPP_APP_TEST`.** Coordinated
  Swift change; deferred to avoid re-signing churn. See cleanup plan
  [D06].~~ **DONE 2026-04-27** in a follow-on commit; cleanup-plan
  [D06] superseded.
- **`just app-test --json`.** Emit the summary as a JSON sidecar for
  richer programmatic consumption. Not added in this plan because the
  text-format `VERDICT:` line is already deterministic.

---

*Cross-reference:* this document is a sibling to
[`tuglaws/app-test-inventory.md`](../tuglaws/app-test-inventory.md).
When in doubt, the AT-tag inventory is authoritative for *scenarios*;
this file is authoritative for *features*.
