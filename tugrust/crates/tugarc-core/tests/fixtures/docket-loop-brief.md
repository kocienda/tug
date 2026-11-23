# Closing the docket loop: follow-ups, successor arcs, and undoing a landed arc

**Purpose:** When an arc lands, what it learned goes nowhere; when a brief changes under a running arc, there is no answer short of starting over; and a landed arc can only be undone if it was the most recent act. This brief closes those three gaps so that work returns to the docket and continues from it.

This is brief 4 of 4 for the docket design. It depends on `briefs/arc-and-sketch-identity-brief.md`, `briefs/docket-record-and-card-brief.md` and `briefs/docket-authoring-brief.md`.

---

## Purpose {#purpose}

The user wants to "kick off arcs, and then have the results flow back", and said of a brief changing under a running arc: "I don't know! We need to figure this out, but given that an arc is on a worktree, we could park or delete the work without much issue."

Tito asked what the code's state is after Stop: "if the developer doesn't write the code directly and the process stops abruptly per user direction, what is the state of the code at this point?" He also noted that tracked arcs make "restore the code at this point" possible.

---

## Evidence {#evidence}

**[F01] Stop keeps the branch and worktree, and the arc is resumable.** `tugtool arc stop` "keeps its branch and worktree"; `tugtool arc run <name>` resumes. Nothing reaches the base before the join. **(verified from the verb's help)**

**[F02] What Stop does with a half-finished step's uncommitted edits was not read.** The doctrine's yield rule commits a round before ending a turn "so the tree holds only committed bytes", but a user's Stop mid-turn is a different path. **(not verified)**

**[F03] An arc's base is both where it forks from and where it lands.** `tugtool arc create --base <BASE>` is the "branch the arc forks from and lands back onto", and "a base is set at birth". An arc cannot today fork from another arc's branch and land on `main`. **(verified from the verb's help)**

**[F04] Step commits almost never cite a brief decision.** In this checkout's arc log, 39 of 2,448 step commit lines carry a bracketed decision label. **(verified)**

**[F05] Plan steps cite plan decisions, not brief decisions.** The devise skeleton (`tugplug/skills/arc-devise/devise-skeleton.md`) requires a `References:` line on every execution step, citing plan-local `[P##]` labels. A plain arc's `tasks.md` has no citation rule. **(verified)**

**[F06] A join is one squash commit with a `Tug-Arc:` trailer.** 387 commits in this checkout carry the trailer. So the commit a landed arc made is always known. **(verified)**

**[F07] `tugtool arc undo` reverses only the most recent join, replay or discard.** **(verified from the verb's help)**

**[F08] The audit's findings are written as one arc log line.** An `audited` line carries a prose summary; nothing structured records what the audit thought should happen next. **(verified)**

---

## Decisions {#decisions}

**[B01] An arc never changes the brief it opened on.** The audit reads the whole diff against the arc's documents, and a brief that moved mid-run leaves nothing to judge against. A running arc whose brief moved is marked stale and keeps going on the version it has.

**[B02] "Continue with the change" is a successor arc.** A successor is a new arc on the revised brief that starts from the old arc's finished work and lands on the old arc's base. The old arc is stopped at its next step boundary and parked, not discarded. This needs a fork point separate from the landing base ([F03]).

**[B03] A stale running arc does not stop itself.** Its card says the brief moved and offers three gestures: keep going, open a successor, or discard and re-open. The choice is the user's.

**[B04] Steps name the brief decisions they carry.** A plain arc's task names the `[B##]` labels it implements, and a plan decision names the brief decisions it came from, so a plan step reaches them through its `References:` line ([F05]). The arc doctrine and the devise skeleton both gain the rule. The commit message is not the carrier ([F04]).

**[B05] The decision diff only pre-selects the default offer.** With [B04] in place the card can say which finished steps a revision touches: none when decisions were only added (default: keep going, the additions become a follow-up), none when no finished step cites a changed decision (default: successor from the tip), some otherwise (default: successor from the last unaffected step). Where citations are missing, the user picks the boundary.

**[B06] A successor of a planned arc gets a fresh devise round.** It reads the revised brief and the finished steps. It is slower and it is the honest version: the old plan was reviewed against the old brief.

**[B07] Stop leaves whole steps.** After a user's Stop, the arc's worktree holds committed work up to the last step boundary and nothing else. [F02] must be read first; if Stop today leaves uncommitted edits, this decision changes that.

**[B08] Parked arcs are listed on the docket with a discard offer.** Each holds a worktree. Nothing cleans them up automatically.

**[B09] An audit's follow-ups become ideas on the arc's docket.** The audit stage records each as a structured item, not only in its summary line ([F08]), and each arrives in the docket's inbox linked to the arc it came from. An arc on no docket records them and files nothing.

**[B10] Any landed arc can be reverted from the docket.** The gesture makes a revert of that arc's squash commit ([F06]). It is a landing, so it is the user's act, and it is offered for any arc in the record, not only the most recent ([F07]).

**[B11] A landed arc names "the code as of this arc".** The docket shows the commit, as an atom, for each landed arc in order.

---

## Open Questions {#open-questions}

- **How a successor forks.** A new verb or flag that sets the fork point apart from the base; whether the successor's branch carries the old arc's commits as they are or replays them. The join squashes either way.
- **What a revert does when later work depends on the arc.** A conflict stops the revert; whether the docket can say in advance which later arcs touched the same files is open.
- **Opening the code as of an arc.** Showing the sha is settled ([B11]). Checking it out into a worktree for the user to look at is a further gesture, not decided.
- **Who decides what is a follow-up.** The audit can over-produce. Whether its items arrive as ideas directly or as proposals the user accepts is open; the recommendation is proposals.

---

## Non-goals {#non-goals}

- **Feeding a revised brief into the running arc.** Rejected by [B01].
- **Stopping or re-opening an arc automatically when its brief moves.** Rejected by [B03].
- **Reading citations from commit messages.** [F04] shows they are not there.
- **Automatic cleanup of parked arcs.** Rejected by [B08].
- **Rollback as a transaction on the base.** Tito's SQL analogy is already met: an arc never touches the base before the join, and a discard removes the worktree.

---

## Exit {#exit}

**An arc.** Its parts, in order:

1. Read what Stop does today ([F02]) and make it leave whole steps.
2. The citation rule in the task list and the devise skeleton.
3. The stale notice and its three gestures, and the successor arc with its fork point.
4. Follow-ups from the audit into the docket's inbox.
5. Revert, and the landed-arc commit list, on the Docket card.
