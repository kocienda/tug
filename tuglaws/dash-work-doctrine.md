# Dash Work Doctrine

*How an agent works on a dash worktree. The rules below hold for every dash — a quick plan-less task, a planned run walking a ledger, an audit that only reads. They are cited, not copied: a working skill states its own flow and points here for the discipline, so the discipline has exactly one home.*

This document covers **how the work is done**. The dash's state model — what `created`, `working`, `implementing`, `built`, `audited`, `draft-ready`, and `joining` mean and how each is derived or declared — is a separate subject, and lives in [dash-lifecycle.md](dash-lifecycle.md) along with the identity and binding models.

## The one and only working root

A dash *is* a git branch (`tugdash/<name>`) plus a worktree. `tugutil dash create <name> --json` returns that worktree's absolute path. **Capture it.** From that moment it is the only working root:

- Address **every** read, write, edit, and test by absolute path into the worktree. A shell's cwd silently reverts to the base checkout between tool calls; a relative path is a coin flip.
- **Never write to the base checkout.** Not code, not a plan, not a ledger, not a scratch file. The base branch is the user's; the only path back is their join gesture.
- A stray write to the base root also *blocks* the join — the join preflight requires the base clean where it intersects the dash's files.
- If the document a run is driving lives on the base branch, a **verb** moves it into the worktree — `tugutil dash create <name> --plan <path>`, or `tugutil dash adopt-plan <name>` for a dash that already exists. Never copy it by hand: the dash owns its plan and there is exactly one live copy ([D139], [dash-lifecycle.md](dash-lifecycle.md#plan-adoption)).

There is no canonical directory for anything. `roadmap/`, `.tugtool/`, and every other home are derived from what you were handed, never assumed.

## Starting from a dirty base

A dash is cut from the base *branch tip*, so the worktree always starts clean no matter what the base checkout holds. What it holds is still your problem: uncommitted work left on the base is either invisible divergence for the length of the run, or the join's `base-dirt` refusal at the end of it.

So `dash create` ends by saying what it left behind — the uncommitted paths, classified, and a warning when the checkout is not on the base branch (creation does not care; the join's preflight does). It is a report, not a veto. Most creates happen over some unrelated dirt, and a create that refused over it would be intolerable. **Read the census; taking nothing is the default and usually the right one.**

When the work on the base *is* the work the dash is for — the "I was half-way through this before I realised it should be a dash" case — `--carry` moves it into the new worktree, uncommitted, and cleans the base. Uncommitted because it is in progress by definition: the dash's first round commits it with intent, rather than a machine writing a message for work it did not do. Content is carried, not index state, so a staged edit arrives unstaged.

`dash discard` is the inverse and needs no flag: it returns the worktree's uncommitted work to the base before teardown, the same way it already returns an adopted plan. If the base has since acquired its own uncommitted edit to one of those paths, discard refuses and leaves the dash standing — the work stays reachable rather than being destroyed to complete a teardown. Commit or stash the base changes and discard again.

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

**A conflicted replay becomes an ordinary turn, never a rung.** The engine never resolves file content — that is a question for whoever is working the dash. Instead it composes one message naming what moved, which round the replay stopped at, the conflicting paths, and what the dash is *for*, and injects it into the dash's most recently used idle bound session as an ordinary submission. The agent resolves by rebasing in the dash worktree, with the full working tree and the tests in hand, and finishes with `tugutil dash replay <name>`, which finds the branch already current and does the bookkeeping only. If the conflict turns out to be a real design collision rather than a mechanical one, the right answer is `git rebase --abort` and saying so — the dash simply stays behind, and the join-time resolution ladder is still there. That ladder remains the standing fallback for every case: a dash with no bound session gets a mark and nothing else.

**No server-initiated turn is ever unannounced.** This is the general rule, and it outranks convenience. Journaling an injection makes the turn real to the server and to a later reload, but it puts no row on screen — the transcript's live user row comes from the composer echoing its own submission, and an injection has no composer. So every injected turn carries a system-origin opener alongside it, rendered as a distinct row attributed to the subsystem that spoke. Attributing it to the user instead would be cheaper and would put words in their mouth in their own transcript. An agent that begins working with no visible cause is a worse ambush than the one this whole mechanism replaces.

**A replay under a live plan run tells the agent its context moved.** The engine does not wait for a plan run to finish — that would leave a dash behind for hours, which is the ambush again. It replays between turns and follows a clean replay with a short notice naming the new base tip and the files the base brought in. The agent's context holds pre-replay file contents, so its next edit could silently revert base changes it never saw; the notice repairs that rather than avoiding it. It asks for nothing, and says so.

The engine is on by default, because the doctrine *is* the default and an opt-in flag would make the designed behavior the exception. `git config tugdash.autoreplay false` disables automatic motion for a repository where any unattended ref motion is unwelcome; the `tugutil dash replay` verb and the marks keep working.

## Verify before every commit

**Warnings are errors.** The Rust workspace enforces `-D warnings`; treat a type error, a lint finding, or a failing test the same way.

The bar before a round is committed:

- `bunx tsc --noEmit` for TypeScript that moved.
- Pure-logic tests for the scope that moved (`bun test <scope>`).
- `cargo nextest run` for Rust — the affected crates while iterating, the workspace before the run ends.
- A real-app test where the change is one only the real app can show.

**Never commit red.** If a check fails, fix it and re-run; a round that lands broken makes every later round's verdict meaningless.

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
tugutil dash commit <name> --message "<conventional commit>" --json <<'EOF'
{"instruction":"<what was asked>","summary":"<what landed + how verified>"}
EOF
```

Git records the diff; the log records the instruction git cannot see. `tug log` on the dash branch reads the rounds back.

**Never commit to the base branch.** Every commit goes through `tugutil dash commit` onto the dash worktree.

## Stop before the join

The build is the user's to vet. Bring up the debug instance from the worktree (`just app-debug`), report it, and stop — do not merge, and do not run the join on the user's behalf.

Before stopping, leave the **join draft** behind: compose the squash message from what the rounds actually did and write it with `tugutil draft set --owner dash:<name> --message "…"`. The join gesture lands that message; it does not compose one. A dash that arrives at the join draftless stops there, which is a stall you caused one step earlier.

Write it knowing exactly what it becomes: **a join lands one commit on the base, and the draft is its message** ([D144]). Not one commit per round, not the rounds replayed — one, whatever the ladder did off to the side to make the bytes merge, and regardless of how many rounds the run took. The draft is therefore the *only* durable prose the base will carry about this dash, so a digest that leans on the round commits to fill in what it left out is leaning on commits that will not be there.

**Marking the dash `built` is what starts the arc, and the arc runs itself.** The join pilot reconciles the dash against its base and runs the project's Tier 0 checks over the tree that would land, unprompted, exactly once per base/head pair — so by the time the user looks, the dash has already reached a verdict or a question. When there is a decision to make, the dash **asks**: a prompt raises on the bound session offering *Join now*, *Review first* or *Not yet*. So a run's report does not need to end in a `/join <name>` chip, and should not read as though nothing will happen until the user types one. Say what was built and stop; the arc will speak for itself ([D142]).

## The join finishes itself

A join whose merge conflicts is **not** handed back to you, and not handed to
the user as a diff to read. The server runs a resolution ladder, then hands the
result to a resolver: an agent working in the dash's own **workshop** worktree,
where the merge is a real tree with the whole project around it. It finishes
what the ladder could not, **audits every file the ladder's machine rungs
decided** against the dash's recorded intent, and reports what it did. Then the
project's own declared checks run over the tree that would actually land.

Three consequences for anyone working in this lane:

- **A conflicted join is not a stall.** Do not resolve conflicts by hand on the
  dash worktree to "help it along". The resolve path owns that work, and a hand
  resolution is one nothing audited.
- **The verdict is the gate, not a reading.** Green joins; red names its failing
  commands and offers an explicit override; nobody has run the checks yet is
  *unverified*, which is a different fact from passing. There is no diff to
  acknowledge and no acknowledgement that opens the gate.
- **An escalation is the user's, and only an intent question.** When the two
  sides want genuinely incompatible things the resolver asks — once, phrased as
  what each side was trying to do, with concrete resolutions. It reaches the
  join face and waits. Answer it there; a resolve blocked on a question is
  blocked on a person, not broken.

Three rules the pipeline holds itself to, which are worth knowing when a join
behaves in a way that looks like nothing happening:

- **One dash, one run.** A resolve, a verification, and a non-preview join each
  take the dash before they touch anything, and any second one is refused by
  name — "a resolve is already running for this dash". They share a workshop
  worktree, so two at once means one resetting the tree the other is editing.
  A preview takes nothing, because it touches nothing. Admission, never a
  queue: one dash, one run, and the refused press is told what holds it.
- **The gate lives on the server.** `tugutil dash join` refuses an unverified,
  red, or candidate-less join exactly as the card does, because the refusal is
  in `join_in` rather than in a surface. `--anyway` is the escape, and the
  card's Join anyway writes the same durable override, anchored to the
  candidate sha it was decided over.
- **A failure fact is always terminal.** Nothing durable describes an activity
  nobody is performing: a tier run that dies writes its verdict red rather than
  leaving it running, and a question whose resolver is gone becomes a stuck
  line quoting what was asked. So a face that says a run is live means one is.
  Silence from the resolver is not evidence of anything — its rung reports four
  discrete beats with minutes between them, and only the server's own timeouts
  can call it dead.

**Every join rides a candidate**, clean ones included. Opening join mode on a
dash with no conflicts still resolves it and verifies what that produced, which
costs a `commit-tree` and one run of the project's checks. The failure that pays
for is the merge with no conflicting file that does not build — a symbol renamed
on one side, a new call site on the other.

What the project's checks *are* is per-project configuration, not built-in
knowledge: `[tugtool.dash].verify_tier0` and `verify_tier1` in
`.tugtool/config.toml`, beside `post_create`. A project that declares neither
gets a stated green with a note, which is the right answer for a repository that
has no build.

## What never gets asked

A skill in this lane may raise a dialog at a real decision point — an unsettleable design question, a judgment call with no technically correct answer, a stale plan, a refused ledger edit, a disposition the user owns. That licence is narrow, and it comes with a boundary, because a run that asks about everything is worse than one that asks about nothing: it trains the user to click through the dialog that mattered.

- Never ask to commit a round.
- Never ask before running a checkpoint.
- Never ask permission to write the join draft.
- Never ask "should I continue?" between ordinary steps.
- Never ask anything with a conventional default.

Join's other stops — a conflict, a missing draft, a named blocker — stay stops. They are correct refusals with one right answer, not unasked questions.

## No plan numbers in durable artifacts

Never write step identifiers — "Step 4.5", "4i", "roadmap step X" — into code, comments, docstrings, test names, or commit messages. Describe the behavior or the reason directly.

A plan document carries step numbers because it *is* the bookkeeping; so does the dash-log's `instruction` field, for the same reason. Nothing that outlives the run does.

## No sub-agents

The worker is the main conversation. Do the work in-thread. The whole point of the agentless model is that the user stays in a tight feedback loop with one thread that holds the context, rather than reviewing the output of a swarm that does not.
