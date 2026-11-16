# Runnable Command Offers

**Purpose:** When the model offers a command for the user to run on their own machine, the offer should be a distinctive block with a play button, and the command's output should appear directly under it. Today the user has to carry the command to the composer or a terminal and read the result somewhere else.

---

## Purpose {#purpose}

An external contributor, Tito Ciuro, wrote in with a suggestion. His example was a numbered list whose third step read "Restart the agent with `launchctl kickstart -k gui/$(id -u)/foundation.vidalife.local-ci`", an inline code span in a sentence. He proposed that such an offer be a block of its own with a play icon beside Copy, and that clicking play "would run it *in situ*":

> See how the output shows below the command. Very convenient, it's a single click. For long outputs, perhaps limit the height of the card with a generous limit (20 lines or so?), which can be scrolled. It's integrated, and no context-switching.

The user wants to try it, and added three points of their own:

- A block whose play button is pressed should expand to a certain height, and scroll inline once the output runs past that.
- Offers written this way may need more work to be recognized, so they can be given the new format.
- The block may want a new visual representation, so executable offers stand out.

---

## Evidence {#evidence}

**[F01] An inline command span is clickable today, for two tools only.** `tugdeck/src/lib/annotator/command-grammar.ts` recognizes an inline `<code>` span that opens with `just` or `tugtool` followed by a subcommand (`SHELL_COMMAND_TOOLS`). A click seeds `/shell <command>` into the prompt through `insertCommand("shell", …)` in `tugdeck/src/lib/annotator/registry.ts`. Nothing runs until the user submits. This is the behaviour the contributor called "what you have in place (which works fine)". **(verified)**

**[F02] Fenced code is deliberately not a command hint.** `tugdeck/src/lib/annotator/annotate-content.ts` skips `pre > code` with the comment "Fenced code (`pre > code`) is content, not a command hint." **(verified)**

**[F03] Each card already has a shell session that can run a command.** `ShellSessionStore` (`tugdeck/src/lib/shell-session-store.ts`) exposes `exec(command)` and `kill()`, holds a persistent `cwd`, and is serial: its snapshot carries one `inflight` exchange or `null`. The `/shell` handler in `tugdeck/src/components/tugways/cards/session-card.tsx` refuses a second command with "A shell command is already running". Exchanges are ledgered and restored through `list_shell_exchanges`. **(verified)**

**[F04] A shell exchange is rendered as its own transcript turn.** `exec` leads to `ingestShellExchange` on `CodeSessionStore`, which mints a `shell`-origin turn drawn by `ShellExchangeBlock` (`tugdeck/src/components/tugways/cards/shell-exchange-block.tsx`), with Add to context and Copy in its header. The result of a command therefore lands at the foot of the transcript, wherever the command was offered. **(verified)**

**[F05] Shell output does not stream.** The `SHELL_OUTPUT` feed that `ShellSessionStore` consumes carries `shell_state`, `exchange_started` and `exchange_complete`. `ShellExchangeBlock`'s header comment says that while an exchange is in flight "there is no body; once it settles the body mounts with the final output." **(verified)**

**[F06] A terminal block never scrolls inside itself.** `tugdeck/src/components/tugways/body-kinds/terminal-block.tsx` states: "the transcript is the one scroll surface; a terminal block never scrolls inside itself vertically. Long output is bounded by the collapse fold … and the retention cap." **(verified)**

**[F07] The fence chrome is built in DOM after `innerHTML`, and is rebuilt.** `tugdeck/src/lib/markdown/enhance-fenced-code.ts` wraps each `<pre>` in `.tugx-md-fenced-code` with a header from `buildBlockHeader` holding the language label, a Copy button and a fold button. The pass is idempotent because a streaming delta rewrites the block's `innerHTML` and the windowing engine prunes and rebuilds blocks. Anything attached to a fence is lost on a rebuild unless the next pass puts it back. **(verified)**

**[F08] A custom fence language taught to the model has a precedent.** A `tugchart` fence is turned into a placeholder by `tugdeck/src/lib/markdown/block-transformers/tugchart.ts` and rendered by `enhance-chart.ts`; the model learns the fence from a prompt file under `tugplug/` that rides every session's system prompt. **(verified)**

**[F09] The shell has no TTY.** `tugdeck/src/lib/shell-interactive-staging.ts` records that "the block shell has no TTY — a command's stdin is `/dev/null`", so a prompting program reads EOF at once. The route already refuses two classes of command before running them: interactive staging (that module) and programs that never end (`unendingProgram` in `shell-line-classifier.ts`). A `sudo` command, common among offered commands, would fail for the same reason. That last sentence is inference from the stdin fact and was not run. **(inferred)**

**[F10] Whether `exec` accepts a multi-line command is unknown.** The `/shell` door passes a single trimmed argument string, and nothing read so far shows a multi-line script going through one exchange. **(not verified)**

---

## Decisions {#decisions}

**[B01] The model declares an offer with a `tugrun` fence.** A command the model wants the user to run on their machine goes in its own fence whose language is `tugrun`, one offer per fence, and never inline in a sentence. The rule ships in a prompt file under `tugplug/`, as `tugchart`'s does ([F08]). The contributor's own example needed this regardless of how offers are recognized: the command was an inline span ([F01]) and only the model can lift it into a block. A declared fence also keeps the distinctive look meaningful, because a `bash` fence is often an illustration rather than an offer.

**[B02] A plain `bash`, `sh` or `zsh` fence gets a play button in its ordinary chrome, and nothing else.** No distinctive frame. This covers transcripts written before the contract existed and turns where the model forgets it. It reverses [F02] for those three languages only. It is the first part to cut if the first pass must be smaller.

**[B03] A `tugrun` block has its own frame, distinct from the code fence.** An accent rail on the left, a `$` sigil, the command, and Play and Copy on the right, with no fold button. It is built in DOM and CSS like the fence chrome ([F07]), per [L06].

**[B04] The command wraps and is never clipped.** The contributor's mock scrolls a long command horizontally. The user should see all of what they are about to run, so the command wraps to as many lines as it needs.

**[B05] Play runs the command in the card's existing shell session.** It calls `ShellSessionStore.exec` ([F03]), so working directory and environment carry from one offer to the next and behave exactly as `/shell` does. No second execution path is built.

**[B06] The click is the consent; there is no confirmation dialog.** The trust is the same as copying the command into a terminal, with less friction. Two guards stand in for a dialog: the whole command is visible ([B04]), and Play is disabled until the turn has finished streaming, because the command text is not final before then.

**[B07] Play becomes Stop while the command runs, and other offers wait.** Stop calls `kill()`. Because the shell is serial ([F03]), every other play button in the card is disabled while one exchange is in flight, which replaces the "already running" bulletin for this door.

**[B08] The result attaches under the command, inside the same frame.** An exchange started from a play button mints no turn at the foot of the transcript ([F04]). This is the whole point of the suggestion: the result is read where the command was offered.

**[B09] Output appears as it is produced.** The feed gains an output-chunk frame from tugcast between `exchange_started` and `exchange_complete` ([F05]). Without it the block would sit empty for the length of the command and the grow-then-scroll behaviour in [B10] would have nothing to show.

**[B10] The result grows to a cap of about 20 lines, then scrolls inside itself, pinned to the tail while running.** This is a deliberate exception to the rule in [F06], for this block only. A result that grows without bound in the middle of a transcript pushes the prose the user was reading off screen, which a result at the foot of the transcript never does. The exact cap is a tuning value, not a setting.

**[B11] The result's footer shows exit status, duration and the directory the command ran in.** The directory is shown because the shell's `cwd` persists ([F03]) and may have moved away from the project directory since the offer was written.

**[B12] Running an offer again replaces its result.** One offer shows one result, the latest.

**[B13] Add to context stays on the result.** It is the only route by which a shell exchange reaches the model, and it matters more here than elsewhere: the model made the offer and usually wants to know what happened.

**[B14] The exchange goes through the same ledger, and a reload restores the result under its fence.** The exchange is keyed to its fence by the turn, the fence's index within the turn, and a hash of the command text. The hash is there because an edited or re-streamed turn can shift the index. The enhance pass re-attaches the result from a store on every rebuild ([F07]); the result is never held only in the DOM.

**[B15] The existing refusals apply to offers.** A command that `unendingProgram` or the interactive-staging check would refuse on the `/shell` route ([F09]) is refused here too, by the same code.

**[B16] An offer that needs a terminal shows Copy only, with a note saying why.** A command that would prompt, `sudo` first among them, cannot succeed with stdin at `/dev/null` ([F09]). Showing a play button that is certain to fail is worse than not offering one.

**[B17] Copy as Markdown writes a `tugrun` fence as `bash`.** A shared transcript should read normally to somebody who has never heard of Tug.

**[B18] One fence is one exchange.** A multi-line `tugrun` fence is sent whole as a single command. This rests on [F10] and is to be confirmed before it is built on.

---

## Open Questions {#open-questions}

- **Which commands count as needing a terminal ([B16])?** `sudo` is certain. The rest of the list, and whether it is a literal-token scan like the interactive-staging check or something the `tuggram` grader answers, is not settled. Reading how `/shell sudo …` fails today would settle the first half.
- **Does `exec` take a multi-line command ([F10], [B18])?** If it does not, the choices are to join the lines, to run them as a script, or to hold the model to one line per offer in the contract. Running one through `/shell` would settle whether there is a question at all.

---

## Non-goals {#non-goals}

- **A heuristic classifier that decides which fences are offers.** Rejected. A `bash` fence is often an illustration, and guessing wrong either hides a real offer or dresses an example as one. The model declares the offer ([B01]).
- **A terminal emulator, or a TTY for the block shell.** The no-TTY shape of the shell stands ([F09]). Offers that need one are handed to Copy ([B16]).
- **Inline scrolling for other terminal output.** The exception in [B10] is for a runnable offer's result. `BashToolBlock`, `ShellExchangeBlock` and the rule in [F06] are unchanged.
- **Changing the inline `just` / `tugtool` click.** The seed-into-the-prompt behaviour in [F01] stays as it is. Widening the inline grammar to other tools is separate work.
- **Sending the result to the model automatically.** A shell exchange reaches the model only when the user adds it to context ([B13]).
- **A confirmation dialog before running.** Rejected in [B06].

---

## Exit {#exit}

**An arc.** The pieces have a natural order, because the later ones need the earlier ones to be visible:

1. The `tugrun` fence end to end without execution: the block transformer or enhance pass, the distinctive frame with the wrapped command ([B03], [B04]), Copy, and the Copy as Markdown rewrite ([B17]).
2. Play and Stop wired to the card's shell session, with the result attached under the command at settle, the serial and streaming-turn guards, and the existing refusals ([B05]–[B08], [B15]).
3. The fence-keyed result store, ledger round trip and restore after reload ([B14]), with replace-on-rerun and Add to context ([B12], [B13]).
4. The output-chunk frame in tugcast and the growing, capped, tail-pinned result ([B09]–[B11]).
5. The terminal-needing check and its Copy-only presentation ([B16]), once the first open question is answered.
6. The play button on plain shell fences ([B02]).
7. The model contract under `tugplug/` ([B01]), written last so it describes what was built.

The second open question should be answered before step 2 is walked.
