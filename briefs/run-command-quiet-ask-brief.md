# A quiet command is asked about, never stopped on a clock

**Purpose:** A command run from the Session card is killed at 120 seconds of wall clock, whatever it is doing. A release script waiting on notarization is healthy and gets killed all the same. The cap should go, and in its place the card should notice a command that has gone quiet and ask the user what to do about it.

---

## Purpose {#purpose}

Tito ran `git push origin main && scripts/release.sh --publish 0.9.0` from a run offer. The script signed the bundle, submitted it for notarization, printed `In Progress after 0m01s`, and the block ended `timed out 120s`. His report:

> Perhaps the timeout is a bit too aggressive? When I run it in Terminal, it never fails. The notarization step can take a bit sometimes.

The user's ask, on top of a more liberal timeout: base the decision on activity. Can the card see that a command is still running productively, as opposed to one that is stuck? And in the stuck case, offer a choice instead of a kill: "This command might be stuck. Do you want to terminate or continue the command?"

---

## Evidence {#evidence}

**[F01] The cap is one wall-clock constant.** `EXEC_TIMEOUT` is `Duration::from_secs(120)` at `tugrust/crates/tugcast/src/feeds/shell.rs:81`. `shell_session_task` wraps `run_command` in `tokio::time::timeout(exec_timeout, …)`; on expiry it calls `reap_group` (SIGTERM, then SIGKILL after 400 ms) and settles the exchange with `stopped_by: "timeout"`. Nothing about the command's behaviour enters the decision. **(verified)**

**[F02] The cap covers both the run offers and the `$` route.** Both send `exec` frames on `SHELL_INPUT` to the same per-session shell child; an offer differs only by carrying an `offer_key`. **(verified)**

**[F03] A timed-out exchange settles with no output.** The timeout arm returns `String::new()` as the output, so the `exchange_complete` frame and the `shell_exchanges` ledger row are empty. The deck papers over it for a live run: `run-offer-store.ts` keeps the streamed output when the settle arrives empty with `stoppedBy === "timeout"`. A restore from the ledger has nothing. **(verified)**

**[F04] Output is read by line, so a `\r` redraw is invisible.** `run_command` reads with `child.lines.next_line()`, which yields only at `\n`. A progress line a script redraws with a carriage return stays in the reader until a newline arrives, so the block shows the first value and nothing after it. **(verified)** That this is why Tito's block showed `0m01s` at the 120 s mark is an inference from the screenshot; his script has not been read. It would be confirmed by running a loop that redraws a line with `\r` once a second from an offer.

**[F05] The deck shows nothing about liveness while a command runs.** `runOfferStatus` in `tugdeck/src/lib/run-offer-store.ts` returns the label `running` with `duration: null` for a running run. There is no elapsed time and no age of the last output. **(verified)**

**[F06] Stop already exists and is always live.** A running offer's Play button poses as Stop, and it sends the `kill` frame the dispatcher handles out of band by signalling the shared pid. **(verified)**

**[F07] Stdin is `/dev/null`, so a prompt does not hang.** `run_command` wraps every command in `{ … } </dev/null`. What can still hang is a TUI that does not self-disable (the case `interactive_tui_is_reaped_by_the_timeout` covers), a dead network connection, or a process meant to keep running. **(verified)**

**[F08] A running command holds the session's one shell.** The session task runs commands serially and is blocked reading the child's output for the length of an exchange, so no second command can start in that card until the first ends. **(verified)**

**[F09] The model is told about the two-minute stop.** `tugplug/run-offers.md` says the card "stops any command still running after two minutes" and uses that as the reason a server or watcher is not an offer. **(verified)**

**[F10] "Stuck" cannot be observed; "quiet" can.** A command sleeping between network polls and a command hung on a dead socket both produce no output and use no CPU. No signal available to tugcast separates them. This is reasoning, not a measurement.

---

## Decisions {#decisions}

**[B01] No wall-clock kill, and no hard ceiling of any length.** A command ends by its own exit, by the user's Stop or Terminate, or by the session's teardown. Terminal never kills a command, and that is the bar the report compares against. A long ceiling, an hour say, would kill a legitimate unattended build, which is the same defect later.

**[B02] Quiet is the only verdict, and its only consequence is a question.** By [F10] the card cannot know a command is stuck, so it never acts on the guess. It asks.

**[B03] Quiet means no output and no CPU for the whole horizon, and the first horizon is two minutes.** Both signals must be idle. A shorter horizon nags a command that is waiting on the network; the user's instruction is that the card must not nag.

**[B04] Output is read as bytes, not lines.** Any byte from the command counts as activity and reaches the block, a `\r` redraw included. This fixes [F04] in its own right: a script that redraws a progress line reads as alive and shows its latest value.

**[B05] CPU time is read when the quiet deadline fires, never on a loop.** Each output byte re-arms the deadline. When it fires, tugcast reads the CPU time of the shell's process group once and compares it with the reading from the last time it fired. If it advanced, the command is working silently (a compile, a compression) and the deadline re-arms without asking. This honours the standing rule against polling in the product: there is one deadline, and it is only reached when output has stopped.

**[B06] The ask is a band on the command's block, not a modal dialog.** It reads along the lines of "No output for 2 minutes. This command might be stuck." with two buttons, **Terminate** and **Keep Waiting**. A modal would interrupt whatever else the user is doing in the card over a command that is probably fine.

**[B07] An unanswered ask leaves the command running.** Nothing happens on a timer after the band appears.

**[B08] Any new output dismisses the band.** The command has answered the question itself.

**[B09] Keep Waiting doubles the horizon for that run.** Two minutes, then four, then eight of further silence. A slow notarization asks once or twice; it does not ask every two minutes.

**[B10] Terminate keeps the output and settles as `stopped`.** It sends the existing `kill`. The settle and the ledger row carry everything the command printed, which closes [F03]. The `timed out` label and the `"timeout"` value of `stopped_by` have no remaining cause and go away.

**[B11] A running block shows elapsed time and the age of its last output.** The user can then judge a quiet command before any question appears, and a command that is plainly still printing never looks stalled.

**[B12] The wire gains one output frame and one input.** tugcast owns the horizon. It tells the deck an exchange has gone quiet (with how long, and that CPU was idle), and the deck sends back a keep-waiting input when that button is pressed. Terminate reuses `kill`. An output chunk after the quiet frame is what dismisses the band.

**[B13] The behaviour is the shell feed's, so it holds for run offers and the `$` route alike.** By [F02] they are one path. Both blocks draw the band and the liveness reading.

**[B14] `tugplug/run-offers.md` drops the two-minute sentence and keeps steering servers and watchers to a terminal.** The reason changes from "it will be stopped" to [F08]: a command meant to keep running holds the card's one shell until the user stops it.

---

## Open Questions {#open-questions}

- **How the process group's CPU time is read on macOS.** The group is the shell and everything it started. Summing over its members needs a way to list them and read each one's CPU time (libproc is the likely source). This has not been tried. If no reliable reading exists, [B03] falls back to output alone, and a silent compile gets asked about at two minutes; that is worth knowing before the work is shaped, because it changes how often the band appears.

---

## Non-goals {#non-goals}

- **A longer fixed timeout.** Rejected by [B01]. Any number is wrong for some honest command.
- **Killing a quiet command automatically.** Rejected by [B02]. Quiet is not stuck.
- **A modal dialog for the ask.** Rejected by [B06].
- **A setting for the horizon.** Not asked for. Two minutes with doubling is the behaviour; a knob can follow a report that it is wrong.
- **Telling the model that a command went quiet or was terminated.** A run's result reaches the model only when the user adds it to their next message, and this work does not change that.
- **Running more than one command at a time in a card.** [F08] stays true.

---

## Exit {#exit}

**An arc.** Its raw material, in the order the pieces depend on each other:

- The shell feed reads the child's output as bytes, keeps the sentinel detection, and streams partial lines and `\r` redraws ([B04]).
- The wall-clock timeout is removed; a quiet deadline takes its place, re-armed by output, with the one CPU reading at expiry ([B01], [B03], [B05]). The open question above is settled here.
- The quiet frame and the keep-waiting input are added to the wire, with the doubling horizon held per exchange in tugcast ([B09], [B12]).
- Terminate and Stop settle with the full output; `"timeout"` leaves `stopped_by` and the deck's `timed out` label goes with it ([B10]).
- The deck draws the band and the liveness reading on the offer block and on the `$` route's block ([B06], [B07], [B08], [B11], [B13]).
- `tugplug/run-offers.md` is reworded ([B14]).
- The feed's tests move with it: `interactive_tui_is_reaped_by_the_timeout` asserted a guarantee that is being reversed in the open by [B01], and its replacement asserts that a silent, idle command produces the quiet frame and is still running afterwards.
