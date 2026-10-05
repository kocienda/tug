<!-- brief-skeleton v1 -->

# Live progress for long shell runs, tied to the running Bash block

**Purpose:** A long command run from a Session card — an app-test selection, `just test`, `build-app` — shows nothing but a spinner and a clock until it exits. The 2026-10-03 "progress lines" work was meant to fix that and changed nothing the user can see, because it improved text on a channel that is closed while the command runs.

---

## Purpose {#purpose}

The user asked for *substantially better feedback* on long app-test runs. The work that followed (`92a27526f`, `app-test(progress-lines)`) landed per-file progress lines in the app-test recipe and advised, in `CLAUDE.md` and the README, running a long selection in the background and reading its output file as it grows.

Two days later, watching the `slow-app-tests` arc's audit stage, the user saw a Bash block sit for **7m 15s** with no content at all and called the effort a total failure: "over 7m of dead space. It can't be like this." The block was `just test > /tmp/slow-app-tests-just-test.log 2>&1` — not an app-test, and its output redirected to a file the card never sees.

This brief says why the effort could not have worked, and what shape does.

---

## Evidence {#evidence}

**[F01] A running Bash block carries no output, by construction of the harness.** Claude Code delivers a Bash tool's stdout in one piece, in the `tool_result`, after the command exits. While it runs, the engine emits only `tool_progress` frames. `tugcode/src/session.ts:2305` drops those on purpose ("none carries tool output … nothing to render"). So better lines on stdout cannot reach the card during the run, however good they are. **(verified)** — read from `tugcode/src/session.ts` and the real `bash_progress` frame fixed in `tugcode/src/__tests__/session.test.ts:469`.

**[F02] The `tool_progress` frame already names the block.** Its shape is `{ tool_use_id, tool_name, elapsed_time_seconds, task_id, session_id, parent_tool_use_id }`. The harness itself keys liveness to the tool call that is running; tugcode is the one throwing that key away. **(verified)** — same test fixture, which the comment calls the "real bash_progress shape from the engine".

**[F03] The model redirects or filters every long run, so stdout would be lost even after exit.** In the `slow-app-tests` implement session (`1542be79`) and audit session (`13a48ea7`), every slow invocation was one of: `just test > /tmp/… 2>&1`, `just app-test … > /tmp/s5-apptest.txt 2>&1; grep -E "VERDICT|…" | head`, `just app-test-build > /tmp/s5-build.txt 2>&1`, `just app-test … 2>&1 | tail -30`. The `CLAUDE.md` advice to run in the background and read the file as it grows was not followed once. Guidance to the model is not a mechanism. **(verified)** — grep of the two sessions' transcripts for `just app-test` / `just test` tool inputs.

**[F04] The silent runs are not only app-tests.** The 7-minute block was `just test` (Rust + `bun test` + Swift + standalone). `just app-test-build` is a full `build-app` (~2 min). Cargo builds and `bun test` across 649 files are equally silent. The progress-lines work touched one recipe out of at least four that produce this shape. **(verified)** — `/tmp/slow-app-tests-just-test.log`: `Ran 10191 tests across 649 files. [336.66s]`.

**[F05] A Bash subprocess knows its session but not its tool call.** The environment of a command run from a Session card carries `TUG_SESSION_ID` and `CLAUDE_CODE_SESSION_ID` (both equal) and `CLAUDE_PID`. It carries no tool-use identifier. The Claude Code 2.1.285 binary names a `CLAUDE_CODE_TOOL_USE_ID` variable, but only inside an environment allow-list; it is not set for Bash commands (`${CLAUDE_CODE_TOOL_USE_ID:-unset}` printed `unset` in this session). **(verified)**

**[F06] The PreToolUse hook receives the tool-use id with the command.** The hook payload Claude Code builds is `{ …session facts, hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id }`; read out of the 2.1.285 binary's `executePreToolHooks`. Tug's hook (`tugplug/hooks/pre-tool-use.sh` → `tugtool hook pre-tool-use`) already runs on every Bash call and already returns `hookSpecificOutput` (`tugrust/crates/tugtool/src/commands/hook.rs:68`). The same binary supports `updatedInput` on PreToolUse output (124 occurrences). So the one process that holds both the id and the command text, before the shell starts, is ours. **(verified)** for the payload and the field's existence; **not yet verified** that an `updatedInput` which prefixes a Bash command with an environment assignment reaches the subprocess unchanged in 2.1.285 — see Open Questions.

**[F07] tugtool already has a session-scoped push into tugcast.** `tugtool` POSTs to the running instance's `/api/tell` for changeset verbs (`tugrust/crates/tugtool/src/changes.rs:51`), to `/api/arc` and `/api/draft`; tugcast broadcasts session-scoped frames on the Control feed (`broadcast_bind_arc_ok(&control_tx, &session_id)`). Nothing new is needed for a recipe to reach the deck for a given session; what is new is the message and the block it lands on. **(verified)**

**[F08] The Bash block renders nothing while streaming, on purpose.** `tugdeck/src/components/tugways/cards/blocks/bash-tool-block.tsx:396`: `status === "streaming"` → `body = null`, "the header's lifecycle dot is the in-flight signal ([D02])". The duration shows in the footer only once `durationMs` is known, i.e. after exit. **(verified)**

**[F09] The app-test recipe already computes every line that should be shown.** `report_progress` in `Justfile:2166` prints `n/N  mm:ss  [STATUS] file (passed/total) secs` plus a red file's first failure or a `WEDGED` cap note; `tugtool apptest record` is called at the end. The lines exist; they go to stdout and nowhere else. **(verified)**

---

## Decisions {#decisions}

**[B01] Progress travels beside stdout, never through it.** A recipe reports progress to tugcast by a side channel keyed to the session, and the card renders it under the running block. Then nothing the model does to stdout — redirect, `| tail`, `| grep`, foreground or background — can lose it, because the progress never entered the pipe the model controls. [F01] and [F03] together rule out every design that improves stdout.

**[B02] The running block is identified by `tool_use_id`, and the subprocess learns its own id from the PreToolUse hook.** The hook holds `tool_use_id` and the command text before the shell starts [F06]. It returns `updatedInput` whose command is the model's command prefixed with an exported `TUG_TOOL_USE_ID=<id>` assignment. The rendered block still shows the model's command (the `tool_use` block streamed to the deck before the hook ran); only the executed text changes. This makes the association exact rather than inferred: a session with two commands running — two parallel tool calls, or a background job beside a foreground one — attaches each report to its own block with no matching. The hook must then always emit output for Bash, including when its gate has "no opinion" (`pre_tool_use` returns `None` today, `hook.rs:94`); the prefix rides an `allow` or a no-decision output alike. This decision is contingent on the one experiment in Open Questions; if the harness does not honour it, [B03] is the fallback.

**[B03] Fallback association, used only if [B02] fails: open-call matching, with the card as the floor.** The hook still registers `(session, tool_use_id, command text)` with tugcast at PreToolUse, and tugcode closes the entry at `tool_result`. A report carrying `TUG_SESSION_ID` and its own recipe invocation (`just app-test …`, `just test`) lands on the single open Bash call in that session when there is one; among several, on the one whose command text contains the invocation; and when that is still ambiguous, on the card's own running strip rather than any block. A guessed attachment to the wrong block is worse than an honest card-level line.

**[B04] tugcode forwards `tool_progress` instead of swallowing it.** The frame already carries `tool_use_id` and `elapsed_time_seconds` [F02]. The deck uses it to tick the running block's clock from the engine's own reading and to mark the block *live* — the harness's heartbeat is the one signal that is true even for a command that reports nothing. This is independent of [B01]–[B03] and costs one `case` in `session.ts`.

**[B05] The running block shows the latest progress line in place of its empty body.** `[D02]` keeps the lifecycle dot as the in-flight signal; this adds, beneath the header of a *streaming* Bash block, one line of the latest report — `app-test 7/20 · 03:12 · at0603 PASS (14/14) 38s`, `bun test · 412/649 files · 2 fail`, `build-app · compiling tugdeck` — and the engine's elapsed seconds. When the block closes, the stdout result replaces it as today; the progress line was a view of the run, not part of its record. The result is the same body-less streaming block, with one line of truth in it.

**[B06] Every long recipe reports, not only app-test.** The 7-minute silence was `just test` [F04]. The reporter is one verb — `tugtool progress <line> [--count n/N] [--status …]` or equivalent — that reads `TUG_SESSION_ID` and `TUG_TOOL_USE_ID` from the environment and exits 0 silently when either is absent or no instance is running, so a recipe run from a plain terminal behaves exactly as now. Recipes that call it: `app-test` (from `report_progress`, [F09]), `test-ts` (per `bun test` invocation, and per file where `bun test`'s output allows), `test-rust` (per crate or nextest progress), `build-app` / `app-test-build` (per phase). Reporting is telemetry-grade like `apptest record`: a failed report never fails the run.

**[B07] The advice in `CLAUDE.md` and the README to "run in the background and read the file as it grows" is withdrawn as the mechanism.** It may stay as a note about reading results, but nothing about the user's feedback depends on the model's behaviour once [B01] holds.

---

## Open Questions {#open-questions}

- **Does `updatedInput` from a PreToolUse hook reach the Bash subprocess in Claude Code 2.1.285 with a prefixed environment assignment intact?** The field exists in the binary [F06]; what is unverified is (a) that Bash honours it, (b) that it still applies when the hook returns no `permissionDecision` and the user is prompted instead, and (c) that the transcript and the deck keep showing the model's original command. One experiment settles it: a PreToolUse hook that returns `updatedInput` with the command `export TUG_TOOL_USE_ID=<tool_use_id>; <command>`, then a Bash call that prints that variable. Hooks are snapshotted at session start, so the experiment runs in a fresh session with the hook in `.claude/settings.local.json`. A *no* on (a) or (b) selects [B03]; a *no* on (c) is a question for the user, since the rendered command would then carry the prefix.

---

## Non-goals {#non-goals}

- **Streaming stdout into the block.** Claude Code does not stream Bash output [F01], and a design that waits for it to is a design that waits on upstream. Also rejected because stdout is the model's channel: even streamed, a `> /tmp/…` redirect empties it [F03].
- **More or better advice to the model.** `CLAUDE.md` already says to run long selections in the background and read the file; the next session did not [F03]. Guidance can shape a report after the fact; it cannot make a running block say anything.
- **A session-level polling reader of the output file.** The product has no polling (`[[no-polling-in-the-product]]`); the recipe knows when a file finishes and pushes then.
- **Associating a report by process ancestry or timing.** The shell's pid chain reaches `CLAUDE_PID` but Claude Code publishes no pid→tool-use map, and two parallel tool calls start within milliseconds. Rejected in favour of the hook carrying the id [B02].
- **Rendering the whole progress history in the running block.** One latest line, with counts; the full report arrives as stdout at exit and is the record. Scrollback in a running block is a second terminal.

---

## Exit {#exit}

**An arc.** The first thing it does is the experiment in Open Questions, because it chooses between [B02] and [B03] and everything downstream reads the same `TUG_TOOL_USE_ID`. Then, in roughly this order: tugcode forwards `tool_progress` and the deck ticks the streaming block from it [B04]; the hook emits the id (or registers the open call) [B02]/[B03]; a `tugtool progress` verb posts to tugcast and tugcast broadcasts a session-scoped, tool-use-keyed frame [B06]; the Bash block renders the latest line while streaming [B05]; the recipes call the verb, app-test first since its lines already exist [F09], then `test-ts`, `test-rust`, `build-app`; and the `CLAUDE.md`/README advice is rewritten [B07]. The verdict is the gesture that started this: `just test` from a Session card, watched for seven minutes, with something true on the block the whole time.
