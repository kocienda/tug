# `tests/app-test/`

Procedural reference for test authors working in `tests/app-test/`.

For the harness **architecture** — what it is, the trusted-event problem, lifecycle model, fidelity envelope, native-gesture rationale, accessibility-grant relationship, smoke vs. scenario classification — see [`tuglaws/app-test-harness.md`](../../tuglaws/app-test-harness.md). This README covers the procedural test-author workflow only.

**Related docs:**

- [`tuglaws/app-test-harness.md`](../../tuglaws/app-test-harness.md) —
  harness architecture reference. Read first if anything in this README
  feels under-explained.
- [`tuglaws/code-signing-mac.md`](../../tuglaws/code-signing-mac.md) —
  the Apple Developer ID signing pipeline that keeps the macOS
  Accessibility grant stable across rebuilds. Read this when AX is
  broken.
- [`roadmap/tugplan-in-app-bridge.md`](../../roadmap/tugplan-in-app-bridge.md)
  — design rationale, decisions ([D01]–[D14]), and transport / boot
  choreography.
- [`roadmap/tugplan-harness-extensions.md`](../../roadmap/tugplan-harness-extensions.md)
  — Phase A native-event family (CGEvent-backed gestures, keyboard,
  app-lifecycle), tugcode subprocess control.
- [`roadmap/tugplan-app-test-cleanup.md`](../../roadmap/tugplan-app-test-cleanup.md)
  — the 2026-04-27 cleanup that produced the current naming.

## Running

```bash
# 1. One-time per machine: verify the Developer ID Application cert
#    is installed (via Xcode → Settings → Accounts → Manage Certificates).
just setup-dev-signing

# 2. Build (and re-sign) Tug.app + Rust binaries + tugdeck dist.
#    Re-run only when Swift / Rust sources change.
just build-app

# 3. Run the tests that cover what you changed. This is the everyday command.
just app-test-changed

# The ~20-test core tier — one test per load-bearing surface:
just app-test

# Run a single file:
just app-test at0001-tab-switch-fc.test.ts
just app-test harness-smoke/smoke.test.ts

# Run a list of specific files in order:
just app-test harness-smoke/smoke.test.ts at0003-pane-activation.test.ts

# Every test file. Slow — one Tug.app launch per file.
just app-test-all
```

### Choosing what to run

Running everything is almost never the right move: each file launches its own `Tug.app` subprocess, and the whole suite is serialized behind a machine-wide gate. Selection is derived, not guessed — every test declares the source it exercises in its header docblock:

```ts
/**
 * at0240-lens-focus-grammar.test.ts — ...prose...
 *
 * @covers tugdeck/src/components/lens/
 * @covers tugdeck/src/lib/lens-store/
 */
```

A `@covers` value is a repo-relative path (a trailing `/` means the whole subtree) or a glob. `just app-test-changed` reads the changed files out of `git status`, resolves them through those declarations, prints which changed file pulled in each test, and runs exactly that set. Prefer **generous** globs — a directory over a single file — so a rename inside the subsystem doesn't silently drop coverage.

| Command | What it runs |
|---|---|
| `just app-test-changed [paths…]` | The tests whose `@covers` match your working diff (or the given paths) |
| `just app-test-select [paths…]` | Same selection, printed but not run |
| `just app-test` | The ~20-test core tier (defined in the `app-test` recipe) |
| `just app-test <files…>` | Exactly the named files |
| `just app-test-all` | Every test file |
| `just app-test-covers-check` | Lint: every test declares `@covers`, and every path resolves |
| `just app-test-foreground-check` | Lint: `@foreground` matches which tests actually take the screen |

A few paths `@covers` cannot scope, because they run before any test's first assertion: `tests/app-test/_harness/`, `tugapp/Sources/TestHarness/`, `tugdeck/src/main.tsx`, `tugdeck/index.html`. The selector prints a **CORE TIER ADVISED** advisory when it sees one changed, and the answer is `just app-test` — the ~20-file core tier, which is what "did I break everything?" actually asks. The list is deliberately tiny: ordinary components, however widely used, are covered by name and do not trip it.

### `@foreground` — the tests that take over the screen

App-tests run in the **background**. The app launches as an accessory, keyboard events go to its process and mouse events straight into its window, and you keep working while a run happens around you.

A minority cannot work that way, because activation *is* their subject: app resign / become-active cycles, key-window-gated responder routing, `document.hasFocus()`. Those launch with `foreground: true`, which puts the app back in the activating event mode — and they really do take the screen out from under you. Each one declares itself with `@foreground` on its own docblock line, beside `@covers`:

```ts
/**
 * at0145-permission-dialog-keyboard.test.ts — …
 *
 * @foreground
 * @covers tugdeck/src/components/tugways/chrome/session-permission-dialog.tsx
 */
```

When a run contains any of them, `just app-test` raises the question in the Session card straight away — and then **gets on with the background tests while you decide.** The screen-takers are ordered last, so by the time the answer matters it is usually already in. Nothing that needed no permission ever waits on something that did. Declining skips them; the background run happened either way, and every skipped file shows as a `SKIP` row in the summary.

**The question counts down and then runs them.** It is a chance to intervene, not a request for permission: the dialog shows thirty seconds ticking (`TUG_APPTEST_COUNTDOWN` overrides the duration), commits whatever option is selected when it reaches zero, and re-arms the count each time you move the selection so you are never timed out mid-decision. Escape says no immediately. Nobody at the keyboard means nobody to disturb — the run should proceed, not sit parked in a dialog until you come back to it.

`TUG_APPTEST_ASSUME=all|background|cancel` answers ahead of time; scripted and non-interactive runs should set it. With no Tug instance to ask, a run proceeds after naming the tests that will take the screen — blocking a terminal-only run that could never have shown a dialog is worse than an unannounced one you started by hand.

`just app-test-foreground-check` holds the declaration honest in both directions. A foreground launch with no tag would seize the screen unannounced, which is the real harm; a tag with no such launch would prompt about a test that was never disruptive.

The check reads the launch option statically, so anything that is not literally `foreground: false` counts as a screen-taker. A computed flag (`foreground: SOAK_SECS === 0`) cannot be resolved by reading the file, and the safe reading of "it might take the screen" is to declare it.

`just app-test` ends every run with a structured summary block whose
last stdout line is exactly `VERDICT: PASS  (...)` or `VERDICT: FAIL
(...)`. Recipe exit code matches the verdict — 0 iff PASS. To check
pass/fail programmatically:

```bash
just app-test 2>/dev/null | tail -n 1   # → VERDICT: PASS  (47/47 ...)
```

The summary also lists every file with `[PASS]` / `[FAIL]` / `[SKIP]`
/ `[ERR]` and per-file `(passed/total)` counts, plus a `Failures:`
block when any file fails. See
[`roadmap/tugplan-app-test-cleanup.md#s01-summary-format`](../../roadmap/tugplan-app-test-cleanup.md#s01-summary-format)
for the contract.

### Concurrency: one invocation at a time

Whole `just app-test` invocations are serialized machine-wide by a
port gate (`tugutil host gate run --name apptest`): native CGEvent input
and app activation are login-session singletons, so only one run may
drive them at a time. Invoking `just app-test` while another worktree
(or another terminal) holds the gate prints

```
gate 'apptest' held by <worktree-slug> (pid <pid>, since <iso8601>) — waiting…
```

and queues until the holder finishes — nothing is killed, both runs
complete. The wait is event-driven (the gate releases the moment the
holder exits, even on SIGKILL). For scripted callers that prefer
fail-fast over queueing:

```bash
tugrust/target/debug/tugutil gate run --name apptest --no-wait -- true
# exit 2 + holder info when held (JSON shape with --json)
```

Each worktree's run is otherwise fully isolated: its own
`Tug-apptest.app` bundle (per-worktree DerivedData, same bundle id —
the one AX grant covers all of them), and `apptest-<wtslug>-<uuid>`
instance ids whose cleanup sweeps match only that worktree's prefix.

### Running from a worktree

The corpus runs from whatever checkout you invoke it in — a dash
worktree included. Nothing to set: the recipe exports
`TUG_REPO_UNIVERSE="$(pwd -P)"`, which is the boundary
`tugutil_core::find_repo_root_from` resolves dash verbs inside, so a
fixture dash is born, listed, joined and torn down in the checkout under
test rather than in the one that owns the shared `.git`. The doctrine is
in [tuglaws/app-test-harness.md](../../tuglaws/app-test-harness.md#the-repo-universe-fixtures-stay-in-the-checkout-under-test).

### A fixture dash lives in a scratch repository, never in your checkout

**A dash is for implementing a plan, not for running a test.** A fixture
never cuts one in the checkout you are working in — `createDash`,
`commitRound`, and `discardDash` all refuse the attempt with a message
naming this rule. Every dash fixture builds a repository of its own:

```ts
scratch = makeDashScratchRepo({ prefix: "at0999", checkout: CHECKOUT });
createDash(scratch.repo, DASH, "at0999 fixture", scratch.cli);
fixtureDir = seedScratchSession(scratch.repo, SID);   // uuid-shaped SID
// afterAll:
rmDashScratchRepo(scratch);
rmScratchSession(fixtureDir);
```

Four things to know:

- **Spread `scratch.cli` into every fixture call.** It carries
  `binaryRoot` (the CLI comes from the checkout under test, which is the
  only tree with a build) and the `TUG_DATA_DIR` redirect (dash state,
  journals and drafts land beside the scratch repo, not in your live data
  root).
- **A scratch repo is invisible until a session is spawned on it.**
  tugcast registers exactly one workspace at startup — the
  `--source-tree` bootstrap, which is your checkout, because that is also
  where `tugdeck/dist` is served from. Every other workspace comes from
  `spawn_session`. So `app.bindSession(...)` is not enough: seed a
  transcript with `seedScratchSession` and open the card with
  `app.spawnSessionResume("A", { tugSessionId: SID, projectDir: scratch.repo })`.
  Pass the launch `TUG_DATA_DIR: scratch.dataRoot`, and leave
  `sourceTreePath` on the checkout.
- **The session id must be a UUID.** `claude --resume` refuses anything
  else, and the failure surfaces far from its cause (the composer's
  selector matches no element, because the card fell back to the
  picker). `seedScratchSession` refuses a non-UUID up front.
- **An app-test instance never sees the checkout's dashes.** The feed
  hides them (`dashes_hidden_for` in `feeds/changeset.rs`), so a test can
  assert on a lane's exact contents instead of on whatever you happen to
  have open. Session entries are untouched — the changes-attribution
  tests really do compose the checkout's dirt.

`--base` still comes from the project the dash is cut in, not from
`main`: `createDash` derives it from the branch that project has out.

Everything a scratch fixture makes carries the `tug-scratch-` prefix — the
repo, its data root, its stub scripts, and the transcript directory under
`~/.claude/projects` — and the recipe sweeps that namespace at the start
of every run, so a test killed before its teardown leaves nothing behind.
`at0426` is the worked example for a join arc; `at0421` for a plain
dash-UI one.

## Environment variables

| Variable                  | Purpose                                                      |
|---------------------------|--------------------------------------------------------------|
| `TUGAPP_APP_TEST=1`    | Enables the `describe.skipIf(!SHOULD_RUN)` gate. Set by the just-recipe; tests should never set it themselves. |
| `TUGAPP_DEBUG_PATH`       | Absolute path to the debug `Tug.app` binary. Set by the just-recipe via xcodebuild's settings query. |
| `TUGAPP_TUGCODE_BINARY`   | Absolute path to the bun-compiled `tugcode` binary. Used by EM-card / live-mode tests. |
| `TUGAPP_TUGBANK_BINARY`   | Absolute path to the `tugbank` CLI. Used by cold-boot disk-side reads in `_harness/tugbank-helpers.ts`. |
| `TUGAPP_TEST_SOCKET`      | Reserved; set by the harness when spawning the subprocess.   |
| `TUGCODE_LIVE=1`          | Opt-in for live-mode tugcode smoke (`harness-smoke/smoke-em-live.test.ts`); requires Anthropic credentials. Skipped by default. |
| `APP_TEST_SKIP_RESIGN=1`  | Bypass the defensive re-sign in `just app-test`. Tests that need `CGEvent.post` will fail; tests that don't will pass. Diagnostic-only — see `tuglaws/code-signing-mac.md`. |
| `TUG_APPTEST_STREAM=1`    | Print each file's raw `bun test` body as it runs. Off by default — see "Reading the output" below. |
| `TUG_APPTEST_JSON=<path>` | Also write the run's results as a JSON document to `<path>`. Stdout is byte-identical either way. |
| `TUG_REPO_UNIVERSE`       | The checkout dash verbs resolve inside. Exported by the recipe as the invoking checkout; a test should read it through `universeRoot()` rather than setting it. |

### Reading the output

**`just app-test` is quiet by default.** It prints the `APP-TEST SUMMARY` block and nothing else — no per-file `bun test` stream. The summary is meant to be complete enough that you never pipe it through `grep` or truncate it with `head`:

- **`Per-file results:`** — every file's status and test counts.
- **`Diagnostics:`** — whatever the tests reported with `note()`, printed for **passing** files as well as failing ones. This is where a probe value belongs; a green run is usually where you want to read one.
- **`Failures:`** — per failing test, the title, the first assertion or error block (the `Expected:`/`Received:`/`TimeoutError:` text), and a `file:line` locator. Repeated identical errors are not reprinted.

Set `TUG_APPTEST_STREAM=1` to get the full raw output back — it is an environment variable rather than a flag because the recipe re-execs itself under the host gate and its arguments are files-only.

To report a value from inside a test, import `note` from the harness:

```ts
import { note } from "../_harness";

note("ROWHEIGHT", await app.evalJS<number>("…"));
```

It prints one `TUG-NOTE:` sentinel line the recipe collects into the `Diagnostics:` section and the JSON document's per-file `notes` array. Prefer it to `console.log`, which is only visible under `TUG_APPTEST_STREAM=1`.

For a machine-readable result, set `TUG_APPTEST_JSON=/tmp/run.json`:

```json
{ "sweep": "core", "wallSeconds": 118, "verdict": "FAIL",
  "totals": { "filesRun": 20, "filesPassed": 19, "filesFailed": 1, "testsPassed": 38, "testsTotal": 39 },
  "files": [ { "file": "at0145-….test.ts", "status": "FAIL", "passed": 0, "total": 1,
               "failures": [ { "title": "…", "message": "…", "location": "at0145-….test.ts:118" } ],
               "notes": [ { "label": "SURFACE", "value": "1.8.0" } ] } ] }
```

Both renderings are serialized from the same arrays in one pass, so the document and the printed summary cannot disagree.

Per-run log files are written under `tests/app-test/logs/` when a
test passes `testName` to `launchTugApp`; the directory is gitignored.

## Live-mode tugcode smoke

`tests/app-test/harness-smoke/smoke-em-live.test.ts` exercises a real
tugcode → Claude Code → Anthropic API round-trip. Because it consumes
API credits and requires live credentials, it is double-gated behind
`TUGCODE_LIVE=1` and stays out of the default `just app-test` sweep.

```bash
# Anthropic credentials must already be set (ANTHROPIC_API_KEY or
# `claude login`'s persisted creds).
TUGCODE_LIVE=1 just app-test harness-smoke/smoke-em-live.test.ts
```

The test sends a single deterministic prompt ("Reply with the single
word: ack.") so token cost stays in single digits per run. First-token
latency is allowed up to 20s for cold-start claude; full-turn up to
60s. Failure surfaces the last 50 lines of tugcode's stdout/stderr to
stderr.

## The join fixtures, and why none of them runs a model

A conflicted dash join is finished by an agent: it reconciles the merge in a
workshop worktree, audits what the algorithmic rungs decided, may ask one
intent question, and reports. Four fixtures press that arc — `at0426` (the
audit), `at0436` (a join pressed for real), `at0442` (the escalation),
`at0443` (a red verdict and the override past it) — and **none of them spawns
a model.** Three seams make that possible, and a new join fixture should use
all three.

**The resolver is scripted.** `git config tugdash.joinresolver <script>` in the
fixture's repo makes tugcast run that command instead of `claude`. It speaks the
same two terminal shapes the real spawn does — one JSON line per user message in
on stdin, one per terminal turn out on stdout, either `{"ask":{…}}` or the
report — so the orchestrator's parse-and-wait path is the identical one. A few
lines of `sh` can play any resolver behavior: resolve-and-report, ask-then-
resolve, never-repair, report-nothing. This is the `tugdash.mergedriver` stub
pattern one rung up. **Without a stub the seam does not fall back to a model —
it refuses**, which is what keeps a stray fixture from quietly spending a
minute of API time.

**Verification is declared, and Tier 1 is deliberately absent.** A fixture repo
writes `.tugtool/config.toml` with `[tugtool.dash] verify_tier0 = [...]` and
**no `verify_tier1`**. Tier 0 is a sentinel grep — seconds cheap, needs no
toolchain, and able to go genuinely red, which is what `at0443` requires. Tier 1
is omitted because a fixture join runs *inside* an app-test invocation that
already holds the machine-wide `apptest` gate: a real tier-1 command would spawn
app-tests that queue on the gate their own run is holding, and the join would
hang until something timed out. A project that declares no tier is green with a
note, which is the posture a fixture wants.

**The repository is the fixture's own.** `makeJoinScratchRepo` in
`dash-fixture.ts` builds one — on top of `makeDashScratchRepo`, the same
constructor every dash fixture uses, so there is one implementation of "a repo
Tug can open" — adding one genuine conflict, the declared Tier 0, and the stub
scripts to the base repo's `git init`, `.tugtool/` marker and redirected
`TUG_DATA_DIR`. Owning the repository is what lets these arcs run all the way
through a join — a successful join squashes onto the base branch **in that
branch's live working tree**, which for the checkout would be the developer's
own `main`. `rmJoinScratchRepo` deletes the lot.

Owning it is also what makes a fixture *safe*, and that is the newer half. Every
join rides a candidate now, so **opening join mode resolves the dash and runs
the project's declared checks over what that built** — a clean dash included.
Aimed at the developer's checkout, that is the corpus building itself on the way
to a button press. Any test that enters join mode belongs on a scratch repo with
a cheap Tier 0, which is why `at0435` and `at0436` moved onto one.

Two options shape what the fixture builds:

- **`cleanMerge: true`** puts the base's rewrite in a file of its own, so the
  squash has nothing to reconcile. The clean join is its own arc rather than the
  absence of one: it resolves, anchors a candidate, and gets a verdict.
- **A slow resolver stub** — `read -r _charter; sleep 15; …` — is how `at0444`
  holds a run silent past the twelve-second deadline the client used to enforce.
  Nothing is emitted during the sleep, on purpose: the point is that a run which
  cannot speak is still a run, and only the server can say otherwise.

## Selectors that mirror the product

Product strings and ids a test queries — an `aria-label`, a dialog island class,
a focus-engine mark — live in [`_harness/selectors.ts`](_harness/selectors.ts),
not inline in each test. A rename in the product otherwise goes undetected:
`querySelector` keeps parsing and keeps returning `null`, so the failure reads
as a behavior regression in whatever the test was actually checking. Renaming
one `aria-label` broke seven files that way.

`selectors.ts` also carries `keyboardIsInCard(cardId)`, the engine-fact form of
"the keyboard is here." Under the focus engine, `document.activeElement` parks
on the key sink **outside** every card whenever the route is `engine-routed`, so
card containment of the active element is not a test for keyboard location — it
is a test for a `dom-granted` text surface specifically. Assert engine facts
(`getFocusedCardId()`, `[data-key-view]`, `[data-first-responder]`); reach for
`document.activeElement` only where a grant is the thing under test, and say so
in a comment.

## Adding a new test

Canonical test shape:

```ts
import { describe, expect, test } from "bun:test";
import { launchTugApp } from "@/_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

describe.skipIf(!SHOULD_RUN)("my scenario", () => {
  test("does the thing", async () => {
    const app = await launchTugApp({ testName: "my-scenario" });
    try {
      await app.seedDeckState({ /* ... */ });
      await app.click({ selector: "[data-card-id='a']" });
      const focused = await app.getFocused();
      expect(focused?.cardId).toBe("a");
    } finally {
      await app.close();
    }
  });
});
```

Step-by-step:

1. **Decide: smoke or scenario?** See
   [`tuglaws/app-test-harness.md`](../../tuglaws/app-test-harness.md)
   for the classification rule. For a scenario, take the next free
   `AT{NNNN}` straight from the directory — `ls at* | tail -1` — and
   name the file. There is no registry to update first; the number is
   a stable id, and what the test is for goes in its header docblock.

2. **Name the file.**
   - Scenario: `tests/app-test/at{NNNN}-<slug>.test.ts`.
   - Smoke: `tests/app-test/harness-smoke/<descriptive>.test.ts`.

3. **Declare `@covers` in the header docblock.** One line per source path
   or glob the test exercises, at the end of the docblock. Without it the
   test can never be selected by `just app-test-changed` — it silently
   stops guarding its surface, which is exactly the drift that produced a
   stale hand-maintained run list. `just app-test-covers-check` fails on a
   missing declaration and on a path that no longer resolves.

4. **Gate on `TUGAPP_APP_TEST=1`.** Use
   `describe.skipIf(!SHOULD_RUN)` at the top of every `describe`
   block. Without it, `bun x tsc --noEmit` runs are forced to skip
   too, which keeps CI honest.

5. **Import from `@/_harness`.** The path alias resolves to
   `tests/app-test/_harness/index.ts` regardless of subdirectory
   depth. Key exports:

   - `launchTugApp(opts)` — spawn + connect + version handshake.
   - `App` class — `evalJS`, `waitForCondition`, `close`, plus typed
     wrappers (`click`, `type`, `focusElement`, `reset`,
     `seedDeckState`, `getActiveCardId`, `getFocusedCardId`,
     `getCaretState`, `getFormControlValue`, `getDeckTrace`,
     `markDeckTrace`, `expectFocusedCard`, `expectCaret`, the full
     native-gesture family, `simulateApp*` lifecycle verbs,
     `appReload`, `quitGracefully`, `startTugcode` / `stopTugcode`,
     ...).
   - `toContainOrderedSubset` / `registerSubsetMatcher()` — partial
     ordered-subset matcher for deck-trace assertions.
   - `EXPECTED_SURFACE_VERSION` — pinned `window.__tug` surface
     version; must match tugdeck and the Swift bridge.

6. **Drive, assert, close.** Seed state, drive gestures through the
   typed wrappers, assert against both `__tug` state reads and the
   deck-trace ring:

   ```ts
   const mark = await app.markDeckTrace();
   await app.click({ selector: "[data-tab='b']" });
   const trace = await app.getDeckTrace({ since: mark });
   expect(trace).toContainOrderedSubset([
     { kind: "fr-flip" },
     { kind: "destination-flip", cardId: "b", to: true },
     { kind: "focus-call", cardId: "b" },
   ]);
   ```

   Call `registerSubsetMatcher()` once at module load to enable the
   `expect(...).toContainOrderedSubset(...)` fluent form.

7. **Always close in `finally`.** Orphaned subprocesses accumulate
   across runs and exhaust socket paths.

8. **Within a single file, prefer `app.reset()`** over re-spawning
   when scenarios share the app — it is orders of magnitude faster
   than a subprocess boot. No state is shared across files.

9. **Prefer production code paths over synthetic events.** For focus,
   call `app.focusElement(selector)` — this uses the same `.focus()`
   path that production code takes, keeping the test inside the
   fidelity envelope. For trusted clicks/drags/keys, use
   `nativeClick` / `nativeDrag` / `nativeKey` — these post real
   `CGEvent`s and exercise WebKit's `isTrusted: true` paths that
   synthesized DOM events cannot reach.

10. **`holdModifier` for modifier-bracketed sequences.** Hold modifiers
   atomically Swift-side rather than driving them as separate events:

   ```ts
   // Hold Cmd while executing multiple keystrokes as one sequence.
   await app.holdModifier(["cmd"], async (inner) => {
     await inner.rpcCall("nativeKey", { key: "a" });     // Cmd+A
     await inner.rpcCall("nativeKey", { key: "c" });     // Cmd+C
   });

   // Simpler shape for a single inner keystroke: just pass the
   // modifier directly to nativeKey.
   await app.nativeKey("a", ["cmd"]);
   ```

   Inner verbs inside a `holdModifier` thunk must be native gestures
   only — `evalJS` / `waitForCondition` / nested `holdModifier` all
   reject. Flatten modifier sets (`["cmd", "shift"]`) instead of
   nesting scopes.

   **To look at the app while a modifier is down, use
   `withModifiersHeld` instead.** `holdModifier` ships its whole thunk
   as one RPC, which is why nothing inside it can introspect;
   `withModifiersHeld` issues the press and the release as separate
   round trips, so the body gets the ordinary caller and `evalJS` /
   `waitForCondition` / `screenshot` all work:

   ```ts
   await app.withModifiersHeld(["shift"], async () => {
     // The chord ring resolves dashed → solid while Shift is down.
     expect(await ringStyle(app)).toBe("solid");
   });
   ```

   The release runs in a `finally`, and Swift releases anything still
   held at connection close — a modifier left down outlives the test
   process and turns the next keystroke on the machine into a system
   chord.

11. **Keybinding chords: dispatch a synthetic `KeyboardEvent`, not
    `nativeKey`.** This is the one place item 8 inverts. A keybinding is
    defined purely by `event.code` + modifier flags — the keymap
    registry reads nothing else and does not check `isTrusted` — so a synthetic
    keydown exercises the exact Stage-1 capture-listener → keybinding →
    chain-dispatch path a real keystroke would. Dispatch it on the
    focused element so it reaches the document-level capture listeners:

    ```ts
    // ⌃⌥⌘P — a key-card-scoped keybinding chord.
    await app.evalJS(`(function(){
      var t = document.activeElement || document;
      return t.dispatchEvent(new KeyboardEvent("keydown", {
        code: "KeyP", key: "p", metaKey: true, ctrlKey: true, altKey: true,
        bubbles: true, cancelable: true, composed: true,
      }));
    })()`);
    ```

    **Why not `nativeKey` for a chord.** A native `CGEvent` for a
    `⌘`-modified chord (especially multi-modifier, e.g. `⌃⌥⌘P`) is routed
    through windowserver, where the OS can intercept it as a menu
    key-equivalent or drop a modifier flag on the timing seam before it
    reaches the WKWebView. Single-modifier chords like `⌘A` usually
    survive; two-modifier ones are unreliable. Reserve `nativeKey` for
    what genuinely needs the trusted input stack — typing into a field,
    `Escape`/arrows during a drag, focus-moving Tab — and drive
    accelerator chords synthetically. (The focus-walk stage that owns
    `Tab` / `Shift-Tab` also reads only `event.key` + modifiers, so the
    same synthetic dispatch drives it.) See `at0340` (route `⌃⌘C`) and
    `at0177` (permission `⌃⌥⌘P`); the binding's static contract is
    additionally pinned by `keybinding-map.test.ts` (pure-logic).

## The menu and keymap family

Six files carry the native menu bar and the keyboard, and they divide by what
they can only be asked of the real app:

| File | What it pins |
|---|---|
| `at0167`–`at0174` | Menu structure, and the validated enablement of the deck, maker-gate, session, and edit tiers |
| `at0177`, `at0179` | The key pipeline end to end — a chord reaching a command through the responder chain |
| `at0180` | The registry gate: an item's enablement, check mark, and dynamic title come from the pushed `commands` block, and every `menuItemId` in the table resolves to a real item |
| `at0181` | Native key equivalents derived from the keymap — applied, detached, left alone, and surviving a menu rebuild |
| `at0182` | A user keymap override round trip: written remotely and driven through the Settings ▸ Keyboard pane, with the native chord following both, and a locked command refusing |

The keymap's *resolution* — which layer takes a chord, what shadows what — is
unit-tested against a constructed multi-layer world, because that question is
about data and needs no app. What lives here is the half that crosses the
WKScriptMessage boundary, which is the half nothing else can answer.

## Directory layout

```
tests/app-test/
  _harness/                   # Bun-side harness library. Imported via @/_harness.
    selectors.ts              # Product strings + engine marks the tests mirror.
  harness-smoke/              # Primitive gates: smoke + protocol tests.
    smoke.test.ts             # Minimal launchTugApp → evalJS → close.
    smoke-native.test.ts      # CGEvent click / type / Cmd+A / drag / double-click.
    smoke-em.test.ts          # EM-card observation surface (engine-ready, getEmCardState).
    smoke-em-live.test.ts     # Opt-in (TUGCODE_LIVE=1) Anthropic round-trip.
    smoke-app-reload.test.ts  # appReload primitive.
    smoke-cold-boot.test.ts   # quitGracefully + tugbankRead two-process round-trip.
    smoke-capture-phase-save.test.ts  # [A9] capture-phase save invariant.
    double-connect.test.ts    # Single-client transport guarantee.
    log-capture.test.ts       # Per-test log file capture.
    version-handshake.test.ts # EXPECTED_SURFACE_VERSION mismatch error.
    wait-for-condition.test.ts # evalJS error translation, timeout, immediate-truthy.
  at{NNNN}-<slug>.test.ts     # AT-numbered scenario tests; prefix must match inventory.
  bunfig.toml                 # [test] root = "." — no test preload.
  tsconfig.json               # Path alias @/_harness. tsc --noEmit must be clean.
  logs/                       # Per-spawn stdout/stderr dumps. Gitignored.
```

## TUGAPP_APP_TEST naming note

The Swift-side gate env var is still named `TUGAPP_APP_TEST=1`
even though the directory is now `tests/app-test/`. Renaming the env
var requires a coordinated Swift change with code-signing
implications — deferred. See
[`roadmap/tugplan-app-test-cleanup.md`](../../roadmap/tugplan-app-test-cleanup.md)
[D06].
