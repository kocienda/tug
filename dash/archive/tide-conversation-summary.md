# Tide — Conversation Log

**Date**: 2026-04-02
**Participants**: Ken Kocienda, Claude Opus 4.6

This document preserves the full conversation that developed the Tide concept — a unified graphical command surface that replaces the terminal for both shell commands and Claude Code interactions.

---

## The Opening Vision

Ken's framing:

> The notion of "building a graphical Claude Code conversation experience" remains a goal, but actually, it doesn't go far enough. Think about the command line experience with terminals on a typical Unix machine. In essence, their user experience traces its roots back to the 19th century and teleprinters, with a modern reimagining closely tied to DEC VT100 terminals from the 1970s. Typing commands in as clipped text and getting minimally-formatted text responses was the outside limit of what the tech could do.

> Anthropic also took the curious step to adopt the terminal as the user interface for Claude Code — and this turned out to be a brilliant master stroke: since the terminal is all about text, and so are LLMs, text-only terminal usage patterns and conventions turned out to be an excellent way to use AI assistance to do work.

> Yes, I want to pursue better Claude Code conversations, but I want to achieve this by improving the entirety of text-based terminal interactions by joining graphically-rich user interface experience.

> If you think about it, command lines on Unix-like computers have two parts we don't typically separate in our minds: the tty/pty and the command interpreter. I want to divide these, leave the tty/pty part behind, and provide a graphical foundation layer for people to use for command interpreters. This means both the shells (like sh, Bash, and zsh), but *also* for Claude Code.

---

## Key Realization: Not a Terminal Emulator Bolt-On

Ken's correction when the initial response proposed embedding a terminal emulator:

> But you see, I *explicitly don't want* to just bolt on a new-fangled pty. I want to get rid of this antiquated layer in the architecture. There is *nothing* interesting about it.

> My idea is to *adapt* all these outputs so we can produce a fully re-imagined graphical version of ls output, git log, htop.... and maybe even vim. Get what I'm saying? The ANSI-escaped text is so limited in what it can actually do.

> So yes, would there be programs my concept would need to leave behind? Yes. Maybe vim. Maybe even htop. But the benefit would be to begin breaking the bonds we no longer actually need. We have graphical text editors. We have graphical activity monitors.

---

## The "UI Must Build" Expansion

Ken connected the Claude Code exploration findings to the shell:

> Think about it this way. Our Claude Code investigations showed that many commands fall into the "UI Must Build" section. Quite a few, actually. We expand out the set of "UI Must Build" components to *encompass* these most often-used commands. This is the basis for the "one surface where humans and AI both issue commands and see results". For all the commands we want to bring onto the "single surface", we do a version of what we did for Claude Code: we investigate to map out its inputs and outputs and we use or expand the protocol (if needed) to bring them in.

---

## The Three-Tier Dispatch Model

Commands in the unified surface dispatch to three tiers, paralleling how shells handle built-ins:

| Tier | Our Example | What Happens |
|------|------------|--------------|
| **Surface built-in** | Model switcher, permission mode, cost display, clear, theme, session management | Handled entirely by the graphical surface. Never reaches shell or Claude Code. Modifies surface state. |
| **Claude Code pass-through** | Natural language prompts, `/plan`, `/implement`, `/compact` | Routed to Claude Code via the stream-json protocol. Events stream back. |
| **Shell pass-through** | `git status`, `cargo build`, `ls`, pipes | Routed to the shell via tugshell. Adapter produces structured output. |

---

## The Prefix Routing Idea

Ken's proposal for command entry:

> What if the "command entry" area accepted an initial character to "direct" or "hint" the following command. I'm thinking `>` for Claude and `$` for the shell.

Examples:
```
> which files need an update for the new "foo" feature
$ which git
```

---

## Research Findings

### 1. Tty/Pty Architecture

A pty is a bidirectional byte pipe with a line discipline in the middle. The terminal emulator holds the master fd; the shell gets the slave fd. The line discipline handles echo, line editing, signal generation. Data flowing slave-to-master is mostly UTF-8 text interleaved with ANSI/xterm escape sequences. The terminal emulator parses these and renders graphically.

The protocol is implicit, accreted over decades, and has no versioning or capability negotiation beyond `TERM` env var and terminfo databases. The pty has a fixed-size kernel buffer (typically 4096 bytes on macOS). Everything must serialize into the byte stream — no out-of-band channel, no schema, no type system.

Modern terminals extend via proprietary escape sequences (Kitty graphics, iTerm2's OSC 1337, sixel). Feature detection is fragile. Each terminal invents its own extensions with no coordination body.

### 2. Shell Integration Hooks

**zsh `preexec(command, fullcommand, fullcommand_expanded)`**: Called before each command execution. Gets the raw command line string only — no parsed argv array. For `ls | grep foo`, you get the literal string.

**zsh `precmd()`**: Called after command finishes. `$?` holds exit code. `$PWD` is current directory.

**bash `DEBUG` trap**: Fires before every simple command in a pipeline. `$BASH_COMMAND` contains the current simple command. More granular than zsh but noisier.

**OSC 133 markers**: iTerm2, Warp, and VS Code all use the same technique — escape sequences emitted from shell hooks to mark prompt/command/output boundaries. This is a solved pattern.

**What we get reliably**: full command line as typed, exit code (including per-stage via `pipestatus`), duration, working directory before/after.

**What we don't get**: a parsed AST. Detecting pipes, redirections, and subshells requires string parsing.

### 3. Command Coverage Analysis

Developer shell usage is heavily concentrated:

- **git alone is 15-25% of all commands**
- Top 10 commands cover 55-65% of usage
- ~19-22 commands with structured adapters would cover 80%+

Categories:
- **Native JSON**: git (some), docker, npm, cargo, kubectl, brew, aws, terraform, curl
- **Stable parseable**: git (porcelain), ls, grep/rg, find, ps, diff, wc, du/df
- **No output**: cd, rm, cp, mv, mkdir, chmod — just show status
- **Free-form text**: make, echo, python, cat, tail/head — styled monospace fallback
- **Full-screen (excluded)**: vim, htop, less, top, ssh — terminal card only

### 4. Structured Shell Precedents

**Nushell** (MIT): Structured pipelines internally, but external commands produce raw ByteStream. User must explicitly convert. No auto-detection of external command output.

**PowerShell** (MIT): Object pipeline internally, strings for external commands. Type-to-default-view mapping via declarative XML — directly relevant pattern.

**Jupyter** (BSD): Multi-representation pattern — one result carries multiple MIME types, frontend picks richest. Strongest design pattern for our use case.

**Warp** (proprietary, concepts only): Block model with OSC 133 boundaries. Proves command-as-object works commercially.

**The gap nobody fills**: automatic structured parsing of known external command output.

### 5. Pipe and Redirection Semantics

Pragmatic approach:
1. Run full pipelines natively through hidden pty
2. Parse command string from preexec to understand pipeline topology
3. Render final output with knowledge of full pipeline
4. For redirections, detect via parsing and show annotation
5. Use pipestatus for per-stage exit codes on failure
6. Ignore subshells and command substitution — let the real shell handle them

### 6. Shell Concepts to Respect

**Startup files**: Must launch as login interactive (`zsh -li`) to load full environment.

**Environment**: Must faithfully maintain and pass environment variables. direnv, nvm, conda, pyenv all depend on this.

**Completion system**: zsh's compsys contains machine-readable descriptions of command interfaces — an untapped data source for contextual help and argument suggestions.

**Inviolable shell UX laws**:
1. Ctrl-C always interrupts
2. The prompt means "ready for input"
3. Commands are text (paste from Stack Overflow must work)
4. The environment is sacred
5. Output is a stream
6. Failure is normal (non-zero exit codes are information)

---

## Architecture: Two Adapters, One Surface

```
┌────────────────────────────────────────────────────────────┐
│                    Graphical Surface (Tide)                 │
│                                                            │
│  ┌──────────────────┐    ┌──────────────────────────────┐  │
│  │  Shell Adapter    │    │  Claude Code Adapter          │  │
│  │  (tugshell)      │    │  (tugtalk)                    │  │
│  │                  │    │                              │  │
│  │  Hidden pty      │    │  stream-json over stdio      │  │
│  │  Shell hooks     │    │  Typed JSON events           │  │
│  │  Command parsing │    │  Semantic UI rendering       │  │
│  │  Adapter registry│    │                              │  │
│  └──────┬───────────┘    └──────┬───────────────────────┘  │
│         │                       │                          │
│  ┌──────▼───────────┐    ┌──────▼───────────────────────┐  │
│  │  bash / zsh       │    │  Claude Code                  │  │
│  │  (unmodified)     │    │  (stream-json mode)           │  │
│  └──────────────────┘    └──────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

### Shell Adapter Architecture (Three Layers)

**Layer 1: Shell Bridge (tugshell)**
- Spawns bash/zsh with hidden pty
- Injects shell integration hooks (preexec/precmd + OSC markers)
- Captures: command string, exit code, duration, cwd, stdout bytes
- Emits structured events to tugcast

**Layer 2: Command Adapter Registry**
- Maps (command_name, args) → adapter function
- Adapter receives: command string, raw stdout, exit code
- Adapter produces: typed output event with format tag + structured data
- Some adapters bypass stdout entirely (e.g., git status adapter runs git --porcelain directly)
- Fallback: format="text", data={ text: raw_stdout }

**Layer 3: Graphical Renderers (tugdeck)**
- Maps format tag → UI component
- "git_status" → GitStatusBlock
- "file_listing" → FileListBlock
- "build_output" → BuildBlock
- "text" → MonospaceBlock (styled, ANSI colors mapped to CSS)

### Protocol Events

Shell command event:
```json
{ "type": "command_start", "id": "cmd-42", "command": "git status", "cwd": "/src/tugtool" }
{ "type": "command_output", "id": "cmd-42", "format": "git_status", "data": { "branch": "main", "staged": [...] } }
{ "type": "command_complete", "id": "cmd-42", "exit_code": 0, "duration_ms": 45 }
```

These sit alongside Claude Code events on the same tugcast WebSocket, same tugdeck rendering pipeline.

---

## Environment Model for the Unified Surface

- **Working directory**: Shell's cwd is source of truth. Claude Code's cwd follows.
- **Variables/export**: Shell bridge runs real shell, full environment maintained.
- **Aliases/functions**: Loaded from user's startup files. Work automatically.
- **Startup files**: Full sequence honored via login interactive shell launch.
- **PATH**: Inherited from shell process startup. All tools (homebrew, nvm, etc.) work.
- **Claude Code sync**: Shell environment changes (cd, export) propagate to Claude Code's next turn via surface coordination.

---

## Design Decisions

- **Pty is opaque**: Hidden implementation detail. Never leaks to user. Candidate for a Law of Tug.
- **Terminal card available**: Separate opt-in for vim/htop/etc. Not part of the unified surface.
- **Prefix routing**: `>` for Claude Code, `$` for shell. Clear, learnable, type-ahead friendly.
- **Progressive enhancement**: Every command works (fallback to monospace). Known commands get rich rendering. Adapter registry grows over time.
- **Full Unix compatibility**: Users can paste any command from Stack Overflow.

---

## Naming

**Tide** chosen as the codename for this effort. Tugdeck remains the broader rendering surface concept. Tide is the unified command surface vision — the project that brings shell and Claude Code together.

---

## Prior Work Referenced

- [tug-conversation.md](tug-conversation.md) — Claude Code conversation roadmap, phases 1-12
- [transport-exploration.md](transport-exploration.md) — 35 tests of Claude Code stream-json protocol
- [ws-verification.md](ws-verification.md) — WebSocket path verification through tugcast
- [tug-feed.md](tug-feed.md) — Structured progress reporting architecture
