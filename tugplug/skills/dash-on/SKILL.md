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

## Input grammar

`/tugplug:dash-on <name> <instruction…>` — create the dash `<name>` if new (or continue it), then carry out `<instruction>`.

That is the whole grammar. `<name>` is alphanumeric + hyphens, 2+ chars, and everything after it is the instruction — there are no reserved words, because there are no sub-verbs to collide with. Joining belongs to `/join` and `dash-join`, the readouts are `tugutil dash status|show|list`, and discard is a bare CLI call the user makes.

## Lifecycle

### Create / continue

```bash
tugutil dash create <name> --description "<first ~100 chars of the instruction>" --json
```

Idempotent — returns the existing active dash if `<name>` already exists. **Capture the absolute `worktree` path** and `branch` from the response; that path is the working root for everything that follows. `create` hydrates the fresh worktree itself (its `[tugtool.dash].post_create` hook runs `bun install`), so it arrives ready.

### Work (in-thread, per round)

Carry out the instruction yourself in the worktree. Run the checks the doctrine names, then commit the round:

```bash
tugutil dash commit <name> --message "tugdash(<name>): <imperative summary, under 50 chars>" --json <<'EOF'
{"instruction":"<the instruction>","summary":"<what you did + how verified>"}
EOF
```

One command: git commit + a line in the per-project dash-log (the verbatim instruction; `tug log` on the dash branch reads the commits back). A follow-up instruction for the same dash is just another round — do it and commit again.

**Two spellings are house rules, not taste.** The round's subject is `tugdash(<name>): <imperative summary>` — the scope-colon form the engine's own dash commits carry, so `tug log` on the branch reads as one voice. And when you *name* a round's commit in the transcript, write the **bare sha in backticks** — `` `63de5762a` ``, never `commit 63de5762a` — because the app supplies the word: a confirmed sha displays as `commit:63de5762a`, and a sentence that already said "commit" makes the app yield its word and show the hash alone. See `tuglaws/entity-presentation.md`.

### Build (when there's something to see)

For a change the user should look at in the app, build + launch from the worktree:

```bash
just app-debug
just instances
tugutil dash mark <name> built
```

That brings up the `(debug, <branch>)` instance and declares the dash `built`, which is what the Lens and the Changes card report while the user looks at it.

### Stop, with a draft on file

Before you stop for the user's vet, write the dash's **join draft** — the squash message their join will land:

```bash
tugutil draft set --owner dash:<name> --message "<subject + rounds digest>"
```

Compose it from what the rounds actually did: an imperative subject under 50 chars naming the deliverable, then a terse factual digest. **The subject is bare — no `tugdash(<name>): ` prefix**, because the join adds the scope itself and a scope naming a different dash is stripped there rather than preserved. Every line unbroken to its end (**no hard wrapping**), no AI or agent attribution, ever. The join gesture lands this message and does not compose one — a dash that reaches it draftless stops there.

Then **stop and let the user vet the build.** Don't merge.

### Join (only on the user's word)

The join is the user's gesture: **`/join <name>`** in the Session card, which previews the merge and lands the squash with the draft you left. If the user asks you to run it instead, `/tugplug:dash-join <name>` is the same join in skill form.

### Discard

`tugutil dash discard <name>` deletes the dash (worktree + branch) without merging. It is the one irreversible act in the lane, this skill has no verb for it, and you never reach for it on your own initiative — it is named here only so that rule has somewhere to live.

## Guardrails

Everything in [`tuglaws/dash-work-doctrine.md`](../../../tuglaws/dash-work-doctrine.md), plus:

- **Leave the draft behind.** Stopping without one hands the user a join gesture that cannot join.
- **Never discard on your own initiative.** Discard destroys work.
