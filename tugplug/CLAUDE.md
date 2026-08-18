# Tugplug Plugin Guidelines

## Skills

The plugin ships **agentless, main-loop-driven** skills — there are no sub-agents.

**Plan lifecycle:**

- **`plan-devise`** — author an implementation plan in-thread against the devise skeleton (`tuglaws/devise-skeleton.md`). Writes to an explicit path (no assumed directory). *(was `devise`.)*
- **`dash-implement`** — drive a plan to a tested debug build on an isolated `tugutil dash` worktree, committing per step, stopping for review before merge. Walks a single step, a step range, or the whole plan, driving the plan's Step Status Ledger with `tugutil dash step start|done`. Gates at setup on `tugutil plan status`: a plan whose review is `stale` or `never-reviewed` raises a dialog rather than being walked silently. *(was `implement`.)*
- **`dash-on`** — quick, plan-less worktree-isolated task, same agentless model as `dash-implement` but without a plan. Takes a name and an instruction, and nothing else. *(was `dash-run`, and `dash` before that — the bare name belongs to the lane, not to one skill in it.)*
- **`dash-join`** — land a worked dash into its base: preview via `tugutil dash join --preview`, then squash with the dash's join draft as the message, clear the draft, report the receipt. Backs the Session card's `/join` verb. Never composes the message and never discards. *(was `join`.)*

**Assessment & drafting:**

- **`plan-review`** — pre-implementation: lint the plan (`tugutil plan lint`), judge it against [`tuglaws/plan-review-rubric.md`](../tuglaws/plan-review-rubric.md) and the real code, **apply the fixups in the plan**, append a Review Record, and stamp it with `tugutil plan stamp` as the last edit — which is what lets `tugutil plan status` say afterwards whether the review still covers the document. Reached from a typed `/plan-review` in the card, or by `plan-devise` handing over a clickable chip. It runs as an ordinary turn on **whatever model is selected** — nothing borrows, nothing switches. A plan devised on Opus is reviewed inline by `plan-devise` itself, in the same turn, because the review model is already the one holding the job. *(was `review-plan`, and replaced `vet` before that — `vet` was read-only by construction and so could only hand its findings back.)*
- **`dash-audit`** — post-implementation: audit the built code (or step range) against the tuglaws and the real diff, then rule "fixups needed" or "good shape". Read-only, with one carve-out: a good-shape verdict on dash-resident work declares `tugutil dash mark <name> audited`. *(was `audit`.)*
- **`draft`** — analyze the working changes, decide per-file dispositions, and author the session's landing draft via `tugutil draft set`. **Never commits** — the user lands the draft with `/commit` in the Session card. *(was `commit`, which committed fire-and-forget; skills draft, humans land.)*

The lifecycle skills run in the main conversation and ride the `tugutil dash` CLI (`create` → `step start` → `commit` → `step done` per step, `mark` for the stages git cannot see). The flow is `/tugplug:plan-devise` (which reviews its own plan when it is already on Opus, and otherwise hands you the review chip) → `/tugplug:dash-implement` (or just `/tugplug:dash-on`) → `/tugplug:dash-audit` → review → the user's `/join <name>` in the Session card (the working run leaves the dash's join draft behind for it).

**The shared working discipline lives in [`tuglaws/dash-work-doctrine.md`](../tuglaws/dash-work-doctrine.md)**, not in the skills: worktree-root discipline, the verification bar, test discipline and the banned shapes, law discipline, round mechanics, the stop-before-landing obligation, no plan numbers in durable artifacts. `dash-implement` and `dash-on` cite it and state only their own flow, so editing one no longer drifts the other.

**Location discipline (critical):** no skill assumes a plan directory — `roadmap/`, `.tugtool/`, and any other home are never hardcoded. A plan is always an explicit path; the working root is derived from that path and from `tugutil dash create`'s worktree response. Once a worktree exists it is the **only** working root — every operation uses an absolute path into it, and nothing (code, plan, ledger) is written to the base checkout until the landing.

The old multi-agent orchestration — a swarm of clarifier/author/critic/conformance/overviewer/architect/coder/committer/reviewer/auditor/dash agents — has been fully retired: no sub-agents, no per-step tugstate database, no inter-agent JSON contracts. Every agent is gone.

## Plan Mode Policy

**DO NOT automatically enter Plan mode.** Never use `EnterPlanMode` unless the user explicitly asks for it. Just do the work directly.
