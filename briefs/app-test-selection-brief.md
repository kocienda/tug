# A run runs what your change could have broken

**Purpose:** An arc about path resolution in the annotator launched `Tug.app` 167 times in 41 minutes, and 140 of those launches were a fixed twenty-file list that could not have been affected by the diff. Thirty-five seized the screen. This brief settles what a run is allowed to run, and what a test is *for*, so that a selection is a claim somebody can read and disagree with rather than a reflex.

---

## Purpose {#purpose}

The user, watching an arc's checkpoints go past:

> WTF did this run the same stupid tests over and over that seem to have ***nothing to do with*** the changes we're making. Seriously... switching tabs in a card is relevant? Browser-native controls are relevant? I think not. It's also *maddening* that these tests take over the interface, which interrupts my work for no reason I can fathom.

Both examples were real, and both came from the same twenty-file list. `at0001-tab-switch-fc.test.ts` ran seven times during an arc that touched the annotator's verdict cache.

Then, on being shown that one of those twenty had been failing for a day:

> Look, basically none of these tests we have are *gospel*. They're aids. If one of these tests has been failing, and I haven't noticed anything wrong (and I use this app *all day every day*), then there's no need to bother with it.

That is the more important half, and it is not a remark about one test. It sets the exchange rate the rest of this brief prices against: **an app-test costs a Tug.app launch, a slice of wall clock, and sometimes the screen; it earns its place by catching something the person using the app all day would not have caught.** A test that fails for a day without producing a symptom anyone noticed has already answered the question of what it is worth.

The standard, in one sentence:

> **A run runs what your change could have broken, and nothing else. Anything else in the selection has to be able to say why it is there.**

The second half carries as much weight as the first. `just app-test-changed` already prints, beside every selected test, the changed file that pulled it in. That line is the whole design — a test in a selection with no honest reason beside it is the defect, whether there is one of them or a hundred.

---

## Evidence {#evidence}

Measurements are from `apptest_results.db` over runs 1445–1461 (2026-09-05 07:05–07:46, the `ink-follows-file` arc), read with `just db-inspect apptest_results`, and from `tests/app-test/scripts/select-tests.ts` re-run against that arc's landed diff (`7103edc8c..3e986114a`).

**[F01] The fixed tier was 84% of the launches and 69% of the test seconds.** Seventeen runs in the window: seven with `sweep=core` (140 file-launches, 899s, 35 foreground launches) and ten with `sweep=explicit-files` (27 file-launches, 406s, 1 foreground launch). Total 167 launches and 1305s of test time inside a 41-minute arc. **(verified)**

**[F02] Every one of those seven runs reported `FAIL`, on a test already recorded red before the arc opened.** `at0168-menu-structure.test.ts` was red 7/7. The arc's `baseline.md` had already established it as red for the previous 11 recorded runs and named it as not this arc's. Fifteen minutes and thirty-five screen seizures spent re-reporting a known result that nobody could act on and nobody did — and, because it sat in the tier, it made the tier's `VERDICT:` line say `FAIL` every time, which is how a verdict stops being read. **(verified)**

**[F03] Nothing asked for that tier seven times; a recipe default supplied it.** `just app-test` with no arguments is the core tier, by design and clearly documented. But `just app-test-build` ends in `just app-test {{FILES}}`, so `just app-test-build` with no arguments is *also* the core tier. The recipe whose stated job is to force a fresh bundle silently also means "and now run twenty tests" — and forcing a build is exactly what a step that changed Swift, Rust or deck source must do, since `app-test` rebuilds only when the bundle is *absent*. The `CORE TIER ADVISED` advisory is not implicated: its triggers are the harness, `main.tsx` and `index.html`, and this arc touched none of them. **(verified)**

**[F04] The derived selection is far better and still a third noise, and the noise is structural.** Re-run over the arc's twenty changed files, `app-test-changed` selected 15 files with one foreground test. Two hub files account for the bulk of it:

- `tugdeck/src/test-surface.ts` pulls in four tests — `harness-smoke/smoke`, `harness-smoke/smoke-em`, `at0017-savestate-rpc-parity`, `at0367-overview-scrollback` — because they each `@covers` the whole file. The arc's change to it was **one added debug accessor** that only one test could reach. `at0017` is the single screen-taker in the entire selection.
- `tugdeck/src/lib/text-card-store.ts` pulls in four text-card tests. The arc's change to it **deleted a duplicated JSON parser and imported the identical one** from a new module — behaviour-identical by construction, four Tug.app launches to confirm it.

Deleting the one test that honestly covered the new accessor did not help: the selection went 15 → 14, the four unrelated coverers of `test-surface.ts` remained, and `at0017` is now selected with no honest reason at all. The coupling is a property of the hub file, not of any one test. **(verified — re-run after the deletion)**

**[F05] Unit-test files select app-tests.** Four of the twenty changed files were `tugdeck/src/lib/annotator/__tests__/*.test.ts` — `bun:test` unit files. They matched the subtree declaration `@covers tugdeck/src/lib/annotator/` and are printed as the reason for `at0225-clickable-slash-commands` and `at0307-transcript-file-path-links`. A unit test is not a source the app runs; editing one cannot change app behaviour. **(verified)**

**[F06] `@covers` names files, but changes are made to symbols.** There is no way for `at0017` to declare that it depends on `saveState` rather than on all of `test-surface.ts`, so a hub file is all-or-nothing. The subtree form is the same problem one level up: `@covers tugdeck/src/lib/annotator/` makes every sibling module equal, which is why a verdict-key change selects a slash-command test. The script already treats hub fan-out as the enemy — `ACCEPTED_FANOUT` records today's hubs with their observed counts and `--check` fails when one climbs — but a ratchet can only hold a number, never make a declaration finer. **(verified)**

**[F07] The machinery is not missing; the tier walks past it.** Already built and working: a hard selection budget that refuses rather than sweeps (`MAX_SELECTED = 20`, no override flag, deliberately); the fan-out ratchet; `@covers` linted in both directions; `@foreground` declarations checked against real behaviour; background-by-default launches; screen-takers held to last behind a declinable thirty-second countdown, with `TUG_APPTEST_ASSUME` for scripted runs; and a per-file history line on every red. The core tier is a hardcoded list, so no budget applies to it, no `@covers` is consulted, and its foreground members raise the question every time it runs. **(verified)**

**[F08] So the interruption is a selection problem wearing a foreground costume.** Thirty-five of the arc's thirty-six screen seizures came from the tier that is by construction not about the change; the derived selection for the same work had one, and that one was `test-surface.ts` noise. Fixing what gets selected removes nearly all of the interruption without touching the foreground policy. **(verified)**

**[F09] Deleting a test is more expensive than it should be, because durable doctrine cites tests by name.** `at0168-menu-structure` is named as a pinning test in `tuglaws/design-decisions.md` under **D124**, **D129** and **D172**, in `notes/window-sidebar-brief.md` under `[B11]` and `[B13]`, and in the prose of four sibling tests (`at0403`, `at0281`, `at0501`, `at0241`). Removing the file leaves every one of those references dangling, and nothing detects it. A corpus whose members are aids rather than gospel has to be cheap to prune, and this is the friction that makes pruning feel like vandalism. **(verified)**

**[F10] Nothing requires a source file to be covered, and that is already true in practice.** The selector prints "no app-test covers these changed files" as information; `--check` enforces `@covers` on *tests*, never coverage of *sources*. After this arc, `tugdeck/src/lib/filesystem-feed.ts`, `tugdeck/src/lib/session-citation-store.ts` and `tuglaws/entity-presentation.md` are uncovered, and the corpus is not broken by that. **(verified)**

---

## Decisions {#decisions}

**[B01] A test earns its place by catching something the user would not have caught; one that fails without producing a noticed symptom is deleted, not triaged.** This is the exchange rate everything else prices against, and it is the user's call, stated in their own words in [Purpose](#purpose). It rules out the reflex that a red test is a debt to be serviced: a test is an aid, and an aid that has been wrong for a day while the app behaved fine has told you what it is worth. It rules in deleting on sight, without a replacement, without a ticket, and without an argument about coverage. What would revisit it: a red test that *did* correspond to a symptom the user hit — then the test was right and the deletion would have cost something real. Applied already: `at0168-menu-structure.test.ts` and `at0521-ink-follows-file.test.ts` are deleted, and `at0168` is out of the core tier list, which is now nineteen files with four screen-takers instead of five.

**[B02] A recipe never runs tests nobody named.** `just app-test-build` builds the bundle and stops; it keeps forwarding whatever files it is given, so `just app-test-build at0307-….test.ts` is unchanged. This is the highest-value change in the brief and the cheapest: on this arc's evidence it removes 140 of 167 launches, 15 of the 21 minutes, and 35 of the 36 interruptions, and costs nothing anybody asked for. The core tier is not weakened or renamed — it stays exactly what it is, reachable as `just app-test` with no arguments, which is a sentence that says what it does. What it rules out: any future recipe acquiring a test sweep as a side effect of its real job.

**[B03] A change that cannot change behaviour selects nothing.** Test files come off the *source* side of selection: `**/__tests__/**`, `*.test.ts`, and `tests/app-test/**`. An app-test you edited still runs — it is named, not selected — but it stops resolving through anybody else's `@covers`. Closes [F05] with no judgment call in it and no cost: there is no scenario where editing a `bun:test` file changes what the app does.

**[B04] The harness's own surface is not evidence of coverage.** `tugdeck/src/test-surface.ts` comes off the source side too. The argument is that nobody changes it speculatively: an accessor is added *because* a test being written needs it, and that test is in the same diff and selects itself by name. So the four launches it provokes — including the selection's only screen-taker — buy nothing that naming the test would not have bought. The residual risk is real and worth stating: changing an *existing* accessor's semantics could break a caller that is now not selected. That is mitigated by `tsc` for shape, and by the fact that such a change is deliberate work on the harness, where naming the affected test is the natural gesture. What would revisit it: an actual escape — a `test-surface.ts` change that broke a test nobody ran.

**[B05] A subtree `@covers` is debt and gets the ratchet the fan-out already has.** Not banned: `@covers tugdeck/src/components/jots/` is honest for a card. But `--check` records how many declarations use the subtree form and how wide each resolves, and fails when a number climbs — the same rule as `ACCEPTED_FANOUT`, in the same file, one more column. This is what keeps [F06] from re-growing after [B03] and [B04] cut today's instances of it.

**[B06] An uncovered source file is a fact, not a deficiency.** The selector keeps printing which changed files no app-test covers, because that is useful information at the moment you are deciding what to run. Nothing is added that treats it as a failure, and no rule is introduced requiring a source to be covered. Under [B01] this follows directly: coverage is not the goal, catching real symptoms is, and a rule requiring coverage would manufacture exactly the tests [B01] says to delete.

**[B07] Nothing changes about the foreground policy.** [F08] is the argument: with [B02]–[B04] in, this arc's selection contains no screen-takers at all, and the countdown-and-decline design is the right shape for the rare one that remains. Recorded as a decision rather than a non-goal because it was the user's stated complaint and the answer is "fixed upstream, deliberately, not here".

---

## Open Questions {#open-questions}

- **What replaces a citation when a cited test is deleted?** [F09] is unresolved: `tuglaws/design-decisions.md` names app-tests inside decisions D124, D129 and D172, and those names are now dangling. Three candidate answers — stop naming tests in durable doctrine at all (they are the most perishable thing a decision can cite); keep naming them but add a lint that catches a dangling citation; or accept the dangling names as historical record of what pinned a decision *at the time*, and say so once in the doctrine so nobody chases them. This needs the user's judgment about what `design-decisions.md` is *for*, and it is the one question here that the code cannot settle.
- **Is per-symbol `@covers` worth building?** [F06] describes the general form of the hub problem, and `@covers path#symbol` resolved against diff hunks is the general fix. But [B03] and [B04] remove today's two instances, and what remains (`focus-manager.ts` at 28, `deck-manager.ts` at 21) is genuine coupling rather than sloppy declaration. Recommendation: land [B02]–[B05], re-measure from `apptest_results.db` after a week of arcs, and let the number decide. Building it now is real machinery for a problem that may have stopped existing.
- **Should the budget's refusal apply to the core tier?** It is nineteen files against a `MAX_SELECTED` of 20, so it would pass today and fail on the next addition. Making the tier justify itself through the same gate is either healthy symmetry or one turn of the screw too many.

---

## Non-goals {#non-goals}

- **Making the corpus faster, or headless.** A covered harness window suspends `requestAnimationFrame`, so paint-settle work genuinely needs the window visible. That constraint is real and this work does not fight it; the answer to expensive tests is to run fewer of them, not to make them lie.
- **Deleting the core tier.** "Does the app fundamentally work" is a real question and the curated nineteen are a good answer to it. The tier is not the problem — being the answer to a question nobody asked is.
- **Weakening the selection budget.** The refusal-with-no-override is right, and [F07] is the evidence: every part of this system that had teeth held, and the waste got in exactly where there were none.
- **Per-test opt-outs for the foreground countdown.** The interruption is a symptom ([F08], [B07]).
- **Backfilling coverage for the files this arc left uncovered.** [B06] and [F10]. Writing tests to close a report line is how the corpus grew the members [B01] now deletes.
- **Rewriting the deleted tests somewhere else.** [B01] means deleted, not relocated — and deleting a test deletes what existed only to serve it. `at0521` was the only caller of the `auditPathFaces` accessor on `tugdeck/src/test-surface.ts`, which was the only consumer of `tugdeck/src/lib/annotator/path-face-audit.ts`, whose own unit test covered a function nothing else called. All of it went with the test, in one gesture rather than as a loose end left for whoever next opened those files.

---

## Exit {#exit}

**A plan**, and a short one — four of the seven decisions are edits to two files.

The first phase is the whole of the win and carries no risk: [B02] in `Justfile` (`app-test-build` stops forwarding to a bare `app-test`), and [B03] plus [B04] in `tests/app-test/scripts/select-tests.ts` (an exclusion list on the source side of the resolve). Each is a few lines, and each is verified the same way — `bun scripts/select-tests.ts --print` over the `7103edc8c..3e986114a` diff, which should fall from fourteen files to about seven with no `@foreground` member and no `*.test.ts` printed as a reason.

The second phase is [B05], the subtree-form ratchet in `--check`, which is new lint state and wants its own step: record today's counts, fail on a climb, and confirm the existing corpus passes unchanged.

The phase boundary is between them: the first ships the measured savings, and the second is prevention that only matters once the first has landed. [B01] is already applied and needs no step; [B06] and [B07] are decisions to *not* build things and need none either. The open question about citations ([F09]) should be settled with the user before the plan is devised, since one of its answers adds a lint to the second phase and the others add nothing.
