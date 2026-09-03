# Shell execution probe — FINDINGS

Probe for the route-enhancements design record, [Q01]–[Q04] — the block-oriented
shell backend for the `$` route. Answers: which process architecture, how one
exchange is captured, how the shell stays non-interactive, and what happens on
restart.

**Host:** macOS (Darwin 24.6.0) · **tmux:** 3.6a · **shells tested:** `/bin/zsh`,
`/opt/homebrew/bin/bash` (fish absent — see [Q01] note)
**Spikes:** `spike-sentinel-child.mjs`, `spike-stdin-fix.mjs`, `spike-tmux.mjs`,
`spike-hardening-streaming.mjs`, `spike-streaming-clean.mjs` (run with `bun`)

## TL;DR

| Q | Resolution |
|---|------------|
| **Q01** backend | **(b) sentinel-driven persistent child shell, pipe mode (no PTY).** Rejected tmux (a) and one-shot (c). |
| **Q02** protocol | **Settled-whole output at `exchange_complete` for v1; streaming frames reserved.** Combined stdout+stderr stream. |
| **Q03** hardening | **Pipe mode + hardened env + per-command `</dev/null` + timeout→signal-kill.** No case hangs. |
| **Q04** restart | **Child does NOT survive a tugcast restart; restarts fresh in the project dir. The *record* survives via the ledger ([P07]).** |

---

## [Q01] — RESOLVED: sentinel-driven persistent child, pipe mode

A long-lived `$SHELL` spawned with **piped** stdio (no controlling TTY), driven
by writing `<command>` then a sentinel emitter, and reading stdout until the
sentinel:

```
<command>
printf '\n__TUG_SENTINEL__<nonce>\t%d\t%s\n' "$?" "$PWD"
```

The sentinel line carries the command's `$?` (exit code) and `$PWD` (post-command
cwd) — exact output boundaries, exit code, and cwd in one read.

### Core battery (zsh AND bash, identical results)

| Case | Result |
|------|--------|
| `echo hello world` | `exit=0`, output `hello world\n` |
| `false` | `exit=1` |
| `cd /tmp` then `pwd` | cwd sentinel tracks to `/tmp`; `pwd` prints `/tmp` — **cwd persists across commands** |
| `export VAR` then `echo $VAR` | prints the value — **env persists** |
| pipes / `&&` / `\|\|` chains | all correct |
| `test -t 1` | prints **`NOTTY`** — pipe mode presents no terminal |

Per-command latency was **5–11 ms**. cwd + env persistence is the property a
one-shot `$SHELL -c` (option c) cannot give without state-serialization hacks —
so (c) is rejected.

### Why NOT tmux (option a)

`spike-tmux.mjs` confirmed tmux's one advantage — **session survival** (the
session persists server-side; a fresh client can `send-keys`/`capture-pane`
after the driver exits) — but its costs disqualify it for a block shell:

- **Tall output is truncated.** `seq 1 120` into a 50-row pane: `capture-pane`
  returned **47 of 120 lines**. A pane is a fixed TTY grid; full output needs
  scrollback gymnastics (`-S -`) and still re-wraps long lines. A `cargo build`
  would lose most of its output.
- **Blank-line padding + echo noise.** `capture-pane` returns the whole visible
  grid — prompt, the echoed command, output, and dozens of trailing blank rows —
  so boundary-finding needs sentinel matching *plus* echo-stripping *plus*
  padding removal.
- **It's a real TTY**, so pagers and TUIs would *render into the pane* — the exact
  opposite of the block model ([P04] — no TTY emulator).

tmux's only win (survival) is redundant: the shell **record** is made durable by
the ledger ([P07]) regardless of process lifetime. Paying tmux's block-model tax
to keep a *live process* across restarts is a bad trade.

> **fish note:** fish was not installed on the probe host. The sentinel protocol
> (`$?`, `$PWD`, `{ …; } </dev/null`) is POSIX/bash/zsh syntax; fish differs
> (`$status`, no `$?`, different grouping). **Recommendation:** the shell service
> spawns a **known POSIX shell** for exec (the login shell if it is bash/zsh, else
> fall back to `/bin/zsh`) rather than assuming `HostFactsStore.shellPath` is
> POSIX. A block-exec shell need not *be* the login shell. Fold this into [P09].

---

## [Q02] — RESOLVED: settled-whole for v1; streaming frames reserved

`spike-streaming-clean.mjs` measured arrival spread:

| Command | bytes | chunks | arrival span |
|---------|-------|--------|--------------|
| `seq 1 5000` (24 KB) | 23894 | 2 | **0 ms** |
| `seq 1 100000` (589 KB) | 588896 | 4 | **2 ms** |
| slow drip (20 lines × 50 ms) | 152 | 21 | **1248 ms** |

**Bulk output arrives effectively all-at-once** — even 589 KB landed within 2 ms
across 4 chunks. Only a *genuinely slow producer* (a build) trickles, and there
the chunks are observable (21 over 1.25 s).

**Resolution:** v1 captures the whole exchange and emits `output` on
`exchange_complete` (settled-whole) — simplest, matches the `/btw` answer model,
and correct for the overwhelmingly common fast command. The Spec S01 frame
sequence keeps the optional `exchange_output` chunk frames between
`exchange_started` and `exchange_complete`, so **streaming is a cheap follow-on**
(`TerminalBlock` already renders streaming) for the slow-producer case — not
built in v1.

**Streams:** the spike kept stdout/stderr on separate pipes and both were
captured. For block rendering, **combine them into one ANSI-bearing stream**
(interleaved, terminal-WYSIWYG) with the sentinel riding stdout — merge `2>&1`
around the command group at exec time so ordering is preserved. Spec S04's
`output` is that single combined string for v1.

---

## [Q03] — RESOLVED: pipe mode + hardened env + `</dev/null` + signal-kill

The env applied to every exec:

```
PAGER=cat  GIT_PAGER=cat  TERM=dumb  GIT_TERMINAL_PROMPT=0
```

and each command wrapped `{ <command> ; } </dev/null`, in a **no-TTY** child.

### A real protocol flaw was found and fixed

`spike-sentinel-child.mjs` ran `cat` (no args) with the shell's stdin as the
command channel: **`cat` swallowed the sentinel-emitter line we wrote next**,
desyncing the protocol and corrupting subsequent commands (the "recovery" case
came back with the previous command's text). **A command that reads stdin steals
the protocol bytes.**

`spike-stdin-fix.mjs` confirmed the fix — wrap each command so *its* stdin is
`/dev/null` while the shell keeps reading our channel:

| Case | Before (`cat` as-is) | After (`{ cat; } </dev/null`) |
|------|----------------------|-------------------------------|
| `cat` | desync, protocol corrupt | `exit=0` immediately, **synced** |
| recovery | wrong output | `echo still-alive` → `still-alive` ✓ |

### TUIs and TTY-grabbers cannot hang the shell

`spike-hardening-streaming.mjs`:

| Command | Result |
|---------|--------|
| `vim` / `vi` | "Output is not to a terminal", **exit 1** (~2 s, then exits) |
| `nano` | "Incomplete terminfo entry" (TERM=dumb), **exit 1** fast |
| `less /etc/hosts` | no TTY → behaves like `cat`, dumps file, exit 0 |
| `top -l 1` | one non-interactive snapshot, exit 0 |
| `head -1 </dev/tty` | **exit 1** immediately — no controlling TTY to open |

**No case hangs.** `ssh`/`sudo` password prompts (which open `/dev/tty` directly)
fail fast for the same reason as the `/dev/tty` case, reinforced by
`GIT_TERMINAL_PROMPT=0` for git.

### Genuine long-runners need signal-based kill

`sleep 30` timed out (no sentinel), **and the next command also timed out** —
the shell is blocked behind the foreground command. You **cannot** cancel by
writing another stdin line (it queues behind the running command). **The shell
service must track the foreground command's pid/pgid and send SIGTERM→SIGKILL**
to reap it (the `kill` verb in Spec S01). A per-exchange timeout is the backstop
for a command that ignores nothing but never returns.

---

## [Q04] — RESOLVED: no cross-restart survival; the record persists via the ledger

The chosen child-shell backend (b) is a child of tugcast: it **dies when tugcast
restarts** (or the app relaunches). There is no in-process state to carry across.

**Semantics:** on tugcast (re)start the shell session is **restarted fresh in the
card's project dir** — cwd and env reset to the spawn defaults. The transcript
**record** of prior exchanges is unaffected because it is persisted in the ledger
([P07]) and restored by the deck-side interleave, independent of the live process.

**Surfacing the reset:** emit a `shell_state { live: true, cwd: <projectDir> }`
frame on (re)spawn so the cwd chip resets truthfully, and (optional, tasteful) a
subdued system-note-style divider in the transcript marking "shell restarted" so
a user mid-`cd` understands why cwd jumped. This matches the doctrine ([P11]):
the *record* is durable; the *live shell* is ephemeral.

---

## Consolidated recommendation → feeds into Step 2 (plan resolutions)

1. **[P09] backend:** persistent child `$SHELL` (POSIX; login shell if bash/zsh,
   else `/bin/zsh`), **pipe mode / no PTY**, one per card, lazy-spawned in the
   project dir. Track the foreground command's pgid for signal-kill.
2. **Spec S01 / S04:** `exchange_started` → (reserved) `exchange_output*` →
   `exchange_complete { exit_code, cwd_after, duration_ms, output }`; `output` is
   a **single combined (stdout+stderr, ANSI) string**, emitted at completion
   (settled-whole v1). `kill` verb signals the pgid. `shell_state { live, cwd }`
   for liveness/cwd + restart reset.
3. **Hardening (baked into the service, not optional):** hardened env
   (`PAGER`/`GIT_PAGER`=cat, `TERM=dumb`, `GIT_TERMINAL_PROMPT=0`), per-command
   `{ …; } </dev/null` stdin isolation, no controlling TTY, per-exchange timeout.
4. **Streaming:** deferred follow-on; frame shape reserves it.
5. **Restart:** fresh shell in project dir; ledger carries the record; reset
   surfaced via `shell_state` (+ optional divider note).
