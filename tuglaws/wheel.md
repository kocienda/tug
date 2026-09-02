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
- The arc this rotation belongs to (below), and the divider facts an arc supplies: the document, the plan, the step range.

**Always dropped.**

- The retiring claude's context. A rotation is a fresh claude session by definition. Carrying context across one is `/compact`'s job, not the wheel's, and a rotation that preserved context would be a different act needing a different name.

## The turn-end rule

**A rotation happens at the end of a turn, and never inside one.**

The reason is not scheduling politeness. A rotation retires the claude session seated under the card, and the caller asking for one is a model *running inside that session* — so performing the rotation on receipt would kill the model mid-sentence, in the middle of the turn that asked for it. The request is recorded and the verb returns; the card rotates seconds later, when the turn ends.

The edge it waits for is the idle transition tugcast already computes once, in the supervisor's dispatcher, and fans to sibling channels — base-motion's, the arc runner's, and the wheel's. Three channels rather than three subscribers because an mpsc has one consumer.

**There is no perform-at-request-time path, and adding one would be a bug.** It is tempting: if the session reads idle, why wait? Because `turn_active` is written true in exactly one place — the dispatcher's `user_message` intercept — so a turn tugcast did not itself open reads *idle while claude is working*. Parking under a wrong reading costs one turn; performing under a wrong reading kills a working session. The asymmetry is the whole argument.

A caller who is genuinely not in a turn is asking about the next one, and the receipt says so. Nothing is lost — a request is a promise about a turn's end, and there is always a next turn.

## Arcs, and how a card is handed back

An **arc** is what drives a series of rotations. Its name reaches tugcode as the stage object's `arc` field and the child process's `TUG_ARC`.

**An arc comes in two kinds, and the record decides which.** Both open on a brief. A **trek** runs devise → review → implement → audit; a **dash** runs implement → audit, because the `/dash` door's whole economy is skipping the settling those two stages buy. The kind is written into the arc's durable record as an `arc-kind` line when the arc opens, from `tugtool arc run --kind dash|trek`, and `start_action` reads it — the documents no longer answer this, because on a dash's opening there is nothing on disk to ask: the task list is the implement stage's own first act ([B04]).

`--kind` **defaults to `trek`**, and within a trek the documents still say how far along it the arc already is: a document that lints as a plan opens at review, a brief alone at devise. That default is exactly the derivation every arc had before the kind was recorded, so an existing arc resumes unchanged.

**A pre-kind arc has no `arc-kind` line, and the old document sniff is its fallback** — plan at review, task list at implement, brief at devise, with `plan.md` outranking `tasks.md`. The skew direction is toward *more* settling: a pre-kind arc the door meant as a dash but left with only a brief opens at devise, spending two rotations it did not need rather than skipping a cold read it did.

**A client may name the model for the stage it asks for.** That is not switching the user's model, and the older guardrail saying never to is retired by this layer: a rotation names the model for *its* stage, and the card returns to the user's own when the stage is over. What the hand-back guarantees is what makes the naming safe.

An arc ends by handing the card back — one `model_change` frame carrying `deck_model`, so the card the user resumes typing into is on the user's own model. Without it a rotation's model change is permanent: tugcode records the selector on its manager and every later spawn reuses it, including through the user's own `/new`.

**A rotation with no arc is a one-stage arc, and ends the same way.** It names a model, so it changed one, and no arc's ending will ever restore it. The wheel arms a hand-back at the moment it performs such a rotation and fires it on that session's next turn-end tick. One turn is the right window because one turn is what the client asks for: a hand-off of a single review turn ends when that review's turn ends. A rotation naming no model arms nothing — it changed nothing, so there is nothing to restore.

**One arc per card.** A rotation requested for a card already running a live arc is refused by name — `arc running` — rather than queued. Two schedulers driving one card can interleave, and refusing is the one behavior that cannot. A second rotation request on a card that already has one *pending* replaces it, which is the natural reading of a caller changing its mind mid-turn, and the receipt says it replaced one.

**A pending rotation does not survive a tugcast restart, and should not.** It is a promise about the end of a turn that is in flight right now; a restart ends that turn by killing the claude running it, so a request that survived would fire into a session that never finished the work it was scheduled behind.

**A pending rotation is withdrawable.** `--cancel` clears it and says whether there was one; cancelling with nothing pending is a state, not an error. Withdrawing leaves nothing behind, which is the correct amount of ceremony for a promise about the next few seconds — unlike an arc's stop, which is a durable record with a resume path because an arc is a document-driven schedule.

### One threshold

**An arc that seats a stage with more turns to run watches that session's context against one threshold, and has two answers to a context that has crossed it.** `[tugtool.dash].implement_compact_tokens` is a project declaration in tokens, `300000` when nothing is declared. Above it the seated session is sent a `/compact` — it keeps its session, its lineage, and its stage label, and only its context comes down. A context the compaction could not bring back under the line gets the second and last answer: the stage rotates to a fresh session. The cheaper act always gets the first crossing, and a compaction the session never performed — an API error, a user's cancel — is never remembered as one, so the next boundary compacts again rather than falling through to the rotation.

**The threshold is a number of tokens, never a share of the model's window.** What makes a stage work badly is a long context, and long is a token count. The share that count happens to be of whatever model the stage was seated on is a different quantity, and on a very large window it is not even close to the same judgement: read as a fraction, one number would mean 120,000 tokens on one model and 600,000 on another. One setting, one unit, one meaning wherever the stage runs.

**Like a rotation, a compaction happens at a turn end and never inside one.** The turn-end rule above is the whole reason: a prompt sent into an open turn would queue behind a model still working, and there would be no idle edge to read the result against. Under an arc, the implement stage therefore closes one step per turn and ends it, so every step boundary is a turn boundary the arc can act on — a rule of the stage's ask and its skill rather than of the wheel, because only a model can end a turn.

**That rule is now held up by machinery as well as by words, because words alone did not hold it.** On the wheel machinery's first live run a stage closed step 1 and walked straight into step 2 in the same turn, through the skill's sentence and the wheel's own opening prompt alike — and an unended turn locks the wheel out of *everything*: pacing, the `/compact` above the threshold, the rotation after it, and the `ImplementIdle` clock, which counts turns that end. So the step verbs speak the boundary at the moment they move a row (`arc step done` ends with the sentence naming what the discipline demands next), and the PreToolUse gate refuses the overrun: once an arc stage's turn has closed a step, a repo write or an `arc step start` from that same turn is denied by name. Only a model can end a turn, which is why the gate can only refuse what comes next rather than perform the ending — but refusing what comes next is enough, because there is then nothing else the turn can do.

The one fact the gate cannot compute is which *turn* a close happened in: the hook is a fresh process, and turn boundaries are tugcast's (`LedgerEntry::turn_active`). So the verb reports the close through `POST /api/session {op:"step_closed"}`, the server holds it on the card's entry until the turn ends, and the gate asks through `{op:"turn_facts"}` — the same chokepoint shape the identity resolver uses, and skew-safe on the same terms: an instance that does not know the op leaves the gate denying nothing.

**The wheel gains no verb here, and "Three verbs, and no others" stands exactly as written.** Sending a prompt to a seated session is a *client's* act, taken at the edge the wheel already computes: it lives in the arc runner and reaches the session through the supervisor's dispatcher, never through `rotate`. Naming a fourth verb would contradict the sentence under that heading — deciding what runs next is a client's — which is precisely the boundary that keeps an arc's policy out of the wheel. And it is the same division "Always dropped" above already draws: carrying context across a rotation is `/compact`'s job, so an arc that wants the context kept asks for a compaction rather than a rotation.

## An arc hands over a part, not a title

A stage opens on a prompt, and every character of that prompt is composed from documents. Four clauses, each omitted when its fact is absent:

1. **The ask** — the slash command the stage's skill answers to, naming the document it is about.
2. **Where to start** — the repo-relative paths the document's own findings cite, extracted mechanically from its backticked tokens and kept only where they resolve to a file that exists.
3. **What moved** — what git says has changed in those paths since the document was last written.
4. **Where the arc is** — for an arc that stopped and is resuming, which stage it stopped in and why.

Nothing here is a sentence a model wrote about the work. A summary would be a claim nobody could check, and it would drift from the documents the moment they changed. A document citing nothing, in a repo git has never seen, produces exactly the bare ask — which is what makes the composition a safe replacement for one.

## What survives a relaunch

A rotation's transcript is an invariant, and an invariant that only held while the process lived would not be one. So what a rotation seated a session as is written on the session's own row — `stage_label` and `stage_model` in `sessions.db`, beside the fork edge, from the same announcement and at the same moment.

The restore reads the row. It consults an arc's record only for the two facts that are genuinely the arc's — its name and the document it opened on — and only where an arc seated that entry. That is why a card rotated with nothing driving it replays as one scroll: there is no arc record to consult, and none is needed.

## The wheel keeps its own record of what it said

Claude's JSONL is claude's. It records a prompt the wheel sent exactly as it records one the user typed, and Tug cannot stamp authorship into it. So on the reload the row that read **Wheel** while the session was live would come back reading **You** — the transcript changing its mind about who was steering, purely because the app was relaunched.

The wheel therefore writes down what it puts on the wire. Every prompt it sends — a rotation's opener through `wheel::rotate`, an arc's later prompts through the dash arc runner — is appended to `wheel_prompts` in `sessions.db`, filed against the **line** rather than the session id, because an arc rotates a card through several session ids and the prompts are all one line's work. Nothing deletes a row on acknowledgement: the `turns` journal beside it is pending-only, but this record answers a question a reload can ask at any time.

The replay reads it back. tugcode loads the line's prompts through its cross-process `sessions.db` handle and hands them to the translator as a ledger; a submission whose sent text the ledger still holds is marked `origin: "wheel"`, and claiming it spends it. Matching is on the text *as it went out* — claude rewrites a slash command into a `<command-*>` envelope before writing the record, so the envelope is put back together, name then args, before the match.

Authorship is therefore **stated by the sender**, never deduced by the reader. The rule this replaced read a prompt's position in the file — the first user turn of a stage session — which could only ever recognize one prompt per session, and could hand the wheel's name to somebody else's words when a recency window moved.

## The three faces

| Face | Where | What it is for |
|---|---|---|
| The op | `POST /api/session`, `op: "rotate" \| "rotate_cancel"` | Loopback only, like every tugcast API. Parks the request; refuses a card already running an arc; answers an unknown session as a 404 whose body the CLI's port loop reads as "not this instance". |
| The verb | `tugtool session rotate` | What a model in a turn reaches for. `--prompt` is required; `--stage` defaults to `rotate`; `--cancel` withdraws. Prints a `TUG-ROTATION-RECEIPT:` line naming the stage, the model, when it will happen, and whether the card hands back; every refusal exits 1 with its reason on stderr. |
| This document | `tuglaws/wheel.md` | The rules above. |

The verb is spelled `session rotate` because it is the session that rotates, and the route follows the same reasoning rather than riding `/api/arc` — a rotation names no arc, and putting the wheel's parameter set inside an arc-shaped type would spell it in the wrong vocabulary.

**The stage label is the role.** With `--model` omitted, a `--stage` of `devise`, `review`, or `implement` resolves the model the project declared for that stage under `[tugtool.dash]`; any other label means the account default, and `--model` always wins. There is no separate roles table, because a second table mapping roles to models would be the same fact written twice. The resolution happens in the verb rather than the server: the CLI is where the project root is known from cwd.

**`session rotate` still exposes no arc flag, and that is deliberate.** `RotationRequest` carries an arc name and the arc runner fills it, but the rotation verb exposes none. The name is read by the stage skills as "an arc is driving you" and by the arc runner as a name it will look up — so letting a caller set it to an arbitrary string would make those skills believe an arc runs them and find no record behind the name. The arc's own flag is `tugtool arc run --kind`, which names a *kind* on an arc that exists, not an arc out of nothing.

## One word that means something else

- **`stage`.** [arc-lifecycle.md](arc-lifecycle.md) uses *stage* for one of the seven derived words describing a dash. A stage here is a rotation of a session. They are unrelated, and neither name is giving way.

## The ask is visible where it is made

The receipt is the whole of the announcement, and it is enough because the ask happens inside a turn the user is watching, in a tool block they can read. Nothing new is drawn on the card at request time; the card's own artifact is the stage divider the rotation draws when it happens, naming the stage and the model.

A pending-rotation note ahead of that divider would be a new action, a new store field, a new reducer case, and a new effect — four surfaces to render a sentence whose subject arrives seconds later and renders itself.

## See also

- [arc-lifecycle.md](arc-lifecycle.md) — what a dash is, and the other meaning of *stage*.
- [arc-work-doctrine.md](arc-work-doctrine.md) — how an agent works on a dash worktree.
- [ledger-reliability.md](ledger-reliability.md) — `[LR9]` and the shutdown supervisor.
- [turn-lifecycle.md](turn-lifecycle.md) — the turn whose end a rotation waits for.
