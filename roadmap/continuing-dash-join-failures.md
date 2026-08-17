# Continuing dash-join failures — the brief

**Written 2026-08-17.** On this date the Changes shade's Join surface failed again, in the release instance, on a real dash, with the rebuilt code — and for the first time it left evidence. This brief records what was captured, what that evidence proves, what it does not, and the full inventory of defects the investigation turned up. It exists because the owner stopped the ad-hoc repair mid-fix: the problem is not one bug but a family of them sharing a single cause, and a family wants a plan, not a patch.

Nothing here is speculative repair. Where a claim is inferred rather than observed it is marked so.

## The incident {#incident}

The `observer-rename` dash was implemented across seven steps, built, marked `built`, and left with a join draft — the ordinary end of a `dash-implement` run. The owner opened the Changes shade in the release instance, aimed at the dash, entered join mode, and pressed the land button. **Nothing happened.** No landing, no error, no message, no movement. The composer stayed in join mode with the typed message intact.

After roughly two minutes of this the owner landed the dash from the terminal with the CLI. The code reached `main` as `189564171`.

This is the same report the [dash-closure-brief](dash-closure-brief.md#join-hunt) has carried as unreproducible since it was first filed — the surface reading as "completely non-functional in real use." It has now been reproduced with a receipt.

## What was captured {#captured}

The release instance's own log holds the first hard evidence this hunt has ever had. From `~/Library/Application Support/Tug/instances/release-main/Logs/tugcast.log.2026-08-17` (times UTC):

```
13:11:58.401  dash-join: completed dash=observer-rename base=main previewed=true commit="-" conflicts=0 blockers=
13:11:58.545  dash-join: completed dash=observer-rename base=main previewed=true commit="-" conflicts=0 blockers=
13:12:17.151  dash-join: completed dash=observer-rename base=main previewed=true commit="-" conflicts=0 blockers=
```

The CLI join landed at 13:14:36 — about two minutes after the last of these.

That receipt line exists only because the backend campaign added it; its own comment in `agent_supervisor.rs` notes that *"the two joins of 2026-08-15 left no trace in any log, which is why the next incident report was an investigation rather than a read."* That instrumentation is what turned this occurrence from another dead end into a diagnosis.

### What the evidence proves {#proven}

1. **The preview path works, end to end.** Three `changeset_join` requests reached tugcast, ran through `tugdash-core`, and came back clean: zero conflicts, zero blockers. The deck, the wire, the backend, and the git layer are all functioning.
2. **The land was never sent.** Every request carries `previewed=true` and `commit="-"`. No request with `preview: false` was ever received. The failure is entirely deck-side and happens *before* anything reaches the wire.
3. **Nothing was refused by the backend.** There is no `changeset_join_err`, no blocker, no conflict. The server was never asked.
4. **Three previews, not one.** Two 144 ms apart (the aim and the enter, each of which previews by design) and a third 19 seconds later (a re-aim or re-enter). Consistent with a user opening the row, entering the composer, and trying again.
5. **The composer stayed in join mode with its text intact** — the owner's own observation, and it discriminates between the two candidate mechanisms below. It rules out the staged-landing path having run at all, and points at the gate.

### What the evidence does not prove {#not-proven}

**Which gate condition refused is still unknown.** This is the one open question, and it must not be guessed at. See [#which-condition](#which-condition).

## The cause: the landing gesture is silent by construction {#cause}

The land gesture's whole path is three hops, and two of them can fail without saying anything.

**Hop one — the composer.** `performSubmit` in `tug-prompt-entry.tsx` is the single caller of `land()`. In landing mode it calls it and returns, with no reference to whether the land button is enabled:

```ts
if (inLandingModeRef.current) {
  landingModeRef.current?.land(view.state.doc.toString());
  return;
}
```

The comment above it blesses the behavior in as many words: *"`land` re-checks the gate (turn / pending / empty), so an empty message or a running turn **no-ops here** and the draft is left intact."* The disabled state of the button is not consulted; a press, a `⌘⏎`, and a `⇧⏎` all funnel here and all rely on `land()` to refuse quietly.

**Hop two — the gate.** `JoinModeController.land()` returns on a refused gate and says nothing:

```ts
land(message: string): void {
  const text = message.trim();
  if (!this.liveGate(text).ok) return;      // ← silent
  const runJoin = () => this.performJoin(text);
  if (this.landHook !== null) this.landHook(runJoin);
  else runJoin();
}
```

`CommitModeController.land()` has the identical shape and the identical `if (!gate.ok) return;`. **The `/commit` lane has the same dead-button failure mode**; it has simply not been hit yet, or has been hit and read as something else.

**Hop three — the staged landing.** If the gate passes, `runJoin` is not run. It is parked in `stagedCommitRef` by the land hook, and the hook exits the mode and expects the shade's `sheetDidHide` to run the parked callback 150 ms later. `JoinModeController.exit()` does not hide the sheet; the hide rides an effect keyed on `anyLandingActive = commitModeActive || joinActive`. If that expression does not transition to false — for instance because the other landing mode is somehow also active — the sheet never hides, `sheetDidHide` never fires, and **the landing sits in a ref forever with no error, no timeout, and no trace**. The owner's observation rules this path out for *this* occurrence, but it remains a live hazard.

### The refusal had a sentence, and it was discarded {#discarded-sentence}

This is the part that stings. `joinDisabledReason` already turns every gate refusal into a human sentence — *"Wait for the turn to finish"*, *"Previewing…"*, *"Resolve the conflicts first"*, *"Review what the ladder resolved first"*, *"Nothing to join"*. Its docblock explains that it lives beside the gate precisely so that *"two surfaces need it… and a refusal that reads differently in two places is worse than one that reads tersely in both."*

That sentence reaches exactly one place: the **tooltip** on the land button, via `landBlockedReason`. You have to hover a control that looks pressable to learn why pressing it did nothing. `land()` computes the same refusal and throws it on the floor.

### Join has no error surface at all {#no-join-surface}

The card mounts notice controllers for commit (`commit-error-notice-controller.tsx`), claim (`claim-error-notice-controller.tsx`), and dash binding (`dash-bind-error-notice-controller.tsx`). **There is no join equivalent.** `JoinModeSnapshot.landError` is populated by `derive()` from the verb store's join error and then read by nobody — dead state.

So even a *server*-side join failure has no surface. `CommitErrorNoticeController`'s own docblock describes exactly the bug it was written to kill: *"a refused commit read as the sheet flashing and returning with no word of why."* That fix was never given to join.

## Inventory of silent failures {#inventory}

Every early return in the two landing controllers that can swallow a user gesture. Not all are defects — several are legitimate "nothing to do" guards — but the load-bearing ones are marked.

| Site | Condition | Verdict |
|---|---|---|
| `tug-prompt-entry.tsx` `performSubmit` | landing mode: calls `land()` regardless of button state | **Defect** — the submit path has no idea whether the land can happen |
| `join-mode-controller.ts` `land()` | `!liveGate(text).ok` | **Defect** — this occurrence's proximate cause |
| `commit-mode-controller.ts` `land()` | `!gate.ok` | **Defect** — same shape, same silence, in the commit lane |
| `join-mode-controller.ts` `performJoin()` | `!gate.ok` on the staged re-check | **Defect** — refuses a beat later, still silently |
| `commit-mode-controller.ts` `performCommit()` | `!gate.ok` on the staged re-check | **Defect** — same |
| `join-mode-controller.ts` `performJoin()` | `verbStore === null` | **Defect** — a missing store is an internal fault, not a no-op |
| `commit-mode-controller.ts` `performCommit()` | `verbStore === null` | **Defect** — same |
| `session-card.tsx` `stage()` → `sheetDidHide` | sheet never hides → parked callback never runs | **Defect** — unbounded, untraced, unrecoverable |
| `join-mode-controller.ts` `preview()` | `target === null` | Benign guard |
| `join-mode-controller.ts` `enter`/`exit`/`persistMessage` etc. | `target === null` / `!this.active` | Benign guards |

## Why the corpus never caught it {#why-tests-missed}

Eight test files name the join path. **None of them presses the land button.**

- `at0417-join-mode.test.ts` asserts the land button *names* the act — it waits for the button to read "Join". It verifies the word, not the gesture.
- `at0418-join-outcomes.test.ts` drives real `--preview` calls and, for its one end-to-end landing, drives **release** rather than join. Its docblock says so plainly.
- `at0425` / `at0426` cover conflicted landings and resolution review.
- `join-mode-controller.test.ts` and `session-changes-dash-landing.test.ts` are pure-logic tests over the controller and the face.

The whole chain — composer submit → gate → land hook → mode exit → shade dismiss → `sheetDidHide` → `performJoin` → wire — has **zero coverage**. Every test either stops before the press or reaches the wire by another door. That is why five green lane files coexisted with a surface that could not land.

## Why this took days {#why-hard}

Because the failure mode of this surface is silence, and silence leaves nothing to investigate.

Each previous round hardened the things *around* the defect — refusals that state their reason in the lane, disabled controls that look disabled, route-attributed landing receipts, truthful clocks and stats. All of it was correct work. None of it touched the two `return` statements at the center, because nothing pointed at them: there was no error, no log line, no rendered state, and no test failure to follow. The report kept being re-filed as unreproducible because from the outside a refused landing and a broken button are indistinguishable.

The receipt line added by the backend campaign is what finally broke the deadlock — not by fixing anything, but by making the *absence* of a land request visible.

## The doctrine this violates {#doctrine}

Stated by the owner, 2026-08-17, on reading the diagnosis:

> Errors **must NEVER EVER EVER** fail silently.

This is not a preference and it is not new — it is what `CommitErrorNoticeController`, the lane's refusal sentences, and the landing receipts were each built to uphold. The landing controllers are where the principle was written down as prose and then not applied. A gesture the user makes must always produce either the act or a reason; "no-ops here" is never an acceptable third outcome, and a comment blessing it is a defect in the comment as much as the code.

**This belongs in `tuglaws/` as a law**, not in a brief that will be archived. A future round should give it a number and a home, so the next controller that wants a quiet early return has something to violate.

## Open question: which condition refused {#which-condition}

The gate's precedence, from `evaluateJoinLandGate`:

1. `turnInProgress` → *"Wait for the turn to finish"*
2. `joinPhase === "pending"` → *"Previewing…"*
3. not landable (`outcome !== "clean"` and no candidate commit) → outcome's own sentence
4. `unreviewedResolution` → *"Review what the ladder resolved first"*
5. empty message → refuses

What the evidence says about each:

- **Outcome is ruled out.** The previews returned clean with no conflicts and no blockers; `deriveJoinOutcome` maps `phase: "preview"` with empty conflicts and blockers to `"clean"`, which is landable.
- **Unreviewed is effectively ruled out.** There was no conflict, so no resolution existed to review.
- **Empty message is ruled out** — the owner reports the text was intact.
- **`pending` is possible** but the previews had completed.
- **`turnInProgress` is the leading candidate**, and it is *not* confirmed. `codeSessionStore.getSnapshot().canInterrupt === true` is a deck-side read. The log shows a deck reload at 13:11:54 (an `app-lifecycle` broadcast and deck-state rehydration) with **no tugcode traffic at all** between 13:05 and 13:14 — so no agent turn was actually running. Whether `canInterrupt` was nonetheless stale-true across that reload is exactly the kind of thing that cannot be settled from a log and must be observed.

**Do not fix on this hypothesis.** Once every refusal speaks, the next occurrence names its own condition in one press, and the question answers itself. Making the refusal visible is therefore both the fix and the diagnostic, which is the right order.

There is a related design question worth raising separately: a `dash-implement` run ends by telling the user to land, and the turn gate refuses a landing while a turn is in progress. If those two ever overlap, the product tells the user to do something it then silently refuses. Even with the refusal made visible, that collision deserves its own look.

## What to fix, in order {#fixes}

The ordering matters: the first item makes every later one diagnosable.

1. **Every landing refusal speaks.** Both controllers, both `land()` gates and both staged re-checks. The sentence already exists in `joinDisabledReason` / `commitDisabledReason`; route it to a surface instead of discarding it. This alone converts every future occurrence from "nothing happened" into a named cause.
2. **Join gets an error surface.** A join notice controller alongside commit's, so `JoinModeSnapshot.landError` stops being dead state and a server-side join failure is visible. Consider generalizing the existing controller over `LandingModeController` rather than writing a second one.
3. **The staged landing cannot swallow a landing.** A parked callback that depends on an animation callback firing needs either a guaranteed dismissal, a fallback, or a loud failure when the beat never comes. Silently holding a user's landing in a ref forever is the worst available outcome.
4. **A null store is a fault, not a no-op.** `verbStore === null` in a land path means the app is broken; it should say so.
5. **The composer submit stops guessing.** Either it consults the gate before calling `land()`, or `land()` is contractually required to report. Today neither is true, which is how a button that looks pressable does nothing.
6. **The corpus presses the button.** An app-test that drives a real land press through composer submit → staged dismissal → wire, and one that drives a *refused* land and asserts the reason appears. The second is the regression test for this whole family.
7. **Then, and only then**, read what the next occurrence reports and fix the actual gate condition.

Items 1–5 are behavior-preserving in the success case and change only what happens on failure, which makes them independently landable and low-risk. Item 6 is what stops this from recurring a fourth time.

## Status of the standing report {#report-status}

[`dash-closure-brief.md`](dash-closure-brief.md#join-hunt) frames the hunt as having two exits: capture a misbehavior, or downgrade the report with a deliberate-exercise receipt.

**It is the first exit.** The surface was exercised deliberately, on real work, in the release instance, with the rebuilt code, and it misbehaved. The report is not downgraded — it is confirmed, localized, and now has a mechanism. The forbidden third path (a speculative fix without evidence) remains forbidden, and item 7 above is where it stays foreclosed.

The dash-and-join program cannot be called closed until the fixes above land and the corpus covers the press.
