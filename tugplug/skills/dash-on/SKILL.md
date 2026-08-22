---
name: dash-on
description: Quick, plan-less, worktree-isolated work — agentless, in-thread, committing per round, stopping for review before merge
argument-hint: "[name] [instruction…]"
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate
disallowed-tools: Task
---

## What this is

`dash-on` is the lightweight path for a quick task — a bug fix, a spike, a small feature, a prototype — that doesn't warrant a full plan. It runs on an isolated dash worktree and **you — the main conversation — do the work directly**. No plan, no steps, no ledger: you execute the user's instruction in-thread, commit each round, and stop before merge.

(If the task is big enough to want a plan with steps, author one with `/tugplug:plan-devise` and run it with `/tugplug:dash-implement` instead.)

**Read [`tuglaws/dash-work-doctrine.md`](../../../tuglaws/dash-work-doctrine.md) before you start.** It is the discipline every dash run works under — the one-and-only-working-root rule, the verification bar, test discipline and the banned test shapes, law discipline, round mechanics, the stop-before-join obligation, and no plan numbers in durable artifacts. This skill states the flow; the doctrine states the rules, and it is not repeated here.

**When the project has no `tuglaws/`,** the doctrine document is absent and cannot be read. The rules that survive its absence are the ones this skill carries inline — one working root, verify before every commit, never commit red, rounds through `tugutil dash commit`, stop before the join — and they are the discipline for the run. Say so once, at the start; do not invent the rest of the doctrine from memory.

## Input grammar

`/tugplug:dash-on <name> <instruction…>` — create the dash `<name>` if new (or continue it), then carry out `<instruction>`.

That is the whole grammar. `<name>` is alphanumeric + hyphens, 2+ chars, and everything after it is the instruction — there are no reserved words, because there are no sub-verbs to collide with. Joining belongs to `/join` and `dash-join`, the readouts are `tugutil dash status|show|list`, and discard is a bare CLI call the user makes.

## Lifecycle

### Create / continue

```bash
tugutil dash create <name> --description "<first ~100 chars of the instruction>" --json
```

Idempotent — returns the existing active dash if `<name>` already exists. **Capture the absolute `worktree` path** and `branch` from the response; that path is the working root for everything that follows. `create` hydrates the fresh worktree itself, running whatever the project declared in `[tugtool.dash].post_create` — in Tugtool, `bun install` for the web surfaces — so it arrives ready.

`create` records that this session is working the dash — every time, including the idempotent call that resumes one — so there is no bind to remember. Boundness is what the server reads to decide whether to work the join arc at all — an unbound dash is never reconciled, never checked, and never offered.

### Work (in-thread, per round)

Carry out the instruction yourself in the worktree. Run the checks the doctrine names. **Before the commit, write the dash's join draft** — committing the round is the arming event, so the prompt can raise and the user can join the moment the commit lands, and whatever draft exists at that instant is the message they land with:

```bash
tugutil draft set --owner dash:<name> --message "<subject + rounds digest>"
```

Compose it from what the rounds (including this one) will have done, per the rules under "Stop" below; on a follow-up round, refresh it the same way. Then commit:

```bash
tugutil dash commit <name> --message "tugdash(<name>): <imperative summary, under 50 chars>" --json <<'EOF'
{"instruction":"<the instruction>","summary":"<what you did + how verified>"}
EOF
```

One command: git commit + a line in the per-project dash-log (the verbatim instruction; `tug log` on the dash branch reads the commits back). A follow-up instruction for the same dash is just another round — do it and commit again.

**Two spellings are house rules, not taste.** The round's subject is `tugdash(<name>): <imperative summary>` — the scope-colon form the engine's own dash commits carry, so `tug log` on the branch reads as one voice. And when you *name* a round's commit in the transcript, write the **bare sha in backticks** — `` `63de5762a` ``, never `commit 63de5762a` — because the app supplies the word: a confirmed sha displays as `commit:63de5762a`, and a sentence that already said "commit" makes the app yield its word and show the hash alone. See `tuglaws/entity-presentation.md`.

**Each committed round makes the dash offerable.** A round that lands on a clean worktree is all the server needs to derive that this dash could be joined: it reconciles it with its base and offers the join on the bound card without waiting to be told the work is over. It runs no build and no tests — the verification belongs to the run, not to the join ([D149]). Nothing below is what arms that, and nothing you skip below disarms it.

### Build (when there's something to see)

For a change the user should look at, run the project's **declared build command** from the worktree — the one `tugutil dash config` reports. Relay what it actually says rather than describing a build you did not watch. When `build` is `null` the project declares none, so no build is offered: say so, and say the work is inspectable at the worktree path.

In Tugtool the declaration is `just app-debug`; pair it with `just instances` to confirm the `(debug, <branch>)` instance came up. `tugutil dash mark <name> built` is available and purely optional — it stamps the stage word `built` on the dash's faces in place of the derived `ready`, which is worth doing when you did build, and gates nothing when you didn't.

### Stop, with the fit verified and a draft on file

**Verify the fit first** ([D149]). What you checked as you worked was the dash's own tree; what a join lands is that work replayed onto the live base, and nothing has tested it:

```bash
tugutil dash replay <name>
```

On **`Replayed`** / **`Recorded`** the tree moved — verify it with the project's **declared verify command**, which `tugutil dash config --json` reports; substitute `{base}`/`{head}` with the replayed range and run it from the worktree root. In Tugtool that is `sh scripts/verify-fit.sh {base} {head}`. A `null` verify means the project declares none: check what the replay moved with the commands you already ran as you worked — never one you invent — and say so. On **`Current`** the base never moved and the checks you already ran covered these exact bytes, so run nothing and say so. On **`Conflicted`** the replay names the round it stopped at: resolve it in the worktree, commit the fix as a round, then verify. Do not re-run what already passed.

Then check the dash's **join draft** — the squash message their join will land — still tells the truth. You wrote it before each round's commit; if the ending added a round (a `Conflicted` replay resolved as new work), refresh it now:

```bash
tugutil draft set --owner dash:<name> --message "<subject + rounds digest>"
```

Compose it from what the rounds actually did: an imperative subject under 50 chars naming the deliverable, then a terse factual digest. **The subject is bare — no `tugdash(<name>): ` prefix**, because the join adds the scope itself and a scope naming a different dash is stripped there rather than preserved. Every line unbroken to its end (**no hard wrapping**), no AI or agent attribution, ever. The join gesture lands this message and does not compose one — a dash that reaches it draftless stops there.

Write the draft whether or not you built anything: the join prompt shows it, and a draftless dash offers to land its branch description — or, with neither, the words `Dash work`.

Then **stop.** Don't merge.

### Join (only on the user's word)

The join is the user's, and the **prompt** is how it reaches them: a modal raises on the bound card offering *Join now*, *Review first*, *Not yet*, and lands the squash with the draft you left. Say the draft is written and stop — do not print a `/join <name>` chip, which reads as "nothing will happen until you type this" beside a dialog that is about to raise on its own.

The chip belongs only where the prompt cannot raise: a dash the user has left unbound, or a legacy dash with no declared run and no mark. If the user asks you to run the join instead, `/tugplug:dash-join <name>` is the same join in skill form.

### Discard

`tugutil dash discard <name>` deletes the dash (worktree + branch) without merging. It is the one irreversible act in the lane, this skill has no verb for it, and you never reach for it on your own initiative — it is named here only so that rule has somewhere to live.

## Guardrails

Everything in [`tuglaws/dash-work-doctrine.md`](../../../tuglaws/dash-work-doctrine.md), plus:

- **Leave the draft behind.** Stopping without one hands the user a join gesture that cannot join.
- **Never discard on your own initiative.** Discard destroys work.
