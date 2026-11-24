# Activity Machine Channel

**Purpose:** A session running shell commands reads as nearly idle on its activity tape. The tape needs a way to show the work the session's processes are doing.

---

## Purpose {#purpose}

The report, 2026-11-24: "When we run a lot of shell commands, the sparkline seems deaf to that. It shouldn't be. We need some concept to model that activity in the sparkline."

The concept is machine work: what the processes a session started are consuming, measured from the operating system, as distinct from what the model is writing. This is the third of four briefs from one sketch, after `activity-watch-scope-brief.md` and `activity-session-accounting-brief.md`.

---

## Evidence {#evidence}

**[F01] A shell command draws a beat, a constant hum, and a beat.** `accountActivity` in `tugcode/src/active-turn.ts` credits 250 units at a foreground `tool_use`, the result's length capped at 600 at its `tool_result`, and `drainActivity` adds `FOREGROUND_TOOL_HUM_UNITS` (30) to every bin in between. The hum is the same for `sleep 60` and a full build. **(verified)**

**[F02] A backgrounded or moved command loses even the hum.** The open-tool set is closed by the `tool_result`, and a backgrounded call's result lands at once (the comment at `tugcode/src/active-turn.ts:415` says so). The command runs on with nothing counted. **(verified)**

**[F03] tugcast already samples each session's process subtree.** `tugrust/crates/tugcast/src/feeds/activity/resource.rs` walks the subtree from each session's tugcode pid once a second and publishes CPU, memory and, on macOS, disk bytes per second on ACTIVITY as gauge channels, each only when it moves. **(verified)**

**[F04] The compact tape excludes gauges on purpose.** `compositeSeries` in `tugdeck/src/lib/session-activity-store.ts` sums the rate channels only, and `SessionActivitySparkline` wakes on rate channels only. A gauge is a level that holds between samples; a memory level is not work. **(verified)**

**[F05] The subtree is tugcode, then claude, then a shell, then the command, with nothing standing beside it.** A `ps` snapshot of eight live sessions on 2026-11-24 showed exactly `tugcode → claude → zsh → command` in each working session and `tugcode → claude` in each idle one. No session had an MCP server or any other long-lived process under `claude`. **(verified, on this machine; a project that configures MCP servers was not measured)**

**[F06] An idle `claude` reads 0.0 to 0.3% CPU and a working one 1.6 to 3.5%.** Six idle `claude` processes sampled four times over eight seconds with `top` read between 0.0 and 0.3. Two mid-turn read 1.6 and 3.5 in the `ps` snapshot. One session's tool subtree held an `xctest` at 137% at the same moment. **(verified)**

---

## Decisions {#decisions}

**[B01] There is a fifth rate channel, `machine`, produced by tugcast.** It is a rate, not a gauge, so it joins the composite and wakes the tape with no change to either rule in [F04]. The existing `cpu`, `memory` and `disk` gauges stay as they are for the Activity card.

**[B02] It measures the processes below `claude`, and neither `claude` nor `tugcode`.** Their own CPU is the model's client reading its stream, which `text` and `tokens` already draw; counting it twice would lift the line whenever the model writes.

**[B03] Nothing is excluded by name; a noise gate handles the floor.** A sample under about 2% of one core credits nothing. That sits above the measured idle floor ([F06]). A standing process such as an MCP server needs no rule: idle, it is under the gate, and busy, a tool called it and the work is real.

**[B04] Three signals become units: CPU consumed, processes spawned, and disk bytes moved.** CPU is the main one. The spawn count is what makes a run of many short commands read as busy, since each lives for less than a sample. Disk covers a command that is I/O-bound and light on CPU.

**[B05] It runs whether or not a turn is open.** The sampler knows nothing of turns. A background job, a moved call and a command a wake started all draw.

**[B06] The sampler runs at the tape's 4 Hz for a session while it has tool processes alive, and at 1 Hz otherwise.** A 1 Hz sample against 250 ms bins draws one spike a second with three empty bins between. The faster cadence applies only to sessions with something below `claude`, so an idle instance does no more work than today.

**[B07] The hum stays.** It is the floor under `machine`: a command that sleeps or waits on the network consumes nothing and is still open.

**[B08] `machine` has its own hue.** The tape's tint follows the dominant channel, so a session whose line is machine work reads differently from one that is writing. The token is `--activity-machine`, added to every theme file.

**[B09] The channel is named in the deck's descriptors and nowhere in tugcode.** `ACTIVITY_DESCRIPTORS` gains the entry and the rate-channel list follows from it. `ActivityChannel` in `tugproto/src/outbound.ts` is the set tugcode derives and does not change.

---

## Calls you have not seen {#unseen-calls}

- The name `machine`. Rename it in this brief before an arc opens if `exec`, `shell` or `process` reads better; it appears on the wire, in the Activity card and in the tape's title.
- One saturated core is 600 units a second, half the tape's full scale, so a single busy core draws a tall line and a multi-core build reaches the top. This is the channel's one level knob.
- A spawn is 60 units and disk is 100 units per MiB a second, capped at 600. Both are constants beside the CPU scale.
- The noise gate is 2% of one core.
- The Activity card shows `machine` as a row of its own beside the gauges. Say so if it should be left off that card.

---

## Open Questions {#open-questions}

- What a 4 Hz process refresh costs. sysinfo's refresh reads every process on the machine. The arc should measure tugcast's own CPU with one session building at 4 Hz, and if it is more than a fraction of a percent, either refresh only the pids known to be in a session's subtree between full walks, or sample at 1 Hz and spread each sample's units across its four bins. Either keeps [B06]'s picture; the measurement picks the mechanism.
- Whether the bodiless-facts reading should treat a `machine` sample as tool work. `onActivity` in `tugdeck/src/lib/bodiless-facts-store.ts` names the kind of work from the channel. Mapping `machine` to `tool_work` is the obvious answer; it needs a look at what a between-turn sample does to a card's phase before it is taken.

---

## Non-goals {#non-goals}

- **Folding the `cpu` gauge into the composite.** A gauge holds its level between samples, so a held 40% would draw a permanent plateau, and it includes `claude` itself.
- **Replacing the hum.** See [B07].
- **Reading a command's output as activity.** A Bash tool's output arrives only in its result; there is no stream to count.
- **Showing waiting as activity.** Settled 2026-11-24.

---

## Exit {#exit}

An arc. A shape for its first steps:

1. The pure part of the sampler: from a process map and a session's tugcode pid, the tool subtree below `claude` and its units for one interval, with spawn counting by pid and start time, tested over hand-built maps as `subtree_usage` is.
2. The cost measurement of the first open question, and the cadence mechanism it picks.
3. Publishing `machine` on ACTIVITY, gated and silent when there is nothing to say.
4. The deck's descriptor, the hue token in every theme with `bun run audit:theme-contrast`, the tape's title, and the Activity card's row.
