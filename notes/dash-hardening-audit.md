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
