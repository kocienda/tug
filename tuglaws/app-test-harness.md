# The App-Test Harness

*The integration-test harness that drives a real `Tug.app` subprocess via the DEBUG-only `TestHarness` Unix-socket bridge. Why it exists, what it can and cannot assert, the lifecycle model, the trusted-event surface, and how it relates to the macOS code-signing pipeline. Read this before changing the harness, before classifying a new test as smoke vs. scenario, or before claiming a behavior has been "covered" by app-test.*

*Cross-references: `[D##]` → [design-decisions.md](design-decisions.md). `[L##]` → [tuglaws.md](tuglaws.md).*

---

## What the harness is

The app-test harness is a Bun-side test driver that launches `Tug.app` as a subprocess and talks to it over a Unix-domain socket exposed by a DEBUG-only `TestHarness` listener inside the app. From a test author's perspective, it looks like a normal `bun:test` file: import `launchTugApp` from `@/_harness`, call it inside an `async test(...)`, drive gestures and DOM reads through the returned `App` object, close the app in a `finally` block.

What makes the harness interesting is what is on the other end of that socket. It is not a fake DOM, not a headless rendering shim. It is the real `Tug.app` bundle running the real WKWebView, hosting the real tugdeck bundle, executing the real production JavaScript. The harness is the only test surface in the repo that exercises the actual WebKit code paths that ship to users — selection rendering, gesture focus-lock, drag-to-select, double-click word boundaries, modifier-key accelerators, scroll containers, paint timing.

The colocated unit tests under `tugdeck/src/__tests__/` are pure-logic tests (stores, protocol, math, validators) — no DOM. Anything that depends on WebKit's `isTrusted: true` paths, on focus surviving a real gesture, or on the timing of WebKit's gesture focus-lock belongs in app-test.

---

## The trusted-event problem

Most JavaScript test environments synthesize events: `new MouseEvent("click", { ... })`, `dispatchEvent`. Synthesized events have `event.isTrusted === false`. WebKit (and every other browser engine) gates several behaviors on `isTrusted: true`:

- **Default focus on click.** Clicking an element does not move focus to it unless the click is trusted. A synthesized click on `<input>` will fire the click handler but the input will not receive focus.
- **Drag selection.** Mouse-down + mouse-move + mouse-up only initiates a text selection range when the events are trusted.
- **Double-click word selection.** WebKit's word-boundary detection only fires on trusted double-clicks within a tight time window.
- **Modifier-key accelerators.** Cmd+A select-all, Cmd+C copy, Cmd+V paste — the keyboard shortcuts WebKit handles internally — only fire on trusted key events.

A test that synthesizes events lives in a different universe from the user. It can drive `onClick`, but it cannot drive default-focus-on-click. It can dispatch `keydown`, but it cannot drive Cmd+A selection. The harness exists because trusted-event paths are first-class user behavior in tugdeck, and a test surface that cannot drive them cannot prove the app works.

The harness solves this by posting events at the **OS level**, via Swift's `CGEvent.post` ([D02] in `tugplan-in-app-bridge.md`). A `CGEvent` posted from Swift is indistinguishable from a hardware event as far as WebKit is concerned: `isTrusted` is `true`, default-focus runs, drag selection initiates, Cmd+A reaches the selection model. This is the entire reason the harness exists as a subprocess driver instead of an in-process fake-DOM shim.

---

## Lifecycle model: one App per file

Each test file launches its own `App` via `launchTugApp()` and closes it in a `finally` block. Inside a single file, tests may share the `App` if they call `app.reset()` between scenarios — but **no state is shared across files**. This matches the bridge's single-connection contract ([D12] in `tugplan-in-app-bridge.md`) and the regression gate in `harness-smoke/double-connect.test.ts`.

The reasons are not arbitrary:

- **Crash isolation.** One test file's hang or assertion failure does not poison the next. The harness can leave a subprocess in any state — including wedged — and the next file starts from a clean process boot.
- **WKUserScript injection is one-shot.** The script that sets `window.__tugTestMode = true` runs at process start via `WKUserScript`. There is no API to "downgrade" a live WebView back to non-test mode. To get a fresh non-test-mode WebView, you spawn a new app.
- **Per-spawn log files.** Stdout / stderr capture rotates per spawn. Failed-test diagnostics stay scoped to the file that produced them.

Within a single file, prefer `app.reset()` over re-spawning. Reset clears tugdeck state, resets the responder chain, and restores the deck to a known baseline — orders of magnitude faster than a subprocess boot. The pattern matters because some flake patterns surface only when state leaks between scenarios; reset makes that leak detectable.

---

## Fidelity envelope

The harness is a behavioral driver, not a visual renderer. It cannot assert:

- **Caret blink.** WebKit owns the blink timer; the harness has no surface to read paint state.
- **Paint correctness.** The harness reads DOM and computed styles, not rendered pixels. A bug where the right element is in the right position with the right styles but the wrong color is invisible to app-test.
- **Perceived snappiness.** The harness times state transitions, not perceived latency. A 100ms vs. 500ms paint delay is the same to app-test if the underlying state change is symmetric.
- **GPU compositor behavior.** Transform-related bugs that manifest only under hardware acceleration are out of envelope.

What the harness *can* assert is the union of:

- **DOM state.** Element presence, attributes, computed styles, bounds, focus, selection.
- **`__tug` state reads.** Active card, focused card, deck state, EM-card state, deck-trace ring.
- **Trusted gesture outcomes.** Default-focus on click, drag selection range, double-click word boundary, modifier-key behavior.
- **Lifecycle ordering.** When a will/did pair fires, when `onCardActivated` runs, when capture-phase save invariants hold.
- **Subprocess-level guarantees.** Cold-boot persistence, app-reload state restoration, `quitGracefully` flush, cross-process tugbank reads.

When a bug falls outside the envelope, mark the residual as "manual verification required" in the test comment. Do not paper over an out-of-envelope assertion with a weaker proxy — a passing weaker proxy is worse than an honest skip, because the skip surfaces in code review while the proxy hides indefinitely.

---

## The Phase A surface: native gestures, keyboard, introspection

The harness exposes two parallel families of input verbs:

- **Synthesized JS gestures** (`app.click`, `app.type`, `app.focusElement`) — fast, reliable, but `isTrusted: false`. Use these when the assertion is about a JS handler running, not about a WebKit gesture path.
- **Native CGEvent gestures** (`app.nativeClick`, `app.nativeKey`, `app.nativeDrag`, etc.) — backed by Swift's `CGEvent.post` per [D02] + [Q05] in `tugplan-in-app-bridge.md`. These post real OS events that WebKit treats as hardware. Use these when the assertion is about default-focus, selection, or any `isTrusted: true` path.

Native gestures cover single click, double click, right click, drag (endpoint-only), mouse-down / mouse-up primitives, key press with modifiers, and ASCII typing. The `holdModifier(mods, async thunk)` shape lets a test wrap a sequence of inner verbs in a modifier-pressed scope, executed atomically Swift-side so the modifier state cannot drift between the outer test and the inner gesture sequence. Inner verbs inside a `holdModifier` thunk are restricted to native gestures only — `evalJS` / `waitForCondition` / nested `holdModifier` reject. The restriction is intentional: a `holdModifier` block must complete deterministically, and a JS-side wait inside it would let modifier state outlive the intended scope.

Introspection is pure DOM reads. `getElementText`, `getElementValue`, `getElementAttribute`, `getElementBounds`, `getElementState`, `getActiveElement`, `getSelection`, `getComputedStyleValue` — all run via `evalJS` against the live WebView's DOM. None of these post events; they observe.

The procedural details (the typed wrappers' signatures, the worked examples, the `markDeckTrace` pattern) are in [`tests/app-test/README.md`](../tests/app-test/README.md). This document explains why the surface exists and what it costs to extend; the README explains how to use it.

---

## Selection is derived, not remembered

Every app-test launches its own `Tug.app` subprocess, and whole invocations are serialized behind a machine-wide gate. Running the corpus is therefore expensive in the one currency that matters during development — the time between making a change and learning whether it broke something. The cost is why a run must be *selected*, and the selection must be *derived* rather than curated by hand: a hand-maintained "the tests we run" list decays silently, because a test added after the list was written is simply absent from it, and nothing fails to announce that.

So coverage is declared at the test, in the header docblock:

```
 * @covers tugdeck/src/components/lens/
 * @covers tugdeck/src/lib/lens-store/
```

`just app-test-changed` resolves the working diff through those declarations and runs the matching set; `just app-test-covers-check` fails on a test that declares nothing and on a path that no longer resolves. Colocation is the load-bearing property — a declaration that lives next to the test it describes moves when the test moves and is visible in the diff that changes the test, which is what a central manifest cannot offer.

**Whose diff, though.** "The working diff" is the wrong input the moment two sessions share a checkout, which is the normal case here: `git status` is every concurrent session's work at once, so a session that touched one Rust file gets handed the union of everyone's edits and runs tests that neither affect it nor are affected by it. So the selector asks the changes ledger instead — `tugutil changes --json` — and selects from **this session's** classification of the working tree:

- **attributed** — files this session holds a proof row for. Always selected.
- **unattributed** — files no session claims. Selected only when the entry carries a this-session hint (`origin` is not `none`), because an unattributed file with no hint at all is as likely to be the user's own hand-save as anything the session did.
- **foreign** — files another live session holds a proof row for. **Never** selected; they are that session's to test, and pulling them in is precisely the over-broad selection this replaces.

The ledger is an input, not a gate. When it cannot answer — no `TUG_SESSION_ID`, an unresolvable session, no built `tugutil` — the selector falls back to the whole working tree and **says which fallback it took and why**, because a selection that silently changed its own meaning is worse than one that refused. It also refuses to read an empty classification over a dirty tree as a clean tree: that combination is the signature of a `--project` the ledger spelled differently ([L29]), and left unannounced it would select nothing, forever, quietly.

A few paths resist coverage-based scoping and are therefore excluded from it by design: the harness itself (`tests/app-test/_harness/`, `tugapp/Sources/TestHarness/`) and the deck's entry point (`tugdeck/src/main.tsx`, `tugdeck/index.html`). They run before any test's first assertion, so no `@covers` line can bound their blast radius; the selector emits a **core-tier advisory** rather than pretending to a scope it cannot compute. The advisory's answer is the core tier below — a minute of broad smoke — not the full corpus. That list stays deliberately tiny: an ordinary component, however widely mounted, is covered by name, and flagging such components turned the advisory into noise that fired on every substantial diff and read as a standing request to run everything.

**The fan-out has a ratchet.** `MAX_SELECTED` bounds what one selection costs. Alongside it, `ACCEPTED_FANOUT` records the hub paths whose real coupling already outruns `MAX_SELECTED`, and `--check` compares each entry against the same entry in the *committed* file: a number may fall, never rise. Otherwise the edit that widens a hub is the same edit that raises its own ceiling, and the widening never has to be argued. A genuinely wider hub is accepted by deleting the entry and re-adding it — a new key is exempt — so the decision shows up in the diff as a decision rather than as a changed digit.

**Declared surface is not asserted rule.** It is tempting to hunt corpus redundancy by comparing `@covers` sets — a test whose declared surface is a strict subset of another's looks like a duplicate. It is not a usable signal, and a pass over every such pair found nothing to retire. `@covers` answers "which diffs should wake this test," so two tests over one file share a declaration whenever they share a *file*, which says nothing about whether they share a *claim*. What the pairs actually turned out to be, over and over, was a symptom test and a mechanism test on one surface, or two distinct fault classes on one component — and the corpus says so out loud, in docblocks that open by naming the sibling they divide the work with. Redundancy has to be judged from what a test asserts, which means reading it; there is no set operation that stands in for that.

The no-argument `just app-test` is a **curated core tier** of roughly twenty tests — one per load-bearing surface — not a sweep. It answers "does the app still fundamentally work," and its incompleteness is the point: it is a deliberately-chosen sample whose members are listed with a one-line rationale each in the `app-test` recipe. `just app-test-all` is the only command that claims to run everything.

---

## A run is recorded, and a red file arrives with its history {#results-are-recorded}

The runner used to forget everything the moment its shell exited. Every summary it printed — which files were green, against which commit, on which tree — was computed, rendered once, and thrown away. So the question a red file actually raises, *was this already broken before I touched it*, had no cheap answer, and the expensive one is bisection: the `at0417` incident cost roughly thirty-five minutes of reverse-patch probing at about six minutes a cycle to establish a fact that had been true and observable at the end of every prior run.

So the runner remembers. Each run persists what it already computed into `apptest_results.db` — machine-global beside `changes.db`, keyed by the **resolved base checkout** so a dash worktree and the checkout it forked from share one history. That keying is not a detail: the incident lived precisely in that split, with the failing run on a dash and every exonerating run on `main`. History keyed by raw working directory would have answered "no history" at the one moment the answer mattered.

Three properties are doctrine, not implementation.

**The ledger informs; it never gates.** Nothing is re-run, quarantined, skipped, or deprioritized because of what the record says. Selection policy is unchanged, and a known-red file still runs and still fails. The reader decides what the history means; the tool only refuses to withhold it. Recording is telemetry all the way down — a missing binary, an unopenable database, a verb that exits non-zero each produce one named line on stderr and leave the run's verdict and exit code untouched. A test runner that failed because its diagnostics failed would be a worse tool than one that never recorded anything.

**The answer arrives attached to the failure.** A history you have to go ask for is a history nobody asks for, so it is not a query surface — it is a line under the file's name in the `Failures:` section, present on every red file and absent everywhere else. The same object rides the JSON document, formatted from the same lookup, because two renderings of one fact that can disagree eventually will.

**The record says what it actually knows.** An interrupted run leaves no row, so counts are of *recorded* runs and say so in that word rather than implying a completeness they cannot have. A green captured against a dirty tree names a commit whose bytes are not quite what ran, so it is labeled `dirty tree` instead of being flattened into a clean green. And the lookup runs *before* the current run records itself, so a red file's history is what came before it rather than an echo of the failure being asked about. Retention is bounded — the most recent 500 runs per checkout, pruned at record time — because this is diagnostic telemetry whose value is recency, and an unbounded diagnostic ledger is a maintenance task waiting to be forgotten.

The three answers, and what each licenses: **last-green** (the file passed when last recorded — a failure now is new), **red-streak** (already failing, back to a named commit, with the green before it when there is one), **no-history** (never recorded here; says nothing either way).

---

## The accessibility-grant relationship

Posting a `CGEvent` requires `Tug.app` to hold the macOS Accessibility (TCC) grant — System Settings → Privacy & Security → Accessibility, with `Tug.app` toggled on. Without the grant, `CGEvent.post` silently no-ops: every native gesture appears to succeed, but no event reaches the WebView, every assertion fails, and the failure attribution is misleading because the verbs returned `void` rather than throwing.

The harness preflights the grant on every `launchTugApp` call and throws `AccessibilityPermissionMissingError` with actionable guidance (the bundle path / id, the `tccutil reset` recipe for stale grants) when the preflight fails. Protocol-only smoke tests (`harness-smoke/smoke.test.ts`, `double-connect.test.ts`, `log-capture.test.ts`, `wait-for-condition.test.ts`) opt out of the preflight via `skipAccessibilityPreflight: true` so they remain runnable on machines that have not yet completed the one-time grant dance. Scenario tests (`at{NNNN}-*.test.ts`) and `harness-smoke/smoke-native.test.ts` keep the default strict preflight — if the grant is missing, the failure attribution is instant.

The grant is not keyed to the `Tug.app` filename or the bundle id alone. macOS's TCC database keys grants on the bundle's **designated requirement (DR)** — a string composed of the bundle identifier *plus* the leaf hash of the certificate that signed the bundle. Two binaries signed by the same identity share a DR and share a grant; anything that changes the signature invalidates the grant. Xcode's default ad-hoc signing produces a fresh random signature on every `xcodebuild` invocation, which would mean re-granting Accessibility every minute in a tight test-edit loop.

The fix is the `Tug Dev` self-signed identity from the code-signing pipeline. `just build-app` re-signs the bundle with the developer's `Tug Dev` identity after `xcodebuild` completes; `just app-test` re-signs defensively per invocation if the bundle's current DR drifts from the sentinel at `.tugtool/code-sign-fingerprint`. Same identity → same DR → grant persists. The escape hatch `APP_TEST_SKIP_RESIGN=1 just app-test` skips the re-sign for the rare case where the re-sign step itself is what you want to investigate; tests that need `CGEvent.post` will fail under that flag, tests that don't will pass. The deep dive on signing — why self-signed, what invalidates the grant, the DR drift detection mechanism — lives in [code-signing-mac.md](code-signing-mac.md). This document only points there.

---

## Instance isolation — the invariant

An app-test launch, a live interactive instance (`just app-debug`, `just app-release`), and **another worktree's app-test world** must all be **completely disjoint**: a test run can never disturb a developer's running session, and one worktree's run can never disturb (or even reach) another worktree's. Every per-instance resource derives from the runtime identity `TUG_INSTANCE_ID` (the harness mints `apptest-<wtslug>-<uuid>` per launch — the worktree's branch slug rides in the id so the recipe's destructive sweeps can scope to their own worktree; the dev loop uses `debug-main` / `release-main`), and nothing is shared across identities:

| Resource | Keyed on | Where |
|---|---|---|
| App bundle / product name | `TUG_FORCE_BUNDLE_ID` (app-test always `dev.tugtool.app.apptest` → `Tug-apptest.app`) — deliberately the SAME for every worktree, so the one AX grant (keyed on the path-independent designated requirement) covers them all | `product-name-from-cwd.sh`, `bundle-id-from-cwd.sh` |
| Xcode build output (DerivedData) | per-variant `-derivedDataPath` keyed on `PRODUCT_NAME`, **plus the worktree slug for forced-identity builds** (`Tug-apptest-<wtslug>`) — Xcode's *default* DerivedData is shared per-project, so without this, building the app-test bundle would overwrite a live `app-debug` bundle's `.app`, and without the slug one worktree's build/re-sign would clobber the bundle another worktree's run is executing | `derived-data-path.sh` |
| Data dir / tugbank.db / sessions.db / Logs | full `TUG_INSTANCE_ID` | `tugcore::instance` |
| tugbank notify socket, app↔tugcast control socket | **short token** `fnv1a32(id)` (8 hex) — long IDs would overflow `sun_path` (~104 B) | `tugcore::instance::short_token`, `InstanceConfig.shortToken` |
| tugcast HTTP + Vite ports | hash of `TUG_INSTANCE_ID` into a window. **App-test draws from a dedicated window** (tugcast 55400–55499, Vite 55500–55599) disjoint from dev/release (55300/55200) | `tugcore::ports` |
| tmux server | per-instance `tmux -L tug-<short_token>` — a *private daemon*, not a shared server with namespaced sessions | `tugcast::feeds::terminal` |
| Claude / tugcode subprocess | tugcast's own process group (`setpgid` + `kill(0)` on exit) | `tugcast/src/main.rs` |
| **Native input / app activation / key window** | **not divisible** — these are login-session singletons, so they are serialized, not namespaced: the whole `just app-test` invocation runs under `tugutil host gate run --name apptest` | `tugcore::ports::APPTEST_GATE_PORT`, `tug::commands::gate` |
| Repo universe (which checkout dash verbs resolve) | `TUG_REPO_UNIVERSE`, exported by the recipe as the invoking checkout — see below | `tugutil_core::find_repo_root_from` |

### The repo universe: fixtures stay in the checkout under test

A dash verb does not act on the directory you hand it. It resolves a repo root first (`tugdash_core::ops::main_repo_root` → `tugutil_core::find_repo_root_from`), and from a linked worktree that resolution *hops* to the checkout owning the shared `.git` — because a dash's meaning is "a worktree of the checkout that owns it."

Unscoped, that hop puts a run's fixtures in the wrong universe. A fixture dash created from a worktree is created against the base checkout, while the app under test has the worktree open as its project: the lane can never list the dash its own fixture just made, and the run leaves branches, worktrees and dash-log lines in somebody else's checkout. That is why the corpus used to refuse to run from a worktree at all.

`TUG_REPO_UNIVERSE` names the owner instead of letting the hop assume it. The `app-test` recipe exports it as `$(pwd -P)` unconditionally, so it reaches the `bun test` child (every fixture CLI call), the app through `forwardableEnv`'s `TUG*` forwarding, and tugcast by inheritance from the app — one export, the whole chain. Inside that boundary resolution is pinned to the checkout under test; outside it, resolution is untouched, which is what lets a fixture own a scratch repo under the temp dir and land a real join there.

Two properties are worth keeping in mind rather than rediscovering:

- **A universe scopes paths, never refs.** `refs/heads/tugdash/*` is one namespace per repository, shared by every worktree of it. This is precisely why no fixture may cut a dash in the checkout: a run's lane would carry every dash the developer has open, and a test asserting on lane contents would be asserting a fact about whoever ran the suite.
- **A hand-rolled hop is a bug waiting.** Anything that shells `git rev-parse --git-common-dir` to find "the real checkout" is a second implementation of the rule that will not honor the boundary, and the two halves then key their state to different directories — which looks exactly like a feature that silently did nothing. Go through `find_repo_root_from`; the TypeScript mirror is `universeRoot()` in `tests/app-test/dash-fixture.ts`.

The corpus therefore runs from any checkout, worktree or not, and there is no override to set — the refusal and its `TUG_APPTEST_ALLOW_WORKTREE` escape hatch are gone.

### A fixture dash lives in a scratch repository {#fixture-dashes-are-scratch}

**A dash is for implementing a plan, not for running a test.** A dash is a real branch and a real worktree; a fixture that cuts one in the developer's checkout leaves litter in the tree somebody is working in, and a test killed mid-file leaves it there permanently. Fourteen files did exactly that until 2026-08-20, which is why the `app-test` recipe carried a fifty-line janitor sweeping `tugdash/at04??-*` branches and their worktrees before every run.

The rule is now structural, in three places that must stay in agreement:

- **The fixture refuses.** `createDash`, `commitRound`, and `discardDash` in `dash-fixture.ts` throw when the target repo resolves to the checkout under test. There is one constructor for a fixture repository — `makeDashScratchRepo` — and `makeJoinScratchRepo` is built on it, so there is no second implementation to drift.
- **The server hides.** An app-test instance composes no dash entries for the universe checkout (`dashes_hidden_for`, `feeds/changeset.rs`). The `--source-tree` bootstrap makes the checkout a workspace in every instance, so without this the developer's own dashes would still reach a fixture's lane. Session entries are deliberately untouched: the changes-attribution tests compose the checkout's dirt for real.
- **The namespace is swept.** Everything a scratch fixture makes is named `tug-scratch-*` — the repo, its data root, its stub scripts, and the transcript directory its encoded path lands under in `~/.claude/projects`. The recipe removes that namespace from both locations at run start, so a killed run's leftovers never outlive the next invocation.

A scratch repo is invisible to the app until a session is spawned on it: tugcast registers one workspace at startup and every other comes from `spawn_session`, so `bindSession` — a client-side binding the ledger knows nothing about — leaves the repo unregistered and its dashes uncomposed. `seedScratchSession` writes the transcript that `spawnSessionResume` opens. The how-to is in [tests/app-test/README.md](../tests/app-test/README.md#a-fixture-dash-lives-in-a-scratch-repository-never-in-your-checkout).

### Seeding the ledger: reaching a session entry

Per-instance isolation is what makes ledger seeding safe, and seeding is what makes a **session-entry** changeset row reachable at all. A `sessions` row is written by exactly one path in the product — `session_init` arriving from a live tugcode subprocess — and `bindSession` is a client-side binding the ledger knows nothing about, so a test could compose *unattributed* rows and nothing else. Everything hanging off a session entry (the hunk-election checkboxes, the `N of M hunks` badge, per-row Disclaim) sat behind that.

`App.seedLedger({ sessions, file_events })` runs `tugcast --seed-ledger` out of the bundle under test with the launch's own instance environment, so rows are written by the same `SessionLedger` the server uses — real schema, real migrations, real change journal. A hand-mirrored `CREATE TABLE` in the harness would drift the first time the schema moved. The flag refuses any instance id that is not an app-test one, so it cannot reach a developer's ledger even if the environment were wrong.

Three things decide whether a seeded row actually composes:

- **Seed after launch, never before.** tugcast calls `demote_live_to_closed` once at startup — the crash-recovery rule that a `live` row with no running subprocess is stale. A pre-launch seed is exactly that shape, so it is swept before the first compose and its files surface as `orphaned`.
- **`origin` must be proof-class** (`exact` / `replay`). A `bash` or `turn` row is a whole-tree-delta *hint* and never makes a session an owner; the file falls to `unattributed` instead.
- **`at` must post-date the path's liveness cut** (its last commit), and the path must be dirty in git.

The wall this retires was written down as permanent (an earlier decision recorded "no app-test is written for them" and two test docblocks recorded it as unreachable). It was reachable the whole time. When a surface looks untestable, spike the seam before the gap becomes doctrine — the cost of getting this one wrong was two blocking defects nobody had clicked their way into.

### Background is the default; the screen-takers are a declared set

An app-test does not take your machine. The app launches as an accessory (`NSApp.setActivationPolicy(.accessory)`, `open -g`), keyboard events are addressed to its process with `CGEvent.postToPid`, and mouse events are synthesized as `NSEvent`s and dispatched straight into its window — AppKit refuses to route mouse events to an inactive app above the window level, so going through the window is the only way in. A run happens around you while you keep working.

That cannot be made universal, because for a minority of tests activation *is* the subject: app resign / become-active cycles, key-window-gated responder routing, and `document.hasFocus()` — which WebKit ties to *application* activation, not key-window status (an experiment making the window key without activating did not restore it, and broke `at0201`'s activation-click semantics). Those tests pass `foreground: true`, which restores session-tap posting and real activation, and they genuinely take the screen.

**The foreground tier is declared, not inferred.** Each such file carries `@foreground` in its header docblock beside `@covers`, and `just app-test-foreground-check` fails when the tag and the file's actual behavior disagree in either direction. The declaration has to be static because the gate must decide *before* launching anything — a runtime signal arrives after the app already has the screen.

A file takes the screen two ways, and the check knows both. The first is the `foreground: true` launch option. The second is calling an app-lifecycle verb — `simulateAppResign` / `BecomeActive` / `Hide` / `Unhide` — which reaches `NSApp.activate(ignoringOtherApps:)` and a Finder activation inside the app no matter which mode it launched in. Modelling only the launch option let a file seize the screen with no tag on it, so the gate never announced what it was about to do; that is what an undeclared screen-taker feels like from the outside. A lifecycle verb additionally *requires* the launch option: without it the app was never active, `NSApp.deactivate()` is a silent no-op, `didResignActive` never posts, and the verb activates Finder on its way to failing on its 1000ms timeout. The check reports that case separately, because it is both a stolen focus and a broken test.

### `document.hasFocus()` is not a readiness gate

The tier grew to forty files before anyone asked whether forty tests could really need the screen. They could not. Twelve were foreground because they opened with `await app.waitForCondition('document.hasFocus()')` — used as a *boot barrier*, a way to say "the app is up and focus has landed" — and since that predicate can never go true in a background launch, each one had `foreground: true` bolted on to make its own barrier satisfiable. The barrier was self-inflicted: in every case the very next line already waited on the real readiness condition (the rows rendered, the ring landed), so deleting the `hasFocus` wait cost nothing and the tests pass backgrounded, faster. One file carried only the copy-pasted *comment* explaining the foreground launch, with no such wait anywhere in it.

The distinction that actually matters: **app-level keyboard focus works fine in a background window, and only the painted caret needs `document.hasFocus()`.** Keys arrive by `postToPid`, the engine's ring and cursor are DOM state, and CM6 accepts typed input and updates its document — `at0241` types into a CM6 editor and asserts the result with no activation at all. What WebKit withholds from an inactive app is `.cm-focused` and the caret's paint, so a test whose subject is caret *rendering* (`at0048`, `at0049`, `at0254`) genuinely belongs in the tier and a test whose subject is where the ring went does not.

So: never gate on `document.hasFocus()` to mean "ready". Wait on the thing you are about to assert against. Reaching for `foreground: true` to make a wait succeed is a sign the wait is wrong, not that the test needs the screen.

A run containing any of them raises the question in the Session card — over `tugutil host ask` → `POST /api/ask` → an inline dialog → back — and then **runs the background tests while it waits**, saving the screen-takers for last. The run is partitioned, not gated: a test that needs no permission is never blocked by one that does. That distinction is load-bearing rather than cosmetic, and getting it wrong the first time made a bare `just app-test` hold sixteen background files behind a prompt none of them needed.

Two rules about *when*, both learned the hard way:

- The ask is raised **before the invocation gate is taken**, never while holding it — a run waiting on a human must not block every other worktree.
- It is raised **immediately**, not at the moment the first screen-taker is reached. Deferring it puts the dialog on screen minutes later, after the developer has moved on, where a timeout silently means "skipped".

And one about *whether it may wait at all*. **The question is a chance to intervene, not a request for permission**, and it resolves itself: it carries `--unattended run-all`, the dialog counts thirty seconds down in plain sight, and at zero it commits the selected option. An unanswered question therefore runs the screen-takers rather than blocking, because at an empty keyboard there is nobody to disturb and no reason to park the run. The mechanism generalizes — any `tugutil host ask` caller may name the answer silence means — and it earns the right to run unasked by being honest about three things: the countdown commits *the selected option* (so moving the selection to "skip" and walking away skips), touching the selection re-arms the count (so nobody is timed out mid-decision), and the option it will commit is the one it opens preselected (so no control ever rests showing something other than what will happen). Escape still declines at once. `tugcast` answers with the same choice if the deck stops ticking mid-count, so no path leads back to a blocked caller.

`TUG_APPTEST_ASSUME` answers ahead of time for scripted runs and is checked before any work starts. With no instance to ask, the run proceeds after naming the screen-takers on stderr — blocking a terminal-only run that could never have shown a dialog is the worse failure.

### The invocation gate

The lifecycle tests drive `NSApp.activate`/`deactivate`, and foreground-tier gestures still post via `CGEvent.post(tap: .cgSessionEventTap)` — keyboard focus, the frontmost window, and screen-coordinate clicks belong to the *login session*, not to any instance. No amount of per-instance namespacing makes two concurrent **screen-taking** runs safe; serialization is physics. The `app-test` recipe therefore re-execs its entire body under a machine-wide gate: `tugutil host gate run --name apptest --label <wtslug>`.

**That argument covers the `@foreground` tier, and only it.** For a long time the recipe applied it to the whole corpus, which is a different and much more expensive claim — the same shape of mistake as selecting from the whole working tree because one session's diff is hard to isolate. A background test posts its keys with `CGEvent.postToPid(ownPid)` and rebuilds its mouse events as in-process `NSEvent`s; it never activates, never takes the key window, and owns a UUID `TUG_INSTANCE_ID` from which every socket, data dir, tmux session and registry entry derives. Two of them have nothing in common to contend for, which is what `launchTugApp`'s own comment has said all along.

So the runner partitions rather than serializes: **background files run `TUG_APPTEST_JOBS` at a time (default 4), screen-takers strictly one at a time, and the invocation gate still serializes whole runs against each other.** Measured on the core tier: 103s serial → 59s, repeatably, with the same 29/29.

Two things had to move for that to be true, and both are the sort of thing that is invisible until concurrency exists:

- **The straggler reap is prefix-scoped, so it runs between batches and never inside one.** `tugutil host instance stop` over `${TUG_APPTEST_ID_PREFIX}-*` reaches every concurrent file's app as readily as its own; called per-file, the first file to finish SIGTERMs every app still under test. The symptom is a batch of unrelated timeouts with one `exitCode=143` buried in it.
- **Timeout budgets travel with the contention.** Every default budget — the RPC per-method defaults, the launch handshake, bun's own per-test timer — is sized for a file that has the machine to itself. `TUG_APPTEST_TIMEOUT_SCALE` multiplies them by the job count; at 1 it rewrites nothing, so a serial run is byte-identical to what it always was.

**The ceiling is 4, and the thing that sets it is a bug rather than the hardware.** At 6 and above every file fails on its *first* `evalJS` — `evalJS("1 + 1")` included — with "returned a result of an unsupported type". That is the launch handshake reporting ready before the WebView can evaluate: a readiness race whose window is only wide enough to lose under load. Raising `TUG_APPTEST_JOBS` means fixing that race first; the number itself is not the constraint.

The gate is a **localhost port bind** (`tugcore::ports::APPTEST_GATE_PORT`, a well-known port outside every hashed window), not a lock file — this project does not use lock files. Binding is exclusive by kernel construction and the kernel frees the port on any holder death, including SIGKILL, so no stale-lock state can exist. The holder serves a live JSON greeting (`{gate, label, pid, since}`) to every connection; a queued invocation prints `gate 'apptest' held by <worktree> (pid …, since …) — waiting…` and blocks reading that connection until EOF (the holder's exit), then races to re-bind — event-driven, no polling. A non-gate listener on the port fails the greeting handshake and the acquirer errors out instead of waiting. `--no-wait` turns queueing into a fail-fast exit for scripted callers.

Two corollaries that bit us before and must not regress:

- **Kills are identity-checked.** `tugutil host instance stop` and tugcast's `--force` both verify a PID is still the process they registered (by command / registry ownership) before signalling. A PID is recycled the instant its process dies, so a stale registry entry can name a PID the OS has handed to an *unrelated* process — signalling it blind was how an app-test teardown could SIGKILL a live debug instance's child. Never signal a PID you cannot confirm is yours.
- **No *unprobed* cross-instance sweeps.** The rule used to be a blanket ban on reaching into another instance's namespace, resting on the claim that a crash-orphaned socket is "a harmless dead file" that `$TMPDIR` reaps. It is not: a 2026-08-02 audit found **9,833** dead `tugcast-ctl-*.sock` files, 8,765 stray test DBs, 188 orphaned data dirs, and a tmux server that had idled for 20 hours. Per-launch uniqueness is exactly what makes a leak invisible — it never collides, so nothing ever notices it.

  The invariant that replaces the ban is narrower and stronger: **a cross-instance sweep is permitted only when every deletion is gated by a signal a live resource passes.** A `connect()` probe for sockets, a registry lookup for tmux servers and data dirs, PPID 1 for processes — plus a minimum-age floor on everything the registry answers for. `tugcore::janitor` is the one implementation; `tugutil host sweep` and tugcast's startup hook are its only callers.

  What stays banned is what was actually dangerous: **deleting on a name pattern alone.** The one such glob that ever existed (`tugcast-ctl-*.sock`) was unscoped and could reach a live dev instance's socket. Probing dissolves that objection; skipping the probe reinstates it.

  Two things the probes do *not* tell you, both load-bearing:

  - **A saturated live listener is indistinguishable from a corpse.** On macOS an `AF_UNIX` listener whose backlog is full fails `connect()` with `ECONNREFUSED` — the same errno a dead socket file gives, and it appears at backlog+1 connections. Errno discipline (unlink only on `ECONNREFUSED`/`ENOENT`) is necessary but *not sufficient*; the socket pass also skips any name belonging to a live registered instance, and applies the age floor.
  - **The registry is a lagging signal during startup.** `write_bundle_path_marker()` runs near the top of tugcast startup while `registry::register` cannot run until after the port bind, so for a real interval a *booting* instance owns a data dir and a tmux server while matching the orphan signature exactly. Anyone adding a registry-gated deletion must put `MIN_DEBRIS_AGE_SECS` under it.

  The worktree dimension of the old rule still holds for the *live*-process teardown the recipe does (`instance stop` loops scoped to `apptest-<wtslug>-`). But note why the slug scoping could not be the whole story: it is structurally unable to reach a server leaked by a since-deleted worktree, which is how the 20-hour orphan survived.

  Historical note worth keeping, because it is the shape of a whole class of mistake: the *empty* tmux-server reap used to be justified by "the gate guarantees no other app-test run is live during a sweep." That precondition was true while the only caller was the gated recipe. The sweep now also runs from tugcast startup, outside the gate — so the justification evaporated without the rule changing. An inherited rationale that quietly stops applying under a new call site is the most dangerous kind; the age floor is what carries the rule now, unconditionally at every call site.

### Resource lifecycle & reclamation

Isolation is only half the contract; the other half is that nothing *leaks*. The table above keys each resource to an identity — this one tracks who creates it, what reclaims it, and the residual risk. Every entry must have a definite reclaim path; "the OS cleans it up eventually" is only acceptable for kernel-owned resources (ports, fds) bounded by process lifetime.

| Resource | Owner / keyed on | Created | Reclaimed | Residual risk |
|---|---|---|---|---|
| tugcast HTTP port (dev 55300–399 / app-test 55400–499) | tugcast, hashed id + walk-on-collision | `TcpListener::bind` | OS on process exit | None — bounded to process |
| Vite port (dev 55200–299 / app-test 55500–599) | Swift, hashed id | `spawnViteServer` | `ProcessManager.stop()` → `terminate()` + wait | None |
| Notify socket `tugbank-notify-<token>.sock` | tugcast | `bind` at boot | `remove_file` on graceful shutdown (`tugcast/src/main.rs`); crash residue by `tugutil host sweep` (connect-probed, live-namespace and age gated) | Crash → stale file until the next sweep. `$TMPDIR` does **not** reap these — believing it did is how 9,833 accumulated |
| Control socket `tugcast-ctl-<token>.sock` | tugcast (path from Swift) | `bind` | ProcessManager unlink on close; crash residue by `tugutil host sweep` | Same as notify socket |
| **tmux server** `tug-<token>` (daemon — *outside* any process group) | tugcast (`-L`) | first `tmux` call in the terminal feed | app-test: self-reap on shutdown (`main.rs`, gated on `apptest-` id); dev/release: `tugutil host instance remove`/`prune` and `dash join`/`release` (`reap_instance_tmux`); `tugutil host sweep` at both ends of the recipe and at dev/release startup | Covered on every managed path; the sweep is registry-anchored rather than slug-scoped, so it reaches orphans a deleted worktree left behind |
| tmux session `cc-<id>` | terminal feed | `ensure_session` | dies with its server | Bounded to server |
| PTY master/slave + `tmux attach` child | terminal feed | `pty_process::open()` + `spawn(pts)` | split halves drop on cancel → SIGHUP detaches the attach child; else `kill(-pgid)` | Self-reaps via hangup + process group. Bounded to tugcast |
| tugcode / claude subprocess | agent_bridge | per session | tugcast `kill(0)` on exit / ProcessManager `kill(-pgid)` SIGTERM→SIGKILL | In tugcast's process group → reaped |
| Registry entry (`$TMPDIR/tug-instances.json`) | tugcast | `register` at boot | `unregister` on shutdown; dead entries pruned on next register/load | Self-healing |
| Gate port (`APPTEST_GATE_PORT`, 55600) | `tugutil host gate` holder | `TcpListener::bind` at invocation start | OS on process exit — including SIGKILL (`FD_CLOEXEC` keeps gated children from inheriting it) | None — bounded to process |
| Per-worktree app-test DerivedData (`Tug-apptest-<wtslug>`) | `just build-app` (forced identity) | first app-test build in a worktree | **nothing automatic** — `just clean-all`'s `Tug-*` glob, or manual `rm` | The known leak: a dash that ran app-test leaves a DerivedData tree behind after `dash join`/`release`. Disk, not correctness. Deliberately outside the janitor: it is build output, not runtime debris, and no probe or registry entry can say whether an Xcode build is mid-flight |
| Instance data dir (`instances/<id>/`) | tugcast | `write_bundle_path_marker` + tugbank/sessions/Logs at boot | harness `wrappedKill` → `instance remove --data-only`; app-test residue by `tugutil host sweep` (registry + marker + age gated); bundle-missing dirs by `tugutil host instance prune` | SIGKILL or a launch failure skips the harness path; the sweep is the backstop. Dev/release dirs with an intact bundle are never candidates |
| `$TMPDIR` test artifacts (`tugcast-test-changes-*`, `tugapp-test-tugbank-*`, `tug-scratch-*`, …) | the tests that mint them | per test / per spawn | the creator's own teardown (TempDir drop, `rmTempTugbank`, `testTmpDir`), then `tugutil host sweep` at 24 h for anything a SIGKILLed runner left | Every prefix must be registered in `tugcore::janitor::TMP_PREFIXES` — `no_unregistered_tmp_prefixes` fails the build otherwise, so a new debris class cannot be invented unswept |
| Screenshots (`tugapp-screenshot-*.png`) | Swift `TestHarnessConnection` | `app.screenshot()` | harness unlinks at `App.close()` and at run end; `TUGAPP_KEEP_SCREENSHOTS=1` opts out | Swift wrote them and nobody deleted them — 121 MB had accumulated |

The process tree is the backbone: tugcast calls `setpgid(0, 0)` at startup so it leads its own group, and **both** exit paths reap the whole group — tugcast's own `kill(0)` on graceful shutdown and ProcessManager's `kill(-pgid)` (SIGTERM, then SIGKILL after 200 ms) on app teardown. That single mechanism reclaims tugcode, claude, and the `tmux attach` child. Vite is reaped separately and explicitly (it is a child of the GUI app, not of tugcast's group). The one daemon that escapes the process group is the tmux *server* — which is exactly why it carries explicit reaping rather than relying on signal propagation.

**Identity-checked kills.** `tugutil host instance stop`, tugcast's `--force`, and the janitor's reparented-process sweep all confirm a PID is still the process they registered (command match / registry ownership) before signalling. A PID is recycled the instant its process dies, so signalling a stale registry PID blind once let an app-test teardown SIGKILL a live debug instance's child. Never signal a PID you cannot confirm is yours.

**Known limitations (bounded, recorded — not open leaks):**

- **Token collision.** `tug-<token>` and the sockets key on a 32-bit FNV hash of the id; two instances colliding would share a tmux server / sockets and break isolation. ~1 in 4 billion per pair — negligible for the handful of live instances, but the ceiling is real.
- **Out-of-band worktree deletion.** A worktree removed by hand (`git worktree remove`, `rm -rf`) instead of `dash join`/`release` or `instance remove` orphans its tmux server. This is now reclaimed automatically: `tugutil host sweep` runs at both ends of every app-test invocation and on every dev/release tugcast startup, so merely using Tug keeps the machine clean. `just reap` survives as the on-demand front end to the same code (`just reap` to diagnose, `just reap apply` to release) — it is no longer a hand-written shell janitor, and there is deliberately only one implementation, since two would drift. Orphaned data dirs whose *bundle* is gone still go through `tugutil host instance prune`, which can delete a (possibly shared) app bundle and so must be run on purpose.
- **`--force` is vestigial for app-test.** Each launch mints a fresh `apptest-<wtslug>-<uuid>`, so there is never a same-id zombie to reclaim and `force_kill_port_holder` early-returns. Harmless; the flag could be dropped from the app-test launch.

---

## Smoke vs. scenario classification

Two test categories live under `tests/app-test/`:

### `harness-smoke/<name>.test.ts` — primitive gates

Smoke tests pin a single harness primitive: RPC handshake, evalJS error translation, native CGEvent click round-trip, app-reload, cold-boot / `quitGracefully`, capture-phase save invariant. They exist so a primitive regression can be diagnosed without the attribution being conflated with a scenario regression. If `smoke.test.ts` fails, the bridge transport is broken; if `at0001-tab-switch-fc.test.ts` fails *and* `smoke.test.ts` passes, the bug is in the scenario path, not the harness.

Smoke tests are not numbered. The filename describes what the gate asserts. Add a smoke test only when (a) it pins a harness primitive that AT scenarios depend on, AND (b) failure attribution would be muddled without a separate gate. A smoke test for behavior already covered by a scenario adds noise without diagnostic value.

### `at{NNNN}-<slug>.test.ts` — AT-numbered scenarios

The `at{NNNN}` prefix is a stable unique id, nothing more. Allocate the next free number by looking at the directory — `ls tests/app-test/at* | tail -1` — and name the file. The number never changes once assigned and is never reused, so a test can be cited durably from a commit message or a plan doc; the slug after it can be re-edited freely as the test's framing evolves.

There is deliberately **no central registry of AT numbers.** There was one — `tuglaws/app-test-inventory.md`, a catalog that every test was supposed to be registered in before it was written. Nothing checked it, so it drifted: by the time it was retired (2026-08-11) it had stopped tracking new tags around AT0181, leaving a majority of the live suite unlisted, while still carrying entries for tests that had been deleted. A registry that no tooling reads is a second copy of the truth that decays silently, and reconciling it costs more than it ever repaid. The directory listing is the registry.

What a test *is for* belongs in the test, not in a catalog beside it: the header docblock states the case, and `@covers` states the source it gates — and `@covers` is machine-checked by `just app-test-covers-check`, which is why it has not drifted.

A consequence worth stating plainly: numbers may collide, and several do (`at0335-` prefixes three unrelated tests today). A collision is untidy, not broken — the filename is the identity as far as every tool is concerned. Prefer a fresh number, but do not renumber an existing file to resolve one; the citation stability is worth more than the tidiness.

---

## Files

Primary canonical authority — the harness JS surface.

- [`tests/app-test/_harness/index.ts`](../tests/app-test/_harness/index.ts) — `launchTugApp`, the `App` class with all typed wrappers (`click`, `type`, `focusElement`, `reset`, `seedDeckState`, `nativeClick`, `nativeKey`, `nativeDrag`, `holdModifier`, `appReload`, `quitGracefully`, `startTugcode` / `stopTugcode`, deck-trace verbs). `EXPECTED_SURFACE_VERSION` lives here.
- [`tests/app-test/_harness/client.ts`](../tests/app-test/_harness/client.ts) — Unix-socket transport. Single-connection guarantee per [D12].
- [`tests/app-test/_harness/rpc.ts`](../tests/app-test/_harness/rpc.ts) — Length-prefixed JSON RPC framing and request / response correlation.
- [`tests/app-test/_harness/errors.ts`](../tests/app-test/_harness/errors.ts) — Typed error hierarchy. `AccessibilityPermissionMissingError`, `NativeTypeAsciiOnlyError`, etc.
- [`tests/app-test/_harness/matchers.ts`](../tests/app-test/_harness/matchers.ts) — `toContainOrderedSubset` partial-ordered-subset matcher; `registerSubsetMatcher()`.
- [`tests/app-test/_harness/types.ts`](../tests/app-test/_harness/types.ts) — Surface types shared between Bun-side and Swift-side JSON shapes.

Swift-side bridge — the in-app responder.

- [`tugapp/Sources/TestHarness/TestHarnessListener.swift`](../tugapp/Sources/TestHarness/TestHarnessListener.swift) — Unix-socket listener. DEBUG-only.
- [`tugapp/Sources/TestHarness/TestHarnessConnection.swift`](../tugapp/Sources/TestHarness/TestHarnessConnection.swift) — Per-connection request handler. `surfaceVersion` constant for the version handshake.
- [`tugapp/Sources/TestHarness/TestHarnessBridge.swift`](../tugapp/Sources/TestHarness/TestHarnessBridge.swift) — Bridge between socket RPC and the app's responder chain / WKWebView / native gesture surface.
- [`tugapp/Sources/TestHarness/TestHarnessUserScript.swift`](../tugapp/Sources/TestHarness/TestHarnessUserScript.swift) — `WKUserScript` injecting `window.__tugTestMode = true` at WebView boot.

Build / signing pipeline.

- [`Justfile`](../Justfile) — `just app-test`, `just build-app`, `just setup-dev-signing`, the `APP_TEST_SKIP_RESIGN=1` opt-out path.
- [`scripts/setup-dev-signing.sh`](../scripts/setup-dev-signing.sh) — One-shot machine setup for the `Tug Dev` identity.
- `.tugtool/code-sign-fingerprint` — DR sentinel; regenerated by `just build-app`, read by `just app-test`.

The results ledger.

- [`tugrust/crates/tugutil-core/src/apptest_ledger.rs`](../tugrust/crates/tugutil-core/src/apptest_ledger.rs) — schema, base-root resolution, `record_run`, `file_history`'s three answers, and the retention constant.
- [`tugrust/crates/tugutil/src/apptest.rs`](../tugrust/crates/tugutil/src/apptest.rs) — the `tugutil apptest record|history` verbs, the recipe's only way in.

Procedural reference for test authors.

- [`tests/app-test/README.md`](../tests/app-test/README.md) — Running, environment variables, adding a new test, lint, directory layout. The architecture moved here; the README is procedure.

---

## Cross-Links

- [code-signing-mac.md](code-signing-mac.md) — The signing pipeline that keeps the AX grant stable across rebuilds. The harness depends on it transitively for every native-gesture test.
- [tuglaws.md](tuglaws.md) — [L11] (responder chain — the action paths the harness exercises end-to-end), [L23] (state preservation across bookkeeping — the contract `harness-smoke/smoke-capture-phase-save.test.ts` gates).
- [state-preservation.md](state-preservation.md) — The [A9] protocol whose capture-phase invariant is gated by `harness-smoke/smoke-capture-phase-save.test.ts`.
- [lifecycle-delegates.md](lifecycle-delegates.md) — The deck-level event pipe whose ordering is exercised by AT0008 / AT0019 and the cross-card scenarios.
