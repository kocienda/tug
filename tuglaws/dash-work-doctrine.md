# Dash Work Doctrine

*How an agent works on a dash worktree. The rules below hold for every dash — a quick plan-less task, a planned run walking a ledger, an audit that only reads. They are cited, not copied: a working skill states its own flow and points here for the discipline, so the discipline has exactly one home.*

*The lane has two doors, and which one the user typed is the routing decision. **Both run under the wheel and both open on a brief**; they differ by **settling time**, and by nothing else. The bare `/dash` writes the brief and the **task list** at the door, and the course opens straight at implement. `/dash-plan` writes the brief, and the course devises a plan from it and reads that plan cold before any step is walked. Everything downstream of the ledger is identical in the two. Typing a stage you want by name — `/tugplug:dash-implement`, `/tugplug:dash-review` — is the expert path and is never worse (`/tugplug:dash-devise` is not among them: it is a stage of a course and stops when it is run outside one). Whichever door a run comes through, the discipline below is the same one.*

This document covers **how the work is done**. The dash's state model — what `created`, `working`, `implementing`, `built`, `audited`, `draft-ready`, and `joining` mean and how each is derived or declared — is a separate subject, and lives in [dash-lifecycle.md](dash-lifecycle.md) along with the identity and binding models.

## The one and only working root

A dash *is* a git branch (`tugdash/<name>`) plus a worktree. `tugtool dash create <name> --json` returns that worktree's absolute path. **Capture it.** From that moment it is the only working root:

- Address **every** read, write, edit, and test by absolute path into the worktree. A shell's cwd silently reverts to the base checkout between tool calls; a relative path is a coin flip.
- **Never write to the base checkout's working tree.** Not code, not a scratch file. The base branch is the user's; the only path back is their join gesture. The dash's own `.tug/dashes/<name>/` is not an exception to that rule but the reason there is nothing left to except: it is gitignored, invisible to `git status`, reached only through a verb, and so is not part of the tree the rule protects.
- A stray write to the base root also *blocks* the join — the join preflight requires the base clean where it intersects the dash's files.

A dash's documents live at `<main-repo>/.tug/dashes/<name>/` — `brief.md` and `plan.md` — and the **name** is their address on every verb ([D139]). They are never tracked and never in the worktree, so nothing transplants them, nothing detects divergence between copies, and nothing has to clean them up: `tugtool dash documents <name>` reports them, and `--ensure` creates the directory to write into. There is no directory to declare, assume, or ask about.

## Starting from a dirty base

A dash is cut from the base *branch tip*, so the worktree always starts clean no matter what the base checkout holds. What it holds is still your problem: uncommitted work left on the base is either invisible divergence for the length of the run, or the join's `base-dirt` refusal at the end of it.

So `dash create` ends by saying what it left behind — the uncommitted paths, classified, and a warning when the checkout is not on the base branch (creation does not care; the join's preflight does). It is a report, not a veto. Most creates happen over some unrelated dirt, and a create that refused over it would be intolerable. **Read the census; taking nothing is the default and usually the right one.**

When the work on the base *is* the work the dash is for — the "I was half-way through this before I realised it should be a dash" case — `--carry` moves it into the new worktree, uncommitted, and cleans the base. Uncommitted because it is in progress by definition: the dash's first round commits it with intent, rather than a machine writing a message for work it did not do. Content is carried, not index state, so a staged edit arrives unstaged.

`dash discard` is the inverse and needs no flag: it returns the worktree's uncommitted work to the base before teardown. If the base has since acquired its own uncommitted edit to one of those paths, discard refuses and leaves the dash standing — the work stays reachable rather than being destroyed to complete a teardown. Commit or stash the base changes and discard again.

## When the base moves

A join problem should surface the moment it becomes true, not the moment you try to join. A dash cut on Monday and joined on Thursday spent three days quietly diverging from a base nobody was watching, and the whole cost of that divergence arrived at once, at the join, in front of whoever pressed the button. The base-motion engine exists to spend that cost as it is incurred.

**The base moving is a wake, not a schedule.** Each workspace already runs one file watcher, and its git watch already broadcasts when the workspace's HEAD moves; the engine is one more subscriber. Two more wakes cover what a signal cannot: a workspace opening (a HEAD signal is an edge, and a dash that fell behind while Tug was not running would never be signalled about), and a turn ending (the gate below refuses to act mid-turn, and "the base moved during a turn" is the common shape of the problem).

**A replay happens only when all of it is safe.** The gate is four conditions, and every one of them is a refusal to act over somebody's work:

- The dash worktree is clean. Nothing moves a branch out from under uncommitted changes.
- No join is in flight for that dash.
- No live session bound to the dash is mid-turn.
- No replay for that dash is already running.

When any fails, the dash is left behind and re-examined on the next wake. Deferral is cheap because the mark makes it visible: a dash that stays behind is a lane state, not a silent stall.

The move itself is a compare-and-swap — the worktree re-verified clean, its HEAD re-verified equal to the tip the replay was computed from, then `git reset --keep` from *inside* the worktree, which updates HEAD, the index, and the working tree together and independently refuses over tracked-file dirt. A round committed between the probe and the move makes the swap fail rather than being silently dropped.

**Quiet, never silent.** A clean replay interrupts nobody: no dialog, no toast, no turn. Its record is a `replayed` line in the dash-log, the plan ledger's commit cells rewritten to the rounds' new ids, and a settled mark on the dash's lane row. History moved under the dash; saying nothing at all about that would be its own hazard.

**A conflicted replay becomes an ordinary turn, never a rung.** The engine never resolves file content — that is a question for whoever is working the dash. Instead it composes one message naming what moved, which round the replay stopped at, the conflicting paths, and what the dash is *for*, and injects it into the dash's most recently used idle bound session as an ordinary submission. The agent resolves by rebasing in the dash worktree, with the full working tree and the tests in hand, and finishes with `tugtool dash replay <name>`, which finds the branch already current and does the bookkeeping only. If the conflict turns out to be a real design collision rather than a mechanical one, the right answer is `git rebase --abort` and saying so — the dash simply stays behind, and the join-time resolution ladder is still there. That ladder remains the standing fallback for every case: a dash with no bound session gets a mark and nothing else.

**No server-initiated turn is ever unannounced.** This is the general rule, and it outranks convenience. Journaling an injection makes the turn real to the server and to a later reload, but it puts no row on screen — the transcript's live user row comes from the composer echoing its own submission, and an injection has no composer. So every injected turn carries a system-origin opener alongside it, rendered as a distinct row attributed to the subsystem that spoke. Attributing it to the user instead would be cheaper and would put words in their mouth in their own transcript. An agent that begins working with no visible cause is a worse ambush than the one this whole mechanism replaces.

**A replay under a live plan run tells the agent its context moved.** The engine does not wait for a plan run to finish — that would leave a dash behind for hours, which is the ambush again. It replays between turns and follows a clean replay with a short notice naming the new base tip and the files the base brought in. The agent's context holds pre-replay file contents, so its next edit could silently revert base changes it never saw; the notice repairs that rather than avoiding it. It asks for nothing, and says so.

The engine is on by default, because the doctrine *is* the default and an opt-in flag would make the designed behavior the exception. `git config tugdash.autoreplay false` disables automatic motion for a repository where any unattended ref motion is unwelcome; the `tugtool dash replay` verb and the marks keep working.

## Verify before every commit

**Warnings are errors.** The Rust workspace enforces `-D warnings`; treat a type error, a lint finding, or a failing test the same way.

The portable rule is two-sided: **a step's checkpoint runs the commands the plan names for the work that step did; the run's ending runs the project's declared verify command.** The list below is what that first side comes to in this repository — read it as this project's instance of the rule, not as the rule.

- `bunx tsc --noEmit` for TypeScript that moved.
- Pure-logic tests for the scope that moved (`bun test <scope>`).
- `cargo nextest run` for Rust — the affected crates while iterating, the workspace on the **last step that touched Rust**. Not "before the run ends": the ending has its own job, and re-running this is not it.
- A real-app test where the change is one only the real app can show.

**Never commit red.** If a check fails, fix it and re-run; a round that lands broken makes every later round's verdict meaningless.

**A checkpoint that passed is spent.** It ran against these bytes, inside the step that changed them; running it again at the end proves nothing new and costs minutes. So: **the run ends when the fit is verified — replay, verify only what the replay moved, report, and stop; never re-run a checkpoint that already passed.** The fit is the one thing the per-step checkpoints genuinely cannot have covered, because until the replay the dash's tree is the sandbox it forked from rather than the tree a join would land. The procedure is the devise skeleton's Integration Checkpoint pattern: `tugtool dash replay <name>`, then the scoped verification **only** on `Replayed`/`Recorded`; `Current` re-runs nothing; `Conflicted` is resolved in the worktree and then verified. What that verification *is* comes from the project, and one verb reads it: `tugtool dash verify <name>` resolves every path the replay moved to a surface declared in the project's own `[[tugtool.dash.surface]]` table and runs what those surfaces declare. A path no surface claims is a **refusal** — it runs no check at all and names the paths, because a table that has fallen behind its tree is a gap to declare rather than to work around. A project that declares no surfaces says so and verifies with the plan's own checkpoint commands over what the replay moved — never an invented one — and says so.

**Fix what you touch.** A pre-existing warning, type error, or dead branch in a file you are editing is yours to fix, not to report. Punting it as "pre-existing" leaves the next reader the same trap.

## Test discipline

The kind of test must match the layer, and two kinds are banned outright.

- **Real-app / browser-behavior tests** — focus, selection, event ordering, caret, portal timing, gestures — live in `tests/app-test/` and run through **`just app-test <file>`**. Never hand-roll the equivalent `TUGAPP_IN_APP_TEST=1 TUGAPP_DEBUG_PATH=… bun test …` pipeline: the recipe does the app-path query, the re-sign, the dist refresh, and the pkill, and prints a finished report ending in a `VERDICT:` line. Never pipe that output into a filter — the pipeline's exit status becomes the filter's, so a green run reads as a silent failure.
- **Pure-logic tests** — stores, protocol, math, validators, layout trees — are plain `bun:test` files with no DOM globals.
- **Banned, do not write and do not re-add:**
  - **Fake-DOM / RTL tests.** No `happy-dom`, no `jsdom` render tests, no `@testing-library/react`. There is no in-process DOM substrate. A test that needs `document`/`window` to express itself is either a pure function over data or an app-test.
  - **Mock-store assertion tests.** Never hand-roll a core interface to count mock method calls, and do not write per-mutator "pin" tests even against the real engine. `tsc --noEmit` already catches interface drift. Write an integration test in response to a real bug, at the real layer.
- If a banned shape looks genuinely worth it, **ask first**.

## Law discipline

Before writing or materially changing code under `tugdeck/src/components/tugways/` or `tugdeck/src/components/chrome/` — hooks, components, CardHost plumbing, portal and registry wiring — read [`tuglaws.md`](tuglaws.md), [`pane-model.md`](pane-model.md), and [`component-authoring.md`](component-authoring.md), and **name the laws the change touches in the round's commit body** (e.g. "upholds [L02] via `useSyncExternalStore`; [L22] via direct store observation").

Preservation-by-mimicry is not an audit: copying the shape of neighbouring code proves nothing about which invariant it was upholding. Naming the law is the proof.

Not required for Rust, Swift, plugin, or pure documentation changes.

## Rounds

A round is one commit plus one line in the per-project dash-log, made by one command:

```bash
tugtool dash commit <name> --message "<conventional commit>" --json <<'EOF'
{"instruction":"<what was asked>","summary":"<what landed + how verified>"}
EOF
```

Git records the diff; the log records the instruction git cannot see. `tug log` on the dash branch reads the rounds back.

**Never commit to the base branch.** Every commit goes through `tugtool dash commit` onto the dash worktree.

## Step work runs to completion

**Once step work has commenced, the run finishes it.** The value passed to `--through` is the run's declared end, and a run that has declared one does not stop before it: not to report a round, not to describe the next step, not to ask whether to keep going, not because a commit landed and a commit looked like a natural place to hand back. It stops at exactly two points — the step it declared it would run through, or a blocker it names and cannot resolve — and nothing else. A round's commit is a checkpoint inside the run, never its end. A turn that ends with a step reading `in progress` and no named blocker is a defect: every dash face reads a live mark that nobody is working, the join cannot arm, and the user is left to discover that the dash needs prodding. Dashes do not need prodding.

**Questions belong to the door, not the steps.** The clarifying question has one home: the invoking conversation, before the course opens — while `/dash-plan` sharpens an idea into a brief, or while `/dash` sharpens one into a brief and a task list. Even there it is narrow, raised only when the run is genuinely at its wits' end on a decision the code cannot answer, and it is bounded by the [never-ask list](#what-never-gets-asked). Once the hand-off happens, that door is closed: a question that arrives mid-run is answered by reading the code, by the conventional default, or by the documents the stage was handed, and the run keeps going. The one mid-run dialog that survives is the refused ledger edit, because a wrong guess there corrupts the durable record.

**A step boundary is a turn boundary.** Under a course — which is now every dash, through either door — the implement stage closes one step per turn and ends it. Not because a longer turn would do worse work, but because the wheel can only act between turns: every act it takes on the seated session — a compaction above `implement_compact_tokens`, and the rotation that follows one the compaction could not bring back under it — is sent at a turn's end, since a prompt sent into an open turn would queue behind a model still working. The wheel reads the boundary and prompts the same session with the next range, so the run still runs to its declared end; the turn is only the unit the course paces it in. Declare `--through` with the run's last step throughout — it never shrinks to the step being walked, because that value is what arms the join.

**With no course in the environment there is no wheel, and nothing will prompt the next step.** That is `/tugplug:dash-implement` typed by hand, and nothing else now that both doors hand off. Ending the turn at a step boundary there is not pacing, it is abandonment: the ledger reads `in progress`, the dash sits, and the user finds it stopped. Walk the whole declared range in the one turn, and end the turn only when the step named by `--through` is `done` or `withdrawn`.

## Stop before the join

Do not merge, and do not run the join on the user's behalf. That is the whole of what "stop" means here; the rest of the ending is one obligation and two offers.

**The build is an offer.** A change with a face is worth bringing up from the worktree so the user can look at it before the join; a refactor, a doctrine edit, or a Rust fix its own checkpoint already covered is not, and a debug instance nobody opens is cost with no reader. Offer it, do not assume it.

What to run is the project's to say: the `build` command declared in `[tugtool.dash]`, which `tugtool dash config` reports. In this repository that declaration is `just app-debug`. A project that declares none offers none — say so, and say the work is inspectable at the worktree.

Before stopping, leave the **join draft** behind: write the squash message with `tugtool draft set --owner dash:<name> --message "…"`. The join gesture lands that message; it does not compose one. A dash that arrives at the join draftless stops there, which is a stall you caused one step earlier.

Write it knowing exactly what it becomes: **a join lands one commit on the base, and the draft is its message** ([D144]). Not one commit per round, not the rounds replayed — one, whatever the ladder did off to the side to make the bytes merge, and regardless of how many rounds the run took. The draft is therefore the *only* durable prose the base will carry about this dash, and the round commits it might have leaned on to fill in what it left out will not be there.

**So the draft is a commit message, held to the same standard as every other commit the base carries.** An imperative subject in the repository's recent-commit style, then a body describing the change the base is about to receive — what it does, and the argument the work rests on — written for a reader who never saw the run. Never a narration of the run: no round-by-round digest, no step numbers, no "the run did X and then Y", and no archaeology about defects the run found and fixed along the way. The round count is the receipt's fact rather than the message's: the join receipt shows it, the `Tug-Dash:` trailer names the branch and base, and the dash branch's own log holds the rounds until the join sweeps it. State the argument the work actually rests on and do not append an inferred benefit to make the change sound worthier. The subject is **bare** — no `tugdash(<name>): ` prefix, because the join wears the scope itself. Every line runs unbroken to its end (**no hard wrapping**), and no AI or agent attribution, ever.

The exemplar is in the tree: `a18557090`, a dash join whose message says what a project can now declare, what routes through it, which boundary was held, and how it was proven — with no round list and nothing that requires having watched the run. Read it before writing one.

**The arc arms itself, and `tugtool dash mark <name> built` is telemetry** ([D147]). What arms it is the run reaching the step it declared it would run through — nothing has to remember to say so, which is the point: an endgame that depended on a chore was an endgame that went dark the first time a run ended early. The mark stamps the word `built` on the dash's faces in place of the derived `ready`, which is worth doing when you did build and changes nothing when you skip it.

Once armed, the pilot reconciles the dash against its base, unprompted. It runs no build and no tests — the run's ending already verified the tree that lands ([D149]) — so a standing candidate is the whole of readiness, and the dash **offers** the moment it has one: the Changes shade reveals itself on the bound session in the first quiet moment, showing the dash's row, what the join would land, and where those words came from ([D152]). A run's report therefore does not end in a `/dash-join <name>` chip and should not read as though nothing will happen until the user types one. Say what was built and stop; the arc will speak for itself ([D142], [D147]).

## The join finishes itself

A join whose merge conflicts is **not** handed back to you, and not handed to
the user as a diff to read. The server runs a resolution ladder, then hands the
result to a resolver: an agent working in the dash's own **workshop** worktree,
where the merge is a real tree with the whole project around it. It finishes
what the ladder could not, **audits every file the ladder's machine rungs
decided** against the dash's recorded intent, and reports what it did.

**The gate is reconcile-clean, and nothing else** ([D149]). A dash joins when
its merge onto the current base is clean — either because it always was, or
because the ladder and the resolver made it so. No build runs here and no tests
run here, because verification belongs to the run's ending, over the tree the
run actually produced. A join that re-verified would be re-reading work that was
already read, at the one moment the user is waiting.

Two consequences for anyone working in this lane:

- **A conflicted join is not a stall.** Do not resolve conflicts by hand on the
  dash worktree to "help it along". The resolve path owns that work, and a hand
  resolution is one nothing audited.
- **An escalation is the user's, and only an intent question.** When the two
  sides want genuinely incompatible things the resolver asks — once, phrased as
  what each side was trying to do, with concrete resolutions. It reaches the
  join face and waits. Answer it there; a resolve blocked on a question is
  blocked on a person, not broken.

Two rules the pipeline holds itself to, which are worth knowing when a join
behaves in a way that looks like nothing happening:

- **One dash, one run.** A resolve and a non-preview join each take the dash
  before they touch anything, and any second one is refused by name — "a resolve
  is already running for this dash". They share a workshop worktree, so two at
  once means one resetting the tree the other is editing. A preview takes
  nothing, because it touches nothing. Admission, never a queue: one dash, one
  run, and the refused press is told what holds it.
- **A failure fact is always terminal.** Nothing durable describes an activity
  nobody is performing: a run that dies writes its outcome rather than leaving
  itself running, and a question whose resolver is gone becomes a stuck line
  quoting what was asked. So a face that says a run is live means one is.
  Silence from the resolver is not evidence of anything — its rung reports four
  discrete beats with minutes between them, and only the server's own timeouts
  can call it dead.

**The join speaks in the room where the work is, and that room stands**
([D152]). The decision surface is the Changes shade: the card reveals it in the
first quiet moment — no turn running, no landing up, no half-typed prompt — and
until one arrives the Changes segment wears an accent dot so the offer is quiet
rather than silent. The reveal is a glance and nothing more: it enters no mode
and touches no composer, so entering the landing mode and pressing the ⬆ stay
the user's own gestures. The fronted dash's fold says what the join would land
and where those words came from, live: a draft written while the offer stands
repaints it in place.

The shade replaced a dialog, and the reason is worth carrying: **a transient
surface has no reopen gesture**, so every dismissible one needs a durable record
of the dismissal and a policy for when that record expires — machinery that once
locked a real dash out of its own join until somebody ran `git config
--unset-all` by hand. Closing a standing room costs nothing, because the row is
still in it. So closing the shade is the whole of "not yet", and new work on the
dash summons it again.

While the join runs, its beats narrate in the register the shade and the
composer already share. The durable record is the receipt row the landing leaves
in the transcript.

## What never gets asked

A skill in this lane may raise a dialog at a real decision point — an unsettleable design question, a judgment call with no technically correct answer, a stale plan, a refused ledger edit, a disposition the user owns. That licence is narrow, and it comes with a boundary, because a run that asks about everything is worse than one that asks about nothing: it trains the user to click through the dialog that mattered.

- Never ask to commit a round.
- Never ask before running a checkpoint.
- Never ask permission to write the join draft.
- Never ask "should I continue?" between ordinary steps — and never end the turn between them as a silent way of asking it. Once step work has commenced, the run finishes its declared range.
- Never ask a clarifying question once step work has commenced. Clarification is a plan-time and task-list-time act; a mid-step unknown is answered by the code, the conventional default, or the design already in the session.
- Never ask anything with a conventional default.
- Never ask which route or which shape the work takes when the invocation, or a design the session already holds, has settled it.
- Never ask the user to choose between readings of the codebase. Read the code; the answer is a decision in the plan.

Join's other stops — a conflict, a missing draft, a named blocker — stay stops. They are correct refusals with one right answer, not unasked questions.

## No plan numbers in durable artifacts

Never write step identifiers — "Step 4.5", "4i", "plan step X" — into code, comments, docstrings, test names, or commit messages. Describe the behavior or the reason directly.

A plan document carries step numbers because it *is* the bookkeeping; so does the dash-log's `instruction` field, for the same reason. Nothing that outlives the run does.

## Retiring something: the design goes, the spelling stays

A retired **design** is deleted whole — the text and the apparatus behind it, its tests, its fixtures, its registry lines and its roster entries — never marked "superseded by"; a retired **spelling** is kept as an alias, because an unmatched `/verb` is submitted to claude as a prompt rather than refused, which is worse than a rename ([slash-commands.md](slash-commands.md#retire-a-spelling) owns that half and states it once). Tell the two apart by asking whether anything is left that a user could still type: if there is, it needs somewhere to land; if there is not, there is nothing to keep.

## No sub-agents

The worker is the main conversation. Do the work in-thread. The whole point of the agentless model is that the user stays in a tight feedback loop with one thread that holds the context, rather than reviewing the output of a swarm that does not.
