# Arc audit integrity — the clock, the arming, and the receipts

**Purpose:** Three failures surfaced on 2026-09-02 around the audit stage and relaunches: a healthy audit was declared "went silent" by a tugcast instance that could not see it; the join was offered while the audit — a stage that may still change the code — was underway; and historical `/dash-join` receipts render as raw shell blocks after the rename. All three are root-caused below with log and code evidence. This brief charters the fixes.

---

## Purpose {#purpose}

The user's report, condensed from the session that diagnosed it: an arc (`arc-lexicon`, a large whole-tree rename) was in its audit stage when the Wheel presented a red stop — "it went silent — no turn ended and no step closed" — with a resume hint, even though the audit was alive, finished cleanly minutes later, marked the arc audited, and joined successfully. Separately, another dash (`session-name-durability`) showed **Ready to join** in the Changes shade while its audit was still underway — "Must wait for the audit to complete, *especially* given as how the audit may make code changes!" And after closing and reopening the session that performed a join, the join renders as a raw Shell block instead of the designed landing receipt.

The demand behind all three: **auditing must be a first-class, accounted-for phase of every arc** — the clock must not stop it falsely, the join must not be offered before it, and the receipts around it must survive replay.

Vocabulary per `tuglaws/work-grammar.md`: arc, dash, trek, wheel, stages, join. Read that first if any term is unfamiliar.

---

## Evidence {#evidence}

**[F01] A foreign tugcast instance stalled a healthy arc, to the second.** Two Tug.app instances were live: `release-main` (driving the arc-lexicon arc) and `debug-tugdash-session-name-durability` (launched by another dash's acceptance test running `just app-debug`). In `release-main`'s log (`instances/release-main/Logs/tugcast.log.2026-09-02`), the audit rotated at 19:33:15Z and ticked once a minute with tokens climbing and `stalled=false` throughout, ending cleanly at 20:00:46Z (27m31s), `dash mark arc-lexicon audited` at 20:00:25, join completed 20:01:08 (`fa1e96b41`). In the debug instance's log, the same arc appears as `event="arc.unseated"` once a minute from 19:22:26 — that tugcast reads the shared on-disk arc record but the seated session lives in the other tugcast's process, so it gets no snapshot — and at **19:53:26Z it logged `stalled=true`** and wrote the durable stop receipt (found in `release-main`'s `shell_exchanges.db`, command `/dash-arc`, 19:53:26). 19:53:26Z is 12:53:26 PM local — the Wheel block's timestamp exactly. **(verified — read from both logs and the ledger copy, 2026-09-02)**

**[F02] The unseated clock is doing what it was built to do; the missing concept is ownership.** `watch_the_clock_unseated` (`tugrust/crates/tugcast/src/feeds/arc_runner.rs:544` region) times an arc whose session hands back no snapshot, by the same stall deadline (`ARC_STALL_SECS_DEFAULT = 1_800`, `tugrust/crates/tugtool-core/src/config.rs:155`), and stops it as `ArcStopReason::Stalled`. The clock's own doctrine — "silence tugcast did not watch is not silence it may hold against the stage" (seeding comments, `arc_runner.rs:~115–137`) — is enforced across restarts but not across instances: nothing in the arc record says *which tugcast* seated the stage, so a foreign runner cannot tell "not mine to watch" from "gone silent". **(verified — read from the crates)**

**[F03] `join_ready` does not know the audit exists.** `tugrust/crates/tugarc-core/src/log.rs:678`: a dash arms when the declared run completes (`done(m)` against `--through`), when `built` or `audited` is declared, or when a plan-less generation has a committed round. Closing the last step arms immediately; the implement stage itself declares `built` (observed in the session-name-durability run). The audit stage — which by design commits fixup rounds ([B06] of the course-retrofit brief) — appears nowhere in the predicate, so the shade offered **Ready to join** mid-audit. **(verified — read from the tree and observed live)**

**[F04] The rename cut the join matcher's history.** Replay re-derives designed blocks purely by matching the ledger row's command string (`tugdeck/src/lib/shell-session-store.ts:480` restores rows verbatim; `tugdeck/src/components/tugways/cards/session-card-transcript.tsx:784` resolves via `session-command-block-registry.ts`). `matchesJoinReceipt` (`tugdeck/src/lib/landing-mode.ts:91`) now claims only `/arc-join`; every pre-rename ledger row says `/dash-join`, so those rows fall through to the raw `ShellExchangeBlock` with `shell` attribution — the reported symptom. The repaired pattern exists in the same surface: `matchesDiscardReceipt` (`tugdeck/src/components/tugways/cards/session-join-receipt-block.tsx:373`) deliberately claims both spellings, "read and never written", with the reason in a comment. The same rename also dropped `/dash-join` from `LANDING_RECEIPT_COMMANDS` (`tugrust/crates/tugcast/src/shell_ledger.rs:44`), so historical join receipts lost their eviction exemption from the 500-row cap. **(verified — read from the tree and the rename commit)**

**[F05] A stop receipt is frozen text and re-renders stale forever.** `format_arc_stop_receipt` (`arc_runner.rs:~1316`) composes the receipt including the resume hint; `session-arc-receipt-block.tsx` renders it blindly from the row; the registry's prop boundary (`session-command-block-registry.ts:~41–58`) hands renderers nothing but the `ShellExchangeMessage`, so a stop receipt cannot consult the arc's present state — deliberate, per the "still read correctly on a relaunch weeks later" comment (`arc_runner.rs:~1400`). Consequence: the false stop of [F01] — and any *true* stop later resolved — replays as a live red instruction ("resume with …") after the arc has joined. Current arc state is available in the deck via `DashArcState` (`tugdeck/src/lib/changeset-types.ts:164`) through `changesController`/`ChangesetAllStore`, but no receipt renderer reads it. **(verified — read from the tree)**

**[F06] Cross-version instances amplify the hazard.** The debug instance ran a pre-rename binary; its stop receipt says `resume with tugtool dash run` in a post-rename world. Two binaries of different vintages sharing one project's arc state acted on it with different vocabularies. **(verified — receipt text vs. current tree)**

---

## Decisions {#decisions}

**[B01] An arc's clock belongs to the instance that seated the stage.** The arc record grows an owner identity written at seat time (alongside the stage line's session id). A runner reading an arc seated by another **live** instance treats it as *not mine to judge*: no motion held against it, no stop written, no receipt recorded. The unseated-clock path times only seats this instance owns. This is the join-occupancy lease's shape applied to the runner, and it closes [F01]/[F02] at the root: the false verdict becomes unwritable rather than merely unlikely. What would reopen it: a design in which arcs are meant to migrate between instances, which does not exist.

**[B02] Liveness of the owner must be answerable, or [B01] strands arcs.** A foreign runner must distinguish "another live instance owns this" from "the owner died mid-stage." A dead owner's arc must eventually be adoptable or stoppable — otherwise a crashed tugcast leaves an arc no clock may ever touch. The mechanism (heartbeat, lease expiry, pid liveness) is the devise round's to choose; the requirement is that both failure modes — false foreign stop, permanently orphaned arc — are impossible at once.

**[B03] Under a live wheel, only the audit arms the join.** While the arc record shows a wheel-driven run in progress, `run_complete` and `built` do not arm `join_ready`; the offer waits for the `audited` declaration. When the wheel has **stopped** (any stop reason), the predicate falls back to today's arms, so a broken audit cannot hold the landing hostage and the user can still join by hand. One gate for both kinds — a dash and a trek both end in an audit. This closes [F03].

**[B04] A command spelling that ever reached a durable ledger is a read spelling for life.** `matchesJoinReceipt` claims `/dash-join` alongside `/arc-join`, exactly as `matchesDiscardReceipt` already does; `/dash-join` returns to `LANDING_RECEIPT_COMMANDS` so historical receipts keep their eviction exemption. Write this as doctrine where the registry lives, so the next rename cannot repeat [F04] — the work-grammar's retired-names list is the natural registry of spellings owed this treatment.

**[B05] A superseded stop receipt renders as history, not instruction.** When a later receipt for the same arc exists in the same session's ledger (a join receipt, a subsequent stop or resume), the earlier stop renders collapsed/muted — the frozen text unchanged, its presentation demoted. This respects the frozen-row doctrine while ending the transcript shouting about a solved problem ([F05]). How the renderer learns "superseded" without breaking the prop boundary — a ledger-side annotation at write time of the later receipt, or a registry-level pass over the session's rows — is the devise round's call; reading live feed state from inside a receipt renderer is the disfavored option.

**[B06] No behavioral opportunism.** The stall deadline's value, the stages' logic, the join's semantics, and the receipt formats stay as they are except where a decision above requires otherwise.

---

## Open Questions {#open-questions}

- **What durably identifies a tugcast instance?** The instance directory name is stable but reused across relaunches; a pid dies with the process. [B02] needs an identity that survives what should survive and expires what shouldn't. Read how `instances/` and the join occupancy lease already handle this before inventing anything.
- **Should app-debug and app-test instances run the arc runner over the host project at all?** [B01] makes their watching harmless, but a debug instance spending a runner on arcs it can never drive may be pure waste. If the answer is no, decide it deliberately — it is a scope cut, not a substitute for [B01].
- **Does any surface *display* a foreign arc, and what may it say?** The Changes shade lists arcs on the project; a foreign-owned arc should presumably still be visible, just never judged. Confirm the display path doesn't share the runner's snapshot blindness.

---

## Non-goals {#non-goals}

- **Tuning `ARC_STALL_SECS_DEFAULT`.** The clock was right in the owning instance; the deadline is not the defect.
- **Letting receipt renderers subscribe to live stores.** Rejected as the fix for [F05]: the prop boundary exists so a transcript row renders from the record alone; [B05] works within it.
- **A general cross-instance arbitration layer.** The lease covers the one shared mutable judgment (the clock/stop). Nothing here builds instance-to-instance messaging.
- **Re-running the rename.** [F06] is noted as a hazard observation; version-skew policy between instances is its own future conversation.

---

## Exit {#exit}

**A plan.** This is a trek: the ownership design ([B01]/[B02]) carries real decisions, and the arming change ([B03]) touches the one predicate standing between finished work and the user's landing gesture. A sensible phase shape for the plan to consider: (1) ownership — record the seat's owner, gate the clock and every stop on it, settle liveness; (2) arming — the audit gate with the stopped-state fallback, over `join_ready` and its callers; (3) receipts — the matcher spellings and eviction exemption (small and independent; the plan may front-load it as its own early step), then the superseded-stop presentation. Verification: `cargo nextest run`, `just app-test-changed`, and a two-instance reproduction of [F01] — one instance driving an arc, a second watching — which the plan should turn into a test if the harness allows it.
