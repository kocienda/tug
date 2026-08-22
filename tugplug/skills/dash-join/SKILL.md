---
name: dash-join
description: Join a dash into its base branch — preview the squash, join it with the dash's join draft as the message, clear the draft, and report the receipt. The user's join gesture; never discards.
argument-hint: "[name] [message…]"
disable-model-invocation: true
allowed-tools: Bash, Read, AskUserQuestion
disallowed-tools: Task
---

## What this is

`dash-join` is the **dash lane's join gesture** — the twin of `/commit` on the main lane. A dash has been worked (by `/tugplug:dash-implement` or `/tugplug:dash-on`), the user has vetted the build, and this run joins it: preview the merge in memory, land the squash onto the base branch with the dash's join draft as the message, tear down the worktree + branch, clear the draft, and report.

**This is the agentic entrance; the card has its own.** Typing `/dash-join` in the Session card no longer submits a turn — it opens **join mode**: the composer becomes the join-message editor over a merge the card previewed on entry, the Changes shade's dash row shows the outcome and whatever blocks it, and Z5's Join button lands it. Same `tugutil dash join` verb, same preflight, same receipt; what differs is who is driving. Reach for this skill when the join is part of a run you are already carrying out. Its interactive twin is one keystroke away for the user, and neither entrance knows or cares about the other.

**You do not decide whether to join.** The user invoked this skill; that invocation is the byline. Your job is to join it correctly, or to stop with a clear reading of why it cannot join yet.

Every git operation goes through **`tugutil dash join`**. Never `git merge`, never `git cherry-pick`, never a hand-rolled squash — the CLI owns the preflight, the in-memory preview, the journal, the trailers, and the teardown.

## Input grammar

`/tugplug:dash-join [name] [message…]`

- `/tugplug:dash-join <name>` — join the dash `<name>` with its maintained join draft.
- `/tugplug:dash-join` — bare. Resolve the dash (see below), then join it.
- `/tugplug:dash-join <name> <message…>` — join with `<message>` instead of the draft. Use only when the user typed a message; never invent one to pass here.

## Resolving the dash

```bash
tugutil dash list --json
```

- **Exactly one active dash** and no name given → that's the one.
- **Several** and no name given → `AskUserQuestion` with the candidates (name + description + rounds). Do not guess.
- **None** → report that there is nothing to join and stop.
- **A name that isn't in the list** → report it and show the list; do not fuzzy-match it onto a neighbor.

## Where you run from

`tugutil dash join` must run from the **base checkout's repo root** — it refuses from inside the dash worktree, and it refuses when the repo root is not on the dash's base branch. If the working directory is inside a dash worktree, run the join with an explicit `cd <repo-root> && tugutil dash join …` (absolute path). Never `cd` into the worktree for a join.

## The message it will join with

The squash message is, in order: an explicit `--message`, else the dash's maintained **join draft**.

```bash
tugutil draft show --owner dash:<name>
```

- **A draft exists** → that is the message. Show it in your report before joining.
- **No draft** → **stop.** Report that the dash has no join draft, and print the command that writes one, on its own line and inside backticks so the Session card renders it as a clickable chip:

  `` `tugutil draft set --owner dash:<name> --message "<subject + rounds digest>"` ``

  The subject that command writes is **bare** — no `tugdash(<name>): ` prefix. The join adds the scope itself, and a scope naming a different dash is stripped there rather than preserved.

  Do **not** compose the message yourself, and do not let the join fall through to the bare dash description. Message authorship needs the working context — what the rounds did and why — which the working skill has and this gesture does not; a message invented from log lines is exactly the durable lie the draft machinery exists to prevent. Whoever worked the dash writes the draft; this gesture joins it.

## Beat 1 — preview

```bash
tugutil dash join <name> --preview --json
```

The preview runs the merge in memory (`git merge-tree`) and touches nothing. Read the result:

- **Clean** → go to beat 2 — but a clean preview is no longer the whole answer. Every join rides a candidate the project's own checks have judged, clean ones included: opening join mode on the card resolves a clean dash and verifies the one-shot squash that produces. So a beat-2 join can be refused with *"this candidate is unverified"* or *"no verified candidate"* even though nothing conflicts, and the honest answers are the same two the card offers — let the resolve run, or pass `--anyway`.
- **Conflicts** → report every conflicted path plus the message that would have landed, and **stop**. Do not join, and do not resolve on your own initiative.

  The next step is the card's, not yours. Pressing **Resolve** on the dash row runs the ladder and then hands the merge to the resolver — an agent that finishes it in the dash's workshop worktree, audits what the machine rungs decided, asks the user one intent question if the two sides genuinely conflict, and reports; the project's own declared checks then run over the tree that would land. Say that is what the row offers, and let the user press it. `tugutil dash join <name> --resolve` is the CLI equivalent and it **lands** what it resolves, so run it only when the user says to, and never as a probe. Resolving by hand on the dash worktree and re-running the join is the other real option, and the one nothing audits.

Preflight refusals come back as errors from this same command — surface them verbatim and stop:

- *"Cannot join from inside the dash worktree"* → re-run from the repo root.
- *"repo root worktree is on branch 'X' but dash targets 'Y'"* → the user checks out the base branch; do not switch branches for them.
- *"the base worktree has uncommitted changes to files this dash also changed (…)"* → the preflight is intersection-aware, so only the named files block. Report them and let the user commit or stash. Never stash, reset, or check out on their behalf.
- *"Nothing to join: dash '<name>' has no commits past '<base>'. Discard it instead."* → the dash is empty. This one is a **question**, not a stop: report it and raise an `AskUserQuestion` — *"Discard it"* / *"Keep it"*. An empty dash is a real fork with two good answers (the work was abandoned, or it has not started yet) and no conventional default, which is exactly what a dialog is for.

  On *"Discard it"*, run `tugutil dash discard <name>` — the dialog **is** the user's gesture, which is the only thing that ever authorizes it. On *"Keep it"*, stop and say the dash is still there. (The second answer used to read *"Leave it"*, in the ordinary English sense of leaving it standing. It is *"Keep it"* now because **Unbind** is the button that used to say Leave, and an answer that reads as a verb from the same system while meaning something else entirely is a collision waiting to be misread.) **Never discard on your own initiative** — discard is the one irreversible act in the workflow, so it needs the user to have said so, in the answer, that turn.

The other three above stay stops. They are correct refusals with one right answer, not unasked questions — the distinction is the doctrine's [never-ask list](../../../tuglaws/dash-work-doctrine.md#what-never-gets-asked). Where that document is absent, the distinction as drawn here is the whole rule, and say so.

## Beat 2 — join

```bash
tugutil dash join <name>
```

Squash-merges `tugdash/<name>` into its base and tears down the worktree + branch. Never pass `--strategy merge` or `--strategy rebase` — squash is the lane's one strategy; the others are expert CLI paths the user drives themselves.

- A join interrupted mid-teardown (the command reports the journal) resumes with `tugutil dash join <name> --continue`. Run that; it is the resume, not a retry.
- A non-preview join that hits conflicts exits non-zero with the working tree already restored. Report the paths; the options are the same two as beat 1.
- A join refused for its **verdict** — unverified, red, or no candidate at all — is refused by `join_in` itself, so the CLI and the card meet one gate rather than two opinions. `--anyway` is the escape and it is the user's to ask for: it lands a tree the project's checks refused or never saw. Report the sentence verbatim and let them choose.
- A join refused with *"a resolve is already running for this dash"* is admission, not failure: one dash admits one run, and the one holding it is still finishing. Wait and re-run rather than forcing it.

## After a successful join

1. **Clear the join draft** — join drafts are keyed by reusable dash names, so an uncleaned draft haunts the *next* dash of the same name as a clobber-protected message describing work that already landed:
   ```bash
   tugutil draft clear --owner dash:<name>
   ```
2. **Read the receipt back** — `tugutil log --limit 1` on the base branch shows the squash commit that landed. Report its hash and subject.

## Report

- The dash, its base branch, and the number of rounds it carried.
- The message that landed, as landed.
- The squash commit hash + subject.
- Teardown: worktree and branch removed; draft cleared.
- Any warnings the CLI emitted (a worktree it could not remove, a branch it could not delete) — verbatim, not paraphrased.

On a stop instead of a join, report what blocked it, the exact CLI message, and the one next step that unblocks it.

## Guardrails

- **`tugutil dash join` does the git.** No `git merge`, `git rebase`, `git cherry-pick`, `git checkout`, `git stash`, or `git reset` — not to prepare the join, not to recover from one.
- **Never compose the join message.** No draft is a stop, not a prompt to write one.
- **Never discard on your own initiative.** `tugutil dash discard` destroys work. The one path that may run it is the empty-dash dialog, and only on the answer that asked for it — a discard nobody chose, that turn, is never yours to make.
- **Preview before joining, always** — even when the user names the dash and the message. Beat 1 shows exactly what beat 2 does.
- **Never resolve conflicts unasked.** `--resolve` rewrites the merge result; it runs on the user's word.
- **Squash only.**
- **Don't edit the tree.** This skill joins what exists; it does not fix a build, a test, or a lint on the way through. A dash that isn't ready goes back to `/tugplug:dash-on` or `/tugplug:dash-implement`.
- **No AI attribution in the joined message. Ever.**
