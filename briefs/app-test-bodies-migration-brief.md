<!-- brief-skeleton v1 -->

# The app-test bodies migration: the cut corpus runs on bodies

**Purpose:** Every card kind is a body, and the user has ruled that bodies become the only mode, but 492 of the corpus's 539 files still launch with bodies off and test a card host the product is leaving behind. This brief records where the cut corpus stands, decides how the rest of it comes onto bodies batch by batch, and cuts Tug over to bodies only: no shipping switch, no in-document card host, no harness option.

---

## Purpose {#purpose}

This is step 7 of the corpus cut (`briefs/app-test-corpus-cut-brief.md`), whose order the user set on 2026-10-16:

1. Move the readings out of the corpus.
2. Delete the transcript-seeding motion files, after one settle-verb reading of the same gestures on the real app.
3. Take the product reds, rows 5 and 6 first.
4. Split, speed up or delete every other file over 20 seconds.
5. Cut the redundant, obsolete and browser-control files, each list approved by the user first.
6. Change the runner so progress stays visible.
7. Migrate what remains onto bodies.

Steps 1–6 are done. Step 6 landed as the `run-panel-adoption` arc (joined `5a0057361`). The cut brief's [B09] already decided step 7's shape: "What remains after [B01]–[B06] moves onto bodies in batches of ten to fifteen files grouped by card kind, each batch opting in with the launch's `bodies` option and run alone as its verdict, fixes landing in the same commit. The harness default flips to bodies in one line once no file is left un-opted. The quarry branch and patches are mined, never merged."

The first attempt flipped the whole corpus at once and stalled the every-card-a-body arc for hours. The user's standing complaints about the corpus apply to this step too: no file over 20 s, no lingering reds, "I want to retain the findings which point to actual bugs."

---

## Evidence {#evidence}

**[F01] The corpus after the cut: 539 files, 47 already on bodies.** That is 440 top-level files and 99 in `body-grounding/` and `harness-smoke/`. Every file that opts in does so with `bodies: true` on `launchTugApp`. Eight top-level files do: the six `at0738-body-*`, `at0741-every-kind-a-body` and `at0742-reconnect-gap`. The other 39 are grounding rows and smoke files. So 432 top-level files and 60 grounding and smoke files launch bodies off. **(verified: counted on `002150a45`)**

**[F02] 217 files reach a card's DOM through the shell's page.** `scripts/card-dom-census.ts` lists every page-evaluating call whose text holds a card selector on a receiver that isn't a body. `scripts/card-dom-allow.json` holds the 242 `{file, kind}` pairs not yet migrated, across 217 files. One of those files is in `body-grounding/`. By kind:

| Kind | Pairs |
|---|---|
| `session` | 77 |
| `layout` | 29 |
| `cards` | 29 |
| `text` | 25 |
| `dashes` | 20 |
| `overview` | 19 |
| `unknown` (the census could not name a kind) | 17 |
| `jots` | 11 |
| `settings` | 6 |
| `gallery-prompt-entry` | 3 |
| `gallery-accordion` | 2 |
| `fixture-markdown-1kb`, `diff`, `keyboard`, `commit` | 1 each |

`just app-test-body-scope-check` runs `--check` and fails on an entry the list doesn't allow. The census's own doctrine is that a file's pair "leaves the list in that kind's change, and the list is empty once every kind is a body." **(verified, run)**

**[F03] The other 225 top-level files reach no card DOM by the census's reading.** Against the quarry triage's bins:

| | Reach card DOM | Reach none |
|---|---|---|
| *kept* | 138 | 81 |
| *shell* | 29 | 97 |
| not in the triage (split pieces and newer files) | 48 | 47 |

The census scans call text only. A file that reaches no card DOM can still go red on bodies through a harness verb that asks the shell about a card ([F06]). **(verified, counted; the cross-tab is against the triage's bins, which [F05] says are a starting point)**

**[F04] Bodies are off by default in both the product and the harness.** `BodyGeometry.bodyViewsEnabled` (`tugapp/Sources/BodyGeometry.swift`) reads the tugbank setting `dev.tugapp.deck`/`bodies`, which is false unless set. Under the harness, a launch also opts in with `TUG_BODY_VIEWS=1`, which the `bodies` option on `launchTugApp` sets (`_harness/types.ts`: "Off by default, which is today's launch"). The user ruled on 2026-10-16 that bodies-off is going away. On that ruling, step 5 deleted the files whose premise was the in-document card host (the cut brief's [B06]). **(verified, read)**

**[F05] The first attempt, and what it left on the quarry branch.** The every-card-a-body arc's steps 10 and 11 flipped every file onto bodies under a 10 s budget, and 324 of 486 went red together. That work was retracted to `quarry/every-card-a-body-corpus`, five commits past the step-9 join:
- `fd91d6d04` launches every app-test on bodies.
- `a266d4fe7` writes the triage (`briefs/app-test-corpus-triage.md`: one subject per file, and a bin of `covered`, `obsolete`, `shell` or `kept`).
- `4cba6d19f` moves card reaches onto bodies by machine, with `scripts/card-dom-codemod.ts`, which is on main.
- `5f14749cd` answers the session verbs in the body: `tugdeck/src/test-surface.ts`, 263 lines.
- `7864c3910` brings the first 98 red files over in seven fixer passes. It adds drag and mouse-up verbs to `BodyApp` and gives the body page its own `UsageStore` and `ingestUsage` (`tugdeck/src/body/body-main.ts`, `body-root.tsx`, `action-dispatch.ts`).

`7864c3910`'s message names five product gaps:
- a Session-card body never receives a seeded bag through bind;
- tugcast asks reach only the shell;
- the Jots body never gets a `NEW_JOT` edit;
- a second rail on one edge is never placed;
- body activation promotes an anonymous responder.

The uncommitted remainder was saved as patches in `.tug/arcs/every-card-a-body/`. That directory is gone now; `.tug/arcs/` is empty. **(verified: the commits and stats read from git; whether each named gap still holds on main is not verified, and nor is whether main already carries any of the quarry's harness or product changes)**

**[F06] On the quarry, six core-tier files went red the same way, through the shell asking about a card that now lives in a body.** The triage's own words: "`window.__tug.assertHostRootRegistered("A")` timing out, the shell's card verb asked about a card that now mounts in a body." That is a harness verb (`_harness/client.ts`, `assertHostRootRegistered`) answered by the shell's test surface. The census doesn't count it, because the call text holds no card selector. **(verified, read from the triage; which other shell-side card verbs share the shape is not enumerated)**

**[F07] Helpers that answer on either path already exist.** `App.body(cardId)` returns a `BodyApp` scoped to the card's page (`_harness/index.ts`). `_harness/card-reach.ts`'s `cardPage(app, cardId)` returns the body when the host holds a bound one and the shell otherwise, "so a file that uses them keeps passing on either path." `body-grounding/_kinds.ts` holds each kind's marks, and `_kind-bodies.ts` stands a kind up. **(verified, read)**

**[F08] The core tier is 13 files after the cut**, three of them `harness-smoke` and one `body-grounding/row-07-focus`. Only `row-07-focus` launches with bodies on. **(verified: `bun scripts/select-tests.ts --core`)**

**[F09] The product branches on bodies in a known set of places.**
- **Host.** `BodyGeometry.bodyViewsEnabled` decides once, at window creation (`MainWindow.swift`), and `BodyViewController.swift` guards on it. `HostCapabilitiesScript` tells the shell `bodyViews` before its first script.
- **Shell.** `hostCapabilitiesStore.get().bodyViews` is read by `lib/body-handoff.ts`, whose `isBodyKind` is the capability AND the registration's `body === true`. It is also read by `body-placement.ts`, `body-shell.ts`, `pointer-claim.ts`, `settle-engine.ts` and `session-card-registration.tsx`.
- **The setting.** The Layout card's Bodies row (`layout-card.tsx`, `BODY_VIEWS_DOMAIN`/`BODY_VIEWS_KEY`) writes `dev.tugapp.deck`/`bodies`.
- **The other half.** Where `isBodyKind` answers false, the card mounts in the shell's document through `card-host.tsx`. That is the in-document card host, the path bodies-off keeps alive.

**(verified: `git grep` for `bodyViews`/`bodyViewsEnabled`; which code is reachable only from the false branch is not enumerated)**

**[F10] What nine arc rounds measured.** Verdict runs are cheap: a 13-file batch verdict ran in 43–70 s, and a red 13-file run in 1–4 min (`apptest_results.db`, the arc's runs of 2026-10-16 and -17). The rounds were not: the jots batch took 37 min, the small-kinds batch 74, the gallery batches 15–30 each (commit times). More than half of every batch's files were product and harness, not tests: jots 25 of 35, small kinds 17 of 27, gallery 3 20 of 25. The product gaps found that way are real (a host dropping clicks into a body, ⌘J never reaching the Jots body, a pane's resize handles unreachable under a body, Open Quickly lit under a modal), and they surfaced one kind at a time. After nine rounds, 362 of 440 top-level files were still bodies-off and 319 allow pairs remained of the 366 the widened census counted. **(verified: the ledger, the commit log, `git show --stat`)**

---

## Quarry against main {#quarry-against-main}

The quarry's own changes are `git diff fd91d6d04^ 7864c3910`, read file by file against `main` at `b4124dba2`. `main` carries **none** of them: every harness, runner, census and product change below is missing, except where `main` has since done the same work its own way (*superseded*). Each line names the step that ports it. Nothing is cherry-picked; the port is by hand from `git show 7864c3910:<path>`. **(verified: read, and each symbol grepped on `main`)**

**Harness (`tests/app-test/_harness/`)**

- **`App.pageOf(cardId)`** and the routing of `getCaretState`, `getFormControlValue`, `expectCaret`, `getEmCardState`, `isEngineReady`, `awaitEngineReady`, `driveSession` and `ingestSessionMetadata` through it: missing. Step 2. (The quarry's `awaitEngineReady` first waits on `assertHostRootRegistered` in the shell; Step 2 waits in the card's page instead.)
- **`BodyApp`'s native element verbs** — `nativeRightClickAtElement`, `nativeDoubleClickAtElement`, `nativeDragElement`, `nativeDragElementWithoutRelease`, `nativeMouseUp`: missing. Step 2.
- **`BodyApp`'s synthesized gestures and element reads** — `click`, `type`, `focusElement`, `getElementText`, `getElementValue`, `getElementAttribute`, `getElementBounds`, `getElementState`, `getComputedStyleValue`, and the card-scoped `getCaretState`, `getFormControlValue`, `getDeckTrace`, `markDeckTrace`: missing. Step 2. This one is load-bearing for the batches: `main`'s codemod rewrites `getElementState`, `getComputedStyleValue` and `getSelection` reaches onto `app.body(id)`, and `main`'s `BodyApp` has none of those methods, so its rewrite of such a reach does not type-check.
- **`card-reach.ts`'s `PageMarks`, `markEveryPage`, `traceSinceEveryPage` and `kindBody`**: missing (`bodyOfKind` is on `main`). Step 2.
- **`-ApplePersistenceIgnoreState YES` on every launch**, so a crash's "reopen windows?" modal cannot wedge every later launch: missing. Step 2 — it is a harness launch change, and a batch run that meets the modal would otherwise read as a machine full of `WEDGED` rows.
- **`bodies` on by default** (`opts.bodies === false ? {} : { TUG_BODY_VIEWS: "1" }`) and its doc comment in `types.ts`: superseded by [B08]. Step 39 deletes the option instead of defaulting it.

**Runner and census (`tests/app-test/scripts/`)**

- **`app-test.sh`'s per-file budget**: the `OVERTIME` status (green past the budget, counted red in the verdict and recorded as `FAIL`), the wedge cap clamped to three budgets, the up-front cost estimate from recorded times, and honouring a caller's `TUG_APPTEST_TIMEOUT_SCALE`: missing. `main`'s runner has no per-file budget at all, so the plan's constraint that it "already reports a file over 20 s as `OVERTIME`" is not true on `main`. [B07] needs the check to exist, so Step 2 ports it with the budget at **20 s** (the quarry's was 10 s; [B07] and the cut brief's [B02] set 20).
- **`card-dom.ts`'s wider census**: gestures and element reads counted as evaluators; the per-card `__tug.*` verbs and `inputSelectorFor(` counted as card selectors; `BODY_TUG_VERBS`/`readsShellDeck`, so a `__tug` verb a body answers no longer marks a reach as reading the shell; `[data-card-id=…] <descendant>` and the same scope through a constant counted as card content; file-local selector builders; and a reach that names no card resolved to the file's one seeded card of its kind: missing. Step 2, which regenerates `card-dom-allow.json` for every reach the wider census newly counts, so `just app-test-body-scope-check` stays the ledger of what is left.
- **`card-dom-codemod.ts`'s `--into-kind`** (rewrites onto `kindBody(<receiver>, "<kind>")` and adds the import): missing. Step 2, with `kindBody`.
- **`card-dom-allow.json`'s 132 removed lines**: the quarry's own migrations. Superseded: each batch removes its own pairs.
- **`select-tests.ts`'s core tier** (`at0016` → `body-grounding/row-07-focus`, `at0201` dropped): superseded. `main`'s core tier already has `row-07-focus`, and neither of the others survived the cut.

**Product (`tugdeck/src/`)**

- **`test-surface.ts`**: 25 verbs moved into `createViewSurfaceMethods`, with `peekCardHostRoot` added to `ViewSurfaceStore`, `SURFACE_VERSION` `2.43.0`, and `attachBodyTestSurface(bridge, { usageStore })`. The moved verbs are `assertHostRootRegistered`, `getCaretState`, `getFormControlValue`, `inkRestoreFacts`, `refreshInkRestore`, `lastSentUserMessage`, `ingestSessionMetadata`, `getSessionPerf`, `getCardStateBag` (Table T02's card-page verbs), and `getDeckTrace`, `markDeckTrace`, `clearDeckTrace`, `connectionClose`, `dispatchControlAction`, `forceCommitClamp`, `getFocusInvariantReport`, `getListConservation`, `getScrollDisplacementCount`, `ingestHostFail`, `isGestureScopePending`, `rowParsesByIdentity`, `setTranscriptEvictionDisabled`, `setTranscriptFollowBottom`, `startListReveal`, `takeListRevealOutcome`: missing. Step 2 classifies and moves the card-page ones; the `usageStore` option rides with the body's `UsageStore` below.
- **`body/body-intent.ts`'s `bind` intent** (the harness's fake bind handed to the body and replayed into its own binding and line stores, honoured only under the harness): missing. Step 3, beside [P13]'s forwarded spawn: a `bindSession` for a card that is already a body is the same "the shell decided a session for a body card" case.
- **`body/body-main.ts` and `body/body-root.tsx`: the body's own `UsageStore` under a `UsageContext.Provider`**, so the Session card's `/usage` sheet works in its body: missing. The session batch whose file opens `/usage`.
- **`body/body-main.ts`: ⌥⇥ (`CYCLE_FOCUS_MODE`) answered in the body**, asking the key card first and forwarding only a base-mode decline to the shell: missing. The first batch whose file drives the card's focus cycle.
- **`body/body-main.ts`: `window.tugDevLog` and `window.tugPerfMonitor` in a body under the harness**: missing. The first batch whose file reads a card's log or census in its page.
- **Save-on-blur for body cards**: the body saves its card on its own window `blur`; the shell's `onBlur` (`deck-manager.ts`) skips its save-and-unfocus when a body card holds the first responder; and `initActionDispatch` sets `hasFocus` from the host's resign/become-active events: missing. The first batch with a red on a stale bag or a stuck `hasFocus`.
- **`action-dispatch.ts`: `resolve_sessions_ok`, `session_index_changed` and `resolve_sessions_err` moved into `registerStoreTailActions`**, so a body's citations settle: missing. The first batch whose file cites a session from a body's transcript.

**What Step 2 ported, and where it departs from the quarry**

- **Ported:** the surface move (with `getSelection`, `getComputedStyleValue`, `registerSelectionBoundary` and `unregisterSelectionBoundary` moved too: the quarry's `BodyApp` calls the first two in the body, and the body's surface lacked them); `App.pageOf` and every per-card `App` verb routed through it, `assertHostRootRegistered`, card-scoped `getSelection` and the selection-boundary pair included; `BodyApp`'s native element verbs, gestures and element reads, plus `getSelection`; `card-reach.ts`'s helpers; the wider census and `--into-kind`; the runner's per-file budget at 20 s; `-ApplePersistenceIgnoreState`. `cardLineFacts` and `activateCard` stay on the shell: the first reads the shell's binding and identity stores, the second raises the card in the shell's deck.
- **`awaitEngineReady` keeps the quarry's shell wait.** The plan said to wait in `pageOf(cardId)` instead, but a `pageOf` resolved before the body exists answers the shell, and the engine wait would then run in the wrong page. The shell's `assertHostRootRegistered` now answers a body card from its body's state (`ready` or `painted`), so waiting there first means "the card's page is up", and only then is the page resolved. The wait still runs in the card's page, which is what the plan's sentence was for.
- **The 352 shell-evaluated `window.__tug.assertHostRootRegistered(…)` waits in 235 files need no batch edit** for the same reason. The other card-page verbs evaluated as shell strings (`getCaretState` 4 calls in 2 files, `getFormControlValue` 1/1, `registerSelectionBoundary` 1/1, `inkRestoreFacts` 11/7, `refreshInkRestore` 3/3, `lastSentUserMessage` 3/2, `ingestSessionMetadata` 1/1, `getSessionPerf` 2/2, `getCardStateBag` 15/10) are now census selectors, so each sits on the allow list for its batch to move.
- **The `bind` intent is left for Step 3.** The quarry's `bindSession` hands off through it; on `main` a bound Session card is not yet a body (the first gap above), and Step 3 is where a decision the shell makes for a body card starts reaching the body.
- **The kill ceiling scales with the timeout scale.** The quarry clamped every file's kill at three budgets (60 s). Under concurrency the harness scales every wait by the job count, so a file's 20 s wait is 80 s, and the clamp killed ordinary timeout reds as `WEDGED`. That cost them their failure messages, and two in a row halted the run (the first core-tier run, which stopped with five files unread). The ceiling is now three budgets times `TUG_APPTEST_TIMEOUT_SCALE`.
- **`card-dom-allow.json` regenerated from the wider census:** 242 pairs became 366. No existing pair dropped out, and none of the 124 new pairs is on a file that already launches on bodies. By kind: `session` 87, `unknown` 18, `gallery-input` 7, `gallery-motion-bench-dot` 3, `fixture-list-view-scroll-keyed` 2, and one each for `text`, `spike-session-identity`, `layout`, `gallery-prompt-entry`, `gallery-accordion`, `fixture-transcript-copy` and `fixture-markdown-50kb`.
- **A census gap remains:** a card scope built by a helper call inside a template, such as `at0165`'s `` `${CARD("B")} input` ``, is not counted, because the helper's argument is read only once a card selector has been found. The batch that owns such a file moves its reach by hand regardless.

**The core tier on bodies (`TUG_BODY_VIEWS=1`), at Step 2.** 8 of 13 green: the three `harness-smoke` files, `at0084-session-lifecycle-coordination`, `at0145-permission-dialog-keyboard`, `at0191-turns-end-to-end`, `at0253-commit-dialog` and `body-grounding/row-07-focus`. The five reds are all card-DOM reaches still evaluated in the shell's document, none a harness verb, so each is its batch's to fix:

| File | Failing assertion | Batch |
|---|---|---|
| `at0024-prompt-state-roundtrip` | the `gallery-prompt-entry` legs: `[m24] phaseA: editor scroller not found for cardId=A` | 18 |
| `at0209-text-card-live-autosave-loop` | both legs: the wait on `[data-card-id="A"] [data-slot="tug-text-card-editor"] .cm-content` holding `fixture line 01` times out | 6 |
| `at0216-shell-exchange` | the wait on `[data-card-id="A"] [data-slot="session-transcript-shell-row"]` (4 rows) times out | 19 |
| `at0231-sidebar-toggle` | both legs: the wait on `[data-testid="layout-card-section"]` times out | 15 |
| `at0165-activation-first-responder` | Bug C: `selector matched no element: [data-card-id="B"] input` | 3 |

**What Step 3 built, and what it found**

- **Every Session card is a body from the moment the deck holds it.** The shell's deck scan hands off an unbound Session card with a `restore` intent once the shell has nothing to start for it: no binding, the startup restore pass settled, no `restoreSessions` pass still asking the ledger about it (`restorePassCards`, which covers a workspace's slow path the gate does not), and no restore in flight. The scan runs a microtask after whatever woke it, so `restoreSpaceSessions`, called right after a workspace's commit, registers its decisions first. Mount kinds are still handed off in the commit, as before.
- **A later decision reaches the body.** `handOffToBody` on a card that is already a body card sends the funnel's new intent to the body as a `card-command` `intent` (a new bus command kind, in the TypeScript and Rust halves and the parity fixture). A body not yet heard from has its latest intent held and sent behind its first `card-facts`. The kept intent is the latest one, so a body that fails re-runs the latest decision in the shell.
- **The reconnect pass passes over body cards by name** (`RestoreOptions.reassert`, read against `isBodyCard`), instead of relying on the shared early return: the body re-asserts its own card.
- **The harness's `bindSession` hands off through the quarry's `bind` intent** and keeps the shell's binding too, as a real spawn's broadcast would.
- **An unbound card's arrival waits on `bodyReadyQuiet`** when the host makes bodies.
- **`at0738-body-arrival`'s guarantee moved, in the open.** It said a card opened through the picker's New takes the warm spare. Under [P13] a Session card takes the spare when the deck holds it, before any pick, so the file now opens Session cards on an empty deck (`show-card`) and samples the spare's container, armed before the open (`hostFrames` accepts `layer: "spare"`). Warm-then-cold, the one-step show and the still container are asserted as before. `at0738-body-placement`'s unbound neighbour is now a body card too, and the file says so.
- **A host defect, fixed here:** `ClickThroughWebView.liveClickInside` read `NSApp.currentEvent`, which names only an event that came through the app's queue. A click handed to `window.sendEvent` directly (the harness's own-pid mode) read as no click, so the window refused to make the clicked body first responder while the shell had named another body for the keyboard, and the click was dropped: no page saw a pointer-down. The window now records the event it is dispatching, and `liveClickInside` reads that first. It surfaced once `at0738-body-placement`'s neighbour became a body.

**The bodies-on Session files at Step 3.** All six are red, each on a card-DOM reach evaluated in the shell's document: a harness-bound Session card is now a body, so its DOM is no longer in the shell. Four of them (`at0084`, `at0145`, `at0191`, `at0253`) were green at Step 2 only because a bound card was not yet a body. That was the false green [P13] closed, not a working read. Each goes green in the batch that moves its reaches:

| File | Failing reach | Batch |
|---|---|---|
| `at0024-prompt-state-roundtrip` | `[m24] phaseA: editor scroller not found for cardId=A`, now on all four legs | 18 |
| `at0084-session-lifecycle-coordination` | the wait on `[data-card-id="A"] [data-slot="session-telemetry-status-row"]` | 18 |
| `at0145-permission-dialog-keyboard` | the wait on `[data-card-id="A"] [data-slot="session-permission-dialog"]` | 18 |
| `at0191-turns-end-to-end` | the wait on `[data-card-id="A"] [data-slot="tug-transcript-entry-sequence"]` | 18 |
| `at0216-shell-exchange` | `selector matched no element: [data-card-id="A"] [data-slot="tug-text-editor"] .cm-content` | 19 |
| `at0253-commit-dialog` | the wait on `[data-card-id="A"] [data-testid="session-card-transcript-user-body"]` | 19 |

**What batch 1 (jots) built, and what it found.** All 13 files are green on bodies. Four product gaps surfaced, and each is fixed here with a file of the batch as its guard:

- **⌘J's capture opens in the Jots card's own page** (`at0241-jots-editor`, the quarry's `NEW_JOT` gap). `NEW_JOT` created the jot in the shell's jots store, whose open row (`editingId`) is that page's own, so a Jots body saved the jot and opened nothing. The canvas now calls `captureJot(cardId)` (`lib/jot-capture.ts`). The body shell's forwarder takes the capture for a card that is, or is about to be, a body, and sends a `card-command` `new-jot` (a new bus command kind, in the TypeScript and Rust halves and the parity fixture). A body not yet heard from is sent it behind its first `card-facts`. Any other card captures in its page's store, as before.
- **A body knows the deck's frontmost bound project** (`at0417-jot-annotation-links`, its relative-path leg). The Jots card resolves a relative path against the frontmost bound card's project, and a body's one-card deck and binding store cannot say which card that is. The shell now sends it in `deck-facts` (`frontmostProject: { binding }`, re-sent when a binding moves), and `frontmostProjectBinding()` answers with the relayed binding on a body page.
- **A jot's annotation links re-resolve when its resolver changes** (`at0418-jot-origin-provenance`). Origins landing from a paste swapped the resolver under an open editor, and nothing re-read the buffer until an unrelated verdict arrived. On the shell page a FILETREE notify happened to supply one; in a body nothing did. The card now notifies its link extension whenever the resolver changes.
- **A body card holds through its pane's crossing** (`at0626-sash-drag-sampler`). The hold writes its sizes on `[data-card-host] > *`, and a body card's placeholder has no card host, so a sash drag, a fold or a settle's height tween held nothing. The body was re-placed at each frame's size, and its card root was laid out on every frame (57 times in one drag). Placeholders are now hold targets, and nothing styles them, so the box the host clips the body to still follows the content box. The body shell relays the frame's marks and held sizes in `card-context` (`crossing`, a new opaque field in both halves and the fixture), re-sent the moment a mark moves (a `MutationObserver` on the crossing attributes). The body writes them on its own frame (`applyCrossingMirror`), announcing the end as the shell's doors do. The hold's CSS, the list view's held frame and the gesture scope's held check now also recognise `.body-pane-frame`. The fold's own consumers still find their frame by `.tug-pane`, so a body's fold presentation is unchanged. Each member now takes one root layout at the mark and none during the hold.

Test-side, the census now counts a name bound to `kindBody(…)`, or an arrow returning one, as a body. Those reaches were already read in the right page, and the scan had flagged them only because it did not know the finder.

---

## Decisions {#decisions}

**[B01] The migration moved by card kind for its first nine rounds; the rest moves by cause, interactively, in slices on main (the user, 2026-10-17).**
- **What the kind batches were.** Ten to fifteen files sharing the kind their allow pairs name, each file opting in with `bodies: true`, each batch run alone once as its verdict with its fixes in the same commit. Nine rounds landed that way on the arc (`895c4310e` through `fe3f223e6`): the quarry delta, the per-card verbs, Session cards always bodies, and the jots, small-kinds, three gallery and first text batches, 78 files in all.
- **What they measured ([F10]).** A batch's verdict run costs about a minute; the hour a batch took was reading, product fixes and the arc step's own overhead. And the reds cluster by cause, not by kind: the body-focus facet surfaced in batches 3, 4 and 6 and was pulled into one step by the user. The grain was wrong, not the goal.
- **The rest, by cause.** One mechanical slice moves every remaining file's reaches by codemod, opts every file in and empties the allow list. The whole remainder then runs once on bodies, in chunks of about 25 so progress shows, recorded under a named selection. The reds are grouped by failure signature from the JSON report, and each cause is one slice: fix it, re-run only its cluster's files. A file red for a reason unrelated to bodies is fixed in its cluster too, under [B03].
- **Why interactive.** The slices cannot be named until the run says what the causes are, so a plan written ahead of it is a plan in name only, and every call along the way (which cause first, which red is a premise and which a bug, what is removed) is the user's to make in the moment. The corpus cut's steps 1–5 ran this way and were its fast part.
- **Not a return to the all-at-once flip.** That attempt ([F05]) failed under a 10 s budget, with harness verbs that could not answer for bodies and a codemod that produced code that did not compile. The arc's Steps 2 and 3 removed all three, and five batches ran green on what they built.

**[B02] A file moves to bodies by moving its reaches, never by deleting what it asserts.**
- **The move.** Each card-DOM reach goes through `App.body(cardId)` or `card-reach.ts`'s helpers ([F07]).
- **The allow list.** The file's `card-dom-allow.json` pair leaves the list in the same commit, so the census stays the ledger of what's left. When the list is empty, the census's job is done.
- **Never re-pointed.** An assertion is never changed to match what bodies happen to do. A test that has to move must still assert the same guarantee in its new place.
- **A gone premise.** If a file's premise is gone under bodies — it reads one document for something that now spans two — the file goes on a removal list. The user approves that list before anything is removed, as in the cut brief's [B06]. It is never deleted inside a batch on the batch's own say.

**[B03] A red that points at the product is fixed in the product, in the batch that found it.** This is the cut brief's [B05], applied to bodies. On the user's daily deck bodies are on, so a body defect a migrated file finds is a defect users see. It is fixed, with the migrated file as its guard. Nothing ships as "known red": a batch ends green or does not land.

**[B04] Harness verbs that ask the shell about a card answer for bodies before the first kind batch.**
- **Why first.** `assertHostRootRegistered` and any verb of its shape ([F06]) go red on every file that calls them, whatever its kind. Fixing them inside a kind batch would spread one cause across every batch.
- **How.** They are found by reading `_harness/client.ts` and the test surface, and made to answer from the card's body when it has one.
- **The check.** This is a harness change, so the core tier runs once on it (`just app-test`), per `CLAUDE.md`'s CORE TIER ADVISED rule.
- **The kind handle (the mechanical slice).** The codemod's `--into-kind` moves a reach naming no card onto `kindBody(app, "<kind>")`, the card the file opens rather than seeds. Two facts shaped it. A file can seed several cards of one kind (one Workspaces card per workspace), so `bodyOfKind` takes the visible ready body and falls back to the first. And `kindBody` waits for its card, so it can never answer that the card has closed: `--into-kind` leaves a reach that tests for absence to a hand, which moves it onto the body when the absence is inside a standing card and reads the closed card from the host's body list otherwise (`hasBodyOfKind`, `waitForNoBodyOfKind` in `_harness/card-reach.ts`).

**[B05] The quarry is mined, never merged, and each of its findings is checked against main first.**
- **The quarry's changes.** Its harness and product changes ([F05]) are taken over one by one, where a batch needs them. They are not cherry-picked as commits: main has moved since, and `7864c3910` also carries file splits that the cut has since done differently or deleted.
- **The named gaps.** Each of the five product gaps is reproduced on main before it is fixed or dropped, and the brief records which way each went.

**[B06] Files that reach no card DOM come over in batches too, grouped by the kind they seat.** The 225 files of [F03] still launch an app whose cards will be bodies. Whether one passes unchanged is a run result, not a reading. Each is batched with the kind its deck seeds, or with a "shell" batch when it seeds none, and opts in like any other.

**[B07] No file goes over 20 s on bodies.** This is the cut brief's [B02]. A body costs more to stand up than a shell subtree, so a migrated file that crosses the line is split along its own `test(` blocks into an `@family`, made cheaper, or put on a removal list for the user. It is never carried over budget.

**[B08] The harness flips last among the test changes, in one change, when no file is left un-opted and the allow list is empty.**
- **The flip.** Every launch has bodies. The `bodies` option on `launchTugApp` and `TUG_BODY_VIEWS` are deleted, not defaulted: under [B09] there is no other mode to ask for.
- **The opt-ins.** The flip commit removes every `bodies: true` line, and the `bodies: false` lines the mechanical slice left.
- **The default, first (the mechanical slice, 2026-10-17).** Opting the remainder in file by file would have written a `bodies: true` into some 500 launches, many inside shared fixtures, only for the flip to delete them. So the mechanical slice turned the option's default on instead (`opts.bodies !== false` in `launchTugApp`, `real-transcript-fixture.ts` and `settle-frames-fixture.ts`), and the files held back say `bodies: false`: the removal list's `at0017`, `at0019`, `at0740` and `harness-smoke/smoke-capture-phase-save`, the body-focus facet's six, and `body-grounding/_row-12.ts`'s two no-switch legs. The option itself stays until the flip, which is then those launches and the option's declaration.
- **The final run.** The flip touches the harness, so the core tier runs on it once.

**[B09] Tug cuts over to bodies only, in this work (the user, 2026-10-16: "We really need to cut over to bodies only. Let's do so here. The only way is forward!").** Bodies stop being a mode:
- **No switch.** The tugbank `dev.tugapp.deck`/`bodies` setting, the Layout card's Bodies row, `BodyGeometry.bodyViewsEnabled` and `HostCapabilitiesScript`'s `bodyViews` are removed. A value left in a user's tugbank is ignored; with no installs in the wild there is no migration to write.
- **No in-document card host.** Every branch on `bodyViews` ([F09]) takes its bodies arm unconditionally. Code reachable only from the other arm — the in-document mount through `card-host.tsx`, and whatever serves only it — is deleted, along with the unit tests that exercise only that arm.
- **The order.** Planned last, after [B08], so an un-migrated file would keep guarding the path still under it; revised by [B10], which lets it come before the cause slices once the one run has been read.
- **A shell-only kind.** If a kind turns out not to be a body after all, it is made one in this arc rather than kept on the in-document host, since the host is what this decision deletes.
- **The check.** The cut-over touches the host and `tugdeck/src/main.tsx`'s startup, so the core tier runs on it once.

**[B10] The cut-over may come before the cause slices, not after them.** The plan put [B09] last, so an un-migrated file would keep guarding the shell path. Step 3 found the opposite risk: four core-tier files passed at Step 2 only because bound cards were not yet bodies, a green the shell's mount hands out. With the mount gone every red is honest, the user's daily deck already runs bodies-on, and the one run of [B01] is the all-at-once reading anyway. The order is settled at the mechanical slice, from what the run shows.

---

## Removals pending the user's approval {#removals}

Files and legs whose premise is gone on bodies, written by the batches that met them ([B02]). Each keeps its bodies-off launch and its allow pair until the user approves its removal; none was in its batch's verdict. The list is put to the user once, before the flip.

| File or leg | Found in | Premise that is gone | What else guards the behaviour |
|---|---|---|---|
| `at0017-savestate-rpc-parity` | batch 3 | the in-document host saves the first-responder card on window blur, and the `saveState` RPC bag must match that will-phase bag; a body page has no window-blur save (`body-deck-bridge.ts` saves on `saveNow` and its debounce only), and the blur save existed to keep the shell's reactivate-time bag restore fresh, which has no DOM to restore into for a body card | the body's `saveState` and `prepareForTermination` (`at0279-quit-draft-survival`, `at0018-async-content-race`) |
| `at0019-pane-teardown-flush` | batch 3 | `_closePane` fires each card's close-handoff save before any card-host unmount; a body card is destroyed with its pane unsaved, since its bag is about to be swept (`body-shell.ts`, the contract's "destroyed card" clause), and the shell's placeholder registers no save callback and emits no unmount event | the body termination path (`at0279`); the close-handoff order itself ends with the in-document host at the cut-over |
| `at0294-imposer-flip-settle`, the two legs whose mid-settle census asserts every pane animation touches `transform` and nothing else (`transform-only mid-window…`, `a deck-wide width change crosses too…`) | batch 4 | a settle animates only `transform` on pane frames; under bodies every pane behind a front body, or moving under one, gets a `clip-path` beat for the settle's length so the hole rides with the body (`body-placement.ts`, `cutMoving`, [B04] of the per-card web views brief), by design | the file's other two legs (no inline transform after the settle, the retarget) still run; the cut's own geometry is `body-placement.test.ts`'s |
| `harness-smoke/smoke-capture-phase-save`, all three legs | batch 5 | the shell saves the outgoing card in the capture phase of the gesture that deactivates it (`pane-focus-controller`'s capture-phase pointerdown, the tab bar's `onPointerDown`, the window-blur listener) before focus can move; a body card's input is in its own page, which the shell's pointerdown never sees, the shell's `invokeSaveCallback` reaches no callback for a placeholder, a body's deactivation fires `notifyCardDidDeactivate` and no save (`body-deck-bridge.ts`, `applyContext`), and the window-blur save is the one `at0017` already lists; a green here would be the body's own debounce landing inside the 150 ms pause, a timing rather than the premise | `at0024-m36` (the user-visible bag restore), the body's `saveNow` paths (`at0279-quit-draft-survival`), and the shell's capture-phase order itself ends with the in-document host at the cut-over |
| `at0740-body-switch` | the plan | its subject is the bodies switch, which [B09] removes | nothing needs to: there is no switch |
| `body-grounding/row-12-composer-no-switch`, both legs | the mechanical slice | without the switch the Session and Overview cards mount in the shell's own document and the host makes no body; [B09] removes the switch and that mount | nothing needs to: there is no switch; the slice holds both legs on `bodies: false` until the removal stop |
| `at0738-body-fallback` | the mechanical slice | a body that never reports ready fails at the deadline and its card mounts in the shell's own document; [B09] deletes that document mount, so there is nothing left to fall back to | nothing yet: what a stalled body does instead (retry it, or stand a failure placard in its frame) is the cut-over's to decide, and that decision brings its own test |

---

## Open Questions {#open-questions}

- **Do the five gaps `7864c3910` named still hold on main?** Answered by [B05]'s reproduction: four hold, one is gone. Each was run on `main` at `b4124dba2` with bodies on, through `tugtool file probe` (the tree restored after), one probed `just app-test` of five files, each patched to add `bodies: true` and move only the reach its gap needed onto the card's body. Every file was green bodies-off in its last recorded run. **(verified, run)**
  - **A Session-card body never receives a seeded bag through bind — holds, and starts earlier than stated.** On `main` a harness-bound Session card is not a body at all: after `seedDeckState` (with the bag) and `bindSession("A")`, `app.bodies()` held only the warm spare, and `assertHostRootRegistered("A")` answered true in the shell's own document. `bindSession` writes only the shell's binding store and hands nothing off, and the Session card is a spawn kind the deck scan skips (#context, the fifth fact). Fixed by Step 3 ([P13]) with the quarry's `bind` intent; batch 18's `at0024-prompt-state-roundtrip` is the guard that the body then holds the seeded text.
  - **tugcast asks reach only the shell — holds.** A Session card made a body by a real stub spawn (`spawnSessionNew`, ready and visible), then `tugtool host ask` aimed at its session: no dialog in the body within 15 s, none in the shell's document either, and the caller was answered `cancel`. tugcast addresses an ask to `PageTarget::Shell` only (`server.rs`), the `ask` action is registered only in the shell's `initActionDispatch`, and the Session card renders the dialog from its own page's `pendingAskStore`. The fix lands in the first session batch that meets it: batch 18 if `at0145-permission-dialog-keyboard` does, else batch 30 with `at0320-app-test-ask-dialog`.
  - **The Jots body never gets a `NEW_JOT` edit — holds.** `new-jot` on a deck with no Jots card made a ready Jots body, and no `.jot-editor` opened in it. Batch 1, with `at0241-jots-editor` as the guard. **Fixed in batch 1** by the `new-jot` card command (#quarry-against-main, "What batch 1 built").
  - **A second rail on one edge is never placed — gone.** In `at0538-rail-cross-side-drag`, all four rail cards' bodies (two on each edge) were ready, visible and inside their panes at the seed, and still were after the cross-side drop put three on the right edge. The drop itself passed unchanged on bodies. Nothing to fix; batch 11 runs the file as an ordinary member.
  - **Body activation promotes an anonymous responder — holds.** With two `gallery-input` cards in two panes as bodies (`at0165-activation-first-responder`, the Bug C leg), a trusted click on B's input in B's body left B's first responder on its body pane frame (`body-pane-B`), DOM focus on `BODY` rather than the input, and the shell's active card still `A`. A's body, focused at the seed, had its input as first responder. Batch 3, with `at0165` as the guard. **At batch 3 the click half is gone:** Bug C is green on bodies with no product change. **The seed half holds and is wider than stated:** a seeded active card's body puts its input in the native first responder at rest, where the shell leaves none, so the Edit menu lights Copy for a `gallery-label` (`at0174`); a shell canvas deselect leaves a body editor's Undo lit and ⌘Z does not reach a body input's native undo (`at0174`); the harness lifecycle verbs settle on the shell's `getHasFocus`, which never returns while a body holds the keyboard (`at0018`); and `at0269-gesture-classification`'s canvas gesture wait times out alone. `applyBagFocus` is not the cause: with no focus bag it focuses nothing. By the user's decision at batch 3, those three files stay bodies-off and the work is its own step, the plan's Step 38, before the removal stop. Batch 4 added two of the same facet: `at0420-case-transforms`'s label leg (Make Uppercase lights for a seeded `gallery-label`) and `at0295-background-activation-click` (the shell's `document.hasFocus()` stays false after an activating click into a body card). **What batch 4 built:** the pane occlusion controller read a coverer's opacity from its chrome background, and a body card's chrome is transparent by design (`.tug-pane[data-body-card] .tug-pane-chrome`), so no pane under a body card could ever hide; it now reads the title bar over the placeholder's lid (`pane-occlusion-controller.ts`, `surfaceAlpha`), guarded by `at0347-stack-badge-picker`'s occluded leg and a jsdom unit test. `at0294-imposer-flip-settle`'s two mid-settle census legs assert transform-only pane animations, and under bodies every pane behind or moving under a body gets a `clip-path` beat by design (`cutMoving`); they are in `removals.md`. **What batch 5 built:** three product gaps, each with its batch file as guard. A pane's resize handles lie half inside the frame, over the body (`.tug-pane-resize-s { bottom: -4px; height: 8px }`), and the host passed every point inside a visible body's frame to the body, so a bottom or inner edge could not be gripped at all and the east edge not at 50 % (`at0694`, `at0695`, `at0711`); each placement now carries the pane's handle rects as `grips` (`body-placement.ts`, `gripRects`) and the host keeps a point on one for the shell, front to back (`BodyHitRegion.frameIndex`), with unit tests on both sides. A body's menu push carried a mirrored gate for every card-scoped item, `file.openQuickly` among them, and a body never sees the shell's app modal, so Open Quickly… stayed lit under UpdateTug while a body was the key card (`at0627`); a body posts no gate for a `changesCardCount` entry (`host-menu-state.ts`, `bodyMenuPayload`). And a seed dropped cards without the destruction notice a real removal sends, so their bodies outlived every reseed — `at0712`'s editor kept its first visit's slash and its second visit's completion never opened; the seed now sends `notifyCardWillBeginDestruction` for every card it drops (`deck-manager-test-seed.ts`), which is why the core tier ran at this batch. A seed that changes a card's component under the same id keeps the body it has, which is the product's rule for a card whose component never changes, so `at0712` seeds one card per surface. `smoke-em`'s engine-ready event is read from the body's trace ring. `harness-smoke/smoke-capture-phase-save` asserts the shell's capture-phase save before focus moves, which no body gesture runs through; it is in `removals.md`. **Batch 6 added one of the body-focus facet:** `at0223-text-card-find-bar`'s ⌥⇥ from the find field — the chord reaches the shell's key-view walk (its `data-kbf` lights, focus parks on `body`) while the body's focus never leaves the field — so it is bodies-off with its allow pair, carried to Step 38 with the others. **What batch 6 built:** two product gaps, each with its batch file as guard. A Text card's ⌘-click on a document link opened the file through its deck store's `addCard`, which a body's bridge leaves inert (the deck's arrangement is the shell's), so from a body no viewer or Text card ever opened (`at0410`); `openAttachmentPath` now dispatches the shell's `OPEN_FILE` command, the route a Session body's `/ref` already takes, which the body's unanswered-command fallback carries to the shell and the shell answers with `openFileInCard`. And a pane-modal sheet's clip starts under the pane's title bar, which a body page does not have, so a Text card's options sheet in a 485 px body lost its Done row below the viewport, scrolled out of a panel capped at the page's canvas (`at0210`); `body-page.css` starts the clip at the top of the page. Three harness facts surfaced, each written into the test or the harness: a value a body card reads at mount — the Text card's save mode — is seeded into the tugbank the app launches on (`mkSeededTugbank`, `AUTOMATIC_SAVE_MODE`), because the shell's `setTugbankValue` writes only the shell page's client cache (`at0209`, `at0210`, `at0212`); the bridge's wrapper objects are not kept between accesses in a body page, so a test that replaces a handler's `postMessage` pins every wrapper it touches (`at0410`); and a copy in one body and a paste in another travel separate queues to the host, so the paste waits for the sidecar to reach the pasteboard (`at0415`). One observation is left for the session batches: a live `send` followed by a synthetic `assistant_text` rendered the user turn and never the reply in a Session body (`at0403`), where the replay shape every bodies-on Session file seeds with (`replay_started`, `add_user_message`, `assistant_text`, `turn_complete`, `replay_complete`) renders both; `at0403` seeds that way now, and whether the live shape should also render is batch 18's to settle with `at0191`.

---

## Non-goals {#non-goals}

- **Flipping every file at once with nothing under it.** Every-card-a-body steps 10–11 did that under a 10 s budget, with harness verbs the body could not answer and a codemod that did not compile, and it was retracted ([F05]). The one run of [B01] is on what the arc's Steps 2 and 3 built, and it is a reading, not a landing.
- **Merging or cherry-picking the quarry.** Main has moved past it, and its file-level work predates the cut ([B05]).
- **Rewriting a file's subject while moving it.** A migration changes where a file reaches, not what it asserts ([B02]). A subject worth changing is its own decision.
- **Cutting more of the corpus in passing.** Removals go through a list the user approves ([B02], [B07]), not a batch's judgement.
- **Re-running the whole remainder after each fix.** It runs once, as the reading the cause list is built from ([B01]); after that a slice re-runs only its cluster's files. The core tier runs only where a harness change asks for it ([B04], [B08]).

---

## Exit {#exit}

**An arc opened this work and walked nine rounds** (the quarry delta, the per-card verbs, Session cards always bodies, and six kind batches); the user joined it onto main on 2026-10-17 and retired its plan. **The rest is interactive**, in a session on main, in slices the user commits ([B01]), the brief updated every slice. The slices, in order:

1. **The mechanical slice.** Codemod every remaining file's reaches onto the card's page, opt every file in, empty `card-dom-allow.json`, type-check.
2. **The one run.** The whole remainder on bodies, in chunks of about 25, recorded under a named selection; then the reds grouped by signature from the JSON report into a cause list the user reads.
3. **The cause slices**, one per cause, each re-running only its cluster ([B03]). The body-focus facet the arc already named (`at0018`, `at0174`, `at0223`, `at0269-gesture-classification`, `at0295`, `at0420`) is one of them. Whether the cut-over ([B09]) comes before these is settled from the run ([B10]).
4. **The removal stop.** The list above, with whatever the run adds, put to the user once.
5. **The harness flip ([B08]),** deleting the `bodies` option.
6. **The cut-over ([B09]),** if not already taken: the switch and the in-document card host removed from host and shell, and the core tier run once.
