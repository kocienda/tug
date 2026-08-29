# Tugplug Plugin Guidelines

## Skills

The plugin ships **agentless, main-loop-driven** skills — there are no sub-agents.

A **dash** is work that leaves the base on a worktree and comes back to it through a join, and it has two doors. The **direct** dash — the plain `/dash` — is worked in the conversation the user is already in, against a task list the working session writes, with no brief and no review. The **planned** dash — `/dash-plan` — settles the idea into a brief and hands it to an **arc**: the server-driven sequence that rotates the card's session through the `devise`, `review`, and `implement` stages, each on the model the project declared for it. Which verb the user typed *is* the routing decision, and neither skill asks it again.

**The dash family:**

- **`dash`** — the direct dash, invoked as the bare `/dash <name> <instruction…>`. Creates or continues the worktree, writes the dash's **task list** — a minimal plan document: an execution-steps section and a step ledger, nothing else — then does the work itself in-thread, walking the ledger with `tugutil dash step` and committing each round. No brief, no review, no arc, and no linting: the task list exists to make the fraction real and the dash resumable, not to pass `tugutil plan lint`. Stops before the join.
- **`dash-plan`** — the planned dash, invoked as `/dash-plan [idea…]`. Orients on what is in flight, sharpens the idea with the user, writes the **brief** in this conversation on the user's own model, and hands it to `tugutil dash run` as the turn's last act. It **narrates; it does not restate** — the arc's stages are the single source of truth for their own mechanics. Creates no worktree, commits nothing, joins nothing.
- **`dash-devise`** — the arc's first stage: author an implementation plan in-thread against the devise skeleton (`tuglaws/devise-skeleton.md`). Writes the dash's own `plan.md`, or an explicit path.
- **`dash-review`** — the arc's second stage: lint the plan (`tugutil plan lint`), judge it against [`tuglaws/dash-review-rubric.md`](../tuglaws/dash-review-rubric.md) and the real code, **apply the fixups in the plan**, append a Review Record, and stamp it with `tugutil plan stamp` as the last edit — which is what lets `tugutil plan status` say afterwards whether the review still covers the document. Reached by the arc, from a typed `/dash-review` in the card, or by `dash-devise` handing over a clickable chip. It runs as an ordinary turn on **whatever model is selected** — nothing borrows, nothing switches. A plan devised on Opus is reviewed inline by `dash-devise` itself, in the same turn, because the review model is already the one holding the job.
- **`dash-implement`** — the arc's third stage: drive a plan to a tested build on an isolated `tugutil dash` worktree, committing per step, stopping before the join. Walks a single step, a step range, or the whole plan, driving the plan's Step Status Ledger with `tugutil dash step start|done`. Gates at setup on `tugutil plan status <name>`: a plan whose review is `stale` or `never-reviewed` raises a dialog rather than being walked silently.

Both doors open the same kind of thing. A direct dash rides the same `tugutil dash` verbs a planned one does, and the Lens, the Changes shade, and the join do not distinguish them — what differs is only whether an arc is driving.

**Drafting and authoring:**

- **`draft`** — analyze the working changes, decide per-file dispositions, and author the session's landing draft via `tugutil draft set`. **Never commits** — the user lands the draft with `/commit` in the Session card.
- **`wire`** — lay, revise, and shake down a **tripwire**: a standing watch that fires on a recorded fact or a commit, answers a brief, and reports itself in the Overview. Rides `tugutil wire` and authors nothing else. **Never joins** — a wire may stage work on a dash and say so, and landing it is the user's act.
`spike-card` — scaffold a design spike onto the deck — is **not** a plugin skill: it is about `tugdeck/src/spikes/` and nothing else, so it lives with this repository at `.claude/skills/spike-card/` and never ships.

## The standalone contract

Tug ships as `Tug.app`, and the only files a user's session can count on are the ones inside that bundle: the binaries in `Contents/MacOS/` (`tugutil`, `tugcode`, `tugcast`, …) and this plugin at `Contents/Resources/tugplug/`. A user's project has no `tuglaws/`, no `justfile`, no `CLAUDE.md` of ours, and no source checkout, and the machine may have no `jq`, no `bun`, and no `~/.local/bin` symlinks.

So the plugin depends on nothing outside itself and the bundle:

- **Hooks are answered by `tugutil`.** `hooks/pre-tool-use.sh` finds the binary (PATH, which the app seeds with the bundle's `Contents/MacOS/`; then beside the plugin; then `TUG_BUNDLE_PATH`) and pipes the payload to `tugutil hook pre-tool-use`. No `jq`, no other tool. When no binary can be found the hook says so through a `systemMessage` rather than going quiet.
- **Skills cite `tuglaws/` only with an absence clause.** A doctrine document is a pointer into a project that has one; every skill that reads one says what survives when it is absent, and carries those rules inline.
- **Skills never name this repository's build or tests.** What to build and what to run is the project's to declare in `.tugtool/config.toml` (`[tugtool.dash]` `build`, `post_create`, and the surfaces `tugutil dash verify` runs); the skill reads `tugutil dash config` and relays it. In Tugtool that declaration is `just app-debug`, and the surface checks are in the config file — the skills do not know this, and must not.
- **No `just`, no commit hashes, no `tugdeck/`/`tugrust/` paths, no `/Users/`.** `scripts/tugplug-lint.ts` (`just tugplug-lint`, part of `just lint`) refuses each of these in `tugplug/`, and `tugplug/__tests__/standalone.test.ts` (`just test-standalone`, part of `just test`) drives the real hook script and the real `tugutil dash` verbs from a scratch project with an empty PATH and a fresh HOME.

The lifecycle skills run in the main conversation and ride the `tugutil dash` CLI (`create` → `step start` → `commit` → `step done` per step, `mark` for the stages git cannot see). The flow starts at whichever door the user typed — `/dash` for work done here, `/dash-plan` for work the arc carries, under which the server rotates the three stages itself and nothing needs typing between them. The expert path is to type the stage you want: `/tugplug:dash-devise` (which reviews its own plan when it is already on Opus, and otherwise hands you the review chip) → `/tugplug:dash-implement` → the user's join gesture in the Session card (the working run leaves the dash's join draft behind for it).

**The shared working discipline lives in [`tuglaws/dash-work-doctrine.md`](../tuglaws/dash-work-doctrine.md)**, not in the skills: worktree-root discipline, the verification bar, test discipline and the banned shapes, law discipline, round mechanics, the stop-before-join obligation, no plan numbers in durable artifacts. `dash-implement` and `dash` cite it and state only their own flow, so editing one no longer drifts the other.

**Location discipline (critical):** a dash's documents live at `<repo>/.tug/dashes/<name>/` — `brief.md` and `plan.md` — and the **name** is their address on every verb. `tugutil dash documents <name>` reports them, `--ensure` creates the directory to write into, and nothing is declared, assumed, or asked: there is no directory to choose. The documents are gitignored, so they are never on a diff and never something the user has to clean up. Once a worktree exists it is the **only** working root for *code* — every operation uses an absolute path into it, and nothing is written to the base checkout's working tree until the landing.

The old multi-agent orchestration — a swarm of clarifier/author/critic/conformance/overviewer/architect/coder/committer/reviewer/auditor/dash agents — has been fully retired: no sub-agents, no per-step tugstate database, no inter-agent JSON contracts. Every agent is gone.

## Plan Mode Policy

**DO NOT automatically enter Plan mode.** Never use `EnterPlanMode` unless the user explicitly asks for it. Just do the work directly.
