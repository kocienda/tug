# Make a running join legible in the Changes shade

**Purpose:** A join that is working shows a sentence the client made up, no clock, a Join button that lights before the run is over, and its refusals and its draft in type too small to read. The face must say what the server is doing, how long it has been doing it, and when it has gone quiet, and it must not offer an act that cannot be taken.

---

## Purpose {#purpose}

On 2026-10-28 the join of `remove-join-candidate-exam` sat on "working through the ladder" for minutes while the exam, since removed, ran silently over the candidate. The user pressed Join, got "a resolve is already running for this arc" in red at the top and again in small red under the report, and said: "This interface *must* be fixed and improved." The tiny red text under Report and the tiny white text under Draft need improvement. The margin between the wave and "working through the ladder" is too small. "There was also a *long* delay while the ladder was being worked through with no idea what the time was being spent doing."

On the Join press during a run: "If that's not a state that makes sense, the button shouldn't be enabled. Disable it." On where the silence line goes: "We need a *prominent* place, but I worry that beside the arc name ('Reconciling with main') doesn't give enough room. We need a solution."

---

## Evidence {#evidence}

All findings were read from main at `20e336df4`.

**[F01] The live block is synthesized by the client, not reported by the server** — `ledgerBlocks` in `tugdeck/src/lib/resolve-ledger.ts` draws "Ladder · Resolving N files · rung 1 · working through the ladder" whenever the run is live and no draft block is open, whatever the server is doing. In the screenshot run the ledger's events were `probe` at +58 ms and `candidate` at +121 ms with no `ended`; the candidate block drew green while the synthesized ladder block sat live beneath it for four minutes of exam. **(verified)**

**[F02] The engine tells rungs only as verdicts** — `LadderEvent` in `tugrust/crates/tugarc-core/src/resolve.rs:139` has Probe, Rung with its verdict, ScribeStarted and ScribeEnded, and Candidate. There is no started-shaped event for a rung, and no event at all for the phases tugcast owns: opening the workshop, spawning the resolver, each resolver turn's wait, the commit, the anchor. `LedgerRecorder` in `tugrust/crates/tugcast/src/feeds/join_ledger.rs:158` records exactly those events. So "rung 1" at a run's start is invented, and a silent phase is indistinguishable from a wedged one. **(verified)**

**[F03] No clock** — the candidate block's summary appends "<duration> in all" only once `ended_ms` exists (`resolve-ledger.ts:568`). A live run shows neither its elapsed time nor the time since its last event. **(verified)**

**[F04] Join was enabled while a run held the arc, and the server refused the press** — `evaluateJoinGate` in `tugdeck/src/lib/join-mode-controller.ts:128` reads the turn, the holder, the join phase, the outcome and the message. `deriveJoinOutcome` returns "clean" as soon as `join.candidate` is a sha. `join.run` is on the wire but is not a gate input. The candidate was anchored at +121 ms, so the button lit while the run was live; the press reached tugcast and `join_occupancy.rs:101` refused it with "a resolve is already running for this arc". **(verified)**

**[F05] That refusal is drawn twice, in the fault register** — the top notice banner offers COPY DETAILS and RETRY JOIN under "Fix what it names and try again", and RETRY JOIN restarts the ladder. The same sentence is drawn again as bare text in `.session-changes-arc-join-error` (`session-changes-arc-fold.css:456`: sans, `--tug-font-size-xs`, danger tone) under the report. The stuck line `.session-changes-arc-join-stuck` (line 477) is the same bare xs red. **(verified)**

**[F06] The draft is set as a receipt** — the landing message in `session-changes-arc-brief.tsx:308` rides `tugx-commit-receipt`, whose subject and message sizes are both `--tug-font-size-xs` (`commit-presentation.css:51`, `:62`). It is the message the user is about to land, set smaller than the file list beneath it. **(verified)**

**[F07] The wave sits tight** — `LiveBand` in `session-changes-resolve-ledger.tsx:91` is a `BlockNoticeBand` in the progress tone. The band's gap is `--tugx-toolnotice-gap`, the small space token, measured from a 14 px icon box (`block-notice.css:31`, `:36`). The wave's ink is three bars at 0.15 of its size with gaps of 0.8 of a bar (`tug-progress-wave.tsx:40`), about 11 px at the default 16, so its ink reads nearer the text than any glyph icon does. **(verified)**

**[F08] The register line is shared and has no room** — `ArcJoinRegister` is one sentence and one word ("Reconciling with main" · "reconciling", `arc-join-register.ts:357`), rendered by the arc lane, the Arcs card row and the composer from one derivation (comment at `session-changes-arc-lane.tsx:539`). Its CSS is `overflow: visible` with no truncation (`arc-join-register.css:24`). A clock or a silence sentence added there would ride all three surfaces and crowd the one that is a single line. **(verified)**

**[F09] The deck already knows one arc admits one run** — the controller suppresses a second resolve send when `join.run` is set (`join-mode-controller.ts:675`). Only the Join gate ignores the fact. **(verified)**

**[F10] The exam is gone, the silent phases are not** — `20e336df4` and D224 removed the minutes-long exam that produced the screenshot. Every silent phase in [F02] remains, and a resolver turn is minutes long by design. **(verified)**

---

## Decisions {#decisions}

**[B01] Join is disabled while a run holds the arc.** `evaluateJoinGate` gains a run input read from `join.run`, placed after the holder reason and before the pending one, with reason "running" and the hint "Wait for the resolve to finish". The button is disabled with that reason the way every gated verb is ([L31]), and the controller's join path shares the gate so the two cannot disagree ([F04], [F09]). The server's admission refusal stays as the defense behind the button and is no longer reachable from it. The user's call: if the state makes no sense, the button is not enabled.

**[B02] The live block names only what the server reported.** The engine adds a started-shaped event, told before each rung, and the tugcast caller tells the phases it owns through the same recorder: opening the workshop, resolver turn N, committing, anchoring ([F02]). `ledgerBlocks` stops synthesizing a Ladder block ([F01]). With a live run and no event yet, the one live band reads "started · nothing reported yet". The sentence on a live band is always the last event's own words.

**[B03] A clock and a silence sentence.** The live band carries the elapsed time since the run's `started_ms` and the time since its last event, ticking on the client's own clock; a timer painting a number is not a poll of the server. Past 20 s with no event the band's text becomes "no report for 40 s" in the caution tone, the same threshold and wording the Bash block's gap doctrine uses, so one number means one thing across the deck ([F03]).

**[B04] The prominent place is a run line under the register, in the Changes shade only.** A full-width row directly beneath the arc lane's register row, present only while a run is live. Left, the phase the server last reported ([B02]). Right, the clock ([B03]). When silence crosses the threshold the left text becomes the silence sentence in the caution tone. It is the first thing under the arc name, it has the whole width, and it belongs to the shade alone, so the shared one-line register keeps its one word and the Arcs card row and the composer are untouched ([F08]). The live band in REPORT shows the same two facts in detail; the run line is where the eye lands.

**[B05] A refusal is a band, once, at body size.** The stuck line and a real fault render as an error band with icon and text at the face's body size, `--tug-font-size-sm`, in one place; bare xs red text goes ([F05]). The admission refusal is unreachable after [B01], so its double rendering goes with it. The top banner with RETRY JOIN stays for a landing that actually failed.

**[B06] The draft is set as a message.** Subject at sm with the subject weight, body at sm in the normal text tone; the clusters and rounds beneath it keep their size ([F06]). It is the text the user signs, and it is set at least as large as the file list under it.

**[B07] The progress band gets its own gap.** Either a progress gap token one step wider than the icon gap, or the wave boxed to `--tugx-toolnotice-icon-size` and centred so its ink lands where every glyph lands ([F07]). The implementer measures and picks, and an app-test pins the chosen gap.

**[B08] Record [B02] as D225.** A live block in the join ledger names only what the server reported, and the client never synthesizes a phase. Cite D142 (status is never a control), D150 (the join speaks in one place) and this brief.

---

## Non-goals {#non-goals}

- **Auto-joining when the candidate stands after a press during a run.** The user chose disabling the button over remembering the press.
- **Changing the register's one word or its sentences on the Arcs card row and the composer.** The run line exists so the shared register need not change ([F08]).
- **Redesigning the Changes shade beyond the arc-join face and the draft block.**
- **Changing the server's admission refusal.** It stays as the defense behind the disabled button.
- **Touching the crossing engine or `resolve.rs` beyond adding the started event.**
- **A progress bar for a resolver turn.** Its length is the model's; the clock and the silence sentence are what can be said.

---

## Exit {#exit}

An arc. The order that lands cleanly:

- The gate ([B01]), with its unit test and an app-test that presses Join under a live run and finds it disabled with the hint.
- The started events and the recorder ([B02]), with a ledger test.
- The run line and the band clock ([B03], [B04]), with an app-test that seeds a live run whose last event is stale and reads the silence sentence.
- The type and band changes ([B05], [B06], [B07]), with the arc-join face's existing tests updated.
- D225 last ([B08]).

Verification is tsc, the vite build, `just test-ts`, the tugcast join ledger and changeset tests under clippy with warnings as errors and nextest, and the app-tests named per step. The live proof is a real arc joined from the shade with the run line visible for the resolver's whole turn.
