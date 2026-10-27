# slash-parity probe findings

Probes for the Session card's slash-command classification on the CLI version in `capabilities/LATEST`. They cover the commands that were hidden or passed through with no headless evidence. Each section names its capture; the captures are the contract, and this file is the summary.

**CLI:** claude 2.1.311 · **Probe:** `probe-commands.mjs`. It drives claude directly over stream-json with tugcode's `buildClaudeArgs` vector (`--permission-mode default`, `--plugin-dir tugplug`, no `--permission-prompt-tool`), with cwd `/private/tmp/slash-parity-probe`.

**Captures:**

- `capture-2026-10-27T22-13-04-794Z.*` — the main round of twelve commands.
- `capture-fast-optin-2026-10-27T22-18-44-966Z.*` — `/fast` under a flag-settings opt-in.
- `capture-output-style-2026-10-27T22-20-19-211Z.*` — `/output-style` switching away and back.

**How the probe was kept safe:**

- The cwd is not a git repository, which is how `/code-review ultra` could be observed without launching a cloud review.
- With no permission-prompt tool, every tool call that needs approval is denied, so no command could edit files.
- `/import` ran with `--dry-run`.
- `~/.claude/settings.json` was hashed before and after each run, and it did not change in any run.

**Redaction:** `redact.mjs` has rewritten the committed `.stdout` files. Every tool result's content is replaced with a length marker, because `/doctor`'s results are reads of the probing machine's own setup. The `stream_event` partial-message lines are dropped. Each `.meta.json` was written from the unredacted wire, so its `stdoutLines` count is the raw one.

## The tiers on the evidence

| Command | Headless behaviour (2.1.311) | Tier |
|---|---|---|
| `/fast` | `/fast on` → `Fast mode unavailable: Fast mode is not available in the Agent SDK`, even under `--settings '{"fastMode":true}'`. `/fast off` and bare `/fast` → `Fast mode OFF (this session only)`. `fast_mode_state` stays `off` throughout. | **hidden** (unchanged) |
| `/reload-plugins` | `Reloaded: 1 plugin · 7 skills · 5 agents · 3 hooks · 0 plugin LSP servers`, 0 turns, $0, and the session carries on. | **pass-through** |
| `/reload-skills` | `Reloaded skills: 28 skills available (none added or removed).`, 0 turns, $0. | **pass-through** |
| `/output-style` | Bare lists the styles and marks the current one. `/output-style Concise` → `Output style set to Concise`, and the next `system/init` reports `output_style: "Concise"`. `/output-style default` switches back. | **pass-through** (a picker is possible) |
| `/autocompact` | Prints the auto-compact window for the model, 0 turns. | **pass-through** |
| `/import --dry-run` | Runs a real model turn (1 turn, $0.14) that scans for another agent's config and reports what it would import. | **pass-through** |
| `/skill-doctor` | Prints a table of loaded skills and their context cost, 0 turns. | **pass-through** |
| `/list-agents` | Lists this session's message name and the other Claude sessions on the machine, 0 turns. | **pass-through** |
| `/code-review ultra` | In a non-repo it is refused before any launch with `… is not inside a git repository …`, 0 turns, $0. In a repo it reaches the cloud launch path (see below). | **refuse the `ultra` argument at submit** |
| `/doctor` | A bundled skill that starts a long diagnostic of the user's whole setup. It made 56 tool calls in 240 s and had not finished. It asks for approval to write files and to use `WebFetch`, and over the bridge every one of those is a permission prompt. | **hidden** (unchanged) |

## /fast — no headless set path {#fast}

The refusal comes from claude's fast-mode availability check (`sdk_opt_in_required`). In SDK mode it refuses unless flag settings opt in. Spawning with `--settings '{"fastMode":true}'` did **not** satisfy it on this account: `/fast on` was refused the same way, and `fast_mode_state` stayed `off`. The off half works but changes nothing, since fast mode was never on. The brief's condition for a local toggle, a set path plus a confirmed state echo, is not met. `/fast` stays hidden, and `fast_mode_state` stays a value the card receives and never sets.

## /reload-plugins and /reload-skills — the tugplug edit loop works {#reload}

Both reload in place and report what they loaded. Neither starts a model turn. The session keeps its id and the command that follows runs normally. Both are `type:"local"` with `supportsNonInteractive:!0` in claude's command table. Nothing about them is terminal-only over this bridge, so they graduate to pass-throughs.

## /output-style — switches mid-session, and persists to the project {#output-style}

The switch takes effect immediately, and the next `system/init` echoes it in `output_style`, which the card already receives. It also **persists**: the probe left `outputStyle: "default"` in the scratch project's `.claude/settings.local.json`. In a real project, a typed switch therefore writes that file in the user's checkout. That is claude's ordinary behaviour, and `settings.local.json` is the file claude keeps out of version control. It passes through. A picker in the `/model` family is possible later, because the echo exists.

## /code-review ultra — the cloud review is reachable headless {#code-review-ultra}

The probe could not launch a review, because its cwd was not a repository. The capture shows claude routing the typed line into the ultra path and stopping at the repository precondition, with no model turn. Static evidence from the binary says what happens past that precondition:

- claude's `/ultrareview` command, which it now calls a deprecated alias of `/code-review ultra`, has a `type:"local"` variant marked `supportsNonInteractive:!0`, enabled when claude is non-interactive.
- Claude's own description of the command says the launch dialog confirms only in interactive sessions.

So in a git repository, a typed `/code-review ultra` over the bridge would go on to start a billed cloud review, with no dialog to stop it. This half is read from the binary, not observed: the probe deliberately never ran it in a repository. That is the outcome `/ultrareview` is hidden to prevent. The ruling: the Session card refuses `/code-review ultra` (the `ultra` argument, not plain `/code-review`) at submit, as it refuses `/ultrareview`.

## /doctor — wanders headless {#doctor}

`/doctor` is not a local command but a bundled skill: a long prompt asking the model to health-check the installation and fix what it finds. Headless, the model:

- tried compound shell one-liners and had them rejected;
- tried to write a helper script and was denied;
- read `~/.claude.json`, `~/.claude/settings.json`, plugin stores and transcripts with read-only commands;
- asked for `WebFetch`.

After four minutes it had not produced its report. Over the bridge, each denied call is a permission prompt in front of the user for a diagnostic of the terminal install, which the Session card does not use. It stays hidden.
