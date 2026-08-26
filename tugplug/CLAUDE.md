# Tugplug Plugin Guidelines

## Skills

The plugin ships **agentless, main-loop-driven** skills — there are no sub-agents.

Two kinds of work leave the base on a worktree and come back to it through a join. A **dash** is the documented kind: a brief, a plan, and an **arc** — the server-driven sequence that rotates the card's session through the `devise`, `review`, and `implement` stages, each on the model the project declared for it. A **poke** is the other kind: no document, no review, no arc — a worktree, rounds, and the join. The skill names follow the split: the `dash-*` family is the arc's stages, `poke` stands alone, and `dash` is the door to both.

**The dash family:**

- **`dash`** — the lane's conversational front door, invoked as the bare `/dash`. Takes a free-text idea (or nothing), sharpens it, routes it with one question to a poke, a design spike, the plan arc, or a brief-then-plan, and on the arc route writes the brief and hands it to `tugutil dash run`. It **sequences and narrates; it does not restate** — at each hand-off it reads the sibling's own `SKILL.md` and runs that contract in-thread, so the expert skills stay the single source of truth for their own mechanics and every one of them stays independently invocable. Creates no worktree, commits nothing, joins nothing.
- **`dash-devise`** — the arc's first stage: author an implementation plan in-thread against the devise skeleton (`tuglaws/devise-skeleton.md`). Writes the dash's own `plan.md`, or an explicit path.
- **`dash-review`** — the arc's second stage: lint the plan (`tugutil plan lint`), judge it against [`tuglaws/dash-review-rubric.md`](../tuglaws/dash-review-rubric.md) and the real code, **apply the fixups in the plan**, append a Review Record, and stamp it with `tugutil plan stamp` as the last edit — which is what lets `tugutil plan status` say afterwards whether the review still covers the document. Reached by the arc, from a typed `/dash-review` in the card, or by `dash-devise` handing over a clickable chip. It runs as an ordinary turn on **whatever model is selected** — nothing borrows, nothing switches. A plan devised on Opus is reviewed inline by `dash-devise` itself, in the same turn, because the review model is already the one holding the job.
- **`dash-implement`** — the arc's third stage: drive a plan to a tested build on an isolated `tugutil dash` worktree, committing per step, stopping before the join. Walks a single step, a step range, or the whole plan, driving the plan's Step Status Ledger with `tugutil dash step start|done`. Gates at setup on `tugutil plan status <name>`: a plan whose review is `stale` or `never-reviewed` raises a dialog rather than being walked silently.

**The poke:**

- **`poke`** — quick, plan-less, review-less work on an isolated worktree, joined back the same way a dash is. Takes a name and an instruction, and nothing else. Underneath it is an ordinary dash with no documents and no arc — it rides the same `tugutil dash` verbs, and the Lens, the Changes shade, and the join do not distinguish it.

**Drafting and authoring:**

- **`draft`** — analyze the working changes, decide per-file dispositions, and author the session's landing draft via `tugutil draft set`. **Never commits** — the user lands the draft with `/commit` in the Session card.
- **`spike-card`** — scaffold a design spike onto the deck: one file in `tugdeck/src/spikes/` plus two lines in its registry, verified by a build and opened from Maker ▸ New Spikes Card. Deliberately not a Component Gallery card — the gallery holds exemplary demos of established `Tug*` components, a spike holds an idea, and `card-taxonomy.test.ts` enforces the split.

The lifecycle skills run in the main conversation and ride the `tugutil dash` CLI (`create` → `step start` → `commit` → `step done` per step, `mark` for the stages git cannot see). The flow starts at the bare `/dash`, which sizes the idea and routes it; under an arc the server rotates the three stages itself and nothing needs typing between them. The expert path is to type the stage you want: `/tugplug:dash-devise` (which reviews its own plan when it is already on Opus, and otherwise hands you the review chip) → `/tugplug:dash-implement`, or `/tugplug:poke` for work that wants none of that → the user's join gesture in the Session card (the working run leaves the dash's join draft behind for it).

**The shared working discipline lives in [`tuglaws/dash-work-doctrine.md`](../tuglaws/dash-work-doctrine.md)**, not in the skills: worktree-root discipline, the verification bar, test discipline and the banned shapes, law discipline, round mechanics, the stop-before-join obligation, no plan numbers in durable artifacts. `dash-implement` and `poke` cite it and state only their own flow, so editing one no longer drifts the other.

**Location discipline (critical):** a dash's documents live at `<repo>/.tug/dashes/<name>/` — `brief.md` and `plan.md` — and the **name** is their address on every verb. `tugutil dash documents <name>` reports them, `--ensure` creates the directory to write into, and nothing is declared, assumed, or asked: there is no directory to choose. The documents are gitignored, so they are never on a diff and never something the user has to clean up. Once a worktree exists it is the **only** working root for *code* — every operation uses an absolute path into it, and nothing is written to the base checkout's working tree until the landing.

The old multi-agent orchestration — a swarm of clarifier/author/critic/conformance/overviewer/architect/coder/committer/reviewer/auditor/dash agents — has been fully retired: no sub-agents, no per-step tugstate database, no inter-agent JSON contracts. Every agent is gone.

## Plan Mode Policy

**DO NOT automatically enter Plan mode.** Never use `EnterPlanMode` unless the user explicitly asks for it. Just do the work directly.
