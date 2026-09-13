# The sparkline shows work while a shell command runs

**Purpose:** A session running a long Bash command shows a flat sparkline for the whole run. The session is working and the instrument must say so.

---

## Purpose {#purpose}

The user's report, with a Session card mid-arc, five Bash calls in a row, one of them running for fifty-one seconds, and the tape flat:

> It still goes flat far too often, especially when running shell commands via Bash. Look, the session is doing work here. We *must* show some activity here. How?

The tape reports bytes in flight. A shell command in flight moves no bytes until it returns, so the line says idle while the state cell says Working.

---

## Evidence {#evidence}

**[F01] tugcode is the only producer of the rate channels, and it credits a foreground tool twice.** `accountActivity` in `tugcode/src/session.ts` adds 250 units to `tools` once when a foreground `tool_use` opens, and up to 600 units for the result's length when `tool_result` arrives. Nothing is credited in between. A 51 second Bash call is one blip, fifty seconds of zero, one blip. **(verified)**

**[F02] Claude Code does stream a liveness signal mid-tool, and tugcode swallows it.** The `tool_progress` case in `tugcode/src/session.ts` names `bash_progress` heartbeats with elapsed seconds, and breaks without emitting or counting, because the frame carries no output to render. **(verified)**

**[F03] The OS gauges see the shell child but cannot carry the composite.** The tugcast sampler in `tugrust/crates/tugcast/src/feeds/activity/resource.rs` walks each session's tugcode subtree at 1 Hz, with a comment noting bash children coming and going. But `cpu` and `memory` are gauge channels, excluded from the tape's composite by design in `compositeSeries`, and a `sleep` or a network wait raises no CPU at all. **(verified)**

**[F04] The deck cannot honestly synthesise the signal itself.** The store is a pure consumer under its own header: the wire frame maps 1:1 to `record`, and all derivation lives upstream in tugcode. The deck does know a tool is in flight, since the tool block runs its own elapsed timer, but crediting the store from that would put derivation on the wrong side of the wire. **(verified)**

**[F05] The flush cadence already exists.** tugcode runs a 250 ms activity flush per live turn, drains the accumulator, and emits one `activity_delta` per non-empty bin. A per-bin credit needs no new timer. **(verified)**

**[F06] The subagent rule is the precedent.** The same accounting code pulses `subagents` once per child tool call because "a burst is the only signal that keeps the line alive" while an agent works, and pulses `tools` on every `task_progress` for the same reason. A held signal for an open foreground tool is the same reasoning applied to the case it missed. **(verified)**

**[F07] Level arithmetic.** Full scale is 1200 units per second and the tape sums four bins for its rate, through a gamma 0.6 curve. **(verified)**

| units per bin | rate per second | height |
|---|---|---|
| 30 | 120 | about 25 percent |
| 75 | 300 | about 44 percent |

The opening call spike of 250 units sits near 39 percent and a full result near 66 percent.

---

## Decisions {#decisions}

**[B01] A foreground tool in flight credits the `tools` channel every bin, from tugcode.** The turn tracks the set of open foreground tool ids, added at `tool_use` and removed at `tool_result`. While the set is non-empty, each 250 ms drain adds a fixed hum to `tools`. The deck changes not at all: the store's change gate passes any positive rate, the tape goes live for the whole run, and the dominant-channel tint turns the line the tools colour while a shell runs. Derivation stays upstream per [F04], the clock is ours per [F05], and the precedent is [F06].

**[B02] The hum is 30 units per bin.** Per [F07] that reads at about a quarter height, a hum under the beats rather than a competitor to the call spike and the result. It is one named constant beside `TOOL_USE_ACTIVITY_UNITS` and is the one knob for the level.

**[B03] Backgrounded tools drop out on their own.** A `run_in_background` Bash returns its result at once, so its id leaves the set immediately, and `task_progress` already pulses `tools` while it runs. No special case.

**[B04] The hum's clock is the flush timer, not Claude Code's heartbeat.** The `tool_progress` frames in [F02] stay swallowed. Their cadence is Claude Code's and has changed across versions; the flush is ours and already paces the bin.

---

## Open Questions {#open-questions}

- Whether a foreground `Agent` call waiting on its child should also hum. The child's own tool calls already pulse `subagents`, so the recommendation is to leave it out and revisit only if a waiting parent reads as dead in practice.

---

## Non-goals {#non-goals}

- **Synthesising units in the deck from the tool block's timer.** Rejected on [F04]; the store is a pure consumer.
- **Folding CPU into the composite.** Rejected on [F03]; a level is not work, and waits show nothing.
- **Un-swallowing `tool_progress` as the signal.** Rejected on [B04].
- **Modulating the hum by CPU.** Not now. The hum states that a tool is running, which is the fact the reader asked for; fidelity beyond that is a later brief.

---

## Exit {#exit}

An arc. The first steps in order: add the in-flight set and the hum constant to the turn's accounting in `tugcode/src/session.ts`, credited in the drain; extend `tugcode/src/__tests__/activity-counting.test.ts` with a case where a foreground tool opens, several bins pass, and the result lands, asserting the hum per bin and its absence after; confirm on a live session running a long shell command that the tape rises, holds the tools tint, and settles after the result.
