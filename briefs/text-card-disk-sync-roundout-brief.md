<!-- brief-skeleton v1 -->

# Text card disk sync, rounded out: no hop, no blind spots, no revisit

**Purpose:** `842b59729` made a Text card track its file on disk, and the headline behaviours hold in the real app. What is left is everything that would bring the user back: a one-row hop that still happens under one timing, the Tug-common case nobody tested (a reload into a card that is not in front), a new conflict surface with no test on it, and the gates that let five red unit tests land on `main` unseen.

---

## Purpose {#purpose}

The user, after the arc was audited and joined:

> How did you test this? I want some confidence before going on that this will work properly, and that I won't be back here later reporting failure to do this properly, or regressions, or other bad behavior.

and, on being told `at0209` was still marginal and the compare sheet untested:

> Why are we leaving `at0209` failures and other "small gaps". Come on. Do a *great* job here, eh? […] I really don't want to revisit this work again later... I want it to be wrapped up *now* while we're focused on it.

The honest answer to the first question was that the audit tested nothing — it read the diff cold, `arc replay` said `Current`, and it took the implement stage's results on faith. Running the checks afterwards found five red unit tests already on `main`. That is fixed (`c0fda71f8`). This brief is the rest: every known gap in the disk-sync work, closed in one pass, with the gates repaired so the same class of miss cannot land again.

---

## Evidence {#evidence}

**[F01] The shipped behaviour holds in the real app.** On `main` with a fresh bundle: `at0602` 5/5 (out-of-workspace file reloads with no interaction in ~120 ms; a twenty-write burst settles on the last in ~240 ms; a dirty buffer merges a distant external edit in both save modes with no conflict; undo after a reload removes only the user's typing), `at0460` 4/4, `cargo nextest run -p tugcast -p tugcast-core` 2636/2636, `bunx tsc --noEmit` clean, full tugdeck `bun test` 9052/9052 after `c0fda71f8`. **(verified)**

**[F02] `at0209` › "in-place reload holds the text at the viewport top" is still marginal, off by exactly one row.** It reads `tall line 044` where it expects `045`. Red on `main` on 2026-09-21 in a three-file run; last recorded green the same day at `11f1382da` in a batch of 19. The arc's `baseline.md` recorded it red at Steps 1–4, green twice at Step 5, red three times at Step 6, with no change between them touching the reload path. **(verified)**

**[F03] The mechanism is CM6's cached scroll offset, and the test's shape is what exposes it.** In `@codemirror/view/dist/index.js`, `ViewState.update` computes the reload's scroll anchor from `this.scrollOffset` — a cached copy that only `measure` refreshes — and `EditorView.measure` discards the anchor outright when `Math.abs(scrollOffset - this.viewState.scrollOffset) > 1`. So a change dispatched after a scroll but before CM6 has measured that scroll gets no anchor: pixel `scrollTop` is held and every visible line slides down by the inserted row, which is the `044` signature exactly. `at0209` sets `scrollTop = 900` and clicks Reload with no frame guaranteed between them; `at0602` scenario 1 has a disk write, a 100 ms server debounce and a round trip in between, so CM6 has always measured, and it holds. The scroller is CM6's own `.cm-scroller` (`tug-text-card-editor.css:82`), so the `hasFocus` condition on the anchor correction does not apply — that hypothesis was checked and ruled out. **(mechanism read from CM6's source; that it is THE cause of `at0209`'s flip is inference until a sampler run shows it)**

**[F04] The same window exists in the product.** A reload that lands in the frame of a scroll — an agent writing while the user scrolls — takes the same path as [F03]. The window is narrow for wheel scrolling (CM6's scroll handler measures promptly) and wide for any programmatic scroll. **(inference from [F03])**

**[F05] Every disk-sync app-test scenario runs on the focused, visible card.** `at0602` seeds one card with `focusCardId: "A"` and never moves focus or hides it. The Tug-common case is the opposite: the user is typing in the Session card while an agent rewrites a file open in an unfocused card or a background tab. **(verified)**

**[F06] A hidden editor cannot hold its place, and nothing handles that.** A `display: none` editor has no layout, so CM6 can neither measure nor anchor; `_applyDiskRead` calls `bridge.replaceText` unconditionally whenever a bridge is attached. Whether a background tab keeps its bridge attached, and what position it shows when brought forward after a reload, was not tested. **(the unconditional call is verified; the visible consequence is untested)**

**[F07] The compare sheet has no test at the layer that can see it.** `presentCompareSheet`, the banner's Diff button, the conflict sheet's Diff… button and the `for (;;)` re-present loop in `text-card.tsx` are exercised by nothing; only `buildTwoTextDiffPayload` is unit-tested. The plan's test non-goals said the app-test would "click through once" and none does. **(verified)**

**[F08] `mergeThreeWay` is pinned by six fixtures and nothing generative.** The plan's own risk table rates a silent wrong merge *high* impact. The code reads correct — closed `touches`, both-sides walk, an overlap guard in the output loop — but a merge is the kind of function whose bugs live in inputs nobody thought to write down. **(verified)**

**[F09] Three small defects in `tugrust/crates/tugcast/src/feeds/file_watch.rs`, found by reading.** (a) `created` paths are built as `format!("{}/{}", client_dir, name)`, so a watched file at the filesystem root yields `//name`. (b) A sibling named by an event that arrives *after* the `absent` frame went out is remembered but never delivered — `emit` sends only on a change of `(state, sha256, ino)`, and an absent file stays absent — so a rename whose second event misses the 100 ms window falls through to the settle rung instead of being followed. (c) When `watcher.watch` fails on an ancestor, the directory is removed from `dirs` but stays in the file's `watched_dirs`; if another file later watches that directory successfully, this file's `unwatch` decrements and releases a watch it never held. **(verified by reading; none reproduced)**

**[F10] An ancestor-directory event costs a full read and hash.** The service watches the chain from the file's parent up to the project root, and any event naming a directory a watched file lives under marks the file dirty — so a directory-entry change anywhere up the chain buys a `read_stable` plus sha256 of a file up to 8 MiB, to learn nothing. `emit` suppresses the unchanged result, so it is cost only, never behaviour. **(verified by reading; the real-world rate was not measured)**

**[F11] No arc-verify surface runs a unit test.** In `.tugtool/config.toml` the `deck` surface runs `tsc`, `vite build` and `app-test-changed`; the `rust` surface runs `cargo clippy` and nothing else. Neither `bun test` nor `cargo nextest` runs at an arc's ending, so unit suites are checked only by whatever a plan's step checkpoints happened to name. **(verified)**

**[F12] That is how five red tests reached `main`.** `text-card-store.autosave.test.ts` replaced `@/lib/file-watch-client` with `mock.module`; bun's module mocks are process-wide, so `file-watch-client.test.ts` received the stub — green alone, red in the suite. Every checkpoint in the arc named files, so none ran both in one process, and [F11] meant the ending did not either. Fixed in `c0fda71f8` with an explicit `_setConnectionSourceForTest` seam and both suites on the real client. Four other suites still `mock.module("@/lib/connection-singleton")`. **(verified)**

**[F13] `just app-test-covers-check` is red on `main` for two independent reasons.** The subtree ratchet in `tests/app-test/scripts/select-tests.ts` records `tugrust/crates/tugcast/` at 689 sources and the tree holds 740 (it was 737 at the disk-sync arc's base, so it is still climbing). Six tests declare the whole crate: `at0090`, `at0093`, `at0094`, `at0216`, `at0226`, `at0239`. The ratchet's own comment says what the answer is: "name the feed or the module the test actually drives". Separately, `tugdeck/src/components/tugways/cards/session-card-transcript.tsx` fans out to 22 tests against an accepted 21. A guard that is red for everyone gates nothing for anyone. **(verified)**

**[F14] [B04]'s reconnect heal is unit-tested only, and the harness has no verb to restart tugcast.** A grep of `tests/app-test/_harness` for a restart or kill of tugcast finds nothing. **(verified)**

---

## Decisions {#decisions}

**[B01] `replaceText` measures before it dispatches.** One `view.measure()` immediately before the dispatch in `tugdeck/src/components/tugways/tug-text-card-editor.tsx` refreshes CM6's cached scroll offset, so the anchor is always computed from where the view really is. This is the fix for [F03] and [F04] at the one door all external text enters through, so it covers reloads, merges, Revert and Reload from Disk alike. It rests on [F03]'s reading of CM6; if the sampler in [B02] shows the hop surviving it, the mechanism is wrong and the arc stops to say so rather than shipping a second guess.

**[B02] The hop is proven with a sampler and a reverse probe, not with a green run.** Per the standing lesson that the 2026-09-18 drop fix was "verified" green and was not fixed: a scenario that scrolls and reloads in the *same task* (deterministically red before [B01], green after), a per-frame sampler of the top line's text and offset across the reload, and a `tugtool file probe` reverting [B01] that turns it red. `at0209`'s existing scenario keeps its assertion byte-for-byte — it was right, and it becomes deterministic rather than being loosened.

**[B03] A reload must hold the reader's place in a card that is not in front, and both shapes get an app-test.** Unfocused-but-visible (focus on another card, external write, assert content and viewport-top hold) and hidden-then-shown (background tab, external write, bring it forward, assert content current and place held). These are the cases a Tug session actually produces ([F05]).

**[B04] A hidden editor defers the reload's text until it is shown; the store's state moves immediately.** If the hidden-tab scenario shows the place is lost ([F06]), the store adopts the baseline and snapshot at once — so saves, conflicts and echoes stay correct — and the editor-side `replaceText` is applied when the card becomes visible, where CM6 can anchor it. Hash identity makes the deferral safe: there is one pending text, the latest. If the scenario shows a hidden editor already holds its place, this decision builds nothing and the test stays as the pin.

**[B05] The compare sheet is driven in the real app, in both save modes.** Force a touching-line conflict, open Diff, assert the sheet renders the real `+`/`-` lines, that Cancel returns to the conflict question (manual mode re-presents its sheet), and that Reload from Disk and Keep Mine each resolve. One scenario per mode ([F07]).

**[B06] `mergeThreeWay` is fuzzed against `git merge-file` as an oracle.** A seeded generator produces base/ours/theirs triples (distant edits, touching edits, identical edits, EOF appends, no trailing newline, CRLF-normalized inputs); the property is one-directional: whenever `mergeThreeWay` returns `ok`, `git merge-file -p` also merges clean and yields byte-identical text. The converse is not asserted — this merge is deliberately stricter than git's. It is a dev-machine test that skips when git is absent; nothing GPL ships, and the host-tools rule about never probing `git --version` is honoured by resolving git the way `tugcore::host_tools` does or by skipping.

**[B07] The three `file_watch.rs` defects are fixed, each with a Rust test.** (a) `created` paths are joined, not formatted, so the root case yields `/name`. (b) A sibling noted while the last reported state is `absent` forces one follow-up frame carrying it, so a late rename event still reaches the ladder. (c) `watched_dirs` holds only directories whose watch this file actually took ([F09]).

**[B08] A look that an ancestor event caused stats before it reads.** When the dirtiness came from a directory above the file rather than from an event naming the file, the look compares `(ino, size, mtime)` with the last report and skips the read when they match. An event naming the file itself always reads, so [B05] of the original brief — mtime is a reason to look, never identity — is untouched: this only declines to look harder when nothing pointed at the file ([F10]).

**[B09] The arc-verify surfaces run the unit suites.** `deck` gains `cd tugdeck && bun test`; `rust` gains `cd tugrust && cargo nextest run`. The whole suite in one process is the only thing that sees a process-wide mock leak, and an arc's ending is the one place guaranteed to run ([F11], [F12]). The cost is about 40 s and 30 s respectively, paid once per arc.

**[B10] A suite may not `mock.module` a module that has its own suite.** A small lint test over `tugdeck/src` enforces it: for every `mock.module("@/lib/X")`, there is no `__tests__/X.test.ts`. The four remaining `connection-singleton` mocks are moved to explicit seams or shown to be safe and listed by name. This is the structural half of [F12]; [B09] is the detection half.

**[B11] The covers check goes green by narrowing, not by raising the number.** The six tests that declare `tugrust/crates/tugcast/` are re-pointed at the feeds and modules they actually drive, and the subtree entry is deleted from the ratchet — which is what its own comment asks for. The `session-card-transcript.tsx` fan-out is settled the same way: narrow a `@covers` line that does not belong, and only if all 22 are honest, record 22 with the reason. `just app-test-covers-check` is green at this arc's end ([F13]). The user decided this is in scope.

**[B12] Reconnect is pinned in the app if the harness can be given a restart verb cheaply; otherwise it is recorded as the one gap left, by name.** "Cheaply" means a harness verb that kills and relaunches the instance's tugcast without relaunching `Tug.app`. If that needs changes under `tugapp/Sources/TestHarness/` beyond a small verb, the arc writes down what it found and does not build it ([F14]).

---

## Non-goals {#non-goals}

- **Loosening `at0209`'s assertion, or adding a wait to make it pass.** The scenario is right and the product has the window ([F04]). A sleep would hide both.
- **Raising the tugcast ratchet to 740.** Rejected in [B11]; the number climbing is the alarm working.
- **A timer that re-checks hidden editors.** The deferral in [B04] is applied on the show event, never on a clock.
- **Asserting `git merge-file` clean ⇒ `mergeThreeWay` ok.** This merge refuses touching-line edits git would accept, by decision.
- **Shipping or bundling git for the oracle.** Dev-machine test only; Tug ships nothing GPL.
- **Changing the merge algorithm, the save modes, the wire, or the missing-file ladder's rungs.** This arc fixes defects and adds proof; it redesigns nothing the first arc settled.
- **Giving other file-showing cards the subscription.** Still a follow-on of the original work, not this one.

---

## Exit {#exit}

**An arc.** The pieces are independent except where noted, and the order that matters is: gates first, so everything after them is checked by the repaired gates.

1. The verify surfaces and the mock lint ([B09], [B10]) — so every later step's ending runs the whole suite.
2. The hop: the same-task scenario red first, then `view.measure()` in `replaceText`, the sampler, the reverse probe ([B01], [B02]).
3. The not-in-front scenarios, then the hidden-editor deferral only if they show it is needed ([B03], [B04]).
4. The compare-sheet app-test ([B05]) and the merge oracle fuzz test ([B06]).
5. The `file_watch.rs` fixes and the stat-before-read ([B07], [B08]), with `cargo nextest run -p tugcast`.
6. The covers check to green ([B11]).
7. The reconnect pin or its written-down gap ([B12]).

Done means: `at0209` 5/5 across repeated runs with the hop scenario proven able to go red; the new scenarios green; full `bun test`, `cargo nextest run`, and `just app-test-covers-check` all green on the arc's tree.
