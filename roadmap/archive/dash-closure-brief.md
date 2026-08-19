# Dashes and joins — the closure brief

**Written 2026-08-16.** This is the gathering document for the whole dash-and-join arc: what has landed across the three campaigns, what each surviving document in `roadmap/` is for, and the ordered path to final closure — up to and including the user interface and experience. When the work named here is done, dashes and joins are *done*: the lifecycle works, the surfaces say the truth, and a person can start, watch, and land a dash without archaeology.

## Where we stand {#where-we-stand}

Three campaigns have run to completion, in sequence:

1. **The integration program** (five phases, archived at `archive/dash-integration-*.md`) built the machinery: dash creation and identity, overlay binding, join mode, the draft contract, base-motion replay.
2. **The backend campaign** (`closing-dash-backend-issues.md`, eleven steps, landed as `5ba5ce400`; then `close-backend-campaign.md`, six steps, landed across `c99692691`…`84b8d9982`) closed the correctness and legibility debt: truthful clocks and stats, route-attributed landing receipts, the engine's per-dash opt-out, refusals that state their reason in the face, disabled controls that look disabled, and a lane test suite stable across three consecutive green runs.
3. **The UI identity round** (`dash-ui-plan.md`, three steps, landed as `4d888adbf`) settled how a dash is *worn*: one grammar — `custom-name:project/callsign#dash-name` — produced in one place and spelled identically by every register, eliding only under real width pressure; and the Lens showing a session's dash as an indented facts line inside the session's own row, not a stray sibling row.

The backend is closed. The identity surfaces are closed. What remains is the **join experience** — the last seam where the machinery meets the user — plus the entry points, and a short tail of pull-driven follow-ons.

## The document map {#document-map}

What each surviving dash document in `roadmap/` is for now. Read this table before re-reading any of them.

| Document | Role |
| --- | --- |
| `dash-closure-brief.md` (this) | **The live document.** The remaining program and the definition of done |
| [`closing-dash-backend-issues-brief.md`](closing-dash-backend-issues-brief.md) | The backend closure record. Its `#join-sheet` section holds the capture protocol the hunt runs; its `#landmines` section is the paid-for knowledge every future round inherits |
| [`join-assessment.md`](join-assessment.md) | The origin post-mortem of the first real landing, grown into the doctrine for landing dashes. Its doctrine section stays live |
| [`dash-ui-report.md`](dash-ui-report.md) | The UI round's report and revision. §§1–3 are landed and historical; §§4–6 name the remaining items this brief absorbs |
| [`dash-ui-plan.md`](dash-ui-plan.md) | The identity revision plan. 3/3 done at `4d888adbf`; historical |
| [`closing-dash-backend-issues.md`](closing-dash-backend-issues.md) | The eleven-step backend program. Landed; historical |
| [`close-backend-campaign.md`](close-backend-campaign.md) | The closing program, with the cold-handoff addendum. Landed; historical |
| [`base-motion-replay-plan.md`](base-motion-replay-plan.md) | Base-motion replay. 10/10 done; historical (its stamp reads `stale` because it finished, not because it drifted) |
| [`draft-contract-plan.md`](draft-contract-plan.md) | The draft contract. Landed; historical |
| [`dash-notes.md`](dash-notes.md) | Superseded scratch notes — everything in it either shipped (plan-devise/plan-review) or was absorbed into the UI report |

**Archive candidates:** everything marked *historical* or *superseded* above — `dash-ui-plan.md`, `closing-dash-backend-issues.md`, `close-backend-campaign.md`, `base-motion-replay-plan.md`, `draft-contract-plan.md`, `dash-notes.md` — can move to `archive/` whenever the owner wants the directory to read as only the live surface. The two briefs, the assessment, and the report stay.

## The remaining program {#program}

Four items, in order. The first two share a subject, and that pairing is the brief's one structural proposal.

### 1. The Join sheet hunt — active, and it needs a live subject {#join-hunt}

The standing report: the Changes shade's join surface once read as **completely non-functional** in real use, and it was never reproduced. Build vintage, the landing machinery, and the test layer are all eliminated — five lane app-test files drive the same lane against the same binary, green. The backend campaign then built exactly the instrumentation a dead click needs: a refusing lane states its reason in the face, a disabled control looks disabled, landings write route-attributed receipts, and `__deckTrace` reads on a release build.

So the posture changed from tripwire to hunt ([dash-ui-report §4](dash-ui-report.md#join-sheet)): **go looking instead of waiting.** With a real dash live, open the Changes shade in the release instance and exercise the join surface deliberately through the whole lifecycle — implementing, built, conflicted, landed. Two exits, both final:

- **It misbehaves** → run the capture protocol on the spot ([backend brief `#join-sheet`](closing-dash-backend-issues-brief.md#join-sheet)): diag/eval on the bank, `__deckTrace.dump()`, the join store snapshot, `evaluateJoinLandGate`'s inputs and reason, `document.elementFromPoint` at the refused control's center. The evidence picks one of the three shapes — refusing / stale / covered — and *that* shape's fix gets built.
- **It survives deliberate exercise** → the original report is downgraded to "fixed by the legibility round, cause among the closed defects," and the tripwire ends.

The forbidden third path is unchanged: no speculative fix without captured evidence.

**The constraint:** there is no live dash right now (`tugutil dash list` is empty — the last one joined), and a throwaway probe dash is a weak subject: it isn't *real use*, and the base-motion engine treats any hand-made dash as live inventory. The strongest subject is the next real piece of work, which is item 2. Hence:

**Proposal:** run the unified Changes pass (item 2) *on a dash*, and let that dash be the hunt's subject. The pass's own lifecycle — created, implementing with step counters, built, possibly conflicted when `main` moves, and finally landed through the sheet by hand — is exactly the exercise §4 prescribes, on genuinely real work, in the release instance. One round closes two items, and the join surface gets exercised on the very change that redesigns it.

### 2. The unified Changes pass — consolidation and simplification {#unified-changes}

The design round ran 2026-08-16 and settled the shape. The governing idea, in the owner's words: **consolidation and simplification** — the human does not think of commits and joins as different subjects, so there is *one* surface for looking at what's in flight and *one* surface for landing it. Structurally the code already agrees (`join-mode-controller.ts` is commit mode's declared twin through one `LandingMode` slot; the shade already hosts files and dashes); the work is presentation and reach, not architecture. Decided:

- **The Z4A group reads `Prompt | Changes`, always.** *Changes* is the room — selecting it enters the landing mode, whatever landing means for this card (commit when unbound, join when mated to a dash). The act's honest verb stays in the Z5 rail: `LANDING_WORDS` keeps `Commit` / `Join` as the land-button labels. The conditional Join segment ([P03]) is deleted; the segment count becomes invariant.
- **The dash annex dissolves into the shade's one list discipline.** The collapsed Dashes fold with a count is dead. Non-fronted dashes render as visible compact rows, the way unattributed files do — the situation shown, a gesture beside it. A dash row never grows claim/disclaim/hunk affordances — a dash is not a claim — and a project with no other dashes shows no section at all. The fronted dash stays first and expanded with the landing face; `JoinState` remains one slot per card, so only the fronted row lands. *(Corrected during planning: an earlier draft of this line proposed respelling the rows in the Lens's `DashFactsRun` grammar. That would lose base, rounds, dirty, and the four divergence marks — the shade's row is richer than the rail's and stays as it is, naming dashes bare per the settled identity doctrine. See the plan's [P05].)*
- **Release joins the shade, guarded.** A shade may release its own fronted dash, and any dash whose `bound_sessions` names no session open in this instance (including truly orphaned dashes). A dash bound to another *open* session is hands-off here — only that session releases it, so no button renders. Release always waits out a turn in the bound session; the fronted case gates on this card's own turn, and the bound-elsewhere case never shows the button, so the gate is always locally readable. The confirm popover is a **fact sheet, never "are you sure"**: branch and worktree deleted, N uncommitted files handed back to `main` (the `dash release` hand-back is deliberate and must be named), and for a dash bound to a closed session, that session's name. The `JoinOutcome::empty` arm — whose doc already says its answer "is release, not a fix" — finally gets its gesture. Known limitation, accepted: "open" means open in this instance; another instance's decks are invisible.
- **The doubled squash-subject prefix rides along, and it is not what the brief first assumed.** Planning found it half-landed and half-deliberate: `integrate_message` already strips a leading `tugdash(<this-dash>): ` idempotently, while `integrate_message_leaves_another_scope_alone` *asserts* that a foreign scope is preserved — and `5ba5ce400`'s `tugdash(close-backend): tugdash(backend): …` is exactly that foreign-scope case, so it doubled by design. Owner-settled: strip **any** leading `tugdash(…): ` at the landing, **and** instruct the three draft-authoring skills to write a bare subject. See the plan's [P10].

Out of scope: the Lens Dashes roster (account-global, parked dashes must stay findable — the shade's dash rows are project-scope).

Shape: `/tugplug:plan-devise` from this section → review → `dash-implement` on its own dash — the dash from item 1's proposal.

### 3. Entry points into dash workflows {#entry-points}

Deferred twice, now next ([dash-ui-report §6](dash-ui-report.md#entry-points)). Today a dash starts from slash-command archaeology. The identity revision created the natural affordances: every surface that *shows* a dash — the masthead run, the Lens dash line, the Dashes roster — is a candidate place to *start*, *bind*, or *join* one. This is a design round with the owner, not a plan yet. It is the last UX item; when it lands, the workflow is discoverable end to end.

### 4. The pull-driven tail {#tail}

Backend follow-ons, none blocking, pulled when a UI round wants them ([campaign addendum `#addendum-open`](close-backend-campaign.md#addendum-open)):

- **Deferred lifecycle items:** queue-a-landing-for-turn-end; a lane click affordance for `dash replay` on a deferred/conflicted dash with no bound session; teaching the injected conflict turn to run the plan's checkpoints after the rebase.
- **Head+tail elision for capped review diffs** — cosmetic since the stat became truthful.
- **at0405's click noise** — `click on … dash-lane-fold did not land (attempt 1)` in every lane run; covered by the file's retry, but a real click is missing its target and the diagnostic is being normalized.

## What closure means {#done}

Dashes and joins are **done** when:

1. The Join sheet report is resolved by evidence — captured and fixed, or downgraded with the deliberate-exercise receipt. No open "it was dead once" report remains.
2. The unified Changes surface is implemented as decided in [item 2](#unified-changes) — one `Prompt | Changes` grammar, dash rows in the shade's own list discipline, guarded release — and the squash subject composes without doubling its scope.
3. A dash can be started, bound, watched, and joined from visible surfaces — no step requires knowing a slash command that nothing on screen suggests.
4. The pull-driven tail is either landed or explicitly re-parked with an owner's decision, not by default.

Everything else — machinery, correctness, identity, legibility — is already closed and verified; the receipts are in the documents above.

## Landmines, inherited {#landmines}

The full set lives in the [backend brief](closing-dash-backend-issues-brief.md#landmines); the ones the remaining program will actually brush against: `tugutil dash join <name> --resolve` **lands** (`--preview` is the only safe probe). `dash release` hands a dirty worktree's files back into the base checkout — reset first. The base-motion engine is live in every instance watching this repo, so any hand-made dash is subject to replay the moment `main` moves; fixtures opt out, real dashes do not (and for the hunt, that replay *is* part of the lifecycle being exercised). The app-test corpus does not run from a dash worktree. Dash-log lines before `5ba5ce400` stamp one year early. And only the user lands: the join is a hand gesture in the Session card, never a CLI act on the user's behalf.
