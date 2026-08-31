# The Wheel

*The layer that seats a claude session under a card. What a rotation is, what it may and may not change, when it is allowed to happen, and the three faces it is reachable through.*

Tug mediates every claude session through tugcast and tugcode, and that mediation buys a capability a terminal claude cannot have: tugcast can retire the session seated under a card and seat a fresh one — on a chosen model, at a chosen reasoning effort, opening on a chosen prompt — while the card, its transcript, its callsign, and its durable ink all stay exactly where they were.

That act is a **rotation**, and the wheel is the layer that performs it. It lives at `tugrust/crates/tugcast/src/wheel/`.

## Why it is called that

A wheel does not choose the destination and does not decide when to sail. It turns the vessel to whatever heading it is given, and it is the only thing that can. That is exactly the split this layer holds: something else decides *which* stage runs — the dash arc reads its own record and its own facts and returns a decision — and the wheel performs the seating. The two halves have different reasons to change, and keeping them apart is what lets a second client exist at all.

The deck says the same thing on the card: a turn opened by a rotation carries `TurnOrigin` `"wheel"`, and the transcript labels that row **Wheel** with its own icon. A rotation's opening prompt is nobody's typing, and the row says so.

## Three verbs, and no others

The wheel **seats** a session, **rotates** a card from one session to the next, and **holds the lineage** that makes the two read as one scroll. Everything else belongs to somebody else: deciding what runs next is a client's, recording what happened is a client's, and the transcript's rendering is the deck's.

## The three kinds of carried thing

A rotation is defined as much by what it cannot change as by what it carries. `RotationRequest` writes that down in the compiler rather than in a comment: its constructor takes the session that rotates, the prompt, and the stage label, and there is no field for anything in the first list below.

**Invariants — a rotation cannot address these, so nothing can parameterize them away.**

- The card. A rotation seats a session *under* a card; it never moves one.
- The tug session id. `session` names which card rotates, never what it rotates into.
- The transcript and its durable ink. The stage segment joins the card's line (`session_segment{kind:"rotation"}`), so the callsign, the `/rename`, and the ink are the line's and never move ([D167]). The wheel never calls the write that records it and cannot influence it.
- The lineage chain. Written by that same record, with a NULL fork point, which is what distinguishes a rotation from a rewind for every later reader.
- The callsign, and the `/rename` beside it — both the line's, and a rotation is another segment of it.
- The user's own model to return to. That is `LedgerEntry::deck_model`, and only a WebSocket client's own `model_change` ever writes it.

**Parameters — what a caller may name.**

- The model. Absent means the account default, which sends *no* `model_change` frame at all rather than one carrying `"default"`.
- The reasoning effort. Absent leaves the level as it is.
- The opening prompt, and the stage label the transcript's divider renders.
- The course this rotation belongs to (below), and the divider facts a course supplies: the document, the plan, the step range.

**Always dropped.**

- The retiring claude's context. A rotation is a fresh claude session by definition. Carrying context across one is `/compact`'s job, not the wheel's, and a rotation that preserved context would be a different act needing a different name.

## The turn-end rule

**A rotation happens at the end of a turn, and never inside one.**

The reason is not scheduling politeness. A rotation retires the claude session seated under the card, and the caller asking for one is a model *running inside that session* — so performing the rotation on receipt would kill the model mid-sentence, in the middle of the turn that asked for it. The request is recorded and the verb returns; the card rotates seconds later, when the turn ends.

The edge it waits for is the idle transition tugcast already computes once, in the supervisor's dispatcher, and fans to sibling channels — base-motion's, the arc runner's, and the wheel's. Three channels rather than three subscribers because an mpsc has one consumer.

**There is no perform-at-request-time path, and adding one would be a bug.** It is tempting: if the session reads idle, why wait? Because `turn_active` is written true in exactly one place — the dispatcher's `user_message` intercept — so a turn tugcast did not itself open reads *idle while claude is working*. Parking under a wrong reading costs one turn; performing under a wrong reading kills a working session. The asymmetry is the whole argument.

A caller who is genuinely not in a turn is asking about the next one, and the receipt says so. Nothing is lost — a request is a promise about a turn's end, and there is always a next turn.

## Courses, and how a card is handed back

A **course** is what drives a series of rotations. Today they are all dash courses, whose course name is the dash, which reaches tugcode as the stage object's `arc` field and the child process's `TUG_DASH_ARC`.

**A dash course comes in two progressions, and the documents decide which.** Both open on a brief. A dash whose ledger is a devised `plan.md` runs devise → review → implement → audit; a dash whose ledger is a `tasks.md` — the task list the `/dash` door wrote — runs implement → audit, because the door already answered what those two stages ask. The runner reads this off the disk in `start_action`: a document that lints as a plan opens at review, a task list opens at implement, and a brief alone opens at devise. There is no recorded course kind and no flag: **`plan.md` outranks `tasks.md`**, and a dash that grows a plan is a plan-course dash from that moment, which is also the whole of the escape hatch when a task list turns out to want settling.

**A client may name the model for the stage it asks for.** That is not switching the user's model, and the older guardrail saying never to is retired by this layer: a rotation names the model for *its* stage, and the card returns to the user's own when the stage is over. What the hand-back guarantees is what makes the naming safe.

A course ends by handing the card back — one `model_change` frame carrying `deck_model`, so the card the user resumes typing into is on the user's own model. Without it a rotation's model change is permanent: tugcode records the selector on its manager and every later spawn reuses it, including through the user's own `/new`.

**A rotation with no course is a one-stage course, and ends the same way.** It names a model, so it changed one, and no course's ending will ever restore it. The wheel arms a hand-back at the moment it performs such a rotation and fires it on that session's next turn-end tick. One turn is the right window because one turn is what the client asks for: a hand-off of a single review turn ends when that review's turn ends. A rotation naming no model arms nothing — it changed nothing, so there is nothing to restore.

**One course per card.** A rotation requested for a card already running a live course is refused by name — `arc running` — rather than queued. Two schedulers driving one card can interleave, and refusing is the one behavior that cannot. A second rotation request on a card that already has one *pending* replaces it, which is the natural reading of a caller changing its mind mid-turn, and the receipt says it replaced one.

**A pending rotation does not survive a tugcast restart, and should not.** It is a promise about the end of a turn that is in flight right now; a restart ends that turn by killing the claude running it, so a request that survived would fire into a session that never finished the work it was scheduled behind.

**A pending rotation is withdrawable.** `--cancel` clears it and says whether there was one; cancelling with nothing pending is a state, not an error. Withdrawing leaves nothing behind, which is the correct amount of ceremony for a promise about the next few seconds — unlike a course's stop, which is a durable record with a resume path because a course is a document-driven schedule.

### One threshold

**A course that seats a stage with more turns to run watches that session's context against one threshold, and has two answers to a context that has crossed it.** `[tugtool.dash].implement_compact_tokens` is a project declaration in tokens, `300000` when nothing is declared. Above it the seated session is sent a `/compact` — it keeps its session, its lineage, and its stage label, and only its context comes down. A context the compaction could not bring back under the line gets the second and last answer: the stage rotates to a fresh session. The cheaper act always gets the first crossing, and a compaction the session never performed — an API error, a user's cancel — is never remembered as one, so the next boundary compacts again rather than falling through to the rotation.

**The threshold is a number of tokens, never a share of the model's window.** What makes a stage work badly is a long context, and long is a token count. The share that count happens to be of whatever model the stage was seated on is a different quantity, and on a very large window it is not even close to the same judgement: read as a fraction, one number would mean 120,000 tokens on one model and 600,000 on another. One setting, one unit, one meaning wherever the stage runs.

**Like a rotation, a compaction happens at a turn end and never inside one.** The turn-end rule above is the whole reason: a prompt sent into an open turn would queue behind a model still working, and there would be no idle edge to read the result against. Under a course, the implement stage therefore closes one step per turn and ends it, so every step boundary is a turn boundary the course can act on — a rule of the stage's ask and its skill rather than of the wheel, because only a model can end a turn.

**The wheel gains no verb here, and "Three verbs, and no others" stands exactly as written.** Sending a prompt to a seated session is a *client's* act, taken at the edge the wheel already computes: it lives in the arc runner and reaches the session through the supervisor's dispatcher, never through `rotate`. Naming a fourth verb would contradict the sentence under that heading — deciding what runs next is a client's — which is precisely the boundary that keeps a course's policy out of the wheel. And it is the same division "Always dropped" above already draws: carrying context across a rotation is `/compact`'s job, so a course that wants the context kept asks for a compaction rather than a rotation.

## A course hands over a part, not a title

A stage opens on a prompt, and every character of that prompt is composed from documents. Four clauses, each omitted when its fact is absent:

1. **The ask** — the slash command the stage's skill answers to, naming the document it is about.
2. **Where to start** — the repo-relative paths the document's own findings cite, extracted mechanically from its backticked tokens and kept only where they resolve to a file that exists.
3. **What moved** — what git says has changed in those paths since the document was last written.
4. **Where the course is** — for a course that stopped and is resuming, which stage it stopped in and why.

Nothing here is a sentence a model wrote about the work. A summary would be a claim nobody could check, and it would drift from the documents the moment they changed. A document citing nothing, in a repo git has never seen, produces exactly the bare ask — which is what makes the composition a safe replacement for one.

## What survives a relaunch

A rotation's transcript is an invariant, and an invariant that only held while the process lived would not be one. So what a rotation seated a session as is written on the session's own row — `stage_label` and `stage_model` in `sessions.db`, beside the fork edge, from the same announcement and at the same moment.

The restore reads the row. It consults a course's record only for the two facts that are genuinely the course's — the arc name and the document it opened on — and only where a course seated that entry. That is why a card rotated with nothing driving it replays as one scroll: there is no arc record to consult, and none is needed.

## The wheel keeps its own record of what it said

Claude's JSONL is claude's. It records a prompt the wheel sent exactly as it records one the user typed, and Tug cannot stamp authorship into it. So on the reload the row that read **Wheel** while the session was live would come back reading **You** — the transcript changing its mind about who was steering, purely because the app was relaunched.

The wheel therefore writes down what it puts on the wire. Every prompt it sends — a rotation's opener through `wheel::rotate`, an arc's later prompts through the dash arc runner — is appended to `wheel_prompts` in `sessions.db`, filed against the **line** rather than the session id, because an arc rotates a card through several session ids and the prompts are all one line's work. Nothing deletes a row on acknowledgement: the `turns` journal beside it is pending-only, but this record answers a question a reload can ask at any time.

The replay reads it back. tugcode loads the line's prompts through its cross-process `sessions.db` handle and hands them to the translator as a ledger; a submission whose sent text the ledger still holds is marked `origin: "wheel"`, and claiming it spends it. Matching is on the text *as it went out* — claude rewrites a slash command into a `<command-*>` envelope before writing the record, so the envelope is put back together, name then args, before the match.

Authorship is therefore **stated by the sender**, never deduced by the reader. The rule this replaced read a prompt's position in the file — the first user turn of a stage session — which could only ever recognize one prompt per session, and could hand the wheel's name to somebody else's words when a recency window moved.

## The three faces

| Face | Where | What it is for |
|---|---|---|
| The op | `POST /api/session`, `op: "rotate" \| "rotate_cancel"` | Loopback only, like every tugcast API. Parks the request; refuses a card already running a course; answers an unknown session as a 404 whose body the CLI's port loop reads as "not this instance". |
| The verb | `tugtool session rotate` | What a model in a turn reaches for. `--prompt` is required; `--stage` defaults to `rotate`; `--cancel` withdraws. Prints a `TUG-ROTATION-RECEIPT:` line naming the stage, the model, when it will happen, and whether the card hands back; every refusal exits 1 with its reason on stderr. |
| This document | `tuglaws/wheel.md` | The rules above. |

The verb is spelled `session rotate` because it is the session that rotates, and the route follows the same reasoning rather than riding `/api/dash` — a rotation names no dash, and putting the wheel's parameter set inside a dash-shaped type would spell it in the wrong vocabulary.

**The stage label is the role.** With `--model` omitted, a `--stage` of `devise`, `review`, or `implement` resolves the model the project declared for that stage under `[tugtool.dash]`; any other label means the account default, and `--model` always wins. There is no separate roles table, because a second table mapping roles to models would be the same fact written twice. The resolution happens in the verb rather than the server: the CLI is where the project root is known from cwd.

**The course has no CLI flag yet, and that is deliberate.** `RotationRequest` carries a course and the arc runner fills it, but the verb exposes none. `TUG_DASH_ARC` is read by three skills as "a dash arc is driving you" and by the arc runner as a dash name it will look up — so letting a caller set it to an arbitrary string would make those skills believe an arc runs them and find no record behind the name. Generalizing it is a rename of the environment variable and a widening of what the stage skills read, with its own blast radius. The next course to need one adds the flag together with that widening.

## One word that means something else

- **`stage`.** [dash-lifecycle.md](dash-lifecycle.md) uses *stage* for one of the seven derived words describing a dash. A stage here is a rotation of a session. They are unrelated, and neither name is giving way.

## The ask is visible where it is made

The receipt is the whole of the announcement, and it is enough because the ask happens inside a turn the user is watching, in a tool block they can read. Nothing new is drawn on the card at request time; the card's own artifact is the stage divider the rotation draws when it happens, naming the stage and the model.

A pending-rotation note ahead of that divider would be a new action, a new store field, a new reducer case, and a new effect — four surfaces to render a sentence whose subject arrives seconds later and renders itself.

## See also

- [dash-lifecycle.md](dash-lifecycle.md) — what a dash is, and the other meaning of *stage*.
- [dash-work-doctrine.md](dash-work-doctrine.md) — how an agent works on a dash worktree.
- [ledger-reliability.md](ledger-reliability.md) — `[LR9]` and the shutdown supervisor.
- [turn-lifecycle.md](turn-lifecycle.md) — the turn whose end a rotation waits for.
