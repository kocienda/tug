# Closing the Dash/Join Gaps: Two Rounds {#close-dash-join-gaps}

**Purpose:** Carry the dash/join lane the rest of the way toward the statement that framed this whole arc — *git versions the repository; it doesn't version the project* — with two rounds: one that makes the dash machinery itself a citizen of the instance model so app-tests run from any worktree, and one that makes the landing gate read the merged **project's** verdict (build + derived test selection) instead of only git's text-level verdict.

This is a brief, not a plan. Each round gets its own `/tugplug:plan-devise` pass when picked up; the open questions below are the ones devise must ask before writing steps.

---

## Where the arc stands {#where-the-arc-stands}

The join-truth round (`roadmap/join-pipeline-truth.md`, landed 2026-08-18) closed the *epistemic* half of the integration gap: join state is now one server-owned fact on the changesets feed, keyed by the [L29] `workspace_key`, with candidates anchored to git ancestry and every refusal required to name a mounted control or a reason in time. The deadlock class (two client stores keyed by two spellings of one path) is unrepresentable, and silence is structurally excluded.

Two gaps remain, and the join-truth run itself demonstrated both:

1. **The app-test harness could not run from the dash worktree.** Steps 6–10 of join-truth shipped with their app-tests — including the brand-new at0441 full-arc test — statically adapted but never executed. A whole verification tier went dark for exactly the duration of working in the parallel environment the dash lane exists to provide.
2. **The land gate trusts git's answer, not the project's.** `tugdash-core/src/ops.rs` (the land path) runs no build and no test. A merge that is textually clean but semantically broken — the renamed symbol on one side, the new call site on the other — sails through `deriveJoinOutcome` as `clean` and lands with a green readiness line.

On undecidability: it is conceded that no tool can guarantee two clean-merging changes remained *true* about each other in the general, adversarially constructed case. That is not the target. The target is the everyday case — the merge that compiles or doesn't, the semantic drift the project's own tests already know how to catch. The success statement is precise: **no breakage that the project's own checks would have caught may land silently.** What remains beyond that — merges that pass every check and are still wrong in intent — is the residue human review was always for.

---

## Round 1 — the dash machinery joins the instance model {#round-1}

### The actual blocker, precisely {#round-1-blocker}

The `justfile`'s `app-test` recipe refuses to run from a linked worktree or a `tugdash/*` branch (the refusal block near `justfile:1019`, escape hatch `TUG_APPTEST_ALLOW_WORKTREE=1`). The harness itself is **not** the problem — it already derives per-worktree identity end to end: `WTSLUG` from the branch, `TUG_APPTEST_ID_PREFIX="apptest-<wtslug>"` scoping instance ids, every destructive sweep scoped to this worktree's instances, and the bundle id `dev.tugtool.app.apptest` baked so build and run cannot disagree.

The problem is one function: `tugdash-core::ops::main_repo_root` (`ops.rs:2828`, via `tugutil_core::find_repo_root_from`). **Every dash verb hops to the main checkout before doing anything.** So a fixture dash created by a test running from a worktree is created against the base checkout — while the app under test has the *worktree* open as its project. The dash lane can never list the row its own fixture just made; the test times out waiting; and because the timeout skips teardown, the run leaves branches, worktrees, and dash-log lines behind in the developer's real checkout. The refusal is a confession, not a fix.

The hop exists for a good reason in the developer flow: a human running `tugutil dash create` from inside a dash worktree means "against base" — nested dashes were never a designed thing, and dash state (registry, log, worktree homes) lives at the base root. The hop is right for that flow and wrong exactly when the "worktree" is itself the project an app instance has open.

### Design direction {#round-1-direction}

**The dash universe is a property of the project, not of the process.** The principled rule: dash verbs resolve their repo universe from the project root the calling context is operating on — explicitly, never by heuristic. Concretely:

- An **explicit scope override** (an env var the harness sets, e.g. `TUG_DASH_UNIVERSE=<abs path>`, or the instance's project root plumbed through the request the way `project_dir` → `workspace_key` already flows on every dash message) pins the dash universe to the checkout under test. With the override set, `main_repo_root` does not hop. Without it, current behavior is unchanged — the developer flow keeps its hop.
- The refusal block and `TUG_APPTEST_ALLOW_WORKTREE` are **deleted**, not widened. The recipe sets the scope and runs.
- Registry, dash-log, and worktree homes follow the scoped root, so a fixture dash is born, listed, joined, and torn down entirely inside the universe the app under test can see. Per-run nonces (the at0426/at0441 fixture discipline) already namespace fixture branches; that carries over unchanged.

**Scratch-base fixtures.** The second half of this round pays off a debt join-truth had to leave: at0441 stops one beat short of pressing the land control, because a fixture dash's base is whatever branch the checkout has out — landing would squash a fixture commit onto the developer's live branch. With the dash universe scopeable, a dash-lane fixture can be given a **scratch base**: a fixture branch (or a fixture repo) that the landing squashes onto and the nonce sweep deletes. That discharges the join-truth exit criterion that is still open — *the poster child lands with no CLI intervention* — as a real pressed-button beat in at0441, not a Rust-layer proxy.

### What Round 1 delivers {#round-1-deliverables}

- `just app-test <file>` and `just app-test-changed` run green from a dash worktree; the refusal and its override are gone from the `justfile`.
- Every future `dash-implement` run executes its app-test checkpoints in place. The "statically adapted, never executed" gap cannot recur.
- at0441 gains its final beat: the land control is pressed, the squash lands on a scratch base, the feed reports the landing, teardown leaves nothing.
- The dash verbs' repo resolution has exactly two behaviors — hop (default, developer flow) and scoped (explicit) — both stated in `ops.rs` where `main_repo_root` lives, neither inferred.

### Open questions for devise {#round-1-questions}

- Scope mechanism: env var read by the CLI + tugcast, or `project_dir` plumbed per-request through the dash message surface (which [L29] then canonicalizes)? The per-request route is more honest but touches every verb signature; the env route is one seam but process-global.
- Scratch base shape: a nonce-named branch in the same repo (cheapest; shares objects; the sweep already deletes nonce branches) or a scratch clone (fully hermetic; slower; new plumbing for the app to open it)? Recommend the nonce branch unless devise finds a reason it leaks.

---

## Round 2 — the verified landing {#round-2}

### The gap, precisely {#round-2-gap}

`Ready to land` today means *git found no overlapping hunks* (or every conflict has a reviewed, ancestry-valid candidate). Nothing asks whether the merged tree **builds** or whether its **tests pass**. The resolution ladder in `tugdash-core/src/resolve.rs` already articulates the right doctrine for machine decisions — *every rung above the replay probe is a machine decision the user never saw*, so each `FileResolution` carries the reviewable diff — but the ladder's subject is text. This round gives the project itself a rung.

The repo already holds the key instrument: **the `@covers` selection derivation is a map from a diff to its semantic surface.** `just app-test-changed` / `app-test-select` answer "which project-level truths does this change bear on?" — a question git cannot pose. Pointed at a candidate merge's combined diff (`base_head..candidate`) instead of a working diff, it is precisely the scoped verification a project-level landing needs — derived, not guessed.

### Design direction {#round-2-direction}

**A `verification` fact on the feed's join block**, server-owned like everything else there, produced by materializing the candidate merge in a scratch worktree (precedent: the rerere rung already runs a scratch detached worktree, `resolve.rs` rung 2) and interrogating it:

- **Tier 0 — the merged tree builds.** Cheap, always computed for a candidate: `cargo check` scoped to touched crates, `bunx tsc --noEmit` / `bunx vite build` when the merge touches tugdeck. This alone kills the classic clean-text-broken-build case.
- **Tier 1 — the derived selection passes.** The `@covers` selection over `base_head..candidate`, run against the merged tree via the Round 1 scoped harness. Expensive (each app-test launches an instance, serialized machine-wide), therefore an **asynchronous fact, not a preview blocker**: it runs when asked (or by policy), and the feed reports `unrun | running | green | red` with the failing files named.

Cacheability follows the join-truth split exactly: verification is a pure function of two trees, so it caches by `(base_head, candidate_sha)` — SHA-anchored, unlike blockers, which stay uncached because they answer to working-tree dirt. A verification survives reloads and restarts for the same reason candidates do: it is anchored to git objects, not to a store's memory.

**The face speaks; policy decides whether it blocks.** The readiness line distinguishes *"Ready to land — verified green"* from *"Ready to land — unverified"* from a refusal *"Merged tree fails at0418 — resolve before landing"*, each in the reachability discipline the landing face already enforces (every refusal names a mounted control or a reason in time). Whether a red or unrun verification *refuses* the land or merely *speaks* is a policy knob — see the open questions; the default proposed here is: red refuses, unrun speaks.

### What Round 2 delivers {#round-2-deliverables}

- The join block carries a `verification` fact; the landing face renders it; reload/restart preserve it.
- The demonstration scenario is pinned by a test: two sides that merge with zero conflict markers and a broken build produce a landing face that **refuses with the failure named** — the silent-semantic-breakage class becomes a visible-refusal class.
- `Ready to land` regains its plain-English meaning: the merged project, not merely the merged text, is in a state the user would accept.
- The at0441 arc extends by one beat: conflicted → resolved → reviewed → **verified** → landed.

### Open questions for devise {#round-2-questions}

- **Policy:** does red verification refuse the land, or speak and defer to the user? Does unrun verification refuse, speak, or trigger the run? (Proposed: red refuses; unrun speaks and offers the run as the named control.)
- **Trigger:** is Tier 1 automatic on candidate creation, on preview, or only on an explicit gesture? Machine-wide app-test serialization argues for the gesture, at least initially.
- **Tier 0 scope derivation:** touched-crate detection for `cargo check` — reuse whatever `app-test-covers-check` / selection plumbing already knows, or a simpler workspace-wide check first?
- **Where the runner lives:** tugcast spawning `just` (matches how app-tests actually run) vs a tugdash-core seam like `FileMerger` (`resolve.rs` [P32]) so the CLI and server share it.

---

## Sequencing and dependencies {#sequencing}

Round 1 strictly precedes Round 2: running the derived selection against a materialized merge worktree **is** running app-tests from a worktree. Tier 0 of Round 2 could technically land first (a build needs no harness), but splitting it buys nothing — the rounds are each one coherent dash.

Both rounds extend, and must not fork, the doctrines join-truth established: server-owned facts on the feed, [L29] keys everywhere a path is compared or persisted, the cacheability split (SHA-anchored facts cache, dirt-answering facts never do), and refusals that name a mounted control or a reason in time.

## Success criteria for the arc {#success-criteria}

- A full `dash-implement` run — plan through build — executes every checkpoint, app-tests included, from its own worktree, with zero residue in the developer's checkout afterward.
- `TUG_APPTEST_ALLOW_WORKTREE` no longer exists in the tree.
- at0441 covers the entire poster-child arc through a pressed landing.
- A textually clean, semantically broken merge cannot land silently: it either refuses with the failure named or lands only past an explicit user decision made in view of a red verification — never past a face that said nothing.
