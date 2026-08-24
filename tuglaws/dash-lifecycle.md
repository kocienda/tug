# The dash lifecycle

*What a dash **is**, what its states mean, and what a binding is. The companion file [dash-work-doctrine.md](dash-work-doctrine.md) covers the other half — how an **agent** behaves once it is working on one. Two audiences, two files: a person asking "why does this dash read as unbound" and an agent asking "may I write here" are not asking the same question.*

## What a dash is

A dash is four things and no more:

1. **A git branch**, `tugdash/<name>`.
2. **A worktree**, conventionally `.tug/worktrees/<name>` under the main repository root.
3. **Branch config** — `branch.tugdash/<name>.{tugbase,description,tugid,tugplan}`. Each key is spelled in exactly one place (`base_config_key`, `description_config_key`, `tugid_config_key`, `plan_config_key` in `tugdash-core/src/ops.rs`); they hang off the **raw** dash name, not the sanitized spelling worktree directories use.
4. **A dash-log**, the append-only record of rounds and declarations.

There is no dash database. Every fact any surface renders about a dash is read from one of those four on demand, which is why `tugutil dash list` and the Changes card cannot disagree: both call `dash_detail_entries_in` (`tugdash-core/src/ops.rs`), which is the one composition.

**Every dash op resolves the main repository root first.** `main_repo_root` normalizes whatever root it was asked from, because a dash's branch and worktree live in the *main* repository whichever checkout the question came from — and a card's project directory may itself be a linked worktree (`just app-debug` produces exactly that). A path handed outward is therefore **absolute**, resolved where the main root is known ([D138]); nothing downstream composes one, because nothing downstream can.

## Identity

The owner key is `tugdash/<name>#<tugid>` (`dash_owner_key`). It is **opaque** — never a git ref, never displayed. Draft rows, session-binding rows, and the deck's `(workspace_key, owner_kind, owner_id)` draft-overlay key are all this same string, so entry, row, and overlay agree by construction.

What the key buys is that two incarnations of a reused name are distinct: discard `fix-join` and create it again and the second one is a different dash, so the first one's draft cannot surface under it.

- Anything that needs a **ref** reads the `branch` field. Never the owner key.
- Anything that needs a **name** for a human reads `display_name`.
- A dash created before ids existed keys under its bare branch ref. `legacy_owner_key` strips a key to that form, and `tugutil draft` reads through it and supersedes — the first resolution through the legacy key rewrites the row under the current key, so the population it serves shrinks to zero on its own.
- **Read paths never mint.** `dash_owner_key` returns the bare ref when there is no `tugid`; only write-path verbs (`create`, `commit`, the `/api/dash` bind handler) call `ensure_dash_id`. A read that wrote git config would be a side-effecting read and a multi-process race on every feed recompute.

**The sigil is `^` (U+005E).** Everywhere a dash is named to a person it wears one, with no opt-out, rendered by the single `DashSigil` component both surfaces compose — `tugtool/juicy-roach^dash-steps`. It was `#` until the collision became untenable: the transcript already numbers messages `#0001` and marks turns `#u12`, and markdown headings are hashes. `◊` replaced it and lasted a day; the lozenge measured well and read badly, which is the whole argument against picking a glyph on metrics. The caret is ASCII, present in every bundled face, and unclaimed by any other Tug grammar. The `#` inside the **owner key** is a different `#` and does not move: that grammar is opaque and never displayed.

## The stages, and derive vs declare

`derive_stage(rounds, worktree_dirty, has_draft, joining, declared)` returns one of seven words, in this precedence:

| Stage | When | Kind |
|---|---|---|
| `joining` | a join journal exists — an interrupted teardown | derived |
| `implementing` | a `dash step` declaration is the latest | declared |
| `built` | `dash mark built` | declared |
| `audited` | `dash mark audited` | declared |
| `draft-ready` | a maintained join draft exists | derived |
| `working` | rounds past base, or a dirty worktree | derived |
| `created` | none of the above | derived |

`joining` outranks everything, including a declaration, because an interrupted teardown is the one state that actively needs a person.

**The rule: anything git can see is derived on every read and never stored; anything it cannot is declared once, in the dash-log, by a verb** ([D138]). Rounds, dirt, and the journal are visible to git, so they are recomputed every time and cannot go stale. "This build succeeded" and "I am on step 4 of 9" are not visible to git at all, so a verb writes them down. **A stage is never written to a config key** — that would make the derived half stale-able and the declared half duplicated.

## Binding

A **bind** mates a live session to a dash. It is a UI concept: git has no idea it happened.

- It lives in the per-instance `sessions.db` and is read back **live-sessions-only** (`bound_sessions_for`). That is exactly why a dash whose cards have all closed reads as *unbound* — unbound is not a stage, it is the absence of workers.
- It is **per-card**. A session has at most one dash, which is why `unbind_dash`'s whole payload is the session id.
- It **mints**: `bind_dash` naming a dash that does not exist succeeds anyway. Every sender therefore builds its frame from a snapshot row rather than from user text; the one place that accepts a typed name (`/dash-bind <name>`) matches the snapshot first and routes an unknown name to `dash create` through the shell, where the receipt says what was made.
- Two cards on one dash is **legal**, not a race: `bound_sessions` is a list and the Lens renders one jump chip per bound session. A bind displaces only *this* card's previous binding.
- A bind is **never a join authority**. It says who is working; it does not say who may join.
- The store moves on the **broadcast**, never on the gesture: `bind_dash_ok` / `unbind_dash_ok` are the only movers of `cardSessionBindingStore`, which is what leaves a card correctly bound to what it was when a bind is refused.

## Plan adoption

A dash that implements a plan **owns** that plan: the worktree copy is the only live one, and only a verb moves it ([D139]). Nothing in the dash lane instructs anyone to copy a plan file by hand, because a hand-copy leaves two live copies with no receipt and no way to notice they have diverged.

- **Adoption at birth.** `tugutil dash create <name> --plan <path>` resolves the plan in either root, commits its bytes on the dash branch, records `branch.tugdash/<name>.tugplan`, and cleans the base copy. Re-running it over a live dash is the repair path, not an error, and `tugutil dash adopt-plan <name>` is the same transplant on its own.
- **What "clean the base copy" means.** A tracked path is restored with `git checkout HEAD -- <rel>`; an untracked one is removed. A *committed, clean* base copy is left alone — that is not a second live copy, it is ordinary branch divergence the join squash resolves like any other file.
- **The ordering is the safety property.** The engine reads base, writes and commits on the branch, and only then touches base. On any failure the base copy is exactly as the user left it.
- **Divergence is a refusal, never a silent state.** `dash step` refuses while a base copy is dirty or untracked, and the join preflight names the plan and `tugutil dash adopt-plan <name>` — because the generic "commit or stash it" is wrong here: committing a stale base copy enshrines a fork, and stashing hides it to detonate later.
- **Progress is never the casualty.** When bodies differ, the base body wins and the worktree's ledger progress is replayed onto it row by row. `content_stamp` excludes status and commit cells, so a plan that was `reviewed` before adoption is `reviewed` after it.
- **Discard hands the plan back.** Adoption removed the base copy and discard deletes the branch holding the only one, so `discard_in` writes the plan back to the repo root before teardown and the discard receipt says so. The plan comes in when the dash adopts it and goes back out when the dash is discarded — a plan is not the work, it is the authored document that predates the dash and outlives it ([L23]).

## The operation log, and undoing

A dash verb that lands, moves, or deletes a branch used to be a one-way door. `tugutil dash undo` is the way back, and it rests on a log every mutating verb writes **before** it acts.

An operation has two halves, which store different facts and never the same one:

- **A keepalive ref**, `refs/tug/oplog/<seq>`, on a synthetic commit whose parents are every tip the verb is about to move or delete. This is what makes recovery possible at all: once it exists, `branch -D` and `reset` cannot strand the dash's rounds, so they are reachable from a ref rather than from a reflog on a clock.
- **A payload**, `oplog-<seq>.json` beside the join journal in the project state dir, holding the verb, the dash, and the before/after values. It is a file rather than the keepalive's commit message because it is written twice — once before the verb acts and once when it completes — and a commit message is immutable.

Three verbs record: `join`, `replay`, and `discard`. `create` does not, because a half-made create already rolls itself back. Retention is 50 operations per repository, pruned oldest-first by the writer — no daemon, the same discipline the join journal uses. Pruning drops both halves, and dropping the keepalive is what finally lets `git gc` collect the commits, which is the honest meaning of *no longer undoable*.

Three rules govern the undo itself:

- **It is a compare-and-swap, never a force.** It verifies the world still matches what the operation left — the base tip unmoved, the branch not since rebuilt, the worktree clean where it must be — and refuses by name otherwise: `tip-moved`, `base-dirty`, `branch-exists`, `already-undone`, `incomplete-op`, `nothing-to-undo`. `reset --keep` rather than `--hard` is the mover, so git itself refuses over changes that would be lost. An operation that later work has made un-undoable stays that way, and the refusal names the newer tip so a person can decide by hand.
- **It restores git state only.** Bindings live in a per-instance ledger and are live-sessions-only by design, so a restored dash reads as **unbound** and rebinding is the user's gesture. The report says so rather than letting it be discovered.
- **An undo is recorded but never undoable.** It belongs in the log — it moved refs — but offering to reverse it would make the verb a redo on alternate presses. So undo records are skipped when selecting what to reverse, which is what makes a second press report `already-undone` about the real operation rather than complaining about the undo.

A discard's handed-back files are the one half no undo reverses: they were *copied* into the base checkout, and pulling files back out of a user's checkout is what this engine never does. The undo names them and leaves them.

## Joining — by reference

A dash joins by `/dash-join <name>` into its base: a preview runs on entry, the squash message is edited in the composer, and the join is the human’s act. Skills draft; humans join.

The doctrine — the two beats, the one-slot `LandingMode`, and the five outcomes a join can reach — is held in [tracking-changes.md](tracking-changes.md#the-landing-workflow), where the capture and commit layer beneath it already lives. It is law where it stands and is deliberately not restated here.

## Naming

An operation is spelled the same everywhere, and that spelling is its `tugutil` verb path, hyphenated: the card verbs are **`/dash-bind`** and **`/dash-join`**.

`dash` and `join` survive as **retired spellings**, and are not scheduled for deletion. They are kept for muscle memory, which does not expire on a release schedule, and `deprecatedFor` excludes them from the completion popup so they are invisible to discovery. The failure mode is what decides it: a `/verb` that stops matching the local registry is submitted to Claude as a prompt — a burned turn on a line the user meant as a gesture.

## See also

- [dash-work-doctrine.md](dash-work-doctrine.md) — how an agent behaves on a dash worktree.
- [tracking-changes.md](tracking-changes.md) — the capture and commit layer beneath a dash, and the landing doctrine.
- [D112] (scope axiom), [D113], [D116] (the landing workflow), [D138] (derive vs declare), [D139] (one plan home).
