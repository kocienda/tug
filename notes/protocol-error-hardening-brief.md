# A rotation never shows the card a protocol error

**Purpose:** At 21:42:36Z on 2026-09-04 the `viney-mule` card flipped to a **Protocol error** banner in the same millisecond the wheel rotated it from the implement stage to the audit stage of `consistent-atoms`. The rotation completed, the audit ran, and the banner stood over a line nothing would ever clear it from. No log on either side of the bridge says which error frame it was. This brief settles how a rotation stops producing the banner, how the banner stops outliving the line it was raised on, and how the next one is a one-grep answer.

---

## Purpose {#purpose}

The user's report:

> There was a protocol error on `@tug/viney-mule`? What was that about?

The honest answer was "the deck received a wire-level `error` frame at the instant of the rotation, and nothing recorded which one." That is two defects, not one. A rotation is the wheel's ordinary act — every arc performs at least two — and it must not raise the one banner the deck reserves for breakage that does not heal itself. And an `error` frame is the bridge's most consequential outbound message, the only one that locks a card body, yet it is the one frame the bridge emits without a line of telemetry beside it.

---

## Evidence {#evidence}

Times are UTC. The tugcast log is `instances/release-main/Logs/tugcast.log.2026-09-04`; the sessions ledger is `instances/release-main/sessions.db` (read through `just db-inspect`); the deck's reducer is `tugdeck/src/lib/code-session-store/reducer.ts`; the bridge is `tugcode/src/session.ts`.

**[F01] The banner is the deck's word for a wire `error` frame.** `session-card.tsx:431` maps `lastError.cause === "wire_error"` to the label "Protocol error"; the reducer's `handleWireError` (`reducer.ts:4326`) sets it on a `type: "error"` event and flips the phase to `errored`. The other four causes — session errored, connection lost, session unknown, session not owned — carry their own labels, so the banner's text identifies the frame family exactly. **(verified)**

**[F02] The flip landed in the rotation's own millisecond.** The ledger's `session_state_changes` for the card's session (`39bb5314…`) reads `idle` at 21:42:31.199 and `errored` (transport `online`) at 21:42:36.482. The log shows the rotation's prompt dispatched at 21:42:36.265 (`wheel.stage_sent stage=audit`), the old claude answering one control request at 36.266, and the fresh claude spawned at 36.482 — `Spawning claude … --session-id c00e48cd…`, then `a segment was announced … kind=rotation stage="audit"` and `session_init.parse` at 36.483. The `errored` row and the spawn share a timestamp to the millisecond. **(verified)**

**[F03] The rotation itself succeeded.** The audit session's transcript (`c00e48cd….jsonl`) opens with the `/tugplug:arc-audit` prompt at 21:42:37.044, 560 ms after the spawn; the arc log carries `arc-stage audit c00e48cd… opus`; the audit stage was working when this was written. Whatever the frame was, it did not cost the arc anything. **(verified)**

**[F04] No server-side errored publish fired.** Every `SESSION_STATE errored` site in tugcast writes a log line beside it — the auth gate, the crash budget, a terminal resume failure, the four spawn rejections, the merger-unavailable path — and none appears between 21:42:30 and 21:43:00. The `errored` row therefore came from a CODE_OUTPUT `error` frame the bridge wrote, which is the only other path into `handleWireError`. **(verified by exclusion)**

**[F05] The bridge emits `error` frames from eleven sites and logs at none of them.** `session.ts` has six (`<local-command-stderr>` echo on replay, twice; post-handshake crash; fresh-init exit; the drain's EOF over an open turn; the send fast-path after EOF), `main.ts` five (inbound parse and dispatch failures), `inbound-dispatch.ts` one (a rejected fire-and-forget handler). A `grep -B3 'type: "error"'` finds no `logSessionLifecycle` or `console.error` adjacent to any of them. The tugcast `tugcode_stderr` capture, which is the only durable record of what the bridge did, therefore cannot say which one fired. **(verified)**

**[F06] The rotation's kill does not close an open turn as a cancel, though the recovery path's kill does.** `forceTerminateAndRespawn` (`session.ts:4071`) sets `activeTurn.interrupted = true` with cause `recovery` *before* `killAndCleanup`, with the comment "close the in-flight turn as a cancel, not an error, when the drain observes the kill's EOF." `newSession` (`session.ts:8508`), the rotation, calls `killAndCleanup` with no such step. The drain's EOF handler (`signalEofToActiveTurn`, `session.ts:7244`) then emits `turn_cancelled` for an interrupted turn and `error "Claude process stream ended unexpectedly"` for any other turn that has not received its `result`. So a rotation that lands while any turn is open on the retiring claude produces the banner by construction. **(verified in code)**

**[F07] Whether a turn was open at this rotation cannot be read back.** The retiring turn's last assistant text is at 21:42:27.9 and the deck went idle at 21:42:31.2, so its `result` had arrived and the bridge clears `activeTurn` on `result` (`session.ts:5988`). The rotation's prompt queues behind the respawn gate (`handleUserMessage`, `session.ts:7332`), so it should not have opened a turn on the old claude either. That leaves the frame unaccounted for — and [F05] is why. The next occurrence is what settles it, and [B01] is what makes the next occurrence legible. **(the reasoning is from code; the frame is unverified)**

**[F08] The banner is sticky on a superseded line.** The reducer clears `lastError` only on `turn_complete(success)` for that line (`reducer.ts:3292`), on a transport recovery for the `transport_closed` cause alone (`reducer.ts:4597`), and on a fresh `handleSend`. A rotation announces a `session_segment kind=rotation`, which the store translates to a `session_stage` divider (`code-session-store.ts:2001`) and nothing else; the banner has no path off a line that the rotation just closed. **(verified)**

**[F09] The error frame carries no provenance.** The wire shape is `{type: "error", message, recoverable}` (`tugcode/src/types.ts:336`). The message is prose meant for a human, `recoverable` is a bit the deck does not act on, and nothing says which of the eleven sites wrote it or which claude process it concerns. **(verified)**

---

## Decisions {#decisions}

**[B01] Every `error` frame the bridge writes is logged beside the write, with its site.** One `logSessionLifecycle("tugcode.error_frame", { site, message, recoverable })` per emit, so the tugcast stderr capture answers "which frame" with one grep. The eleven sites are enumerated in [F05]; a helper `emitErrorFrame(site, message, recoverable)` that both logs and writes is the shape that keeps a twelfth site from forgetting.

**[B02] The frame names its site on the wire.** `ErrorFrame` gains `site: string` (a stable slug — `drain_eof_open_turn`, `send_after_eof`, `local_command_stderr`, `post_handshake_exit`, `fresh_init_exit`, `inbound_parse`, `inbound_dispatch`, …). The deck keeps it on `lastError` and shows it in the banner's detail, the way the crash-budget detail already rides `session_state`. A banner that says "Protocol error" and nothing else is asking the user to read tugcode's source.

**[B03] A rotation closes any open turn on the retiring claude as a cancel, exactly as the recovery kill does.** `newSession` sets `activeTurn.interrupted = true` and `interruptCause ??= "recovery"` before `killAndCleanup`, so the drain's EOF emits `turn_cancelled` rather than `error`. The rotation is the wheel's deliberate act; a turn it retires was not lost, and the frame family for "the wheel ended this" is the cancel with `is_recovery`, which the deck already renders without a banner. This is the one code path [F06] shows can raise the banner on a rotation, and it is closed whether or not it is the path that fired on 2026-09-04.

**[B04] A rotation segment clears a `wire_error` banner on the line it supersedes.** The store's translation of `session_segment kind=rotation` into `session_stage` gains the same effect a transport recovery has on `transport_closed`: `lastError` of cause `wire_error` is nulled. The rule is the one `clearedTransportError` states — "nothing that the recovery disproves should outlive it" — and a rotation that announced a fresh claude has disproved a wire error on the old one. `session_state_errored` and the two ownership causes stay untouched, exactly as they do on reconnect.

**[B05] The pins are at the layer that saw the defect.** A tugcode test drives `newSession` with an `ActiveTurn` installed and no `result`, and asserts the drain emits `turn_cancelled` with `is_recovery`, never `error` ([B03]). A second asserts that every `error` write is preceded by a `tugcode.error_frame` lifecycle line carrying the same site, over the whole enumerated set ([B01]). A reducer test in `code-session-store.errored.test.ts` asserts a `wire_error` banner is cleared by a rotation `session_stage` and a `session_state_errored` one is not ([B04]). No app-test: the shape is a frame sequence, and the runner-harness lesson from the compaction brief applies — the sequence is the pin, not the screen.

---

## Open Questions {#open-questions}

- **Which frame fired on 2026-09-04?** [F07] rules out the two obvious candidates and [F05] leaves no way to read the answer back. This brief does not guess. [B01] and [B02] make the next occurrence a one-line read, and if the next one is *not* the drain-EOF shape [B03] closes, that is a new finding for a new brief rather than a reason to hold this one.

---

## Non-goals {#non-goals}

- **Suppressing `error` frames during a rotation.** A rotation that genuinely broke — a spawn that failed, a stdin that closed — must still raise the banner. [B03] changes what the *retiring* turn's ending is called, not whether errors are reported.
- **Clearing every `lastError` cause on a rotation.** A `session_state_errored` from the crash budget is about the card's process supervision, which a rotation does not replace; it survives, as it survives a reconnect.
- **Reading the frame out of the deck's persisted state.** The tugbank card-state domain holds the reducer's snapshot, not the wire; [B01] puts the record where the other bridge records already are.
- **Retrying the rotation's prompt on a wire error.** It arrived ([F03]); nothing here needs a resend path.

---

## Exit {#exit}

**A plan**, single-phase, for `/arc`:

1. `emitErrorFrame(site, …)` in the bridge, the eleven sites moved onto it, the lifecycle line beside every write ([B01]), and `site` on the wire shape with the IPC catalog fixtures regenerated ([B02]).
2. `newSession` marks an open turn interrupted with cause `recovery` before the kill ([B03]), with the two tugcode tests ([B05]).
3. The store clears a `wire_error` banner on a rotation segment ([B04]), the banner shows `site` in its detail ([B02]), and the reducer test ([B05]).
4. One sentence in `tuglaws/wheel.md` under the rotation paragraph: a rotation ends the retiring claude's turn as a cancel and never as an error, and the card wears no banner for it.

The wheel, the arc runner, and the skills are untouched.
