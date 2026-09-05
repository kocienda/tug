# Start and Stop are buttons on the arc

**Status:** sketch, for discussion 2026-09-05. Not yet settled — the calls to
make are under [Questions](#questions).

The ask: start/stop buttons on arcs, visible in the Arcs card and in the Z2
`ARC` popup.

## What is true today

**Stopping is a CLI verb and nothing else.** `tugtool arc stop <name>` posts
`arc_stop` to `POST /api/arc` (`tugrust/crates/tugcast/src/server.rs:815`). The
blocking half (`arc_api.rs:348`) resolves the calling card's live segment,
requires that card to be bound to *this* arc, refuses an arc already done or
already stopped, and names the stage. The async half (`server.rs:668`) runs the
one shared stop path, `stop_arc_for_session`, with reason `stopped by user` and
`HandBack::Send`. The card gets the ordinary receipt: `arc stopped · <arc> · in
<stage> — you stopped it` (`tuglaws/arc-lifecycle.md:89`). **No deck surface sends
it.** The supervisor's CONTROL dispatch (`agent_supervisor.rs:4123–4150`) knows
`bind_arc`, `arc_resume`, `unbind_arc` — not `arc_stop`. The only way a user
stops an arc from the UI today is to cancel the turn (`card taken`) or close the
card (`card closed`).

**Resuming is already a button, in one place.** The stop receipt's
`ArcResumeOffer` (`session-arc-receipt-block.tsx:373`) sends the `arc_resume`
CONTROL frame with `{tug_session_id, project_dir, arc}` — the `bind_arc`
payload, deliberately, because a resume *is* a bind with the stop cleared first.
`arc_api::arc_resume` (`arc_api.rs:240`) appends `arc-resume <stage>` when the
record carries a stop, then binds; an arc with no stop is bound and left alone,
which is what makes a second press a no-op. The rotation is the card's next
idle, never the call. The press is held in `arcResumeStore` until `arc_resume_ok`
or `_err` answers; a refusal speaks through `ArcResumeNoticeController` as a
pane bulletin on the card that asked.

**Starting a fresh arc happens client-side, in the CLI.** `tugtool arc run
<name> [--plan]` runs `open_arc` in the tugtool process (`tugtool/src/arc.rs:1251`):
validate the name, find `brief.md` / `plan.md` / `tasks.md` under
`.tug/arcs/<name>/`, append `arc-start` and `arc-kind` to the arc log — and only
then posts `arc_run`, which on the server is nothing but `bind`
(`server.rs:763–777`). The server has no verb that opens an arc. A deck Start on
a document nobody has run therefore has nothing to call.

**The doors decide the kind.** `/arc` writes a brief and a task list and runs
`arc run` (plain); `/arc-plan` writes a brief and runs `arc run --plan`
(planned). Both skills say the same sentence: *"Never offer the resume by naming
a command. A stopped arc's receipt carries its own Resume button, and a CLI verb
typed into the transcript beside it is the implementation the button exists to
hide."* The doctrine already wants these gestures to be buttons.

**The doctrine already imagines the Stop button.** `arc-lifecycle.md:220`: the
ownership gate sits in the runner's clock paths and not in
`stop_arc_for_session`, because "a user pressing Stop on a card bound to a
foreign-owned arc is making a decision, not a judgment."

**The Arcs card once had buttons on plan rows and took them off.** The
`PlanCell` docblock (`arcs-card.tsx:~755`): a Devise / Review / Implement control
that "composed a `/tugplug:…` line and submitted it into the followed card. It
read as a label rather than as a control, it made a row about the followed card
when the card is about every project, and the gesture it offered is one
sentence to type." Three objections. Two of them are about *that* button: it was
a word, and it typed a prompt. The third — the row is about every project, the
button is about one card — is structural and has to be answered, not waved at.

**Both surfaces have the slot.** `ArcLifecycleBlock` reserves `trailing` for
"the surface's own — a row menu, a fold cue" (`arc-lifecycle-block.tsx`); the
Arcs card fills it with the fold cue today (`arcs-card.tsx:~683`). The Z2 `ARC`
popover ends in a `TugPopupListFooter` whose action cluster holds one
`2xs` ghost button, `Show in Changes`
(`session-card-telemetry-popovers.tsx:~1404`); the footer's convention is
"every action is a 2xs push-button-shaped control" (`tug-popup-list.tsx:~400`).

**The row menu is for rare verbs.** `arc-row-menu.tsx`: Bind, Discard, Replay
moved behind `⋯` / right-click because "a card binds an arc once and discards
one almost never, and the row's whole job in between is to be read." Start and
Stop are the opposite population — the two things a person does *to* a running
arc — which is the argument for standing them on the row rather than filing
them in the menu.

## The rule

> **One transport control per arc, on every surface that shows the arc.** It
> wears ▶ when the arc is not running and ■ when it is. Pressing it performs
> the one verb the arc's state admits — Start, Resume, or Stop — through the
> same server path the CLI takes, and never by composing a prompt. When the
> press cannot land, the control stays and says why.

Icon-only, `xs`, in the eyebrow's trailing slot beside the fold cue, in the
Arcs card; a `2xs` outlined word-button in the Z2 popover's footer. Same
component, two sizes, one state machine.

## The three faces

| Arc state | Face | Verb | Server act |
|---|---|---|---|
| Document with no arc record (a brief or plan nobody has run) | ▶ *Start* | `arc_run` | open the arc (`arc-start`, `arc-kind`) and bind |
| Arc record carrying a stop, not terminal | ▶ *Resume* | `arc_run` | `arc-resume <stage>` and bind — what `arc_resume` does today |
| Arc record live, not done, a card bound | ■ *Stop* | `arc_stop` | `stop_arc_for_session`, reason `stopped by user` |
| Arc done (joined / audited and waiting to land) | — | none | the control is absent; the join register is the row's affordance |

`Start` and `Resume` are one face because the CLI already makes them one verb:
`tugtool arc run` opens or resumes, whichever the record wants. The deck sends
one frame and lets the server read the record, exactly as the CLI does. The
receipt's existing `arc_resume` becomes an alias for `arc_run`, or the receipt
switches to `arc_run` — either way there is one store, one notice, one answer
shape.

## Which card runs it

This is the objection the old plan-row button never answered, and the reason
the control needs a rule rather than a default.

**Stop needs no choice.** The verb requires the calling card to be bound to the
arc, and the row knows its bound sessions (`entry.bound_sessions`). The Arcs
card sends the frame *as* the bound card — the same way the Z2 popover does,
where the card is the card. An unbound live arc has no card to stop from; the
control shows ■ disabled with the reason `no card is running it` ([L31]), and
Discard in the menu remains the way to end it.

**Resume prefers the card that had it.** A stopped arc's binding survives the
stop (`stop_arc_for_session` never touches the binding; `arc_api::unbind` is the
one production act that clears it). If a bound card is still open, Resume seats the arc there — the
receipt's own behaviour. Only an unbound stopped arc falls through to the rule
below.

**Start, and an unbound Resume, take the followed card** — the rule Bind on
this card already uses (`useArcRowVerbsMenu`): the Arcs card follows a Session
card, and its verbs act on it. What makes this different from the rejected
button is that the refusals are legible on the control itself, in the card's
[L31] grammar: `no Session card to run it on`, `<card> is running <other arc>`,
`<card> works another project`. The card is not "about" the followed card; the
*press* is, and the control says which card it means before you press.

In the Z2 popover there is no question at all: the popover exists only for the
arc this card is bound to.

## Wire

Two changes on the server, both small, both making the CLI's acts reachable
from a frame:

1. **`arc_stop` becomes a CONTROL verb** beside `arc_resume`, same
   `parse_bind_arc_payload`, answering `arc_stop_ok` / `arc_stop_err`. The
   async half is `server.rs:668` lifted into a supervisor method the HTTP route
   and the frame both call, so the CLI and the button cannot drift.
2. **`arc_run` learns to open.** `open_arc` moves from the tugtool crate into
   `tugarc_core::ops` and `arc_api::arc_run` calls it when `read_arc` finds no
   record — validate, find the document, `append_arc_start`, `append_arc_kind`,
   then bind. The op grows an optional `kind`. The CLI keeps opening client-side
   first, so it reaches the server with a record already written and the server
   path is a no-op for it; nothing about `tugtool arc run` changes.

On the deck, `arcResumeStore` generalizes to hold a pending press per
`(arc, verb)` and a refusal per session; the receipt, the Arcs card, and the
popover all read it. Refusals on the Z2 popover speak through the card's
existing pane bulletin (`ArcResumeNoticeController`, renamed); on the Arcs card
they land on the card-level surface Bind's refusals already use.

## The kind of a started document

`arc_run` from the CLI is told `--plan` by the door that wrote the document.
A Start button has no door behind it. The kind is read off the documents:

- `tasks.md` present, no `plan.md` → **plain** (this is what `/arc` leaves)
- `brief.md` or `plan.md` present → **planned** (what `/arc-plan` leaves; a plan
  already reviewed derives straight to implement under the existing stage
  derivation, so "planned" costs no extra stage)

A directory with a brief and a task list and no plan is ambiguous. Propose
plain — the task list is the ledger the implement stage walks, and its presence
is the stronger signal — and say so in the record's note.

## Stop while the stage is mid-turn

The CLI passes `HandBack::Send` unconditionally because it is usually typed
from inside the stage's own turn. A button is pressed from *outside* the turn,
at any moment, and most of the time the stage will be mid-turn.

Two readings of "Stop":

- **Halt now.** Cancel the running turn, then stop. The card is back in the
  user's hands the moment they press. A step in flight leaves whatever it had
  written uncommitted in the worktree; that is already the state a `card taken`
  stop leaves, and Resume / Discard / Replay already reason about worktree dirt.
- **Stop at the seam.** Arm the stop (`HandBack::Arm`); the turn finishes, the
  step may close, and the arc stops at the next idle edge. The button is
  "pressed" for up to a whole turn with no visible effect beyond its held state.

Recommendation: **halt now.** A stop control that lets the thing run is the dead
button the arc verbs have paid for twice already. The pressed state resolves in
under a second, the receipt says `you stopped it`, and the worktree's dirt is a
known quantity every other verb already handles. The async half chooses
`hand_back` from the session's live turn state — cancel-and-`Send` when a turn
is running, `Send` when it is not — rather than trusting the caller.

## What the control does not do

- **No join.** The join stays the composer's gesture on Z5 and the shade's
  offer; a done arc shows no transport control at all.
- **No Discard, Bind, Unbind, Replay.** Those stay behind `⋯` / right-click.
- **No typing.** The control never composes a `/tugplug:…` line; the doors
  remain the way a *new* document is written.
- **No second table of state.** The face is derived from `entry.arc`
  (`stopped`, `done`) and `bound_sessions` on the entry the row already renders;
  the pending press is the only local bit.

## Questions {#questions}

1. **Start on document rows at all, or Resume/Stop only?** Start is the one
   face that needs a server-side `open_arc` and a kind rule. Leaving it out
   makes this a two-face control over existing verbs. My read: include it — a
   brief sitting in the Arcs card with no way to run it but the composer is the
   "front half was a file only `ls` could find" the card exists to fix.
2. **Halt now, or stop at the seam?** Recommended above: halt now.
3. **Icon-only on the row, or icon + word?** Icon-only `xs` matches the fold
   cue beside it and answers the "read as a label" objection. The Z2 footer
   takes the word (`Stop` / `Resume` / `Start`) because its cluster is words.
4. **One verb (`arc_run`) for Start and Resume, retiring `arc_resume`?** Or
   keep `arc_resume` as-is and add `arc_run` only for Start. One verb is what the
   CLI already has; two is less churn in the receipt block.
5. **Which sessions' consent does Stop need on a multi-holder arc?** Rare
   (`bound_sessions.length > 1`). Propose: send as the first bound card; the stop
   path stops the arc, not a card.

## Out of scope

- The Changes shade's arc row. It is the join's room; if the control belongs
  there too, that is a follow-on once the two surfaces named here have settled.
- Any change to what a stop *records* or how the wheel judges one
  (`notes/arc-never-stops-brief.md` owns that).
- The stop receipt's own Resume offer, beyond pointing it at the shared store.
