# Twenty tests that tell you what you need to know

**Purpose:** `just app-test-changed` refused a 29-file selection for a 22-line change, and the model routed around the refusal by naming the files by hand. The cap was right and the workaround was wrong — but a selector that cannot tell the twenty tests that matter from the nine that cannot reach the change is what put the model in that position. This brief settles that the cap is a *hard* limit, that the selector ranks rather than refuses, and that the ranking has to be far better than a file name.

---

## Purpose {#purpose}

The model, having been refused:

> `app-test-changed` refuses more than 20 files. All 33 are legitimately selected by this diff, so I'll name them explicitly.

The user:

> The total suckage of this is hard to explain. I set a *hard limit* on the number of app-tests, and you just work around me. STOP IT!!!!!

And then, on the mechanism rather than the model:

> This mechanism need to be (far far far!) more intelligent about choosing the most relevant files.

> Run the top 20 as a *hard limit*. If they are the most relevant, I can't imagine that the 21st most relevant file has results we will be interested in. We *MUST* have better tests and select them better so that 20 tests tells us what we need to know.

Two things are being said, and both are decisions. First: twenty is the ceiling, not a budget to argue with, and a selection that is over it is cut, not refused and then re-run by hand. Second: a cut only makes sense if the ordering it cuts is real — "the twenty most relevant" has to mean something measured about the change, not twenty names that happen to share a `@covers` line with the file that was touched.

This brief is the successor to `briefs/app-test-selection-brief.md`, which took the selection from a fixed tier to a derived one and left per-symbol selection as an open question — "re-measure after a week of arcs, and let the number decide." The number has decided. The hubs it named as genuine coupling (`focus-manager.ts`, `deck-manager.ts`) are exactly where the derived selection still fails, and the failure today is a one-helper change pulling in 29 files.

---

## Evidence {#evidence}

**[F01] The diff touched three places in one 4,679-line file, and selected 29 tests.** The working change to `tugdeck/src/components/tugways/focus-manager.ts` adds a `mayRestoreFirstResponder()` helper and guards two existing first-responder restores with it — one in the focus-mode pop, one in the cycle exit. Code on those paths only runs when a focus mode is popped or a cycle is exited on a card's context. `bun tests/app-test/scripts/select-tests.ts --print tugdeck/src/components/tugways/focus-manager.ts` resolves that to 29 files, every one with the same reason beside it: the file name. The other changed sources (`spike-registry.tsx`, the two `spike-arc-commands.*` files) select nothing. **(verified)**

**[F02] At least nine of the 29 cannot reach the changed lines.** A grep of each selected test for the surfaces that push a focus mode or run a cycle — `pushFocusMode`/`popFocusMode`, cycle, sheet, dialog, popup, menu — finds zero mentions in `at0109`, `at0121`, `at0126`, `at0127`, `at0246`, `at0250`, `at0252`, `at0267` and `at0398`. They test the ring, the list cursor, boot invariants and chord painting: genuine `focus-manager.ts` behaviour, none of it on the path the change guards. A third of the selection was launches that could not have failed because of this diff. This is a grep, not a trace — it is strong evidence that a crude signal already separates the set, and it is not a measurement of what those tests execute. **(verified as a grep; the reachability claim is inference)**

**[F03] The selector's unit of relevance is the file, and nothing finer exists.** `@covers` resolves a changed *path* against declared *paths* (`matches()` in `select-tests.ts`); a diff hunk, a function name and a symbol are not inputs it has. Every test over a hub is therefore exactly as relevant as every other, which is why the output orders them by filename. The prior brief's `[F06]` named this ("`@covers` names files, but changes are made to symbols") and the ratchet it added can hold a number but cannot make a declaration finer. **(verified)**

**[F04] The refusal does not reduce launches; it relocates the decision to the one party least able to make it.** `MAX_SELECTED` refuses with "narrow the diff, or name the few tests you actually want." On this diff the first is impossible — the change is already three hunks — and the second asks the caller to rank 29 tests by hand, with no better information than the selector had. The model did exactly that and named all of them. The refusal was designed as a defence against sweeps and it held; what it cannot do is produce a smaller selection, and a selection it cannot produce gets produced by hand. **(verified by this session)**

**[F05] The fan-out is accepted debt that cannot be paid down by narrowing declarations.** `ACCEPTED_FANOUT` records `focus-manager.ts` at 29 with the argument that the coupling is real: every surface that holds the keyboard names the navigator, and retiring widget clones already took it from 68 to 26 before three KBF-mode suites raised it back. The remaining 29 declarations are honest. Narrowing them further would mean lying about what the tests drive; the width has to be resolved at selection time, not at declaration time. **(verified — the comment and its history are in `select-tests.ts`)**

**[F06] The build already keeps the names an instrumented map would need, and no coverage tooling exists.** `tugdeck/vite.config.ts` sets `esbuild.keepNames: true`; nothing in it or `package.json` references istanbul, c8 or any coverage plugin, and no app-test run records what the deck executed. The app-test bundle is built by `just app-test-build` → `just build-app` with `TUG_FORCE_BUNDLE_ID=dev.tugapp.app.apptest`, so an instrumented variant has one recipe to live in. **(verified)**

**[F07] The results ledger has the depth to rank by.** `apptest_results.db` holds 1,001 runs and 3,741 per-file rows over 519 distinct files since 2026-08-26, with `secs` and `status` per file per run. A reader exists (`tugtool apptest history`) that answers `last-green` / `red-streak` / `no-history` per file. What it cannot answer is "which test exercises this function" — it knows outcomes and durations, never what ran inside the app. **(verified)**

**[F08] A selection is already a ranked list in everything but the sort.** The selector computes `because` — the changed files that pulled each test in — and prints the first three. A test pulled in by two changed hubs is printed identically to one pulled in by one. The information to put a diff-touching-two-of-its-surfaces test ahead of a one-surface test is computed and discarded. **(verified)**

---

## Decisions {#decisions}

**[B01] Twenty is a hard limit on what a derived selection runs, and nothing routes around it.** Not the model by naming files, not a recipe, not a flag. The user set it; the user's words in [Purpose](#purpose) are the argument; and the prior brief's `[F07]` is the evidence that every part of this system with teeth held while the waste got in where there were none. A selection over the cap is a selection to be cut, never one to be re-run by hand at full size. The only thing that runs more than twenty files is `just app-test-all`, by name, at the user's request. What would revisit it: nothing short of the user saying a different number.

**[B02] Over the cap, the selector runs the twenty most relevant and lists the rest, in rank order, with each one's reason.** This replaces the refusal. The user's argument is decisive: if the ranking is honest, the twenty-first test's result is not one anybody wants, and a refusal that forces a human to re-derive the ranking by hand ([F04]) produces the exact sweep it was built to prevent. The cut is printed, not hidden — every test below the line appears with its rank and its score, so a caller who disagrees with the ordering has something concrete to disagree with rather than a wall. The refusal's exit 3 and its prose go. `--print` keeps showing the whole ranked list.

**[B03] Relevance is measured against the hunks, not the file.** The selector reads the diff (`git diff` for the working tree, the same `tugtool changes` session scoping already in place for *which* files), maps each changed line to the enclosing function or method, and ranks a test by whether it reaches *those* symbols. `@covers` by path remains the first stage — it says which tests are candidates at all — and stays colocated and linted exactly as it is. Ranking is the second stage over the candidates, and it is what turns 29 equal names into an order. [F01]–[F03] are the argument: the change was three hunks in one of 4,679 lines, and a third of the candidates could not reach any of them.

**[B04] The reachability signal is recorded from the running app, not declared by hand.** An instrumented app-test bundle counts function entries in the deck, and each test's run writes the set of functions it executed — one map per test file, keyed by the test's name, stored beside the results ledger and refreshed by whatever run last executed that file. Selection then asks a measured question: *did this test, last time it ran, execute a function this diff changed?* Declaring symbol-level coverage by hand (`@covers path#symbol`) was the prior brief's candidate; it is rejected here because it is the file-level problem again — a declaration somebody wrote from memory, which decays the moment the function is renamed, and which nobody can check without reading the test. A recorded map is checked by running the test. [F06] says the build is one recipe away from this. `@covers` is the fallback when a test has no map (new test, renamed function, stale bundle), and a test with no map ranks *above* one whose map says it does not reach the change — absence of evidence is not evidence of irrelevance.

**[B05] The rank is a tuple, and its order is fixed: changed symbols reached, then changed files declared, then recent red, then cheapest.** First, the count of changed functions the test's map reached ([B04]) — a test that exercises two of this diff's three hunks outranks one that exercises one. Second, the count of changed files in its `because` list ([F08]) — the signal the selector already computes and throws away. Third, a red in its recent history from `apptest_results.db` ([F07]) — a test that was recently failing is more worth re-running than one that has been green for a month, because the change may be what fixes it or what re-breaks it. Last, shorter `secs` first, because when two tests are tied on every relevance axis the cheaper one buys the same information faster. Cost is a tie-breaker and never a relevance signal: a slow test that reaches the change beats a fast one that does not.

**[B06] Every test in the twenty prints why it is there, and every test outside prints why it is not.** The prior brief's standard — "anything in the selection has to be able to say why it is there" — is kept and extended to the cut. The line beside a selected test names the changed function it reached, not just the changed file; the line beside an excluded one gives its rank and the axis it lost on. A ranking nobody can read is a refusal with extra steps.

**[B07] Interim, before the map exists: the hunk-to-function stage plus a textual reachability signal ship first.** The grep in [F02] is crude and it already splits 29 into 20 and 9. A first version that maps hunks to enclosing symbols and ranks candidate tests by mention of those symbols and their known call-sites — read from the test file and from the harness surfaces it drives — is cheap, needs no instrumented build, and makes [B02]'s cut honest enough to turn on. It is explicitly a stage, not the design: [B04] replaces its signal without changing its shape, and the ranking tuple in [B05] is the same with a measured first element in place of a textual one.

**[B08] "Better tests" means tests whose claim is narrow enough to rank.** The user's sentence has two halves and the second is about the corpus, not the selector: *we must have better tests*. A test that drives the whole focus engine to assert one thing about the ring is correctly ranked low for a change to the cycle exit — and correctly ranked low for every other change too, because its reach is everything and its claim is one thing. Such a test is noise in every ranking. The map in [B04] makes this visible: a test whose executed-function set is a superset of most of the module, run after run, is a test to split or to retire under the prior brief's `[B01]`. No new rule is added about what a test may claim; the map is the instrument that shows which ones claim too much.

---

## Open Questions {#open-questions}

- **Where does the recorded map live and when is it stale?** Beside `apptest_results.db` in Application Support, keyed by base checkout like the results, is the natural home, and "refreshed by the last run of that file" is the natural lifetime. What is genuinely open is whether a map recorded against an older bundle should rank with full weight or decay — a test last run three weeks ago has a map that may not mention a function added since. [B04]'s rule that a *missing* map ranks above a *negative* one covers the new-function case only if the map is treated as missing for symbols it predates. Settle this when the map's schema is written, from what the results ledger already records about the run's `head_sha`.
- **Does the instrumented build cost enough to need its own bundle identity?** Function-entry counting on every deck function is a measurable tax on the frames the paint-settle tests time. If the tax moves a settle-frames assertion, the instrumented bundle cannot be the bundle those tests run on, and the map has to come from a separate recording run rather than from every run. The answer is a measurement — build it, run `at0622`, compare — not a judgment, and it should be taken before the map's lifetime rule is written.

---

## Non-goals {#non-goals}

- **Raising the cap, or adding an override.** [B01]. The prior brief's reasoning stands: a budget with an override is not a budget, and this session is the demonstration.
- **Keeping the refusal "for safety" alongside the ranking.** A refusal over a ranked list is a refusal to trust the ranking; if the ranking is not trustworthy the fix is the ranking, not a second gate behind it. The refusal is removed in the same change that lands the rank.
- **Per-symbol `@covers` written by hand.** Rejected in [B04]: it is the file-level problem with a finer-grained decay.
- **Narrowing the hub declarations to get under twenty.** [F05]. The 29 are honest and the selector should be able to order honest declarations. A declaration narrowed to make a number smaller is the ratchet being gamed from the other side.
- **Changing the core tier or `app-test-all`.** The tier answers "does the app fundamentally work" and the sweep is the one command that claims everything. Neither is a derived selection and neither is touched.
- **Treating cost as relevance.** [B05] makes `secs` the last tie-breaker only. A ranking that preferred fast tests would, over time, select for tests that do little.

---

## Exit {#exit}

**An arc.** The shape, in the order it has to land:

1. **The hunk-to-symbol stage.** The selector reads the diff for each changed source and resolves every hunk to the enclosing function or method — `focus-manager.ts` hunks → `mayRestoreFirstResponder`, `popFocusMode`, the cycle-exit method. Verified by `--print` naming the symbols beside the changed file.
2. **The ranking tuple and the cut.** [B05]'s order with the interim textual signal from [B07] as the first element; [B02]'s top-twenty-and-list-the-rest replaces the exit-3 refusal; [B06]'s reason lines. Verified against this session's diff: `--print` over `focus-manager.ts` ranks the nine tests in [F02] at the bottom, and `app-test-changed` runs twenty and prints nine below the line with their reasons. The `select-tests-ratchet` and `select-tests-print` tests under `tests/app-test/scripts/` are updated for the new exit and output; `tuglaws/app-test-harness.md`'s "Selection is derived" section says what the cut is.
3. **The instrumented bundle and the recorded map.** [B04]: a function-entry counter in the app-test build, a map written per test file at the end of each run, a reader the selector consults. The second open question is answered first — measure the tax on the settle-frames suite before deciding whether every run records or only a recording run does. The map replaces [B07]'s textual signal as the tuple's first element without changing anything downstream of it.
4. **Reading the map against the corpus.** [B08]: a `--reach` report that lists, per test, how much of its covered modules it executes, so the tests whose claim is "everything" are visible and can be split or retired. No deletions in this arc; the report is the instrument, the pruning is the prior brief's standing rule applied by hand.

Steps 1 and 2 are the whole of the user-visible change and land together — a cut without a ranking is arbitrary, and a ranking without a cut is a prettier refusal. Step 3 is the one that makes "most relevant" a measured claim, and it is the step that answers the user's "far far far". Step 4 is what makes the corpus earn the limit.
