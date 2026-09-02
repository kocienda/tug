# Dash hardening: the audit and the proposal

**Written 2026-08-31, synthesizing four parallel code audits** over the session-identity paths, the `tugtool dash` verb surface, the arc runner and Wheel, and the dash skills/doctrine — prompted by [wheel-rotation-strands-the-arc.md](wheel-rotation-strands-the-arc.md), [dash-machinery-gaps.md](dash-machinery-gaps.md), and the standing worry those notes leave: that a dash cannot be bound, unbound, rotated, and resumed with confidence.

The one-paragraph verdict: **commit `88ef085b2` fixed the server door and nothing else in the pattern that produced the incident.** The stale-id hazard is still answered per-caller, three raw writers remain, no structural guard exists, the deck's read side has an ordering race on the exact rotation path the fix was for, the `reported_binding` branch gate still deterministically nulls valid bindings, the step ledger still cannot represent the states a real run passes through, the arc runner has three ways to wedge with no receipt, and the skills actively teach four of the failing gestures. The course retrofit is half-landed with the two halves contradicting each other in ten places. None of this is a mystery any more — every mechanism below has a file:line — but confidence requires closing the *class*, not the next instance.

---

## Part I — What the audits found

### A. Session identity: the door is fixed; the class is not

`88ef085b2` put `calling_segment` → `live_segment_of` at the `/api/dash` and `/api/session` doors, made `set_dash_binding` refuse closed/demoted rows, and added `seat_line_binding` + a `bind_dash_ok` broadcast at the rotation seat and at startup (`tugrust/crates/tugcast/src/main.rs:625`). All genuinely done, and unit-tested.

What survived the fix:

1. **Three raw writers never pass through the door.**
   - `tugtool draft` — `resolve_owner` (`tugrust/crates/tugtool/src/draft.rs:102`) writes `changeset_drafts` rows keyed on the raw `$TUG_SESSION_ID`; the read-back (`Owner::keys()`, `:60`) is never line-expanded, and tugcast attaches session drafts by exact id, live-only (`tugrust/crates/tugcast/src/feeds/changeset.rs:958`). A draft authored after a rotation can fail to surface. `tugplug/skills/draft/SKILL.md:82` pins the raw id in the skill text itself.
   - `tugtool ask` (`tugrust/crates/tugtool/src/commands/ask.rs:148`) — the server forwards the id verbatim and the deck routes by exact match (`tugdeck/src/lib/pending-ask-store.ts:221`); a stale id means no card matches and the store **silently answers with the declining fallback**. Skills ask mid-stage, so this is on the arc's path.
   - `tugtool changes claim|disclaim` (`tugrust/crates/tugtool/src/changes.rs:187`) — writes `file_events` under the stale segment. Benign today only because every reader re-expands; the row is misattributed at rest.
2. **The CLI still posts and prints the stale id.** `calling_session_id` (`tugrust/crates/tugtool/src/dash.rs:1335`) reads the raw env; the server corrects it, but `run_bind` prints the *posted* id and ignores the `session_id` the server answered with (`dash.rs:1360-1368`) — success can name a session the server deliberately did not write. No `--session` flag exists; the refusal text is still the misleading one the gaps note quotes.
3. **A rotation-overlap race in `live_segment_of`** (`tugrust/crates/tugcast/src/session_ledger.rs:4172`): the posted id wins the ordering if it is *itself still live*, so during the window where the new segment is recorded and the old not yet demoted, a bind resolves to the **old** segment, passes the live-guard, and strands when the old row closes — `seat_line_binding` already ran and will not run again until relaunch.
4. **`seat_line_binding` bypasses the live-guard** — its `UPDATE` (`session_ledger.rs:5258`) has no `state='live'` predicate; a second binding writer without the refusal the first one earned.
5. **`tugcode` passes `TUG_SESSION_ID` through unchanged on every claude respawn** (`tugcode/src/session.ts:3775`) while recomputing `TUG_DASH_ARC` per spawn (`:3800`). Safe iff a rotation always means a fresh tugcode spawn; unverified. The card's `$` shell pane keeps its spawn-time env for its whole life too.
6. **No structural guard.** The `no_ad_hoc_ledger_opens` / `no_ad_hoc_data_dir_resolution` / `source_scan` chokepoint regime has no entry for `TUG_SESSION_ID` or session-keyed writes. Nothing prevents the next raw `std::env::var("TUG_SESSION_ID")` or the next raw `WHERE session_id = ?` — which is precisely how `draft.rs`, `ask.rs`, and `changes.rs` survived this round.

### B. The card's read side: fixed for explicit binds, racy for the rotation itself

`bind_dash_ok`/`unbind_dash_ok` are consumed by the deck (`tugdeck/src/action-dispatch.ts:1230` → `cardSessionBindingStore`), so [P07]'s "spawn ack is the only writer" is dead — though the stale comments survive at `agent_supervisor.rs:4891` and `card-session-binding-store.ts:83`.

But on the rotation seat, the broadcast names the **freshly minted segment id**, which the deck learns only from the `session_updated` push sent *after* the broadcast on the same ordered channel (`tugrust/crates/tugcast/src/feeds/agent_supervisor.rs:1038` then `:1046`). On arrival, `cardIdForSession` (`tugdeck/src/lib/card-session-binding-store.ts:166`) resolves neither the id nor its line, and the handler **silently no-ops** (`action-dispatch.ts:1245-1251` — no else, no warn). The rotation seat also fires no `changeset_all_bump`, so the masthead's dash index (which derives from `CHANGESET_ALL`) does not refresh either. This is very likely the mechanism that would blank the card *again* even with `seat_line_binding` in place. No tugdeck test covers `bind_dash_ok` at all.

### C. `reported_binding`: the spawn-ack open question, answered

Two findings close the postmortem's first open question:

- **The ack is composed before the row exists.** `spawn_session_ok` is built inside `do_spawn_session` (`agent_supervisor.rs:4866-4936`); the ledger row is written later, at `session_init` (`:1005-1047`). On a rotation the fresh segment has no row at ack time → `dash_id: null` regardless of any gate. `seat_line_binding` is the compensation, not a fix of the ack.
- **The `live_dash_branches` gate nulls valid bindings two ways** (`agent_supervisor.rs:5778`): a **pre-branch arc binding is valid by design** (`server.rs:719` — `ensure_dash_id` needs no branch) yet has no `tugdash/<name>` ref, so the gate nulls it deterministically; and the gate's set is **empty on any git failure** (repo moved, `project_dir` spelling stale), indistinguishable from "no branches". Since the row is already bound, `seat_line_binding` returns `None` and no corrective broadcast ever fires. The same gate nulls `list_card_bindings` (`:7730`). No instrumentation was added.

### D. The step ledger: a machine that cannot represent a real run

Transition gate at `tugrust/crates/tugtool-core/src/plan.rs:1366-1373`. As implemented: `pending|in progress|withdrawn → in progress`, `in progress → done`, `pending|in progress|withdrawn → withdrawn`; `done` is terminal; **no edge reaches `pending` from anywhere**.

- **Withdraw counts as done and is skipped on resume** — both by documented design (`tugrust/crates/tugdash-core/src/dash.rs:500-511` advances the run; `tugrust/crates/tugcast/src/feeds/dash_arc.rs:43-50` skips the row; the withdrawn-final-step-arms-the-join semantics are *tested as intended*, `ops.rs:6364`). So parking an opened step has literally no sanctioned path: withdraw lies forward, hand-editing desyncs, and there is no `reset`.
- **The desync direction in the gaps note is inverted, which makes it worse.** `dash status`, `run_fraction`, `derive_stage`, and `join_ready` all derive from the **dash-log** (`ops.rs:2006-2045`); the arc's resume pointer and the changeset feed's closed count derive from the **markdown table** (`dash_arc.rs:43`, `changeset.rs:1495`). A hand-edited table therefore desyncs *join-arming* from *resume* — the two surfaces that must agree for the Wheel to walk the right step.
- **Table and log are written in sequence with no transaction** (`ops.rs:2175` then `:2181`) — a crash between them produces the same desync with no hand involved. Nothing detects either. There is no doctor, no lint, no reconciling verb.
- Smaller silent shapes: idempotent `step start` re-entry appends a duplicate log line every time (`ops.rs:2173-2182`); `step done --commit` records any string unverified (`ops.rs:2167`); `mark built|audited` arms `join_ready` over a table full of `pending` with no warning (`ops.rs:2350`, `dash.rs:582`); `claim_dash` failure is a stderr warning on an exit-0 run (`dash.rs:1424-1431`).

### E. The arc runner: three silent wedges, one wrong stop

Every *decided* stop paints a receipt naming the resume gesture — that discipline is good. The undecided `None`s are the hole:

1. **An implement turn that ends closing no step decides `None` forever** (`dash_arc.rs:488-489`). Nothing re-prompts, nothing stops, no receipt. A wandering implement stage is an arc that sits silently — the largest wedge.
2. **A dispatch whose segment never announces latches `in_flight_at`** (`dash_arc_runner.rs:244-249`); every future tick returns early. Self-healing only if the entry later reads `Errored`.
3. **A mid-turn hang decides `None`** (`dash_arc.rs:268`); there is **no timeout anywhere in the machine** — stops are noticed only on turn-end/recompute edges.
4. **Crash between wheel dispatch and the bridge's `arc-stage` write → the restart is misread as `CardTaken`** (`dash_arc.rs:303-309`) — a wrong stop, though a spoken one. Related restart losses: armed **hand-backs are dropped** (`wheel/mod.rs:214-231`), leaving a card pinned on a stage model; `last_done_count` is re-seeded at current value (`dash_arc_runner.rs:342`), so a step boundary that closed just before the crash never prompts.
5. `arc-stop`/`arc-done` append failures are discarded (`let _ =`, `dash_arc_runner.rs:1050`, `:1098`).

Stage addressing itself is **safe by construction**: the rotation target is always the live-filtered binding, resume is addressed by stage name, and the recorded segment id is only compared, never dereferenced. The binding's stale-id hazard does not recur in the arc's resume path.

### F. The course retrofit: half-landed, and the halves contradict

Doors done (B01, B02, B03, B05, B06, B10, B12 hold). Not landed: **B07** (`TUG_DASH_COURSE` occurs nowhere; env, wire field, and skills all still say arc), **B08** (no `--course`; `open_arc` derives from which document exists), **B09/B11** (off-arc branches stand in `dash-implement`/`dash-review`; `dash-audit` never checks for a course at all; the "expert path" blessings the brief's non-goals name for removal still stand in `tuglaws/dash-work-doctrine.md:5` and `tugplug/CLAUDE.md:37`). **B04 deviates twice**: the runner picks the progression by *document sniffing* (`ArcFacts::task_list`, `dash_arc_runner.rs:505-515`) — exactly what B04 forbids — and the task list is written at the door, not as implement's first act.

`tuglaws/wheel.md:59` states the rejected design as current law ("There is no recorded course kind and no flag"). Ten concrete contradictions between skills and doctrine are enumerated in the skills audit; the worst: `dash-implement/SKILL.md:216` still describes the retired in-thread `/dash`; `:117`'s refusal dialog offers the hand-edit that `:211` forbids; `dash-review:14` and `dash-devise:89` describe incompatible stage-handoff mechanisms.

### G. The skills teach the failure modes

No skill anywhere teaches rotation detection, verification, or recovery. Several teach the failing gestures:

- The doors run `tugtool dash run` then instruct **ending the turn immediately, never polling** (`dash/SKILL.md:126`; `dash-plan/SKILL.md:120`) — the one session that could verify the anchor is told not to look.
- `dash-plan/SKILL.md:67` recommends **`/dash-bind` as the repair** — the verb the postmortem shows succeeding in both failure modes.
- `dash-implement/SKILL.md:157` tells a rotated-in session it "needs nothing from you" — the exact session the incident shows stranded.
- `dash-implement/SKILL.md:105` advertises withdraw for steps that turn out unnecessary with no warning that withdraw ≠ park; `:117` offers the hand-edit.
- The **green baseline** is established once at Setup and recorded nowhere; the **brief is missing from the audit stage's reading list** (`dash-audit/SKILL.md:41` calls the ledger "the only" standard, while `dash/SKILL.md:142` says the brief is what audit judges intent against).
- Standalone-contract nits: `dash-review/SKILL.md:53` says "tugdeck" bare (Tug-specific knowledge in the plugin); `tug log` is instructed (`dash-implement:149`) — verify `tug` ships in the bundle; `tugplug/CLAUDE.md` is lint-exempt (`scripts/tugplug-lint.ts:84`), so its drift is uncaught mechanically.

### H. What no test covers

- **The postmortem's exact scenario end-to-end**: rotation mid-implement → binding carried onto the fresh segment → card and Z2 stay populated → a `tugtool dash` verb from the stale env lands on the live segment → the next step is prompted. (`at0485` covers the *relaunch* seat; the ledger units cover `seat_line_binding` in isolation; nothing joins them.)
- tugcast restart mid-arc (unit-tested only); the false-`CardTaken` path untested entirely; stage crash only via hand-set state.
- `bind_dash_ok` in tugdeck; a desynced table/log pair; the CLI bind's stale-id echo; duplicate `step-start` lines; bogus `--commit` shas.
- The silent wedges have no tests **because they have no behavior** — which is itself the finding.

---

## Part II — The pattern underneath

Three sentences carry all of Part I:

1. **Identity is a convention, not a chokepoint.** The line model stops at the session ledger's edge; every consumer re-solves staleness locally (`line_segments`, `session_citation_for`, `calling_segment`), each fix leaves the next caller exposed, and nothing structural makes the raw id unwritable. Fourth incident in this class (claim-orphans, the vanished receipts, the stranded arc, and the three writers still open).
2. **Verbs succeed while achieving nothing, and surfaces disagree without a detector.** Bind's echo, claim's warning, mark over pending rows, the table/log split, the deck's no-op handler, the discarded appends — every one exits 0. The gaps note counted six of nine defects in this shape, found only by a person looking at a screen.
3. **The machine's states don't span the run's states.** No `step reset`, `done` unrecoverable, withdraw overloaded, implement-with-no-boundary undecided, hand-backs unpersisted — so real runs are forced off the sanctioned paths, and the discipline that keeps the surfaces consistent has to be broken to make progress.

A facility whose premise is unattended runs across deliberate rotations cannot rest on convention, silent success, or hand-edits. The hardening below is organized to kill each pattern class, not each instance.

---

## Part III — The proposal

Six workstreams, ordered by dependency. W1–W3 are the confidence-critical core and should land from ordinary main-lane sessions (the dash machinery should not be trusted to rebuild itself). W5 is the course retrofit's outstanding half and can run as a dash once W1–W3 land — a fitting first passenger. Each workstream names its guard, because the guard is what makes the fix a class-closure rather than the fifth instance-patch.

### W1 — One identity chokepoint, structurally enforced

The postmortem posed two options: stop the id being stale, or stop it being usable raw. Take the second, completely, and add the guard that makes it stick:

1. **`calling_session_id` resolves, always.** The tugtool-side resolver asks the instance API for the live segment of its line before any use (it already holds the port-walk machinery), and every verb prints the *resolved* id. `run_bind` reads `response["session_id"]` instead of echoing the posted value. Add `--session` to `bind|stop|unbind|run`, and rewrite the refusal to name the resolved id and its `state`.
2. **Route the three stragglers through the door.** `draft` owners, `ask`, and `changes claim|disclaim` either resolve through the same chokepoint or their servers/readers expand by line (`Owner::keys()` gains line expansion; `pending-ask-store` routes by line). **Settled 2026-08-31: `file_events` grows a `line_id` column** — the durable fix, surviving a sessions-ledger prune — with the required `CHANGES_SCHEMA_VERSION` bump and registered migration. Fix `draft/SKILL.md:82` to stop pinning the raw id.
3. **The guard tests.** In the `no_ad_hoc_ledger_opens` mold: a source-scan test that refuses any `std::env::var("TUG_SESSION_ID")` outside the one resolver (allowlist: the spawn-time exporters); a tugcast test that refuses any session-keyed binding `UPDATE` outside `set_dash_binding`/`seat_line_binding`. This is the single highest-leverage item in the whole plan — it converts the fourth incident into the last one.
4. **Close the expansion edges.** `seat_line_binding` gains the `state='live'` predicate; `live_segment_of`'s ordering prefers the newest live segment during the rotation-overlap window (the posted-id-wins tiebreak is the wrong bias when the poster is the retiring segment); verify the `tugcode` respawn assumption (a rotation always re-spawns tugcode) with a test, since the whole design leans on it.

### W2 — No silent success on the binding path

1. **Fix the rotation broadcast race.** Send `session_updated` before `bind_dash_ok`, or carry `line_id`/`card_id` on the broadcast so the deck can route it without the row; the deck handler warns instead of silently no-opping; the rotation seat fires the `changeset_all_bump` the masthead index needs. Add the missing tugdeck test for `bind_dash_ok`, and delete the stale [P07] comments.
2. **Fix `reported_binding`.** Gate on the dash *record* existing, not on the branch ref (pre-branch arc bindings are valid by design); distinguish git-failure from genuinely-no-branches (a failure keeps the ledger's answer rather than nulling it); trace the gate's decision under `dev::ledger` — the postmortem's "instrument this first" ask, still unmet.
3. **Truthful exits.** `claim_dash` failure fails the verb (or at minimum the JSON carries `claimed: false` and the skills check it); `step done --commit` verifies the sha resolves in the dash worktree; `mark built|audited` warns when ledger rows are open; `bind` grows `--dry-run` printing the resolved segment and state without writing.

### W3 — Complete the step machine; make the three records one story

1. **`step reset <n>`** — row to `pending`, commit cell cleared, paired log line, refused on `done`. **`step reopen <n>`** — `done → in progress` with a log line naming why (the audit-rejected case). **Settled 2026-08-31: reopen un-arms `join_ready`** until the step is re-closed — the log line gives `read_declarations` the fact it needs.
2. **One writer, one truth.** Table and log move in a single atomic write (write both to temp, rename both, or derive one from the other); `step start` re-entry stops appending duplicate log lines when the rewrite was a no-op.
3. **`dash doctor <name>`** — diffs table vs log vs sqlite binding vs arc record, names each disagreement in a sentence, and offers the reconciling append. This is also the recovery gesture the skills can finally teach. Run its read-only core in `dash status` so an ordinary status call says "ledger and log disagree at step 4" instead of silently answering from one side.

### W4 — The arc cannot wedge or mis-stop silently

1. **A quiet-turn horizon.** An implement turn that ends closing no step increments a counter; after **2 quiet turns (settled 2026-08-31)** the runner stops with a new receipt-bearing stop reason (`ImplementIdle`) naming the resume gesture — a stop with a receipt, not a re-prompt. Same horizon retires a latched `in_flight_at`.
2. **Restart correctness.** Persist armed hand-backs beside `deck_model`; re-derive `last_done_count` from the ledger at startup instead of seeding at current; fix the false `CardTaken` by recording dispatch intent (an `arc-dispatch` line) before the wheel fires, so a crash in the gap reads as "re-rotate" rather than "taken".
3. **Loud appends.** A failed `arc-stop`/`arc-done` append logs at warn with the path, never `let _ =`.

### W5 — Finish the course retrofit; rewrite the skills to teach recovery

Land the machinery half first (the brief's own Exit ordering): recorded course kind in the arc record, `--course dash|plan` defaulting to plan, `TUG_DASH_COURSE` through the wheel wire and `tugcode`, runner reads the kind instead of sniffing (`ArcFacts::task_list` demoted to a fallback for pre-kind dashes). Then the documents, which now have material W1–W4 gave them:

- Delete the off-arc branches and in-thread residue (`dash-implement:74,155,183,216`; `dash-review:110-128`; doctrine `:114`, `:229` rewritten per B09); give `dash-audit` the course check it never had; remove the "expert path" blessings; fix `wheel.md:59` and the ten enumerated contradictions.
- **Teach verification and recovery**: the doors confirm `dash run`'s receipt names a live segment before ending the turn; stages get a two-line rotation self-check (`tugtool dash status --json` names the bound sessions — is mine among them?) and are told the repair is `dash doctor`, not `/dash-bind`; withdraw's text warns it is not a park and points at `step reset`; the hand-edit dialog option is replaced by the new verbs; the audit's reading list gains the brief; the green baseline is recorded in the dash's documents at Setup (and the skills point at `apptest_results.db` history for it).
- Standalone nits: generalize `dash-review:53`'s bare "tugdeck"; verify `tug` ships in the bundle or drop `tug log` from the skills; consider bringing `tugplug/CLAUDE.md` under the lint.

### W6 — The end-to-end gate

One app-test that *is* the postmortem: open an arc, force an implement rotation (a test-lowered `implement_compact_tokens`), and assert the binding rode the seat, the card and Z2 stayed populated, a `dash` verb issued with the stale env id landed on the live segment, and the next step was prompted. Plus: tugcast restart mid-arc (including the crash-before-`arc-stage` gap once W4.2 fixes it), a stage-kill test, and the tugdeck `bind_dash_ok` test from W2. These are the tests that make "the Wheel's promise" — a rotation invisible to the work — an asserted property rather than a hope.

### Sequencing and what not to do

- W1 → W2 → {W3, W4 in parallel} → W5 → W6 grows alongside each. W1.3's guard tests land *with* W1.1, not after.
- **Do not run W1–W3 as a dash.** The machinery under repair is the machinery a dash runs on; a rotation mid-fix would be debugging the patient with the patient. Main-lane sessions, ordinary `/commit` landings.
- W5 is the natural first `/dash-plan` passenger once W1–W3 are landed — it exercises exactly the paths just hardened, and its audit stage is the acceptance test for the skill rewrites.

### Open questions

None. The three that were open — reopen un-arming `join_ready`, the `file_events.line_id` column, and the `ImplementIdle` horizon of 2 — were settled by the user 2026-08-31 and folded into W1, W3, and W4 above.

---

## Part IV — W1 as landed, and four corrections to Part I

**W1 landed 2026-08-31** from main-lane sessions, in seven commits. The shape is as proposed — one resolver, structurally enforced — but four of Part I's facts did not survive contact, and W2+ should be read against these rather than against the sections above.

**1. `file_events.line_id` already exists.** Part I.A.1 and W1.2 record the column as a settled decision still to be made. It is `CHANGES_SCHEMA_VERSION` **3**, already on disk with a registered migration (`ADD_FILE_EVENTS_LINE_ID_SQL`), stamped at write time by `insert_file_event` from the *writer's* line. Further, `do_changeset_claim` (`agent_supervisor.rs:6004`) already expands an incoming segment id to its line's seat and writes under that, keeping every id the line has worn. So `changes claim|disclaim` was never misattributed at rest, and no schema work was needed. What W1 changed there is the CLI side only: the verb resolves before it posts, so the receipt names the live segment and `revive_on_activity` is not handed a corpse.

**2. A rotation does *not* respawn tugcode.** Part I.A.5 calls the pass-through "safe iff a rotation always means a fresh tugcode spawn; unverified." It is not safe: `wheel::rotate` sends a `session_command "new"` frame down the *existing* card's `input_tx`, and `SessionManager.newSession` (`tugcode/src/session.ts`) mints a fresh session id and respawns only **claude**, inside the same tugcode process. `process.env.TUG_SESSION_ID` therefore named the segment the card was born on for the card's entire life — the widest instance of the class, and the one nobody had counted. The spawn env is now built by `buildClaudeSpawnEnv`, which stamps the manager's current id (tested in `tugcode/spawn-env.test.ts`). This narrows the window; a shell already running when the rotation lands still holds the old value, which is why the resolver remains the guarantee.

**3. The stale id was not the only silent thing on the binding path.** `post_instance_api`'s try-each-instance loop kept the **last** error, and `unknown_session` — one instance's "not mine, keep walking" — is an error like any other. On any machine with a second instance live, a bystander's shrug overwrote the sentence the owning instance had already given: `at0476`'s bind-refusal assertion had been red for eleven recorded runs reporting `unknown_session` where the server had said `card runs <name>`. Fixed, and green. Part II's second sentence is right about the pattern and understated about its reach.

**4. Version skew is a real refusal surface.** The resolver asks an instance for an op the instance may not have. Refusing there broke every session-addressed verb between installing a build and restarting the app — caught only because the app-test bundle was stale. `unknown op` now degrades to the posted id (`/api/dash` resolves at its own door regardless), with a CLI test driving a tugcast that answers exactly that. Any later workstream adding an op to an existing endpoint owes the same fallback.

### What W1 deliberately left

- **The deck's `bind_dash_ok` handling and the rotation broadcast race** (Part I.B) — W2 by assignment. W1 touched the deck once, to make `pendingAskStore`'s `sessionFor` route by line as well as by id; that path has no deck test, for the same reason W2 owns the missing `bind_dash_ok` one.
- **`reported_binding`'s branch gate** (Part I.C) — W2.
- **`at0476`'s stop-receipt assertion** expects `arc stopped` where the card now says `you stopped it`. Pre-existing wording drift, red since `4cd1c9a45`, untouched here: it belongs with W4's receipt work, not with identity.
- **`at0387`** times out waiting for the Overview card to mount. Pre-existing and unrelated to identity; it covers `action-dispatch.ts`, which is why it kept appearing in the selection.

---

## Part V — W2 as landed, and five corrections to Part I

**W2 landed 2026-08-31** from main-lane sessions, in four commits. The shape is
as proposed — nothing on the binding path succeeds without its effect being
real and visible — but five of Part I's facts did not survive contact, and W3+
should be read against these as well as against Part IV.

**1. `session_updated` carries no dash at all.** Part I.B's fix reads as "send
`session_updated` before `bind_dash_ok`, so the push already says which dash."
`build_session_updated_frame` has no dash field and never had one — the ack
does, the push does not. Ordering the push first works for a different reason:
the push is the only frame that carries the `(session_id, line_id)` pair, and
that pair is what the deck's segment → line → card walk is made of. So the
order matters because of *identity*, not because of the binding. The
announcement now also carries `line_id` and `card_id` itself, which is the
belt to the ordering's braces.

**2. `reported_binding`'s branch gate has a third door, not two.** Part I.C
names the pre-branch arc binding and the empty-set-on-git-failure. There is
also `list_card_bindings`'s per-project map (`agent_supervisor.rs`), whose
`unwrap_or(&no_dashes)` gave a project *missing from the map* the same empty
set — so a row whose `project_dir` spelling drifted out of the collected set
was nulled having never been asked about. Fixed with the other two; the gate is
now `DashRecords::{Known, Unreadable}` and only `Known` may null.

**3. The dash's record is the `tugid`, not the branch — and `ops::mark` still
gates on the branch.** The fix for the pre-branch nulling is that
`live_dash_records` accepts either a `tugdash/<name>` ref or a
`branch.tugdash/<name>.tugid` config entry, because a teardown takes both
together. `tugdash_core::ops::mark` was not brought along: it still refuses
with "Dash not found" when the branch is absent, so a pre-branch arc cannot be
marked at all. Left for W3, which owns the step machine and is where the
ledger verbs' entry conditions belong together.

**4. "`claim_dash` failure fails the verb" has a third case Part III does not
anticipate.** Taken literally it fails every CLI fixture that creates a scratch
dash in a temp repo from inside a Session card — because `dash_api::bind`
refuses a session binding a dash outside its own checkout, and that refusal
says nothing about whether a claim was lost. The landed shape distinguishes
**refused** (fatal) from **never entitled** (skipped), which needed a fact this
side did not have: `POST /api/session {op:"resolve"}` now answers with the
session's `project_dir`. Additive, and skew-safe by Part IV's rule — an
instance that omits it cannot be asked, so the refusal warns exactly as it used
to. W5's skill rewrites should teach `claimed` in the JSON rather than the exit
code alone, since three of the four outcomes exit 0.

**5. The CLI test corpus leaks the ambient session.** `tripwire_cli.rs` ran
`tugtool dash create` in a temp repo with neither `TUG_SESSION_ID` nor `TMPDIR`
scrubbed, so on a developer's machine it reached the real instance registry and
posted a bind naming a scratch dash — the exact hazard `dash_api::bind`'s
same-project guard was added for, met from the other side. Scrubbed here.
`dash_binding_cli.rs` and `dash_verify_cli.rs` were already careful; the other
five CLI test files drive no binding verb today, and nothing stops the next one
from doing so. A source-scan guard in the `no_ad_hoc_*` mold — a CLI test that
shells `tugtool` must scrub the session env — is the class-closure, and is not
landed.

### What W2 deliberately left

- **The step machine** (Part I.D) — W3 by assignment. `step done --commit` now
  verifies its sha and `mark` reports open rows, but there is still no `step
  reset`, `done` is still terminal, and the table/log pair still moves in two
  writes.
- **`ops::mark`'s branch gate** — finding 3 above, W3.
- **The arc runner's silent wedges** (Part I.E) — W4.
- **Teaching the new verbs.** `dash bind --dry-run` exists and no skill mentions
  it; `dash-plan/SKILL.md:67` still recommends `/dash-bind` as the repair. W5.
- **`at0476`'s stop-receipt subtest, `at0387`'s Overview-mount timeout, and
  `tugcode`'s `plugin-commands.test.ts`** — pre-existing reds, unrelated, as
  Part IV records.

---

## Part VI — W3 as landed, and what W4+ should read Part I against

**W3 landed 2026-09-01** from a main-lane session, in three commits. The step
machine now spans the states a real run passes through, the two records a step
move produces are committed as one act, and a doctor compares all four. Four
things did not survive contact, and one of them changes what a later
workstream should expect to find.

**1. "One atomic write" is not available, and the brief's own three options
say so.** Part III W3.2 offers "write both to temp, rename both, or derive one
from the other". The first is unavailable: the dash-log is shared by every dash
in the project and appended to concurrently, so a read-modify-rename would drop
a neighbouring dash's line between the read and the rename. The third is
unavailable in the direction it is needed: the log cannot be derived from the
table (the table has no timestamps and no run-through), and the table cannot be
derived from the log without becoming a generated file a person may not edit —
which is the opposite of what the plan wants. What landed is the fourth option:
**order the fallible parts before the committing parts.** `write_step_pair`
opens the dash-log — where a log append actually fails — *before* the table's
rename, writes the line through the handle it already holds, and rolls the
table back if the write still fails. Every ordinary error path now leaves both
records agreeing. What remains is a hard crash between a rename and a write:
two adjacent syscalls rather than a file-write plus an open-and-append, and the
doctor's `undeclared-open-row` finding is exactly its shape. A later workstream
should not go looking for the transaction; there isn't one to find.

**2. `done` stopped being terminal, but only through one door.** Adding
`done → in progress` to `transition_allowed` would have made an ordinary
`dash step start` reopen a finished row silently, which is a *worse* silent
success than the one W3 came to close. So `reopen_ledger_row` carries its own
gate and `set_ledger_status` is unchanged; `dash step start` on a `done` row
still refuses. Anything reading the transition table alone will conclude `done`
is terminal, and for every verb but `reopen` it is.

**3. The reopen un-arms the join through arithmetic, not a flag.** The settled
decision reads as though `read_declarations` needs a new field. It does not:
`step-reopen` and `step-reset` clear `last_step_done` exactly as `step-start`
does, and `run_complete` falls out false. So the un-arming is one line in an
existing fold, it survives a `step-reset` of any step in the selection for free,
and there is no new state for a consumer to have missed. Nothing else needed
touching — `derive_stage`, `run_fraction`, `join_ready`, and the changeset
feed's closed count all agree without changes, because the feed's count already
derives from the table's statuses and `pending`/`in progress` were already in
its vocabulary.

**4. Part I.H's "known pre-existing reds" list is short by two, and one of them
is a W1/W2 regression.** Parts IV and V name three: `at0476`'s stop-receipt
wording, `at0387`'s Overview mount, `tugcode`'s `plugin-commands.test.ts`.
Running the seven app-tests that `@covers` W3's touched sources found five red,
all pre-existing:

- `at0427`, `at0479`, `at0486` share one failure — a 32s/80s timeout waiting
  for `[data-slot="tug-sheet"]` to mount in the Changes pane. Red for the last
  3 recorded runs, back to `4cd1c9a45` (2026-08-31). One deck-side cause, three
  files; worth chasing as one thing.
- `at0475` fails at `dash bind` with *"no running Tug instance knows session
  …"*. Its last green was `abf230c42` — **before W1** — and it fails
  identically at `346af9df7`, W3's parent, verified by running it from a
  worktree at that commit. So it went red somewhere in W1/W2, and the failure
  names the instance walk those workstreams rewrote (`206e96adb`,
  `a7f5ec7ff`). **This is a real regression in the identity chokepoint that
  W1's own app-test selection did not surface**, and it is the one item here a
  later workstream should treat as work rather than as context.

### What W3 deliberately left

- **`step reopen`'s effect on the arc runner.** A reopened step reads `in
  progress` in the table, so `first_pending` points at it and a resumed
  implement stage walks it again — which is what the audit-rejected case wants.
  But the runner has no idea it is a *re*-walk, so a quiet-turn horizon (W4.1)
  will count it like any other. Fine as it stands; worth a thought when W4
  writes the horizon.
- **The doctor is not taught anywhere.** No skill mentions `dash doctor`,
  `dash step reset`, or `dash step reopen`; `dash-implement/SKILL.md:105` still
  advertises withdraw with no warning that it is not a park, and `:117` still
  offers the hand-edit these verbs replace. W5 by assignment, and the verbs
  now exist for it to point at.
- **The arc's silent wedges** (Part I.E) — W4, untouched. The doctor's
  `arc-unbound` finding *reports* a stranded arc but does nothing about it;
  detection was in scope and the horizon is not.
- **A `dash doctor` app-test.** The doctor is covered by unit tests at both
  altitudes (the checks against synthesized tables, and the whole verb against
  a real dash whose table was moved by hand). Nothing drives it through the
  card, because the gate for the surfaces it would need is among the five reds
  above.

---

## Part VII — W4 as landed, and six corrections to Parts I and VI

**W4 landed 2026-09-01** from a main-lane session, in six commits: two paying
W1–W3's debts, then the arc's three. The shape is as proposed — the arc cannot
wedge or mis-stop without saying so — but six facts did not survive contact,
and one of them is a limit on W4's own fix that W5 and W6 should read before
trusting Part III's wording.

**1. `at0475`'s regression was a stderr contract, not the instance walk.** Part
VI names three suspects in the instance-walk code (`e1991caf2`, `a7f5ec7ff`,
`206e96adb`) and calls the failure "a real regression in the identity
chokepoint". The commit is right — `e1991caf2` — and the location is not. The
walk is correct and W1's two behaviors are intact. What broke is that `resolve`
turned the walk's raw `unknown_session` into an actionable sentence, and
`unknown_session` was the only thing a caller could branch on to tell the
refusal's *one legitimately transient cause* — the ledger row a card's spawn
writes lands a moment after the card does — from a permanent one.
`tests/app-test/dash-fixture.ts`'s `bindDash` polls through exactly that window
on the token; the prose swallowed it and the poll became a hard throw at 3s.
The sentence now keeps the token, and a CLI test pins both halves. **The
general fact for later workstreams: a refusal's wording is a wire contract when
anything branches on it, and prose alone is not a superset of a token.**

**2. The middle-step wedge needed a second number, not a restored one.** Part
VI's item 3 records that reopen un-arms the join "through arithmetic, not a
flag" and that "nothing else needed touching". True for the *final* step, which
is all the test covered; false for every other. Re-closing a reopened middle
step wrote the run's frontier back to that step's own number, so a five-step run
whose step 2 was reopened and re-closed read as "reached step 2" and could never
be joined again. `read_declarations` now carries the frontier — the highest step
a close reached, which only rises — separately from the set of steps still open
or parked, and a run is complete when the frontier covers the selection and
nothing it passed is outstanding. `step reset` inherits the fix, since a park is
the same kind of debt as a reopen. Still no new marker, so the skew direction is
unchanged: an older reader keeps the single-number fold, which errs by leaving a
join un-armed and never by arming one it should not.

**3. The quiet-turn horizon closes the multi-turn wedge and not the
single-turn one.** This is the limit W5/W6 must know. The settled decision is
"2 quiet turns, a stop with a receipt, not a re-prompt" — and *because* it is
not a re-prompt, nothing the arc does manufactures the second turn. A stage
that ends one turn without closing a step and then simply stops working leaves
`quiet_turns == 1` and the arc waiting, exactly as before, forever. The horizon
fires when turns keep ending: a stage that asks a question and is answered, a
user typing on the card, a stage wandering across several turns. Those are the
common shapes and the horizon handles them. The uncommon one — a stage that
finishes the work and never runs `dash step done`, then goes silent — is still
a silent sit. Closing it needs either a re-prompt (rejected) or a clock (there
is still no timeout anywhere in the machine, Part I.E.3, which W4 did not take
on). Worth naming as its own item rather than assuming W4 covered it.

**4. The horizon retires `in_flight_at` on the same terms, with the same
limit.** Part III W4.1 says "the same horizon retires a latched `in_flight_at`",
and it does — the guard now lets a tick through once the count reaches the
horizon. But the count only advances when turns end on the card, so a latch
whose card has gone entirely quiet stays latched. In practice the common case
is the good one: the dispatch frame reached stdin, claude never respawned, and
the *old* session goes on ending turns, which is precisely when the latch needs
retiring. The restart case is covered by `arc-dispatch` instead, which does not
depend on any count.

**5. `turns_ended` does survive a restart, so the boundary fix is
observable.** Worth recording because the opposite is the obvious guess:
`stage_turn_ended` is `turns_ended > 0`, `turns_ended` lives on the in-memory
`LedgerEntry`, and a restart rebuilds it — but the rebind seeds it from the
persisted `turn_count`. So a stage tugcast inherited across a restart is not
made to end one more turn before the arc will look at it, and re-deriving the
unanswered step boundary from the table actually reaches a prompt. Anyone
writing W6's restart test should not go looking for a `stage_turn_ended` bug;
there isn't one.

**6. Part VI's "one shared cause, three files" is two things, and the app-test
corpus has a batch-pressure failure mode nobody has named.** Running the
sixteen app-tests that `@covers` W4's touched sources put seven red. Re-running
the unclassified ones **alone** turned four of them green: `at0334`, `at0335`,
`at0478`, and — the interesting one — `at0486`, which Part VI groups with
`at0427` and `at0479` as one `tug-sheet` mount timeout. `at0427` and `at0479`
fail in isolation too and are the genuine shared deck-side red; `at0486` passes
in 6s alone and times out at 80s in a batch. So a slice of what reads as
"pre-existing red" in a multi-file run is contention between files rather than
a defect in any of them, and the per-file `history:` line cannot distinguish
them — it records the run, not the run's size. **W6 should not build its
end-to-end gate on a batch's verdict without checking the isolated one**, and
whoever chases the `tug-sheet` red should chase two files, not five.

`at0476`'s stop-receipt subtest is untouched and still red for the reason Part
IV gives: the card renders the receipt's structured parts and drops the
`arc stopped ·` prefix the assertion looks for. W4 added a stop *reason* and
changed no receipt wording, so it stayed W5's to fix along with the rest of the
wording drift.

### What W4 deliberately left

- **The course retrofit and the skills** (Part I.F, I.G) — W5 by assignment,
  untouched. `ImplementIdle` and `arc-dispatch` are two more things no skill
  mentions, and `dash-implement` still has no sentence about what to do when
  the arc hands the card back mid-run.
- **The end-to-end gate** (Part I.H, W6) — including the restart-mid-arc test
  and the crash-before-`arc-stage` gap that W4.2 has now made testable. W4's
  coverage of all three restart losses is unit-level: two wheels over one
  ledger for the hand-back, an empty state map for the boundary, and a
  synthesized record for the dispatch gap. Nothing drives a real tugcast
  through a real restart.
- **A timeout anywhere in the machine** (Part I.E.3). The mid-turn hang still
  decides `None`, and correction 3 above is the other half of the same absence.
  It belongs with W6's stage-kill test, which is where a clock could be
  asserted rather than merely added.
- **The other `let _ =` appends.** `arc-plan`, `arc-note`, and the `compact`
  line are still discarded. They are footnotes rather than the record — no
  reader learns whether an arc ended from them — so they were left where the
  brief left them, but they are the same shape and the helper to report them
  now exists.

---

## Part VIII — W5 as landed, and seven corrections to Parts I, VI and VII

**W5 landed 2026-09-01** from a main-lane session, in six commits: the course
kind, the environment rename, `at0476`'s wording, then the documents in three
passes. The shape is as proposed — machinery first, then the prose that
describes it — but seven facts did not survive contact, and two of them change
what W6 should expect.

**1. The course kind could not ride `arc-start`, and the reason generalizes.**
Part III W5 says "recorded course kind in the arc record" without saying where.
The obvious place is a second field on `arc-start`, and it is wrong: that
marker's note is a path read *whole*, so an older `read_arc` would take
`dash/idea.md plan` for the document's name — a reader that misreads is
strictly worse than one that skips. The kind is `arc-course`, a marker of its
own, which every older reader drops through its `_` arm exactly as it drops
`arc-dispatch`. **The general rule: a new fact appended to an existing marker's
note is only skew-safe when that note is already positional.** `arc-stage`
could take one; `arc-start` and `arc-plan` cannot.

**2. `--course` defaulting to `plan` is load-bearing in a way the brief does
not say.** [B08] frames the default as backward compatibility — "every existing
dash resumes unchanged." True, and there is a second reason that outlives the
migration: a pre-kind dash falls back to the document sniff, and the sniff's
error is asymmetric. Opening a dash-course dash at devise costs two rotations
it did not need; opening a plan-course dash at implement skips a cold read it
did. The default and the fallback both lean the same way on purpose, and the
comment in `start_action` says so. A later change that flips the default to
`dash` for economy would be flipping the direction of that error.

**3. The rename needed three wires, not two.** Part III W5 names
`RotationRequest`, the stage frame's `"arc"`, and tugcode. There is a fourth
hop nobody counted: tugcode's *outbound* `session_segment` announcement also
carries `arc`, and tugcast turns it into the `arc-stage` line. Renaming it
would have pulled in tugcast's parser and the deck's divider for no gain, so
that field keeps its spelling and is instead **sourced from the resolved
course** (`course ?? arc`) rather than from whichever field arrived. The skew
correctness lives in the resolution, not in the name — which is the cheaper
half of the same guarantee, and worth reaching for first the next time a rename
crosses a process boundary.

**4. `at0476` was a test bug, not a receipt bug, and Parts IV and VII both
guessed the other way.** Both record it as "wording drift" to be fixed "along
with the rest of the wording drift" — implying the card should be made to say
`arc stopped` again. It should not. That prefix is `parseArcReceipt`'s key, and
spending it is the arc-receipt block's entire purpose: the block renders the
dash as an atom, the reason as the lifecycle strip's note, and the resume
sentence on its own line. The assertion pinned the row to *not* having been
recognized. Fixed on the test side, and green. **Nothing in the receipt wording
changed in W1–W5**, so any later red asserting a raw receipt prefix is the same
mistake rather than a regression.

**5. `tug` does not ship in the bundle, so `tug log` is gone.** Part I.G leaves
this as a thing to verify. The answer is definite: the Xcode copy phase carries
`tugcast tugcode tugtool tugedit tugexec tugrelaunch tugpulse` into
`Contents/MacOS/`, and `tug` is not among them. Every `tug log` in the plugin
and the doctrine is replaced — by `tugtool dash show <name>` where the rounds'
instructions were wanted, and by `git log` where recent joins were.

**6. `tugplug/CLAUDE.md` stays lint-exempt, and the exemption is now written
down.** Part III W5 asks whether to bring it under the lint. No: the file is
*about* the standalone contract rather than a party to it, so it must be able
to name the guard, the repository's own build declaration, and the paths a
reader needs — every one a string the lint refuses. Nothing loads it in a
user's project (Claude Code reads a `CLAUDE.md` from the working tree, and the
plugin's own is not one), so its drift costs a user nothing. The file now says
this, which converts an exemption into a decision.

**7. `at0486` is not batch pressure, and Part VII's regrouping was one file
too generous.** Part VII moves `at0486` out of the `tug-sheet` group on the
strength of one isolated pass in 6s. It fails in isolation now — 83s to the
same `[data-slot="tug-sheet"]` mount timeout — and it fails identically from a
worktree at `74d793cfc`, W5's parent, so it is not W5's. **The `tug-sheet` red
is three files, not two**: `at0427`, `at0479`, `at0486`. Whoever chases it
should chase all three. The lesson is the one Part VII drew and then
under-applied: a single isolated run classifies nothing when the failure is a
32s/80s timeout, because a timeout's outcome is a race with the machine's load
either way. Two isolated runs, or a run from a parent commit, is the cheapest
thing that actually decides it.

`at0478` did re-run green alone and is batch pressure as Part VII says.

### One thing the audit does not list, found while rewriting

**The never-ask boundary is inconsistent across the four stages, and always
was.** `dash-implement` and `dash-audit` now raise no dialog at all, and say so
in their frontmatter rather than only in prose. But `dash-devise` and
`dash-review` still raise `AskUserQuestion` for a design call — devise for a
`[Q##]` it would otherwise defer, review for a judgment the rubric hands it —
and under the wheel those stages are rotated sessions like any other, so a
dialog there stops a course in front of whoever happens to be watching. This
is not one of the ten enumerated contradictions and the brief does not settle
it: [B11] made all four stages *refuse to run outside a course* and said
nothing about what they may do inside one. The doctrine now states the split as
it actually is, and names devise and review as the one place the boundary is a
judgment rather than a rule. **It is a real open question and it is the only
one W5 leaves.**

### What W5 deliberately left

- **The end-to-end gate** (Part I.H, W6) — untouched by assignment. What W5
  adds to its brief: the course kind is now an assertable fact end-to-end
  (`dash run --json` carries `arc.course`, and `at0476`'s resume diagnostic
  already shows it riding through the real app), and the `--course dash`
  progression has no app-test at all — it is covered only by the predicate's
  unit tests.
- **The `tug-sheet` mount red** — three files, pre-existing, and the gate for
  most of the dash-lane surfaces W6 would want to drive.
- **A timeout anywhere in the machine** (Part I.E.3, Part VII's item 3). The
  quiet-turn horizon still cannot catch a stage that ends one turn and goes
  silent, and the doctrine now says so in the same breath as the horizon rather
  than leaving the limit in this note alone.
- **The devise/review dialog question** above.

---

## Part IX — W6 as landed, and ten corrections to Parts I, VI, VII and VIII

**W6 landed 2026-09-01** from a main-lane session. Its job was to turn the
Wheel's promise into an asserted property, add the one piece of machinery W4
named and deferred, and close the test-suite debts. Ten facts did not survive
contact, and three of them are corrections to conclusions earlier parts drew
about the same red twice.

**1. The `tug-sheet` red is neither of the two things Part VIII offers, and
the probe is worth writing down.** Parts VI, VII and VIII spend three rounds
regrouping `at0427`, `at0479` and `at0486` and never look at what the DOM
holds at the moment they fail. It holds this: `document.elementFromPoint` at
the composer's own centre answers `DIV.tug-alert-overlay`. **The restore gate
is up when the test clicks.** The gate is correct and blocking by design — a
cold restore holds the one main thread every card shares — and what is wrong
is that `nativeClickAtElement` posts into it anyway. The click is spent on the
scrim, the composer never focuses, the `/commit` typed after it goes nowhere,
and the test fails thirty seconds later pointing at a sheet, five steps
downstream of the event. Being a race is why one of the three was flaky and
two were not, and why a batch made it worse: a loaded machine restores slower.
Fixed in `centerOfElement`, which every `*AtElement` verb goes through: it
waits, briefly and advisorily, for the target's own centre to hit-test to the
target, and reads the bounds after that wait. All three are green.

**The general fact:** a failure whose symptom is a *later* wait timing out
should be diagnosed by asking what the DOM held at the *earlier* gesture. Three
rounds of re-running classified nothing that one `elementFromPoint` settled.

**2. "Red since `4cd1c9a45`" over-reads the `history:` line, and the line was
right.** Parts VI and VIII both treat that sha as when the red began.
`4cd1c9a45` changes one file, `notes/dash-course-proposal.md`. The `back to`
sha is the `HEAD` of the *oldest recorded red run*, not the commit that broke
anything — and for `at0427` and `at0479` there is no recorded green on this
checkout at all, so the streak reaches back only as far as the ledger does.
A `back to` sha is a place to start looking, never an accusation.

**3. The batch-size fact needed no schema change, and the brief's ask for one
was the wrong shape.** Part III's W6 asks for the run's batch size recorded in
`apptest_results.db` under the registered-migration regime. It is already
there: one `results` row per file that ran, so the size is `COUNT(*)` over the
run's non-`SKIP` result rows. Deriving it is strictly better than storing it —
a stored column can disagree with the rows it counts, and this cannot. Every
outcome now carries it (`filesInRun` on a green, `minFilesInRun`/
`maxFilesInRun` across a streak) and the `history:` line renders `alone` or
`in a batch of N`, which is the reading that tells a defect from contention.

**4. `at0486` fails alone, and the ledger says so without a re-run.** Part VII
moved it out of the `tug-sheet` group on one isolated pass; Part VIII moved it
back on one isolated failure; each drew the lesson that a single run classifies
nothing. With the sizes recorded, the answer was one query: red in batches of
**1** as well as of 12. Part VIII's regrouping was right, and nobody needs to
run anything to know it next time.

**5. A stage kill does not reach `SessionGone`, so W6's stage-kill test does
not exist.** Driven end to end — a seated stage, its claude killed, ninety
seconds of sweeps — the arc decided nothing. That is by design and the design
is right: `session_snapshot` returns `None` for `SpawnState::Idle`, because a
card parked `Idle` is indistinguishable from one whose tugcast just restarted
and judging it would stop every in-flight arc on every relaunch. A killed child
parks there rather than in `Errored`/`Closed`. `SessionGone` is reachable from
those two, which a kill is not the gesture for. Recorded in `at0503`'s docblock
so the next reader does not go looking for the bug.

**6. The clock needed a second signal, and the obvious one is already in the
snapshot.** With a turn *ending* as the only motion, the deadline has to
outlast the longest legitimate turn — a stage running a full test sweep — and
a deadline that long leaves the wedge sitting most of a working day. The
seated session's **context size** is the within-turn signal: a turn doing real
work reports usage as it goes and the number climbs; a hung turn reports
nothing and it stands still. A number that does not move is not proof of a
hang and does not have to be — it only has to stop the clock being *reset* by
a turn producing nothing. That is what makes `arc_stall_secs`' half-hour
default defensible rather than a compromise.

**7. The clock is skew-free, and the reason generalizes Part VIII's rule.**
`ArcRecord::stopped` has always carried a free-text `String`, and the deck
renders it as one, so `ArcStopReason::Stalled` costs an older reader nothing:
no new marker, no new field, no new op. **A new *member* of a vocabulary that
already travels as free text is the cheapest skew there is** — cheaper than
`arc-course`'s new marker, which is what Part VIII's rule is about. The
expensive case is a vocabulary a reader *matches on*, and this one is not.

**8. `implement idle` never reached the doctrine's closed vocabulary.** W4
added the reason and its receipt and did not add its row to
`dash-lifecycle.md`'s Interruptions table or its word to the closed list two
sections below — which is the list that says what the receipt formatter is
allowed to explain. Both are in, along with `stalled`'s.

**9. Part I.H's red list is short by two more, and both are two lines.**
`tugcode`'s `plugin-commands.test.ts` pinned `/dash`'s frontmatter description
to a phrase W5 rewrote — the same mistake as `at0476`, one repository over, and
it now asserts the description occurs verbatim in the shipped `SKILL.md`
instead. And `replay-dead-invariants.test.ts` is the TypeScript half of the
very failure Task 4c named only in Rust: 746 sessions, zero dead branches,
every invariant vacuous. **A corpus-dependent test skips with a note when the
corpus lacks its case** — both halves now do, and both point at the committed
`rewind-and-compact.jsonl` fixture as the guard that does not depend on what a
machine happens to hold.

**10. Two app-tests on one dash share one dash-log generation.** `at0503`'s
first draft ran both its cases against one dash and read back two `arc-stage`
lines where one rotation had happened. The dash-log is one shared, append-only
file per project, so a fixture that wants its own record needs its own dash.
Cheap to get wrong, and it reads as a machine doing something extra rather
than as a fixture answering about the wrong run.

**11. `just app-test` builds the bundle *if missing*, never if stale — and
every app-test W6 ran before noticing was driving a tugcast from before W4.**
Part IV records this hazard and its consequence once already ("caught only
because the app-test bundle was stale"), as a thing that happened to W1. It is
not a thing that happened; it is the standing behaviour of the recipe, and it
catches whoever does not check. The bundle under `Tug-apptest.app` held a
`tugcast` with no `arc-course`, no `arc-dispatch` and no `implement idle` in
it — W5's marker and two of W4's — which is diagnosable in one line:

    strings -a <bundle>/Contents/MacOS/tugcast | grep -c arc-course

**The false red it produced is worth keeping**, because it is exactly the
shape a real defect would have taken. A `--course plan` arc over a
brief-and-task-list dash opened at **implement**, which is the document sniff's
answer and not the recorded kind's — precisely [B04]'s deviation, which W5
landed the fix for. The predicate was right (`start_action` reads
`record.course` first, and `a_recorded_plan_course_devises_over_a_task_list`
pins it); the binary was old. An hour went into reading a correct machine
looking for the bug in it.

Two rules follow. **`just app-test-build`, not `just app-test`, after any Rust
change you intend an app-test to exercise** — and the tugcast in the bundle is
the one that runs, while `tugtool` comes from `target/debug`, so a run can
easily be half fresh. And **an app-test that asserts on new server behaviour
should be able to say which build answered it**: every "the app did not do the
new thing" red is this until ruled out, and ruling it out costs one `strings`.

**12. The postmortem's symptom is still standing, and the gate found it.**
This is W6's finding and the reason the workstream was worth running. On a
real wheel rotation, driven end to end in `at0504`:

- the server is **entirely correct**. The wheel mints a fresh segment on the
  card's line, `seat_line_binding` moves the dash onto it, and `dash bind
  --dry-run --json` run with the card's *spawn-time* id answers `rotated:
  true`, `state: live`, and the id of the segment just seated. W1's chokepoint
  and W2's `seat_line_binding` both do exactly what Parts IV and V claim.
- the **deck never learns**. Sixty seconds after the rotation,
  `window.__tug.cardLineFacts("A")` still answers with the pre-rotation
  session id — and with `lineId` *equal to* that id, so the deck does not know
  the card is on a line at all. The masthead's `^<dash>` sigil is looked up by
  the card's session id and so never resolves; the Z2 DASH cell and the stage
  divider are blank for the same reason.

That is Part I.B's hazard — "fixed for explicit binds, racy for the rotation
itself" — and it is **not** the race Part I.B describes. W2 fixed the ordering
and put `line_id`/`card_id` on the announcement, and Part V records both. What
is missing is upstream of the binding entirely: nothing moves the card's own
session identity onto the fresh segment, so there is no card for a correctly
addressed `bind_dash_ok` to land on. A binding announcement that resolves
through `cardIdForSession` cannot help a deck that still thinks the card is the
session it was born as.

**It is pinned, not left red.** `at0504` carries
`DECK_SEAT_FOLLOWS_A_ROTATION = false`, asserts what is true today, prints
`KNOWN DEFECT` in its diagnostics, and goes red — asking for the constant to be
flipped — the moment somebody fixes it. A corpus with a permanently failing
file teaches everyone to read past failures, and this note has now spent three
parts on two reds that survived exactly that way.

**Why five workstreams did not find it.** Every W1-W5 test asserts on the side
of the wire it was written for: the ledger's units over the ledger, the
predicate's table over synthesized facts, the CLI's fixtures over a real
instance, and `at0485` over a *relaunch*, where the card is **resumed** onto
the stage's segment and so is seated correctly by construction. A rotation
under a live card is the one path where the seat has to *move*, and nothing
drove it. Part I.H says exactly this in one line — "nothing joins them" — and
it turns out to have been the whole finding.

---

## Part X — The plan as landed, W1–W6

**The six workstreams are landed.** The class Part II names is closed at every
point it was open: identity resolves at one chokepoint with a source-scan
guard behind it (W1), the binding path has no silent success left on it (W2),
the step machine spans the states a real run passes through and a doctor
reconciles its three records (W3), the arc cannot wedge or mis-stop without
saying so (W4), the course kind is recorded rather than sniffed and the skills
teach recovery (W5), and the promise is asserted end to end against a real app
(W6).

**What W6 added.** The clock — an idle deadline on the arc's watch, restarted
by every turn that ends, every step that closes, every act the wheel takes and
every reading where the seated context grew, stopping through the same
receipt-bearing path as every other stop. Three app-tests that drive the real
thing: `at0503` (a real tugcast restart mid-stage waits, and a card that came
back on a fresh segment is a taking) and `at0504` (the postmortem). The
`tug-sheet` red closed at its true cause, three test-suite debts closed, and
the `history:` line taught to say which batch each outcome ran in.

**What remains open, in the order somebody should take it:**

1. **The deck's seat does not follow a rotation** (Part IX item 12). The one
   real defect left of the original incident, reproducible in `at0504`, pinned
   there, W2-shaped.
2. **`at0387-session-identity-menu`** — the Overview card never mounts. The
   restore-gate class W6 closed on the *click* path is a plausible cause on the
   *key* path (`Cmd+Ctrl+O` posted into a focus-trapped gate goes to its key
   sink), but that is a hypothesis, and a corpus-wide change to `nativeKey`'s
   timing on a hypothesis is not worth it. Test it, then decide.
3. **`at0168`'s `maker.lens` menu row** — Lens-breakout residue, back to
   `a7f5ec7ff` with `at0231`. Whether that row should still exist is the Lens
   arc's call, not the harness's.
4. **The devise/review `AskUserQuestion` boundary** — W5's one open question,
   untouched here because W6's Task 5 was optional and the firing message did
   not confirm it.
5. **A CLI test that shells `tugtool` must scrub the session env** — W2's item
   5, still not landed as a source-scan guard.
6. **The other `let _ =` appends** — `arc-plan`, `arc-note`, and the `compact`
   line, as W4 left them.

**And two habits this note has now paid for twice each**, worth more than any
one item above: **check the build before diagnosing the machine** (Part IX item
11), and **look at what the DOM held at the earlier gesture** rather than
re-running the later wait (Part IX item 1).

---

## Part XI — W7 as landed, and eight corrections to Parts IX and X

**W7 landed 2026-09-01** from a main-lane session, as the fixup workstream:
close the deck's seat (Part X item 1), make a killed stage reach a decision
(Part IX item 5), and — confirmed mid-workstream — retire the mid-course
dialog (Part X item 4). All three are landed. Eight facts did not survive
contact, and the largest of them is the reason the original incident was still
partly standing after six workstreams.

**1. The arc has been factless since its first rotation, and that — not the
kill — is what Part IX item 5 watched.** `bound_arcs` asked the ledger which
session is on the dash and handed the runner that id. The ledger's answer is a
**segment**: after a rotation, the fresh one `seat_line_binding` moved the
binding onto. The supervisor's map is keyed by the **tug session id**, the
card's address, which never moves. So from the moment a course seated its
opening stage, `session_snapshot` looked up an id no entry wears, answered
`None`, and `evaluate` returned early — every tick, forever. No predicate, no
decision, and no clock either, because W6's clock is fed by facts. Part IX read
ninety seconds of that as the consequence of killing the stage's claude; the
kill had nothing to do with it. `bound_arcs` now walks segment → card by
`claude_session_id`, and `a_rotated_binding_still_finds_the_card_the_arc_runs_on`
pins it.

**Why every test missed it.** Before the first rotation the two ids are one
string, so the unit harness — which seats `claude-1` as both the entry key and
the row — could not tell them apart, and neither could any test built on it.
This is Part IX item 12's lesson repeating one layer down: **an identity that
is two facts wearing one string until some event separates them is untested
until a test drives that event.**

**2. A killed child does not park `Idle`, and does not come back.** Part IX
item 5 records the entry parking in `SpawnState::Idle`. Driven by pid in
`at0505`: it stays `Live`. The bridge is *written* to retry — `Crashed` records
against the crash budget and respawns a second later — but no respawn arrives,
`ps` under the app's own tugcast shows no tugcode for the card twenty-four
seconds and five kill rounds later, and the ledger row still reads `live`. So
the wedge was a live session with no process: `spawn_state` is the bridge's own
account of itself and cannot say the retry never returned. `child_gone_at` is
the absence itself, stamped where the relay tears the child down, and
`CHILD_GONE_GRACE` (thirty seconds, against a one-second backoff) is what keeps
an ordinary retry from reading as a death.

**Two drafts of `at0505` were spent arguing with the machine** — one broke out
of the kill loop believing a quiet four seconds meant a dead tree, the next
spent a crash budget that was never being spent. Both were reasoning from the
code's intent rather than from what the process table said. The habit that
ended it is Part IX item 1's, in another key: **when the machine disagrees with
the code you just read, measure the machine.** One `ps` settled what two runs
of inference had not.

**3. `ever_live_here` is correct and was not the fix.** It tells the two
`Idle`s apart — an entry this process watched reach `Live` and found back at
`Idle` has lost its child; one rebound from tugbank has not — and it is kept,
with its own test. But no path observed here parks a dead child there, so it
closes a hole rather than the hole. Recorded plainly because Part IX item 5 is
cited elsewhere as behaviour, and it is not.

**4. The deck's seat was two frozen reads, and neither was a missing
announcement.** Part IX item 12 says nothing moves the card's session identity
onto the fresh segment. Both halves were more specific than that. `binding.lineId`
is the *spawn ack's* value, and a resume of a session the ledger has no row for
yet is acked with none — so it falls back to the session's own id, a line of
one. In `at0504` the binding said `a7c0d1ea-…-504` while `dash bind --dry-run`
said `fa395c92-…`: the card held a line nothing else in the system used. And
the seat itself was never asked for at all. Part IX's "the deck does not know
the card is on a line" was the right observation with the wrong cause — the
line existed, the deck was holding a different one.

**5. A derived seat is a race, and `at0503` is what proved it.** The first fix
composed card → line → the line store's seat, which is "whichever frame seated
that line last". A rotation leaves **two** live rows on the line — the retired
segment's row stays `live` until the card closes — so a later `session_updated`
about the older one moved the answer backwards, and a card bound directly to
its stage read back as its root. The seat is now announced:
`session_line_seated`, the bridge's frame at the `session_init` where the card's
claude id changes on a line it already had, carrying card, segment, and line
together, because only the server holds all three at once. **A fact three
parties each know part of is announced, never composed.**

**6. `session_line_rebound`'s own comment was the doctrine that hid this.** It
says a `/new` is the one id change that needs a push and that "everything else
is another segment of the line the card already has, and needs no push because
nothing moved". Something did move — which segment the card is seated on — and
that sentence is why nobody looked for a frame that was not there.

**7. There is no receipt on the card for a stage that died, and there cannot
be.** The brief asked `at0505` to assert one. By the time the arc decides, the
card has unbound and fallen back to its picker — the DOM under
`[data-card-id="A"]` holds `session-card-picker` and no transcript at all — so
there is nowhere for the receipt to paint. That is the same trade
`dash-lifecycle.md`'s **card closed** row already records: no card left to paint
one on, and the only surface missing is one that does not exist. `at0505`
asserts the picker outright, so the absence is a claim the file makes rather
than a check it quietly dropped.

**8. `at0367` is `at0387`'s twin, and Part X item 2 is short by one.** Part X
names one Overview red. Running W7's derived selection turned up a second:
`at0367-overview-scrollback` fails on `[data-testid="overview-card"]` never
appearing, which is `at0387`'s symptom exactly. It is **not** W7's — reverting
every source file this workstream touched and rebuilding leaves it failing
identically, which `tugtool file probe --patch` established in one run without
disturbing the tree. Two files on one cause is worth more than one: whatever is
keeping the Overview card from mounting is reproducible without a menu, a key
path, or a restore gate in the way, so `at0367` is the cheaper place to test
item 2's hypothesis than `at0387` is.

**And `at0371` was contention, not a red.** It failed in a batch of eleven and
passed alone, which is the reading the `history:` line's batch sizes exist to
make free.

**9. `at0504`'s stage divider is still empty, and it is still only observed.**
Every run of the file notes `stage dividers on the card: []`, green ones
included. The file says why it is observed rather than waited on, and the
finding stands unchanged: whether a rotation should draw a divider on the card
it rotated is a question about presentation that nobody has answered. It is not
the seat — the seat is asserted three ways above it now.

**What W7 added.** `at0504` green with `DECK_SEAT_FOLLOWS_A_ROTATION = true`
and its full deck assertions running on a real rotation. `at0505`, the
stage-kill test W6 could not write. `session_line_seated` and the binding's
`seatedSessionId`. The sweep's segment → card walk, `child_gone_at`, the two
`Idle`s told apart, and the clock's coverage of an arc whose session yields no
snapshot — so that class degrades to *late*, never to *forever*. And
`tugtool dash ask`, with `ArcStopReason::NeedsDecision`, which retires the
mid-course dialog from the last two stages that had one.

---

## Part X's closing state, as W7 leaves it

Of the six items Part X left open, in its own order:

1. **The deck's seat does not follow a rotation** — **closed**. Landed as
   `2206520c6` and corrected by `3db1960e7`; asserted in `at0504` with the pin
   flipped, and in two deck units.
2. **`at0387-session-identity-menu`** — untouched, exactly as scoped, and now
   **joined by `at0367-overview-scrollback`**: both fail because the Overview
   card never mounts, and `at0367` reaches that without a menu or a key path in
   the way. Proven pre-existing by probing W7's whole diff away. The
   restore-gate hypothesis is still a hypothesis, and `at0367` is where to test
   it.
3. **`at0168`'s `maker.lens` menu row** — untouched, still Lens-breakout
   residue. It went red in this workstream's core-tier runs, as expected.
4. **The devise/review `AskUserQuestion` boundary** — **closed**, confirmed
   mid-workstream. `5115cf233`.
5. **A CLI test that shells `tugtool` must scrub the session env** — still not
   landed as a source-scan guard.
6. **The other `let _ =` appends** — `arc-plan`, `arc-note`, and the `compact`
   line, as W4 left them. `dash ask`'s own note is the same shape, deliberately:
   a note that does not land costs the receipt its question, never the stop.

**And the habit this part paid for.** Part IX left two: check the build before
diagnosing the machine, and look at what the DOM held at the earlier gesture.
W7 adds the third, which is both of theirs generalized — **when the machine
disagrees with the code you just read, measure the machine.** One
`elementFromPoint` settled the `tug-sheet` red; one `strings` would have
settled W6's false red; one `ps` settled the stage kill after two runs of
inference had not.

---

## Part XII — W8 as landed, and six things the brief did not anticipate

**W8 landed 2026-09-01** from a main-lane session, as the turn-boundary
workstream: make the course's most load-bearing discipline structural rather
than prose. The incident it answers is the course machinery's first live run
(`lens-retirement`), where the implement stage walked the first boundary
perfectly — `step start 1`, work, `tugtool dash commit` (`999353ca1`),
`step done 1` — and then, instead of ending its turn, kept working straight
into step 2. Both the skill and the wheel's opening prompt command the
boundary; the stage rolled through both.

All four tasks are landed. Six facts did not survive contact with the code, and
two of them are limits a later reader should know before trusting this part's
wording.

**1. The quiet-line mechanism already existed, and it is the shell-exchange
ink row rather than anything named "quiet line".** Task 3 asks to look for one
first. There is no small-system-line renderer in the transcript and no generic
notice frame; what there is, is the mechanism `/commit`, `/dash-join`,
`/dash-discard` and `/dash-arc` all land their receipts through — a durable
`shell_exchanges` row written by `record_landing_receipt`, keyed to the
**line** so a rotation carries it, plus one unsolicited CONTROL frame so the
card paints its live copy now instead of at the next restore ([D111], [P12]).
A dash gesture is exactly that shape, so `dash_note` is `arc_receipt`'s
sibling, and the row's command is the verb **as it was typed**
(`dash step demo done 1`) with the sentence as its output — which makes the row
read as the `$` ink of somebody having run it, because that is what happened.

**One difference, and it is the whole of the deck-side work.** `arc_receipt` is
a single value per session: an arc ends once. A run's gestures are a
*sequence*, dozens of them, every one meant to be read. So the store
accumulates them under its own monotonic `seq` — not under `receipt_id`, which
is `null` whenever no shell ledger is configured — and each card seeds its
watermark at mount, so a card that opens mid-run appends only what arrives from
there and lets its restore supply the rest.

**2. The gate could not be built out of the existing hook alone, for two
reasons the brief names as one.** The plugin's `PreToolUse` hook matched only
`Skill` and `Bash`, so `Edit`/`Write` reached no gate at all; `hooks.json`
grows a third matcher. And `tugtool` is *auto-approved by prefix* in that hook
— which is right for a CLI whose every verb prints its own receipt, and wrong
for `dash step start` after a boundary. The boundary check therefore runs
**before** the whole existing match, and is the one rule here that outranks the
prefix approval and the change grammar alike. A command the grammar already
refuses now earns the boundary's refusal instead, because ending the turn
settles both and the other sentence would send the reader to `tugtool file
edit`.

**3. "Repo write" is placed relative to the call's own `cwd`, and the obvious
spelling is wrong on this platform.** The first cut listed scratch roots —
`/tmp`, `/var/folders` — and that fails immediately in the test suite, because
macOS puts every `tempfile::tempdir()` under `/var/folders`, which is also
where a fixture's whole checkout lives. What the boundary means by "the work"
is "inside the tree this call is being made in", which is one comparison
against `cwd` with nothing to keep current, plus a `target/` component check.
A path that cannot be placed at all — relative, with no `cwd` — is not a repo
write, which is the open direction.

**4. The gate needed a cheap pre-filter, or every card in the app pays for the
course.** The ask is a localhost round trip, and without a filter it happens on
every `Edit` in every Session card to be told that nothing is being paced. A
course stage's claude is spawned with `TUG_DASH_COURSE` and a hook is claude's
own child, so the variable's absence is a free "not a course stage". It is
explicitly a filter and not the answer — the variable is frozen at spawn like
every other and can outlive the course it names, so the server is still asked
and its `on_course` still decides. **The general shape, and it is [P01]'s in a
second key:** a spawn-time variable may cheapen a question, never answer one.

**5. A unit test of the gate would have asked the developer's own card about
the developer's own turn.** Part V item 5 records the CLI-test version of this
hazard — a spawned `tugtool` reaching the real registry — and `common::tugtool`
closes it for spawns. This is the same hazard met *in process*: `pre_tool_use`
called from `cargo nextest` reads the ambient `TUG_SESSION_ID` and walks the
real instance registry. The fix is that the boundary's one I/O call is a
parameter (`pre_tool_use_with`), the units hand in an answer, and the round
trip is driven only from `tests/turn_boundary_cli.rs` against a stand-in
tugcast. **A source-scan guard for in-process reads does not exist and would be
the class-closure**, exactly as W2 item 5's CLI-spawn guard still would be.

**6. `at0168`'s `maker.lens` red was never Lens residue reappearing — the
previous green was a stale bundle.** The `history:` line reads *last green
`ea9abd3cc`*, the commit immediately before this workstream, which reads as a
regression W8 caused. It is not: `maker.lens` occurs in exactly one place in
the repository, `at0168-menu-structure.test.ts:172`'s contract list, and
nowhere in `tugdeck/` or `tugapp/` at all. The bundle that produced the last
green predated the Lens breakout; `app-test-build` rebuilt it, and the test met
the app as it now is. **Part IX item 11's rule wants a companion clause:**
check the build before diagnosing the machine — *and* before believing a
`history:` line's last green, which dates a recorded run rather than a
verified binary.

### The gate's behaviour, in full

| calling session | course | step closed this turn | server | verdict |
|---|---|---|---|---|
| a course stage | live | yes | new | **deny**, naming the step and the gesture |
| a course stage | live | no | new | allow (no opinion) |
| a course stage | live | yes | old (`unknown op`) | allow, one `systemMessage`, once per boot |
| an ordinary card | none | — | any | allow — and **not asked**: no `TUG_DASH_COURSE` |
| a course stage | stopped/done | — | new | allow — the server's `on_course` is `false` |
| no `TUG_SESSION_ID` | — | — | any | allow — and **no socket opened** |
| any | any | any | none running | allow |

Read-only tools, `dash status`, `dash doctor`, `dash commit` and the draft verb
are never gestures, so no row above can refuse them: the report of the step you
just closed is not the next step's work.

### What each gesture now shows on the card

One `$`-route row per gesture, written by the verb, keyed to the caller's line:

| gesture | row |
|---|---|
| `dash create` | `$ dash create <n>` — `<n>: dash created on tugdash/<n>` |
| the run's declaration | `$ dash step <n> start i --through m` — `<n>: run declared through step m of N` |
| `step start` | `$ dash step <n> start i` — `<n>: step i/N started` |
| `step done` | `$ dash step <n> done i` — `<n>: step i/N closed (<sha>)` |
| `step withdraw` | `$ dash step <n> withdraw i` — `<n>: step i/N withdrawn` |
| `step reset` | `$ dash step <n> reset i` — `<n>: step i/N reset to pending` |
| `step reopen` | `$ dash step <n> reopen i` — `<n>: step i/N reopened` |
| `dash mark` | `$ dash mark <n> <stage>` — `<n>: marked <stage>` |
| `dash commit` | `$ dash commit <n>` — `<n>: committed (<sha>)` |

The run's declaration announces **once**, from the `step start` that actually
wrote the `run-through` line — which is why `StepOutcome` grows `declared_run`
beside `through`: the first answers "did this call declare a run", the second
"which selection is in force", and only the first should draw a row.

### What W8 deliberately left

- **No app-test drives the note channel end to end.** The CLI test asserts the
  `note` op is posted, the deck test asserts the frame becomes a row, and
  nothing joins them through a real tugcast — the same "nothing joins them"
  Part IX item 12 found was the whole finding, one channel over. The surfaces
  are there for it (`at0216` covers shell-exchange ink, `at0482` covers ink by
  line); the test is not written.
- **An in-process source-scan guard for ambient-session reads** (item 5).
- **A `dash doctor` reading of the boundary.** The doctor compares four
  records; the turn's closed step is a fifth fact, in memory, and it has no
  reader but the gate.
- **The single-turn wedge** (Part VII item 3) is untouched and is *not* what
  this workstream closes. The gate refuses a stage that closes a step and keeps
  working; it cannot make a stage that has stopped working end its turn, because
  only a model can end a turn. The clock is still the answer there.
- **`at0168`'s `maker.lens` row** — pre-existing, item 6 above, and still the
  Lens arc's call rather than the harness's.
