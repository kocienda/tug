# Dashes in the Session card — how we got here, what's built, and the question still open

The main lane is done and it works: `/commit` enters commit mode, the composer becomes the message editor, the changes sheet shows what this session touched, Auto-Message drafts it, ⌘Return lands it, a receipt row goes into the transcript. Nobody goes back to the terminal to commit.

The dash lane has none of that. `/join` was a caution bulletin from `aeed8d02a` until 2026-08-12, when it was pointed at a new `tugplug:join` skill that drives `tugutil dash join` from the conversation. That closes the *hole* — you can land a dash without the terminal — but it does not close the *gap*. This brief is about the gap: not a missing dialog, but a missing place for dashes in the card's model of what you are working on.

## How we got here

**`dash/archive/changes-commit-dash-consolidation.md`** set the doctrine that still holds: one lifecycle — **Gather → Draft → Land** — with two lanes (main-lane commit, dash-lane join), one room (the Changes surface), and two landing gestures typed from the prompt entry. [P05] made `/join` the mirror of `/commit`: bare `/join` opens the dash lane, `/join <name>` previews and lands a squash with the join draft as the message, conflicts route into the resolve flow. [P14] made release shade-only with a discard preflight, on the reasoning that a typed one-liner must never vaporize rounds. [P08] set the landing gates: idle lifecycle, no pending landing, non-empty selection or clean preview, non-empty message — enforced both at dispatch and as affordance disable.

**`dash/archive/commit-inline-dialog.md`** then rebuilt the commit surface after three or four failed attempts at a shade/sheet scheme. The shade became a read-only glance; `TugChangesList` was extracted; the commit machinery moved out of the sheet. [P10] cut the dash lane loose deliberately: `slashCommandSurfaces.join` became a single caution bulletin, `lib/join-verb-plan.ts` and the join/resolve/release UI were deleted, and `TugJoinDialog` was named as the follow-on — "reasonably easy to undertake" *once the inline commit dialog proved out*. The ruling was explicit that a short gap beat carrying the old confusing lane forward, and that shell joins would suffice meanwhile.

**Then the model for the follow-on moved.** There is no `TugCommitDialog` in the tree. `/commit` shipped as commit **mode** — `tugdeck/src/lib/commit-mode-controller.ts`, the prompt entry's one secondary resting mode, with `evaluateCommitLandGate` as the shared gate and Z5 swapping to cancel / auto-message / commit. The surface `TugJoinDialog` was supposed to be modeled on never existed at the address the plan gave, so the follow-on had nothing to copy and was never revisited. That is the entire reason this lapsed. It was not an oversight; it was a deferral whose precondition changed shape.

**2026-08-12.** `/join` stopped being a bulletin. `tugplug/skills/join/SKILL.md` is the dash lane's landing gesture as a skill: resolve the dash, show or compose the join draft, `tugutil dash join --preview --json`, land the squash, `tugutil draft clear`, report the receipt. The deck's `/join` forwards a `tugplug:join` command atom so claude expands it as a user invocation, under the same idle gate every mutating verb takes.

## Current state of play

Far more is built than the bulletin implies. The server half is finished and unused.

| Piece | Where | State |
|---|---|---|
| `changeset_join` CONTROL — preview, execute, or land a pre-resolved candidate | `tugcast/src/feeds/agent_supervisor.rs:4545` (`do_changeset_join`) | Complete. Registry- and worktree-guarded, runs on a blocking thread, bumps the aggregate on a real land, broadcasts `changeset_join_ok {…JoinOutcome}` / `_err` |
| `changeset_join_resolve` — the conflict ladder | `agent_supervisor.rs:4654`, `feeds/join_resolve.rs` | Complete. Replay probe, rerere, re-merge, AI rung; streams per-file deltas; produces a candidate commit it never lands itself |
| `changeset_release` | `agent_supervisor.rs:4763` | Complete |
| Deck resolve overlay store | `tugdeck/src/lib/changeset-join-store.ts` | Complete. `/btw`-style live state keyed by `(project_dir, dash)`, `useSyncExternalStore`, candidate + shape + unresolved |
| Dash entries in the changeset snapshot | `tugdeck/src/lib/changeset-types.ts:110` (`DashChangesetEntry`), surfaced as `snapshot.dashes` in `lib/changes-route-controller.ts:151` | Complete — name, branch, base, rounds, worktree_dirty, **and the maintained draft**. Nothing renders it |
| Dash **Auto-Message** | `tugcast/src/feeds/draft_engine.rs` (`DraftTarget::Dash`) | Complete server-side. The engine already generates dash drafts from `base..branch` plus worktree dirt, on the same scribe path commit mode uses |
| Join preflight semantics | `tugdash-core/src/ops.rs` (`join_in`, ~1010–1085) | Complete: refuses from inside the worktree, refuses when the repo root isn't on the base branch, intersection-aware base-dirt block, "nothing to join → release" |
| Deck **sender** for `changeset_join` / `changeset_release` | — | **Missing.** The join/release slice left `changeset-verb-store.ts` with the read-only shade |
| Any dash UI at all | — | **Missing.** No mode controller, no dash lane, no conflict presentation, no join receipt variant |

So the deck can *watch* a resolve it cannot start, and *hold* a dash draft it cannot show. Nothing in this list needs new Rust.

## What the skill can and cannot do

The skill is the right tool for the agentic path and should stay: it works headless, from any project, inside a `dash` or `implement` run's own thread, with no card in the loop, and it composes the join draft at the end of a run so a landing surface would open with the message already there.

Its ceiling is real, though:

- **A conflict is a spatial problem.** Conflicted paths, per-file diffs, and a resolve gesture want to be in one place you can look at. Prose describing them is a worse instrument than the list.
- **It burns a turn and needs claude live.** The CONTROL verbs are synchronous, work mid-turn, and work logged out.
- **It runs from the base checkout.** `tugutil dash join` refuses from inside the worktree and refuses off the base branch — which is fine for a CLI and awkward for a card whose session may be anywhere.
- **It cannot hold state between beats.** Preview → look → decide → land is one continuous surface in commit mode; in the skill it is a conversation that can be interrupted, re-asked, or answered from stale output.

## The question actually still open

Adding `TugJoinDialog` — or its likelier modern twin, a **join mode** matching commit mode — would close the landing gesture. It would not answer why the dash lane still feels unfinished, which is this:

**On main, the card's session *is* the unit of change. On a dash, it isn't.** Commit mode works because everything lines up on one axis: this card is bound to a project, the session ledger says which files this session touched, the sheet shows exactly those files, and the commit lands exactly them. Attribution, surface, and gesture are all the same unit.

A dash breaks that alignment on three axes at once:

- **Place.** The work lives in a different directory (`.tug/worktrees/<name>`), on a different branch, while the card's project binding, changes attribution, shell route, and `/diff` all point at the base checkout. Work happening on a dash is not the card's changes, and the card has no way to say "I am working over there."
- **Time.** A dash's unit of change is the branch — gathered across rounds, sessions, and possibly days. The session ledger's "who changed what" is per-session and per-file; it does not describe a branch. That is why the dash draft is generated from a *range* (`DraftTarget::Dash`) while the session draft is generated from a *file set*.
- **Agency.** On main you do the work and you land it. On a dash the skill does the work in-thread on a worktree you are not looking at, commits per round on your behalf, and stops — and the card shows none of it while it happens.

The questions that follow, none of which a landing dialog answers:

1. **Where does a dash live in the UI?** Today it is invisible: an entry in the snapshot nothing renders. Is a dash a state of the card, a lane in the Changes surface, a chip in Z2, its own card, or a project binding of its own?
2. **What binds a card to a dash?** Does `/tugplug:dash foo` put *this card* into a dash-bound state — changes, diffs, shell, and receipts all reading the worktree — or does the dash stay a thing the conversation talks about while the card keeps reading main?
3. **Is the worktree visible at all?** If the answer to (2) is "the card stays on main," then the user's mental model has to hold two directories at once, which is exactly the confusion [P10] was cutting away from.
4. **What does progress look like while a dash runs?** `implement` writes rounds; the card shows tool blocks. There is no dash-scoped progress surface, and the rounds are the natural one.
5. **When and by whom is the join draft authored?** The skill writes it at the end of a run; the draft engine can also generate it live from the range. Both write the same `dash:<name>` row. Which is the default, and does the surface regenerate or respect?
6. **What are the four join outcomes' surfaces?** Clean, conflicted, blocked (wrong branch / intersecting base dirt / inside the worktree), and empty-dash-should-release are four different presentations, and only one of them is "sign here."
7. **Where does release live now?** [P14] ruled it shade-only with a discard preflight; the shade it referred to is now a passive read-only glance with no verbs. That ruling needs a new home or a new ruling.
8. **Multiple dashes.** One at a time is the common case the bare `/join` form optimizes for, but discovery, naming, and switching have no surface.

## What I'd want decided before writing a plan

Whether the card **binds** to a dash (question 2) is the load-bearing decision — every other question resolves differently on each side of it, and it is the difference between "join is a gesture" and "dashes are a place." A landing surface designed before that answer will be rebuilt after it.

If the answer turns out to be "just give me the landing gesture for now," the smallest honest version is join mode as the twin of commit mode: a join slice on `changeset-verb-store`, a `join-mode-controller` mirroring `commit-mode-controller`'s snapshot and gate, the dash lane in `SessionChangesView`, the conflict lane wired to the resolve overlay that already exists, and a join receipt variant. That is a few days of work over finished server machinery — and it is worth knowing that it stays a few days of work whenever it happens, so there is no cost to thinking first.

## Files worth reading first

- `dash/archive/changes-commit-dash-consolidation.md` — the lifecycle doctrine, [P05] `/join`, [P08] gates, [P14] release
- `dash/archive/commit-inline-dialog.md` — [P10] the deferral, and the current-state map of the surfaces it rebuilt
- `tugdeck/src/lib/commit-mode-controller.ts` — the surface any join lane should be modeled on
- `tugdeck/src/lib/changes-route-controller.ts` — where `snapshot.dashes` already arrives
- `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` — `do_changeset_join`, `do_changeset_join_resolve`, `do_changeset_release`
- `tugrust/crates/tugdash-core/src/ops.rs` — `join_in`'s preflight, which defines every blocked state a surface must present
- `tugplug/skills/join/SKILL.md` — what the lane does today
