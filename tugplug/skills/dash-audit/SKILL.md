---
name: dash-audit
description: Audit the implementation work for a plan (or a step range) AFTER it's built — assess code quality, coherence, technical choices, and architecture; audit it against the tuglaws and the real diff; then rule "fixups needed" or "codebase is in good shape"
argument-hint: "[plan-path] [; Step N | Steps N-M]"
disable-model-invocation: true
allowed-tools: Bash, Read, Glob, Grep, WebFetch, WebSearch, AskUserQuestion
disallowed-tools: Task, Write, Edit
---

## What this is

`dash-audit` is the **post-implementation** scrutiny pass. It judges the **code that got written** for a plan (or a step range) after the fact — where a plan review judges the design before anyone writes it, this pass judges the tree. It is the encapsulation of the audit the user runs by hand all the time. It produces an assessment and a verdict. It does **not** make changes — it rules; the user (or a follow-up `/tugplug:dash-implement` / `/tugplug:dash-on`) acts.

The axes below are the ones in [`tuglaws/plan-review-rubric.md`](../../../tuglaws/plan-review-rubric.md), read against built code rather than against a plan. Read the rubric for what each axis is asking; when it is absent, the axes carried here stand on their own.

**You are the auditor, in-thread.** Do not spawn sub-agents (`Task`). Do not edit files — this is a read-and-judge pass, not a fixup pass.

## Input

`/tugplug:dash-audit <plan-path> [; Step N | Steps N-M]`

- `<plan-path>` — an **explicit path** to the plan whose implementation you're auditing. There is no default location; the plan's path tells you which tree the work lives in (it may be a dash worktree — audit it where it is, resolving roots from the `.tugtool/` marker, never from an assumed directory).
- optional `; Step N` or `; Steps N-M` — narrow the audit to the work for one step or a range. With no step clause, audit all the implementation work for the plan.

## The pass

### 1. Establish what was actually built

Read the plan (and its **Step Status Ledger**) to know what was intended, then read the **actual implementation**. Pull the diff — use `tug log` and `tugutil diff --range <base>..tugdash/<name>` for the relevant commits (the ledger records commit hashes; `tug log --range <base>..tugdash/<name>` lists the dash's commits, and `tugutil diff --range …` gives the per-file change set), and read the changed files in full, not just the hunks. Audit the code as it stands, against what the plan promised.

### 2. Assess the code

Give your honest assessment of:

- **Code quality and coherence** — is it clean, consistent with the surrounding code, and free of dead ends, TODO-rot, or half-applied patterns?
- **Technical choices** — did the implementation pick the right mechanisms? Did it drift from the plan's decisions, and if so, for better or worse?
- **Implementation strategy** — is the work structured well, or are there seams, duplication, or leaks across layers that will cost later?
- **Holes, pitfalls, weaknesses, limitations** — bugs, unhandled edge cases, race conditions, missing tests, stale comments, warnings (warnings are errors here).
- **Test discipline (flag violations as findings):** the shapes banned in [`tuglaws/dash-work-doctrine.md`](../../../tuglaws/dash-work-doctrine.md) — any fake-DOM/RTL test (`happy-dom`, `jsdom` render tests, `@testing-library/react`) or mock-store assertion test — and any real-app behavior tested outside the project's real-app harness (`tests/app-test/` here). Call each one out for deletion or rewrite. These bans are Tugtool doctrine, and they bind where that document exists. On a project that never signed them, audit the tests against the plan's own Test Plan instead, note that the project has no real-app harness so its real-app claims are verified only as far as its own tests reach, and say so — do not impose a doctrine the project never adopted.
- **Plan numbers in durable artifacts** — any step identifier ("Step 4.5", "4i", "roadmap step X") written into code, comments, docstrings, test names, or commit messages. Flag each one; they should describe the behavior directly instead.

Look holistically. Determine whether the changes are *actually good*, not just whether they match the plan in the abstract. A plan-faithful implementation can still be wrong.

### 3. Audit tuglaws adherence

**When the project has no `tuglaws/tuglaws.md`,** there are no laws to audit against: audit on the axes this skill carries, name each criterion inline in the finding that uses it so the reader can see what it was judged by, and say so. Skip the rest of this section rather than inventing laws.

Confirm the code adheres to the **tuglaws** as defined in [`tuglaws/tuglaws.md`](../../../tuglaws/tuglaws.md) — **with an actual audit**, not a glance. Cross-check [`design-decisions.md`](../../../tuglaws/design-decisions.md) where relevant. Walk the specific laws the change touches (`[L02]`, `[L06]`, `[L22]`, `[L23]`, `[L24]`, `[L26]`, …) and, for each, cite the concrete code that honors or violates it. For tugdeck/tugways work this is mandatory: verify state landed in the right zone (appearance via CSS/DOM, structure via stores/`useSyncExternalStore`, direct DOM updates via store observers, not React round-trips), and that mount identity and user-visible state are preserved across transitions.

### 4. Confirm the architecture sets us up for the future

Confirm this new architecture leaves the codebase in good shape — not just working, but a foundation the next work builds on cleanly rather than around.

### 5. Verdict

End with a clear ruling:

> **Do we need to make fixups? Or can we move on from here with confidence that the codebase is in good shape?**

- If **fixups are needed**, list them concretely and in priority order — file, what's wrong, what to do. Then ask what to do with the list, with `AskUserQuestion`: *"Carry them now as rounds on this dash"* / *"Leave the list with you"*. The user is right here, and handing back a list they then have to re-issue as an instruction is a round trip nobody wanted.

  This pass cannot make the fixups itself — it holds no `Write` or `Edit`, deliberately, so that a judgment pass can never quietly become an implementation pass. "Carry them now" therefore means **hand off**: print `` `/tugplug:dash-on <name> <the fixups>` `` as its own backticked chip, with the list as the instruction, and stop. "Leave the list with you" stops with the list and no chip.
- If the work is **solid**, say so plainly, with the confidence level and any watch-items worth tracking. Nothing to ask — a good-shape verdict has one next move, and it is step 6.

That is the only question this pass asks. The boundary is the doctrine's [never-ask list](../../../tuglaws/dash-work-doctrine.md#what-never-gets-asked).

### 6. Declare it, when the work lives on a dash

A good-shape verdict on work that lives on a dash is a lifecycle transition nothing else can see, so record it:

```bash
tugutil dash mark <name> audited
```

One dash-log line and nothing else — no file in the tree changes. This is the single write this skill is allowed, it happens only on a good-shape verdict, and only when the audited work is a dash. A fixups-needed verdict declares nothing; the dash is still being worked.

## Guardrails

- **No sub-agents.** Read and judge in-thread.
- **No edits.** This pass assesses and recommends; it never rewrites the code. The one carve-out is the `dash mark audited` bookkeeping append above.
- **Audit the real diff and real files.** Ground every finding in concrete code, not the plan's description of it.
- **Always end with the explicit verdict** (fixups vs. good shape).
