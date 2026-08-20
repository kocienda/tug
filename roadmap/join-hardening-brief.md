# Join Hardening: Round 3 of the Dash/Join Arc {#join-hardening-brief}

**Status:** every finding below was carried into [`roadmap/join-hardening.md`](join-hardening.md) and implemented there; this document stays as the findings record — what was seen, where, and what it would have cost. Table T01 in the plan maps each finding to the step that closed it, and the one refusal (F12b) records its reason.

**Purpose:** Close the failure seams found in the 2026-08-19 audit of the agent-finished join as it landed on `main` (`77ece2b65`). Rounds 1 and 2 (`roadmap/close-dash-join-gaps.md`, `roadmap/close-dash-join-gaps-round-2.md`) built the design — the workshop, the resolver, the verification tiers, the escalation frame, the audited report — and the design is sound. What remains is the difference between "works in the fixtures" and "reliable in daily use": the holes below live almost entirely in the *seams* between the new pieces (the override and the store's idle discipline, the client deadline and the resolver's real cadence, the ladder's clean exits and the audit duty, restart recovery, concurrency on one shared workshop). Every finding names its file and line as of the joined tree and states a concrete failure scenario. Findings marked **(verified)** were confirmed by hand in the code after the audit; the rest were read directly by the auditing pass with the quoted evidence and should be re-confirmed by devise as its first act.

This is a brief, not a plan. `/tugplug:plan-devise` turns it into steps; the open questions at the end are the ones devise must settle before writing them.

**Success statement:** every finding below is either fixed with a falsifiable checkpoint (the finding's own failure scenario, driven for real), or explicitly refused with a recorded reason. In particular: the override works in the state where it matters; one dash admits one resolve at a time; a healthy resolver run never renders as an error; the audit runs on every machine-decided candidate including the replay and clean-squash exits; a clean join can be — and by default is — verified before it joins; and no durable state left by a crash renders as live, waits forever, or swallows a press.

---

## Findings {#findings}

### F1 — "Join anyway" is a no-op in the ordinary case **(verified)** {#f1-override-noop}

`tugdeck/src/lib/changeset-join-store.ts:306-312` (`_set` deletes any state whose `phase` is `"idle"`) and `:389-393` (`overrideRed` spreads `this._states.get(k) ?? IDLE`).

After a successful resolve the store returns the dash to `IDLE` (`_set(k, IDLE)` on `changeset_join_resolve_ok`), which *deletes* the entry. `overrideRed` then reads `IDLE` back, spreads it — preserving `phase: "idle"` — and hands it to `_set`, which deletes it again. `state()` returns `IDLE` with `redOverrideFor: null`, `redOverrideStands()` is false, and the gate keeps refusing `verification-red` (`tugdeck/src/lib/join-mode-controller.ts:195`).

**Failure scenario:** resolver finishes, tier 1 is red, the user reads the named failures and presses **Join anyway** — nothing happens, the button stays, no reason is given. The exact state the control exists for is the one state it does not work in. It sticks only in `phase: "error"` (dropped wire, fired deadline) — the wrong half of the state space. The unit tests exercise `redOverrideStands`/`evaluateJoinGate` with a hand-written `redOverrideFor` (`tugdeck/src/lib/__tests__/join-mode-controller.test.ts:150-158, 251`) and never the store round-trip, which is how it slipped through. The fix must be pressed through the store, and ideally through at0443's real arc rather than a pure-function test.

### F2 — the 12-second silence deadline fires on every real resolver run, and its error face invites a second concurrent resolve on one workshop **(verified)** {#f2-deadline-and-double-resolve}

Two defects that compose into workshop corruption.

**(a) The deadline's premise is the scribe rung, not the resolver.** `RESOLVE_IDLE_DEADLINE_MS = 12_000` (`tugdeck/src/lib/changeset-join-store.ts:122`) is justified in its docblock by the scribe file-merger's per-chunk streaming deltas (`tugcast/src/feeds/join_resolve.rs`). The resolver emits four discrete statuses — `working`, `asking`, `verifying`, `iterating` (`tugrust/crates/tugcast/src/feeds/join_resolver.rs:1098-1108`) — and the deadline is disarmed only while `status === "asking"` (`changeset-join-store.ts:258`). The silent stretches inside a healthy run are minutes long: `open_workshop` runs the project's `post_create` hydration *before* the first `working` delta (`join_resolver.rs:735`, `workshop.rs:275`); a resolver turn is a whole headless `claude` conversation; `run_tier0`/`run_tier1` are a build and a test selection. So the overlay flips to `phase: "error"` — "No answer from the resolution ladder in 12 seconds" — during essentially every real run. The stub resolvers in at0441/at0442/at0443 answer in milliseconds, which is why the corpus never saw it.

**(b) No server-side in-flight guard.** `do_changeset_join_resolve` (`tugrust/crates/tugcast/src/feeds/agent_supervisor.rs:5472`) takes no per-dash lock. The error face mounts `JOIN_CONTROL.resolve` (`session-changes-dash-join.tsx:120-127`, `:216-220`); pressing it starts a second `finish_join`. Both tasks call `Workshop::open_merge` on the same `.tug/workshops/<name>` (`workshop.rs:88`), each doing `merge --abort` + `reset --hard` + `clean -fd` on the tree the other's live agent is editing, then both `commit()` and `anchor_candidate` over each other. The store's own docblock ("a second run costs time and nothing else", `changeset-join-store.ts:322-326`) was written for the ladder, which built off to the side; with the workshop it is no longer true.

**Failure scenario:** press Resolve on a real conflict → 12s later the face says the ladder went silent → press Resolve again (the face offered it) → two resolvers fight over one worktree; lost work, or a candidate committed from a half-reset tree, or a spurious "conflict markers remain". Devise should treat (a) and (b) as one design question — the client's liveness signal and the server's admission discipline — not two patches.

### F3 — the replay and clean-squash ladder exits skip the resolver and the audit **(verified)** {#f3-audit-skipped}

`agent_supervisor.rs:5547`: `let conflicted = !outcome.resolved.is_empty() || !outcome.unresolved.is_empty();` — under a comment claiming the resolver "runs on every conflicted join, including one the ladder resolved completely" ([P10]).

Two of the ladder's success exits return empty `resolved` *and* empty `unresolved` with a candidate: the replay probe (`tugrust/crates/tugdash-core/src/resolve.rs:207-216`) and the clean one-shot squash (`:224-234`). Both are machine decisions over a dash whose preview reported conflicts — that is why Resolve was pressed — and both make `conflicted == false`, so `finish_join` never runs: no audit, no charter, no tier 0, no tier 1. The candidate is anchored and the face offers a bare Verify at `unrun`.

**Failure scenario:** the 2026-08-15 incident class exactly — a replay that silently accepts a shape change builds green, tests green, and joins unread. The audit duty that round 2 built to carry the retired review gate's weight does not cover the exit most likely to produce that incident.

### F4 — a genuinely clean join gets no verification at all, and there is no server-side verdict gate **(verified)** {#f4-clean-join-unverified}

`tugdeck/src/lib/join-mode-controller.ts:134-142`: no candidate → `verificationVerdict` returns `"not-applicable"`, and `evaluateJoinGate` only refuses on `red`/`running`/`unrun`. A dash whose merge is textually clean never grows a candidate, so the resolver never runs and neither tier ever runs — it joins on the message gate alone. The motivating example of the whole arc (`roadmap/close-dash-join-gaps-round-2.md` context: "a textually clean, semantically broken merge joins behind a green line" — the renamed symbol on one side, the new call site on the other) is a *clean* merge, and it still has the hole. Round 2's success criterion "a textually clean merge with a broken build cannot join silently" is pinned only on the conflicted path, where a candidate exists.

Separately, `do_changeset_join` (`agent_supervisor.rs:5154-5205`) passes straight to `join_in` with no reference to `verify::read_verification` — the entire green/red/override discipline is client-side. A second deck, a stale client, or `tugutil dash join --resolve` from the CLI joins a red candidate with no refusal.

**Failure scenario:** dash renames a symbol; main adds a call site to the old name; the merge is clean; the join is green; main does not build. Devise must decide what a clean join verifies against (see [Q2]) and where the authoritative gate lives (the server owns the join facts — [P0x] of join-truth — so a verdict the server never consults is advisory, not a gate).

### F5 — restart and failure recovery: stale questions render live and swallow the answer; a crashed tier pins `running` forever with no control {#f5-restart-recovery}

Three composing holes, all read directly by the audit with quoted code.

**(a) The durable question is cleared on exactly one path.** `clear_question`'s only caller is `escalate`'s in-process cleanup (`join_resolver.rs:883`). `do_changeset_join_resolve` clears the stuck fact but never the question (`agent_supervisor.rs:5515`), and nothing clears it at startup. Kill tugcast while a resolver is blocked on an ask and `branch.tugdash/<name>.tugjoinquestion` stands; `standing_question` (`join_board.rs:184-189`) re-renders it as live for as long as the dash head doesn't move, and the face mounts the `QuestionWizard` over it (`session-changes-dash-join.tsx:678`).

**(b) The answer's refusal has no listener.** `answer_question` correctly returns `false` when the process-global `PENDING_ASKS` has no waiter (`join_resolver.rs:657-668`), and the supervisor correctly replies `changeset_join_question_answer_err` with a reason (`agent_supervisor.rs:5657-5666`) — but `ChangesetJoinStore._onControl` filters to the three `changeset_join_resolve_*` actions only (`changeset-join-store.ts:222-229`) and no other client code subscribes. The user answers a dead question and *nothing happens*, forever, with no message — the [L31] silence the surrounding code exists to forbid, and the store's own docblock at `:407-410` claims the opposite.

**(c) A tier runner that errors pins the verdict at `running`.** Both runners write `TierStatus::Running` durably and then `?` on `verify::run_tier0`'s `Err` (`join_resolver.rs:1044-1054`, `agent_supervisor.rs:2055-2079`) without rewriting the fact. The verdict is SHA-anchored, so it survives restarts indefinitely while neither head moves. `verificationVerdict` → `"running"` → refusal `verifying`, whose reachability entry is `{slot: null, where: "time"}` (`join-mode-controller.ts:288`) — a "wait" about something that will never finish, with no control that clears it. A tugcast crash between the `Running` write and the tier finishing lands in the same place.

**Failure scenario for the round:** restart tugcast mid-resolve; the face must come back honest — no live-looking dead question, no absorbed press, no permanent spinner — and each stale fact must either clear or name a control.

### F6 — tier 0 runs unbounded, and `finish_join` has no overall deadline {#f6-tier0-unbounded}

`tugrust/crates/tugdash-core/src/verify.rs:236-247`: tier 1 gets `Some(TIER1_TIMEOUT)` (20 min) with a written rationale — "a join held open forever … is the one failure mode a face cannot render" — and tier 0 gets `None`, i.e. `cmd.output()` (`:391`), unbounded. Tier 0 is `cargo check`/`bunx vite build` class: a cargo lock contention or a network-fetching build parks the `spawn_blocking` thread forever, `finish_join` never returns, no `record_join_stuck`, the verdict stays `running` (F5c), and the blocking pool leaks a thread. Killing tugcast is the only exit, and it leaves the `running` fact behind. `finish_join` as a whole has no deadline either: worst case is 3 × (unbounded resolver turn + unbounded tier 0) + the 30-minute question wait.

### F7 — a feed recompute clears the candidate out from under a running resolve; a dash commit vanishes a standing question {#f7-recompute-races}

`join_board.rs:110-119` (`join_state_for`) mutates on read: a `CandidateStatus::Stale` triggers `resolve::clear_candidate`, which deletes the ref, the marks, *and* the verification fact (`resolve.rs:1423`). A candidate is stale the moment the base branch stops being its ancestor (`resolve.rs:1470-1478`) — i.e. the moment anything lands on `main` during a multi-minute resolve, which is routine. `finish_join` then proceeds against a candidate that no longer exists, and the durable stuck line becomes tier 1's "the build verdict went missing before the exam" (`join_resolver.rs:1080`) — a sentence that names none of the actual cause.

Relatedly: `escalate` keys the durable question to the dash head at ask time (`join_resolver.rs:849-850`), and `standing_question` requires the head to still match (`join_board.rs:185-187`). A dash agent committing a round while the question stands makes the question vanish from the face, leaving the resolver to burn the full 30-minute `QUESTION_DEADLINE` with no way for anyone to answer.

**Design note for devise:** the self-demotion discipline is right for *verdicts*; the question is whether a *running resolve* should pin its inputs (candidate, question key) against demotion until it exits, and what the stuck sentence should say when the base genuinely moved.

### F8 — Verify racing a resolve: two processes reset and build in one workshop {#f8-verify-race}

`do_changeset_join_verify` (`agent_supervisor.rs:5382-5412`) takes no lock and does not ask whether a resolve is in flight; `verify.rs:239`/`:269` open the candidate via `Workshop::open_candidate` → `reset_to` (= `merge --abort` + `reset --hard` + `clean -fd`). Verify is mountable whenever a candidate reads `unrun` — reachable during an iterating resolve, and trivially reachable after F2's deadline lies about the run being over. The verify pass then resets the shared workshop under the resolver's tier 0 in the same directory and `target/`. Consequences range from a bogus red to a candidate committed from a mid-reset tree. The same admission discipline that answers F2(b) should answer this — one workshop, one occupant.

### F9 — workshop lifecycle: recreation-after-teardown leaks; `release()` is dead code; failure leaves the workshop dirty as the steady state {#f9-workshop-lifecycle}

`Workshop::ensure` (`workshop.rs:225-297`) unconditionally recreates a missing worktree and `tugworkshop/<name>` branch, and every entry point goes through it. `workshop::remove` runs from join teardown (`ops.rs:3283`) and discard (`ops.rs:3379`), neither of which coordinates with an in-flight resolve or verify — so a straggling task that reaches `ensure` after teardown recreates a worktree and branch for a dash that no longer exists, and nothing ever removes them again. There is no sweeper for `.tug/workshops` at all. Separately, `Workshop::release()` (`workshop.rs:216`) — "return the workshop to a clean base checkout" — has zero production callers, so every failed resolve leaves conflict markers, a live `MERGE_HEAD`, and partial edits standing until the next open resets them. Not corrupting (every `open_*` except `open_existing` resets), but "dirty after failure" is the steady state, and the orphan path is a real leak.

### F10 — `Workshop::commit` stages the whole tree, so a file the resolver invented lands unaudited {#f10-add-a-unaudited}

`workshop.rs:130`: `git add -A` commits whatever the working tree holds, including any untracked non-ignored file the resolver created (it has `Write` — `join_resolver.rs:49`). The marker scan is correctly scoped to the diff against base, and `validate_report` only requires the *resolution set* to be accounted for (`join_resolver.rs:149-164`) — a path outside that set is neither audited nor reported, and joins. Devise should decide whether the report contract widens to "every path in the candidate's diff against base" or the commit narrows to the resolution set plus declared artifacts.

### F11 — `escalate`'s expiry contract is not what its docstring promises {#f11-expiry-contract}

`join_resolver.rs:643-650`, `:872-899`. The `QUESTION_DEADLINE` docblock says expiry "sticks with the question preserved, so the answer arrives on the next resolve rather than being lost." In fact every exit arm including timeout clears the durable question; the text survives only inside the stuck sentence as prose, and the next resolve charters a fresh resolver with no memory of the ask. Either implement the preserved-question contract (feed the standing question into the next charter as a decided or still-open item) or rewrite the docstring and the stuck sentence to tell the truth. A contract the code does not keep is worse than a smaller contract.

### F12 — small, real, cheap {#f12-small}

- `run_bounded`'s timeout branch leaves **stdin inherited** from tugcast (`verify.rs:398-404`), so a declared command that reads stdin blocks until the timeout; the unbounded branch (`output()`) is the one that nulls stdin. Null it in both.
- `workshop_branch`/`workshop_path` sanitize the dash name (`workshop.rs:44, 51`) while `branch_name` and the config keys do not (`ops.rs:295`; `resolve.rs:1155, 1164, 1305, 1315, 1377`) — dashes `a/b` and `a__b` would share one workshop. Decide one sanitization rule at the naming gateway; no tolerance shims.
- `emit_resolver_delta` passes the candidate sha through `emit_delta`'s `path` parameter (`join_resolver.rs:1099-1107`), so the client keys resolver progress rows by sha-as-path (`changeset-join-store.ts:231-236`). Name the field honestly.
- `write_report` uses plain `git config` set while `clear_candidate_marks` uses `--unset-all`; a key that ever acquires two values makes every subsequent `write_report` fail the whole resolve (`resolve.rs:1305-1320`).

---

## What the audit checked and found sound — do not re-litigate {#found-sound}

Devise should treat these as settled and build on them, not around them: the resolver two-shape turn protocol and its bounded-quote violations (`join_resolver.rs:95-138`); the [P10] report-completeness check over the resolution set (`:149-164`); marker refusal on staged *content*, not index state (`workshop.rs:130-153`); the resolver boundary (no Bash, `--strict-mcp-config`, `kill_on_drop`, dropped-sender kills the child); dead resolvers reporting a sentence with 2s of captured stderr rather than hanging; the injected-never-defaulted production spawner (`:409-417`); second-ask enforcement in `ResolverRun::send`; `open_merge` never touching user checkouts; the workshop branch living outside the `refs/heads/tugdash/` glob by construction, `.tug/` excluded per-clone; `is_live` canonicalization; `reset_to`'s `merge --abort` + `clean -fd` (never `-x`); verdict self-demotion clearing the fact from config, not just the wire (`join_board.rs:214-243`); the cacheability split with the probe counter tests; `anchor_candidate` moving ref + marks + source as one act; report and question as git blobs; the stuck fact's durability, anchoring, clear-at-next-resolve, and rendered alert; the detached `finish_join` (awaiting it would deadlock the control path against the answer); the client's dropped-wire handling and disarmed-while-asking deadline; `workshop::remove` wired into both ordinary terminal paths; config keys riding `branch.tugdash/<name>.*` so `branch -D` collects them; tier 1's environment hardening and the `TUG-VERIFY-NOTE:` channel; declared-nothing-is-green-with-a-note distinguished from `unrun`.

---

## Scope {#scope}

**In:** everything in F1–F12. The shape of the fixes is devise's to design, but the round is not done while any finding is neither fixed nor refused-with-reason.

**Out (unchanged from round 2's non-goals):** UI polish — button positions, feedback areas, fonts, colors, layout — which is its own review round and runs on the user's eye, not this brief; the app-test corpus quality round (culling non-falsifiable tests, at0438's scratch-universe rewrite); live-model resolver tests in the corpus (real-claude runs stay on-demand; fixtures drive the stub seam — though F2 is precisely the class stub timing hides, so devise should consider what *non-model* fixture can drive a slow resolver, e.g. a stub that sleeps past the deadline); a takeover mode that opens the workshop as a project; renaming the commit|join composer substrate (user ruling, [P01] of round 2).

**Also open, from the join lane's own backlog:** the join-verb UI redesign noted when the "dead button" was solved — lane JOIN enters the mode, the composer ⬆ executes; whether that verb split is right is a design question that belongs with the UI round, not this one.

---

## Open questions devise must ask {#open-questions}

- **[Q1] Admission discipline (F2b, F8):** one per-dash lock in the supervisor covering resolve *and* verify, or a workshop-level occupancy fact that both consult? What does the second press get — a refusal naming the live run, or an attach to it?
- **[Q2] Clean-join verification (F4):** does a clean join grow a candidate (commit the clean merge-tree, verify it, join the verified sha), or verify the preview tree without anchoring? Auto-run on preview, or mounted as Verify with the join gated on it? And does the server refuse `changeset_join` on a red/unrun verdict, or is the CLI (`tugutil dash join --resolve`) deliberately ungated as the user's escape hatch?
- **[Q3] Liveness signal (F2a):** replace the client deadline with a server heartbeat (the resolver's driver already sees stream activity), lengthen it per-status, or disarm it entirely for resolver rungs and let the durable stuck fact carry failure? What does the face show during a minutes-long `working` stretch so silence reads as work, not absence?
- **[Q4] Override residence (F1):** the override is deliberately deck-local ("one person's press", store docblock). Keeping it client-side is compatible with fixing F1, but F4's server-side gate question interacts: a server that refuses red must also honor an override, which makes it a server fact. One decision, taken once.
- **[Q5] Question durability (F5a, F11):** on restart, should a standing question re-arm (a fresh waiter that can actually receive the answer) rather than merely render? That would honor the docstring's promise and fix the swallow in one move — but it needs the resolver conversation to be resumable or the answer to feed the *next* charter.
