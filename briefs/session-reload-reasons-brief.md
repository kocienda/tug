# A Session card reloads only when it must

**Purpose:** A Session card's transcript is rebuilt from disk as a side effect of building its stores, so any path that builds them reloads the card. The user wants a reload to be an act with a reason, and the reasons to be a closed set: the app launched, a card opened on a previous session, the server restarted. Nothing else.

---

## Purpose {#purpose}

After the `cards-and-sessions-footing` arc joined (`a76fea5d9`), the user read its account of what had been replaying Session cards and said: "I am deeply concerned about this work, and the seemingly willy-nilly fashion that the code would reload session cards. THIS MUST NOT HAPPEN SO CASUALLY... EVER. Reloading a session card should only take place when it *absolutely must*, as in when the app relaunches or a session card that restores a previous session is opened."

That arc removed the one casual trigger it found (a body page driving every binding it mirrored) and made a reload that lands on a live turn survivable. It did not change the rule that produced the trigger: in the deck, constructing a card's services *is* asking for its transcript. This brief is about changing that rule, and about the one remaining reload the rule hides — a wire reconnect, which rebuilds every card on the page whether or not the server behind it restarted.

---

## Evidence {#evidence}

**[F01] There is exactly one sender, and it is store construction.** Every replay a card asks for is `sendRequestReplay` at `tugdeck/src/lib/card-services-store.ts:852`, inside `_construct`, called unconditionally after the stores are built. tugcast never originates a replay: `do_request_replay` (`tugrust/crates/tugcast/src/feeds/agent_supervisor/control/session.rs:785`) has one caller, the deck's `request_replay` control frame. tugcode's `runReplay` is request-driven only (`tugcode/src/main.ts:469`, `tugcode/src/session.ts:1715`). So "when does a card reload" is exactly "when does `_construct` run for it." **(verified, code)**

**[F02] `_construct` runs on four paths today.** From `_reconcile` (`card-services-store.ts:358`): (a) a card gets a binding it had none for — app launch, a card restored from the ledger, a fresh spawn's ack; (b) a card's binding flips to a different `tugSessionId` — `/clear`, `/resume` to another session, a `/cd` directory change — via the rebuild branch at `:383` and `_beginHeldSwap`. (c) A seat rotation rewrites the binding with a new `seatedSessionId` and the same `tugSessionId` (`tugdeck/src/lib/session-control-actions.ts:257`), which the rebuild branch does not match, so a rotation does **not** reload. (d) Until `a76fea5d9`, a body page constructing for every binding it mirrored; closed by `_servesCard` (`:342`). **(verified, code)**

**[F03] A wire reconnect reloads every Session card the page holds, in full.** The shell (`tugdeck/src/main.tsx:835`) and every body page (`tugdeck/src/body/body-main.ts:658`) subscribe to `connectionDidReconnect` and run `cardSessionBindingStore.clearAll()` then `restoreSessions(…, { reason: "reconnect" })`. `clearAll` empties the bindings, `_reconcile` disposes every card's services with them, and the transcript each store held goes too. `restoreSessions` (`tugdeck/src/lib/session-restore.ts:717`) sends `spawn_session(mode=resume)` for every bound card in the active workspace; each ack writes a binding, `_reconcile` finds a card with no services, and `_construct` sends `request_replay`. The store's own reconnect handler (`transport_open` → `restoring`, `tugdeck/src/lib/code-session-store.ts:565`) never settles anything: the store it would settle has been disposed by then, and `notifyTransportSettled` (`session-restore.ts:579`) lands on the freshly built one. **(verified, code)**

**[F04] The deck cannot tell a server restart from a dropped socket, so it treats every reconnect as a restart.** The comment at `main.tsx:825` gives the reason for the clear-and-restore: after a tugcast restart, bindings held against the dead server would route frames the new server never sends. That is right for a restart. But nothing on the wire identifies the server: no boot id, no epoch, nothing in the connect handshake or `list_card_bindings_ok` the deck could compare across reconnects. [F02] of `briefs/cards-and-sessions-footing-brief.md` is this case: a WebSocket reset at 15:49:06 with tugcast still running, and the body reloaded cold at 15:49:16. **(verified, code and that brief's log)**

**[F05] The replay shadow is a seatbelt, not a prevention.** `replayShadowActive` in `tugdeck/src/lib/code-session-store/reducer.ts` keeps a live turn through a bracket that lands on it and takes from tugcode's in-flight snapshot what the window suppressed. It does nothing to stop the bracket being asked for. The server has no guard either: deduping replays in tugcast or tugcode was a stated non-goal of the prior brief, so a second requester is served. **(verified, code)**

**[F06] A reconnect that kept its stores would have a gap to close, and the size of that gap is not established.** While the socket is down tugcode keeps running the turn. tugcast's CODE_OUTPUT broadcast feeds a router-level replay ring, but the comment at `tugcode/src/session.ts:3100` says that ring backfills only on lag overflow, never on a new subscription — so a reconnecting client would not receive the frames it missed from the ring. tugcode can already describe a turn's present state from `ActiveTurn` (`emitInflightTurnFromActiveTurn`), but only inside a replay bracket. **(inference from comments; what would confirm it is reading `tugrust/crates/tugcast/src/router.rs`'s subscription path, and a harness run that drops the socket mid-turn with tugcast up and reads what the card then shows)**

**[F07] A reload is logged, but without its reason.** `sendRequestReplay` logs `request_replay.dispatch` with the session id (`tugdeck/src/lib/session-lifecycle.ts:256`) and tugcast logs `request_replay.dispatched`. Neither says why. The 2026-10-16 diagnosis had to infer the trigger from timing against composer clicks. **(verified, code and log)**

---

## Decisions {#decisions}

**[B01] The reasons a Session card may reload are a closed set of three.** *Launch*: the app started and the card restores from the ledger. *Restore-open*: a card is opened, or a parked workspace activated, onto a session that already exists — the user's "a session card that restores a previous session is opened". *Server restart*: the deck reconnects to a tugcast that is not the one it was talking to. A reload with any other reason is a defect, and a unit test over `cardServicesStore` enumerates the set so adding a fourth is a test change somebody has to make on purpose. `/clear`, `/resume` to another session and `/cd` are not reloads of a card: the card shows a different session afterwards, and building that session is its restore-open.

**[B02] Building a card's stores and asking for its transcript become two acts.** `_construct` builds the services bag and sends nothing. The transcript is requested by a named call that carries one of [B01]'s reasons, made at the site that has the reason: the restore pass for launch and restore-open, the reconnect handler for server restart, the rebind paths for `/clear`, `/resume` and `/cd`. Any other path that constructs services gets stores and no `request_replay`. This is what makes [B01] enforceable: today a new caller of `_construct` is a reload by default, and the only way to find it is in the log after the fact.

**[B03] A reconnect to the same server re-binds without rebuilding.** When the deck reconnects and the server is the one it left, nothing clears the bindings and no store is disposed. The page re-asserts its cards (`list_card_bindings`, `page_bind` for a spare) and each existing store is settled by the re-ack through the `restoring` → `online` path that already exists and is never reached today ([F03]). The clear-and-restore stays as the server-restart path, with that as its recorded reason.

**[B04] tugcast identifies itself on the wire, and the deck compares.** tugcast mints one id per process start and sends it where the deck first hears from it after a connect, so the deck holds the id of the server it is bound to and compares on every reconnect: same id, [B03]; different id, server restart. The id is a fact about the process, not about any session, so it rides a connection-level frame rather than a session one. Which frame is an open question below; the decision is that there is one and that the deck keys on it.

**[B05] The gap a same-server reconnect leaves is closed by asking tugcode for the present, not the past.** After [B03], a card whose turn ran on while the socket was down asks tugcode for the in-flight state of that turn — the same snapshot `emitInflightTurnFromActiveTurn` already composes — and nothing else. Not the JSONL: the card already holds every committed turn, and re-reading a 15 MB file to recover a few seconds of streaming is the reload this brief exists to end. Whether the snapshot alone is sufficient, or whether tugcast's ring must also backfill on a new subscription, is the open question below; the lean is the snapshot, because it is one frame sequence tugcode already knows how to produce and it describes the turn as it now stands rather than replaying its history.

**[B06] Every reload says why.** `request_replay.dispatch` and tugcast's `request_replay.dispatched` carry the reason from [B01]. The user can then grep `tugcast.log` for a reload whose reason is not one of the three, and a reproduction can assert on it.

**[B07] The shadow stays.** [B01] through [B05] are prevention; the shadow and its test (`code-session-store.replay-shadow.test.ts`) remain as the guard for a collision that should no longer be reachable, and prove the card survives one if it ever is.

---

## Open Questions {#open-questions}

- **Where the server id rides.** The first frame the deck waits on after a connect is the natural carrier, so the comparison can happen before the reconnect handler decides anything. Settled by reading the connect handshake in `tugdeck/src/connection.ts` and tugcast's router for the first frame a client receives; the arc decides, and the test for [B04] pins it.
- **Whether the in-flight snapshot closes the gap alone** ([F06], [B05]). What settles it: read `router.rs`'s subscription path to confirm the ring does not backfill a reconnecting client, then a harness reproduction — tugcast up, a stub session mid-turn, drop the socket, reconnect, and read what the card shows against what tugcode sent in the gap. If frames the snapshot cannot describe are lost (a tool approval that arrived in the gap, a `turn_complete`), the ring backfills on subscribe for that client as well. The reproduction is the verdict either way.

---

## Non-goals {#non-goals}

- **Deduping replays in tugcast or tugcode.** Carried from `briefs/cards-and-sessions-footing-brief.md`: fewer requesters is the fix, and a server-side dedupe would hide the next page that over-requests. [B01] and [B02] make the requesters few by construction.
- **Removing the replay shadow.** It is the seatbelt ([F05], [B07]); this work is the brakes.
- **Changing what `/clear`, `/resume` and `/cd` do.** Each shows a different session afterwards; its construction is a restore-open ([B01]).
- **Replaying on a seat rotation.** It does not reload today ([F02]) and must not start to.
- **The app-test corpus cut.** Still tabled behind this, as the prior brief's [B01] tabled it behind that one.

---

## Exit {#exit}

**An arc.** The first steps, in order: write the test that enumerates [B01]'s closed set over `cardServicesStore`, red, and split construction from the transcript request so it goes green ([B02]) — this lands first because every later step is a caller of the named act. Then put the server id on the wire and the comparison in the deck ([B04]), and on a same-server reconnect keep the stores and settle them through `restoring` ([B03]); settle [F06] by the reproduction before deciding whether the snapshot alone closes the gap ([B05]). Carry the reason into both logs ([B06]) in whichever step first has one to carry. Verification runs with bodies on, since every finding here was made with bodies on, and the reconnect reproduction is a harness test, never the user's live app.
