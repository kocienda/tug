<!-- tug-brief: cdefa379 -->
# Send a mid-turn message at once

**Purpose:** A message the user sends while a turn is running reaches claude one step late, and when that step was the turn's last, claude runs it as a turn the Session card never draws. The user sees their message ignored.

---

## Purpose {#purpose}

A usability report from Tito, who says it happens almost every time he tries:

> - I type /commit-and-merge and hit return, Tug goes to work
>
> Immediately I remember "Oh, and push!"
>
> - I type "push" and the prompt goes on standby while /commit-and-merge is running...
>
> What I see: commit and merge succeeds and the push prompt is ignored.

His screenshot shows one turn: the `/commit-and-merge` prompt, two Bash calls, a user row reading "push" (`#u2.2`, sent four seconds into the turn), and a closing reply that ends "Nothing was pushed." Nothing follows it.

What is wanted: a message sent while Tug is working is acted on, in view, as soon as the model can read it.

---

## Evidence {#evidence}

The probes below ran on 2026-11-27 against claude 2.1.325. Their scripts and the recorded frames are in `/tmp/steer-probe`, which does not survive a restart; the readings that matter are copied here.

**[F01] The deck holds a mid-turn submit and forwards it only when a tool result arrives.** `handleSend` in `tugdeck/src/lib/code-session-store/reducer.ts` enqueues a send made in any phase but `idle` or `errored` onto `queuedSends` and emits no frame. `handleToolResult` (the "steering pickup") forwards the head of that queue on a live `tool_result`, removes it from the queue, and appends it as a `user_message` to the running turn's messages. A queue that no tool result drained is flushed at `turn_complete`. **(verified, read from the code)**

**[F02] That forward is one boundary late.** claude takes in waiting messages the instant a tool returns. A message forwarded on *seeing* that tool's result arrives after claude has already begun its next model request, so it waits for the next boundary. **(verified by [F03] and [F04] together)**

**[F03] A message sent while a tool is running is merged into the running turn.** Raw claude over stream-json, second message written when the `tool_use` for `sleep 4` appeared:

```text
 1.7s assistant tool_use: sleep 4      <== second message written
 1.7s command_lifecycle queued 12d20da8
 5.8s user tool_result
 5.8s command_lifecycle started 12d20da8
 7.2s assistant tool_use: echo pushed
 8.0s command_lifecycle completed 12d20da8
 8.0s result                            (one result)
```

**(verified)**

**[F04] A message sent after the last tool result runs as a turn of its own.** Same harness, second message written on seeing the `tool_result` of the turn's only tool call:

```text
 1.5s user tool_result                 <== second message written
 1.5s command_lifecycle queued ee93a17f
 2.1s result 'Committed.'
 2.1s command_lifecycle started ee93a17f
 3.2s assistant tool_use: echo pushed
 3.8s result 'Pushed.'                  (a second result)
```

claude does not lose the message. `started` arriving before the turn's `result` means merged; after it, a follow-on turn. **(verified)**

**[F05] tugcode emits the follow-on turn in full, with no opener.** The real tugcode over the real claude, second `user_message` written on seeing the first `tool_result` frame, as the deck writes it today. After the first `turn_complete`, tugcode emitted `prompt_anchor` carrying the second message's submission id as `promptUuid`, then `content_block_start`, `tool_use`, `tool_result`, `assistant_text` and a second `turn_complete`. It emitted no `add_user_message` or any other frame announcing the turn's opening message. **(verified)**

**[F06] The deck drops every frame of that follow-on turn, without a warning.** The frames recorded in [F05] were replayed through `reduce`, with a `send` of "push" dispatched just before the first `tool_result`:

```text
USER SENDS 'push' mid-turn: phase tool_work, queued=1
   => deck forwards user_message "push"
wire tool_result:   phase tool_work -> streaming, queued=0
   => COMMITTED turn: user("go"), tool_use(Bash), user("push"), assistant_text(...)
wire turn_complete: phase streaming -> idle, pendingTurn=null
wire prompt_anchor: phase idle -> idle, pendingTurn=null
wire tool_result:   phase idle -> idle, pendingTurn=null
wire turn_complete: phase idle -> idle, pendingTurn=null
FINAL: phase=idle, committed turns=1
```

The committed turn is Tito's screenshot. The second turn's tool call and reply are never drawn, and the dev log receives nothing. **(verified)** Not exercised: tugcast, which carries the frames between tugcode and the deck.

**[F07] In Tito's session claude most likely did act on "push", out of sight.** This is inference from [F04]–[F06] and the screenshot's shape (the "push" row sits after the last Bash call, which is where the pickup places it). It would be confirmed by the remote holding his commit, or by a reload of that session showing a turn the live card did not.

**[F08] A wake turn merges a message the same way.** Raw claude, second message written during a foreground tool call of a turn that a background job's notification had started: `queued` at once, `started` right after that tool's result, acted on inside the wake turn, one `result`. The deck's pickup is gated on `!isWaking`, so today a message sent during a wake turn waits for the whole turn. **(verified)**

**[F09] claude reports each message's progress, and tugcode discards the report.** `command_lifecycle` frames (`queued`, `started`, `completed`, `cancelled`, `discarded`, `refused`, keyed on the uuid the inbound message carried, which is Tug's submission id) reach `tugcode/src/event-mapping.ts` and are swallowed there. **(verified, read from the code and seen on the wire in [F03], [F04], [F08])**

**[F10] claude can withdraw a queued message by uuid.** claude 2.1.325 accepts a `cancel_async_message` control request, and its own schema text says the answer carries `cancelled: true` or `false`. Tug does not send it. The request's presence and description were read from the binary's strings; **it was not exercised**. A probe that sends one for a waiting message and one for a message already taken in would confirm both answers.

**[F11] tugcode pairs a follow-on turn with its message by FIFO order, and says the pairing can be wrong.** `pendingTurnInputs` in `tugcode/src/session.ts` is claimed head-first by `openTurnFromPending`. Its own comment records that a message claude merged leaves a stale entry there, which mislabels a later turn, because tugcode "cannot distinguish merge from buffer at submit time (claude emits no signal for it)". [F09] is that signal. **(verified, read from the code)**

---

## Decisions {#decisions}

**[B01] A mid-turn submit goes on the wire at Return, and claude's queue is the queue.** By [F02]–[F04], sending at once is what lets claude merge the message at the boundary the user was aiming at; Tito's "push", typed during the `git commit`, would have merged when it returned. The deck stops holding a message for a live turn. This rules out keeping the tool-result pickup as the forwarding point.

**[B02] tugcode forwards `command_lifecycle` to the deck, keyed on the submission id.** It is the only live statement of where a message landed ([F04]), and the only thing that lets the deck stop guessing. It also answers the question the steering spike left open, whether the wire surfaces a merge live.

**[B03] One behaviour, drawn one way.** Whether claude merged the message into the running turn or ran it as a turn of its own, the row seats at the point claude took it in and the work it caused continues directly under it, as one exchange: the `#u2.2` / `#a2.2` shape the card already draws for a merged message. A follow-on gets no new turn header and no second opening block. The split between the two is claude's bookkeeping and the user is not asked to read it. The one trace of a follow-on is that the summary above the row was written before the message was read.

**[B04] A turn the deck did not open itself is never dropped in silence.** tugcode opens a follow-on turn by the uuid `started` names rather than by FIFO order ([F11]) and says so to the deck, and the deck opens a turn for it. [F06] is a defect in its own right: commands ran and the transcript said nothing. Whatever else changes, frames for a live turn arriving at an idle card are drawn.

**[B05] A wake turn takes the same rule.** By [F08] claude treats it identically. A message sent during a wake turn goes at once and seats in that turn when claude takes it in. A reload already has to draw a user row inside a wake turn, since that is where claude's own transcript puts it.

**[B06] A waiting message stays retractable, through claude.** The deck's hold existed so a message could be taken back. The waiting row's remove button, and Stop's order of popping waiting messages before it interrupts the turn, send `cancel_async_message` for the message's uuid. An answer of not cancelled means claude had already taken it in, and the row stays. This rests on [F10], which is the one finding here not yet exercised.

**[B07] The waiting row says one word and predicts nothing.** While claude holds the message and has not taken it in, the row reads `Waiting` and carries its remove button. It does not say which landing it is heading for: that is certain only while a tool is running, and while the model is writing it depends on whether the reply calls another tool, so a label would be right in one phase and a guess in the other. When claude takes the message in, the row loses `Waiting` and stays where it is.

**[B08] The other holds are unchanged.** A submission the network cannot carry, a store being handed over to a moved card, a card in catch-up, and replay still keep the message in the deck. A message the network cannot carry keeps its own wording, since it has not reached claude at all.

---

## Non-goals {#non-goals}

- **Pulling the running prompt back and re-submitting it with the addition, on a time window.** Considered and rejected. Tito's turn had already run a command by the time he typed, and a commit cannot be taken back. Restricted to the moments before anything has run, it buys almost nothing: under [B01] a message typed that early already reaches the model at its first step, and a stop-and-restart adds a cancelled turn. Stop already pulls a prompt back into the composer for the user who wants that.
- **Interrupting the turn so the model reads the message sooner.** A model reads new input only between steps. Getting in earlier means stopping work already under way, which is the wrong trade for a commit, and it is what Stop is for.
- **Relying on claude's own rapid-follow-up preemption.** claude 2.1.325 carries a declaration by which it stops a turn that has shown nothing yet in favour of a follow-up. Its schema text marks it internal and behind a rollout flag, so nothing here depends on it.
- **A label that predicts the landing.** See [B07].

---

## Exit {#exit}

**An arc.** Its raw material, in the order the pieces depend on each other:

- Keep the evidence. The frames recorded for [F05] become a fixture, and the first test is a failing one in the deck: two turns arrive, one is drawn ([F06]).
- Exercise `cancel_async_message` against a live claude, for a waiting message and for one already taken in, and record both answers ([F10]). [B06] is built on what that shows.
- tugcode: forward `command_lifecycle`; open a follow-on turn by uuid and announce its opener; retire the FIFO pairing.
- Deck: send at Return for a live turn, wake turns included; hold the row as `Waiting` until `started`; seat it where it was taken in; draw a follow-on as a continuation; withdraw through claude.
- The steering tests in `reducer.steering.test.ts` assert the pickup-at-tool-result mechanism this replaces. Their guarantees move with it and are restated, not dropped: a message is forwarded exactly once, a retracted message sends nothing the model acts on, and several messages land in the order they were sent.
- A verdict run through the real app with a real claude: the report's own gesture, a second message typed during the last command of a turn.
